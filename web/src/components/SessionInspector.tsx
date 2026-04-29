import { useEffect, useRef, useState } from "react";
import {
  fetchSession,
  fetchSessionEvents,
  fetchSessionArtifacts,
  SessionNotFoundError,
} from "../data/sessions-api";
import { subscribeUiEvents } from "../data/ui-events";
import type {
  Session,
  SessionEvent,
  SessionArtifactJoined,
  SessionState,
} from "../data/sessions-api";
import { KindThumb } from "./KindThumb";
import type { ActivePanel } from "./InspectorPanel";

interface Props {
  sessionId: string;
  onSwitchTo: (next: ActivePanel) => void;
  onClose: () => void;
  onNotFound: () => void;
}

const PIP_CLASS: Record<SessionState, string> = {
  active: "green",
  waiting: "amber",
  disconnected: "red",
  done: "dim",
};

const STATE_LABEL: Record<SessionState, string> = {
  active: "active",
  waiting: "waiting on you",
  disconnected: "disconnected",
  done: "done",
};

const RAW_CAP_BYTES = 4096;

type Tab = "transcript" | "artefacts";

export function SessionInspector({ sessionId, onSwitchTo, onClose, onNotFound }: Props) {
  const [session, setSession] = useState<Session | null>(null);
  const [events, setEvents] = useState<SessionEvent[] | null>(null);
  const [artefacts, setArtefacts] = useState<SessionArtifactJoined[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("transcript");
  const latestReqId = useRef(0);
  // Capture onNotFound by ref so the effects don't re-run when the caller
  // passes a fresh inline lambda each render. Without this, a parent
  // re-render (e.g. from the Home `useSessions` SSE tick) recreates the
  // closure → effect re-fires → state resets to null → spinner flicker.
  const onNotFoundRef = useRef(onNotFound);
  useEffect(() => { onNotFoundRef.current = onNotFound; }, [onNotFound]);

  useEffect(() => {
    const reqId = ++latestReqId.current;
    setError(null);
    setSession(null);
    setEvents(null);
    setArtefacts(null);
    setTab("transcript");
    const ac = new AbortController();
    Promise.all([
      fetchSession(sessionId, ac.signal),
      fetchSessionEvents(sessionId, ac.signal),
      fetchSessionArtifacts(sessionId, ac.signal),
    ])
      .then(([s, ev, art]) => {
        if (reqId !== latestReqId.current) return;
        setSession(s);
        setEvents(ev);
        setArtefacts(art);
      })
      .catch((err) => {
        if (reqId !== latestReqId.current || ac.signal.aborted) return;
        if (err instanceof SessionNotFoundError) {
          onNotFoundRef.current();
          return;
        }
        setError(err instanceof Error ? err.message : String(err));
      });
    return () => ac.abort();
  }, [sessionId]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let inflight: AbortController | null = null;

    function refetchLive() {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        const reqId = ++latestReqId.current;
        if (inflight) inflight.abort();
        inflight = new AbortController();
        Promise.all([
          fetchSession(sessionId, inflight.signal),
          fetchSessionEvents(sessionId, inflight.signal),
        ])
          .then(([s, ev]) => {
            if (reqId !== latestReqId.current) return;
            setSession(s);
            setEvents(ev);
          })
          .catch((err) => {
            if (inflight?.signal.aborted) return;
            if (err instanceof SessionNotFoundError) {
              onNotFoundRef.current();
              return;
            }
            console.warn("[SessionInspector] live refresh failed:", err);
          });
      }, 200);
    }

    const unsubscribe = subscribeUiEvents((event) => {
      if (
        event.command === "session_changed"
        && (event.payload as { id?: string } | null)?.id === sessionId
      ) {
        refetchLive();
      }
    });

    return () => {
      if (timer) clearTimeout(timer);
      if (inflight) inflight.abort();
      unsubscribe();
    };
  }, [sessionId]);

  if (error) {
    return (
      <>
        <header className="inspector-header">
          <div className="inspector-meta">
            <span>session</span>
            <span className="close" onClick={onClose}>✕</span>
          </div>
        </header>
        <div className="inspector-body">
          <div className="inspector-error">Couldn't load session: {error}</div>
        </div>
      </>
    );
  }

  if (!session) {
    return (
      <>
        <header className="inspector-header">
          <div className="inspector-meta">
            <span>loading…</span>
            <span className="close" onClick={onClose}>✕</span>
          </div>
        </header>
        <div className="inspector-body" />
      </>
    );
  }

  return (
    <>
      <Header session={session} onClose={onClose} />
      <Banner session={session} />
      <Tabs tab={tab} setTab={setTab} eventsCount={events?.length ?? 0} artefactsCount={artefacts?.length ?? 0} />
      <TranscriptBody
        tab={tab}
        events={events}
        artefacts={artefacts}
        onSwitchTo={onSwitchTo}
      />
      <Footer session={session} />
    </>
  );
}

