const mongoose = require('mongoose')

// One 'excelState' document PER USER, tracking that user's own currently
// active yearly workbook and its year. Persisted in Mongo so it survives
// restarts and so month/year rollover can be detected on every save. `key`
// is no longer globally unique on its own - every user gets their own
// 'excelState' row, disambiguated by the compound index below.
const settingsSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  key: { type: String, required: true },
  activeWorkbookName: { type: String, default: null },
  activeYear: { type: Number, default: null },
}, { timestamps: true })

settingsSchema.index({ userId: 1, key: 1 }, { unique: true })

module.exports = mongoose.model('Settings', settingsSchema)
