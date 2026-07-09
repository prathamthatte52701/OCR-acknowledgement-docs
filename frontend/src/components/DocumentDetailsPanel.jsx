import SummaryCard from './SummaryCard'
import ExtractedFieldsTable from './ExtractedFieldsTable'
import ExtractedTablesView from './ExtractedTablesView'

const DETAIL_VIEWS = [
  { id: 'summary', label: 'Full Summary' },
  { id: 'about', label: 'About' },
  { id: 'consignee', label: 'Consignee Details' },
  { id: 'consigner', label: 'Consigner Details' },
  { id: 'items', label: 'Uncoded RGP' },
  { id: 'taxes', label: 'Taxes' },
]

function formatDateTime(dateStr) {
  if (!dateStr) return '-'
  return new Date(dateStr).toLocaleString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}

function formatSize(bytes) {
  if (!bytes) return '-'
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

function AboutView({ doc }) {
  const rows = [
    ['Document Name', doc.autoName],
    ['Original Filename', doc.originalFilename],
    ['Document Type', doc.documentType || 'Delivery Challan'],
    ['File Type', doc.mimeType],
    ['File Size', formatSize(doc.size)],
    ['Status', doc.uploadStatus],
    ['Uploaded On', formatDateTime(doc.createdAt)],
    ['Processed On', formatDateTime(doc.processedAt || doc.reprocessedAt)],
  ]
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
      <h3 className="text-gray-300 font-semibold mb-3">About This Document</h3>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {rows.map(([label, value]) => (
          <div key={label}>
            <p className="text-gray-600 text-[11.6px] mb-0.5">{label}</p>
            <p className="text-gray-200 text-[13.6px] break-words">{value || '-'}</p>
          </div>
        ))}
      </div>
    </div>
  )
}

// "Consignee Details" also includes challan-level metadata (Invoice No, FI Doc,
// Date, Reason) and "Consigner Details" includes PO/Request/IRN No, matching how
// the user wants these two buttons grouped - not a strict party-only split.
const CONSIGNEE_EXTRA_KEYS = ['invoice_no', 'fi_doc', 'challan_date', 'reason']
const CONSIGNER_EXTRA_KEYS = ['po_no', 'request_no', 'irn_no']

function filterFields(fields, prefix, extraKeys) {
  return (fields || []).filter(f =>
    f.normalizedKey?.startsWith(prefix) || extraKeys.includes(f.normalizedKey)
  )
}

// Renders the content for one detail view. Always reads live from `doc`, so
// every appended chat entry (past or present) reflects the current field
// values - there's no separate stale snapshot to fall out of sync.
export function DetailView({ type, doc, onCorrect }) {
  if (!doc) return null
  const fields = doc.extractedFields || []

  if (type === 'summary') {
    return (
      <SummaryCard
        fullSummary={doc.fullSummary}
        summaryPoints={doc.summaryPoints}
        fields={fields}
        onCorrect={onCorrect}
      />
    )
  }
  if (type === 'about') return <AboutView doc={doc} />
  if (type === 'consignee') {
    return <ExtractedFieldsTable fields={filterFields(fields, 'consignee_', CONSIGNEE_EXTRA_KEYS)} onCorrect={onCorrect} />
  }
  if (type === 'consigner') {
    return <ExtractedFieldsTable fields={filterFields(fields, 'consignor_', CONSIGNER_EXTRA_KEYS)} onCorrect={onCorrect} />
  }
  if (type === 'items') {
    const itemsAndTaxTables = (doc.extractedTables || []).filter(t => t.title === 'Line Items' || t.title === 'Totals')
    return <ExtractedTablesView tables={itemsAndTaxTables} fields={fields} onCorrect={onCorrect} />
  }
  if (type === 'taxes') {
    const taxTables = (doc.extractedTables || []).filter(t => t.title === 'Totals')
    return <ExtractedTablesView tables={taxTables} fields={fields} onCorrect={onCorrect} />
  }
  return null
}

// Button row only - clicking a button no longer toggles content inline here;
// the parent appends the result to the chat history instead (see onSelect).
export default function DocumentDetailsPanel({ doc, onSelect }) {
  if (!doc || doc.uploadStatus !== 'processed') return null

  return (
    <div className="border-t border-blue-300/12 bg-slate-950/68">
      <div className="flex flex-wrap gap-2 px-4 py-3">
        {DETAIL_VIEWS.map(v => (
          <button
            key={v.id}
            type="button"
            onClick={() => onSelect(v.id, v.label)}
            className="inline-flex shrink-0 items-center gap-2 rounded-full border border-blue-300/14 bg-slate-900/70 px-3 py-2 text-[12.6px] font-semibold text-blue-100/75 transition-all hover:border-blue-300/38 hover:bg-blue-500/10 hover:text-blue-100"
          >
            {v.label}
          </button>
        ))}
      </div>
    </div>
  )
}
