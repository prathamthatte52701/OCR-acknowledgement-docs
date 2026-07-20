import { useState, useEffect } from 'react'
import { useParams, Link, useNavigate } from 'react-router-dom'
import api, { saveDocument } from '../utils/api'
import CorrectionModal from '../components/CorrectionModal'
import ConfirmModal from '../components/ConfirmModal'
import LoadingState from '../components/LoadingState'
import ErrorMessage from '../components/ErrorMessage'
import ProcessingState from '../components/ProcessingState'
import { formatIST } from '../utils/formatDate'

function formatDate(d) {
  return formatIST(d)
}

function formatSize(bytes) {
  if (!bytes) return '-'
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

// Which fields are editable, per documentType - matches backend EDITABLE_FIELDS
// and PATCH /:id/correct's field-conditional validation.
function fieldsFor(doc) {
  if (doc.documentType === 'Tax Invoice') {
    return [
      { key: 'taxInvoiceNo', label: 'TAX INVOICE No.', value: doc.taxInvoiceNo, confidence: doc.taxInvoiceNoConfidence },
      { key: 'referenceNo', label: 'Reference No.', value: doc.referenceNo, confidence: doc.referenceNoConfidence },
      { key: 'date', label: 'Date', value: doc.date, confidence: doc.dateConfidence },
    ]
  }
  return [
    { key: 'number', label: 'Delivery Challan No.', value: doc.number, confidence: doc.numberConfidence },
    { key: 'date', label: 'Date', value: doc.date, confidence: doc.dateConfidence },
  ]
}

// Threshold matches the spec: anything below ~80, or no score at all
// (extraction failed/null), is flagged for manual verification.
const LOW_CONFIDENCE_THRESHOLD = 80

function ConfidenceBadge({ confidence }) {
  const isLow = confidence == null || confidence < LOW_CONFIDENCE_THRESHOLD
  if (!isLow) {
    return (
      <span title="High confidence" className="shrink-0 grid h-5 w-5 place-items-center rounded-full bg-green-900/30 text-green-400" aria-label="High confidence">
        <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>
      </span>
    )
  }
  return (
    <span title="Low confidence — please verify" className="shrink-0 grid h-5 w-5 place-items-center rounded-full bg-red-900/30 text-red-400" aria-label="Low confidence — please verify">
      <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path strokeLinecap="round" strokeLinejoin="round" d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" /></svg>
    </span>
  )
}

export default function DocumentDetailPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [doc, setDoc] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [editingField, setEditingField] = useState(null)
  const [reprocessing, setReprocessing] = useState(false)
  const [reprocessMsg, setReprocessMsg] = useState('')
  const [deleting, setDeleting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState(false)

  async function fetchDoc() {
    try {
      const res = await api.get(`/documents/${id}`)
      setDoc(res.data?.document)
    } catch (err) {
      setError(err.userMessage || 'Document not found or could not be loaded.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    let cancelled = false

    api.get(`/documents/${id}`)
      .then(res => {
        if (!cancelled) setDoc(res.data?.document)
      })
      .catch(err => {
        if (!cancelled) setError(err.userMessage || 'Document not found or could not be loaded.')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => { cancelled = true }
  }, [id])

  async function handleCorrect(field, newValue) {
    try {
      await api.patch(`/documents/${id}/correct`, { field: field.key, value: newValue })
      setEditingField(null)
      alert(`${field.label} updated successfully.`)
      fetchDoc()
    } catch (err) {
      alert(err.userMessage || 'Could not save your correction. Please try again.')
    }
  }

  async function handleReprocess() {
    if (!window.confirm('Re-run OCR and AI analysis on this document?')) return
    setReprocessing(true)
    setReprocessMsg('')
    try {
      await api.post(`/documents/${id}/reprocess`)
      setReprocessMsg('Reprocessing started. Check the document status shortly.')
      fetchDoc()
    } catch (err) {
      setReprocessMsg(err.userMessage || 'Could not start reprocessing. Please try again.')
    } finally {
      setReprocessing(false)
    }
  }

  async function handleSave() {
    setSaving(true)
    try {
      const message = await saveDocument(id)
      if (message) alert(message) // "Excel file appended successfully."
    } catch (err) {
      alert(err.userMessage || 'Could not save this document to Excel. Please try again.')
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete() {
    setDeleting(true)
    try {
      await api.delete(`/documents/${id}`)
      navigate('/documents')
    } catch (err) {
      alert(err.userMessage || 'Could not delete this document. Please try again.')
      setDeleting(false)
      setConfirmingDelete(false)
    }
  }

  function handleDownload() {
    window.open(`/api/documents/${id}/download`, '_blank')
  }

  if (loading) return <div className="max-w-4xl mx-auto px-4 py-8"><LoadingState /></div>
  if (error) return <div className="max-w-4xl mx-auto px-4 py-8"><ErrorMessage message={error} /></div>
  if (!doc) return null

  const statusColor = {
    uploaded: 'text-yellow-400 bg-yellow-900/20 border-yellow-800',
    processed: 'text-green-400 bg-green-900/20 border-green-800',
    failed: 'text-red-400 bg-red-900/20 border-red-800',
  }[doc.uploadStatus] || 'text-gray-400 bg-gray-800 border-gray-700'

  return (
    <div className="max-w-4xl mx-auto px-4 py-8">
      <Link to="/documents" className="text-gray-500 hover:text-gray-300 text-[14.7px] no-underline flex items-center gap-1 mb-4">
        {'<-'} Back to Documents
      </Link>

      <div className="flex items-start justify-between gap-4 flex-wrap mb-4">
        <div>
          <h1 className="text-2xl font-bold text-white">{doc.autoName}</h1>
          <p className="text-gray-500 text-[12.6px] mt-0.5">{doc.originalFilename}</p>
        </div>
        <span className={`text-[12.6px] px-2.5 py-1 rounded-full border font-medium capitalize ${statusColor}`}>
          {doc.uploadStatus}
        </span>
      </div>

      <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 mb-5 grid grid-cols-2 sm:grid-cols-4 gap-3 text-[14.7px]">
        {[
          { label: 'Document Type', value: doc.documentType || '-' },
          { label: 'File Size', value: formatSize(doc.size) },
          { label: 'Uploaded', value: formatDate(doc.createdAt) },
          { label: 'Processed', value: formatDate(doc.processedAt || doc.reprocessedAt) },
        ].map(m => (
          <div key={m.label}>
            <p className="text-gray-600 text-[12.6px] mb-0.5">{m.label}</p>
            <p className="text-gray-300 text-[14.7px]">{m.value}</p>
          </div>
        ))}
      </div>

      {doc.uploadStatus === 'failed' && (
        <div className="bg-red-900/20 border border-red-800 rounded-xl p-4 mb-5">
          <p className="text-red-400 font-semibold mb-1">Processing Failed</p>
          <p className="text-red-300/70 text-[14.7px]">{doc.processingError || 'We could not process this document. Try reprocessing it below.'}</p>
        </div>
      )}

      {reprocessMsg && (
        <div className={`border rounded-xl p-3 mb-4 text-[14.7px] ${reprocessMsg.toLowerCase().includes('started') ? 'bg-green-900/20 border-green-800 text-green-400' : 'bg-red-900/20 border-red-800 text-red-400'}`}>
          {reprocessMsg}
        </div>
      )}

      <div className="flex flex-wrap gap-2 mb-6">
        {doc.uploadStatus === 'processed' && (
          <Link
            to={`/documents/${id}/chat`}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-[14.7px] font-medium rounded-lg transition-colors no-underline"
          >
            Chat with Document
          </Link>
        )}
        {doc.uploadStatus === 'processed' && (
          <button onClick={handleSave} disabled={saving} className="px-4 py-2 bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 text-white text-[14.7px] font-medium rounded-lg transition-colors">
            {saving ? 'Saving...' : 'Save to Excel'}
          </button>
        )}
        <button onClick={handleDownload} className="px-4 py-2 bg-gray-800 hover:bg-gray-700 text-gray-300 text-[14.7px] rounded-lg transition-colors">
          Download Original
        </button>
        <button onClick={handleReprocess} disabled={reprocessing} className="px-4 py-2 bg-gray-800 hover:bg-gray-700 disabled:opacity-50 text-gray-300 text-[14.7px] rounded-lg transition-colors">
          {reprocessing ? 'Reprocessing...' : 'Reprocess'}
        </button>
        <button onClick={() => setConfirmingDelete(true)} disabled={deleting} className="px-4 py-2 bg-red-900/30 hover:bg-red-900/50 disabled:opacity-50 text-red-400 text-[14.7px] rounded-lg border border-red-800/50 transition-colors">
          {deleting ? 'Deleting...' : 'Delete'}
        </button>
      </div>

      {reprocessing && <ProcessingState message="Reprocessing with OCR and AI..." />}

      {doc.uploadStatus === 'processed' && !reprocessing && (
        <div className="space-y-3">
          <h3 className="text-gray-300 font-semibold mb-2">Extracted Fields</h3>
          {fieldsFor(doc).map(f => {
            const isLow = f.confidence == null || f.confidence < LOW_CONFIDENCE_THRESHOLD
            return (
              <div key={f.key} className={`flex items-center justify-between gap-3 bg-gray-900 border rounded-xl px-4 py-3 ${isLow ? 'border-red-800/60' : 'border-gray-800'}`}>
                <div className="min-w-0 flex items-center gap-2">
                  <div className="min-w-0">
                    <p className="text-gray-500 text-[12.6px]">{f.label}</p>
                    <p className="text-gray-100 text-[14.7px] font-semibold truncate">{f.value || 'Not available'}</p>
                  </div>
                  <ConfidenceBadge confidence={f.confidence} />
                </div>
                <button
                  onClick={() => setEditingField(f)}
                  className="shrink-0 px-3 py-1.5 text-[12.6px] font-bold text-blue-300 border border-blue-800/50 rounded-lg hover:bg-blue-900/20 transition-colors"
                >
                  Edit
                </button>
              </div>
            )
          })}
          {doc.edited && (
            <p className="text-[12.6px] text-amber-400">This document has manually edited fields.</p>
          )}
        </div>
      )}

      {editingField && (
        <CorrectionModal
          field={{ label: editingField.label, value: editingField.value, key: editingField.key }}
          onSave={handleCorrect}
          onClose={() => setEditingField(null)}
        />
      )}

      {confirmingDelete && (
        <ConfirmModal
          title="Delete this document?"
          message="Are you sure you want to delete this document? This cannot be undone."
          onConfirm={handleDelete}
          onClose={() => setConfirmingDelete(false)}
          busy={deleting}
        />
      )}
    </div>
  )
}
