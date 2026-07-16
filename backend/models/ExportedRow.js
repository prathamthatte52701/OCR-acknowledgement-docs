const mongoose = require('mongoose')

// Running log of every export - separate from Document so it survives even if
// a document is later deleted/reprocessed, and gives an audit trail independent
// of the Excel file on disk.
const exportedRowSchema = new mongoose.Schema({
  documentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Document', required: true, index: true },
  documentType: { type: String, required: true },
  taxInvoiceNo: { type: String, default: null },
  referenceNo: { type: String, default: null },
  number: { type: String, default: null },
  date: { type: String, default: null },
  exportedAt: { type: Date, default: Date.now },
})

module.exports = mongoose.model('ExportedRow', exportedRowSchema)
