import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

interface Props {
  spaceId: string;
  spaceName: string;
  /** Anchor — the menu is portaled to body and pinned below this rect. */
  anchorRect: DOMRect;
  onClose: () => void;
  onRename: (spaceId: string, newName: string) => void | Promise<void>;
  /** Delete is a destructive flow — the parent owns the confirm modal. */
  onRequestDelete: (spaceId: string) => void;
}

type Mode = "menu" | "rename";

export function SpaceContextMenu({ spaceId, spaceName, anchorRect, onClose, onRename, onRequestDelete }: Props) {
  const [mode, setMode] = useState<Mode>("menu");
  const [renameValue, setRenameValue] = useState(spaceName);
  const ref = useRef<HTMLDivElement>(null);
  const renameRef = useRef<HTMLInputElement>(null);

  // Reset rename buffer + mode when the parent reopens the menu for a
  // different space without unmounting (React reuses the instance because
  // the JSX position is identical). Without this, "Rename" on Tokinvest
  // would prefill with Blunderfixer's name.
  useEffect(() => {
    setRenameValue(spaceName);
    setMode("menu");
  }, [spaceId, spaceName]);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("mousedown", handleClick);
    window.addEventListener("keydown", handleKey);
    return () => {
      window.removeEventListener("mousedown", handleClick);
      window.removeEventListener("keydown", handleKey);
    };
  }, [onClose]);

  useEffect(() => {
    if (mode === "rename") renameRef.current?.focus();
  }, [mode]);

  function submitRename(e?: React.FormEvent) {
    e?.preventDefault();
    const next = renameValue.trim();
    if (next && next !== spaceName) onRename(spaceId, next);
    onClose();
  }

  return createPortal(
    <div
      ref={ref}
      className="space-ctx-menu"
      style={{ left: anchorRect.left + anchorRect.width / 2, top: anchorRect.bottom }}
    >
      {mode === "menu" && (
        <>
          <button className="space-ctx-item" onClick={() => setMode("rename")}>
            Rename
          </button>
          <div className="space-ctx-sep" />
          <button
            className="space-ctx-item space-ctx-delete"
            onClick={() => { onRequestDelete(spaceId); onClose(); }}
          >
            Delete
          </button>
        </>
      )}
      {mode === "rename" && (
        <form onSubmit={submitRename} style={{ padding: 6 }}>
          <input
            ref={renameRef}
            className="space-pill-rename"
            style={{ width: 140 }}
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onBlur={submitRename}
            onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); onClose(); } }}
          />
        </form>
      )}
    </div>,
    document.body,
  );
}
