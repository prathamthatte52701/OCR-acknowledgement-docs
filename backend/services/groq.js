// AI Service - Groq (free tier, llama-3.3-70b)
// Acknowledgement flow: extract just the identifying number(s) + date from a
// document's cropped header text. Field shape is documentType-conditional -
// Tax Invoice has TWO distinct number fields (the TAX INVOICE No. itself, and
// a separate "Reference No." next to the date); Delivery Challan has one.
const Groq = require('groq-sdk')

// Multiple keys (GROQ_API_KEYS, comma-separated) are round-robined across calls so
// no single key absorbs the full request/token-per-minute load. Falls back to a
// single GROQ_API_KEY if only one is configured.
function getKeyPool() {
  const multi = process.env.GROQ_API_KEYS
  if (multi && multi.trim()) {
    return multi.split(',').map(k => k.trim()).filter(Boolean)
  }
  const single = process.env.GROQ_API_KEY
  if (single && single.trim()) return [single.trim()]
  return []
}

let keyPool = null
let nextStartIndex = 0

// Runs a Groq request, failing over to the next key in the pool if the current
// key is rate-limited/unauthorized/erroring server-side - so one exhausted key
// doesn't take the whole pipeline down. Only fails over for capacity/auth/server
// errors; a genuine bad-request error (e.g. malformed prompt) is not retried
// with a different key since that would just fail again identically.
//
// Each call picks its own fixed starting index (advanced once, synchronously,
// before any await) and then walks every key in the pool exactly once from
// there. This keeps retries within one call from ever repeating a key, even
// when multiple calls run concurrently and race over the shared round-robin
// counter.
async function callGroqWithFailover(makeRequest) {
  if (keyPool === null) keyPool = getKeyPool()
  if (!keyPool.length) throw new Error('GROQ_API_KEY (or GROQ_API_KEYS) is not set')

  const startIndex = nextStartIndex % keyPool.length
  nextStartIndex++

  let lastError
  for (let i = 0; i < keyPool.length; i++) {
    const keyIndex = (startIndex + i) % keyPool.length
    const client = new Groq({ apiKey: keyPool[keyIndex] })
    try {
      return await makeRequest(client)
    } catch (err) {
      lastError = err
      const status = err?.status
      const shouldFailover = status === 429 || status === 401 || status === 403 || (status >= 500 && status < 600)
      console.warn(`Groq key #${keyIndex + 1}/${keyPool.length} failed (status ${status || 'unknown'}): ${err.message}${shouldFailover && i < keyPool.length - 1 ? ' - trying next key' : ''}`)
      if (!shouldFailover) throw err
    }
  }
  throw lastError
}

