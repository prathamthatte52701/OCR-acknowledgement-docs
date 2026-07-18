// Races a promise against a timer so an in-process library call (pdf-parse,
// pdfjs-dist) that never resolves on a malformed/hostile file can't hang the
// request forever - mirrors the timeout already applied to the OCR child process.
function withTimeout(promise, ms, label) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

module.exports = { withTimeout }
