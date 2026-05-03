import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FolderPlus } from "lucide-react";
import type { Space } from "../../../../shared/types";
import { bestMatchSpace } from "./match-space";
import { homeRelative } from "./utils";

interface Props {
  /** Absolute folder path of the orphan tile. */
  path: string;
  /** Anchor — popover is portaled to body and pinned near this rect. */
  anchorRect: DOMRect;
  /** Spaces eligible to receive the folder. Caller filters out meta IDs. */
  spaces: Space[];
  onClose: () => void;
  /** Pick an existing space. Resolves on success, rejects with a user-facing message. */
  onPickSpace: (spaceId: string) => Promise<void>;
  /** Promote to a brand-new space (existing FolderPlus behaviour). */
  onPromoteToNew: () => Promise<void>;
}

const PAD = 8;
const POPOVER_W = 240;

function basename(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, "");
  const i = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return i >= 0 ? trimmed.slice(i + 1) : trimmed;
}

export function AttachOrphanPopover({ path, anchorRect, spaces, onClose, onPickSpace, onPromoteToNew }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>({
    left: anchorRect.right - POPOVER_W,
    top: anchorRect.bottom + 4,
  });

  // Viewport-aware flip: align right edge of popover to the button's right
  // edge by default; if the popover would overflow on the left, snap to
  // the button's left edge; if it would overflow on the bottom, flip above.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    let left = anchorRect.right - r.width;
    let top = anchorRect.bottom + 4;
    if (left < PAD) left = Math.min(anchorRect.left, window.innerWidth - r.width - PAD);
    if (left + r.width > window.innerWidth - PAD) left = window.innerWidth - r.width - PAD;
    if (top + r.height > window.innerHeight - PAD) top = anchorRect.top - r.height - 4;
    if (top < PAD) top = PAD;
    setPos({ left, top });
  }, [anchorRect]);

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

  const folderName = basename(path);
  const best = bestMatchSpace(folderName, spaces);
  const others = spaces
    .filter((s) => s.id !== best?.id)
    .slice()
    .sort((a, b) => a.displayName.localeCompare(b.displayName));

  async function run(key: string, fn: () => Promise<void>) {
    if (pending) return;
    setPending(key);
    setError(null);
    try {
      await fn();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't attach folder");
      setPending(null);
    }
  }

  return createPortal(
    <div
      ref={ref}
      className="attach-orphan-popover"
      style={{ left: pos.left, top: pos.top, width: POPOVER_W }}
      role="dialog"
      aria-label={`Attach ${folderName}`}
    >
      <div className="attach-orphan-header" title={path}>
        Attach <span className="attach-orphan-header-path">{homeRelative(path)}</span> to
      </div>
      {best && (
        <>
          <button
            type="button"
            className="attach-orphan-row"
            disabled={Boolean(pending)}
            aria-busy={pending === best.id}
            onClick={() => run(best.id, () => onPickSpace(best.id))}
          >
            <SpaceDot color={best.color} />
            <span className="attach-orphan-row-label">{best.displayName}</span>
            <span className="attach-orphan-row-hint">Best match</span>
          </button>
          <div className="attach-orphan-sep" />
        </>
      )}
      {others.length > 0 && (
        <div className="attach-orphan-list">
          {others.map((s) => (
            <button
              key={s.id}
              type="button"
              className="attach-orphan-row"
              disabled={Boolean(pending)}
              aria-busy={pending === s.id}
              onClick={() => run(s.id, () => onPickSpace(s.id))}
            >
              <SpaceDot color={s.color} />
              <span className="attach-orphan-row-label">{s.displayName}</span>
            </button>
          ))}
        </div>
      )}
      {(best || others.length > 0) && <div className="attach-orphan-sep" />}
      <button
        type="button"
        className="attach-orphan-row attach-orphan-row--new"
        disabled={Boolean(pending)}
        aria-busy={pending === "__new__"}
        onClick={() => run("__new__", onPromoteToNew)}
      >
        <FolderPlus size={14} strokeWidth={2} aria-hidden="true" />
        <span className="attach-orphan-row-label">New space</span>
      </button>
      {error && <div className="attach-orphan-error" title={error}>{error}</div>}
      {!best && others.length === 0 && (
        <div className="attach-orphan-hint">No spaces yet — promote this folder to start one.</div>
      )}
    </div>,
    document.body,
  );
}

function SpaceDot({ color }: { color: string | null }) {
  return (
    <span
      className="attach-orphan-dot"
      style={{ background: color ?? "var(--fg-dim, #888)" }}
      aria-hidden="true"
    />
  );
}
