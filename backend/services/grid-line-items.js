// Part 2 (Uncoded RGP) ONLY - grid-based line-item extraction using OpenCV
// (Python) for table structure detection + tesseract.js for per-cell OCR.
// Part 1 never calls this file at all.
//
// Why this exists: passing the whole line-items table image into Tesseract
// in one shot lets text bleed across columns/rows (a value from "Quantity"
// landing in "Amount", etc). This detects the table's actual printed border
// lines (deskewing first - phone photos are rarely perfectly level, and an
// undetected 1-2 degree tilt misaligns every cell), then crops+OCRs each
// cell alone so Tesseract physically cannot mix cells together.
//
// Verified independently against ground truth on real samples before this
// was wired in: Description/HSN/Basic/Amount matched ground truth almost
// verbatim; only the narrow Quantity column and item SR No stayed weak.
// On failure (no Python, no usable grid, etc) this returns null and the
// caller falls back to the existing AI-text-based lineItems - never worse
// than before.

const { spawn } = require('child_process')
const path = require('path')
const os = require('os')
const fs = require('fs')
const sharp = require('sharp')

function findPython() {
  const candidates = [
    'python',
    'python3',
    'C:\\Users\\Pratham\\AppData\\Local\\Programs\\Python\\Python312\\python.exe',
  ]
  for (const c of candidates) {
    try {
      const { execFileSync } = require('child_process')
      execFileSync(c, ['--version'], { stdio: 'ignore' })
      return c
    } catch { /* try next candidate */ }
  }
  return null
}

function runPythonGrid(pythonExe, imagePath, jsonPath) {
  return new Promise((resolve) => {
    const scriptPath = path.join(__dirname, 'table-grid.py')
    const child = spawn(pythonExe, [scriptPath, imagePath, jsonPath], { stdio: ['ignore', 'ignore', 'pipe'], timeout: 60000 })
    let stderr = ''
    child.stderr.on('data', d => { stderr += d.toString() })
    child.on('close', () => {
      try {
        const grid = JSON.parse(fs.readFileSync(jsonPath, 'utf8'))
        resolve(grid)
      } catch {
        resolve(null)
      }
    })
    child.on('error', () => resolve(null))
  })
}

// Same noise pattern seen in the AI/text path: a border-line pixel or
// neighboring cell's stray mark occasionally attaches to the front of an
// otherwise-correct number ("gs 600.00", "- 1,400.00"). Keep only the actual
// number pattern instead of the garbage prefix.
function cleanNumericField(value) {
  if (value === null || value === undefined) return value
  const s = String(value).trim()
  const decimalMatches = s.match(/\d[\d,]*\.\d{1,2}/g)
  if (decimalMatches && decimalMatches.length) return decimalMatches[decimalMatches.length - 1]
  const wholeMatches = s.match(/\d[\d,]*/g)
  if (wholeMatches && wholeMatches.length) return wholeMatches[wholeMatches.length - 1]
  return value
}

// Every real HSN/SAC code on this template is shaped "99_7__" (998729,
// 998719, 993729-with-OCR-noise, etc) - same evidence pattern already used
// elsewhere in this codebase for the same reason (avoids matching footer
// phone/CIN numbers as if they were HSN codes).
function hasHsnEvidence(text) {
  return /\b99\d7\d\d\b/.test(text)
}

function isHeaderOrFooterRow(cellTexts) {
  const joined = cellTexts.join(' ').toLowerCase()
  return /total|cgst|sgst|igst|input tax|posted by|declaration|corporate office|admissible|description|hsn|sac|quantity|amount|sr no/.test(joined)
}

async function ocrCell(worker, grayBuffer, box) {
  const pad = 3
  const x = Math.max(0, box.x + pad)
  const y = Math.max(0, box.y + pad)
  const w = Math.max(1, box.w - pad * 2)
  const h = Math.max(1, box.h - pad * 2)
  try {
    const cropped = await sharp(grayBuffer).extract({ left: x, top: y, width: w, height: h }).toBuffer()
    const { data } = await worker.recognize(cropped)
    return (data.text || '').trim().replace(/\s+/g, ' ')
  } catch {
    return ''
  }
}

// SR No and Quantity are narrow columns (often <60px even after the 3.5x
// upscale) - the shared psm-7 worker treats them like a line of prose and
// hallucinates ("i]", "[IR", "et a"). A digit-only pass with a tighter crop
// (no border-line bleed) and a 3x extra enlargement gives Tesseract enough
// pixel detail to read the 1-3 digit number instead of guessing letters.
async function ocrCellDigits(digitWorker, grayBuffer, box) {
  const pad = 4
  const x = Math.max(0, box.x + pad)
  const y = Math.max(0, box.y + pad)
  const w = Math.max(1, box.w - pad * 2)
  const h = Math.max(1, box.h - pad * 2)
  try {
    const cropped = await sharp(grayBuffer)
      .extract({ left: x, top: y, width: w, height: h })
      .resize({ width: w * 4, height: h * 4, kernel: 'lanczos3' })
      .normalise()
      .threshold(150)
      .toBuffer()
    const { data } = await digitWorker.recognize(cropped)
    const digits = (data.text || '').replace(/[^0-9]/g, '')
    return digits || null
  } catch {
    return null
  }
}

