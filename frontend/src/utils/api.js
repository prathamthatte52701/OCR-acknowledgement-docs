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

// Save a processed document's row to the active Excel workbook - appends only,
// no download. Handles two automatic prompts:
//  - NO_ACTIVE_WORKBOOK: first-ever save, prompt for a workbook name, create it,
//    retry.
//  - NEED_NEW_WORKBOOK: the year rolled over, prompt for the new year's workbook
//    name, create it, retry.
// Returns the success message on success; throws with err.userMessage carrying
// the exact server reason (locked file, permission, etc.) on failure.
export async function saveDocument(docId) {
  async function doSave() {
    return api.post(`/documents/${docId}/save`)
  }

  try {
    const res = await doSave()
    return res.data?.message || 'Excel file appended successfully.'
  } catch (err) {
    const body = err.response?.data || {}

    if (body.error === 'NO_ACTIVE_WORKBOOK') {
      const filename = window.prompt('No active Excel workbook yet. Enter a name for the new workbook:')
      if (!filename || !filename.trim()) return null
      await api.post('/documents/new-excel-file', { filename: filename.trim() })
    } else if (body.error === 'NEED_NEW_WORKBOOK') {
      const filename = window.prompt(`${body.message}\n\nEnter a name for the ${body.year} workbook:`, `Bills_${body.year}`)
      if (!filename || !filename.trim()) return null
      await api.post('/documents/new-excel-file', { filename: filename.trim() })
    } else {
      // Surface the exact server-side reason - never a generic message.
      throw Object.assign(err, { userMessage: body.message || body.error || err.userMessage })
    }

    // Retry once after creating the workbook.
    const res = await doSave()
    return res.data?.message || 'Excel file appended successfully.'
  }
}

// Download the current active Excel workbook (dashboard Export). Blob responses
// hide JSON error bodies, so 400/404 bodies are re-parsed from blob text.
export async function downloadWorkbook(year = null) {
  let res
  try {
    res = await api.get('/documents/workbook/download', {
      params: year ? { year } : {},
      responseType: 'blob',
    })
  } catch (err) {
    let body = null
    if (err.response?.data instanceof Blob) {
      try { body = JSON.parse(await err.response.data.text()) } catch { body = null }
    } else {
      body = err.response?.data || null
    }
    throw Object.assign(err, { userMessage: body?.message || body?.error || err.userMessage })
  }

  const disposition = res.headers?.['content-disposition'] || ''
  const match = disposition.match(/filename\*?=(?:UTF-8'')?"?([^\";]+)"?/i)
  const filename = match ? decodeURIComponent(match[1]) : 'workbook.xlsx'

  const url = window.URL.createObjectURL(new Blob([res.data]))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  window.URL.revokeObjectURL(url)
  return true
}

export default api
