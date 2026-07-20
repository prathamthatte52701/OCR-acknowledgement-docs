// OCR Service
// Runs Tesseract in an isolated child process - server survives any crash
// Auto-splits each page into Part 1 (Consignee/Consignor header) and
// Part 2 (line-items + tax table), OCRs both independently.

const { spawn } = require('child_process')
const path = require('path')
const os = require('os')
const fs = require('fs')
const { withTimeout } = require('../utils/withTimeout')

// pdf-parse/pdfjs-dist run in-process (unlike Tesseract, which is isolated in
// its own child process with a 180s timeout) - a malformed/hostile PDF can
// otherwise hang these calls forever and freeze the whole server.
const PDF_PARSE_TIMEOUT_MS = 60000

// -- Run OCR in isolated child process ----------------------------------------

async function extractFromImage(buffer, mimeType = 'image/jpeg', singlePartMode = null) {
  const ext = mimeType === 'image/png' ? 'png' : 'jpg'
  const tmpPath = path.join(os.tmpdir(), `consignor_${Date.now()}.${ext}`)
  fs.writeFileSync(tmpPath, buffer)
  try {
    const result = await runOCRWorker(tmpPath, singlePartMode)
    console.log(`OCR result: part1=${result?.part1Text?.length || 0} chars, part2=${result?.part2Text?.length || 0} chars`)
    return result
  } finally {
    try { fs.unlinkSync(tmpPath) } catch {}
  }
}

// User has already manually cropped this image down to exactly one section
// (Consignee/Consignor header, or the Uncoded RGP line-items table) - the
// worker skips auto-split entirely and OCRs the whole image as that one part.
async function extractSingleImagePart(buffer, mimeType, partLabel) {
  const result = await extractFromImage(buffer, mimeType, partLabel)
  return result
}

// -- Header-only extraction (Acknowledgement flow) ------------------------------
// Crops to the top ~28% of the page (Reference No./Delivery Challan No. + date
// row always lives there on both templates) before OCR, so Tesseract never has
// to fight the item table/stamps/signatures below it. Reuses the existing
// single-part OCR path (extractSingleImagePart with 'part1' label) unchanged -
// a pre-cropped image just makes its job easier.
const HEADER_CROP_RATIO = 0.28

async function extractHeaderText(buffer, mimeType) {
  try {
    if (mimeType === 'application/pdf') return await extractHeaderFromPDF(buffer)
    return await extractHeaderFromImage(buffer, mimeType)
  } catch (err) {
    console.error('Header OCR error:', err.message)
    return null
  }
}

async function extractHeaderFromImage(buffer, mimeType) {
  const sharp = require('sharp')
  const meta = await sharp(buffer).metadata()
  if (!meta.width || !meta.height) return null
  const cropped = await sharp(buffer)
    .extract({ left: 0, top: 0, width: meta.width, height: Math.max(1, Math.round(meta.height * HEADER_CROP_RATIO)) })
    .toBuffer()
  const result = await extractSingleImagePart(cropped, mimeType, 'part1')
  return result?.part1Text || null
}

async function extractHeaderFromPDF(buffer) {
  try {
    const { PDFParse } = require('pdf-parse')
    const parser = new PDFParse({ data: buffer })
    let text
    try {
      const result = await withTimeout(parser.getText(), PDF_PARSE_TIMEOUT_MS, 'PDF header text extraction')
      text = (result.pages || []).map(p => p.text).join('\n').trim()
    } finally {
      await parser.destroy()
    }
    if (text && text.length > 20) {
      const headerText = await reconstructHeaderRowsByPosition(buffer)
      return cleanOCRText(headerText || text)
    }
  } catch (err) {
    console.error('pdf-parse error (header):', err.message)
  }

  // No text layer - scanned PDF. Rasterize page 1, crop to the top band, OCR it.
  console.log('Header OCR: PDF has no text layer, rasterizing page 1.')
  const { pngBuffer } = await renderPdfPageToPng(buffer)
  return await extractHeaderFromImage(pngBuffer, 'image/png')
}

// Same row-grouping as reconstructTextByPosition, but keeps only rows whose y
// falls in the top HEADER_CROP_RATIO of the page - so the header number/date
// row survives even when it isn't in visual document order in the raw text.
async function reconstructHeaderRowsByPosition(buffer) {
  try {
    const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs')
    const path = require('path')
    const { pathToFileURL } = require('url')
    const standardFontDataUrl = pathToFileURL(
      path.join(path.dirname(require.resolve('pdfjs-dist/package.json')), 'standard_fonts') + path.sep
    ).href

    const doc = await withTimeout(
      pdfjsLib.getDocument({ data: new Uint8Array(buffer), standardFontDataUrl, disableWorker: true }).promise,
      PDF_PARSE_TIMEOUT_MS, 'PDF header position reconstruction (load)'
    )
    const page = await doc.getPage(1)
    const viewport = page.getViewport({ scale: 1 })
    const content = await withTimeout(page.getTextContent(), PDF_PARSE_TIMEOUT_MS, 'PDF header position reconstruction (text content)')

    const items = content.items
      .map(it => ({ str: it.str, x: it.transform[4], y: it.transform[5] }))
      .filter(it => it.str && it.str.trim())
    if (!items.length) return null

    // PDF y-axis increases upward - the top of the page is the HIGH end of y.
    const cutoffY = viewport.height * (1 - HEADER_CROP_RATIO)
    const headerItems = items.filter(it => it.y >= cutoffY)
    if (!headerItems.length) return null

    const Y_TOLERANCE = 3
    const rows = []
    for (const item of headerItems) {
      let row = rows.find(r => Math.abs(r.y - item.y) <= Y_TOLERANCE)
      if (!row) { row = { y: item.y, items: [] }; rows.push(row) }
      row.items.push(item)
    }
    rows.sort((a, b) => b.y - a.y)
    rows.forEach(r => r.items.sort((a, b) => a.x - b.x))

    const text = rows.map(r => r.items.map(i => i.str).join(' ')).join('\n').trim()
    return text || null
  } catch (err) {
    console.error('Header position-based reconstruction failed (falling back):', err.message)
    return null
  }
}

