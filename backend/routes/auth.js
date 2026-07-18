const express = require('express')
const router = express.Router()
const bcrypt = require('bcryptjs')
const jwt = require('jsonwebtoken')
const { rateLimit, ipKeyGenerator } = require('express-rate-limit')
const User = require('../models/User')
const { requireAuth } = require('../middleware/auth')
const { normalizeEmail, normalizeUsername, validateUsername, validateEmail, validatePassword } = require('../utils/validators')
const { logAction } = require('../services/auditLog')

const TOKEN_TTL = '7d'
const SALT_ROUNDS = 10
// Shared text for every non-field-specific signup failure (duplicate email,
// race-condition duplicate) - must stay byte-identical across all of them so
// none of them stands out as the "email already exists" case in particular.
const GENERIC_SIGNUP_ERROR = 'Could not create your account. Please check your details and try again.'

// Login throttling is layered, not just per-IP - an office/shared-WiFi has
// everyone behind one IP, so a single person mistyping their password (or one
// compromised/malicious account) must not lock out every coworker's IP too.
//   - Per-EMAIL limiter: the real brute-force guard, tight, keyed on the
//     account actually being attacked - only that one account's login attempts
//     count against it, wherever they come from.
//   - Per-IP limiter: a generous safety net so one IP can't hammer many
//     DIFFERENT accounts unthrottled by rotating the email on each request.
// Both must pass for a login attempt to proceed.
function normalizedLoginEmailKey(req) {
  const email = req.body?.email
  // Falls back to the requester's IP (IPv6-safely truncated per express-rate-
  // limit's own helper) when email is missing/malformed, so a request that
  // will fail validation anyway still counts against SOME budget instead of
  // bypassing the limiter entirely.
  return typeof email === 'string' && email.trim()
    ? email.trim().toLowerCase()
    : ipKeyGenerator(req.ip)
}
const loginEmailLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: normalizedLoginEmailKey,
  message: { error: 'Too many login attempts for this account. Please try again in a few minutes.' },
})
const loginIpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts from this network. Please try again in a few minutes.' },
})
const signupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many signup attempts. Please try again later.' },
})
// Forgot-password has no OTP/email step gating it, so the username+email
// match check IS the only brute-force surface - throttled the same as login.
const forgotPasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please try again in a few minutes.' },
})
// Same non-field-specific wording as GENERIC_SIGNUP_ERROR and for the same
// reason - must not reveal whether the username or the email was the one
// that didn't match.
const GENERIC_FORGOT_PASSWORD_ERROR = 'Username and email do not match our records.'

// Includes role so the admin/ frontend can read it client-side too - the
// real enforcement is always the server-side isAdmin middleware's DB lookup,
// this is only for the UI to decide what to render/redirect.
function signToken(user) {
  return jwt.sign({ userId: user._id.toString(), tokenVersion: user.tokenVersion, role: user.role }, process.env.JWT_SECRET, { expiresIn: TOKEN_TTL })
}

// POST /api/auth/signup
router.post('/signup', signupLimiter, async (req, res) => {
  try {
    const { password } = req.body
    if (typeof req.body.email !== 'string' || typeof password !== 'string') {
      return res.status(400).json({ error: 'Email and password are required.' })
    }
    const email = normalizeEmail(req.body.email)
    const username = normalizeUsername(req.body.username)

    const usernameErr = validateUsername(username)
    if (usernameErr) return res.status(400).json({ error: usernameErr })

    const emailErr = validateEmail(email)
    if (emailErr) return res.status(400).json({ error: emailErr })

    const passwordErr = validatePassword(password)
    if (passwordErr) return res.status(400).json({ error: passwordErr })

    // Hash before the uniqueness check so a taken-email response costs roughly
    // the same as a successful signup - a response-time gap would otherwise
    // let an attacker use signup as an email-existence oracle.
    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS)

    // One account per email - checked explicitly (clearer error) in addition
    // to the unique index (which is the actual race-safe guarantee). Reported
    // with the SAME 400 status/shape as every other signup failure above
    // (not a distinct 409) and a message that doesn't confirm the email is
    // taken - a status/message unique to this one condition would itself let
    // an attacker enumerate which emails already have accounts.
    const existing = await User.findOne({ email })
    if (existing) return res.status(400).json({ error: GENERIC_SIGNUP_ERROR })

    let user
    try {
      user = await User.create({ username, email, passwordHash })
    } catch (err) {
      if (err.code === 11000) return res.status(400).json({ error: GENERIC_SIGNUP_ERROR })
      throw err
    }

    await logAction(user._id, 'signup', { email: user.email })
    res.status(201).json({ message: 'Account created. Please log in.' })
  } catch (err) {
    console.error('Signup error:', err)
    res.status(500).json({ error: 'We could not create your account right now. Please try again in a moment.' })
  }
})

// POST /api/auth/login
router.post('/login', loginIpLimiter, loginEmailLimiter, async (req, res) => {
  try {
    // Must reject non-string email/password before they ever reach a Mongo
    // query - otherwise a JSON body like {"email":{"$gt":""}} gets passed
    // straight through as a Mongo operator instead of a literal match.
    if (typeof req.body.email !== 'string' || typeof req.body.password !== 'string') {
      return res.status(400).json({ error: 'Email and password are required.' })
    }
    const email = normalizeEmail(req.body.email)
    const { password } = req.body
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' })

    const user = await User.findOne({ email })
    if (!user) return res.status(401).json({ error: 'Invalid email or password.' })

    const match = await bcrypt.compare(password, user.passwordHash)
    if (!match) return res.status(401).json({ error: 'Invalid email or password.' })

    const token = signToken(user)
    await logAction(user._id, 'login', { email: user.email })
    res.json({ token, user: { id: user._id, username: user.username, email: user.email, role: user.role } })
  } catch (err) {
    console.error('Login error:', err)
    res.status(500).json({ error: 'We could not log you in right now. Please try again in a moment.' })
  }
})

