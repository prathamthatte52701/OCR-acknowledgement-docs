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

const documentsRouter = require('./routes/documents')
const chatRouter = require('./routes/chat')

const app = express()
const PORT = process.env.PORT || 5002

// Middleware
app.use(cors({
  origin: process.env.NODE_ENV === 'production' ? false : 'http://localhost:5174',
  credentials: true,
}))
app.use(express.json({ limit: '10mb' }))
app.use(express.urlencoded({ extended: true, limit: '10mb' }))

// API routes
app.use('/api/documents', documentsRouter)
app.use('/api/documents/:id/chat', chatRouter)

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

// Connect MongoDB then start server
mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/docintel', {
  serverSelectionTimeoutMS: 10000,
  family: 4,
})
  .then(async () => {
    console.log('OK MongoDB connected successfully')
    const recoveredCount = await documentsRouter.recoverInterruptedUploads()
    if (recoveredCount > 0) {
      console.warn(`Requeued ${recoveredCount} interrupted document(s) for processing.`)
    }
    app.listen(PORT, () => {
      console.log(`AckIntel AI - Acknowledgement Intelligence Server running on port ${PORT}`)
    })
  })
  .catch((err) => {
    console.error('ERROR MongoDB connection FAILED')
    console.error(`   Reason : ${err.message}`)
    console.error(`   Code   : ${err.code || 'N/A'}`)
    console.error(`   URI    : ${(process.env.MONGO_URI || 'mongodb://localhost:27017/docintel').replace(/:([^@]+)@/, ':***@')}`)
    process.exit(1)
  })

// Log live connection events after initial connect
mongoose.connection.on('disconnected', (err) => {
  console.warn('WARN  MongoDB disconnected')
})
mongoose.connection.on('error', (err) => {
  console.error(`ERROR MongoDB error: ${err.message}`)
})
