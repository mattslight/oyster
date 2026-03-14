import { useRef, useMemo, useCallback, useState, useEffect, type PointerEvent as ReactPointerEvent } from "react";
import { WindowChrome } from "./WindowChrome";
import { subscribeToEvents } from "../data/chat-api";

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
  onFixError?: (error: { title: string; message: string; stack: string; console: Array<{ type: string; message: string }> }) => Promise<string>;
}

const toolLabels: Record<string, string> = {
  read: "Reading",
  edit: "Editing",
  write: "Writing",
  bash: "Running command",
  glob: "Searching files",
  grep: "Searching code",
};

function extractToolHint(part: Record<string, unknown>): string | null {
  const state = part.state as Record<string, unknown> | undefined;
  if (!state) return null;
  const input = state.input as Record<string, unknown> | undefined;
  if (!input) return null;
  const filePath = (input.file_path || input.path) as string | undefined;
  if (filePath && typeof filePath === "string") {
    const name = filePath.split("/").pop() || null;
    if (name && name.length > 40) return name.slice(0, 37) + "...";
    return name;
  }
  const pattern = input.pattern as string | undefined;
  if (pattern) return pattern.length > 30 ? pattern.slice(0, 27) + "..." : pattern;
  return null;
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

type FixPhase = "idle" | "fixing" | "done";

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
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [error, setError] = useState<ArtifactError | null>(null);
  const [iframeKey, setIframeKey] = useState(0);
  const [fixPhase, setFixPhase] = useState<FixPhase>("idle");
  const [fixStatus, setFixStatus] = useState("Sending to Oyster...");
  const unsubRef = useRef<(() => void) | null>(null);
  const iframeSrc = useMemo(() => `${path}?t=${Date.now()}`, [path, iframeKey]);

  // Listen for iframe errors via postMessage
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

  // Reset on path change
  useEffect(() => {
    unsubRef.current?.();
    unsubRef.current = null;
    setError(null);
    setFixPhase("idle");
    setFixStatus("");
    setIframeKey((k) => k + 1);
  }, [path]);

  // Clean up SSE subscription on unmount
  useEffect(() => {
    return () => { unsubRef.current?.(); };
  }, []);

  // Auto-retry after fix completes
  useEffect(() => {
    if (fixPhase !== "done") return;
    const timer = setTimeout(() => {
      setError(null);
      setFixPhase("idle");
      setFixStatus("");
      setIframeKey((k) => k + 1);
    }, 1200);
    return () => clearTimeout(timer);
  }, [fixPhase]);

  const handleRetry = useCallback(() => {
    unsubRef.current?.();
    unsubRef.current = null;
    setError(null);
    setFixPhase("idle");
    setFixStatus("");
    setIframeKey((k) => k + 1);
  }, []);

  const handleFix = useCallback(async () => {
    if (!onFixError || !error) return;
    setFixPhase("fixing");
    setFixStatus("Sending to Oyster...");

    // Subscribe to SSE BEFORE sending the message so we don't miss events
    let seenBusy = false;
    let targetSessionId: string | null = null;

    unsubRef.current?.();
    unsubRef.current = subscribeToEvents((event) => {
      const props = event.properties;
      const eventSessionId =
        (props.sessionID as string) ||
        (props.info as { sessionID?: string })?.sessionID ||
        (props.part as { sessionID?: string })?.sessionID;

      // Filter to our session once we know it; accept tool events from sub-agents
      if (targetSessionId && eventSessionId !== targetSessionId) {
        const isToolEvent = event.type === "message.part.updated" &&
          (props.part as { type?: string })?.type === "tool";
        if (!isToolEvent) return;
      }

      switch (event.type) {
        case "session.status": {
          const status = props.status as { type: string };
          if (status.type === "busy") {
            seenBusy = true;
            setFixStatus("Oyster is thinking...");
          } else if (status.type === "idle" && seenBusy) {
            setFixPhase("done");
            setFixStatus("Fixed! Reloading...");
            unsubRef.current?.();
            unsubRef.current = null;
          }
          break;
        }
        case "message.part.updated": {
          const part = props.part as { type: string; tool?: string; state?: { status?: string } };
          if (part.type === "tool" && part.tool) {
            const label = toolLabels[part.tool.toLowerCase()] || "Working";
            const hint = extractToolHint(props.part as Record<string, unknown>);
            if (part.state?.status === "running" || part.state?.status === "pending") {
              setFixStatus(hint ? `${label} ${hint}` : `${label}...`);
            }
          }
          break;
        }
      }
    });

    try {
      const sessionId = await onFixError({ title, message: error.message, stack: error.stack, console: error.console });
      targetSessionId = sessionId;
    } catch {
      unsubRef.current?.();
      unsubRef.current = null;
      setFixPhase("idle");
      setFixStatus("");
    }
  }, [onFixError, error, title]);

  const onPointerDown = useCallback((e: ReactPointerEvent) => {
    if ((e.target as HTMLElement).closest("button")) return;
    e.preventDefault();
    const el = toolbarRef.current!;
    const rect = el.getBoundingClientRect();
    dragOffset.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    el.setPointerCapture(e.pointerId);
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

  // Determine what to render inside the window
  let content: React.ReactNode;

  if (fixPhase === "fixing" || fixPhase === "done") {
    // Fixing progress screen
    content = (
      <div className="viewer-fix-screen">
        <div className={`viewer-fix-icon ${fixPhase === "done" ? "viewer-fix-icon-done" : ""}`}>
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none">
            <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" fill="url(#fix-bolt-grad)" />
            <defs>
              <linearGradient id="fix-bolt-grad" x1="3" y1="2" x2="20" y2="22">
                <stop offset="0%" stopColor="#7c6bff" />
                <stop offset="100%" stopColor="#6366f1" />
              </linearGradient>
            </defs>
          </svg>
        </div>
        <h3 className="viewer-fix-title">
          {fixPhase === "done" ? "Fixed!" : "Oyster is on it"}
        </h3>
        <p className="viewer-fix-status">{fixStatus}</p>
        {fixPhase === "fixing" && (
          <button className="viewer-fix-cancel" onClick={handleRetry}>Cancel</button>
        )}
      </div>
    );
  } else if (error) {
    // Error screen
    content = (
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
            <button className="viewer-error-fix" onClick={handleFix}>
              Ask Oyster to fix it
            </button>
          )}
          <button className="viewer-error-retry" onClick={handleRetry}>Retry</button>
        </div>
        <ErrorDetails stack={error.stack} consoleEntries={error.console} />
      </div>
    );
  } else {
    content = <iframe key={iframeKey} ref={iframeRef} src={iframeSrc} className="viewer-iframe" title={title} />;
  }

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
      {content}
    </WindowChrome>
  );
}
