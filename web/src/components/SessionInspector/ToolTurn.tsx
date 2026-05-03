// ToolTurn — extracted from SessionInspector for navigability.
import { useState } from "react";
import { fetchSessionEventRaw } from "../../data/sessions-api";
import type { SessionEvent } from "../../data/sessions-api";
import { Highlighted } from "./Highlighted";

const RAW_CAP_BYTES = 4096;

export function ToolTurn({
  event, sessionId, flash, highlightQuery,
}: {
  event: SessionEvent;
  sessionId: string;
  flash: boolean;
  highlightQuery: string;
}) {
  const [open, setOpen] = useState(false);
  // The list endpoint omits raw to keep payloads small. We lazy-fetch
  // it the first time the user expands this turn, and cache it locally.
  const [raw, setRaw] = useState<string | null>(event.raw);
  const [rawLoading, setRawLoading] = useState(false);
  const [rawError, setRawError] = useState<string | null>(null);
  const summary = oneLineSummary({ ...event, raw });

  function toggle() {
    const next = !open;
    setOpen(next);
    if (next && raw === null && !rawLoading) {
      setRawLoading(true);
      setRawError(null);
      fetchSessionEventRaw(sessionId, event.id)
        .then((r) => setRaw(r))
        .catch((err) => setRawError(err instanceof Error ? err.message : String(err)))
        .finally(() => setRawLoading(false));
    }
  }

  const { display, truncated, totalBytes } = capRaw(raw ?? "");
  return (
    <div className={`turn ${event.role}${flash ? " turn-flash" : ""}`} data-event-id={event.id}>
      <div className="turn-role">{event.role}</div>
      <button
        type="button"
        className="turn-tool-summary"
        onClick={toggle}
        aria-expanded={open}
      >
        {open ? "▾" : "▸"} <Highlighted text={summary} query={highlightQuery} />
      </button>
      {open && rawLoading && <div className="turn-tool-truncated">Loading…</div>}
      {open && rawError && <div className="turn-tool-truncated">Couldn't load: {rawError}</div>}
      {open && !rawLoading && !rawError && raw && (
        <>
          <pre className="turn-tool-raw"><Highlighted text={display} query={highlightQuery} /></pre>
          {truncated && (
            <div className="turn-tool-truncated">
              …truncated, {totalBytes - RAW_CAP_BYTES} more bytes
            </div>
          )}
        </>
      )}
      {!raw && !rawLoading && event.text && (
        <div className="turn-text"><Highlighted text={event.text} query={highlightQuery} /></div>
      )}
    </div>
  );
}

function oneLineSummary(event: SessionEvent): string {
  // Prefer parsed tool name from raw; fall back to text snippet
  if (event.raw) {
    try {
      const parsed = JSON.parse(event.raw);
      const name = parsed?.message?.content?.[0]?.name
        ?? parsed?.toolUseResult?.name
        ?? parsed?.tool
        ?? null;
      if (name) return `Tool ${event.role === "tool" ? "call" : "result"}: ${name}`;
    } catch { /* fall through */ }
  }
  return event.role === "tool" ? "Tool call" : "Tool result";
}

function capRaw(raw: string): { display: string; truncated: boolean; totalBytes: number } {
  const totalBytes = new Blob([raw]).size;
  if (totalBytes <= RAW_CAP_BYTES) return { display: raw, truncated: false, totalBytes };
  // Slice by character is approximate but cheap; for our purposes it's fine.
  return { display: raw.slice(0, RAW_CAP_BYTES), truncated: true, totalBytes };
}
