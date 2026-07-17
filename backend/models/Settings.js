const mongoose = require('mongoose')

// Single-document collection (key: 'excelState') tracking the currently active
// yearly workbook and its year. Persisted in Mongo so it survives restarts and
// so month/year rollover can be detected on every save.
const settingsSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  activeWorkbookName: { type: String, default: null },
  activeYear: { type: Number, default: null },
}, { timestamps: true })

module.exports = mongoose.model('Settings', settingsSchema)
