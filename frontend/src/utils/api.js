import axios from 'axios'

const api = axios.create({
  baseURL: '/api',
  timeout: 120000, // 2 min for OCR processing
})

api.interceptors.response.use(
  (res) => res,
  (err) => {
    const message = err.response?.data?.error || err.message || 'Something went wrong.'
    err.userMessage = message
    return Promise.reject(err)
  }
)

// Export a document row to the active Excel workbook and download the file.
// Handles the first-ever export automatically: when the backend says no
// active file exists (NO_ACTIVE_FILE), prompts for a filename, creates the
// workbook, then retries. Blob responses hide JSON error bodies, so 400s
// are re-parsed from blob text before deciding what went wrong.
export async function exportDocument(docId) {
  async function doExport() {
    return api.post(`/documents/${docId}/export`, {}, { responseType: 'blob' })
  }

  let res
  try {
    res = await doExport()
  } catch (err) {
    let body = null
    if (err.response?.data instanceof Blob) {
      try { body = JSON.parse(await err.response.data.text()) } catch { body = null }
    } else {
      body = err.response?.data || null
    }

    if (body?.error === 'NO_ACTIVE_FILE') {
      const filename = window.prompt('No active Excel file yet. Enter a name for the new export file:')
      if (!filename || !filename.trim()) return false
      await api.post('/documents/new-excel-file', { filename: filename.trim() })
      res = await doExport()
    } else {
      throw Object.assign(err, { userMessage: body?.error || body?.message || err.userMessage })
    }
  }

  // Use the server's filename (Content-Disposition) so the download matches
  // the active workbook name instead of a generic "export.xlsx".
  const disposition = res.headers?.['content-disposition'] || ''
  const match = disposition.match(/filename\*?=(?:UTF-8'')?"?([^\";]+)"?/i)
  const filename = match ? decodeURIComponent(match[1]) : 'export.xlsx'

  const url = window.URL.createObjectURL(new Blob([res.data]))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  window.URL.revokeObjectURL(url)
  return true
}

export default api
