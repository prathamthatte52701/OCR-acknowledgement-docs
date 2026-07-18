import { useState, useEffect } from 'react'
import api, { downloadWorkbook } from '../utils/api'
import LoadingState from '../components/LoadingState'

function formatExportedAt(dateStr) {
  if (!dateStr) return '-'
  return new Date(dateStr).toLocaleString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}

// Same "which number to show" logic used by DocumentCard/DocumentDetailPage -
// Tax Invoice combines its two number fields, Delivery Challan has just one.
function displayNumber(row) {
  if (row.documentType === 'Tax Invoice') {
    return [row.taxInvoiceNo, row.referenceNo].filter(Boolean).join(' / ') || '-'
  }
  return row.number || '-'
}

function HistoryError({ message, onRetry }) {
  return (
    <div className="rounded-[28px] border border-rose-400/25 bg-rose-500/10 p-8 text-center shadow-[0_24px_80px_rgba(127,29,29,0.16)]">
      <div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl border border-rose-300/25 bg-rose-400/10 text-[14.7px] font-black text-rose-200">ERR</div>
      <p className="mt-4 text-lg font-black text-white">{message}</p>
      <button
        onClick={onRetry}
        className="mt-5 rounded-2xl border border-white/10 bg-white/[0.045] px-5 py-3 text-[14.7px] font-bold text-slate-200 transition-colors hover:border-rose-300/30 hover:bg-rose-500/10"
      >
        Try Again
      </button>
    </div>
  )
}

function EmptyHistory() {
  return (
    <div className="rounded-[30px] border border-blue-300/12 bg-slate-900/62 p-10 text-center shadow-[0_28px_100px_rgba(2,8,23,0.35)] backdrop-blur-xl">
      <div className="mx-auto grid h-16 w-16 place-items-center rounded-2xl border border-blue-300/18 bg-blue-500/10 text-[14.7px] font-black text-blue-200 shadow-[0_0_42px_rgba(37,99,235,0.2)]">XL</div>
      <h2 className="mt-5 text-2xl font-black text-white">No exports yet</h2>
      <p className="mx-auto mt-2 max-w-md text-[14.7px] leading-6 text-slate-500">
        Save a processed document to Excel from its detail page to see it show up here.
      </p>
    </div>
  )
}

export default function ExportHistoryPage() {
  const [exports, setExports] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [downloadingId, setDownloadingId] = useState(null)

  async function fetchHistory() {
    setLoading(true)
    setError('')
    try {
      const res = await api.get('/documents/export-history')
      setExports(res.data?.exports || [])
    } catch (err) {
      setError(err.userMessage || 'Could not load export history. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    let cancelled = false
    api.get('/documents/export-history')
      .then(res => { if (!cancelled) setExports(res.data?.exports || []) })
      .catch(err => { if (!cancelled) setError(err.userMessage || 'Could not load export history. Please try again.') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [])

  async function handleDownload(row) {
    if (!row.workbookId?._id) return
    setDownloadingId(row._id)
    try {
      await downloadWorkbook({ workbookId: row.workbookId._id })
    } catch (err) {
      alert(err.userMessage || 'Could not download the Excel workbook. Please try again.')
    } finally {
      setDownloadingId(null)
    }
  }

  return (
    <div className="relative min-h-full overflow-hidden bg-[#020817]">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_18%_4%,rgba(37,99,235,0.16),transparent_28%),radial-gradient(circle_at_82%_12%,rgba(6,182,212,0.12),transparent_25%),linear-gradient(180deg,rgba(15,23,42,0.12),rgba(2,6,23,0.98))]" />
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(rgba(96,165,250,0.16)_1px,transparent_1px)] bg-[size:22px_22px] opacity-25" />

      <main className="relative mx-auto max-w-[1440px] px-4 py-8 sm:px-6 lg:px-10 lg:py-10">
        <div className="mb-7">
          <h1 className="text-3xl font-black tracking-[-0.03em] text-white sm:text-4xl">Export History</h1>
          <p className="mt-2 flex items-center gap-2 text-[14.7px] font-medium text-slate-500">
            <span className="h-2 w-2 rounded-full bg-blue-400 shadow-[0_0_16px_rgba(96,165,250,0.85)]" />
            {loading ? 'Loading export history...' : `${exports.length} export${exports.length !== 1 ? 's' : ''}`}
          </p>
        </div>

        {loading ? (
          <div className="rounded-[28px] border border-blue-300/12 bg-slate-900/68 shadow-2xl shadow-slate-950/30 backdrop-blur-xl">
            <LoadingState message="Loading export history..." />
          </div>
        ) : error ? (
          <HistoryError message={error} onRetry={fetchHistory} />
        ) : exports.length === 0 ? (
          <EmptyHistory />
        ) : (
          <div className="overflow-hidden rounded-3xl border border-blue-300/12 bg-slate-900/64 shadow-[0_24px_90px_rgba(2,8,23,0.34)] backdrop-blur-xl">
            <div className="overflow-x-auto" style={{ WebkitOverflowScrolling: 'touch' }}>
              <table className="min-w-full text-[14.7px]">
                <thead>
                  <tr className="border-b border-blue-300/12 bg-white/[0.02]">
                    <th className="px-4 py-3 text-left font-bold text-slate-400">Document Type</th>
                    <th className="px-4 py-3 text-left font-bold text-slate-400">Number</th>
                    <th className="px-4 py-3 text-left font-bold text-slate-400">Date</th>
                    <th className="px-4 py-3 text-left font-bold text-slate-400">Exported At</th>
                    <th className="px-4 py-3 text-left font-bold text-slate-400">Workbook</th>
                    <th className="px-4 py-3 text-right font-bold text-slate-400">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {exports.map(row => (
                    <tr key={row._id} className="border-b border-white/8 last:border-b-0 hover:bg-white/[0.02]">
                      <td className="whitespace-nowrap px-4 py-3 font-semibold text-slate-200">{row.documentType}</td>
                      <td className="whitespace-nowrap px-4 py-3 text-slate-300">{displayNumber(row)}</td>
                      <td className="whitespace-nowrap px-4 py-3 text-slate-300">{row.date || '-'}</td>
                      <td className="whitespace-nowrap px-4 py-3 text-slate-400">{formatExportedAt(row.exportedAt)}</td>
                      <td className="whitespace-nowrap px-4 py-3 text-slate-300">
                        {row.workbookId?.filename || <span className="text-slate-600">Unknown</span>}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-right">
                        <button
                          onClick={() => handleDownload(row)}
                          disabled={!row.workbookId?._id || downloadingId === row._id}
                          className="inline-flex items-center justify-center rounded-xl border border-blue-300/18 bg-slate-950/32 px-3 py-1.5 text-[12.6px] font-bold text-blue-200 transition-all hover:border-blue-300/35 hover:bg-blue-500/10 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          {downloadingId === row._id ? 'Downloading...' : 'Download Excel'}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </main>
    </div>
  )
}