// GET /api/auth/me - lets the frontend verify a stored token on load without
// having to decode the JWT itself.
router.get('/me', requireAuth, async (req, res) => {
  const user = await User.findById(req.userId).select('username email role')
  if (!user) return res.status(401).json({ error: 'Not authenticated.' })
  res.json({ user: { id: user._id, username: user.username, email: user.email, role: user.role } })
})

// PATCH /api/auth/me - update the logged-in user's username/email. Same
// validation and duplicate-email handling as signup.
router.patch('/me', requireAuth, async (req, res) => {
  try {
    const user = await User.findById(req.userId)
    if (!user) return res.status(401).json({ error: 'Not authenticated.' })

    if (req.body.username !== undefined) {
      const username = normalizeUsername(req.body.username)
      const usernameErr = validateUsername(username)
      if (usernameErr) return res.status(400).json({ error: usernameErr })
      user.username = username
    }

    if (req.body.email !== undefined) {
      const email = normalizeEmail(req.body.email)
      const emailErr = validateEmail(email)
      if (emailErr) return res.status(400).json({ error: emailErr })
      if (email !== user.email) {
        const existing = await User.findOne({ email })
        if (existing) return res.status(400).json({ error: 'That email is already in use.' })
        user.email = email
      }
    }

    await user.save()
    res.json({ user: { id: user._id, username: user.username, email: user.email, role: user.role } })
  } catch (err) {
    console.error('Profile update error:', err)
    res.status(500).json({ error: 'We could not update your profile right now. Please try again in a moment.' })
  }
})

// POST /api/auth/change-password - requires the current password, applies
// the same rules as signup to the new one, then bumps tokenVersion so every
// previously-issued token (including ones from other devices) stops working -
// the same soft-revocation the auth middleware already checks for.
router.post('/change-password', requireAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword, confirmNewPassword } = req.body
    if (typeof currentPassword !== 'string' || typeof newPassword !== 'string') {
      return res.status(400).json({ error: 'Current and new password are required.' })
    }
    if (newPassword !== confirmNewPassword) {
      return res.status(400).json({ error: 'New password and confirmation do not match.' })
    }

    const user = await User.findById(req.userId)
    if (!user) return res.status(401).json({ error: 'Not authenticated.' })

    const match = await bcrypt.compare(currentPassword, user.passwordHash)
    if (!match) return res.status(400).json({ error: 'Current password is incorrect.' })

    const passwordErr = validatePassword(newPassword)
    if (passwordErr) return res.status(400).json({ error: passwordErr })

    user.passwordHash = await bcrypt.hash(newPassword, SALT_ROUNDS)
    user.tokenVersion += 1
    await user.save()

    // Re-issue a fresh token carrying the new tokenVersion so the tab that
    // just changed the password doesn't get logged out too - only every
    // OTHER previously-issued token is now invalid.
    const token = signToken(user)
    await logAction(user._id, 'password_change', { method: 'change_password' })
    res.json({ token, user: { id: user._id, username: user.username, email: user.email, role: user.role } })
  } catch (err) {
    console.error('Change password error:', err)
    res.status(500).json({ error: 'We could not change your password right now. Please try again in a moment.' })
  }
})

// POST /api/auth/forgot-password/verify - checks a username+email pair
// against the same account before the frontend shows the "set new password"
// form. No OTP/token issued by design - the reset call below re-verifies the
// same pair itself, so this step is UX gating only, never trusted alone.
router.post('/forgot-password/verify', forgotPasswordLimiter, async (req, res) => {
  try {
    const { username, email } = req.body
    if (typeof username !== 'string' || typeof email !== 'string') {
      return res.status(400).json({ error: 'Username and email are required.' })
    }
    const user = await User.findOne({ username: normalizeUsername(username), email: normalizeEmail(email) })
    if (!user) return res.status(400).json({ error: GENERIC_FORGOT_PASSWORD_ERROR })
    res.json({ verified: true })
  } catch (err) {
    console.error('Forgot-password verify error:', err)
    res.status(500).json({ error: 'We could not verify your details right now. Please try again in a moment.' })
  }
})

// POST /api/auth/forgot-password/reset - re-verifies the same username+email
// pair (never trusts that verify was called first) then sets the new
// password, applying the same rules as signup/change-password and bumping
// tokenVersion to invalidate every previously-issued token, same as change-password.
router.post('/forgot-password/reset', forgotPasswordLimiter, async (req, res) => {
  try {
    const { username, email, newPassword, confirmNewPassword } = req.body
    if (typeof username !== 'string' || typeof email !== 'string' || typeof newPassword !== 'string') {
      return res.status(400).json({ error: 'Username, email, and new password are required.' })
    }
    if (newPassword !== confirmNewPassword) {
      return res.status(400).json({ error: 'New password and confirmation do not match.' })
    }

    const user = await User.findOne({ username: normalizeUsername(username), email: normalizeEmail(email) })
    if (!user) return res.status(400).json({ error: GENERIC_FORGOT_PASSWORD_ERROR })

    const passwordErr = validatePassword(newPassword)
    if (passwordErr) return res.status(400).json({ error: passwordErr })

    user.passwordHash = await bcrypt.hash(newPassword, SALT_ROUNDS)
    user.tokenVersion += 1
    await user.save()

    await logAction(user._id, 'password_change', { method: 'forgot_password' })
    res.json({ message: 'Password updated successfully.' })
  } catch (err) {
    console.error('Forgot-password reset error:', err)
    res.status(500).json({ error: 'We could not reset your password right now. Please try again in a moment.' })
  }
})

module.exports = router