// Splits a combined "SR No + Description" cell (happens when the faint
// internal divider between those two narrow/wide columns isn't detected).
// Every real description on this template starts with an uppercase item-code
// abbreviation (SC, HOB, GSC, SHANK, STEP...) - only treat a leading 1-2
// digit number as the SR No if it's immediately followed by that pattern.
// A naive "first digit found" match would wrongly grab a digit from WITHIN
// the description itself (e.g. the "9" in "SC DRILL @9.0xFL61...").
function splitSrNoDescription(text) {
  const m = text.match(/^[^\dA-Za-z]*(\d{1,2})\s+(?=[A-Z]{2,})/)
  if (m) return { srNo: m[1], description: text.slice(m[0].length).trim() }
  return { srNo: null, description: text.trim() }
}

async function extractLineItemsViaGrid(buffer) {
  const pythonExe = findPython()
  if (!pythonExe) return null

  const tmpImg = path.join(os.tmpdir(), `grid_${Date.now()}.jpg`)
  const tmpJson = path.join(os.tmpdir(), `grid_${Date.now()}.json`)
  fs.writeFileSync(tmpImg, buffer)

  try {
    const grid = await runPythonGrid(pythonExe, tmpImg, tmpJson)
    if (!grid || !grid.rows || grid.rows.length < 2 || !grid.rotatedImagePath) return null

    const rotatedBuffer = fs.readFileSync(grid.rotatedImagePath)
    const grayBuffer = await sharp(rotatedBuffer).grayscale().toBuffer()

    const Tesseract = require('tesseract.js')
    const worker = await Tesseract.createWorker('eng', 1, { logger: () => {} })
    await worker.setParameters({ tessedit_pageseg_mode: 7, preserve_interword_spaces: '1' })
    const digitWorker = await Tesseract.createWorker('eng', 1, { logger: () => {} })
    await digitWorker.setParameters({ tessedit_pageseg_mode: 8, tessedit_char_whitelist: '0123456789' })

    const items = []
    try {
      for (const row of grid.rows) {
        const texts = []
        for (const cell of row) {
          texts.push(await ocrCell(worker, grayBuffer, cell))
        }
        if (isHeaderOrFooterRow(texts)) {
          // The column-header row (before any items) is skipped and scanning
          // continues; the "Total Basic Amount" row (after items) marks the
          // end of the table - everything below it is declaration/stamp/
          // signature noise, so stop entirely instead of skipping row-by-row.
          if (items.length > 0) break
          continue
        }

        let srNo, description, hsnSac, basic, quantity, amount
        let srNoBox = null, qtyBox = null
        if (texts.length >= 6) {
          [srNo, description, hsnSac, basic, quantity, amount] = texts
          srNoBox = row[0]
          qtyBox = row[4]
        } else if (texts.length === 5) {
          const split = splitSrNoDescription(texts[0])
          srNo = split.srNo
          description = split.description
          ;[hsnSac, basic, quantity, amount] = texts.slice(1)
          qtyBox = row[3]
        } else {
          continue // too few columns to trust
        }

        // Re-OCR the narrow SR No / Quantity cells with the digit-only
        // worker - the prose worker above regularly hallucinates on them.
        // Only overrides when the digit pass actually found something;
        // falls back to the prose-worker text otherwise (never worse).
        if (srNoBox) {
          const digitSrNo = await ocrCellDigits(digitWorker, grayBuffer, srNoBox)
          if (digitSrNo) srNo = digitSrNo
        }
        if (qtyBox) {
          const digitQty = await ocrCellDigits(digitWorker, grayBuffer, qtyBox)
          if (digitQty) quantity = digitQty
        }

        const cleanDescription = (description || '').replace(/[^a-zA-Z]/g, '')
        if (cleanDescription.length < 3) continue // not a real item row

        // A real Amount cell is a number (digits/commas/decimal point) -
        // reject rows where it's mostly letters (declaration text, footer
        // sentences, signature names that slipped past the keyword filter).
        const amountDigitRatio = (amount || '').replace(/[^0-9]/g, '').length / Math.max(1, (amount || '').replace(/\s/g, '').length)
        if (amountDigitRatio < 0.3) continue

        items.push({
          srNo: srNo || null,
          description: description?.trim() || null,
          hsnSac: hasHsnEvidence(hsnSac) ? hsnSac.match(/\b99\d7\d\d\b/)[0] : (hsnSac?.trim() || null),
          basic: cleanNumericField(basic?.trim() || null),
          quantity: cleanNumericField(quantity?.trim() || null),
          amount: cleanNumericField(amount?.trim() || null),
        })
      }
    } finally {
      await worker.terminate()
      await digitWorker.terminate()
    }

    return items.length ? items : null
  } catch (err) {
    console.error('Grid line-item extraction failed (Part 2 only, falling back):', err.message)
    return null
  } finally {
    try { fs.unlinkSync(tmpImg) } catch {}
    try {
      const grid = JSON.parse(fs.readFileSync(tmpJson, 'utf8'))
      if (grid.rotatedImagePath) fs.unlinkSync(grid.rotatedImagePath)
    } catch {}
    try { fs.unlinkSync(tmpJson) } catch {}
  }
}

module.exports = { extractLineItemsViaGrid }
