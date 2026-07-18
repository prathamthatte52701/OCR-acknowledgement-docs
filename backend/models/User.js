const mongoose = require('mongoose')

// Email is lowercased before every save/query so "A@B.com" and "a@b.com" can
// never both register - the unique index alone wouldn't catch case variants.
// 8-char maxlength is the SIGNUP-FORM rule (enforced by validateUsername in
// utils/validators.js, before any User is ever created/edited by a normal
// user) - the schema's own ceiling is deliberately looser (40) so it stays a
// sane upper bound without also being the thing that rejects every later
// .save() on a row - like the seeded admin account - whose display name was
// inserted directly and doesn't fit the signup-form range.
const userSchema = new mongoose.Schema({
  username: { type: String, required: true, minlength: 3, maxlength: 40 },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true },
  // 'admin' unlocks the separate admin/ app - see middleware/isAdmin.js, which
  // is the actual enforcement point (always a fresh DB read, never trusts the
  // JWT's role claim alone).
  role: { type: String, enum: ['user', 'admin'], default: 'user' },
  // Bumped to invalidate all previously-issued JWTs for this user (soft-delete,
  // password change) - see requireAuth, which rejects tokens carrying a stale value.
  tokenVersion: { type: Number, default: 0 },
}, { timestamps: true })

module.exports = mongoose.model('User', userSchema)
