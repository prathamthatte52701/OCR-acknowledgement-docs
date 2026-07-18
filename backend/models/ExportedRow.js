const mongoose = require('mongoose')

// Running log of every export - separate from Document so it survives even if
// a document is later deleted/reprocessed, and gives an audit trail independent
// of the Excel file on disk.
const exportedRowSchema = new mongoose.Schema({
  documentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Document', required: true, index: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  // Which workbook this export landed in, set at export time going forward.
  // Nullable so historical rows created before this field existed don't need
  // a backfill - they just show as "unknown workbook" in the history view.
  workbookId: { type: mongoose.Schema.Types.ObjectId, ref: 'Workbook', default: null },
  documentType: { type: String, required: true },
  taxInvoiceNo: { type: String, default: null },
  referenceNo: { type: String, default: null },
  number: { type: String, default: null },
  date: { type: String, default: null },
  exportedAt: { type: Date, default: Date.now },
})

module.exports = mongoose.model('ExportedRow', exportedRowSchema)
