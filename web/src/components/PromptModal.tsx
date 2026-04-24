import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

interface Props {
  open: boolean;
  title: string;
  body?: React.ReactNode;
  initialValue?: string;
  placeholder?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}

// In-app replacement for window.prompt(). Same chrome as ConfirmModal
// (reuses .confirm-modal-* styles) plus a text input autofocused with its
// initial value pre-selected so the common "replace it all" case is one
// keystroke away.
export function PromptModal({
  open, title, body, initialValue = "", placeholder,
  confirmLabel = "OK", cancelLabel = "Cancel",
  onSubmit, onCancel,
}: Props) {
  const [value, setValue] = useState(initialValue);
  const inputRef = useRef<HTMLInputElement>(null);

  // Reset the field whenever the modal opens with a new default.
  useEffect(() => { if (open) setValue(initialValue); }, [open, initialValue]);

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    inputRef.current?.select();
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") { e.stopPropagation(); onCancel(); }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onCancel]);

  if (!open) return null;

  function submit() {
    onSubmit(value);
  }

  return createPortal(
    <div
      className="confirm-modal-overlay"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="prompt-modal-title"
    >
      <div className="confirm-modal-panel">
        <h2 id="prompt-modal-title" className="confirm-modal-title">{title}</h2>
        {body !== undefined && <div className="confirm-modal-body">{body}</div>}
        <input
          ref={inputRef}
          className="prompt-modal-input"
          type="text"
          value={value}
          placeholder={placeholder}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
          // Labelled by the modal title so screen readers announce e.g.
          // "Rename folder, edit text" instead of an unlabelled textbox.
          aria-labelledby="prompt-modal-title"
        />
        <div className="confirm-modal-actions">
          <button
            type="button"
            className="confirm-modal-btn confirm-modal-btn--cancel"
            onClick={onCancel}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            className="confirm-modal-btn confirm-modal-btn--confirm"
            onClick={submit}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
