const express = require('express')
const router = express.Router({ mergeParams: true })
const rateLimit = require('express-rate-limit')
const Document = require('../models/Document')
const ChatMessage = require('../models/ChatMessage')
const ChatFeedback = require('../models/ChatFeedback')
const { answerQuestion } = require('../services/groq')
const { isValidObjectId } = require('../utils/objectId')

const CHAT_LIMIT = 50

// :id here is merged in from the parent mount path (/api/documents/:id/chat),
// not a param of this router, so it isn't covered by router.param() and needs
// an explicit check in each handler below. :messageId IS this router's own
// param, so router.param() covers it once for the feedback route.
router.param('messageId', (req, res, next, messageId) => {
  if (!isValidObjectId(messageId)) return res.status(400).json({ error: 'Invalid message id.' })
  next()
})

// Every chat message hits the Groq API - throttle per authenticated user
// (not IP, since this route always runs behind requireAuth) to cap API cost
// from any one account.
const chatLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.userId,
  message: { error: 'Too many messages. Please slow down and try again shortly.' },
})

// GET /api/documents/:id/chat
router.get('/', async (req, res) => {
  try {
    if (!isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid document id.' })

    // ChatMessage/ChatFeedback have no userId of their own - they're scoped
    // entirely through this ownership check on their parent Document, same
    // pattern as routes/documents.js. A 404 here means no message below it
    // is ever reached, so no separate userId field is needed on those models.
    const doc = await Document.findOne({ _id: req.params.id, userId: req.userId, isDeleted: { $ne: true } }).select('_id')
    if (!doc) return res.status(404).json({ error: 'Document not found.' })

    const messages = await ChatMessage.find({ documentId: req.params.id })
      .sort({ createdAt: 1 })
      .limit(CHAT_LIMIT)
    res.json({ messages })
  } catch {
    res.status(500).json({ error: 'Failed to load chat history.' })
  }
})

// POST /api/documents/:id/chat
router.post('/', chatLimiter, async (req, res) => {
  try {
    if (!isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid document id.' })

    const { message } = req.body
    if (!message?.trim()) return res.status(400).json({ error: 'Message is required.' })

    const doc = await Document.findOne({ _id: req.params.id, userId: req.userId, isDeleted: { $ne: true } })
    if (!doc) return res.status(404).json({ error: 'Document not found.' })
    if (doc.uploadStatus !== 'processed') {
      return res.status(400).json({ error: 'Document has not been processed yet.' })
    }

    // Save user message
    await ChatMessage.create({
      documentId: doc._id,
      role: 'user',
      message: message.trim(),
    })

    // Generate answer
    let answer
    try {
      answer = await answerQuestion(message.trim(), {
        documentType: doc.documentType,
        taxInvoiceNo: doc.taxInvoiceNo,
        referenceNo: doc.referenceNo,
        number: doc.number,
        date: doc.date,
      })
    } catch (err) {
      answer = 'AI analysis is unavailable. Please check the Groq API key or try again later.'
    }

    const assistantMsg = await ChatMessage.create({
      documentId: doc._id,
      role: 'assistant',
      message: answer,
    })

    const count = await ChatMessage.countDocuments({ documentId: doc._id })
    const excess = count - CHAT_LIMIT
    if (excess > 0) {
      const oldest = await ChatMessage.find({ documentId: doc._id }).sort({ createdAt: 1 }).limit(excess).select('_id')
      await ChatMessage.deleteMany({ _id: { $in: oldest.map(m => m._id) } })
    }

    res.json({ message: assistantMsg })
  } catch (err) {
    console.error('Chat error:', err)
    res.status(500).json({ error: 'Something went wrong. Please try again.' })
  }
})

// POST /api/documents/:id/chat/:messageId/feedback
router.post('/:messageId/feedback', async (req, res) => {
  try {
    if (!isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid document id.' })

    const r = Number(req.body.rating)
    if (!r || r < 1 || r > 10) return res.status(400).json({ error: 'Rating must be 1-10.' })

    const doc = await Document.findOne({ _id: req.params.id, userId: req.userId, isDeleted: { $ne: true } }).select('_id')
    if (!doc) return res.status(404).json({ error: 'Document not found.' })

    const msg = await ChatMessage.findOne({ _id: req.params.messageId, documentId: req.params.id }).select('_id')
    if (!msg) return res.status(404).json({ error: 'Message not found.' })

    await ChatFeedback.findOneAndUpdate(
      { documentId: req.params.id, messageId: req.params.messageId },
      { $set: { rating: r } },
      { upsert: true }
    )
    res.json({ ok: true })
  } catch (err) {
    console.error('Feedback error:', err.message)
    res.status(500).json({ error: 'Failed to save feedback.' })
  }
})

module.exports = router
