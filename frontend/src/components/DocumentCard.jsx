import { Link } from 'react-router-dom'
import { saveDocument } from '../utils/api'

const statusStyles = {
  uploaded: 'border-sky-400/25 bg-sky-400/10 text-sky-300',
  processed: 'border-emerald-400/25 bg-emerald-400/10 text-emerald-300',
  failed: 'border-rose-400/25 bg-rose-400/10 text-rose-300',
}

const statusLabels = {
  uploaded: 'Uploaded',
  processed: 'Processed',
  failed: 'Failed',
}

function StatusBadge({ status }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[11.6px] font-bold ${statusStyles[status] || statusStyles.uploaded}`}>
      <span className="h-1.5 w-1.5 rounded-full bg-current shadow-[0_0_12px_currentColor]" />
      {statusLabels[status] || statusLabels.uploaded}
    </span>
  )
}

function displayNumber(doc) {
  if (doc.documentType === 'Tax Invoice') {
    return [doc.taxInvoiceNo, doc.referenceNo].filter(Boolean).join(' / ') || '-'
  }
  return doc.number || '-'
}

async function handleSave(docId) {
  try {
    const message = await saveDocument(docId)
    if (message) alert(message) // "Excel file appended successfully."
  } catch (err) {
    alert(err.userMessage || 'Failed to append to the Excel file.')
  }
}

export default function DocumentCard({ doc }) {
  const status = doc.uploadStatus || 'uploaded'

  return (
    <article className="group relative overflow-hidden rounded-3xl border border-blue-300/12 bg-slate-900/64 p-5 shadow-[0_24px_90px_rgba(2,8,23,0.34)] backdrop-blur-xl transition-all duration-300 hover:-translate-y-1 hover:border-blue-300/40 hover:shadow-[0_28px_110px_rgba(37,99,235,0.16)]">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_0%_0%,rgba(37,99,235,0.22),transparent_26%),linear-gradient(135deg,rgba(59,130,246,0.08),transparent_42%)] opacity-80" />

      <div className="relative flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-lg font-black tracking-tight text-white">{doc.autoName}</h3>
          <p className="mt-1 truncate text-[14.7px] text-slate-500">{doc.documentType}</p>
        </div>
        <StatusBadge status={status} />
      </div>

      <div className="relative mt-4 grid grid-cols-2 gap-3 text-[14.7px]">
        <p className="min-w-0 truncate text-slate-400">
          <span className="text-slate-500">Number: </span>
          <span className="text-slate-200 font-semibold">{displayNumber(doc)}</span>
        </p>
        <p className="min-w-0 truncate text-slate-400">
          <span className="text-slate-500">Date: </span>
          <span className="text-slate-200 font-semibold">{doc.date || '-'}</span>
        </p>
      </div>

      <div className="relative mt-4 grid grid-cols-2 gap-3">
        <Link
          to={`/documents/${doc._id}`}
          className="inline-flex items-center justify-center gap-2 rounded-xl border border-blue-300/18 bg-slate-950/32 px-3 py-3 text-[14.7px] font-bold text-slate-200 no-underline transition-all hover:border-blue-300/35 hover:bg-blue-500/10"
        >
          View Details
        </Link>
        {status === 'processed' ? (
          <button
            onClick={() => handleSave(doc._id)}
            className="inline-flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-emerald-600 to-emerald-500 px-3 py-3 text-[14.7px] font-black text-white shadow-[0_16px_38px_rgba(16,185,129,0.28)] transition-all hover:-translate-y-0.5 hover:shadow-[0_18px_48px_rgba(16,185,129,0.38)]"
          >
            Save
          </button>
        ) : (
          <span className="inline-flex cursor-not-allowed items-center justify-center rounded-xl border border-white/8 bg-white/[0.025] px-3 py-3 text-[14.7px] font-bold text-slate-600">
            Save
          </span>
        )}
      </div>
    </article>
  )
}
