const express = require('express')
const router = express.Router()
const fs = require('fs')
const User = require('../models/User')
const Document = require('../models/Document')
const Correction = require('../models/Correction')
const Workbook = require('../models/Workbook')
const ExportedRow = require('../models/ExportedRow')
const Settings = require('../models/Settings')
const ChatMessage = require('../models/ChatMessage')
const ChatFeedback = require('../models/ChatFeedback')
const AuditLog = require('../models/AuditLog')
const { deleteFile } = require('../services/gridfs')
const excel = require('../services/excel')
const { logAction } = require('../services/auditLog')
const { isValidObjectId } = require('../utils/objectId')
const { normalizeEmail, normalizeUsername, validateUsername, validateEmail } = require('../utils/validators')

// Same on-disk naming scheme documents.js uses for per-user workbook files -
// duplicated here (one line) rather than exported from documents.js, to keep
// this admin router self-contained and documents.js untouched beyond its
// audit-log hooks.
function physicalWorkbookFilename(userId, filename) {
  return `${userId}_${filename}`
}

// Same documentType -> editable-fields map documents.js uses for PATCH
// /:id/correct - duplicated (not exported) for the same reason as above.
const EDITABLE_FIELDS = ['taxInvoiceNo', 'referenceNo', 'number', 'date']
const FIELDS_BY_DOCUMENT_TYPE = {
  'Tax Invoice': ['taxInvoiceNo', 'referenceNo', 'date'],
  'Delivery Challan': ['number', 'date'],
}

function parsePagination(query, defaultLimit = 30) {
  const limit = Math.max(1, parseInt(query.limit, 10) || defaultLimit)
  const page = Math.max(1, parseInt(query.page, 10) || 1)
  return { limit, page, skip: (page - 1) * limit }
}

router.param('id', (req, res, next, id) => {
  if (!isValidObjectId(id)) return res.status(400).json({ error: 'Invalid id.' })
  next()
})

router.get('/ping', (req, res) => {
  res.json({ ok: true, admin: true })
})

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

// GET /api/admin/users
router.get('/users', async (req, res) => {
  try {
    const { limit, page, skip } = parsePagination(req.query)
    const [users, totalUsers] = await Promise.all([
      User.find({}).select('-passwordHash').sort({ createdAt: -1 }).skip(skip).limit(limit),
      User.countDocuments({}),
    ])
    res.json({
      users,
      totalUsers,
      totalPages: Math.max(1, Math.ceil(totalUsers / limit)),
      currentPage: page,
    })
  } catch (err) {
    console.error('Admin list users error:', err)
    res.status(500).json({ error: 'Failed to list users.' })
  }
})

// GET /api/admin/users/:id
router.get('/users/:id', async (req, res) => {
  try {
    const user = await User.findById(req.params.id).select('-passwordHash')
    if (!user) return res.status(404).json({ error: 'User not found.' })
    res.json({ user })
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch user.' })
  }
})

// PATCH /api/admin/users/:id - edit name/email/role. Same validation rules
// signup/profile-update already use, plus a role enum check.
router.patch('/users/:id', async (req, res) => {
  try {
    const user = await User.findById(req.params.id)
    if (!user) return res.status(404).json({ error: 'User not found.' })

    if (req.body.username !== undefined) {
      const username = normalizeUsername(req.body.username)
      const usernameErr = validateUsername(username)
      if (usernameErr) return res.status(400).json({ error: usernameErr })
      user.username = username
    }

    if (req.body.email !== undefined) {
      const email = normalizeEmail(req.body.email)
      const emailErr = validateEmail(email)
      if (emailErr) return res.status(400).json({ error: emailErr })
      if (email !== user.email) {
        const existing = await User.findOne({ email })
        if (existing) return res.status(400).json({ error: 'That email is already in use.' })
        user.email = email
      }
    }

    if (req.body.role !== undefined) {
      if (!['user', 'admin'].includes(req.body.role)) {
        return res.status(400).json({ error: "Role must be 'user' or 'admin'." })
      }
      user.role = req.body.role
    }

    await user.save()
    await logAction(req.userId, 'user_updated', { targetUserId: user._id, fields: Object.keys(req.body) })

    const updated = user.toObject()
    delete updated.passwordHash
    res.json({ user: updated })
  } catch (err) {
    console.error('Admin update user error:', err)
    res.status(500).json({ error: 'Failed to update user.' })
  }
})

