# AckIntel AI

**AI-powered OCR and document intelligence for acknowledgement documents — upload, extract, verify, and export to Excel in seconds.**

---

## Table of Contents

- [Project Overview](#project-overview)
- [Features](#features)
- [Tech Stack](#tech-stack)
- [Architecture](#architecture)
- [Workflow](#workflow)
- [API Reference](#api-reference)
- [Setup / How to Run](#setup--how-to-run)
- [Folder Structure](#folder-structure)
- [Troubleshooting for Office Users](#troubleshooting-for-office-users)

---

## Project Overview

Transport and logistics teams get scanned **Tax Invoice** and **Delivery Challan** acknowledgement documents. These come in as photos or PDF scans. Someone has to read each one, find the document number and the date, and type them into an Excel sheet. This is normal office data-entry work, and it is slow and easy to get wrong. A tired person can misread a number, skip a row, or type the wrong date.

AckIntel AI takes this manual job and automates almost all of it. Here is the short version of what happens:

1. A user uploads one document (an image or a PDF).
2. The system looks only at the top part of the page, where the number and date always sit.
3. It runs OCR (Optical Character Recognition — software that turns a picture of text into real, readable text) on that part of the page.
4. It sends that text to an AI model (Groq, running Llama 3.3 70B) and asks it to pull out just the number(s) and the date.
5. The user checks the result. If anything looks wrong, they can fix it by hand.
6. Once it looks right, the user saves it. This adds one row to an Excel workbook that keeps growing over time.

No one has to re-type anything by hand unless the AI genuinely could not read a value — and even then, the app tells the user exactly what to fix instead of failing silently.

**Who uses it:**
- **Regular users** — people who upload documents day to day. They sign up, upload their own files, check and correct the extracted number/date, and keep their own Excel workbooks and export history. Each user only ever sees their own documents (with one shared exception: the Export History page, explained later).
- **Admins** — a small number of trusted staff who need to see everything, not just their own uploads. Admins get a separate admin panel where they can manage every user account, look at (and fix) any user's documents, download any user's Excel workbooks, read a full audit log of what happened in the system, and see overall numbers like total users, total documents, total exports, and how often OCR is failing.

## Features

This section lists what the app can actually do today, grouped by area.

### OCR & Extraction
- Users can upload a JPG, JPEG, PNG, or PDF file. The file must be 5 MB or smaller, and a PDF can have at most 4 pages. Before uploading, the user must pick a document type: Tax Invoice or Delivery Challan. This choice matters because each document type has different fields to extract.
- File validation errors are specific, not generic — the app tells the user exactly what went wrong (for example, "File size must be 5 MB or less" versus "File content does not match the selected file type") instead of a single catch-all error message.
- Bulk Upload lets a user upload up to 5 files in one go, each with its own document type picked individually. The files are still processed strictly one at a time through the same single-slot queue described below — never in parallel — to keep server load safe. The user sees live, per-file progress (waiting / processing / done / failed) as each one finishes.
- Only the top ~28% of the page (the header area) is sent through OCR. The number and date always live in this area on both document types. Everything else on the page — the item table, GST numbers, stamps, and signatures — is deliberately ignored. Skipping that extra content makes OCR faster and far more accurate, because there is less noisy text for it to get confused by.
- The actual OCR engine is Tesseract.js. It runs inside its own separate child process (a second, isolated program that the main server starts and talks to), not inside the main server itself. This matters a lot: if OCR ever crashes, hangs, or gets stuck on a strange file, only that one child process dies — the main server and every other user's request keep working normally. There is also a timeout on this process, so a stuck OCR job can never hang forever.
- PDFs are handled in two different ways depending on what kind of PDF they are:
  - A **digital PDF** (one that already has real, selectable text inside it, not just a picture) is read directly using `pdf-parse` and `pdfjs-dist`. The text is also rebuilt using each word's on-page position, so rows and columns come out in the correct visual order instead of a jumbled order.
  - A **scanned PDF** (a PDF that is really just a photo or scan with no real text layer) has its first page turned into a PNG image using `@napi-rs/canvas`, also inside its own separate child process for the same crash-safety reason as OCR. Once it is an image, it goes through the exact same image pipeline as a normal JPG/PNG upload.
- The actual extraction of the number and date is done by an AI model (Groq, using the `llama-3.3-70b-versatile` model). The AI is given a strict instruction: return only the fields as clean JSON, and if it is not confident about a value, return `null` instead of guessing. It is also told to ignore anything handwritten, any rubber stamps, and any signatures — only printed form text counts.
- The app can be configured with more than one Groq API key at once. If one key hits a rate limit or stops working, the app automatically tries the next key in the list. This is called a round-robin pool with failover, and it means one bad or overloaded key does not stop the whole app from working.
- Every extracted date is converted into one consistent format: `DD/MM/YYYY`. If a date cannot be understood confidently, it is stored as `null` so a human can fill it in later — the app never invents a date.
- Tax Invoice numbers get one extra safety check on top of what the AI returns: a real Tax Invoice number always starts with the letter "G". This is enforced in code, not just hoped for via the AI prompt — if the AI returns a value that doesn't start with "G", that value is not silently trusted. Instead it is flagged as low-confidence, the same way any other uncertain field is, so the user sees the warning and can manually verify it before saving.
- Only one OCR job runs at a time, through a simple one-slot queue. This protects the server from running out of memory if many big files come in at once. The queue is also fair: it takes turns between different users instead of always processing whoever uploaded first, so one user uploading a big batch of files cannot block everyone else from getting their single document processed.
- If the server restarts while a document is still mid-processing, that document is automatically picked back up and re-queued when the server comes back online. Nothing gets silently lost.

### Document Management
- The Dashboard shows every document a user has uploaded, plus quick counts by document type. The separate Documents page shows the same list but with pagination (loading documents a page at a time instead of all at once), which matters once a user has a lot of documents.
- The Dashboard has a search bar for finding a document quickly: by document number (a partial match — typing part of the number is enough) or by date (picked with a native date picker). Searching redirects to the Documents page with the results filtered and still paginated, the same as browsing normally.
- Each document has its own detail page. It shows the extracted fields, a confidence indicator for each one, and lets the user preview or download the original file they uploaded.
- Any extracted field can be corrected by hand. The date field is checked for the right format before it is accepted. Every correction is written to a `Correction` record, so there is always a history of what was changed and when.
- A document can be reprocessed. This re-runs the whole OCR-plus-AI pipeline again from the original file that is still stored — useful if the first attempt got a field wrong or missed something.
- Deleting a document is a "soft delete": the document is marked as deleted and hidden from view, along with its stored file, rather than being destroyed outright.
- Delete always asks for confirmation first, in a popup ("Delete this document? This cannot be undone."), specifically to prevent accidental deletion from a stray click.

### Excel Export & Workbooks
- Verified rows go into an Excel workbook that is scoped to one user and one year. Inside that workbook, each month gets its own worksheet, and that worksheet is created automatically the first time a row for that month is saved.
- Why year-based workbooks with monthly sheets, instead of one giant file? Splitting by year keeps each file a manageable size and keeps old years' records naturally archived and separate, while splitting by month inside that gives a clean, familiar layout that matches how these logs are normally read and audited later. It also means a row always lands in the sheet that matches the document's own printed date — not whatever day it happened to be saved on — so the workbook stays accurate even if someone saves a backlog of older documents.
- When the calendar year changes, the app automatically notices and prompts the user to start a new workbook for the new year. The old workbook is not deleted — it is archived, and can still be downloaded later.
- A user can also manually start a brand-new workbook at any time using "Start New Excel File" — for example, to begin a fresh batch. Again, the old one is archived rather than lost.
- Users can download either their current active workbook or any older, archived workbook by picking the year.
- There is one shared page, Export History, that is deliberately different from everything else in the app: it shows every export ever made by every user, not just the current user's own exports. This is intentional — it acts as a shared, company-wide audit trail of what has been exported and when, with a link back to the workbook each row came from.
- Because more than one export could try to write to the same Excel file at once, all writes to a given workbook are lined up and done one at a time (serialized), so two saves happening close together can never overwrite or lose each other's row. If the file happens to be open in Microsoft Excel at the same time (which locks the file on disk), the app returns a clear, specific error explaining that, instead of crashing or silently failing.

### Auth & Security
- Users can sign up, log in, and log out. Being logged in is tracked using a JWT (a signed token the browser holds onto), which stays valid for 7 days.
- Passwords are never stored as plain text — they are hashed with bcrypt. Password strength is checked whenever a password is set: on signup, on a normal password change, and on a forgotten-password reset.
- There is a forgot-password flow. It confirms the user's identity using their username and email together, and does not depend on sending an email or a one-time code.
- There is also a normal change-password flow for a logged-in user. Both this and the forgot-password flow bump an internal counter called `tokenVersion` on that user's account. This immediately invalidates every other token that was issued before the change — so if someone else was still logged in with an old session (or an old token was stolen), that access is cut off the moment the password changes.
- Login, signup, and forgot-password are all rate-limited, both per email address and per IP address. This slows down anyone trying to guess passwords or spam signups, but it is deliberately layered so a whole shared office or shared Wi-Fi network cannot get accidentally locked out just because one person on that network typed a wrong password.
- The document chat feature is also rate-limited per user (20 messages every 10 minutes), which puts a cap on how much AI usage cost any single account can run up.
- Every route that touches documents, chat, or admin data requires a valid, logged-in session. On top of that, every database query is scoped to the logged-in user, so a regular user can only ever see or change their own documents and workbooks — this is enforced at the database-query level, not just hidden in the interface.
- Standard security headers are added to every response using Helmet, and CORS (Cross-Origin Resource Sharing — the browser rule that controls which websites are allowed to call this API) is locked down to only the app's own known frontend address.
- Error messages on signup, login, and forgot-password are written to be generic on purpose. For example, the app never says "that email doesn't exist" versus "wrong password" separately — because that difference could let an attacker figure out which email addresses already have accounts on the system.

### Admin Panel
- The admin panel is a completely separate app (the `admin/` folder), with its own login page. Access is gated by checking that the logged-in account has `role: 'admin'` — and importantly, this check is done fresh against the database on every single request, not just trusted from whatever the login token happens to claim. This stops someone from tampering with their token to fake admin access.
- **Users** — admins can see every user account (with pagination), edit a user's username, email, or role, and delete a user entirely. Deleting a user is a cascade delete: it also removes that user's documents, their stored files, their correction history, their chat history, their workbooks, their exported-row records, and their settings — nothing is left behind as orphaned data. As with document deletion, a confirmation popup is always shown first, to prevent an accidental delete.
- **Documents** — admins can see every document from every user (with the owner's name attached), and can correct any document's fields, the same way a regular user can correct their own.
- **Workbooks** — admins can view and download any user's Excel workbooks, not just their own.
- **Logs** — a paginated, filterable audit log. It can be filtered by the type of action (like login, signup, password change, document export, document deletion, or an admin action) and/or by which user it relates to.
- **Dashboard** — a system-wide telemetry view: total number of users, total documents, total exports, the current OCR failure rate, a breakdown of documents by status and type, and how much activity happened in the last 24 hours and the last 7 days.
- Every admin action that changes something (editing or deleting a user, correcting or deleting a document) is written to the audit log automatically, so there is always a record of what an admin did and when.

### Chat
- Each processed document has its own small chat assistant attached to it. A user can ask questions about that one document's extracted number and date.
- The assistant is deliberately limited to only the data already stored for that document — it is instructed never to make up information that is not actually there.
- Chat history is saved per document, but only the most recent 50 messages are kept, to keep things bounded.
- Each assistant reply can be rated on a 1–10 scale, as simple feedback on how good the answer was.

### Dashboard / Analytics
- The regular user dashboard shows document counts by type, a list of recent documents, and quick buttons to export or download the currently active workbook.
- The admin dashboard shows the same kind of numbers, but across every user in the system at once (see the Admin Panel section above for the exact numbers shown).

## Tech Stack

This section lists the real packages used in each part of the app, and what each one is actually for. Nothing here is aspirational — this is what is installed and used right now.

### Backend (`backend/`)
| Package | Purpose |
|---|---|
| `express` (v5) | The web server itself — handles incoming HTTP requests and routes them to the right code. |
| `mongoose` (v9) | A library that makes it easier to talk to MongoDB from Node.js code, using schemas/models instead of raw database queries. |
| `tesseract.js` | The OCR engine — reads text out of images. |
| `sharp` | Crops and prepares images before they are sent to OCR (for example, cutting out just the top header section of a page). |
| `@napi-rs/canvas` | Draws a PDF page onto an image, used only when a PDF has no real text layer and needs to be treated like a photo. |
| `pdf-parse` / `pdfjs-dist` | Reads real, selectable text straight out of digital PDFs, and can also rebuild that text in the correct visual reading order. |
| `groq-sdk` | Talks to the Groq API, which is what actually runs the AI model doing extraction and chat. |
| `exceljs` | Creates and updates the `.xlsx` Excel workbook files. |
| `multer` | Handles file uploads that come in as multipart form data (the standard way browsers send files). |
| `bcryptjs` | Hashes passwords so the real password is never stored anywhere. |
| `jsonwebtoken` | Creates and checks the JWT session tokens used for login. |
| `express-rate-limit` | Limits how many times someone can hit login, signup, and chat endpoints in a given time window. |
| `helmet` | Adds a set of standard security-related HTTP headers to every response. |
| `cors` | Controls which websites/origins are allowed to call this API from a browser. |
| `dotenv` | Loads configuration values from a `.env` file into the running app (see the Setup section below). |

### Frontend (`frontend/`)
| Package | Purpose |
|---|---|
| `react` 19 / `react-dom` 19 | The UI framework the whole interface is built with. |
| `react-router-dom` 7 | Handles moving between pages inside the app without a full page reload. |
| `vite` | The tool used to run the app locally during development and to build it for production. |
| `tailwindcss` 4 (`@tailwindcss/vite`) | A styling system used to build the look of every page, using utility classes instead of separate CSS files. |
| `axios` | The library used to make HTTP requests from the browser to the backend API. |

### Admin (`admin/`)
The admin app is built with the same base stack as the main frontend (React 19, Vite, Tailwind 4, react-router-dom 7, axios), so it looks and behaves consistently, but it is its own separate project with its own build. On top of that shared base, it also uses:
| Package | Purpose |
|---|---|
| `framer-motion` | Adds small page-transition animations when moving between admin pages. |

### Database
- **MongoDB** (hosted on MongoDB Atlas in production) is where almost everything lives: user accounts, document records, workbook records, correction history, exported-row records, chat messages and feedback, app settings, and the audit log.
- **GridFS** is a feature built into MongoDB for storing files that are too large or awkward to fit neatly into a normal database document. It is used here to store the original uploaded files (the actual images and PDFs), separately from the smaller Document records that describe them.

## Architecture

The project is organized as three separate apps that all share one single backend. Keeping them separate — rather than one giant app — keeps each one focused: the backend only ever deals with data and business logic, and each frontend only ever deals with showing a UI to one kind of user.

```
backend/    Express API — the only part of the system that touches MongoDB/GridFS/Groq/disk
frontend/   React app for regular users  (Vite dev server, port 5174)
admin/      React app for admins only    (Vite dev server, port 5175)
```

Both the `frontend/` app and the `admin/` app talk to the exact same backend, running on port 5002, over a set of `/api` routes. During development, Vite (the dev server each of them runs on) automatically forwards any `/api` request through to the backend — this is called a proxy, and it is why the frontend code can just call `/api/...` without needing to know the backend's real address.

Access control between regular users and admins is enforced entirely on the server side, never just in the interface. That matters because anything only enforced in the browser can be bypassed by someone determined enough — the real gate has to live on the server:
- The `requireAuth` middleware checks that a valid, non-expired JWT is present on every protected request, and also checks that the token has not been invalidated since it was issued (see the `tokenVersion` explanation in the Auth & Security section above).
- The `isAdmin` middleware, which only runs in front of `/api/admin/*` routes, goes one step further: it looks up the user's current role directly in the database on every request, rather than trusting whatever role the token itself claims. A token cannot be edited to fake admin access, because the token's claim is never the final answer — the database is.
- The `admin/` app is its own separate bundle of code, with its own login screen and its own place to store its login token in the browser (separate from the regular frontend's token). This means the same person could, in theory, be logged into the regular app and the admin app in the same browser at the same time, without the two sessions interfering with each other.

Here is what happens, step by step, when a user uploads a document:

```
 Frontend/Admin (React)
        │  POST /api/documents/upload (multipart)
        ▼
 Express route (requireAuth) ──► GridFS (store original file)
        │
        ▼
 Processing queue (1 job at a time, round-robin per user)
        │
        ▼
 Preprocess ── sharp crop to top 28% of page (image)
           └─ pdfjs / rasterize page 1 (PDF)
        │
        ▼
 OCR ── Tesseract.js in an isolated child process
        │
        ▼
 AI Extraction ── Groq (Llama 3.3 70B), documentType-specific prompt,
                  strict JSON, key-pool failover
        │
        ▼
 Validation ── date normalized to DD/MM/YYYY, confidence scored
        │
        ▼
 MongoDB ── Document row updated (uploadStatus: processed/failed)
        │
        ▼
 Response ── JSON back to frontend (poll / refetch)
        │
        ▼
 User reviews/corrects → POST /:id/save → row appended to Excel
                          workbook (exceljs, backend/exports/) +
                          logged as an ExportedRow in MongoDB
```

Walking through that in plain words:

1. The browser sends the file to the backend as a normal file upload (multipart form data), along with which document type it is.
2. The `requireAuth` check runs first — if the user is not logged in, the request stops here.
3. The original file is saved into GridFS immediately, before any processing happens. This means the original upload is never lost, even if OCR later fails.
4. A new `Document` record is created in MongoDB with a status of `uploaded`, and the actual processing work is added to the one-slot queue described earlier, rather than being done immediately inline. This keeps the upload request itself fast — the user does not have to sit and wait for the whole upload HTTP request to finish before getting a response back.
5. When the queue gets to this job, the image (or rasterized PDF page) is cropped down to just the header area using `sharp`.
6. That cropped header image goes through Tesseract.js OCR, running in its own isolated child process.
7. The resulting text is sent to Groq's AI model, along with a prompt that depends on whether this is a Tax Invoice or a Delivery Challan.
8. The AI's answer is checked and cleaned up: the date is normalized into `DD/MM/YYYY` format, and a rough confidence value is worked out for each field.
9. The `Document` record in MongoDB is updated with the results, and its status becomes either `processed` or `failed`.
10. The frontend, which has been checking in periodically (polling) since the upload, sees the updated status and shows the result to the user.
11. Once the user is happy with the extracted fields (correcting them by hand first if needed), saving the document appends one row to the correct Excel workbook and also records that export as an `ExportedRow` in MongoDB, so there is a database record of every export in addition to the Excel file itself.

## Workflow

This section walks through what a real person actually clicks through, from the very first visit to a finished export.

**Regular user journey**
```
1. Sign up          → POST /api/auth/signup (username, email, password)
2. Log in           → POST /api/auth/login → JWT stored client-side
3. Upload           → pick document type, drop a file → OCR + AI run automatically
4. Verify / edit    → review extracted number(s) + date, correct inline if needed
5. Save / export    → append the row to the active Excel workbook
                       (first save ever, or a new year, prompts for a workbook name)
6. View history      → Export History page (all users) or download the active/
                        archived workbook from the Dashboard/Workbooks view
```

In more detail:

1. **Sign up.** A new user creates an account with a username, an email address, and a password. No email confirmation step is required to start using the app.
2. **Log in.** The user logs in with their email and password. On success, the backend hands back a JWT, and the frontend keeps it in the browser so future requests can prove who is asking.
3. **Upload.** The user picks whether the document is a Tax Invoice or a Delivery Challan, then drops in one file. From this point on, everything described in the Architecture section above happens automatically, with no further action needed from the user.
4. **Verify / edit.** Once processing finishes, the user sees the extracted number and date. If either one looks wrong, or came back empty (`null`), they can type in the correct value directly.
5. **Save / export.** Saving appends the verified row to the user's current Excel workbook. The very first time a user ever saves, or the first time in a new calendar year, the app asks them to name a new workbook before it can continue.
6. **View history.** From here, a user can look at the shared Export History page (which shows every export by every user, as explained earlier), or go to the Dashboard/Workbooks view to download their own current or older workbooks.

**Admin journey**
```
1. Log in to the admin app (separate login, role checked server-side)
2. Dashboard         → system-wide telemetry
3. Users             → view/edit/delete any user (cascade-deletes their data)
4. Documents         → view/correct any user's documents
5. Workbooks          → download any user's Excel workbook
6. Logs              → filter the audit trail by action or user
```

In more detail:

1. **Log in.** An admin logs in through the separate admin app's own login page, using an account whose role is `admin`. As covered in the Architecture section, this role is always re-checked against the database, not just trusted from the login response.
2. **Dashboard.** The admin lands on a system-wide overview: total users, total documents, total exports, and the current OCR failure rate, at a glance.
3. **Users.** From here, an admin can look through every account, fix a wrong username, email, or role, or remove an account entirely (which also removes everything that account owned).
4. **Documents.** An admin can browse every document from every user and correct a field the same way a regular user would correct their own document.
5. **Workbooks.** An admin can download any user's Excel workbook, which is useful for troubleshooting or for pulling records on someone else's behalf.
6. **Logs.** An admin can look through the audit trail, filtering by action type or by a specific user, to answer questions like "who deleted this document" or "when did this account last log in."

## API Reference

Every route below lives behind the backend's Express app on port 5002 (or, in the browser, behind the `/api` proxy). Before reading the tables, it helps to know the two access rules that apply everywhere:

- **Auth = Y** means the request must include a valid `Authorization: Bearer <token>` header — this is checked by the `requireAuth` middleware described in the Architecture section. Without it, the request is rejected before it ever reaches the route's own code.
- **Admin = Y** means, on top of Auth, the logged-in account's role must be `admin` in the database right now — this is checked by the `isAdmin` middleware, always with a fresh database lookup.

This applies to every `/api/documents/*` route, every `/api/documents/:id/chat/*` route, and every `/api/admin/*` route.

### Auth — `routes/auth.js` (mounted at `/api/auth`)

| Method | Path | Auth | Admin | Description |
|---|---|:-:|:-:|---|
| POST | `/signup` | N | N | Create a new account from a username, email, and password. Returns just a success message — the user still has to log in afterward, there is no automatic login on signup. |
| POST | `/login` | N | N | Check an email and password against the database. If they match, returns `{ token, user }` — the token is what the frontend keeps and sends with every future request. |
| GET | `/me` | Y | N | Returns the currently logged-in user's own basic info: `{ id, username, email, role }`. Used by the frontend to check "who am I" after loading. |
| PATCH | `/me` | Y | N | Lets a logged-in user update their own username and/or email. Returns the updated user object. |
| POST | `/change-password` | Y | N | Changes the password for the logged-in user, given their current password. Returns a brand-new token, since changing the password invalidates every previously-issued one. |
| POST | `/forgot-password/verify` | N | N | The first step of the "forgot password" flow — checks that a given username and email actually belong to the same account, before letting the user try to set a new password. |
| POST | `/forgot-password/reset` | N | N | The second step — re-checks the same username+email pair (never trusts that verify was called first) and then sets a brand-new password. |

### Documents — `routes/documents.js` (mounted at `/api/documents`)

| Method | Path | Auth | Admin | Description |
|---|---|:-:|:-:|---|
| POST | `/upload` | Y | N | Uploads one file (sent as multipart form data, in a field called `document`) along with a `documentType`. Stores the original file in GridFS, creates a new `Document` record, and adds the OCR/AI work to the processing queue. Returns the newly created document record right away — processing continues in the background. |
| GET | `/` | Y | N | Lists the logged-in user's own documents. If a `?page=` query is given, it returns one page of results at a time (for the Documents page). If no `?page=` is given, it returns every document at once, plus a count of documents by type — this second shape is what the Dashboard uses to build its summary. |
| GET | `/workbooks` | Y | N | Lists the logged-in user's own workbooks — both the currently active one and any archived ones — along with the name and year of whichever workbook is currently active. |
| GET | `/workbook/download` | Y | N | Downloads a workbook file. It can be asked for by `?workbookId=` (a specific workbook), by `?year=` (that year's workbook for this user), or with no extra query at all, in which case it downloads whatever workbook is currently active. |
| GET | `/export-history` | Y | N | Returns every export ever made, by every user — this route is a deliberate exception to the usual "only your own data" rule, because it powers the shared, company-wide Export History page. |
| GET | `/:id` | Y | N | Gets the full details of one document, as long as it belongs to the logged-in user. |
| GET | `/:id/download` | Y | N | Downloads the original file that was uploaded for this document. |
| POST | `/:id/reprocess` | Y | N | Re-runs OCR and AI extraction on this document again, starting from the original file, which is still safely stored in GridFS. |
| DELETE | `/:id` | Y | N | Soft-deletes a document (marks it deleted rather than destroying it) and also removes its stored file. This action is written to the audit trail. |
| PATCH | `/:id/correct` | Y | N | Manually corrects one field on a document. The request body needs `{ field, value }`. This is rejected with an error if the document is still mid-processing, since editing a field that OCR/AI might overwrite a moment later would be confusing. |
| POST | `/new-excel-file` | Y | N | Starts a brand-new active workbook for the logged-in user, given a `{ filename }` in the request body. Whatever workbook was active before this is archived, not deleted. |
| POST | `/:id/save` | Y | N | Appends this document's verified row into the correct month's worksheet inside the user's active workbook. If there is no active workbook yet, or the calendar year has just rolled over, this responds with a specific `409 NO_ACTIVE_WORKBOOK` or `409 NEED_NEW_WORKBOOK` error instead of failing silently, so the frontend knows exactly to ask the user for a workbook name first. On success, this is also logged to the audit trail as a `document_exported` event. |

### Chat — `routes/chat.js` (mounted at `/api/documents/:id/chat`)

| Method | Path | Auth | Admin | Description |
|---|---|:-:|:-:|---|
| GET | `/` | Y | N | Returns the chat history for one document (up to the most recent 50 messages), as long as the document belongs to the logged-in user. |
| POST | `/` | Y | N | Sends a new question about a processed document and returns the assistant's reply. Limited to 20 messages every 10 minutes per user, to keep AI usage costs predictable. |
| POST | `/:messageId/feedback` | Y | N | Rates one specific assistant reply on a 1–10 scale. Sending feedback again for the same message just updates the existing rating (an "upsert") instead of creating duplicates. |

### Admin — `routes/admin.js` (mounted at `/api/admin`, requires `role: admin`)

| Method | Path | Auth | Admin | Description |
|---|---|:-:|:-:|---|
| GET | `/ping` | Y | Y | A simple health check for the admin API. Just returns `{ ok: true, admin: true }` if the caller really does have admin access. |
| GET | `/users` | Y | Y | Returns a paginated list of every user account in the system. Password hashes are never included in the response. |
| GET | `/users/:id` | Y | Y | Returns the full details of one specific user, by their id. |
| PATCH | `/users/:id` | Y | Y | Lets an admin edit a user's username, email, and/or role. Logged to the audit trail. |
| DELETE | `/users/:id` | Y | Y | Deletes a user and cascades that deletion across everything they own: their documents, stored files, corrections, chat history and feedback, workbooks (including the files on disk), exported-row records, and settings. An admin cannot delete their own account through this route. Logged to the audit trail. |
| GET | `/documents` | Y | Y | Returns a paginated list of every document from every user, with the owning user's username and email attached to each one. |
| PATCH | `/documents/:id` | Y | Y | Lets an admin correct a field on any user's document. Logged to the audit trail. |
| DELETE | `/documents/:id` | Y | Y | Soft-deletes any user's document. Logged to the audit trail. |
| GET | `/workbooks` | Y | Y | Lists every workbook from every user, with the owner attached. |
| GET | `/workbooks/:id/download` | Y | Y | Downloads any user's workbook file. |
| GET | `/logs` | Y | Y | Returns a paginated view of the audit log, optionally narrowed down with `?action=` and/or `?userId=`. |
| GET | `/telemetry` | Y | Y | Returns the system-wide numbers shown on the admin dashboard: total users, total documents, total exports, documents broken down by status and type, the current OCR failure rate, and activity counts for the last 24 hours and last 7 days. |

### Health

| Method | Path | Auth | Admin | Description |
|---|---|:-:|:-:|---|
| GET | `/api/health` | N | N | A basic health check for the whole backend. Returns `{ status: 'ok', mongodb: 'connected'|'disconnected' }`, so it is easy to tell at a glance whether the server and its database connection are both working. |

## Setup / How to Run

### Prerequisites
Before starting, make sure you have:
- **Node.js** installed (an LTS version is recommended; the backend uses `express@5` and `mongoose@9`, so Node 18 or newer is a safe choice).
- **MongoDB** available somewhere — either running locally on your own machine, or a free MongoDB Atlas cluster in the cloud.
- A **Groq API key**. The free tier is enough to run this app. You can get one at [console.groq.com](https://console.groq.com).

### 1. Clone
```bash
git clone <repo-url>
cd "OCR project AJ"
```

### 2. Install dependencies (each app separately)
Each of the three apps (`backend`, `frontend`, `admin`) is its own separate project with its own dependencies, so each one needs its own `npm install`:
```bash
cd backend && npm install
cd ../frontend && npm install
cd ../admin && npm install
```

### 3. Configure environment variables
The backend needs some configuration values to run — things like a database connection string and API keys. These are kept in a `.env` file, which is never committed to git (it is listed in `.gitignore` on purpose, so real secrets never end up in the repository's history).

To set this up:
```bash
cd backend
cp .env.example .env
```
Then open the new `backend/.env` file and fill in your own real values. See `backend/.env.example` for the exact list of variable names this app needs and a short note on what each one is for — that file is safe to look at, since it only contains placeholder/empty values, never real ones.

The `frontend/` and `admin/` apps do not need a `.env` file of their own. They talk to the backend through Vite's dev proxy and do not hold any secrets themselves.

### 4. Seed an admin account
```bash
cd backend
node scripts/seedAdmin.js
```
This script creates one or more admin-role accounts, and safely does nothing if an account with the same email already exists — so it is safe to run more than once. Open `scripts/seedAdmin.js` before running it against a real database, so you know exactly which account(s) and credentials it is about to create.

### 5. Run in development (3 terminals)
Each app runs as its own separate process, so it is easiest to run them in three separate terminal windows at the same time:
```bash
# Terminal 1 — backend (http://localhost:5002)
cd backend && npm run dev

# Terminal 2 — frontend (http://localhost:5174)
cd frontend && npm run dev

# Terminal 3 — admin (http://localhost:5175)
cd admin && npm run dev
```
Once all three are running, the regular app is at `http://localhost:5174` and the admin app is at `http://localhost:5175`. Both talk to the same backend on port 5002 behind the scenes.

### 6. Production build
```bash
cd frontend && npm run build
cd ../admin && npm run build
```
These commands produce optimized, static versions of each frontend app (in a `dist` folder each). Run the backend with `NODE_ENV=production` set, and it will serve the main `frontend/dist` build directly by itself (see `server.js`) — so in production, the backend and the main frontend can be one single deployed thing. The `admin/dist` build is not auto-served by the backend, so it needs to be hosted separately (its own static host, or its own path behind a reverse proxy).

## Folder Structure

```
OCR project AJ/
├── README.md
├── .gitignore
├── backend/
│   ├── server.js                  Express app entry, Mongo connect, crash safety net
│   ├── package.json
│   ├── .env.example                Documented env vars (no real values)
│   ├── eng.traineddata              Tesseract English language data
│   ├── middleware/
│   │   ├── auth.js                 requireAuth — JWT verification
│   │   └── isAdmin.js              isAdmin — DB-backed role check
│   ├── models/
│   │   ├── User.js
│   │   ├── Document.js
│   │   ├── Workbook.js
│   │   ├── Settings.js
│   │   ├── ExportedRow.js
│   │   ├── Correction.js
│   │   ├── ChatMessage.js
│   │   ├── ChatFeedback.js
│   │   └── AuditLog.js
│   ├── routes/
│   │   ├── auth.js
│   │   ├── documents.js
│   │   ├── chat.js
│   │   └── admin.js
│   ├── services/
│   │   ├── ocr.js                  Header-crop OCR orchestrator (image/PDF routing)
│   │   ├── ocr-worker.js           Tesseract child process
│   │   ├── pdf-render-worker.js    PDF page → PNG child process
│   │   ├── groq.js                 AI extraction + chat + date normalization
│   │   ├── excel.js                Workbook create/append (exceljs)
│   │   ├── gridfs.js               GridFS upload/download/delete
│   │   └── auditLog.js             logAction() helper
│   ├── utils/
│   │   ├── validators.js
│   │   ├── objectId.js
│   │   └── withTimeout.js
│   ├── scripts/
│   │   └── seedAdmin.js            Admin account seed script
│   └── exports/                    Generated .xlsx workbooks (gitignored)
├── frontend/
│   ├── src/
│   │   ├── pages/                  Login, Signup, ForgotPassword, Dashboard,
│   │   │                           Upload, Documents, DocumentDetail,
│   │   │                           DocumentChat, ExportHistory, Profile, NotFound
│   │   ├── components/             AppLayout, UploadCard, DocumentCard,
│   │   │                           DocumentList, DocumentPreview,
│   │   │                           DocumentDetailsPanel, ExtractedFieldsTable,
│   │   │                           ExtractedTablesView, CorrectionModal,
│   │   │                           AddRowModal, DocumentChat, ChatMessageBubble,
│   │   │                           RequireAuth, ErrorMessage, LoadingState,
│   │   │                           ProcessingState, EmptyState, SummaryCard,
│   │   │                           PasswordInput, ServerDownBanner
│   │   ├── context/AuthContext.jsx
│   │   └── utils/                  api.js (axios + interceptors), validators.js
│   └── vite.config.js              dev proxy /api → :5002, port 5174
└── admin/
    ├── src/
    │   ├── pages/                  AdminLogin, AdminForgotPassword,
    │   │                           AdminDashboard, AdminUsers, AdminDocuments,
    │   │                           AdminWorkbooks, AdminLogs, AdminProfile
    │   ├── components/             AdminLayout, RequireAdminAuth, Banner,
    │   │                           Modal, PaginationControls, PasswordInput,
    │   │                           ServerDownBanner
    │   ├── context/AdminAuthContext.jsx
    │   └── utils/                  api.js (axios + interceptors), validators.js
    └── vite.config.js              dev proxy /api → :5002, port 5175
```

A quick note on how to read this tree: `backend/` is the one shared brain of the app — it is the only place that ever talks directly to MongoDB, GridFS, or Groq. `frontend/` and `admin/` are two separate faces on top of that same brain, one for regular users and one for admins, and neither of them can reach the database or any external service directly — everything they do goes through the backend's API first.

## Troubleshooting for Office Users

The app itself has a built-in **Help** page (`/help` in the regular frontend, linked from the navbar) with the exact same content as below, in an expandable/collapsible list. This section is that same content, reproduced here so it is also available outside the app itself.

**I uploaded a file and got an error like "File content does not match" or "File size must be 5 MB or less"**
- This app only accepts PDF, JPG, JPEG, or PNG files, and each file must be smaller than 5 MB.
- Check what type your file is and how big it is (right-click the file → Properties on Windows, or Get Info on Mac).
- If it is a different file type (like Word or Excel), save/export it as a PDF first, then upload the PDF.
- If it is too big, ask whoever scanned it to save it at a lower quality, or take a normal photo instead of a very high-resolution scan.

**I forgot to check which "Document Type" was selected before uploading**
- Before every upload, look at the "Document Type" buttons (Tax Invoice / Delivery Challan) above the upload box.
- The app always has one selected by default - if you upload without checking, it may pick the wrong one for your document.
- If you notice after uploading that the wrong type was used, open the document and click "Reprocess" - but first you need to fix this from the very start, so it is best to just double check the Document Type before every upload.
- For Bulk Upload, each file has its own dropdown next to it - check every file's dropdown before clicking "Upload All".

**The extracted Number or Date is wrong, or empty (looks like a dash "-")**
- This happens when the scan or photo was blurry, dark, or the number was partly covered by a stamp.
- Open the document and look for a red circle icon next to the field - that means the app itself is not confident about that value and wants you to double-check it.
- Click "Edit" on that field and type in the correct value by looking at the original document (you can view/download the original file from the same page).
- If many fields look wrong, try "Reprocess" first - it re-reads the file from scratch and sometimes gets a better result.
- For best results next time: use good lighting, hold the camera steady, and make sure the top of the page (where the number and date are) is not covered by anything.

**I clicked Save/Export and nothing seems to have happened**
- "Save" only works once a document has finished processing (status shows "Processed"). If it still says "Uploaded" or "Processing", wait a bit and try again.
- If this is your very first time saving, the app will ask you to type a name for a new Excel file - type any name and click OK.
- If nothing downloads when you click "Export" on the Dashboard, check your browser's download folder or download bar - some browsers save the file quietly without a popup.
- If you see a red message instead of a download, read the message - it tells you exactly what went wrong (for example, "no active Excel workbook yet").

**I can't log in - is it a wrong password, or something else?**
- If the page says "Invalid email or password", either your email or password is wrong. Check for typos, and make sure Caps Lock is off.
- If you genuinely forgot your password, click "Forgot password?" on the login page and follow the steps there - you will need to enter your username and email correctly.
- If you see a message about "too many login attempts", wait about 15 minutes before trying again - this is a safety feature, not a bug.

**I got suddenly logged out while using the app**
- Your login automatically expires after some time for security. This is normal and not an error.
- Simply log in again with your email and password - you will be taken back to the same page you were on.
- Nothing you already saved or uploaded is lost when this happens.

**The page is blank, frozen, or shows "Server is currently unreachable"**
- This means the app cannot reach the server right now - usually a temporary internet or server issue, not something wrong with your computer.
- Wait about 10-30 seconds - the app checks the connection automatically and this message will disappear on its own once the server is back.
- If it does not go away after a few minutes, refresh the page (F5) or contact your admin/IT contact.

**My document has been stuck on "Processing..." for a long time**
- Processing usually takes a few seconds to about a minute per document, especially if many people are uploading files at the same time - the app processes one file at a time to stay reliable.
- If the app tells you it is "taking longer than expected", it may still finish in the background - go check the "My Documents" page after a minute or two.
- If it still says "Uploaded" or "Processing" after several minutes, use the "Reprocess" button on the document's page to try again.

**I searched for a document but it did not show up**
- Number search: it looks for that text anywhere inside the number, so a partial number is fine (for example, searching "7704827" will find "G0027704827").
- Date search: this one needs to match EXACTLY, in the format DD/MM/YYYY (for example 01/07/2026, with the leading zero and forward slashes). Typing it any other way (like 1-7-2026 or July 1) will not find it.
- Remember, you can only search your own documents, not documents uploaded by other people.
- Click "Clear Search" to see your full document list again.

**I accidentally clicked Delete on a document**
- The app always asks "Delete this document? This cannot be undone." before actually deleting anything - if you see that popup, click Cancel and you are safe.
- If you already confirmed the delete, it genuinely cannot be undone by you from within the app.
- If this was important data, contact your admin - they may be able to help depending on how recently it happened.

**I saved a document but I don't see it in my Excel file**
- Your Excel workbook has a separate sheet/tab for each month, and it is based on the DATE PRINTED ON THE DOCUMENT - not the day you clicked Save.
- For example, if a document is dated 15/06/2026 and you save it in July, it goes into the "June" sheet, not "July".
- Open the Excel file and check the sheet tabs at the bottom of the window for the month matching the document's own date.
- If a document's Date field itself is wrong, fix it first (Edit) - otherwise it will keep landing on the wrong month's sheet.

**Bulk Upload won't let me add more files**
- Bulk Upload accepts a maximum of 5 files at once.
- If you have more than 5 documents, upload the first 5, wait for that batch to finish, then click "Start New Batch" and upload the rest.
- Each file in Bulk Upload still needs the right Document Type selected in its own dropdown, and still follows the same file type/size rules as a single upload.

Still stuck after trying the steps above? Contact your admin or IT contact for help.
