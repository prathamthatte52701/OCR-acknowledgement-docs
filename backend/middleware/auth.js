const jwt = require('jsonwebtoken')

// Verifies the Bearer token on every protected request and attaches the
// decoded user id as req.userId. Any route mounted behind this never runs
// its handler without a valid, non-expired token.
function requireAuth(req, res, next) {
  const header = req.headers.authorization || ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : null
  if (!token) return res.status(401).json({ error: 'Not authenticated.' })

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET)
    req.userId = payload.userId
    next()
  } catch {
    res.status(401).json({ error: 'Invalid or expired session. Please log in again.' })
  }
}

module.exports = { requireAuth }
