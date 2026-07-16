const mongoose = require('mongoose')

// Single-document collection - one row, key 'activeExcelFile', tracks which
// workbook filename new exports append to. Persisted in Mongo (not in-memory)
// so it survives server restarts.
const settingsSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  filename: { type: String, default: null },
}, { timestamps: true })

module.exports = mongoose.model('Settings', settingsSchema)
