import { useRef, useMemo, useCallback, useState, useEffect, type PointerEvent as ReactPointerEvent } from "react";
import { WindowChrome } from "./WindowChrome";

interface ArtifactError {
  message: string;
  stack: string;
  console: Array<{ type: string; message: string; ts: number }>;
}

interface Props {
  title: string;
  path: string;
  defaultX: number;
  defaultY: number;
  zIndex: number;
  fullscreen: boolean;
  onFocus?: () => void;
  onClose: () => void;
  onToggleFullscreen: () => void;
  onNavigate?: (direction: -1 | 1) => void;
  hasPrev?: boolean;
  hasNext?: boolean;
  onFixError?: (error: { title: string; message: string; stack: string; console: Array<{ type: string; message: string }> }) => void;
}

function ErrorDetails({ stack, consoleEntries }: { stack: string; consoleEntries: Array<{ type: string; message: string }> }) {
  const [open, setOpen] = useState(false);
  if (!stack && consoleEntries.length === 0) return null;
  return (
    <div className="viewer-error-details">
      <button className="viewer-error-details-toggle" onClick={() => setOpen(!open)}>
        {open ? "Hide details" : "Show details"}
      </button>
      {open && (
        <pre className="viewer-error-stack">
          {stack}
          {consoleEntries.length > 0 && (
            "\n\nConsole:\n" + consoleEntries.map((e) => `[${e.type}] ${e.message}`).join("\n")
          )}
        </pre>
      )}
    </div>
  );
}

export function ViewerWindow({
  title,
  path,
  defaultX,
  defaultY,
  zIndex,
  fullscreen,
  onFocus,
  onClose,
  onToggleFullscreen,
  onNavigate,
  hasPrev = false,
  hasNext = false,
  onFixError,
}: Props) {
  const toolbarRef = useRef<HTMLDivElement>(null);
  const dragOffset = useRef({ x: 0, y: 0 });
  // Cache-bust URL once per path change, not on every re-render
  const iframeSrc = useMemo(() => `${path}?t=${Date.now()}`, [path, iframeKey]);

  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [error, setError] = useState<ArtifactError | null>(null);
  const [iframeKey, setIframeKey] = useState(0);

  useEffect(() => {
    function handleMessage(event: MessageEvent) {
      if (event.origin !== window.location.origin) return;
      if (event.source !== iframeRef.current?.contentWindow) return;
      if (event.data?.type !== "oyster-error") return;
      setError({
        message: event.data.error?.message || "Unknown error",
        stack: event.data.error?.stack || "",
        console: Array.isArray(event.data.console) ? event.data.console : [],
      });
    }
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, []);

  useEffect(() => {
    setError(null);
    setIframeKey((k) => k + 1);
  }, [path]);

  const handleRetry = useCallback(() => {
    setError(null);
    setIframeKey((k) => k + 1);
  }, []);

  const onPointerDown = useCallback((e: ReactPointerEvent) => {
    // Only drag from the toolbar background / title, not from buttons
    if ((e.target as HTMLElement).closest("button")) return;
    e.preventDefault();

    const el = toolbarRef.current!;
    const rect = el.getBoundingClientRect();
    dragOffset.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    el.setPointerCapture(e.pointerId);

    // Reset centered transform so absolute positioning works
    el.style.transform = "none";
    el.style.left = `${rect.left}px`;
    el.style.top = `${rect.top}px`;
  }, []);

  const onPointerMove = useCallback((e: ReactPointerEvent) => {
    const el = toolbarRef.current!;
    if (!el.hasPointerCapture(e.pointerId)) return;

    const x = e.clientX - dragOffset.current.x;
    const y = e.clientY - dragOffset.current.y;
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
  }, []);

  const onPointerUp = useCallback((e: ReactPointerEvent) => {
    const el = toolbarRef.current!;
    if (el.hasPointerCapture(e.pointerId)) {
      el.releasePointerCapture(e.pointerId);
    }
  }, []);

  return (
    <WindowChrome
      title={fullscreen ? "" : title}
      onFocus={onFocus}
      onClose={onClose}
      defaultX={defaultX}
      defaultY={defaultY}
      defaultW={640}
      defaultH={480}
      zIndex={zIndex}
      fullscreen={fullscreen}
      onToggleFullscreen={onToggleFullscreen}
    >
      {fullscreen && (
        <div
          ref={toolbarRef}
          className="fullscreen-toolbar"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
        >
          <button
            className="fullscreen-toolbar-btn"
            disabled={!hasPrev}
            onClick={() => onNavigate?.(-1)}
            title="Previous doc"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M15 18l-6-6 6-6" />
            </svg>
          </button>
          <span className="fullscreen-toolbar-title">{title}</span>
          <button
            className="fullscreen-toolbar-btn"
            disabled={!hasNext}
            onClick={() => onNavigate?.(1)}
            title="Next doc"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 18l6-6-6-6" />
            </svg>
          </button>
          <div className="fullscreen-toolbar-sep" />
          <button
            className="fullscreen-toolbar-btn"
            onClick={onToggleFullscreen}
            title="Exit fullscreen"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="4 14 10 14 10 20" />
              <polyline points="20 10 14 10 14 4" />
              <line x1="14" y1="10" x2="21" y2="3" />
              <line x1="3" y1="21" x2="10" y2="14" />
            </svg>
          </button>
          <button
            className="fullscreen-toolbar-btn fullscreen-toolbar-close"
            onClick={onClose}
            title="Close"
          >
            ×
          </button>
        </div>
      )}
      {error ? (
        <div className="viewer-error-screen">
          <div className="viewer-error-icon">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none">
              <circle cx="12" cy="12" r="10" fill="#3a1e1e" />
              <path d="M12 8v4m0 4h.01" stroke="#ef4444" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </div>
          <h3 className="viewer-error-title">This app ran into a problem</h3>
          <p className="viewer-error-message">{error.message}</p>
          <div className="viewer-error-actions">
            {onFixError && (
              <button className="viewer-error-fix"
                onClick={() => onFixError({ title, message: error.message, stack: error.stack, console: error.console })}>
                Ask Oyster to fix it
              </button>
            )}
            <button className="viewer-error-retry" onClick={handleRetry}>Retry</button>
          </div>
          <ErrorDetails stack={error.stack} consoleEntries={error.console} />
        </div>
      ) : (
        <iframe key={iframeKey} ref={iframeRef} src={iframeSrc} className="viewer-iframe" title={title} />
      )}
    </WindowChrome>
  );
}
