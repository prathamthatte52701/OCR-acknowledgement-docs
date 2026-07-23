require('dotenv').config()
const express = require('express')
const mongoose = require('mongoose')
const cors = require('cors')
const path = require('path')
const dns = require('dns')

// This machine's default DNS resolver intermittently fails to resolve the
// mongodb+srv SRV record (ECONNREFUSED on _mongodb._tcp lookups) even though
// the record itself is valid - Google/Cloudflare DNS resolve it fine. Setting
// these as fallback resolvers fixes SRV connection strings without affecting
// anything else.
dns.setServers(['8.8.8.8', '1.1.1.1', ...dns.getServers()])

// Without these, ANY uncaught error anywhere (a stray rejection in an OCR
// child-process handler, a Mongoose callback, etc.) kills the whole Node
// process with nothing to restart it - every in-flight request gets a 502
// from the frontend's dev proxy, and the server stays down until someone
// notices and manually restarts it. Log and keep running instead.
process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION (server kept running):', err)
})
process.on('unhandledRejection', (reason) => {
  console.error('UNHANDLED REJECTION (server kept running):', reason)
})

if (!process.env.JWT_SECRET) {
  console.error('ERROR JWT_SECRET is not set - refusing to start (sessions would be forgeable).')
  process.exit(1)
}

const helmet = require('helmet')
const authRouter = require('./routes/auth')
const documentsRouter = require('./routes/documents')
const adminRouter = require('./routes/admin')
const { requireAuth } = require('./middleware/auth')
const { isAdmin } = require('./middleware/isAdmin')

const app = express()
const PORT = process.env.PORT || 5002

// Middleware
// crossOriginResourcePolicy is relaxed because the dev frontend (5174) fetches
// JSON/blob responses from this API (5002) cross-origin - the app's own cors()
// below already governs which origins may do that; helmet's default
// same-origin CORP would otherwise block those already-permitted requests.
app.use(helmet({ crossOriginResourcePolicy: false }))
app.use(cors({
  origin: process.env.NODE_ENV === 'production' ? false : 'http://localhost:5174',
  credentials: true,
}))
app.use(express.json({ limit: '10mb' }))
app.use(express.urlencoded({ extended: true, limit: '10mb' }))

// API routes - signup/login are the only unauthenticated document routes;
// everything else requires a valid session.
app.use('/api/auth', authRouter)
app.use('/api/documents', requireAuth, documentsRouter)
app.use('/api/admin', requireAuth, isAdmin, adminRouter)

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    mongodb: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
  })
})

// Serve frontend in production
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, '../frontend/dist')))
  app.get('/{*any}', (req, res) => {
    res.sendFile(path.join(__dirname, '../frontend/dist/index.html'))
  })
}

// Global error handler
app.use((err, req, res, next) => {
  console.error(err)
  res.status(500).json({ error: 'Internal server error.' })
})

// Connect MongoDB then start server. Atlas connections occasionally ECONNRESET
// on the very first handshake (a transient network blip, not a real outage) -
// retrying a few times with backoff before giving up turns "the server is
// randomly dead until someone notices and restarts it" into "it connects a few
// seconds late," which is what was actually causing intermittent login/upload
// failures (the process was exiting on the first hiccup instead of retrying).
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/docintel'
const MONGO_CONNECT_RETRIES = 5
const MONGO_CONNECT_RETRY_DELAY_MS = 3000

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function connectWithRetry(attempt = 1) {
  try {
    await mongoose.connect(MONGO_URI, {
      serverSelectionTimeoutMS: 10000,
      family: 4,
    })
    console.log('OK MongoDB connected successfully')
    const recoveredCount = await documentsRouter.recoverInterruptedUploads()
    if (recoveredCount > 0) {
      console.warn(`Requeued ${recoveredCount} interrupted document(s) for processing.`)
    }
    app.listen(PORT, () => {
      console.log(`AckIntel AI - Acknowledgement Intelligence Server running on port ${PORT}`)
    })
  } catch (err) {
    console.error(`ERROR MongoDB connection FAILED (attempt ${attempt}/${MONGO_CONNECT_RETRIES})`)
    console.error(`   Reason : ${err.message}`)
    console.error(`   Code   : ${err.code || 'N/A'}`)
    console.error(`   URI    : ${MONGO_URI.replace(/:([^@]+)@/, ':***@')}`)

    if (attempt >= MONGO_CONNECT_RETRIES) {
      console.error(`Giving up after ${MONGO_CONNECT_RETRIES} attempts.`)
      process.exit(1)
    }

    console.warn(`Retrying in ${MONGO_CONNECT_RETRY_DELAY_MS / 1000}s...`)
    await delay(MONGO_CONNECT_RETRY_DELAY_MS)
    return connectWithRetry(attempt + 1)
  }
}

connectWithRetry()

// Log live connection events after initial connect
mongoose.connection.on('disconnected', (err) => {
  console.warn('WARN  MongoDB disconnected')
})
mongoose.connection.on('error', (err) => {
  console.error(`ERROR MongoDB error: ${err.message}`)
})
