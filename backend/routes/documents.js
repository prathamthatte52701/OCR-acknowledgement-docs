const express = require('express')
const router = express.Router()
const multer = require('multer')
const path = require('path')

// -- Processing queue - max 1 OCR job at a time to prevent OOM crashes ---------
let _processing = false
const _queue = [] // { fn, userId, resolve, reject }
function enqueue(fn, userId) {
  return new Promise((resolve, reject) => {
    _queue.push({ fn, userId, resolve, reject })
    drainQueue()
  })
}

// Round-robin fairness: run the earliest-queued job from a DIFFERENT user
// than whoever ran last, if one is waiting - so one user's batch of uploads
// can't starve everyone else behind strict FIFO. Falls back to plain FIFO
// (front of queue) when everything queued belongs to the same user.
let _lastUserId
function pickNextJobIndex() {
  if (_lastUserId !== undefined) {
    const idx = _queue.findIndex(j => j.userId !== _lastUserId)
    if (idx !== -1) return idx
  }
  return 0
}

async function drainQueue() {
  if (_processing || _queue.length === 0) return
  _processing = true
  const idx = pickNextJobIndex()
  const [{ fn, userId, resolve, reject }] = _queue.splice(idx, 1)
  _lastUserId = userId
  try { resolve(await fn()) } catch (e) { reject(e) }
  finally { _processing = false; drainQueue() }
}

const Document = require('../models/Document')
const Correction = require('../models/Correction')
const Settings = require('../models/Settings')
const Workbook = require('../models/Workbook')
const ExportedRow = require('../models/ExportedRow')
const { uploadBuffer, downloadBuffer, deleteFile } = require('../services/gridfs')
const { extractHeaderText } = require('../services/ocr')
const { extractHeader } = require('../services/groq')
const excel = require('../services/excel')
const { withTimeout } = require('../utils/withTimeout')
const { isValidObjectId } = require('../utils/objectId')

const PDF_PARSE_TIMEOUT_MS = 60000

const DOCUMENT_TYPES = ['Tax Invoice', 'Delivery Challan']

const storage = multer.memoryStorage()
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    const allowed = ['image/jpeg', 'image/jpg', 'image/png', 'application/pdf']
    if (!allowed.includes(file.mimetype)) {
      return cb(new multer.MulterError('LIMIT_UNEXPECTED_FILE', 'Only JPG, JPEG, PNG, and PDF files are allowed.'))
    }
    cb(null, true)
  },
})

// Wrap multer to catch its errors cleanly
function uploadMiddleware(req, res, next) {
  upload.single('document')(req, res, (err) => {
    if (!err) return next()
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: 'File size must be 5 MB or less.' })
      }
      return res.status(400).json({ error: err.field || 'Only JPG, JPEG, PNG, and PDF files are allowed.' })
    }
    return res.status(400).json({ error: err.message || 'Upload failed.' })
  })
}

function detectMimeType(buffer) {
  if (!buffer || buffer.length < 4) return null
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg'
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'image/png'
  if (buffer.slice(0, 4).toString('ascii') === '%PDF') return 'application/pdf'
  return null
}

function mimeMatchesUpload(declared, detected) {
  if (!detected) return false
  if (declared === detected) return true
  return declared === 'image/jpg' && detected === 'image/jpeg'
}

// Document display name is the actual uploaded filename, extension stripped -
// e.g. "delivery-challan-123.jpg" -> "delivery-challan-123".
function nameFromOriginalFilename(originalname) {
  return path.parse(originalname).name || originalname
}

async function getPDFPageCount(buffer) {
  try {
    const { PDFParse } = require('pdf-parse')
    const parser = new PDFParse({ data: buffer })
    try {
      const info = await withTimeout(parser.getInfo(), PDF_PARSE_TIMEOUT_MS, 'PDF page count')
      return info.total || 1
    } finally {
      await parser.destroy()
    }
  } catch (err) {
    console.error('getPDFPageCount error:', err.message)
    return null
  }
}

function updateActiveDocument(docId, update) {
  return Document.updateOne({ _id: docId, isDeleted: { $ne: true } }, update)
}

// A malformed :id (e.g. "abc123") would otherwise reach Mongoose and throw an
// uncaught CastError, surfacing as a raw 500 instead of a clean 400. Runs
// once, before every route below that takes an :id param, so none of them
// need this check repeated inline.
router.param('id', (req, res, next, id) => {
  if (!isValidObjectId(id)) return res.status(400).json({ error: 'Invalid document id.' })
  next()
})

