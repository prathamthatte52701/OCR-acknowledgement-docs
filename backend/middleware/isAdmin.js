const User = require('../models/User')

// Must run AFTER requireAuth (needs req.userId). Deliberately re-reads the
// role from the DB instead of trusting a role claim on the decoded JWT - a
// token payload can be tampered with client-side, a DB row cannot. Combined
// with requireAuth's own signature + tokenVersion check, this means only a
// genuinely-signed, non-revoked token for a user whose CURRENT DB role is
// 'admin' ever passes.
async function isAdmin(req, res, next) {
  try {
    const user = await User.findById(req.userId).select('role')
    if (!user || user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required.' })
    }
    req.user = user
    next()
  } catch {
    res.status(403).json({ error: 'Admin access required.' })
  }
}

module.exports = { isAdmin }
