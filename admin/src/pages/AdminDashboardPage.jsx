import { useEffect, useState } from 'react'
import api from '../utils/api'
import { useAdminAuth } from '../context/AdminAuthContext'
import Banner from '../components/Banner'

function StatCard({ label, value, accent = 'text-white' }) {
  return (
    <div className="rounded-[22px] border border-emerald-300/12 bg-slate-900/60 p-5">
      <div className="text-[11.6px] font-black uppercase tracking-wide text-slate-500">{label}</div>
      <div className={`mt-2 text-3xl font-black ${accent}`}>{value}</div>
    </div>
  )
}

function BreakdownRow({ label, value }) {
  return (
    <div className="flex items-center justify-between border-b border-white/5 py-2.5 last:border-0">
      <span className="text-[13.6px] text-slate-400">{label}</span>
      <span className="text-[13.6px] font-black text-white">{value}</span>
    </div>
  )
}

export default function AdminDashboardPage() {
  const { user } = useAdminAuth()
  const [telemetry, setTelemetry] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    api.get('/admin/telemetry')
      .then((res) => { if (!cancelled) setTelemetry(res.data) })
      .catch((err) => { if (!cancelled) setError(err.userMessage || 'Could not load telemetry.') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [])

  return (
    <main className="mx-auto max-w-[1200px] px-4 py-8 sm:px-6 lg:px-10">
      <h1 className="mb-1 text-3xl font-black tracking-tight text-white">Welcome, {user?.username}</h1>
      <p className="mb-6 text-[14.7px] text-slate-500">System-wide telemetry across every user.</p>

      <Banner error={error} />

      {loading ? (
        <div className="flex justify-center py-16">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-transparent border-t-emerald-400" />
        </div>
      ) : telemetry && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard label="Total users" value={telemetry.totalUsers} />
            <StatCard label="Total documents" value={telemetry.totalDocuments} />
            <StatCard label="Total exports" value={telemetry.totalExports} />
            <StatCard label="OCR failure rate" value={`${telemetry.ocrFailureRate}%`} accent={telemetry.ocrFailureRate > 10 ? 'text-rose-300' : 'text-emerald-300'} />
          </div>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <div className="rounded-[22px] border border-emerald-300/12 bg-slate-900/60 p-5">
              <h2 className="mb-3 text-[13.6px] font-black uppercase tracking-wide text-slate-500">Documents by status</h2>
              <BreakdownRow label="Processed" value={telemetry.documentsByStatus.processed} />
              <BreakdownRow label="Failed" value={telemetry.documentsByStatus.failed} />
              <BreakdownRow label="Uploaded" value={telemetry.documentsByStatus.uploaded} />
            </div>
            <div className="rounded-[22px] border border-emerald-300/12 bg-slate-900/60 p-5">
              <h2 className="mb-3 text-[13.6px] font-black uppercase tracking-wide text-slate-500">Documents by type</h2>
              <BreakdownRow label="Tax Invoice" value={telemetry.documentsByType['Tax Invoice']} />
              <BreakdownRow label="Delivery Challan" value={telemetry.documentsByType['Delivery Challan']} />
            </div>
            <div className="rounded-[22px] border border-emerald-300/12 bg-slate-900/60 p-5">
              <h2 className="mb-3 text-[13.6px] font-black uppercase tracking-wide text-slate-500">Recent activity</h2>
              <BreakdownRow label="Last 24 hours" value={telemetry.recentActivity.last24h} />
              <BreakdownRow label="Last 7 days" value={telemetry.recentActivity.last7d} />
            </div>
          </div>
        </div>
      )}
    </main>
  )
}
