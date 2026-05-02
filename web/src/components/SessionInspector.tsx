import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  fetchSession,
  fetchSessionEvents,
  fetchSessionArtifacts,
  fetchSessionEventRaw,
  fetchSessionMemory,
  SessionNotFoundError,
} from "../data/sessions-api";
import { subscribeUiEvents } from "../data/ui-events";
import type {
  Session,
  SessionAgent,
  SessionEvent,
  SessionArtifactJoined,
  SessionState,
  SessionMemory,
  SessionMemoryEntry,
} from "../data/sessions-api";
import { KindThumb } from "./KindThumb";
import type { ActivePanel } from "./InspectorPanel";

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
// Matches the server default. If a fetch returns exactly this many events,
// assume there are more upstream and surface the "1000+" affordance.
const PAGE_SIZE = 1000;

type Tab = "transcript" | "artefacts" | "memory";

type RoleCategory = "user" | "assistant" | "tools" | "system" | "thinking";
const ALL_CATEGORIES: RoleCategory[] = ["user", "assistant", "tools", "system", "thinking"];
const DEFAULT_VISIBLE: RoleCategory[] = ["user", "assistant", "tools", "system"];

// Match patterns the watcher's older code emitted for assistant-only-tool
// turns ("[Bash]", "[Edit] [Read]", etc.) so historical rows categorise
// as tools rather than thinking/assistant text.
const TOOL_ONLY_RE = /^(\[[A-Za-z][A-Za-z0-9_-]*\]\s*)+$/;

function categoryOf(event: SessionEvent): RoleCategory {
  if (event.role === "user") return "user";
  if (event.role === "tool" || event.role === "tool_result") return "tools";
  if (event.role === "system") return "system";
  if (event.role === "assistant") {
    if (event.text === "(thinking)") return "thinking";
    if (TOOL_ONLY_RE.test(event.text.trim())) return "tools";
    return "assistant";
  }
  return "system";
}

function loadVisibleCategories(): Set<RoleCategory> {
  try {
    const stored = window.localStorage.getItem("oyster.inspector.transcriptFilter");
    if (stored) {
      const parsed = JSON.parse(stored) as RoleCategory[];
      const valid = parsed.filter((c) => ALL_CATEGORIES.includes(c));
      if (valid.length > 0) return new Set(valid);
    }
  } catch { /* fall through */ }
  return new Set(DEFAULT_VISIBLE);
}

function saveVisibleCategories(set: Set<RoleCategory>) {
  try {
    window.localStorage.setItem(
      "oyster.inspector.transcriptFilter",
      JSON.stringify(Array.from(set)),
    );
  } catch { /* ignore */ }
}

