const express = require('express')
const router = express.Router()
const multer = require('multer')
const path = require('path')

// -- Processing queue - max 1 OCR job at a time to prevent OOM crashes ---------
let _processing = false
const _queue = []
function enqueue(fn) {
  return new Promise((resolve, reject) => {
    _queue.push({ fn, resolve, reject })
    drainQueue()
  })
}
async function drainQueue() {
  if (_processing || _queue.length === 0) return
  _processing = true
  const { fn, resolve, reject } = _queue.shift()
  try { resolve(await fn()) } catch (e) { reject(e) }
  finally { _processing = false; drainQueue() }
}

const Document = require('../models/Document')
const Correction = require('../models/Correction')
const Settings = require('../models/Settings')
const ExportedRow = require('../models/ExportedRow')
const { uploadBuffer, downloadBuffer, deleteFile } = require('../services/gridfs')
const { extractHeaderText } = require('../services/ocr')
const { extractHeader } = require('../services/groq')
const excel = require('../services/excel')

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
      const info = await parser.getInfo() // metadata only, no text/page extraction
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

// POST /api/documents/upload
router.post('/upload', uploadMiddleware, async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded.' })
    }

    const documentType = req.body.documentType
    if (!DOCUMENT_TYPES.includes(documentType)) {
      return res.status(400).json({ error: 'documentType must be "Tax Invoice" or "Delivery Challan".' })
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
      autoName,
      originalFilename: originalname,
      mimeType: mimetype,
      size,
      gridFsFileId,
      documentType,
      uploadStatus: 'uploaded',
    })

    // Queue processing - only 1 OCR job runs at a time to prevent OOM
    enqueue(() => processDocument(doc._id, buffer, mimetype, documentType)).catch(err => {
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
        processingError: 'We could not read this document.',
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
    .select('_id mimeType gridFsFileId documentType')

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
    }).catch(err => console.error('Recovery queue error:', err.message))
  })

  return docs.length
}

// GET /api/documents
router.get('/', async (req, res) => {
  try {
    const documents = await Document.find({ isDeleted: { $ne: true } })
      .sort({ createdAt: -1 })
      .select('-ocrTextHidden')
    res.json({ documents })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to fetch documents.' })
  }
})

// GET /api/documents/:id
router.get('/:id', async (req, res) => {
  try {
    const doc = await Document.findOne({ _id: req.params.id, isDeleted: { $ne: true } })
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
    const doc = await Document.findOne({ _id: req.params.id, isDeleted: { $ne: true } })
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
    const doc = await Document.findOne({ _id: req.params.id, isDeleted: { $ne: true } })
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
    enqueue(() => processDocument(doc._id, buffer, doc.mimeType, doc.documentType))
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
    const doc = await Document.findOne({ _id: req.params.id, isDeleted: { $ne: true } })
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
router.patch('/:id/correct', async (req, res) => {
  try {
    const { field, value } = req.body
    if (!EDITABLE_FIELDS.includes(field)) {
      return res.status(400).json({ error: 'field must be one of: ' + EDITABLE_FIELDS.join(', ') })
    }
    if (!value || !value.trim()) {
      return res.status(400).json({ error: 'New value is required.' })
    }

    const doc = await Document.findOne({ _id: req.params.id, isDeleted: { $ne: true } })
    if (!doc) return res.status(404).json({ error: 'Document not found.' })

    if (field === 'date') {
      const { normalizeDateToDDMMYYYY } = require('../services/groq')
      const normalized = normalizeDateToDDMMYYYY(value.trim())
      if (!normalized) return res.status(400).json({ error: 'Date must be in DD/MM/YYYY format.' })
    }

    const oldValue = doc[field]
    doc[field] = value.trim()
    doc.edited = true
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

// POST /api/documents/new-excel-file - starts (or resets) the active export
// workbook. Body: { filename }.
router.post('/new-excel-file', async (req, res) => {
  try {
    const { filename } = req.body
    if (!filename || !filename.trim()) {
      return res.status(400).json({ error: 'filename is required.' })
    }
    const trimmed = filename.trim()
    await excel.createNewFile(trimmed)
    await Settings.findOneAndUpdate(
      { key: 'activeExcelFile' },
      { $set: { filename: trimmed } },
      { upsert: true }
    )
    res.json({ message: 'New Excel file started.', filename: trimmed })
  } catch (err) {
    console.error('new-excel-file error:', err)
    res.status(500).json({ error: 'Failed to start a new Excel file.' })
  }
})

// POST /api/documents/:id/export - appends this document's row to the active
// workbook and logs an ExportedRow, then streams the file back for download.
router.post('/:id/export', async (req, res) => {
  try {
    const doc = await Document.findOne({ _id: req.params.id, isDeleted: { $ne: true } })
    if (!doc) return res.status(404).json({ error: 'Document not found.' })
    if (doc.uploadStatus !== 'processed') {
      return res.status(400).json({ error: 'Document has not been processed yet.' })
    }

    const settings = await Settings.findOne({ key: 'activeExcelFile' })
    if (!settings || !settings.filename) {
      return res.status(400).json({ error: 'NO_ACTIVE_FILE', message: 'No active Excel file. Start one first.' })
    }

    const row = {
      documentType: doc.documentType,
      taxInvoiceNo: doc.taxInvoiceNo,
      referenceNo: doc.referenceNo,
      number: doc.number,
      date: doc.date,
      timestamp: new Date().toISOString(),
    }

    const target = await excel.appendRow(settings.filename, row)

    await ExportedRow.create({
      documentId: doc._id,
      documentType: row.documentType,
      taxInvoiceNo: row.taxInvoiceNo,
      referenceNo: row.referenceNo,
      number: row.number,
      date: row.date,
    })

    res.download(target)
  } catch (err) {
    console.error('Export error:', err)
    res.status(500).json({ error: 'Failed to export document.' })
  }
})

router.recoverInterruptedUploads = recoverInterruptedUploads

module.exports = router