// POST /api/documents/upload
router.post('/upload', uploadMiddleware, async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded.' })
    }

    const documentType = req.body.documentType
    if (!DOCUMENT_TYPES.includes(documentType)) {
      return res.status(400).json({ error: 'Please choose a document type - Tax Invoice or Delivery Challan - before uploading.' })
    }

    const { buffer, mimetype, originalname, size } = req.file
    const detectedMimeType = detectMimeType(buffer)
    if (!mimeMatchesUpload(mimetype, detectedMimeType)) {
      return res.status(400).json({ error: 'File content does not match the selected file type.' })
    }

    if (mimetype === 'application/pdf') {
      const pages = await getPDFPageCount(buffer)
      if (!pages) {
        return res.status(400).json({ error: 'Could not read this PDF. Please upload a valid PDF or convert it to JPG/PNG.' })
      }
      if (pages > 4) {
        return res.status(400).json({ error: 'PDF must be 4 pages or less.' })
      }
    }

    const autoName = nameFromOriginalFilename(originalname)
    const gridFsFileId = await uploadBuffer(buffer, originalname, mimetype)

    const doc = await Document.create({
      userId: req.userId,
      autoName,
      originalFilename: originalname,
      mimeType: mimetype,
      size,
      gridFsFileId,
      documentType,
      uploadStatus: 'uploaded',
    })

    // Queue processing - only 1 OCR job runs at a time to prevent OOM.
    // Tagged with the uploader's userId so the queue can round-robin fairly
    // across users instead of one user's batch blocking everyone else.
    enqueue(() => processDocument(doc._id, buffer, mimetype, documentType), req.userId).catch(err => {
      console.error('Background processing error:', err.message)
    })

    res.status(201).json({ document: doc })
  } catch (err) {
    console.error('Upload error:', err)
    res.status(500).json({ error: 'Something went wrong while processing this document.' })
  }
})

async function processDocument(docId, buffer, mimeType, documentType) {
  try {
    const headerText = await extractHeaderText(buffer, mimeType)
    if (!headerText || !headerText.trim()) {
      await updateActiveDocument(docId, {
        uploadStatus: 'failed',
        processingError: 'We could not read any text from this document. Try a clearer photo or scan, or a higher-quality PDF.',
      })
      return
    }

    let result
    try {
      result = await extractHeader(documentType, headerText)
    } catch (err) {
      console.error('AI extraction error:', err.message)
      await updateActiveDocument(docId, {
        uploadStatus: 'failed',
        ocrTextHidden: headerText,
        processingError: 'AI analysis is unavailable. Please check the Groq API key or try again later.',
      })
      return
    }

    await updateActiveDocument(docId, {
      uploadStatus: 'processed',
      ocrTextHidden: headerText,
      taxInvoiceNo: result.taxInvoiceNo || null,
      referenceNo: result.referenceNo || null,
      number: result.number || null,
      date: result.date || null,
      taxInvoiceNoConfidence: result.taxInvoiceNoConfidence ?? null,
      referenceNoConfidence: result.referenceNoConfidence ?? null,
      numberConfidence: result.numberConfidence ?? null,
      dateConfidence: result.dateConfidence ?? null,
      processingError: null,
      processedAt: new Date(),
    })
  } catch (err) {
    console.error('processDocument error:', err.message)
    await updateActiveDocument(docId, {
      uploadStatus: 'failed',
      processingError: 'Something went wrong while processing this document.',
    })
  }
}

async function recoverInterruptedUploads() {
  const docs = await Document.find({ uploadStatus: 'uploaded', isDeleted: { $ne: true } })
    .select('_id userId mimeType gridFsFileId documentType')

  docs.forEach((doc) => {
    enqueue(async () => {
      try {
        const activeDoc = await Document.findOne({
          _id: doc._id,
          uploadStatus: 'uploaded',
          isDeleted: { $ne: true },
        }).select('_id mimeType gridFsFileId documentType')

        if (!activeDoc) return

        const buffer = await downloadBuffer(activeDoc.gridFsFileId)
        await processDocument(activeDoc._id, buffer, activeDoc.mimeType, activeDoc.documentType)
      } catch (err) {
        console.error(`Recovery failed for document ${doc._id}:`, err.message)
        await updateActiveDocument(doc._id, {
          uploadStatus: 'failed',
          processingError: 'Processing was interrupted and could not be recovered. Please reprocess this document.',
        })
      }
    }, doc.userId).catch(err => console.error('Recovery queue error:', err.message))
  })

  return docs.length
}

