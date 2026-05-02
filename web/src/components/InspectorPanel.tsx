import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";
import "./InspectorPanel.css";

export type ActivePanel =
  | {
      kind: "session";
      id: string;
      /** Optional event id to scroll to + highlight on open (#329).
       *  Used by Spotlight transcript-hit click-through. */
      focusEventId?: number;
      /** Optional query to pre-fill the in-transcript find bar (#332).
       *  When set together with focusEventId, the inspector opens with
       *  the bar already populated and the focused match highlighted
       *  inline alongside any other matches in the loaded window. */
      initialSearchQuery?: string;
    }
  | { kind: "artefact"; id: string };

interface Props {
  /** When non-null, the panel is open. When null, the chrome unmounts entirely. */
  active: ActivePanel | null;
  onClose: () => void;
  children: ReactNode;
}

export function InspectorPanel({ active, onClose, children }: Props) {
  useEffect(() => {
    if (!active) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, onClose]);

  if (!active) return null;

  return createPortal(
    <>
      <div
        className="inspector-backdrop open"
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      />
      <div className="inspector-panel open" role="dialog" aria-modal="true">
        {children}
      </div>
    </>,
    document.body,
  );
}