export function SessionInspector({ sessionId, focusEventId, initialSearchQuery, onSwitchTo, onClose, onNotFound }: Props) {
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
        sessionId={sessionId}
        agent={session.agent}
        hasMoreOlder={hasMoreOlder}
        loadingOlder={loadingOlder}
        onLoadOlder={() => loadOlderRef.current()}
      />
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
  tab, events, artefacts, memory, memoryError, focusEventId, initialSearchQuery,
  onSwitchTo, sessionId, agent, hasMoreOlder, loadingOlder, onLoadOlder,
}: {
  tab: Tab;
  events: SessionEvent[] | null;
  artefacts: SessionArtifactJoined[] | null;
  memory: SessionMemory | null;
  memoryError: string | null;
  focusEventId: number | undefined;
  initialSearchQuery: string | undefined;
  onSwitchTo: (next: ActivePanel) => void;
  sessionId: string;
  agent: SessionAgent;
  hasMoreOlder: boolean;
  loadingOlder: boolean;
  onLoadOlder: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const wasNearBottomRef = useRef(true);
  const [visible, setVisible] = useState<Set<RoleCategory>>(loadVisibleCategories);
  // In-transcript search (#332). Client-side substring match over the
  // already-loaded events. Compared with the FTS5-backed Spotlight, this
  // is forgiving on punctuation (literal "0.6.0" works) and highlights
  // the matched substring inline. Caps at the loaded window.
  //
  // Spotlight click-through (#329) pre-fills via initialSearchQuery so
  // the user lands inside an already-active find session — inline
  // highlights visible, ↑/↓ available to walk other matches.
  const [searchOpen, setSearchOpen] = useState(!!initialSearchQuery);
  const [searchQuery, setSearchQuery] = useState(initialSearchQuery ?? "");
  const [searchMatchIdx, setSearchMatchIdx] = useState(0);
  // Re-initialise the find bar when the inspector swaps to a new
  // deep-link target (e.g. user clicks a different Spotlight hit
  // without closing the panel between).
  useEffect(() => {
    if (initialSearchQuery !== undefined) {
      setSearchQuery(initialSearchQuery);
      setSearchOpen(initialSearchQuery.length > 0);
      setSearchMatchIdx(0);
    }
  }, [initialSearchQuery, sessionId]);
  // When set to a number (saved scrollHeight), the layout effect below
  // restores the user's scroll position after a load-older prepend. Cleared
  // after restore so live appends continue to behave normally.
  const restoreFromBottomRef = useRef<number | null>(null);
  const onLoadOlderRef = useRef(onLoadOlder);
  useEffect(() => { onLoadOlderRef.current = onLoadOlder; }, [onLoadOlder]);
  // Latest values for the scroll handler — keeping them in refs avoids
  // re-attaching the listener on every state tick.
  const hasMoreOlderRef = useRef(hasMoreOlder);
  useEffect(() => { hasMoreOlderRef.current = hasMoreOlder; }, [hasMoreOlder]);
  const loadingOlderRef = useRef(loadingOlder);
  useEffect(() => { loadingOlderRef.current = loadingOlder; }, [loadingOlder]);

  function toggleCategory(cat: RoleCategory) {
    setVisible((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat); else next.add(cat);
      saveVisibleCategories(next);
      return next;
    });
  }

  // Compute matches from the loaded events. Substring on lowercased
  // text — robust against punctuation FTS5 strips (e.g. literal "0.6.0").
  // Only runs when the bar is open: closing the bar via the magnifying
  // glass preserves the query for next-open but suppresses the inline
  // highlights and scroll-anchoring while hidden.
  const trimmedQuery = searchQuery.trim();
  const isSearching = searchOpen && trimmedQuery.length > 0;
  const matchIds = useMemo<number[]>(() => {
    if (!events || !isSearching) return [];
    const q = trimmedQuery.toLowerCase();
    return events.filter((e) => e.text.toLowerCase().includes(q)).map((e) => e.id);
  }, [events, isSearching, trimmedQuery]);
  // Clamp idx if the match list shrinks under us (e.g. user typed
  // more). Gated on isSearching so closing the bar (which empties
  // matchIds via the isSearching gate above) doesn't reset the
  // user's position — re-opening returns them to the same match.
  useEffect(() => {
    if (!isSearching) return;
    if (matchIds.length === 0) { setSearchMatchIdx(0); return; }
    if (searchMatchIdx >= matchIds.length) setSearchMatchIdx(0);
  }, [isSearching, matchIds.length, searchMatchIdx]);

  // Action-driven scroll: only scroll to the current match when the
  // user explicitly navigated (clicked ↑/↓ or arrived via Spotlight),
  // not when they merely toggled the bar open. Without this, hiding
  // and reopening the bar via the magnifying glass would yank the
  // transcript back to the current match every time, fighting the
  // user's scroll position.
  const pendingMatchScrollRef = useRef(false);

  // Align the find bar's current match to the Spotlight-clicked event
  // once both the matches and the focus id are known. Without this,
  // Cmd+K → "ruth" → click third hit could land on the FIRST loaded
  // match for "ruth" instead of the one the user actually clicked.
  // Runs once per (session, focusEventId) pair via a ref guard.
  const alignedFocusRef = useRef<{ sid: string; fid: number | undefined } | null>(null);
  useEffect(() => {
    if (focusEventId === undefined || matchIds.length === 0) return;
    const last = alignedFocusRef.current;
    if (last && last.sid === sessionId && last.fid === focusEventId) return;
    const idx = matchIds.indexOf(focusEventId);
    if (idx >= 0) {
      setSearchMatchIdx(idx);
      pendingMatchScrollRef.current = true; // initial deep-link should scroll
      alignedFocusRef.current = { sid: sessionId, fid: focusEventId };
    }
  }, [focusEventId, matchIds, sessionId]);
  const currentMatchEventId = matchIds[searchMatchIdx];

  // Always include deep-link / search targets in the rendered list, even
  // if their category is filtered out. Otherwise a Spotlight click on a
  // tool_result with Tools off lands on no DOM target. Same for
  // in-transcript search hits — strip them and the user can't see what
  // they searched for.
  const filteredEvents = events
    ? events.filter((e) =>
        visible.has(categoryOf(e))
        || e.id === focusEventId
        || matchIds.includes(e.id),
      )
    : null;
  const filteredLen = filteredEvents?.length ?? 0;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onScroll = () => {
      const fromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      wasNearBottomRef.current = fromBottom < 80;
      // Trigger load-older when within 200px of the top. Take the
      // loading lock synchronously so a flurry of scroll events doesn't
      // queue duplicate fetches before React commits the state change.
      // The prop-mirroring useEffect catches up afterwards.
      if (
        el.scrollTop < 200
        && hasMoreOlderRef.current
        && !loadingOlderRef.current
      ) {
        loadingOlderRef.current = true;
        // Capture distance-from-bottom *before* the prepend so we can
        // restore it after React re-renders. scrollTop alone is fragile —
        // it grows by N pixels on prepend and the user appears to "jump
        // back" to where they were; pinning to bottom-distance keeps the
        // visible turn at the same screen position.
        restoreFromBottomRef.current = el.scrollHeight - el.scrollTop;
        onLoadOlderRef.current();
      }
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  // Track whether we've already handled the focus scroll for this open
  // — only fire it once per inspector mount, not on every render.
  const focusScrolledRef = useRef(false);
  useEffect(() => { focusScrolledRef.current = false; }, [sessionId, focusEventId]);

  // The effective scroll target each render: in-transcript-search match
  // takes precedence (the user is actively stepping through), with the
  // deep-link target as fallback for the very first render.
  const effectiveFocusId = currentMatchEventId ?? focusEventId;

  // Run BEFORE paint so the scroll restore is invisible to the user. A
  // post-paint useEffect would briefly show the jumped position.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || tab !== "transcript") return;
    if (restoreFromBottomRef.current != null) {
      el.scrollTop = el.scrollHeight - restoreFromBottomRef.current;
      restoreFromBottomRef.current = null;
      return;
    }
    // In-transcript search: scroll the current match into view ONLY
    // when the user just navigated (↑/↓ or initial Spotlight arrival).
    // pendingMatchScrollRef gates this so toggling the bar open doesn't
    // yank the transcript back to the current match each time.
    if (pendingMatchScrollRef.current && currentMatchEventId !== undefined && filteredLen > 0) {
      const target = el.querySelector(`[data-event-id="${currentMatchEventId}"]`) as HTMLElement | null;
      if (target) {
        target.scrollIntoView({ block: "center" });
        pendingMatchScrollRef.current = false;
        wasNearBottomRef.current = false;
        return;
      }
    }
    // Deep-link from Spotlight: scroll the focused turn into view on
    // first render only (focusScrolledRef guards re-entry).
    if (focusEventId !== undefined && !focusScrolledRef.current && filteredLen > 0) {
      const target = el.querySelector(`[data-event-id="${focusEventId}"]`) as HTMLElement | null;
      if (target) {
        target.scrollIntoView({ block: "center" });
        focusScrolledRef.current = true;
        wasNearBottomRef.current = false;
        return;
      }
    }
    if (wasNearBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [filteredLen, tab, focusEventId, currentMatchEventId]);

  // Cmd+F (Ctrl+F on non-Mac) opens the search bar. Handled at the
  // window level only when this inspector is the active session view —
  // tab gating below ensures it doesn't fire in the artefacts/memory
  // tabs where the search would have no targets.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const isFind = (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f";
      if (isFind && tab === "transcript") {
        e.preventDefault();
        setSearchOpen(true);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tab]);

  function stepMatch(delta: number) {
    if (matchIds.length === 0) return;
    pendingMatchScrollRef.current = true;
    setSearchMatchIdx((i) => (i + delta + matchIds.length) % matchIds.length);
  }
  function closeSearch() {
    setSearchOpen(false);
    setSearchQuery("");
    setSearchMatchIdx(0);
  }

  // Floating "scroll to bottom" affordance. Visible when the user is
  // not within 80px of the bottom (matches the auto-tail threshold).
  // Tracked via state so the button can show/hide; we read scrollTop
  // on the body's scroll handler that already exists for load-older.
  const [showScrollBottom, setShowScrollBottom] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      const fromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      // Hide when essentially at the bottom; show when materially above.
      setShowScrollBottom(fromBottom > 200);
    };
    el.addEventListener("scroll", update, { passive: true });
    update();
    return () => el.removeEventListener("scroll", update);
  }, [tab]);
  function scrollToBottom() {
    const el = ref.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    wasNearBottomRef.current = true;
  }

  // Highlight applies to whichever event is the current scroll target —
  // search-match takes priority, deep-link target falls back.
  const flashEventId = currentMatchEventId ?? focusEventId;

  return (
    <>
      {tab === "transcript" && (
        <TranscriptFilter
          visible={visible}
          onToggle={toggleCategory}
          agent={agent}
          onToggleSearch={() => setSearchOpen((v) => !v)}
          searchActive={searchOpen}
        />
      )}
      {tab === "transcript" && searchOpen && (
        <TranscriptSearchBar
          query={searchQuery}
          matchCount={matchIds.length}
          matchIdx={searchMatchIdx}
          onChange={setSearchQuery}
          onNext={() => stepMatch(1)}
          onPrev={() => stepMatch(-1)}
          onClose={closeSearch}
        />
      )}
      <div className="inspector-body" ref={ref}>
        {tab === "transcript" && (
          <>
            {loadingOlder && (
              <div className="inspector-empty" style={{ textAlign: "center", padding: "8px 0" }}>
                Loading older…
              </div>
            )}
            <Transcript
              events={filteredEvents}
              sessionId={sessionId}
              agent={agent}
              flashEventId={flashEventId}
              highlightQuery={isSearching ? trimmedQuery : ""}
            />
          </>
        )}
        {tab === "artefacts" && <Artefacts items={artefacts} onSwitchTo={onSwitchTo} />}
        {tab === "memory" && <MemoryTab memory={memory} memoryError={memoryError} onSwitchTo={onSwitchTo} sessionId={sessionId} />}
      </div>
      {tab === "transcript" && showScrollBottom && (
        <button
          type="button"
          className="transcript-scroll-bottom"
          onClick={scrollToBottom}
          aria-label="Scroll to bottom of transcript"
          title="Scroll to bottom"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="12" y1="5" x2="12" y2="19" />
            <polyline points="19 12 12 19 5 12" />
          </svg>
        </button>
      )}
    </>
  );
}

