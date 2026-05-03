import { useEffect, useRef, useState } from "react";
import {
  fetchSession,
  fetchSessionEvents,
  fetchSessionArtifacts,
  fetchSessionMemory,
  SessionNotFoundError,
} from "../../data/sessions-api";
import { subscribeUiEvents } from "../../data/ui-events";
import type {
  Session,
  SessionEvent,
  SessionArtifactJoined,
  SessionMemory,
} from "../../data/sessions-api";
import type { ActivePanel } from "../InspectorPanel";
import type { Artifact } from "../../data/artifacts-api";
import { Banner } from "./Banner";
import { Header } from "./Header";
import { Tabs } from "./Tabs";
import { TranscriptBody } from "./TranscriptBody";
import type { Tab } from "./types";
import { PAGE_SIZE } from "./utils";

interface Props {
  sessionId: string;
  /** When set, the bootstrap fetches a window of events centred on
   *  this id (rather than the latest 1000) and the matching turn is
   *  scrolled into view + flashed for ~3s. Used by Spotlight transcript
   *  click-through (#329). */
  focusEventId?: number;
  /** Pre-fills the in-transcript find bar so the user sees inline
   *  match highlights and can step through other matches in this
   *  session. Used by Spotlight click-through alongside focusEventId
   *  (#332). */
  initialSearchQuery?: string;
  onSwitchTo: (next: ActivePanel) => void;
  /** Open an artefact directly in the file viewer. The session inspector
   *  stays mounted behind the viewer (windows-layer renders above
   *  inspector-panel) so the user returns to it when the viewer closes.
   *  Clicking an artefact in the Artefacts tab routes here rather than
   *  through the ArtefactInspector — users want the file, not a metadata
   *  sidebar on top of a metadata sidebar. */
  onOpenArtefact: (artefact: Artifact) => void;
  onClose: () => void;
  onNotFound: () => void;
}

