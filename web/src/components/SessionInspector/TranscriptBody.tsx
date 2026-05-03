// TranscriptBody — extracted from SessionInspector for navigability.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type {
  SessionAgent,
  SessionArtifactJoined,
  SessionEvent,
  SessionMemory,
} from "../../data/sessions-api";
import type { Artifact } from "../../data/artifacts-api";
import type { ActivePanel } from "../InspectorPanel";
import { Artefacts } from "./Artefacts";
import { MemoryTab } from "./MemoryTab";
import { Transcript } from "./Transcript";
import { TranscriptFilter } from "./TranscriptFilter";
import { TranscriptSearchBar } from "./TranscriptSearchBar";
import type { RoleCategory, Tab } from "./types";
import { categoryOf, loadVisibleCategories, saveVisibleCategories } from "./utils";

/**
 * Scroll-to-bottom container for the transcript.
 *
 * Default behaviour: scroll to the latest turn on initial load and on
 * subsequent live updates — but only if the user was already within
 * 80px of the bottom (i.e. "following along"). If they've scrolled up
 * to read history, leave them there.
 */
export function TranscriptBody({
  tab, events, artefacts, memory, memoryError, focusEventId, initialSearchQuery,
  onSwitchTo, onOpenArtefact, sessionId, agent, hasMoreOlder, loadingOlder, onLoadOlder,
}: {
  tab: Tab;
  events: SessionEvent[] | null;
  artefacts: SessionArtifactJoined[] | null;
  memory: SessionMemory | null;
  memoryError: string | null;
  focusEventId: number | undefined;
  initialSearchQuery: string | undefined;
  onSwitchTo: (next: ActivePanel) => void;
  onOpenArtefact: (artefact: Artifact) => void;
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
  // O(1) lookup for the filter pass below — Array.includes would make
  // the per-render filter O(n×m) on long transcripts with many matches.
  const matchIdSet = useMemo(() => new Set(matchIds), [matchIds]);

  // Always include deep-link / search targets in the rendered list, even
  // if their category is filtered out. Otherwise a Spotlight click on a
  // tool_result with Tools off lands on no DOM target. Same for
  // in-transcript search hits — strip them and the user can't see what
  // they searched for.
  const filteredEvents = useMemo(() => events
    ? events.filter((e) =>
        visible.has(categoryOf(e))
        || e.id === focusEventId
        || matchIdSet.has(e.id),
      )
    : null,
  [events, visible, focusEventId, matchIdSet]);
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
        {tab === "artefacts" && <Artefacts items={artefacts} onOpenArtefact={onOpenArtefact} />}
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