// GET /api/documents
router.get('/', async (req, res) => {
  try {
    const documents = await Document.find({ userId: req.userId, isDeleted: { $ne: true } })
      .sort({ createdAt: -1 })
      .select('-ocrTextHidden')

    const byDocumentType = { 'Tax Invoice': 0, 'Delivery Challan': 0 }
    documents.forEach(d => { if (d.documentType in byDocumentType) byDocumentType[d.documentType]++ })

    res.json({ documents, byDocumentType })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to fetch documents.' })
  }
})

// GET /api/documents/workbooks - list this user's workbooks (active + archived),
// newest year first. Registered before /:id so "workbooks" isn't read as an id.
router.get('/workbooks', async (req, res) => {
  try {
    const Workbook = require('../models/Workbook')
    const workbooks = await Workbook.find({ userId: req.userId }).sort({ year: -1 }).lean()
    const settings = await getSettings(req.userId)
    res.json({ workbooks, active: settings?.activeWorkbookName || null, activeYear: settings?.activeYear || null })
  } catch (err) {
    res.status(500).json({ error: 'Failed to list workbooks.' })
  }
})

// GET /api/documents/workbook/download?year=YYYY - download a workbook file.
// Defaults to the active workbook when no year is given (dashboard Export).
// Every lookup is scoped to req.userId - workbooks are per-user, never shared.
router.get('/workbook/download', async (req, res) => {
  try {
    const Workbook = require('../models/Workbook')
    let filename
    if (req.query.workbookId) {
      // Lets a specific archived record (as listed by GET /workbooks) be
      // downloaded unambiguously - a year can now hold more than one
      // Workbook record since a same-year "start new file" archives the old
      // one instead of overwriting it.
      if (!isValidObjectId(req.query.workbookId)) {
        return res.status(400).json({ error: 'Invalid workbook id.' })
      }
      const wb = await Workbook.findOne({ _id: req.query.workbookId, userId: req.userId })
      if (!wb) return res.status(404).json({ error: 'Workbook not found.' })
      filename = wb.filename
    } else if (req.query.year) {
      // Prefer the currently active workbook for that year, else the most
      // recently archived one, so a plain year lookup stays deterministic.
      const wb = await Workbook.findOne({ year: Number(req.query.year), userId: req.userId }).sort({ isActive: -1, createdAt: -1 })
      if (!wb) return res.status(404).json({ error: 'No workbook for that year.' })
      filename = wb.filename
    } else {
      const settings = await getSettings(req.userId)
      if (!settings || !settings.activeWorkbookName) {
        return res.status(400).json({ error: 'NO_ACTIVE_WORKBOOK', message: 'No active Excel workbook yet. Save a document first.' })
      }
      filename = settings.activeWorkbookName
    }

    const target = excel.filePath(physicalWorkbookFilename(req.userId, filename))
    if (!require('fs').existsSync(target)) {
      return res.status(404).json({ error: 'Workbook file not found on the server.' })
    }
    res.download(target, filename.endsWith('.xlsx') ? filename : `${filename}.xlsx`)
  } catch (err) {
    console.error('Workbook download error:', err)
    res.status(500).json({ error: 'Failed to download the workbook.' })
  }
})

// GET /api/documents/:id
router.get('/:id', async (req, res) => {
  try {
    const doc = await Document.findOne({ _id: req.params.id, userId: req.userId, isDeleted: { $ne: true } })
      .select('-ocrTextHidden')
    if (!doc) return res.status(404).json({ error: 'Document not found.' })
    res.json({ document: doc })
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch document.' })
  }
})

// GET /api/documents/:id/download
router.get('/:id/download', async (req, res) => {
  try {
    const doc = await Document.findOne({ _id: req.params.id, userId: req.userId, isDeleted: { $ne: true } })
    if (!doc) return res.status(404).json({ error: 'Document not found.' })

    const buffer = await downloadBuffer(doc.gridFsFileId)
    res.set('Content-Type', doc.mimeType)
    res.set('Content-Disposition', `attachment; filename="${encodeURIComponent(doc.originalFilename)}"`)
    res.send(buffer)
  } catch (err) {
    console.error('Download error:', err)
    res.status(500).json({ error: 'Failed to download file.' })
  }
})

