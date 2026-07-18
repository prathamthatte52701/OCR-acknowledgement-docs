// Mirrors backend/utils/validators.js exactly - frontend runs these for instant
// feedback, but the backend always re-validates; this is not the source of truth.

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
export const USERNAME_RE = /^.{3,8}$/
export const PASSWORD_RE = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).{8,32}$/

export function normalizeEmail(email) {
  return typeof email === 'string' ? email.trim().toLowerCase() : email
}

// Only used for editing OTHER (regular) users on the Users page - the
// admin's own name is shown read-only on the Profile page and never runs
// through this 3-8 char signup-form rule.
export function validateUsername(username) {
  if (typeof username !== 'string' || !USERNAME_RE.test(username)) {
    return 'Name must be 3-8 characters.'
  }
  return null
}

export function validateEmail(email) {
  if (typeof email !== 'string' || !EMAIL_RE.test(normalizeEmail(email))) {
    return 'Enter a valid email address.'
  }
  return null
}

export function validatePassword(password) {
  if (typeof password !== 'string' || !PASSWORD_RE.test(password)) {
    return 'Password must be 8-32 characters and include an uppercase letter, a lowercase letter, a number, and a special character.'
  }
  if (/\s/.test(password)) {
    return 'Password cannot contain spaces or whitespace.'
  }
  return null
}
