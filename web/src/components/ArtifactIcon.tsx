import { useEffect, useRef, useState } from "react";
import type { Artifact, ArtifactKind } from "../data/artifacts-api";

// eslint-disable-next-line react-refresh/only-export-components
export const typeConfig: Record<
  ArtifactKind,
  { gradient: string; color: string; ext: string; icon: string }
> = {
  wireframe: {
    gradient: "linear-gradient(135deg, #2d2f52, #353764)",
    color: "#818cf8",
    ext: "wireframe",
    icon: "M3 3h18v18H3zM3 9h18M9 21V9",
  },
  deck: {
    gradient: "linear-gradient(135deg, #2d2f52, #353764)",
    color: "#a78bfa",
    ext: "deck",
    icon: "M2 3h20v14H2zM8 21h8M12 17v4",
  },
  map: {
    gradient: "linear-gradient(135deg, #1e3a2f, #243f34)",
    color: "#4ade80",
    ext: "map",
    icon: "M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5",
  },
  notes: {
    gradient: "linear-gradient(135deg, #1e3a2f, #243f34)",
    color: "#4ade80",
    ext: "notes",
    icon: "M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8zM14 2v6h6M16 13H8M16 17H8",
  },
  app: {
    gradient: "linear-gradient(135deg, #1e2d4a, #253a5c)",
    color: "#60a5fa",
    ext: "app",
    icon: "M16 18l6-6-6-6M8 6l-6 6 6 6",
  },
  diagram: {
    gradient: "linear-gradient(135deg, #3a2d1e, #4a3a24)",
    color: "#fbbf24",
    ext: "diagram",
    icon: "M12 3v18M3 12h18M5.6 5.6l12.8 12.8M18.4 5.6L5.6 18.4",
  },
  table: {
    gradient: "linear-gradient(135deg, #1e3a3a, #244a4a)",
    color: "#22d3ee",
    ext: "table",
    icon: "M3 3h18v18H3zM3 9h18M3 15h18M9 3v18M15 3v18",
  },
};

interface Props {
  artifact: Artifact;
  index: number;
  onClick: () => void;
  onStop?: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  reveal?: boolean;
  isRenaming?: boolean;
  onRenameCommit?: (label: string) => void;
  onRenameCancel?: () => void;
}

export function ArtifactIcon({ artifact, index, onClick, onStop, onContextMenu, reveal, isRenaming, onRenameCommit, onRenameCancel }: Props) {
  const config = typeConfig[artifact.artifactKind] || typeConfig.app;
  // Only show status indicators for managed apps (local_process runtime)
  const isManagedApp = artifact.runtimeKind === "local_process";

  // If the generated icon URL 404s (stale ref, mid-write race, or cache
  // mismatch in incognito), fall back to the kind glyph rather than showing
  // the browser's broken-image placeholder.
  const [iconFailed, setIconFailed] = useState(false);
  const iconRetryCountRef = useRef(0);

  // Clear on URL change OR iconStatus transition (e.g. regenerate → ready),
  // and reset the retry budget for the new icon lifecycle.
  useEffect(() => {
    iconRetryCountRef.current = 0;
    setIconFailed(false);
  }, [artifact.icon, artifact.iconStatus]);

  // Auto-retry after a short delay so a transient 404 (e.g. during
  // regenerate_icon, where the old file is unlinked before the new one
  // is written) recovers without requiring a full URL change. Bounded so
  // a permanently-missing icon can't spin in an infinite retry loop
  // burning network requests.
  const MAX_ICON_RETRIES = 3;
  useEffect(() => {
    if (!iconFailed || !artifact.icon) return;
    if (iconRetryCountRef.current >= MAX_ICON_RETRIES) return;
    const timer = window.setTimeout(() => {
      iconRetryCountRef.current += 1;
      setIconFailed(false);
    }, 1500);
    return () => window.clearTimeout(timer);
  }, [artifact.icon, iconFailed]);

  const inputRef = useRef<HTMLInputElement>(null);
  // Guard against the double-commit race: Enter or Esc call commit/cancel
  // directly, but then the state flip unmounts the <input> which fires blur,
  // which would call commit a second time. For Esc that undoes the cancel
  // entirely (the rename still happens). Track "already handled" in a ref
  // and skip the blur-triggered commit when set.
  const keyHandledRef = useRef(false);
  useEffect(() => {
    if (isRenaming) {
      keyHandledRef.current = false;
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [isRenaming]);

  return (
    <button
      className={`artifact-icon ${artifact.status === "generating" ? "generating" : ""} ${reveal ? "reveal" : ""}`}
      style={{
        animationDelay: `${index * 0.05 + 0.05}s`,
        ...(artifact.status === "generating" ? { pointerEvents: "none" as const } : {}),
      }}
      onClick={isRenaming ? (e) => e.preventDefault() : onClick}
      onContextMenu={onContextMenu}
    >
      <div className={`icon-thumb ${artifact.icon && !iconFailed ? "icon-thumb-ai" : ""}`} style={artifact.icon && !iconFailed ? undefined : { background: config.gradient }}>
        {artifact.icon && !iconFailed ? (
          <img
            src={artifact.icon}
            alt={artifact.label}
            className="icon-img"
            loading="lazy"
            onError={() => setIconFailed(true)}
          />
        ) : (
          <>
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke={config.color}
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d={config.icon} />
            </svg>
            <span className="file-ext">{config.ext}</span>
          </>
        )}

        {isManagedApp && (
          <span
            className={`status-dot ${artifact.status === "online" ? "online" : artifact.status === "starting" ? "starting" : "offline"}`}
          />
        )}

        {isManagedApp && artifact.status === "online" && onStop && (
          <span
            className="stop-btn"
            onClick={(e) => {
              e.stopPropagation();
              onStop();
            }}
          >
            &times;
          </span>
        )}
      </div>
      {isRenaming ? (
        <input
          ref={inputRef}
          className="icon-label-input"
          defaultValue={artifact.label}
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              keyHandledRef.current = true;
              onRenameCommit?.(e.currentTarget.value);
            } else if (e.key === "Escape") {
              e.preventDefault();
              keyHandledRef.current = true;
              onRenameCancel?.();
            }
          }}
          onBlur={(e) => {
            if (keyHandledRef.current) return;
            onRenameCommit?.(e.currentTarget.value);
          }}
        />
      ) : (
        <span className="icon-label">{artifact.label}</span>
      )}
    </button>
  );
}