// POST /api/documents/:id/reprocess
router.post('/:id/reprocess', async (req, res) => {
  try {
    const doc = await Document.findOne({ _id: req.params.id, userId: req.userId, isDeleted: { $ne: true } })
    if (!doc) return res.status(404).json({ error: 'Document not found.' })

    const buffer = await downloadBuffer(doc.gridFsFileId)

    await Document.findByIdAndUpdate(doc._id, {
      uploadStatus: 'uploaded',
      processingError: null,
      taxInvoiceNo: null,
      referenceNo: null,
      number: null,
      date: null,
      edited: false,
    })

    // Queue reprocessing - only 1 OCR job runs at a time to prevent OOM
    enqueue(() => processDocument(doc._id, buffer, doc.mimeType, doc.documentType), req.userId)
      .then(() => updateActiveDocument(doc._id, { reprocessedAt: new Date() }))
      .catch(err => console.error('Reprocess background error:', err.message))

    res.json({ message: 'Reprocessing started. Check document status shortly.' })
  } catch (err) {
    console.error('Reprocess error:', err)
    res.status(500).json({ error: 'Reprocessing failed.' })
  }
})

// DELETE /api/documents/:id
router.delete('/:id', async (req, res) => {
  try {
    const doc = await Document.findOne({ _id: req.params.id, userId: req.userId, isDeleted: { $ne: true } })
    if (!doc) return res.status(404).json({ error: 'Document not found.' })

    await Document.findByIdAndUpdate(doc._id, {
      isDeleted: true,
      deletedAt: new Date(),
    })
    if (doc.gridFsFileId) {
      try {
        await deleteFile(doc.gridFsFileId)
      } catch (err) {
        console.warn(`Failed to delete GridFS file for document ${doc._id}: ${err.message}`)
      }
    }
    res.json({ message: 'Document deleted successfully.' })
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete document.' })
  }
})

// PATCH /api/documents/:id/correct - editable fields are documentType-conditional:
// Tax Invoice -> taxInvoiceNo | referenceNo | date. Delivery Challan -> number | date.
const EDITABLE_FIELDS = ['taxInvoiceNo', 'referenceNo', 'number', 'date']
const FIELDS_BY_DOCUMENT_TYPE = {
  'Tax Invoice': ['taxInvoiceNo', 'referenceNo', 'date'],
  'Delivery Challan': ['number', 'date'],
}
router.patch('/:id/correct', async (req, res) => {
  try {
    const { field, value } = req.body
    if (!EDITABLE_FIELDS.includes(field)) {
      return res.status(400).json({ error: 'That field cannot be edited.' })
    }
    if (!value || !value.trim()) {
      return res.status(400).json({ error: 'Please enter a value before saving.' })
    }

    const doc = await Document.findOne({ _id: req.params.id, userId: req.userId, isDeleted: { $ne: true } })
    if (!doc) return res.status(404).json({ error: 'Document not found.' })

    // A document still mid-OCR can have its uploadStatus flip to 'processed'
    // right after this handler reads it and silently overwrite a correction
    // made in that window - block corrections until processing has actually
    // finished, so there's no race between a manual edit and the OCR result.
    if (doc.uploadStatus !== 'processed' && doc.uploadStatus !== 'failed') {
      return res.status(409).json({ error: 'This document is still being processed. Please wait for it to finish before editing.' })
    }

    if (!FIELDS_BY_DOCUMENT_TYPE[doc.documentType].includes(field)) {
      return res.status(400).json({ error: `That field cannot be edited on a ${doc.documentType} document.` })
    }

    if (field === 'date') {
      const { normalizeDateToDDMMYYYY } = require('../services/groq')
      const normalized = normalizeDateToDDMMYYYY(value.trim())
      if (!normalized) return res.status(400).json({ error: 'Date must be in DD/MM/YYYY format.' })
    }

    const oldValue = doc[field]
    doc[field] = value.trim()
    doc.edited = true
    // Manually verified by the user, so it's no longer a "please verify" case.
    doc[`${field}Confidence`] = 100
    await doc.save()

    await Correction.create({
      documentId: doc._id,
      fieldLabel: field,
      fieldKey: field,
      oldValue,
      newValue: value.trim(),
      correctedAt: new Date(),
    })

    const updated = doc.toObject()
    delete updated.ocrTextHidden
    res.json({ message: 'Field corrected successfully.', document: updated })
  } catch (err) {
    console.error('Correction error:', err)
    res.status(500).json({ error: 'Failed to save correction.' })
  }
})

// Workbooks/Settings are per-user, but excel.js resolves a filename straight
// to a shared backend/exports/ directory - two users picking the same
// display name would otherwise read/write the SAME physical .xlsx file even
// though their Workbook/Settings records are isolated. Namespacing the
// on-disk filename with the owning userId keeps the files themselves
// isolated too, without changing services/excel.js at all (it just gets
// handed a different string).
function physicalWorkbookFilename(userId, filename) {
  return `${userId}_${filename}`
}

function getSettings(userId) {
  return Settings.findOne({ userId, key: 'excelState' })
}

