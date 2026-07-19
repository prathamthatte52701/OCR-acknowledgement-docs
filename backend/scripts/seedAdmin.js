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
const ADMINS = [
  { name: 'Arjav Jain', email: 'arjav99jain@gmail.com', password: 'ArjavJain@99' },
  { name: 'Pratham Thatte', email: 'prathamthatte527@gmail.com', password: 'Pratham@/@/1' },
]

async function main() {
  await mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/docintel')

  for (const { name, email, password } of ADMINS) {
    const existing = await User.findOne({ email })
    if (existing) {
      console.log(`Admin account already exists (${email}), role: ${existing.role}. Nothing to do.`)
      continue
    }

    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS)
    const admin = new User({
      username: name,
      email,
      passwordHash,
      role: 'admin',
    })
    await admin.save()

    console.log(`Admin account created: ${email} (role: admin).`)
  }

  await mongoose.disconnect()
}

main().catch((err) => {
  console.error('seedAdmin failed:', err)
  process.exit(1)
})