function runOCRWorker(imagePath, singlePartMode = null) {
  return new Promise((resolve) => {
    const workerPath = path.join(__dirname, 'ocr-worker.js')
    const args = singlePartMode ? [workerPath, imagePath, singlePartMode] : [workerPath, imagePath]
    const child = spawn(process.execPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 180000,
    })

    let stdout = ''
    let stderr = ''

    child.stdout.on('data', d => { stdout += d.toString() })
    child.stderr.on('data', d => { stderr += d.toString() })

    child.on('close', (code) => {
      const lines = stdout.trim().split('\n').filter(Boolean)
      const lastLine = lines[lines.length - 1]
      try {
        const parsed = JSON.parse(lastLine)
        if (parsed.debug?.singlePartMode) {
          console.log(`OCR single-part debug: mode=${parsed.debug.singlePartMode}, strategy=${parsed.debug.strategy}`)
        } else if (parsed.debug) {
          console.log(`OCR split debug: splitY=${parsed.debug.splitY}, part1=${parsed.debug.part1Strategy}, part2=${parsed.debug.part2Strategy}`)
        }
        if (parsed.part1Text || parsed.part2Text) {
          resolve({ part1Text: parsed.part1Text || null, part2Text: parsed.part2Text || null })
        } else {
          console.warn('OCR worker returned no text. Error:', parsed.error || 'unknown')
          resolve(null)
        }
      } catch {
        console.warn('OCR worker output parse failed. Exit code:', code)
        console.warn('stdout:', stdout.slice(0, 200))
        resolve(null)
      }
    })

    child.on('error', (err) => {
      console.error('OCR worker spawn error:', err.message)
      resolve(null)
    })
  })
}

// -- PDF extraction ------------------------------------------------------------
// Rasterizes page 1 of a PDF to a PNG in an isolated child process (mirrors
// runOCRWorker's pattern) - pdfjs-dist + native canvas rendering on a malformed
// or hostile scanned PDF must never be able to crash or hang the main server.
function renderPdfPageToPng(buffer) {
  return new Promise((resolve, reject) => {
    const tmpPdfPath = path.join(os.tmpdir(), `consignor_pdf_${Date.now()}.pdf`)
    const tmpPngPath = path.join(os.tmpdir(), `consignor_pdf_${Date.now()}.png`)
    fs.writeFileSync(tmpPdfPath, buffer)

    const cleanup = () => {
      try { fs.unlinkSync(tmpPdfPath) } catch {}
      try { fs.unlinkSync(tmpPngPath) } catch {}
    }

    const workerPath = path.join(__dirname, 'pdf-render-worker.js')
    const child = spawn(process.execPath, [workerPath, tmpPdfPath, tmpPngPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60000,
    })

    let stdout = ''
    child.stdout.on('data', d => { stdout += d.toString() })
    child.stderr.on('data', () => {})

    child.on('close', () => {
      try {
        const lines = stdout.trim().split('\n').filter(Boolean)
        const parsed = JSON.parse(lines[lines.length - 1])
        if (parsed.success) {
          const pngBuffer = fs.readFileSync(tmpPngPath)
          cleanup()
          resolve({ pngBuffer, numPages: parsed.numPages || 1 })
        } else {
          cleanup()
          reject(new Error(parsed.error || 'PDF rendering failed'))
        }
      } catch (err) {
        cleanup()
        reject(new Error('PDF render worker output could not be parsed: ' + err.message))
      }
    })

    child.on('error', (err) => {
      cleanup()
      reject(err)
    })
  })
}

// -- OCR text cleanup ----------------------------------------------------------

function cleanOCRText(text) {
  if (!text) return text
  return text
    .replace(/\f/g, '\n')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[ \t]{4,}/g, '   ')
    .replace(/\n{4,}/g, '\n\n\n')
    .replace(/\bG\s+S\s+T\b/gi, 'GST')
    .replace(/\bP\s+A\s+N\b/gi, 'PAN')
    .replace(/\bI\s+N\s+R\b/gi, 'INR')
    .replace(/Rs\.\s{2,}/gi, 'Rs. ')
    .trim()
}

module.exports = { extractSingleImagePart, extractHeaderText }
