import { useState } from 'react'

const FIELDS = [
  { key: 'srNo', label: 'SR No' },
  { key: 'description', label: 'Description', required: true },
  { key: 'hsnSac', label: 'HSN/SAC' },
  { key: 'basic', label: 'Basic' },
  { key: 'quantity', label: 'Quantity' },
  { key: 'amount', label: 'Amount' },
]

export default function AddRowModal({ open, onSave, onClose }) {
  const [values, setValues] = useState({})
  const [saving, setSaving] = useState(false)

  if (!open) return null

  async function handleSave() {
    if (!values.description?.trim()) return
    setSaving(true)
    await onSave(values)
    setSaving(false)
    setValues({})
  }

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-gray-900 border border-gray-700 rounded-xl shadow-2xl w-full max-w-md">
        <div className="px-5 py-4 border-b border-gray-800 flex items-center justify-between">
          <h2 className="text-white font-semibold">Add Missing Row</h2>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300 transition-colors">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="p-5 space-y-3">
          <p className="text-gray-500 text-xs">Use this when an entire line item is missing from the table (not for correcting an existing row - use its Edit link for that).</p>
          {FIELDS.map(f => (
            <div key={f.key}>
              <label className="text-gray-500 text-xs mb-1 block">{f.label}{f.required && ' *'}</label>
              <input
                type="text"
                value={values[f.key] || ''}
                onChange={(e) => setValues(v => ({ ...v, [f.key]: e.target.value }))}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500 transition-colors"
                placeholder={f.label}
                autoFocus={f.key === 'description'}
              />
            </div>
          ))}
        </div>

        <div className="px-5 pb-5 flex gap-2 justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-gray-400 hover:text-gray-200 bg-gray-800 hover:bg-gray-700 rounded-lg transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving || !values.description?.trim()}
            className="px-4 py-2 text-sm text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg transition-colors"
          >
            {saving ? 'Adding...' : 'Add Row'}
          </button>
        </div>
      </div>
    </div>
  )
}