// POST /api/documents/new-excel-file - creates a new active yearly workbook
// for the AUTHENTICATED USER. Body: { filename }. Used for the first-ever
// workbook, when the year rolls over, and when the user manually starts a
// new file mid-year. Whatever workbook this user had previously active -
// same year or not - is archived (kept on disk, marked isActive:false/
// archivedAt set, same as year rollover) rather than overwritten, so it
// stays listed/downloadable. Never touches other users' workbooks.
router.post('/new-excel-file', async (req, res) => {
  try {
    const { filename } = req.body
    if (!filename || !filename.trim()) {
      return res.status(400).json({ error: 'filename is required.' })
    }
    const trimmed = filename.trim()
    const { year, month } = excel.currentPeriod()

    // Archive whatever workbook THIS USER currently has active, regardless
    // of year - this covers both year rollover AND a same-year "start new
    // file" click, which previously just silently overwrote the same-year
    // record.
    await Workbook.updateMany(
      { userId: req.userId, isActive: true },
      { $set: { isActive: false, archivedAt: new Date() } }
    )

    await excel.createWorkbook(physicalWorkbookFilename(req.userId, trimmed), month)
    await Workbook.create({ userId: req.userId, year, filename: trimmed, isActive: true, archivedAt: null })
    await Settings.findOneAndUpdate(
      { userId: req.userId, key: 'excelState' },
      { $set: { activeWorkbookName: trimmed, activeYear: year } },
      { upsert: true }
    )
    res.json({ message: 'New Excel workbook started.', filename: trimmed, year })
  } catch (err) {
    console.error('new-excel-file error:', err)
    res.status(500).json({ error: 'Failed to start a new Excel workbook.' })
  }
})

// POST /api/documents/:id/save - appends this document's row to the CURRENT
// month's worksheet in the active workbook. No download. Handles automatic
// monthly worksheet switching (appendRow creates the month sheet if missing)
// and signals year rollover so the frontend can prompt for a new workbook name.
router.post('/:id/save', async (req, res) => {
  try {
    const doc = await Document.findOne({ _id: req.params.id, userId: req.userId, isDeleted: { $ne: true } })
    if (!doc) return res.status(404).json({ error: 'Document not found.' })
    if (doc.uploadStatus !== 'processed') {
      return res.status(400).json({ error: 'Document has not been processed yet.' })
    }

    const { year } = excel.currentPeriod()
    const settings = await getSettings(req.userId)

    if (!settings || !settings.activeWorkbookName) {
      return res.status(400).json({ error: 'NO_ACTIVE_WORKBOOK', message: 'No active Excel workbook. Start one first.' })
    }

    // Year rollover: archive the old workbook and ask the frontend to create a
    // new one for the new year (prompts the user once for its name, then retries
    // this save). Previous year's file stays on disk, untouched.
    if (settings.activeYear !== year) {
      await Workbook.updateMany(
        { userId: req.userId, isActive: true, year: settings.activeYear },
        { $set: { isActive: false, archivedAt: new Date() } }
      )
      return res.status(409).json({
        error: 'NEED_NEW_WORKBOOK',
        year,
        message: `The year changed to ${year}. Create a new workbook for ${year} to continue.`,
      })
    }

    const row = {
      documentType: doc.documentType,
      taxInvoiceNo: doc.taxInvoiceNo,
      referenceNo: doc.referenceNo,
      number: doc.number,
      date: doc.date,
      timestamp: new Date().toISOString(),
    }

    // Worksheet = the document's OWN date, not today's date - a document dated
    // 30/06 always lands in the June sheet even if saved in July.
    const sheetMonth = excel.monthFromDate(doc.date)
    await excel.appendRow(physicalWorkbookFilename(req.userId, settings.activeWorkbookName), sheetMonth, row)

    await ExportedRow.create({
      documentId: doc._id,
      documentType: row.documentType,
      taxInvoiceNo: row.taxInvoiceNo,
      referenceNo: row.referenceNo,
      number: row.number,
      date: row.date,
    })

    res.json({ message: 'Excel file appended successfully.', worksheet: sheetMonth, workbook: settings.activeWorkbookName })
  } catch (err) {
    console.error('Save error:', err)
    // Surface the exact reason (locked file, permission, etc.) to the user
    // instead of a generic message.
    if (err.code === 'FILE_LOCKED') {
      return res.status(409).json({ error: err.message })
    }
    res.status(500).json({ error: err.message || 'Failed to append to the Excel file.' })
  }
})

router.recoverInterruptedUploads = recoverInterruptedUploads
router.enqueue = enqueue

module.exports = router
