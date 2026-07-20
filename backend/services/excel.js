const ExcelJS = require('exceljs')
const path = require('path')
const fs = require('fs')

const EXPORT_DIR = path.join(__dirname, '..', 'exports')
const HEADERS = ['Document Type', 'Number', 'Date', 'Timestamp']
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December']

function ensureExportDir() {
  if (!fs.existsSync(EXPORT_DIR)) fs.mkdirSync(EXPORT_DIR, { recursive: true })
}

function filePath(filename) {
  const safe = path.basename(filename) // no path traversal via user-supplied filename
  return path.join(EXPORT_DIR, safe.endsWith('.xlsx') ? safe : `${safe}.xlsx`)
}

// Current period from the real clock - drives which yearly workbook is active
// (year rollover). Kept in one place so year rollover is detected consistently.
function currentPeriod(now = new Date()) {
  return { year: now.getFullYear(), month: MONTHS[now.getMonth()] }
}

// Worksheet month comes from the DOCUMENT'S OWN extracted date (DD/MM/YYYY),
// not the day it happens to be saved on - a document dated 30/06 always lands
// in the June sheet, even if you save it in July. Falls back to the current
// real month when the date couldn't be extracted, so the document still saves
// somewhere instead of failing outright.
function monthFromDate(dateStr, fallbackNow = new Date()) {
  const match = typeof dateStr === 'string' && dateStr.match(/^(\d{2})\/(\d{2})\/(\d{4})$/)
  if (!match) return currentPeriod(fallbackNow).month
  const mm = Number(match[2])
  if (mm < 1 || mm > 12) return currentPeriod(fallbackNow).month
  return MONTHS[mm - 1]
}

function addHeaderRow(sheet) {
  sheet.addRow(HEADERS)
  sheet.getRow(1).font = { bold: true }
}

// Creates a fresh yearly workbook containing the current month's worksheet.
// Overwrites any file of the same name (used when starting a brand-new batch).
async function createWorkbook(filename, month = currentPeriod().month) {
  ensureExportDir()
  const workbook = new ExcelJS.Workbook()
  addHeaderRow(workbook.addWorksheet(month))
  const target = filePath(filename)
  await workbook.xlsx.writeFile(target)
  return target
}

// Formats the row's Number cell - Tax Invoice has two number fields
// (TAX INVOICE No. + Reference No.), Delivery Challan has one.
function formatNumberCell({ documentType, taxInvoiceNo, referenceNo, number }) {
  if (documentType === 'Tax Invoice') {
    return [taxInvoiceNo, referenceNo].filter(Boolean).join(' / ') || null
  }
  return number || null
}

// All workbook writes are serialized through this promise chain - two parallel
// saves would otherwise read-modify-write the same file and lose a row.
let _writeChain = Promise.resolve()

function appendRow(filename, month, row) {
  const job = _writeChain.then(() => appendRowNow(filename, month, row))
  // Keep the chain alive even when a job fails - the next save must not inherit
  // this one's rejection.
  _writeChain = job.catch(() => {})
  return job
}

// Appends one row to the given month's worksheet, creating the workbook and/or
// the worksheet if either is missing (this is what makes automatic monthly
// switching work - the first save in a new month just creates that sheet).
async function appendRowNow(filename, month, row) {
  ensureExportDir()
  const target = filePath(filename)
  if (!fs.existsSync(target)) {
    // Settings can point at a file that was deleted from disk - recreate it.
    await createWorkbook(filename, month)
  }
  // Windows locks the workbook while it is open in Excel - both the read and
  // the write below fail with EBUSY/EPERM in that case, so the whole
  // read-modify-write is wrapped, not just the write.
  try {
    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.readFile(target)
    let sheet = workbook.getWorksheet(month)
    if (!sheet) {
      sheet = workbook.addWorksheet(month)
      addHeaderRow(sheet)
    }
    sheet.addRow([row.documentType, formatNumberCell(row), row.date, row.timestamp])
    await workbook.xlsx.writeFile(target)
  } catch (err) {
    if (err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'EACCES') {
      const friendly = new Error(`"${path.basename(target)}" is open in Excel. Close it and try saving again.`)
      friendly.code = 'FILE_LOCKED'
      throw friendly
    }
    throw err
  }
  return target
}

module.exports = { createWorkbook, appendRow, filePath, currentPeriod, monthFromDate }