function TranscriptSearchBar({
  query, matchCount, matchIdx, onChange, onNext, onPrev, onClose,
}: {
  query: string;
  matchCount: number;
  matchIdx: number;
  onChange: (v: string) => void;
  onNext: () => void;
  onPrev: () => void;
  onClose: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { inputRef.current?.focus(); inputRef.current?.select(); }, []);
  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") { onClose(); return; }
    if (e.key === "Enter") {
      e.preventDefault();
      e.shiftKey ? onPrev() : onNext();
      return;
    }
  }
  const counter = query.trim()
    ? (matchCount === 0 ? "0" : `${matchIdx + 1}/${matchCount}`)
    : "";
  return (
    <div className="transcript-search">
      <input
        ref={inputRef}
        className="transcript-search-input"
        placeholder="Find in transcript…"
        value={query}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
      />
      <span className="transcript-search-count">{counter}</span>
      <button
        type="button"
        className="transcript-search-step"
        onClick={onPrev}
        disabled={matchCount === 0}
        aria-label="Previous match"
        title="Previous match (Shift+Enter)"
      >
        ↑
      </button>
      <button
        type="button"
        className="transcript-search-step"
        onClick={onNext}
        disabled={matchCount === 0}
        aria-label="Next match"
        title="Next match (Enter)"
      >
        ↓
      </button>
      <button
        type="button"
        className="transcript-search-close"
        onClick={onClose}
        aria-label="Close search (Esc)"
      >
        ✕
      </button>
    </div>
  );
}

