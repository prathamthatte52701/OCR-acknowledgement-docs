const AuditLog = require('../models/AuditLog')

// Best-effort - a logging failure must never break the request that
// triggered it, so errors are swallowed here rather than left for callers
// to remember to catch.
async function logAction(userId, action, context = {}) {
  try {
    await AuditLog.create({ userId, action, context })
  } catch (err) {
    console.error('Audit log write failed:', err.message)
  }
}

module.exports = { logAction }
