const mongoose = require('mongoose')

const documentSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  autoName: { type: String, required: true },
  originalFilename: { type: String, required: true },
  mimeType: { type: String, required: true },
  size: { type: Number, required: true },
  gridFsFileId: { type: mongoose.Schema.Types.ObjectId },
  uploadStatus: {
    type: String,
    enum: ['uploaded', 'processed', 'failed'],
    default: 'uploaded',
  },
  // User-selected at upload time, not AI-guessed - determines which fields
  // below apply and which extraction prompt runs.
  documentType: { type: String, enum: ['Tax Invoice', 'Delivery Challan'], required: true },

  // Tax Invoice has two distinct number fields on the real form - the "TAX
  // INVOICE" box number and a separate "Reference No." next to the date.
  // Delivery Challan has just one number field. Unused fields for a given
  // documentType stay null.
  taxInvoiceNo: { type: String, default: null },
  referenceNo: { type: String, default: null },
  number: { type: String, default: null },
  date: { type: String, default: null }, // DD/MM/YYYY

  // 0-100, null = no extraction attempted yet (e.g. document still processing).
  // See services/groq.js for how these are derived - no per-field score is
  // available from Tesseract in this pipeline, so this is the AI-uncertainty
  // signal described there instead.
  taxInvoiceNoConfidence: { type: Number, default: null },
  referenceNoConfidence: { type: Number, default: null },
  numberConfidence: { type: Number, default: null },
  dateConfidence: { type: Number, default: null },

  edited: { type: Boolean, default: false },
  ocrTextHidden: String,

  processingError: String,
  processedAt: Date,
  reprocessedAt: Date,
  isDeleted: { type: Boolean, default: false },
  deletedAt: Date,
}, {
  timestamps: true,
})

module.exports = mongoose.model('Document', documentSchema)
