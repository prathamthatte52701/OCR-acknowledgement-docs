const mongoose = require('mongoose')

// Append-only trail hooked into auth (login/signup/password_change) and key
// document actions (delete/export) going forward - not backfilled, since
// there is no history to backfill from before this model existed.
const auditLogSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  action: { type: String, required: true, index: true },
  context: { type: mongoose.Schema.Types.Mixed, default: {} },
}, { timestamps: true })

module.exports = mongoose.model('AuditLog', auditLogSchema)
