// One-off admin account seed. Run with: node backend/scripts/seedAdmin.js
// Idempotent - does nothing if an account with this email already exists.
//
// "Arjav Jain" is stored in the existing `username` field. The signup form's
// 3-8 char rule is enforced by validateUsername() in the signup route itself,
// not by the schema (see models/User.js) - so this direct DB insert is a
// normal, fully-validated save.
require('dotenv').config()
const dns = require('dns')
dns.setServers(['8.8.8.8', '1.1.1.1', ...dns.getServers()])
const mongoose = require('mongoose')
const bcrypt = require('bcryptjs')
const User = require('../models/User')

const SALT_ROUNDS = 10
const ADMIN_NAME = 'Arjav Jain'
const ADMIN_EMAIL = 'arjav99jain@gmail.com'
const ADMIN_PASSWORD = 'ArjavJain@99'

async function main() {
  await mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/docintel')

  const existing = await User.findOne({ email: ADMIN_EMAIL })
  if (existing) {
    console.log(`Admin account already exists (${ADMIN_EMAIL}), role: ${existing.role}. Nothing to do.`)
    await mongoose.disconnect()
    return
  }

  const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, SALT_ROUNDS)
  const admin = new User({
    username: ADMIN_NAME,
    email: ADMIN_EMAIL,
    passwordHash,
    role: 'admin',
  })
  await admin.save()

  console.log(`Admin account created: ${ADMIN_EMAIL} (role: admin).`)
  await mongoose.disconnect()
}

main().catch((err) => {
  console.error('seedAdmin failed:', err)
  process.exit(1)
})