// DELETE /api/admin/users/:id - cascade delete: every document (+ its GridFS
// file, corrections, chat history), every workbook (+ its .xlsx file on
// disk), every exported-row record, and the excel-state settings row. A
// clean removal rather than an orphaned trail, since this is an admin tool.
router.delete('/users/:id', async (req, res) => {
  try {
    if (req.params.id === req.userId) {
      return res.status(400).json({ error: 'You cannot delete your own account.' })
    }

    const user = await User.findById(req.params.id)
    if (!user) return res.status(404).json({ error: 'User not found.' })

    const docs = await Document.find({ userId: user._id }).select('_id gridFsFileId')
    const docIds = docs.map(d => d._id)

    await Promise.all(docs.map(async (doc) => {
      if (!doc.gridFsFileId) return
      try { await deleteFile(doc.gridFsFileId) } catch (err) {
        console.warn(`Failed to delete GridFS file for document ${doc._id}: ${err.message}`)
      }
    }))

    await Correction.deleteMany({ documentId: { $in: docIds } })
    await ChatFeedback.deleteMany({ documentId: { $in: docIds } })
    await ChatMessage.deleteMany({ documentId: { $in: docIds } })
    await Document.deleteMany({ userId: user._id })
    await ExportedRow.deleteMany({ userId: user._id })

    const workbooks = await Workbook.find({ userId: user._id }).select('_id filename')
    workbooks.forEach((wb) => {
      const target = excel.filePath(physicalWorkbookFilename(user._id, wb.filename))
      if (fs.existsSync(target)) {
        try { fs.unlinkSync(target) } catch (err) {
          console.warn(`Failed to delete workbook file ${target}: ${err.message}`)
        }
      }
    })
    await Workbook.deleteMany({ userId: user._id })
    await Settings.deleteMany({ userId: user._id })

    const deletedEmail = user.email
    await User.deleteOne({ _id: user._id })

    await logAction(req.userId, 'user_deleted', { targetUserId: user._id, targetEmail: deletedEmail, documentsDeleted: docIds.length, workbooksDeleted: workbooks.length })
    res.json({ message: 'User and all associated data deleted successfully.' })
  } catch (err) {
    console.error('Admin delete user error:', err)
    res.status(500).json({ error: 'Failed to delete user.' })
  }
})

// ---------------------------------------------------------------------------
// Documents (cross-user)
// ---------------------------------------------------------------------------

// GET /api/admin/documents?userId= - every user's documents (owner attached),
// or one user's documents when userId is given.
router.get('/documents', async (req, res) => {
  try {
    const { limit, page, skip } = parsePagination(req.query)
    const filter = { isDeleted: { $ne: true } }
    if (req.query.userId) {
      if (!isValidObjectId(req.query.userId)) return res.status(400).json({ error: 'Invalid userId.' })
      filter.userId = req.query.userId
    }
    const [documents, totalDocuments] = await Promise.all([
      Document.find(filter)
        .sort({ createdAt: -1 })
        .select('-ocrTextHidden')
        .populate('userId', 'username email')
        .skip(skip)
        .limit(limit),
      Document.countDocuments(filter),
    ])
    res.json({
      documents,
      totalDocuments,
      totalPages: Math.max(1, Math.ceil(totalDocuments / limit)),
      currentPage: page,
    })
  } catch (err) {
    console.error('Admin list documents error:', err)
    res.status(500).json({ error: 'Failed to list documents.' })
  }
})

// PATCH /api/admin/documents/:id - admin can correct any document's fields,
// same field-by-documentType rules as the owner's own correct route.
router.patch('/documents/:id', async (req, res) => {
  try {
    const { field, value } = req.body
    if (!EDITABLE_FIELDS.includes(field)) {
      return res.status(400).json({ error: 'That field cannot be edited.' })
    }
    if (!value || !value.trim()) {
      return res.status(400).json({ error: 'Please enter a value before saving.' })
    }

    const doc = await Document.findOne({ _id: req.params.id, isDeleted: { $ne: true } })
    if (!doc) return res.status(404).json({ error: 'Document not found.' })

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
    await logAction(req.userId, 'document_corrected', { documentId: doc._id, field, byAdmin: true })

    const updated = doc.toObject()
    delete updated.ocrTextHidden
    res.json({ message: 'Field corrected successfully.', document: updated })
  } catch (err) {
    console.error('Admin correct document error:', err)
    res.status(500).json({ error: 'Failed to save correction.' })
  }
})

// DELETE /api/admin/documents/:id - admin can delete any document, any owner.
router.delete('/documents/:id', async (req, res) => {
  try {
    const doc = await Document.findOne({ _id: req.params.id, isDeleted: { $ne: true } })
    if (!doc) return res.status(404).json({ error: 'Document not found.' })

    await Document.findByIdAndUpdate(doc._id, { isDeleted: true, deletedAt: new Date() })
    if (doc.gridFsFileId) {
      try { await deleteFile(doc.gridFsFileId) } catch (err) {
        console.warn(`Failed to delete GridFS file for document ${doc._id}: ${err.message}`)
      }
    }
    await logAction(req.userId, 'document_deleted', { documentId: doc._id, ownerUserId: doc.userId, byAdmin: true })
    res.json({ message: 'Document deleted successfully.' })
  } catch (err) {
    console.error('Admin delete document error:', err)
    res.status(500).json({ error: 'Failed to delete document.' })
  }
})

// ---------------------------------------------------------------------------
// Workbooks (cross-user)
// ---------------------------------------------------------------------------

