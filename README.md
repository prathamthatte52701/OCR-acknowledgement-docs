# AckIntel AI

**AI-powered number + date extraction for acknowledgement documents.** Upload a scanned Tax Invoice or Delivery Challan acknowledgement (image or PDF); the system crops the page to just the header region, runs OCR, extracts the document number(s) and date with an AI model, lets you verify/correct them, and exports each verified row into a running Excel workbook.

This is a focused, two-field extraction pipeline — it deliberately ignores everything else on the page (line items, GST totals, stamps, signatures, addresses).

---

## Table of Contents

- [What It Does](#what-it-does)
- [Supported Documents & Extracted Fields](#supported-documents--extracted-fields)
- [User Flow](#user-flow)
- [Architecture Overview](#architecture-overview)
- [The Extraction Pipeline, Step by Step](#the-extraction-pipeline-step-by-step)
- [Excel Export Flow](#excel-export-flow)
- [Data Model](#data-model)
- [API Reference](#api-reference)
- [Tech Stack](#tech-stack)
- [Project Structure](#project-structure)
- [Setup & Run](#setup--run)
- [Environment Variables](#environment-variables)
- [Reliability & Failure Handling](#reliability--failure-handling)
- [Known Limitations](#known-limitations)

---

## What It Does

- Upload an acknowledgement as JPG, JPEG, PNG, or PDF (max 5 MB, PDF max 4 pages) after picking its document type.
- Only the **top ~28% of the page** (the header region) is OCR'd — the number/date box always lives there, and skipping the item table, stamps, and signatures makes OCR dramatically more reliable.
- An AI model (Groq / Llama 3.3 70B) extracts just the number field(s) and the date from the header text — strict JSON output, `null` when unsure, never guessed.
- Extracted values are shown for review; both can be edited inline (date validated as DD/MM/YYYY).
- One click exports the verified row (Document Type | Number | Date | Timestamp) into a **running Excel workbook** — the same file keeps accumulating rows across exports, and every export is also logged to MongoDB.
- "Start New Excel File" begins a fresh workbook for a new batch at any time.
- A simple chat assistant answers questions about the extracted number/date.

## Supported Documents & Extracted Fields

| Document Type | Extracted fields |
|---|---|
| **Tax Invoice** | `taxInvoiceNo` (the "TAX INVOICE" box number, e.g. `G0027704827`), `referenceNo` (the "Reference No." field, e.g. `9800592335`), `date` (same row as Reference No., DD/MM/YYYY) |
| **Delivery Challan** | `number` (the "Delivery Challan" number, e.g. `820268362`), `date` (same row, DD/MM/YYYY) |

The document type is **chosen by the user at upload** — it selects which extraction prompt runs and which fields apply. It is never guessed by the AI.

## User Flow

```
1. Upload page  → pick document type (Tax Invoice / Delivery Challan)
                → drop one file (JPG/PNG/PDF)
                → automatic OCR + AI extraction (few seconds)

2. Detail page  → review extracted Number(s) + Date
                → Edit any field inline (logged as a correction)
                → Reprocess re-runs OCR+AI from the stored original
                → Delete removes the document (soft delete)

3. Export       → click Export on a processed document
                → first ever export: prompted for a workbook filename
                → row appended to the active .xlsx AND logged in MongoDB
                → the workbook downloads to your browser

4. New batch    → "Start New Excel File" on the Documents page
                → enter a new filename; subsequent exports go there
```

## Architecture Overview

```
┌─────────────┐      ┌──────────────────────┐      ┌─────────────────┐
│   Frontend   │◄────►│   Express Backend    │◄────►│   MongoDB Atlas  │
│  React+Vite  │ HTTP │   (routes/services)  │      │  (+ GridFS files)│
└─────────────┘      └──────────┬───────────┘      └─────────────────┘
                                 │
                 ┌───────────────┼────────────────┐
                 ▼               ▼                ▼
      ┌─────────────────┐ ┌──────────────────┐ ┌─────────────────┐
      │ ocr-worker.js    │ │ pdf-render-       │ │ Groq API         │
      │ (Tesseract child │ │ worker.js (PDF→   │ │ (Llama 3.3 70B,  │
      │  process)        │ │ PNG child process)│ │  key pool)       │
      └─────────────────┘ └──────────────────┘ └─────────────────┘
```

- OCR and PDF rendering run in **isolated child processes** — a crash or hang can never take down the main server.
- A single-slot **processing queue** ensures only one OCR job runs at a time (prevents OOM on large scans).
- Excel workbooks are written server-side to `backend/exports/`; the active filename is persisted in MongoDB so it survives restarts.

## The Extraction Pipeline, Step by Step

1. **Upload** — file stored in GridFS, a `Document` row created with `uploadStatus: 'uploaded'`, job queued.
2. **Header crop** (`services/ocr.js → extractHeaderText`)
   - **Image**: sharp crops the top 28% of the page, then the standard OCR worker runs on the crop (4x Lanczos upscale, grayscale + binarized variants, multi-PSM Tesseract, best result scored).
   - **Digital PDF** (has a text layer): pdfjs reads each text item's x/y position, keeps only rows in the top 28% of the page, and reassembles them in true visual order.
   - **Scanned PDF** (no text layer): page 1 is rasterized to PNG in a child process, then cropped + OCR'd like an image.
3. **AI extraction** (`services/groq.js → extractHeader`) — a documentType-specific prompt (Tax Invoice vs Delivery Challan) extracts the field(s) + date as strict JSON. Printed-text-only rule: stamps/handwriting are explicitly ignored; unknown values come back `null`, never guessed.
4. **Date normalization** — `DD.MM.YYYY` / `DD-MM-YYYY` / `DD/MM/YYYY` accepted, anything else → `null`. Stored as `DD/MM/YYYY`.
5. **Save** — `uploadStatus: 'processed'` with the extracted fields (or `'failed'` with a user-readable `processingError`).

## Excel Export Flow

- A singleton `Settings` document (`key: 'activeExcelFile'`) holds the current workbook filename — persisted in Mongo, survives restarts.
- `POST /api/documents/:id/export`:
  1. 400 `NO_ACTIVE_FILE` if no workbook has been started (the frontend auto-prompts for a filename and retries).
  2. Appends `Document Type | Number | Date | Timestamp` to the workbook (`backend/exports/<name>.xlsx`). For Tax Invoice, Number is `taxInvoiceNo / referenceNo`.
  3. Logs the same row as an `ExportedRow` document in Mongo (audit trail, independent of the file on disk).
  4. Streams the workbook back as a download.
- `POST /api/documents/new-excel-file` — creates a fresh workbook with a header row and repoints the Settings singleton.

## Data Model

**Document**
```
autoName, originalFilename, mimeType, size, gridFsFileId
uploadStatus:  'uploaded' | 'processed' | 'failed'
documentType:  'Tax Invoice' | 'Delivery Challan'   (user-selected)
taxInvoiceNo:  String|null   (Tax Invoice only)
referenceNo:   String|null   (Tax Invoice only)
number:        String|null   (Delivery Challan only)
date:          String|null   (DD/MM/YYYY)
edited:        Boolean       (true once any field is manually corrected)
ocrTextHidden: String        (raw header OCR text, hidden from API responses)
processingError, processedAt, reprocessedAt, isDeleted, deletedAt, timestamps
```

**Settings** — `{ key: 'activeExcelFile', filename }` (singleton)

**ExportedRow** — `{ documentId, documentType, taxInvoiceNo, referenceNo, number, date, exportedAt }`

**Correction** — `{ documentId, fieldLabel, fieldKey, oldValue, newValue, correctedAt }` (audit log of manual edits)

**ChatMessage / ChatFeedback** — per-document chat history (50-message cap) and 1-10 response ratings.

## API Reference

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/documents/upload` | Upload one file + `documentType` (multipart) |
| GET | `/api/documents` | List documents (newest first) |
| GET | `/api/documents/:id` | Get one document |
| GET | `/api/documents/:id/download` | Download the original file |
| PATCH | `/api/documents/:id/correct` | Edit a field — body `{ field, value }`, field ∈ `taxInvoiceNo` `referenceNo` `number` `date` |
| POST | `/api/documents/:id/reprocess` | Re-run OCR + extraction from the stored file |
| DELETE | `/api/documents/:id` | Soft-delete (also removes the GridFS file) |
| POST | `/api/documents/:id/export` | Append row to active workbook + Mongo log, download file |
| POST | `/api/documents/new-excel-file` | Start a fresh workbook — body `{ filename }` |
| GET/POST | `/api/documents/:id/chat` | Chat history / ask a question |
| POST | `/api/documents/:id/chat/:messageId/feedback` | Rate a chat answer 1-10 |
| GET | `/api/health` | Server + MongoDB status |

## Tech Stack

- **Backend**: Node.js, Express 5, Mongoose 9, MongoDB Atlas + GridFS, multer, Tesseract.js 7, sharp, pdf-parse + pdfjs-dist + @napi-rs/canvas, groq-sdk, exceljs
- **Frontend**: React 19, Vite, react-router-dom 7, Tailwind CSS 4, axios
- **AI**: Groq (Llama 3.3 70B), multi-key round-robin pool with automatic failover

## Project Structure

```
backend/
  server.js                 Express app, Mongo connect, crash recovery
  routes/documents.js       Upload/list/correct/reprocess/export/new-excel-file
  routes/chat.js            Per-document chat + feedback
  services/ocr.js           Header-crop OCR orchestrator (image/PDF routing)
  services/ocr-worker.js    Tesseract child process (multi-PSM, upscaling)
  services/pdf-render-worker.js  PDF page → PNG child process
  services/groq.js          AI extraction + date normalization + chat
  services/excel.js         Workbook create/append (exceljs)
  services/gridfs.js        GridFS upload/download/delete
  models/                   Document, Settings, ExportedRow, Correction,
                            ChatMessage, ChatFeedback
  exports/                  Generated .xlsx workbooks (gitignored)
frontend/
  src/pages/                Dashboard, Upload, Documents, DocumentDetail, Chat
  src/components/           UploadCard, DocumentCard, CorrectionModal, chat UI
  src/utils/api.js          Axios instance + exportDocument helper
```

## Setup & Run

```bash
# backend
cd backend
npm install
cp .env.example .env        # fill in MONGO_URI and GROQ_API_KEYS
npm run dev                 # http://localhost:5002

# frontend (separate terminal)
cd frontend
npm install
npm run dev                 # http://localhost:5174 (proxies /api to :5002)
```

Production: `cd frontend && npm run build`, then run the backend with `NODE_ENV=production` — it serves `frontend/dist` itself.

## Environment Variables

| Variable | Purpose |
|---|---|
| `MONGO_URI` | MongoDB Atlas connection string |
| `GROQ_API_KEYS` | Comma-separated Groq API keys (round-robin + failover). `GROQ_API_KEY` (single) also works |
| `PORT` | Backend port (default 5002) |
| `NODE_ENV` | `development` / `production` |

## Reliability & Failure Handling

- **Child-process isolation**: Tesseract and PDF rasterization each run in their own process with timeouts — malformed files can't crash the server.
- **Single-job queue**: uploads/reprocesses are processed one at a time to bound memory.
- **Crash recovery**: on startup, any document stuck in `uploaded` is automatically re-queued.
- **Groq key pool**: rate-limited/unauthorized keys fail over to the next key in the pool automatically.
- **Never-guess rule**: unparseable dates or unfound numbers are stored as `null` for manual entry, never fabricated.
- **DNS fallback**: Google/Cloudflare DNS resolvers are added as fallback for `mongodb+srv` SRV lookups (some local resolvers fail these).

## Known Limitations

- Scanned PDFs: only page 1 is rasterized/OCR'd (headers are always on page 1 for these documents).
- Excel workbooks live on the server's local disk (`backend/exports/`) — fine for single-instance deployments; multi-instance would need shared storage.
- No authentication — designed for single-user/local use.
- English-language documents only.
