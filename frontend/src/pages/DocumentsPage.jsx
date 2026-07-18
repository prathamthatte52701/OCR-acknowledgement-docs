import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import api from '../utils/api'
import DocumentList from '../components/DocumentList'

function DocumentsSkeleton() {
  return (
    <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
      {[0, 1, 2, 3, 4, 5].map(i => (
        <div key={i} className="h-[250px] animate-pulse rounded-3xl border border-blue-300/10 bg-slate-900/60 p-5">
          <div className="flex gap-4">
            <div className="h-20 w-20 rounded-2xl bg-blue-500/10" />
            <div className="flex-1 space-y-3">
              <div className="h-4 w-2/3 rounded-full bg-slate-700/70" />
              <div className="h-3 w-4/5 rounded-full bg-slate-800" />
              <div className="h-3 w-1/2 rounded-full bg-slate-800" />
            </div>
          </div>
          <div className="mt-6 grid grid-cols-2 gap-3">
            <div className="h-9 rounded-xl bg-slate-800/70" />
            <div className="h-9 rounded-xl bg-slate-800/70" />
          </div>
          <div className="mt-4 h-10 rounded-xl bg-slate-800/70" />
        </div>
      ))}
    </div>
  )
}

function DocumentsError({ message, onRetry }) {
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

const PAGE_SIZE = 30

export default function DocumentsPage() {
  const [documents, setDocuments] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [page, setPage] = useState(1)
  const [totalPages, setTotalPages] = useState(1)
  const [totalDocuments, setTotalDocuments] = useState(0)

  async function fetchDocuments(pageToLoad = page) {
    setLoading(true)
    setError('')
    try {
      const res = await api.get('/documents', { params: { page: pageToLoad, limit: PAGE_SIZE } })
      setDocuments(res.data?.documents || [])
      setTotalPages(res.data?.totalPages || 1)
      setTotalDocuments(res.data?.totalDocuments || 0)
    } catch (err) {
      setError(err.userMessage || 'Could not load your documents. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    let cancelled = false

    api.get('/documents', { params: { page, limit: PAGE_SIZE } })
      .then(res => {
        if (cancelled) return
        setDocuments(res.data?.documents || [])
        setTotalPages(res.data?.totalPages || 1)
        setTotalDocuments(res.data?.totalDocuments || 0)
      })
      .catch(err => {
        if (!cancelled) setError(err.userMessage || 'Could not load your documents. Please try again.')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => { cancelled = true }
  }, [page])

  return (
    <div className="relative min-h-full overflow-hidden bg-[#020817]">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_18%_4%,rgba(37,99,235,0.16),transparent_28%),radial-gradient(circle_at_82%_12%,rgba(6,182,212,0.12),transparent_25%),linear-gradient(180deg,rgba(15,23,42,0.12),rgba(2,6,23,0.98))]" />
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(rgba(96,165,250,0.16)_1px,transparent_1px)] bg-[size:22px_22px] opacity-25" />

      <main className="relative mx-auto max-w-[1440px] px-4 py-8 sm:px-6 lg:px-10 lg:py-10">
        <div className="mb-7 flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="text-3xl font-black tracking-[-0.03em] text-white sm:text-4xl">My Documents</h1>
            <p className="mt-2 flex items-center gap-2 text-[14.7px] font-medium text-slate-500">
              <span className="h-2 w-2 rounded-full bg-blue-400 shadow-[0_0_16px_rgba(96,165,250,0.85)]" />
              {loading ? 'Loading documents...' : `${totalDocuments} document${totalDocuments !== 1 ? 's' : ''}`}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <button
              onClick={async () => {
                const filename = window.prompt('Name for the new Excel export file:')
                if (!filename || !filename.trim()) return
                try {
                  await api.post('/documents/new-excel-file', { filename: filename.trim() })
                  alert(`New workbook "${filename.trim()}.xlsx" is ready. Future saves will go into this file.`)
                } catch (err) {
                  alert(err.userMessage || 'Could not start a new Excel file. Please try again.')
                }
              }}
              className="inline-flex items-center justify-center gap-2 rounded-2xl border border-blue-300/20 bg-slate-900/60 px-5 py-3 text-[14.7px] font-bold text-blue-200 transition-all hover:border-blue-300/45 hover:bg-blue-500/10"
            >
              Start New Excel File
            </button>
            <Link
              to="/upload"
              className="inline-flex items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-blue-600 to-blue-500 px-5 py-3 text-[14.7px] font-black text-white no-underline shadow-[0_18px_45px_rgba(37,99,235,0.34)] transition-all hover:-translate-y-0.5 hover:shadow-[0_22px_60px_rgba(37,99,235,0.45)] focus:outline-none focus:ring-2 focus:ring-blue-300/60"
            >
              <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                <path d="M12 16V4" />
                <path d="M7 9l5-5 5 5" />
                <path d="M20 16v3a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-3" />
              </svg>
              Upload New
            </Link>
          </div>
        </div>

        {loading ? (
          <DocumentsSkeleton />
        ) : error ? (
          <DocumentsError message={error} onRetry={() => fetchDocuments(page)} />
        ) : (
          <>
            <DocumentList documents={documents} />
            {totalPages > 1 && (
              <div className="mt-8 flex items-center justify-center gap-4">
                <button
                  onClick={() => setPage(p => Math.max(1, p - 1))}
                  disabled={page <= 1}
                  className="inline-flex items-center justify-center rounded-2xl border border-white/10 bg-white/[0.045] px-5 py-3 text-[14.7px] font-bold text-slate-200 transition-colors hover:border-blue-300/30 hover:bg-blue-500/10 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-white/10 disabled:hover:bg-white/[0.045]"
                >
                  Previous
                </button>
                <span className="text-[14.7px] font-bold text-slate-400">
                  Page {page} of {totalPages}
                </span>
                <button
                  onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                  disabled={page >= totalPages}
                  className="inline-flex items-center justify-center rounded-2xl border border-white/10 bg-white/[0.045] px-5 py-3 text-[14.7px] font-bold text-slate-200 transition-colors hover:border-blue-300/30 hover:bg-blue-500/10 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-white/10 disabled:hover:bg-white/[0.045]"
                >
                  Next
                </button>
              </div>
            )}
          </>
        )}
      </main>
    </div>
  )
}
