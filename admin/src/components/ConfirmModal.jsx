import Modal from './Modal'

// Shared confirm-before-destructive-action modal - built on the same Modal
// wrapper as EditUserModal/EditDocumentModal, so it matches the rest of the
// admin app instead of the browser's native confirm() dialog. Mount inside
// an <AnimatePresence> in the parent, same as every other Modal user here.
export default function ConfirmModal({ title = 'Are you sure?', message, confirmLabel = 'Yes, Delete', onConfirm, onClose, busy = false }) {
  return (
    <Modal onClose={onClose}>
      <h2 className="mb-2 text-lg font-black text-white">{title}</h2>
      <p className="mb-5 text-[14.7px] text-slate-400">{message}</p>
      <div className="flex gap-3">
        <button
          type="button"
          onClick={onConfirm}
          disabled={busy}
          className="rounded-xl bg-gradient-to-r from-rose-600 to-red-500 px-4 py-2.5 text-[14.7px] font-black text-white transition-all disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? 'Deleting...' : confirmLabel}
        </button>
        <button
          type="button"
          onClick={onClose}
          disabled={busy}
          className="rounded-xl border border-white/10 bg-white/[0.035] px-4 py-2.5 text-[14.7px] font-bold text-slate-300 hover:border-white/20 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Cancel
        </button>
      </div>
    </Modal>
  )
}
