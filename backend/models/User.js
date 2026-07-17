const mongoose = require('mongoose')

// Email is lowercased before every save/query so "A@B.com" and "a@b.com" can
// never both register - the unique index alone wouldn't catch case variants.
const userSchema = new mongoose.Schema({
  username: { type: String, required: true, minlength: 3, maxlength: 8 },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true },
}, { timestamps: true })

module.exports = mongoose.model('User', userSchema)
