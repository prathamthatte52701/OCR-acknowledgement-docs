# ChallanIntel AI

**AI-powered extraction, verification, and Q&A for Consignor–Consignee delivery challans** (Rule 55 of CGST Rule documents). Upload a photo or PDF of a delivery challan; the system splits the page, runs OCR, extracts every field with an AI model, lets you correct anything, and lets you ask questions about the document in plain English.

This is a single, fixed-template extraction pipeline: it is tuned specifically for the "Delivery Challan under Rule 55 of CGST Rule" layout (Consignee/Consignor header table + "UNCODED RGP" line-items table), not a general-purpose document parser.

---

## Table of Contents

- [What It Does](#what-it-does)
- [Architecture Overview](#architecture-overview)
- [The Extraction Pipeline, Step by Step](#the-extraction-pipeline-step-by-step)
- [Data Model](#data-model)
- [Editing & Data Integrity](#editing--data-integrity)
- [Chat Interface](#chat-interface)
- [API Reference](#api-reference)
- [Tech Stack](#tech-stack)
- [Project Structure](#project-structure)
- [Setup & Run](#setup--run)
- [Environment Variables](#environment-variables)
- [Reliability & Failure Handling](#reliability--failure-handling)
- [Known Limitations](#known-limitations)
- [Roadmap Ideas](#roadmap-ideas-not-built)

---

## What It Does

- Upload a delivery challan as JPG, JPEG, PNG, or PDF (max 5 MB, PDF max 4 pages).
- The page is automatically split into **Part 1** (Consignee/Consignor header block) and **Part 2** ("UNCODED RGP" line-items + tax table) — you upload one file, the system handles the rest.
- Each part is OCR'd independently (4x upscaled, multi-strategy Tesseract) and extracted independently by an AI model with a part-specific prompt, then the results are merged into one document.
- Deterministic rules correct the two fields most prone to OCR error (Consignee address, Consignor address) using the fixed template's known valid values, rather than trusting free-form AI reconstruction for them.
- Every extracted field is editable. An edit overwrites the value everywhere — in the document, in every table, in the summary text, in the chat context — there is no separate "AI value" vs "corrected value."
- Two focused chat views (Part 1 / Part 2) let you pull up grouped data (Consignee Details, Consigner Details, Taxes, Uncoded RGP, About, Full Summary) or ask free-form questions about the document.

---

## Architecture Overview

```
┌─────────────┐      ┌──────────────────────┐      ┌─────────────────┐
│   Frontend   │◄────►│   Express Backend    │◄────►│   MongoDB Atlas  │
│  React+Vite  │ HTTP │   (routes/services)  │      │  (+ GridFS files)│
└─────────────┘      └──────────┬───────────┘      └─────────────────┘
                                 │
                 ┌───────────────┼────────────────┐
                 ▼                                ▼
      ┌─────────────────────┐          ┌───────────────────────┐
      │ ocr-worker.js        │          │ pdf-render-worker.js   │
      │ (isolated child proc)│          │ (isolated child proc)  │
      │ Tesseract.js OCR     │          │ pdfjs-dist + canvas    │
      └─────────────────────┘          └───────────────────────┘
                 │
                 ▼
      ┌─────────────────────┐
      │      Groq API        │  <- round-robin across N keys, automatic failover
      │  Llama 3.3 70B        │
      └─────────────────────┘
```

**Why child processes for OCR and PDF rendering:** Tesseract and PDF rasterization are the two heaviest, least-predictable operations in the pipeline (a malformed image or hostile PDF can hang or crash a native rendering library). Both run in dedicated, timeout-bounded child processes (`services/ocr-worker.js`, `services/pdf-render-worker.js`) spawned from `services/ocr.js`. The main Express process never performs OCR or PDF rendering directly and can never be taken down by a bad upload.

---

## The Extraction Pipeline, Step by Step

1. **Upload** — `POST /api/documents/upload`. File is validated (magic-byte MIME sniffing, size, PDF page count), stored in MongoDB GridFS, and queued for background processing (one job at a time, to avoid OOM on constrained hosts).
2. **OCR input resolution**:
   - **Digital PDF** (has a real text layer) → text extracted directly via `pdf-parse`, no OCR needed.
   - **Scanned PDF** (no text layer) → page 1 is rasterized to a PNG in an isolated child process, then fed into the same image pipeline below. If the PDF has more than one page, only page 1 is processed and a warning is surfaced (this app's document model is one bill per upload).
   - **JPG/PNG** → goes straight into the image pipeline.
3. **Image preprocessing** (`ocr-worker.js`) — the image is upscaled **4x** with Lanczos3 interpolation, then converted to grayscale. Empirically, upscale factor beyond ~2x makes no measurable difference to Tesseract confidence on real phone-photo samples (confidence plateaus around the same value at 2x/3x/4x) — 4x is kept because it does no harm and gives headroom for future preprocessing tuning, not because it independently improves accuracy over 2x. Aggressive contrast normalization/sharpening/thresholding was tested and found to **reduce** confidence on this print quality, so the primary OCR pass uses a plain grayscale image; a binarized variant is only tried as a fallback candidate.
4. **Auto page split** — the page is split into Part 1 (Consignee/Consignor header) and Part 2 (line-items table) by locating the printed "UNCODED RGP" divider row using Tesseract's word-level bounding boxes (not a fixed pixel ratio, so it tolerates page-to-page size variation), with a fixed-ratio fallback if the anchor word isn't found.
5. **Independent OCR per part** — each crop is OCR'd with multiple Tesseract strategies (grayscale vs. binarized, PSM 6 vs. PSM 4) and the highest-scoring result wins. Part 2's result is validated against a real table-content check (presence of a 6-digit HSN/SAC code, not just a stray keyword) before being accepted; if it looks like only the tax footer was captured, the split is retried at a fallback ratio.
6. **Independent AI extraction per part** — Part 1 text and Part 2 text are sent to Groq (Llama 3.3 70B) in **two parallel calls**, each with its own strict, part-specific system prompt (see [AI Extraction Prompts](#chat-interface) below). Each call automatically uses a different key from the round-robin pool (see [Reliability & Failure Handling](#reliability--failure-handling)).
7. **Deterministic address correction** — see [Editing & Data Integrity](#editing--data-integrity).
8. **Garbage-row filtering** — any line item the AI produced without a genuinely readable description (e.g., a stray footer number misattributed to a fake row) is dropped before it ever reaches the document, with a warning logged.
9. **View assembly** — one function (`assembleDocumentViews`) turns the canonical extracted data into every display surface: flat editable fields, tables (Parties / Line Items / Totals), the full-text summary, and the Part 1 / Part 2 breakdowns. This same function is reused after every correction, so there is exactly one code path that produces what the UI shows — see below.

---

## Data Model

Each `Document` stores:

| Field | Description |
|---|---|
| `consignee`, `consignor` | Structured party objects (code, name, address, state, GSTIN, PAN) |
| `invoiceNo`, `fiDoc`, `challanDate`, `reason`, `poNo`, `requestNo`, `irnNo` | Header metadata scalars |
| `lineItems[]` | One entry per printed row (SR No, description, HSN/SAC, basic, quantity, amount) |
| `totals` | Total Basic Amount, CGST, SGST, IGST, Total Amount |
| `extractedFields[]` | Every value above, flattened into `{label, normalizedKey, value, edited, category}` entries — this is what the Edit UI operates on |
| `extractedTables[]` | Parties / Line Items / Totals, pre-built for table display |
| `fullSummary`, `summaryPoints[]` | Human-readable summary text/bullets |
| `part1`, `part2` | Per-part fields/tables/summary, for the Part 1 / Part 2 chat pages |
| `editedFieldKeys[]` | Which `normalizedKey`s have ever been manually corrected (drives the "(edited)" badge) |
| `warnings[]` | Every extraction uncertainty, partial read, or deterministic-rule override, surfaced to the user |

All of the above (except the raw hidden OCR text) are derived from a single canonical source and regenerated together — see below.

---

## Editing & Data Integrity

**Deterministic address rules.** The Consignee address and Consignor address are the two fields most prone to OCR/AI reconstruction error, because their value spans unlabeled continuation lines below an "Address" label — a genuinely hard problem for a flattened-text AI extraction to get right consistently. Since this is a fixed template, both fields only ever take one of two possible values:

- **Consignee address** is fixed to the detected State: Gujarat → `AHMEDABAD 382220`, Maharashtra → `PUNE 411026`. Any other/unrecognized state leaves the OCR-read value untouched and logs a warning.
- **Consignor address** is fixed by detecting the `87A` or `78-86` prefix (checked against both the AI's extracted value and the raw OCR text, tolerant of common misreads like `78-96`): `87A Industrial Area No 3, A. B Road Dewas, 455001` or `78-86 Industrial Area No 3, A. B Road Dewas, 455001`.

These are applied as plain deterministic code (`applyConsigneeAddressRule` / `applyConsignorAddressRule` in `services/groq.js`), not AI guessing, and every override is logged to `warnings[]` so it's never a silent surprise.

**No hallucination, but no silent data loss either.** The extraction prompts draw a hard line: `null` means *the OCR text contains nothing for this field* — no digits, no fragment. If OCR found *some* real characters for a field but not the complete value, the AI must return that partial fragment (flagged in warnings) rather than nulling it out "to be safe." Separately, it must never pad a partial value out to look complete by inventing the missing characters, and it must never fabricate a character correction where no real misread character exists to point to (a blank, illegible position stays missing — it is not "corrected" using the expected format or a reference value).

**Single source of truth for corrections.** Editing a field does not create a parallel "corrected value" that display code has to remember to check. `PATCH /api/documents/:id/fields/:fieldKey/correct` writes the new value directly into the canonical structured data (`consignee`, `consignor`, `totals`, `lineItems`, or a header scalar) and then calls the same `assembleDocumentViews` function used after AI extraction to regenerate *every* derived view — fields, tables, full summary, Part 1/Part 2 breakdowns — from that one corrected source. The old value does not linger anywhere: not in a table row, not in the summary text, not in a stale Part 1/Part 2 snapshot.

---

## Chat Interface

Two focused chat pages instead of one page mixing both parts' data:

- **`/documents/:id/chat/part1`** — Consignee Details, Consigner Details, About, Full Summary
- **`/documents/:id/chat/part2`** — Taxes, Uncoded RGP, About, Full Summary

Clicking a button appends a result to the chat history (it does not replace the previous one — you can scroll up through everything you've looked at). Every button's content is rendered live from the current document state, so an edit made anywhere is reflected in every previously-opened view too. You can also type a free-form question; it's answered by Groq using only the document's extracted fields, tables, and summary (never general knowledge), with a document-scoped chat history (50 messages, oldest trimmed first).

---

## API Reference

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/documents/upload` | Upload and queue a document for processing |
| `GET` | `/api/documents` | List all documents |
| `GET` | `/api/documents/:id` | Get one document |
| `GET` | `/api/documents/:id/download` | Download the original uploaded file |
| `POST` | `/api/documents/:id/reprocess` | Re-run OCR + AI extraction |
| `DELETE` | `/api/documents/:id` | Soft-delete a document |
| `PATCH` | `/api/documents/:id/fields/:fieldKey/correct` | Correct a field (overwrites everywhere, see above) |
| `GET` | `/api/documents/:id/chat` | Get chat history |
| `POST` | `/api/documents/:id/chat` | Send a chat message |
| `POST` | `/api/documents/:id/chat/:messageId/feedback` | Rate a chat response (1-10) |
| `GET` | `/api/documents/training-stats` | Count of processed/corrected documents |
| `GET` | `/api/documents/feedback-stats` | Chat rating analytics |

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React + Vite, Tailwind CSS v4, React Router |
| Backend | Node.js, Express 5 |
| Database | MongoDB + Mongoose |
| File storage | MongoDB GridFS |
| OCR | Tesseract.js (isolated child process) |
| PDF rendering | pdfjs-dist + @napi-rs/canvas (isolated child process), pdf-parse for digital-text PDFs |
| AI extraction & chat | Groq (Llama 3.3 70B) via `groq-sdk`, round-robin across a configurable pool of API keys |

---

## Project Structure

```
OCR project AJ/
├── frontend/                    # React + Vite app
│   └── src/
│       ├── components/          # Chat, tables, correction modal, detail views
│       ├── pages/                # Dashboard, Upload, Documents, Detail, Chat
│       └── utils/                 # API client
├── backend/
│   ├── models/                  # Document, Correction, ChatMessage, ChatFeedback
│   ├── routes/                  # documents.js, chat.js
│   └── services/
│       ├── ocr.js                # Orchestrates OCR/PDF pipeline, spawns child processes
│       ├── ocr-worker.js         # Child process: 4x upscale, split, Tesseract
│       ├── pdf-render-worker.js  # Child process: scanned-PDF page-1 rasterization
│       ├── groq.js               # AI prompts, extraction, view assembly, corrections
│       └── gridfs.js             # File storage
└── README.md
```

---

## Setup & Run

### 1. Install dependencies

```bash
cd backend && npm install
cd ../frontend && npm install
```

### 2. Configure environment

Copy `backend/.env.example` to `backend/.env` and fill in your values (see below).

### 3. Run backend

```bash
cd backend
npm run dev
# http://localhost:5002
```

### 4. Run frontend

```bash
cd frontend
npm run dev
# http://localhost:5174
```

---

## Environment Variables

Create `backend/.env`:

```env
MONGO_URI=mongodb+srv://<user>:<password>@cluster.mongodb.net/docintel_transport?appName=Cluster0
GROQ_API_KEYS=gsk_key1,gsk_key2,gsk_key3
PORT=5002
NODE_ENV=development
```

- `GROQ_API_KEYS` accepts a **comma-separated list** of keys (any number). Each AI call round-robins to the next key in the pool and automatically fails over to the next one if a call errors with a rate-limit, auth, or server error — a single exhausted or invalid key never stalls processing. `GROQ_API_KEY` (singular) is still supported as a one-key fallback.

---

## Reliability & Failure Handling

- **Round-robin + failover**: every Groq call picks its own fixed starting key index (advanced synchronously before any await), then walks the *entire* key pool exactly once from there if needed. Because Part 1 and Part 2 extraction run in parallel and each independently reserves a starting index up front, they reliably use different keys under normal conditions, and neither call can get stuck retrying a key the other call already proved is bad.
- **Isolated OCR/PDF processing**: see [Architecture Overview](#architecture-overview). A malformed image or corrupt PDF can only ever fail its own child process — the main server and every other in-flight request are unaffected.
- **Serialized processing queue**: only one OCR/AI job runs at a time server-side, to avoid memory pressure from concurrent Tesseract workers on constrained hosts.
- **Filename integrity**: the document's display name is derived directly from the uploaded file's original name (extension stripped) — never invented, renumbered, or substituted.

---

## Known Limitations

- This is a fixed-template pipeline (VE Commercial Vehicles / Oerlikon Balzers "Delivery Challan under Rule 55 of CGST Rule"). It is not a general-purpose document extractor, and the deterministic address rules are specific to this template's two known Consignee/Consignor address variants.
- Scanned PDFs are rasterized page 1 only — a genuinely multi-page scanned PDF will only have its first page read (surfaced as a warning), since this app's data model assumes one bill per upload.
- OCR accuracy still depends on source photo quality; low-resolution or heavily skewed phone photos reduce confidence regardless of preprocessing.
- No authentication - single-user/local workflow.
- Processing takes roughly 15-70 seconds per document depending on OCR fallback depth and Groq latency.

---

## Roadmap Ideas (Not Built)

- Column-position-aware table reconstruction for the line-items table (using word bounding boxes to assign values to columns geometrically, rather than trusting AI reconstruction from flattened text) — would directly target the remaining Part 2 accuracy gap.
- Admin dashboard, multi-user auth, role-based access.
- Export to Excel/PDF.
- Batch upload and multi-document comparison.
- Native mobile app.