/**
 * Scroll-to-bottom container for the transcript.
 *
 * Default behaviour: scroll to the latest turn on initial load and on
 * subsequent live updates — but only if the user was already within
 * 80px of the bottom (i.e. "following along"). If they've scrolled up
 * to read history, leave them there.
 */
function TranscriptBody({
  tab, events, artefacts, onSwitchTo,
}: {
  tab: Tab;
  events: SessionEvent[] | null;
  artefacts: SessionArtifactJoined[] | null;
  onSwitchTo: (next: ActivePanel) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const eventsLen = events?.length ?? 0;
  const wasNearBottomRef = useRef(true);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onScroll = () => {
      const fromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      wasNearBottomRef.current = fromBottom < 80;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el || tab !== "transcript") return;
    if (wasNearBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [eventsLen, tab]);

  return (
    <div className="inspector-body" ref={ref}>
      {tab === "transcript" && <Transcript events={events} />}
      {tab === "artefacts" && <Artefacts items={artefacts} onSwitchTo={onSwitchTo} />}
    </div>
  );
}

function Header({ session, onClose }: { session: Session; onClose: () => void }) {
  return (
    <header className="inspector-header">
      <div className="inspector-meta">
        {session.spaceId && <span className="space">{session.spaceId}</span>}
        {session.spaceId && <span>·</span>}
        <span className="agent">{session.agent}</span>
        <span>·</span>
        <span className={`pip ${PIP_CLASS[session.state]}`} />
        <span>{STATE_LABEL[session.state]}</span>
        <span className="close" onClick={onClose}>✕</span>
      </div>
      <div className="inspector-title">{session.title ?? "(no title yet)"}</div>
      <div className="inspector-sub">
        {session.id} · started {formatTs(session.startedAt)}
        {session.model ? ` · ${session.model}` : ""}
      </div>
    </header>
  );
}

function Banner({ session }: { session: Session }) {
  if (session.state === "disconnected") {
    return (
      <div className="inspector-banner disconnected">
        <div>
          Last heartbeat <strong>{formatRel(session.lastEventAt)}</strong>. The agent process may have exited or the JSONL transcript stopped updating.
        </div>
      </div>
    );
  }
  if (session.state === "waiting") {
    return (
      <div className="inspector-banner waiting">
        <div>
          Agent is waiting — usually for tool approval. Resolve it inside the agent's TUI.
        </div>
      </div>
    );
  }
  return null;
}

function Tabs({
  tab, setTab, eventsCount, artefactsCount,
}: {
  tab: Tab;
  setTab: (t: Tab) => void;
  eventsCount: number;
  artefactsCount: number;
}) {
  return (
    <div className="inspector-tabs">
      <button
        type="button"
        className={`inspector-tab${tab === "transcript" ? " active" : ""}`}
        onClick={() => setTab("transcript")}
      >
        Transcript <span className="badge">{eventsCount}</span>
      </button>
      <button
        type="button"
        className={`inspector-tab${tab === "artefacts" ? " active" : ""}`}
        onClick={() => setTab("artefacts")}
      >
        Artefacts <span className="badge">{artefactsCount}</span>
      </button>
    </div>
  );
}

function Transcript({ events }: { events: SessionEvent[] | null }) {
  if (events === null) return <div className="inspector-empty">Loading transcript…</div>;
  if (events.length === 0) {
    return <div className="inspector-empty">No transcript yet. Live updates active.</div>;
  }
  return (
    <>
      {events.map((e) => (
        <Turn key={e.id} event={e} />
      ))}
    </>
  );
}

function Turn({ event }: { event: SessionEvent }) {
  if (event.role === "tool" || event.role === "tool_result") {
    return <ToolTurn event={event} />;
  }
  return (
    <div className={`turn ${event.role}`}>
      <div className="turn-role">{event.role}</div>
      <div className="turn-text">{event.text || "(empty)"}</div>
    </div>
  );
}

function ToolTurn({ event }: { event: SessionEvent }) {
  const [open, setOpen] = useState(false);
  const summary = oneLineSummary(event);
  const { display, truncated, totalBytes } = capRaw(event.raw ?? "");
  return (
    <div className={`turn ${event.role}`}>
      <div className="turn-role">{event.role}</div>
      <div className="turn-tool-summary" onClick={() => setOpen((v) => !v)}>
        {open ? "▾" : "▸"} {summary}
      </div>
      {open && event.raw && (
        <>
          <pre className="turn-tool-raw">{display}</pre>
          {truncated && (
            <div className="turn-tool-truncated">
              …truncated, {totalBytes - RAW_CAP_BYTES} more bytes
            </div>
          )}
        </>
      )}
      {!event.raw && event.text && <div className="turn-text">{event.text}</div>}
    </div>
  );
}

function Artefacts({
  items, onSwitchTo,
}: {
  items: SessionArtifactJoined[] | null;
  onSwitchTo: (next: ActivePanel) => void;
}) {
  if (items === null) return <div className="inspector-empty">Loading artefacts…</div>;
  if (items.length === 0) {
    return <div className="inspector-empty">No artefacts touched yet.</div>;
  }
  return (
    <>
      {items.map((item) => (
        <div
          key={item.id}
          className="link-row"
          onClick={() => onSwitchTo({ kind: "artefact", id: item.artifact.id })}
        >
          <KindThumb kind={item.artifact.artifactKind} />
          <div className="link-body">
            <div className="link-title">{item.artifact.label}</div>
            <div className="link-meta">
              <span className={`role-chip ${item.role}`}>{item.role}</span>
              <span>{formatRel(item.whenAt)}</span>
            </div>
          </div>
        </div>
      ))}
    </>
  );
}

// KindThumb is extracted to its own file (created earlier in Task 4 — see KindThumb.tsx)

function Footer({ session }: { session: Session }) {
  const [copiedCmd, setCopiedCmd] = useState(false);
  const [copiedId, setCopiedId] = useState(false);
  const command = `claude --resume ${session.id}`;

  function copyCommand() {
    if (!navigator.clipboard) {
      alert(`Copy failed — resume command:\n${command}`);
      return;
    }
    navigator.clipboard.writeText(command).then(
      () => {
        setCopiedCmd(true);
        setTimeout(() => setCopiedCmd(false), 1500);
      },
      () => alert(`Copy failed — resume command:\n${command}`),
    );
  }

  function copyId() {
    if (!navigator.clipboard) return;
    navigator.clipboard.writeText(session.id).then(() => {
      setCopiedId(true);
      setTimeout(() => setCopiedId(false), 1500);
    });
  }

  return (
    <footer className="inspector-footer">
      <button type="button" className="btn primary" onClick={copyCommand}>
        {copiedCmd ? "Copied!" : "Copy resume command"}
      </button>
      <button type="button" className="btn" onClick={copyId}>
        {copiedId ? "Copied!" : "Copy session ID"}
      </button>
    </footer>
  );
}

// --- helpers ---

function formatTs(iso: string): string {
  return new Date(iso).toLocaleString();
}

function formatRel(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
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