export function SessionInspector({ sessionId, focusEventId, initialSearchQuery, onSwitchTo, onOpenArtefact, onClose, onNotFound }: Props) {
  const [session, setSession] = useState<Session | null>(null);
  const [events, setEvents] = useState<SessionEvent[] | null>(null);
  const [artefacts, setArtefacts] = useState<SessionArtifactJoined[] | null>(null);
  const [memory, setMemory] = useState<SessionMemory | null>(null);
  const [memoryError, setMemoryError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("transcript");
  // True if the bootstrap fetch returned a full page — i.e. there are older
  // events still on the server. Drives the "1000+" badge and the scroll-up
  // load. Flips to false once an older fetch returns less than a full page.
  const [hasMoreOlder, setHasMoreOlder] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const latestReqId = useRef(0);
  // Capture onNotFound by ref so the effects don't re-run when the caller
  // passes a fresh inline lambda each render. Without this, a parent
  // re-render (e.g. from the Home `useSessions` SSE tick) recreates the
  // closure → effect re-fires → state resets to null → spinner flicker.
  const onNotFoundRef = useRef(onNotFound);
  useEffect(() => { onNotFoundRef.current = onNotFound; }, [onNotFound]);

  // Tracks whether the bootstrap fetch has finished. Live SSE refetches
  // gate on this — without the gate, an SSE event arriving mid-bootstrap
  // can race the bootstrap's 3-fetch promise: the (cheaper, 2-fetch) live
  // path resolves first, sets session+events with reqId N+1, then the
  // bootstrap resolves with reqId N and is dropped — leaving artefacts
  // permanently null until tab switch or next SSE.
  const [bootstrapDone, setBootstrapDone] = useState(false);

  useEffect(() => {
    const reqId = ++latestReqId.current;
    setError(null);
    setSession(null);
    setEvents(null);
    setArtefacts(null);
    setMemory(null);
    setMemoryError(null);
    setTab("transcript");
    setHasMoreOlder(false);
    setLoadingOlder(false);
    setBootstrapDone(false);
    const ac = new AbortController();

    // Bootstrap: the three fetches that gate "session is loaded enough
    // to render". A failure on any of these blocks the inspector.
    // When focusEventId is set, fetch a window centred on that event
    // rather than the latest page — the deep-link target may be
    // thousands of events older than the tail.
    const eventsOpts = focusEventId !== undefined
      ? { around: focusEventId, signal: ac.signal }
      : { signal: ac.signal };
    Promise.all([
      fetchSession(sessionId, ac.signal),
      fetchSessionEvents(sessionId, eventsOpts),
      fetchSessionArtifacts(sessionId, ac.signal),
    ])
      .then(([s, ev, art]) => {
        if (reqId !== latestReqId.current) return;
        setSession(s);
        setEvents(ev);
        setArtefacts(art);
        setHasMoreOlder(ev.length >= PAGE_SIZE);
        setBootstrapDone(true);
      })
      .catch((err) => {
        if (reqId !== latestReqId.current || ac.signal.aborted) return;
        if (err instanceof SessionNotFoundError) {
          onNotFoundRef.current();
          return;
        }
        setError(err instanceof Error ? err.message : String(err));
      });

    // Memory loads in parallel but on its own track. A 500 here must
    // never block the inspector — the Memory tab is auxiliary, the
    // transcript and artefacts come first. Failure surfaces inside the
    // tab as an error message.
    fetchSessionMemory(sessionId, ac.signal)
      .then((mem) => {
        if (reqId !== latestReqId.current) return;
        setMemory(mem);
      })
      .catch((err) => {
        if (reqId !== latestReqId.current || ac.signal.aborted) return;
        setMemoryError(err instanceof Error ? err.message : String(err));
      });
    return () => ac.abort();
  }, [sessionId]);

  useEffect(() => {
    if (!bootstrapDone) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let inflight: AbortController | null = null;

    function refetchLive() {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        const reqId = ++latestReqId.current;
        if (inflight) inflight.abort();
        inflight = new AbortController();
        // Fetch session metadata fresh, but only NEW events past the last
        // cursor. Replacing the whole events array would clobber any older
        // events the user has scrolled up to load.
        const lastEventId = (() => {
          // Read the freshest events without putting events in deps —
          // adding events as a dep would re-subscribe to SSE on every
          // append, which is wasteful and risks dropping ticks.
          const arr = eventsRef.current;
          return arr && arr.length > 0 ? arr[arr.length - 1].id : undefined;
        })();
        Promise.all([
          fetchSession(sessionId, inflight.signal),
          fetchSessionEvents(sessionId, {
            after: lastEventId,
            signal: inflight.signal,
          }),
        ])
          .then(([s, newEvents]) => {
            if (reqId !== latestReqId.current) return;
            setSession(s);
            if (newEvents.length > 0) {
              setEvents((prev) => (prev ? [...prev, ...newEvents] : newEvents));
            }
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
  }, [sessionId, bootstrapDone]);

  // Mirror events into a ref so live SSE fetches can read the freshest
  // last-id without re-running their effect on every append.
  const eventsRef = useRef<SessionEvent[] | null>(null);
  useEffect(() => { eventsRef.current = events; }, [events]);

  // Load-older handler: triggered by the transcript scroll listener.
  // Returns a flag indicating whether the caller should preserve scroll
  // position (true if a fetch was actually issued and resolved with rows).
  const loadOlderRef = useRef<() => Promise<void>>(() => Promise.resolve());
  loadOlderRef.current = async () => {
    if (loadingOlder || !hasMoreOlder) return;
    const arr = eventsRef.current;
    if (!arr || arr.length === 0) return;
    const cursor = arr[0].id;
    setLoadingOlder(true);
    try {
      const older = await fetchSessionEvents(sessionId, { before: cursor });
      // Drop overlap defensively (id < cursor server-side guarantees this,
      // but if a future change introduces ≤ semantics we'd dupe rows).
      const fresh = older.filter((e) => e.id < cursor);
      if (fresh.length > 0) {
        setEvents((prev) => (prev ? [...fresh, ...prev] : fresh));
      }
      setHasMoreOlder(older.length >= PAGE_SIZE);
    } catch (err) {
      console.warn("[SessionInspector] load older failed:", err);
    } finally {
      setLoadingOlder(false);
    }
  };

  if (error) {
    return (
      <>
        <header className="inspector-header">
          <div className="inspector-meta">
            <span>session</span>
            <button type="button" className="close" onClick={onClose} aria-label="Close inspector">✕</button>
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
            <button type="button" className="close" onClick={onClose} aria-label="Close inspector">✕</button>
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
      <Tabs
        tab={tab}
        setTab={setTab}
        eventsCount={events?.length ?? 0}
        hasMoreOlder={hasMoreOlder}
        artefactsCount={artefacts ? new Set(artefacts.map((a) => a.artifact.id)).size : 0}
        memoryCount={memory ? memory.written.length + memory.pulled.length : 0}
      />
      <TranscriptBody
        tab={tab}
        events={events}
        artefacts={artefacts}
        memory={memory}
        memoryError={memoryError}
        focusEventId={focusEventId}
        initialSearchQuery={initialSearchQuery}
        onSwitchTo={onSwitchTo}
        onOpenArtefact={onOpenArtefact}
        sessionId={sessionId}
        agent={session.agent}
        hasMoreOlder={hasMoreOlder}
        loadingOlder={loadingOlder}
        onLoadOlder={() => loadOlderRef.current()}
      />
    </>
  );
}
