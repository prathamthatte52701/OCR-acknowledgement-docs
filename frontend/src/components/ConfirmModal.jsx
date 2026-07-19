// Shared confirm-before-destructive-action modal - same backdrop/card styling
// as CorrectionModal, so it matches the rest of the app rather than the
// browser's native confirm() dialog.
export default function ConfirmModal({ title = 'Are you sure?', message, confirmLabel = 'Yes, Delete', onConfirm, onClose, busy = false }) {
  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-gray-900 border border-gray-700 rounded-xl shadow-2xl w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-gray-800">
          <h2 className="text-white font-semibold">{title}</h2>
        </div>

        <div className="p-5">
          <p className="text-gray-300 text-sm">{message}</p>
        </div>

        <div className="px-5 pb-5 flex gap-2 justify-end">
          <button
            onClick={onClose}
            disabled={busy}
            className="px-4 py-2 text-sm text-gray-400 hover:text-gray-200 bg-gray-800 hover:bg-gray-700 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={busy}
            className="px-4 py-2 text-sm text-white bg-red-700 hover:bg-red-600 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg transition-colors"
          >
            {busy ? 'Deleting...' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
