const mongoose = require('mongoose')

// One record per yearly Excel workbook ever created, PER USER - each user has
// their own workbooks, never shared. Old workbooks are never deleted - when
// the year rolls over (or the user starts a new file) the previous record is
// marked archived (isActive:false, archivedAt set) and its .xlsx file stays
// on disk in backend/exports/. Metadata lives here so the dashboard can
// list/download any past year's workbook belonging to that user.
const workbookSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  year: { type: Number, required: true, index: true },
  filename: { type: String, required: true }, // display name; on-disk file is namespaced per user, see documents.js
  isActive: { type: Boolean, default: true },
  archivedAt: { type: Date, default: null },
}, { timestamps: true })

module.exports = mongoose.model('Workbook', workbookSchema)