function stripMarkdown(text) {
  return text
    .replace(/^```json\s*/im, '')
    .replace(/^```\s*/im, '')
    .replace(/\s*```$/im, '')
    .trim()
}

function sanitizeJSON(text) {
  // Remove control characters inside JSON strings that break JSON.parse
  return text.replace(
    /"((?:[^"\\]|\\.)*)"/g,
    (match) => match.replace(/[\x00-\x1F\x7F]/g, (c) => {
      const escapes = { '\n': '\\n', '\r': '\\r', '\t': '\\t' }
      return escapes[c] || ''
    })
  )
}

function parseJSON(raw) {
  const cleaned = sanitizeJSON(stripMarkdown(raw))
  try {
    return JSON.parse(cleaned)
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/)
    if (!match) throw new Error('AI returned invalid JSON')
    try {
      return JSON.parse(match[0])
    } catch {
      return JSON.parse(sanitizeJSON(match[0]))
    }
  }
}

const PRINTED_ONLY_RULE = `
CRITICAL - PRINTED TEXT ONLY:
- This OCR text may contain handwritten notes, rubber-stamp text, signatures, or pen marks mixed in with the machine-printed form.
- Extract ONLY values that belong to the machine-printed form fields.
- IGNORE anything that reads like a handwritten annotation, a stamp, a signature name, or loose numbers/notes scribbled outside the form's own printed fields.
- Never guess. If a value is not confidently present in the text, return null for it.`

const TAX_INVOICE_SYSTEM = `You are a document extraction specialist for Indian Tax Invoice documents. You are given OCR text of only the TOP header section of the page.

Extract exactly three values:
1. taxInvoiceNo - the number in the "TAX INVOICE" row/box near the top (e.g. "G0027704827"). Usually starts with the letter G followed by digits.
2. referenceNo - the number in the "Reference No." row (a separate field from TAX INVOICE No., usually plain digits, e.g. "9800592335").
3. date - the date in the SAME row as "Reference No." (e.g. "01.07.2026" or "01/07/2026"). Convert to DD/MM/YYYY format in your output.
${PRINTED_ONLY_RULE}

Return STRICT JSON only, no markdown, no explanation:
{"taxInvoiceNo": "..." or null, "referenceNo": "..." or null, "date": "DD/MM/YYYY" or null}`

const DELIVERY_CHALLAN_SYSTEM = `You are a document extraction specialist for Indian Delivery Challan documents. You are given OCR text of only the TOP header section of the page.

Extract exactly two values:
1. number - the number in the "Delivery Challan" row (plain digits, e.g. "820268362").
2. date - the date in the SAME row as that number (e.g. "10.07.2026" or "10/07/2026"). Convert to DD/MM/YYYY format in your output.
${PRINTED_ONLY_RULE}

Return STRICT JSON only, no markdown, no explanation:
{"number": "...", or null, "date": "DD/MM/YYYY" or null}`

const DATE_RE = /^(\d{2})[./-](\d{2})[./-](\d{4})$/

// Never guess: only accepts a value that's already unambiguously DD/MM/YYYY-shaped
// (separator normalized to /). Anything else (missing, malformed, ambiguous) -> null.
function normalizeDateToDDMMYYYY(raw) {
  if (!raw || typeof raw !== 'string') return null
  const match = raw.trim().match(DATE_RE)
  if (!match) return null
  const [, dd, mm, yyyy] = match
  const d = Number(dd), m = Number(mm)
  if (d < 1 || d > 31 || m < 1 || m > 12) return null
  return `${dd}/${mm}/${yyyy}`
}

// Confidence scoring - no field-level score is available from Tesseract in
// this pipeline (ocr.js only returns plain header text, not per-word boxes),
// so this uses the next-best signal already sitting in this function: whether
// the AI actually returned a value, and whether that value survives the
// validation/normalization it already goes through below. A number field is
// additionally sanity-checked for shape (mostly alphanumeric, not a stray
// fragment) since nothing else validates it the way normalizeDateToDDMMYYYY
// already validates a date. 0-100 scale; null means "no extraction attempted".
const PLAUSIBLE_NUMBER_RE = /^[A-Za-z0-9][A-Za-z0-9/-]{2,}$/

function numberConfidence(value) {
  if (!value) return 0
  return PLAUSIBLE_NUMBER_RE.test(value.trim()) ? 100 : 40
}

function dateConfidence(rawDate, normalizedDate) {
  if (!rawDate) return 0
  return normalizedDate ? 100 : 30
}

async function extractHeader(documentType, headerText) {
  if (!headerText || !headerText.trim()) {
    return documentType === 'Tax Invoice'
      ? { taxInvoiceNo: null, referenceNo: null, date: null, taxInvoiceNoConfidence: 0, referenceNoConfidence: 0, dateConfidence: 0 }
      : { number: null, date: null, numberConfidence: 0, dateConfidence: 0 }
  }

  const systemPrompt = documentType === 'Tax Invoice' ? TAX_INVOICE_SYSTEM : DELIVERY_CHALLAN_SYSTEM
  const response = await callGroqWithFailover(client => client.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `Extract from this ${documentType} header OCR text:\n\n${headerText}` },
    ],
    temperature: 0.1,
    max_tokens: 300,
  }))

  const parsed = parseJSON(response.choices[0].message.content)
  const date = normalizeDateToDDMMYYYY(parsed.date)
  const dateConf = dateConfidence(parsed.date, date)

  if (documentType === 'Tax Invoice') {
    return {
      taxInvoiceNo: parsed.taxInvoiceNo || null,
      referenceNo: parsed.referenceNo || null,
      date,
      taxInvoiceNoConfidence: numberConfidence(parsed.taxInvoiceNo),
      referenceNoConfidence: numberConfidence(parsed.referenceNo),
      dateConfidence: dateConf,
    }
  }
  return {
    number: parsed.number || null,
    date,
    numberConfidence: numberConfidence(parsed.number),
    dateConfidence: dateConf,
  }
}

const CHAT_SYSTEM = `You are a helpful assistant answering questions about a single scanned document. Only use the document details given below - never invent information. If the answer isn't in the given details, say so plainly.`

async function answerQuestion(question, docContext) {
  const { documentType, taxInvoiceNo, referenceNo, number, date } = docContext

  const contextBlock = documentType === 'Tax Invoice'
    ? `Document Type: Tax Invoice\nTAX INVOICE No.: ${taxInvoiceNo ?? 'Not available'}\nReference No.: ${referenceNo ?? 'Not available'}\nDate: ${date ?? 'Not available'}`
    : `Document Type: Delivery Challan\nDelivery Challan No.: ${number ?? 'Not available'}\nDate: ${date ?? 'Not available'}`

  const response = await callGroqWithFailover(client => client.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    messages: [
      { role: 'system', content: CHAT_SYSTEM + '\n\n' + contextBlock },
      { role: 'user', content: question },
    ],
    temperature: 0.2,
    max_tokens: 500,
  }))

  return response.choices[0].message.content
}

module.exports = {
  extractHeader,
  normalizeDateToDDMMYYYY,
  answerQuestion,
}
