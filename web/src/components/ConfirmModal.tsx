import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

interface Props {
  open: boolean;
  title: string;
  body?: React.ReactNode;
  confirmLabel?: string;
  /** Set to null to hide the cancel button (alert-mode, OK-only). */
  cancelLabel?: string | null;
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

// Minimal in-app replacement for window.confirm(). Promise-based usage
// (via a small wrapper in the caller) is fine, but this component is
// controlled — the caller owns the open state. ESC cancels, backdrop
// click cancels, Enter confirms. Autofocuses the confirm button so
// keyboard-only users can just press Enter for the common path.
export function ConfirmModal({
  open, title, body,
  confirmLabel = "OK", cancelLabel = "Cancel",
  destructive = false,
  onConfirm, onCancel,
}: Props) {
  const confirmBtnRef = useRef<HTMLButtonElement>(null);
  // Guards against rapid double-clicks queuing duplicate destructive ops
  // (uninstall, archive). First click sets submitting; subsequent clicks
  // are ignored until the caller closes the modal (which resets on next
  // open via the useEffect below).
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) {
      setSubmitting(false);
      return;
    }
    confirmBtnRef.current?.focus();
    // Only handle Escape here. Enter is handled implicitly by the focused
    // confirm button — if we also listened for Enter on window, a single
    // keypress would fire both this handler and the button's native click,
    // double-invoking onConfirm (spotted in review — would have caused
    // double-uninstall / double-archive).
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") { e.stopPropagation(); onCancel(); }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onCancel]);

  if (!open) return null;

  // Portal to document.body so the modal escapes any stacking context the
  // parent has created (e.g. the Desktop's chat-bar container). Without this
  // the z-index bump alone isn't enough if an ancestor has its own stacking
  // context.
  return createPortal(
    <div
      className="confirm-modal-overlay"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-modal-title"
    >
      <div className="confirm-modal-panel">
        <h2 id="confirm-modal-title" className="confirm-modal-title">{title}</h2>
        {body !== undefined && <div className="confirm-modal-body">{body}</div>}
        <div className="confirm-modal-actions">
          {cancelLabel !== null && (
            <button
              type="button"
              className="confirm-modal-btn confirm-modal-btn--cancel"
              onClick={onCancel}
            >
              {cancelLabel}
            </button>
          )}
          <button
            ref={confirmBtnRef}
            type="button"
            className={`confirm-modal-btn confirm-modal-btn--confirm${destructive ? " confirm-modal-btn--destructive" : ""}`}
            disabled={submitting}
            onClick={() => {
              if (submitting) return;
              setSubmitting(true);
              onConfirm();
            }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