// GET /api/admin/workbooks - every user's workbooks, owner attached.
router.get('/workbooks', async (req, res) => {
  try {
    const workbooks = await Workbook.find({})
      .sort({ year: -1, createdAt: -1 })
      .populate('userId', 'username email')
      .lean()
    res.json({ workbooks })
  } catch (err) {
    console.error('Admin list workbooks error:', err)
    res.status(500).json({ error: 'Failed to list workbooks.' })
  }
})

// GET /api/admin/workbooks/:id/download - admin can download any user's workbook.
router.get('/workbooks/:id/download', async (req, res) => {
  try {
    const wb = await Workbook.findById(req.params.id)
    if (!wb) return res.status(404).json({ error: 'Workbook not found.' })

    const target = excel.filePath(physicalWorkbookFilename(wb.userId, wb.filename))
    if (!fs.existsSync(target)) {
      return res.status(404).json({ error: 'Workbook file not found on the server.' })
    }
    const downloadName = wb.filename.endsWith('.xlsx') ? wb.filename : `${wb.filename}.xlsx`
    res.download(target, downloadName)
  } catch (err) {
    console.error('Admin workbook download error:', err)
    res.status(500).json({ error: 'Failed to download the workbook.' })
  }
})

// ---------------------------------------------------------------------------
// Exports (cross-user)
// ---------------------------------------------------------------------------

// GET /api/admin/exports?userId= - every export ever made (workbook attached),
// or one user's exports when userId is given.
router.get('/exports', async (req, res) => {
  try {
    const { limit, page, skip } = parsePagination(req.query)
    const filter = {}
    if (req.query.userId) {
      if (!isValidObjectId(req.query.userId)) return res.status(400).json({ error: 'Invalid userId.' })
      filter.userId = req.query.userId
    }
    const [exports, totalExports] = await Promise.all([
      ExportedRow.find(filter)
        .sort({ exportedAt: -1 })
        .populate('workbookId', 'filename year')
        .skip(skip)
        .limit(limit),
      ExportedRow.countDocuments(filter),
    ])
    res.json({
      exports,
      totalExports,
      totalPages: Math.max(1, Math.ceil(totalExports / limit)),
      currentPage: page,
    })
  } catch (err) {
    console.error('Admin list exports error:', err)
    res.status(500).json({ error: 'Failed to list exports.' })
  }
})

// ---------------------------------------------------------------------------
// Audit logs
// ---------------------------------------------------------------------------

// GET /api/admin/logs?action=&userId=&page=&limit=
router.get('/logs', async (req, res) => {
  try {
    const { limit, page, skip } = parsePagination(req.query)
    const filter = {}
    if (req.query.action) filter.action = req.query.action
    if (req.query.userId) {
      if (!isValidObjectId(req.query.userId)) return res.status(400).json({ error: 'Invalid userId.' })
      filter.userId = req.query.userId
    }

    const [logs, totalLogs] = await Promise.all([
      AuditLog.find(filter)
        .sort({ createdAt: -1 })
        .populate('userId', 'username email')
        .skip(skip)
        .limit(limit),
      AuditLog.countDocuments(filter),
    ])
    res.json({
      logs,
      totalLogs,
      totalPages: Math.max(1, Math.ceil(totalLogs / limit)),
      currentPage: page,
    })
  } catch (err) {
    console.error('Admin list logs error:', err)
    res.status(500).json({ error: 'Failed to list logs.' })
  }
})

// ---------------------------------------------------------------------------
// Telemetry
// ---------------------------------------------------------------------------

// GET /api/admin/telemetry - unscoped version of the per-user stats the main
// dashboard already computes client-side from GET /api/documents (documents
// array + reduce) - same reduce-in-JS approach, just over every user's docs.
router.get('/telemetry', async (req, res) => {
  try {
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000)
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)

    const [totalUsers, documents, totalExports, activity24h, activity7d] = await Promise.all([
      User.countDocuments({}),
      Document.find({ isDeleted: { $ne: true } }).select('uploadStatus documentType'),
      ExportedRow.countDocuments({}),
      AuditLog.countDocuments({ createdAt: { $gte: dayAgo } }),
      AuditLog.countDocuments({ createdAt: { $gte: weekAgo } }),
    ])

    const byStatus = { uploaded: 0, processed: 0, failed: 0 }
    const byType = { 'Tax Invoice': 0, 'Delivery Challan': 0 }
    documents.forEach((d) => {
      if (d.uploadStatus in byStatus) byStatus[d.uploadStatus]++
      if (d.documentType in byType) byType[d.documentType]++
    })
    const finished = byStatus.processed + byStatus.failed
    const ocrFailureRate = finished > 0 ? Math.round((byStatus.failed / finished) * 1000) / 10 : 0

    res.json({
      totalUsers,
      totalDocuments: documents.length,
      totalExports,
      documentsByStatus: byStatus,
      documentsByType: byType,
      ocrFailureRate,
      recentActivity: { last24h: activity24h, last7d: activity7d },
    })
  } catch (err) {
    console.error('Admin telemetry error:', err)
    res.status(500).json({ error: 'Failed to load telemetry.' })
  }
})

module.exports = router
