// Signup field rules - kept in one place so the frontend and backend can't
// drift out of sync (frontend re-implements the same regexes for instant
// feedback, but the backend is the source of truth and always re-checks).

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const USERNAME_RE = /^.{3,8}$/
// 8-32 chars, at least one lowercase, one uppercase, one digit, one special char.
const PASSWORD_RE = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).{8,32}$/

function normalizeEmail(email) {
  return typeof email === 'string' ? email.trim().toLowerCase() : email
}

function normalizeUsername(username) {
  return typeof username === 'string' ? username.trim() : username
}

function validateUsername(username) {
  const trimmed = normalizeUsername(username)
  if (typeof trimmed !== 'string' || !trimmed || !USERNAME_RE.test(trimmed)) {
    return 'Username must be 3-8 characters.'
  }
  return null
}

function validateEmail(email) {
  if (typeof email !== 'string' || !EMAIL_RE.test(normalizeEmail(email))) {
    return 'Enter a valid email address.'
  }
  return null
}

function validatePassword(password) {
  if (typeof password !== 'string' || !PASSWORD_RE.test(password)) {
    return 'Password must be 8-32 characters and include an uppercase letter, a lowercase letter, a number, and a special character.'
  }
  if (/\s/.test(password)) {
    return 'Password cannot contain spaces or whitespace.'
  }
  return null
}

module.exports = { normalizeEmail, normalizeUsername, validateUsername, validateEmail, validatePassword, EMAIL_RE, USERNAME_RE, PASSWORD_RE }
