const ExcelJS = require('exceljs')
const path = require('path')
const fs = require('fs')

const EXPORT_DIR = path.join(__dirname, '..', 'exports')
const HEADERS = ['Document Type', 'Number', 'Date', 'Timestamp']

function ensureExportDir() {
  if (!fs.existsSync(EXPORT_DIR)) fs.mkdirSync(EXPORT_DIR, { recursive: true })
}

function filePath(filename) {
  const safe = path.basename(filename) // no path traversal via user-supplied filename
  return path.join(EXPORT_DIR, safe.endsWith('.xlsx') ? safe : `${safe}.xlsx`)
}

async function createNewFile(filename) {
  ensureExportDir()
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('Exports')
  sheet.addRow(HEADERS)
  sheet.getRow(1).font = { bold: true }
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

async function appendRow(filename, row) {
  ensureExportDir()
  const target = filePath(filename)
  if (!fs.existsSync(target)) {
    throw new Error(`Excel file not found: ${path.basename(target)}`)
  }
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.readFile(target)
  const sheet = workbook.getWorksheet('Exports') || workbook.worksheets[0]
  sheet.addRow([row.documentType, formatNumberCell(row), row.date, row.timestamp])
  await workbook.xlsx.writeFile(target)
  return target
}

module.exports = { createNewFile, appendRow, filePath, EXPORT_DIR }
