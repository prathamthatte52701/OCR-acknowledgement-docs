const express = require('express')
const router = express.Router()
const bcrypt = require('bcryptjs')
const jwt = require('jsonwebtoken')
const User = require('../models/User')
const { requireAuth } = require('../middleware/auth')
const { normalizeEmail, validateUsername, validateEmail, validatePassword } = require('../utils/validators')

const TOKEN_TTL = '7d'
const SALT_ROUNDS = 10

function signToken(userId) {
  return jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: TOKEN_TTL })
}

// POST /api/auth/signup
router.post('/signup', async (req, res) => {
  try {
    const { username, password } = req.body
    const email = normalizeEmail(req.body.email)

    const usernameErr = validateUsername(username)
    if (usernameErr) return res.status(400).json({ error: usernameErr })

    const emailErr = validateEmail(email)
    if (emailErr) return res.status(400).json({ error: emailErr })

    const passwordErr = validatePassword(password)
    if (passwordErr) return res.status(400).json({ error: passwordErr })

    // One account per email - checked explicitly (clearer error) in addition
    // to the unique index (which is the actual race-safe guarantee).
    const existing = await User.findOne({ email })
    if (existing) return res.status(409).json({ error: 'An account with this email already exists.' })

    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS)
    let user
    try {
      user = await User.create({ username, email, passwordHash })
    } catch (err) {
      if (err.code === 11000) return res.status(409).json({ error: 'An account with this email already exists.' })
      throw err
    }

    const token = signToken(user._id.toString())
    res.status(201).json({ token, user: { id: user._id, username: user.username, email: user.email } })
  } catch (err) {
    console.error('Signup error:', err)
    res.status(500).json({ error: 'Something went wrong while creating your account.' })
  }
})

// POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email)
    const { password } = req.body
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' })

    const user = await User.findOne({ email })
    if (!user) return res.status(401).json({ error: 'Invalid email or password.' })

    const match = await bcrypt.compare(password, user.passwordHash)
    if (!match) return res.status(401).json({ error: 'Invalid email or password.' })

    const token = signToken(user._id.toString())
    res.json({ token, user: { id: user._id, username: user.username, email: user.email } })
  } catch (err) {
    console.error('Login error:', err)
    res.status(500).json({ error: 'Something went wrong while logging in.' })
  }
})

// GET /api/auth/me - lets the frontend verify a stored token on load without
// having to decode the JWT itself.
router.get('/me', requireAuth, async (req, res) => {
  const user = await User.findById(req.userId).select('username email')
  if (!user) return res.status(401).json({ error: 'Not authenticated.' })
  res.json({ user: { id: user._id, username: user.username, email: user.email } })
})

module.exports = router