function TranscriptFilter({
  visible, onToggle, agent, onToggleSearch, searchActive,
}: {
  visible: Set<RoleCategory>;
  onToggle: (cat: RoleCategory) => void;
  agent: SessionAgent;
  onToggleSearch: () => void;
  searchActive: boolean;
}) {
  const labels: Array<[RoleCategory, string]> = [
    ["user", "User"],
    ["assistant", agent.toUpperCase()],
    ["tools", "Tools"],
    ["system", "System"],
    ["thinking", "Thinking"],
  ];
  return (
    <div className="transcript-filter" role="group" aria-label="Filter transcript by role">
      <button
        type="button"
        className={`transcript-filter-search${searchActive ? " active" : ""}`}
        onClick={onToggleSearch}
        aria-label={searchActive ? "Close search" : "Find in transcript"}
        aria-pressed={searchActive}
        title={searchActive ? "Close search (Esc)" : "Find in transcript (Cmd+F)"}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="11" cy="11" r="8" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
      </button>
      {labels.map(([cat, label]) => (
        <button
          key={cat}
          type="button"
          className={`transcript-filter-chip${visible.has(cat) ? " active" : ""}`}
          onClick={() => onToggle(cat)}
          aria-pressed={visible.has(cat)}
        >
          {label}
        </button>
      ))}
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
        <button type="button" className="close" onClick={onClose} aria-label="Close inspector">✕</button>
      </div>
      <div className="inspector-title">{session.title ?? "(no title yet)"}</div>
      <div className="inspector-sub">
        {session.id} · started {formatTs(session.startedAt)}
        {session.model ? ` · ${session.model}` : ""}
      </div>
      <SessionActions session={session} />
    </header>
  );
}

