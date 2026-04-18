import { useRef, useMemo, useCallback, useState, useEffect } from "react";
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
  onFixError?: (error: { title: string; path: string; message: string; stack: string; console: Array<{ type: string; message: string }> }) => Promise<string>;
  onHashChange?: (hash: string) => void;
  initialHash?: string;
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
  const [copied, setCopied] = useState(false);
  if (!stack && consoleEntries.length === 0) return null;

  const fullText = stack + (consoleEntries.length > 0
    ? "\n\nConsole:\n" + consoleEntries.map((e) => `[${e.type}] ${e.message}`).join("\n")
    : "");

  function handleCopy() {
    navigator.clipboard.writeText(fullText).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  return (
    <div className="viewer-error-details">
      <button className="viewer-error-details-toggle" onClick={() => setOpen(!open)}>
        {open ? "Hide details" : "Show details"}
      </button>
      {open && (
        <div className="viewer-error-stack-wrap">
          <button className="viewer-error-copy" onClick={handleCopy}>
            {copied ? "Copied!" : "Copy"}
          </button>
          <pre className="viewer-error-stack">{fullText}</pre>
        </div>
      )}
    </div>
  );
}

type FixPhase = "idle" | "fixing" | "done";

interface FixLogEntry {
  type: "tool" | "text";
  label: string;
  detail?: string;
  ts: number;
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
  onHashChange,
  initialHash,
}: Props) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [error, setError] = useState<ArtifactError | null>(null);
  const [iframeKey, setIframeKey] = useState(0);
  const [fixPhase, setFixPhase] = useState<FixPhase>("idle");
  const [fixStatus, setFixStatus] = useState("Sending to Oyster...");
  const [fixLog, setFixLog] = useState<FixLogEntry[]>([]);
  const [fixLogOpen, setFixLogOpen] = useState(false);
  const fixLogEndRef = useRef<HTMLDivElement>(null);
  const unsubRef = useRef<(() => void) | null>(null);
  // Date.now() is intentional cache-busting — the memo only recomputes when
  // path or iframeKey changes, so it's not per-render.
  // eslint-disable-next-line react-hooks/purity
  const iframeSrc = useMemo(() => `${path}${path.includes("?") ? "&" : "?"}t=${Date.now()}${initialHash ? initialHash : ""}`, [path, iframeKey]);

  // Auto-scroll fix log
  useEffect(() => {
    if (fixLogOpen && fixLogEndRef.current) {
      fixLogEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [fixLog, fixLogOpen]);

  // Listen for iframe errors via postMessage
  useEffect(() => {
    function handleMessage(event: MessageEvent) {
      if (event.origin !== window.location.origin) return;
      if (event.source !== iframeRef.current?.contentWindow) return;
      if (event.data?.type === "oyster-close") { onClose(); return; }
      if (event.data?.type !== "oyster-error") return;
      setError({
        message: event.data.error?.message || "Unknown error",
        stack: event.data.error?.stack || "",
        console: Array.isArray(event.data.console) ? event.data.console : [],
      });
      // Exit fullscreen so error appears as a window on the desktop
      if (fullscreen) onToggleFullscreen();
    }
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [fullscreen, onToggleFullscreen, onClose]);

  // Track hash changes inside iframe (e.g., Reveal.js slide navigation)
  // Injects a MutationObserver + polling script into the iframe to detect
  // hash changes from Reveal.js (which uses replaceState, not hashchange)
  useEffect(() => {
    if (!onHashChange) return;
    const iframe = iframeRef.current;
    if (!iframe) return;

    function handleMessage(event: MessageEvent) {
      if (event.source !== iframe!.contentWindow) return;
      if (event.data?.type === "oyster-hash") {
        onHashChange!(event.data.hash);
      }
    }
    window.addEventListener("message", handleMessage);

    function onLoad() {
      try {
        const doc = iframe!.contentWindow?.document;
        if (!doc) return;
        const script = doc.createElement("script");
        script.textContent = `
          (function() {
            var last = location.hash;
            if (last) parent.postMessage({ type: "oyster-hash", hash: last }, "*");
            setInterval(function() {
              if (location.hash !== last) {
                last = location.hash;
                parent.postMessage({ type: "oyster-hash", hash: last }, "*");
              }
            }, 50);
          })();
        `;
        doc.body.appendChild(script);
      } catch { /* cross-origin, ignore */ }
    }

    iframe.addEventListener("load", onLoad);
    return () => {
      iframe.removeEventListener("load", onLoad);
      window.removeEventListener("message", handleMessage);
    };
  }, [onHashChange, iframeKey]);

  // Reset on path change — each state reset is intentional on navigation.
  useEffect(() => {
    unsubRef.current?.();
    unsubRef.current = null;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setError(null);
    setFixPhase("idle");
    setFixStatus("");
    setFixLog([]);
    setFixLogOpen(false);
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
    setFixLog([]);
    setFixLogOpen(false);
    setIframeKey((k) => k + 1);
  }, []);

  const handleFix = useCallback(async () => {
    if (!onFixError || !error) return;
    setFixPhase("fixing");
    setFixStatus("Sending to Oyster...");
    setFixLog([]);
    setFixLogOpen(false);

    // Subscribe to SSE BEFORE sending the message so we don't miss events
    let seenBusy = false;
    let hasEdited = false;
    let targetSessionId: string | null = null;
    const textAccum = new Map<string, string>();

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
            setFixStatus("Oyster is debugging...");
          } else if (status.type === "idle" && seenBusy) {
            unsubRef.current?.();
            unsubRef.current = null;
            if (hasEdited) {
              setFixPhase("done");
              setFixStatus("Done! Reloading...");
              setFixLog((prev) => [...prev, { type: "text", label: "Done — reloading artifact", ts: Date.now() }]);
            } else {
              setFixPhase("idle");
              setFixStatus("");
              setError((prev) => prev ? { ...prev, message: prev.message + "\n\nOyster couldn't fix this automatically." } : prev);
            }
          }
          break;
        }
        case "message.part.updated": {
          const part = props.part as { type: string; id?: string; text?: string; tool?: string; state?: { status?: string; output?: unknown } };

          // Capture text parts (Oyster's reasoning)
          if (part.type === "text" && part.text && part.id) {
            textAccum.set(part.id, part.text);
            // Emit the latest meaningful line as a log entry
            const lines = part.text.split("\n").filter((l) => l.trim().length > 0);
            const last = lines[lines.length - 1];
            if (last) {
              const snippet = last.length > 120 ? last.slice(0, 117) + "..." : last;
              setFixLog((prev) => {
                // Update existing text entry for this part ID, or add new
                const existingIdx = prev.findIndex((e) => e.detail === part.id);
                if (existingIdx >= 0) {
                  const updated = [...prev];
                  updated[existingIdx] = { type: "text", label: snippet, detail: part.id!, ts: Date.now() };
                  return updated;
                }
                return [...prev, { type: "text", label: snippet, detail: part.id!, ts: Date.now() }];
              });
            }
          }

          if (part.type === "tool" && part.tool) {
            const toolName = part.tool.toLowerCase();
            if (toolName === "edit" || toolName === "write") {
              hasEdited = true;
            }
            const label = toolLabels[toolName] || "Working";
            const hint = extractToolHint(props.part as Record<string, unknown>);
            const status = part.state?.status;
            if (status === "running" || status === "pending") {
              const statusText = hint ? `${label} ${hint}` : `${label}...`;
              setFixStatus(statusText);
              setFixLog((prev) => [...prev, { type: "tool", label: statusText, ts: Date.now() }]);
            } else if (status === "completed") {
              const statusText = hint ? `${label} ${hint} ✓` : `${label} ✓`;
              setFixLog((prev) => {
                // Replace the last pending entry for this tool with completed
                const lastIdx = prev.findLastIndex((e) => e.type === "tool" && e.label.startsWith(label));
                if (lastIdx >= 0) {
                  const updated = [...prev];
                  updated[lastIdx] = { ...updated[lastIdx], label: statusText };
                  return updated;
                }
                return [...prev, { type: "tool", label: statusText, ts: Date.now() }];
              });
            }
          }
          break;
        }
      }
    });

    try {
      const sessionId = await onFixError({ title, path, message: error.message, stack: error.stack, console: error.console });
      targetSessionId = sessionId;
    } catch {
      unsubRef.current?.();
      unsubRef.current = null;
      setFixPhase("idle");
      setFixStatus("");
    }
  }, [onFixError, error, title]);

  // Toolbar: visible until first use, then auto-hides with subtle hint (#102)
  const [discovered, setDiscovered] = useState(
    () => localStorage.getItem("oyster-toolbar-discovered") === "true",
  );
  const [toolbarVisible, setToolbarVisible] = useState(true);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const scheduleHide = useCallback(() => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setToolbarVisible(false), 1500);
  }, []);

  const showToolbar = useCallback(() => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    setToolbarVisible(true);
  }, []);

  const leaveToolbar = useCallback(() => {
    if (discovered) scheduleHide();
  }, [discovered, scheduleHide]);

  const markDiscovered = useCallback(() => {
    if (!discovered) {
      setDiscovered(true);
      localStorage.setItem("oyster-toolbar-discovered", "true");
    }
  }, [discovered]);

  useEffect(() => {
    if (!fullscreen) return;
    // Auto-reveal the toolbar entering fullscreen, then schedule hide.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setToolbarVisible(true);
    if (discovered) scheduleHide();
    return () => { if (hideTimer.current) clearTimeout(hideTimer.current); };
  }, [fullscreen, discovered, scheduleHide]);

  // Escape key exits fullscreen
  useEffect(() => {
    if (!fullscreen) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        onClose();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [fullscreen, onClose]);


  // Determine what to render inside the window
  let content: React.ReactNode;

  if (fixPhase === "fixing" || fixPhase === "done") {
    content = (
      <div className="viewer-fix-screen">
        <div className="viewer-fix-container">
          <div className={`viewer-fix-bar ${fixPhase === "done" ? "viewer-fix-bar-done" : ""}`}>
            <div className="viewer-fix-bolt">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="none">
                <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
              </svg>
            </div>
            <span className="viewer-fix-status" key={fixStatus}>{fixStatus}</span>
            {fixPhase === "fixing" && (
              <button className="viewer-fix-cancel" onClick={handleRetry} title="Cancel">
                ×
              </button>
            )}
          </div>
          {fixLog.length > 0 && (
            <button
              className="viewer-fix-log-toggle"
              onClick={() => setFixLogOpen(!fixLogOpen)}
            >
              {fixLogOpen ? "Hide" : "Show"} activity log ({fixLog.length})
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" style={{ transform: fixLogOpen ? "rotate(180deg)" : "none", transition: "transform 0.15s" }}>
                <path d="M6 9l6 6 6-6" />
              </svg>
            </button>
          )}
          {fixLogOpen && (
            <div className="viewer-fix-log">
              {fixLog.map((entry, i) => (
                <div key={i} className={`viewer-fix-log-entry viewer-fix-log-${entry.type}`}>
                  <span className="viewer-fix-log-icon">{entry.type === "tool" ? "⚙" : "›"}</span>
                  <span className="viewer-fix-log-label">{entry.label}</span>
                </div>
              ))}
              <div ref={fixLogEndRef} />
            </div>
          )}
        </div>
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
          className="fullscreen-toolbar-zone"
          onMouseEnter={showToolbar}
          onMouseLeave={leaveToolbar}
        >
        {!toolbarVisible && <div className="fullscreen-toolbar-hint" />}
        <div className={`fullscreen-toolbar ${toolbarVisible ? "" : "fullscreen-toolbar-hidden"}`}>
          <button
            className="fullscreen-toolbar-btn"
            disabled={!hasPrev}
            onClick={() => { markDiscovered(); onNavigate?.(-1); }}
            title="Previous"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M15 18l-6-6 6-6" />
            </svg>
          </button>
          <button
            className="fullscreen-toolbar-btn"
            disabled={!hasNext}
            onClick={() => { markDiscovered(); onNavigate?.(1); }}
            title="Next"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 18l6-6-6-6" />
            </svg>
          </button>
          <span className="fullscreen-toolbar-title">{title}</span>
          <div className="fullscreen-toolbar-sep" />
          <button
            className="fullscreen-toolbar-btn"
            onClick={() => { markDiscovered(); onToggleFullscreen?.(); }}
            title="Window"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <polyline points="4 14 10 14 10 20" />
              <polyline points="20 10 14 10 14 4" />
              <line x1="14" y1="10" x2="21" y2="3" />
              <line x1="3" y1="21" x2="10" y2="14" />
            </svg>
          </button>
          <button
            className="fullscreen-toolbar-btn fullscreen-toolbar-close"
            onClick={() => { markDiscovered(); onClose(); }}
            title="Close"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
        </div>
      )}
      {content}
    </WindowChrome>
  );
}
