const mongoose = require('mongoose')

// One record per yearly Excel workbook ever created. Old workbooks are never
// deleted - when the year rolls over the previous year's record is marked
// archived (isActive:false, archivedAt set) and its .xlsx file stays on disk in
// backend/exports/. Metadata lives here so the dashboard can list/download any
// past year's workbook.
const workbookSchema = new mongoose.Schema({
  year: { type: Number, required: true, index: true },
  filename: { type: String, required: true }, // stored .xlsx basename in exports/
  isActive: { type: Boolean, default: true },
  archivedAt: { type: Date, default: null },
}, { timestamps: true })

module.exports = mongoose.model('Workbook', workbookSchema)