// POSIX single-quote: wrap in 's, replace embedded ' with '\''. Keeps
// paths with spaces, $, backticks, etc. literal so resume can be pasted
// straight into bash/zsh.
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

function SessionActions({ session }: { session: Session }) {
  const [copiedCmd, setCopiedCmd] = useState(false);
  const [copiedId, setCopiedId] = useState(false);
  // `cd --` disables option parsing so a path beginning with `-` (or
  // the literal `-`, which would otherwise mean "previous dir") is
  // taken as a positional path argument. Single-quoting handles
  // spaces/$/backticks; `--` handles the leading-dash edge case.
  const command = session.cwd
    ? `cd -- ${shellQuote(session.cwd)} && claude --resume ${session.id}`
    : `claude --resume ${session.id}`;

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
    if (!navigator.clipboard) {
      alert(`Copy failed — session id:\n${session.id}`);
      return;
    }
    navigator.clipboard.writeText(session.id).then(
      () => {
        setCopiedId(true);
        setTimeout(() => setCopiedId(false), 1500);
      },
      () => alert(`Copy failed — session id:\n${session.id}`),
    );
  }

  return (
    <div className="inspector-actions">
      <button type="button" className="btn primary" onClick={copyCommand}>
        {copiedCmd ? "Copied!" : "Copy resume command"}
      </button>
      <button type="button" className="btn" onClick={copyId}>
        {copiedId ? "Copied!" : "Copy session ID"}
      </button>
    </div>
  );
}

function Banner({ session }: { session: Session }) {
  if (session.state === "disconnected") {
    return (
      <div className="inspector-banner disconnected">
        <div>
          Quiet since <strong>{formatRel(session.lastEventAt)}</strong>. The agent looks like it's closed — copy the resume command above to pick it back up.
        </div>
      </div>
    );
  }
  if (session.state === "waiting") {
    return (
      <div className="inspector-banner waiting">
        <div>
          The agent is waiting on you — usually for tool approval. Open the terminal where it's running to respond.
        </div>
      </div>
    );
  }
  return null;
}

function Tabs({
  tab, setTab, eventsCount, hasMoreOlder, artefactsCount, memoryCount,
}: {
  tab: Tab;
  setTab: (t: Tab) => void;
  eventsCount: number;
  hasMoreOlder: boolean;
  artefactsCount: number;
  memoryCount: number;
}) {
  // While older events haven't all been loaded, clamp the badge to "1000+"
  // — the loaded count grows as the user scrolls, but the user wants the
  // single "more than a thousand" signal, not an interim 2000+/3000+/…
  const transcriptLabel = hasMoreOlder ? "1000+" : String(eventsCount);
  return (
    <div className="inspector-tabs">
      <button
        type="button"
        className={`inspector-tab${tab === "transcript" ? " active" : ""}`}
        onClick={() => setTab("transcript")}
      >
        Transcript <span className="badge">{transcriptLabel}</span>
      </button>
      <button
        type="button"
        className={`inspector-tab${tab === "artefacts" ? " active" : ""}`}
        onClick={() => setTab("artefacts")}
      >
        Artefacts <span className="badge">{artefactsCount}</span>
      </button>
      <button
        type="button"
        className={`inspector-tab${tab === "memory" ? " active" : ""}`}
        onClick={() => setTab("memory")}
      >
        Memory <span className="badge">{memoryCount}</span>
      </button>
    </div>
  );
}

function MemoryTab({
  memory, memoryError, onSwitchTo, sessionId,
}: {
  memory: SessionMemory | null;
  memoryError: string | null;
  onSwitchTo: (next: ActivePanel) => void;
  sessionId: string;
}) {
  if (memoryError) {
    return (
      <div className="inspector-empty">
        Couldn't load memory traffic: {memoryError}
      </div>
    );
  }
  if (memory === null) return <div className="inspector-empty">Loading memory…</div>;
  // Both sections always render with their badges, even when empty —
  // keeps the structure stable so a 0-count is a real "the agent hasn't
  // written/pulled anything here" signal, not a missing affordance.
  return (
    <div className="memory-tab">
      <MemorySection
        title="Written by this session"
        emptyHint="No memories were written by this session yet."
        timestampOf={(m) => m.created_at}
        items={memory.written}
        sessionId={sessionId}
        onSwitchTo={onSwitchTo}
      />
      <MemorySection
        title="Pulled into this session"
        emptyHint="No memories were recalled in this session yet."
        timestampOf={(m) => m.recalled_at ?? m.created_at}
        items={memory.pulled}
        sessionId={sessionId}
        onSwitchTo={onSwitchTo}
      />
    </div>
  );
}

function MemorySection({
  title, emptyHint, items, sessionId, onSwitchTo, timestampOf,
}: {
  title: string;
  emptyHint: string;
  items: SessionMemoryEntry[];
  sessionId: string;
  onSwitchTo: (next: ActivePanel) => void;
  timestampOf: (m: SessionMemoryEntry) => string;
}) {
  return (
    <section className="memory-section">
      <h3 className="memory-section-title">{title} <span className="badge">{items.length}</span></h3>
      {items.length === 0 ? (
        <div className="memory-section-empty">{emptyHint}</div>
      ) : (
        <ul className="memory-list">
          {items.map((m) => (
            <MemoryRow
              key={m.id}
              memory={m}
              displayTs={timestampOf(m)}
              currentSessionId={sessionId}
              onSwitchTo={onSwitchTo}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function MemoryRow({
  memory, displayTs, currentSessionId, onSwitchTo,
}: {
  memory: SessionMemoryEntry;
  displayTs: string;
  currentSessionId: string;
  onSwitchTo: (next: ActivePanel) => void;
}) {
  // Source link only appears when (a) the memory has an attributable
  // source, and (b) it isn't this very session — pointing the user at
  // the inspector they already have open is noise.
  const showSource = memory.source_session_id && memory.source_session_id !== currentSessionId;
  return (
    <li className="memory-row">
      <div className="memory-row-content">{memory.content}</div>
      <div className="memory-row-meta">
        {memory.space_id && <span className="memory-row-space">{memory.space_id}</span>}
        {memory.tags.length > 0 && memory.tags.map((t) => (
          <span key={t} className="memory-row-tag">{t}</span>
        ))}
        {showSource && (
          <button
            type="button"
            className="memory-row-source"
            onClick={() => onSwitchTo({ kind: "session", id: memory.source_session_id! })}
            title={`Open source session: ${memory.source_session_title ?? memory.source_session_id}`}
          >
            from {memory.source_session_title ?? memory.source_session_id!.slice(0, 8)}
          </button>
        )}
        <span className="memory-row-ts">{formatTs(displayTs)}</span>
      </div>
    </li>
  );
}

function Transcript({
  events, sessionId, agent, flashEventId, highlightQuery,
}: {
  events: SessionEvent[] | null;
  sessionId: string;
  agent: SessionAgent;
  flashEventId: number | undefined;
  highlightQuery: string;
}) {
  if (events === null) return <div className="inspector-empty">Loading transcript…</div>;
  if (events.length === 0) {
    return <div className="inspector-empty">No transcript yet. Live updates active.</div>;
  }
  return (
    <>
      {events.map((e) => (
        <Turn
          key={e.id}
          event={e}
          sessionId={sessionId}
          agent={agent}
          flash={e.id === flashEventId}
          highlightQuery={highlightQuery}
        />
      ))}
    </>
  );
}

function Turn({
  event, sessionId, agent, flash, highlightQuery,
}: {
  event: SessionEvent;
  sessionId: string;
  agent: SessionAgent;
  flash: boolean;
  highlightQuery: string;
}) {
  const isToolish =
    event.role === "tool"
    || event.role === "tool_result"
    || (event.role === "assistant" && TOOL_ONLY_RE.test(event.text.trim()));
  if (isToolish) {
    return <ToolTurn event={event} sessionId={sessionId} flash={flash} highlightQuery={highlightQuery} />;
  }
  const label = event.role === "assistant" ? agent.toUpperCase() : event.role.toUpperCase();
  return (
    <div className={`turn ${event.role}${flash ? " turn-flash" : ""}`} data-event-id={event.id}>
      <div className="turn-role">{label}</div>
      <div className="turn-text">
        {event.text
          ? <Highlighted text={event.text} query={highlightQuery} />
          : "(empty)"}
      </div>
    </div>
  );
}

/** Renders text with case-insensitive substring matches wrapped in
 *  <mark> spans. Used by the in-transcript find-box (#332) to make the
 *  match visible inline, not just as a turn-level flash. */
function Highlighted({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>;
  const lower = text.toLowerCase();
  const q = query.toLowerCase();
  const parts: Array<{ text: string; mark: boolean }> = [];
  let i = 0;
  while (i < text.length) {
    const found = lower.indexOf(q, i);
    if (found === -1) {
      parts.push({ text: text.slice(i), mark: false });
      break;
    }
    if (found > i) parts.push({ text: text.slice(i, found), mark: false });
    parts.push({ text: text.slice(found, found + q.length), mark: true });
    i = found + q.length;
  }
  return (
    <>
      {parts.map((p, idx) => p.mark
        ? <mark key={idx} className="turn-text-match">{p.text}</mark>
        : <span key={idx}>{p.text}</span>)}
    </>
  );
}

function ToolTurn({
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
      <div className="turn-tool-summary" onClick={toggle}>
        {open ? "▾" : "▸"} <Highlighted text={summary} query={highlightQuery} />
      </div>
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

const ROLE_PRIORITY = { create: 3, modify: 2, read: 1 } as const;

/**
 * Collapse repeated touches of the same artefact into one row, keeping the
 * highest-impact role (create > modify > read) and the most recent timestamp.
 * A long session may Read+Edit the same file many times; the user wants one
 * "this artefact was modified" row, not the full audit trail.
 */
function dedupeTouches(items: SessionArtifactJoined[]): SessionArtifactJoined[] {
  const byId = new Map<string, SessionArtifactJoined>();
  for (const item of items) {
    const existing = byId.get(item.artifact.id);
    if (!existing) {
      byId.set(item.artifact.id, item);
      continue;
    }
    const incomingPriority = ROLE_PRIORITY[item.role];
    const existingPriority = ROLE_PRIORITY[existing.role];
    if (incomingPriority > existingPriority) {
      byId.set(item.artifact.id, item);
    } else if (incomingPriority === existingPriority && item.whenAt > existing.whenAt) {
      byId.set(item.artifact.id, item);
    }
  }
  return Array.from(byId.values()).sort((a, b) => {
    const dp = ROLE_PRIORITY[b.role] - ROLE_PRIORITY[a.role];
    if (dp !== 0) return dp;
    return b.whenAt.localeCompare(a.whenAt);
  });
}

function Artefacts({
  items, onSwitchTo,
}: {
  items: SessionArtifactJoined[] | null;
  onSwitchTo: (next: ActivePanel) => void;
}) {
  if (items === null) return <div className="inspector-empty">Loading artefacts…</div>;
  const deduped = dedupeTouches(items);
  if (deduped.length === 0) {
    return <div className="inspector-empty">No artefacts touched yet.</div>;
  }
  return (
    <>
      {deduped.map((item) => (
        <button
          type="button"
          key={item.artifact.id}
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
        </button>
      ))}
    </>
  );
}

// KindThumb is extracted to its own file (created earlier in Task 4 — see KindThumb.tsx)


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
