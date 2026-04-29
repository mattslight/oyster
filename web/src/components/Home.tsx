import { useEffect, useMemo, useState } from "react";
import type { Session, SessionState, SessionAgent } from "../data/sessions-api";
import type { Memory } from "../data/memories-api";
import { createMemory } from "../data/memories-api";
import type { Space } from "../../../shared/types";
import { useSessions } from "../hooks/useSessions";
import { useMemories } from "../hooks/useMemories";
import { useSpaceSources } from "../hooks/useSpaceSources";
import type { SpaceSource } from "../data/spaces-api";
import { addSpaceSource, removeSpaceSource } from "../data/spaces-api";
import { parseTimestamp } from "../utils/parseTimestamp";
import { Desktop } from "./Desktop";
import { InspectorPanel, type ActivePanel } from "./InspectorPanel";
import { SessionInspector } from "./SessionInspector";
import { ArtefactInspector } from "./ArtefactInspector";
import { ConfirmModal } from "./ConfirmModal";
import "./Home.css";

interface Props {
  activeSpace: string;
  spaces: Space[];
  desktopProps: Omit<Parameters<typeof Desktop>[0], "isHero">;
  isHero?: boolean;
  onSpaceChange: (space: string) => void;
}

type ViewMode = "icons" | "table";
type StateFilter = SessionState | "live" | "all";
type ArtefactSource = "all" | "manual" | "ai_generated" | "discovered";

const ARTEFACT_SOURCE_ORDER: ArtefactSource[] = ["all", "manual", "ai_generated", "discovered"];
const ARTEFACT_SOURCE_LABELS: Record<ArtefactSource, string> = {
  all: "all",
  manual: "mine",
  ai_generated: "from agents",
  discovered: "linked",
};

// 3 rows × ~7 tiles in the default 1100px column ≈ 21. The grid is
// responsive so the visible count varies by width — picking a fixed cap
// keeps the truncation predictable, and the "Show all N" toggle is the
// safety valve for narrow viewports where 21 fills less of the screen.
const ARTEFACTS_PREVIEW = 21;

// Persists a view toggle (icons / table) to localStorage so it survives
// reloads. Returns a useState-shaped pair so callsites stay one-liner.
function useStickyView(key: string, defaultValue: ViewMode): [ViewMode, (v: ViewMode) => void] {
  const [value, setValue] = useState<ViewMode>(() => {
    if (typeof window === "undefined") return defaultValue;
    try {
      const stored = window.localStorage.getItem(key);
      return stored === "icons" || stored === "table" ? stored : defaultValue;
    } catch {
      // Safari private browsing / storage disabled — fall through to default
      return defaultValue;
    }
  });
  const set = (v: ViewMode) => {
    setValue(v);
    try {
      window.localStorage.setItem(key, v);
    } catch {
      // private browsing / disabled storage — fine, just lose persistence
    }
  };
  return [value, set];
}

// "live" is a preset bundling active+waiting+disconnected (everything that
// isn't archived). It's the default because that's the common case — done
// is review/history, not active inventory. The dot after "live" indicates
// the live cluster ends; the per-state chips after it are for fine-grained
// filtering.
const FILTER_ORDER: StateFilter[] = ["live", "active", "waiting", "disconnected", "done", "all"];
const LIVE_STATES: SessionState[] = ["active", "waiting", "disconnected"];

const EMPTY_COUNTS = { total: 0, active: 0, waiting: 0, disconnected: 0, done: 0 };

// Memory list shows this many rows by default; user clicks "Show all N"
// to expand. Five is small enough to fit alongside Sessions and Artefacts
// without scroll-thrash, large enough that single-space views (typically
// <5 memories) stay fully visible.
const MEMORIES_PREVIEW = 5;

const FILTER_LABELS: Record<StateFilter, string> = {
  live: "live",
  active: "active",
  waiting: "waiting",
  disconnected: "disconnected",
  done: "done",
  all: "all",
};

const AGENT_LETTERS: Record<SessionAgent, string> = {
  "claude-code": "CC",
  opencode: "OC",
  codex: "CX",
};

const AGENT_CLASS: Record<SessionAgent, string> = {
  "claude-code": "agent-cc",
  opencode: "agent-oc",
  codex: "agent-codex",
};

const AGENT_PIP_CLASS: Record<SessionAgent, string> = {
  "claude-code": "cc",
  opencode: "oc",
  codex: "codex",
};

export function Home({ activeSpace, spaces, desktopProps, isHero, onSpaceChange }: Props) {
  const { sessions, error, loading } = useSessions();
  const {
    memories,
    loading: memoriesLoading,
    error: memoriesError,
    refresh: refreshMemories,
  } = useMemories();
  // Space sources only fetch when scoped to a real space — Home / Elsewhere
  // / All / Archived don't have a single source list. Identifies the
  // "zero sources attached" pitfall (#266) at a glance.
  const isMetaScope = activeSpace === "home" || activeSpace === "__all__" || activeSpace === "__archived__";
  const sourcesSpaceId = !isMetaScope ? activeSpace : null;
  const {
    sources: spaceSources,
    loading: spaceSourcesLoading,
    error: spaceSourcesError,
    refresh: refreshSpaceSources,
  } = useSpaceSources(sourcesSpaceId);
  const [showAttachForm, setShowAttachForm] = useState(false);
  // Reset the attach form whenever scope changes so it doesn't carry
  // across spaces.
  useEffect(() => { setShowAttachForm(false); }, [sourcesSpaceId]);
  const [stateFilter, setStateFilter] = useState<StateFilter>("live");
  const [sessionsView, setSessionsView] = useStickyView("oyster.home.sessionsView", "icons");
  const [artefactsView, setArtefactsView] = useStickyView("oyster.home.artefactsView", "icons");
  const [activePanel, setActivePanel] = useState<ActivePanel | null>(null);

  // Local "Elsewhere" scope: filters Sessions to those whose spaceId is null
  // (claude/codex sessions started in folders that aren't attached to any
  // registered space). Only applies in Home view; navigating to a real space
  // resets it.
  const [showElsewhere, setShowElsewhere] = useState(false);
  // Memories collapse: long lists are noisy on Home. Default to 5 rows;
  // "Show all" expands. Resets when the user changes scope so a different
  // space starts collapsed too.
  const [memoriesLimit, setMemoriesLimit] = useState(MEMORIES_PREVIEW);
  const [showAddMemory, setShowAddMemory] = useState(false);
  // Artefact source filter (#280) + 3-row collapse. Reset on scope change
  // so each space starts compact and at "all".
  const [artefactSource, setArtefactSource] = useState<ArtefactSource>("all");
  const [artefactsLimit, setArtefactsLimit] = useState(ARTEFACTS_PREVIEW);

  const isHomeView = activeSpace === "home";
  const isAllView = activeSpace === "__all__";
  const isArchivedView = activeSpace === "__archived__";
  const isMetaView = isHomeView || isAllView || isArchivedView;
  const scopedSpace = !isMetaView ? activeSpace : null;

  // Reset Elsewhere scope when we navigate away from Home (e.g. user clicks
  // a real space card or chat-bar pill).
  useEffect(() => {
    if (!isHomeView) setShowElsewhere(false);
  }, [isHomeView]);

  // Collapse limits + filter reset on scope change — switching from a
  // 60-item Home view to a single-space view shouldn't carry over either
  // the "show more" depth or the source filter.
  useEffect(() => {
    setMemoriesLimit(MEMORIES_PREVIEW);
    setArtefactsLimit(ARTEFACTS_PREVIEW);
    setArtefactSource("all");
  }, [scopedSpace, showElsewhere, isHomeView]);

  const scopedSessions = useMemo(() => {
    if (showElsewhere && isHomeView) return sessions.filter((s) => s.spaceId === null);
    return scopedSpace ? sessions.filter((s) => s.spaceId === scopedSpace) : sessions;
  }, [sessions, scopedSpace, showElsewhere, isHomeView]);

  const stateCounts = useMemo(() => {
    const counts: Record<StateFilter, number> = { live: 0, active: 0, waiting: 0, disconnected: 0, done: 0, all: scopedSessions.length };
    for (const s of scopedSessions) counts[s.state]++;
    counts.live = counts.active + counts.waiting + counts.disconnected;
    return counts;
  }, [scopedSessions]);

  const visibleSessions = useMemo(() => {
    if (stateFilter === "all") return scopedSessions;
    if (stateFilter === "live") return scopedSessions.filter((s) => LIVE_STATES.includes(s.state));
    return scopedSessions.filter((s) => s.state === stateFilter);
  }, [scopedSessions, stateFilter]);

  // Per-space session counts + a separate orphan tally (sessions with
  // spaceId === null) + a grand total for the Home card, plus the most
  // recent lastEventAt per space so we can sort the cards by activity.
  const { sessionCountsBySpace, orphanCounts, totalCounts, lastActivityBySpace } = useMemo(() => {
    const bySpace: Record<string, { total: number; active: number; waiting: number; disconnected: number; done: number }> = {};
    const orphans = { total: 0, active: 0, waiting: 0, disconnected: 0, done: 0 };
    const total = { total: 0, active: 0, waiting: 0, disconnected: 0, done: 0 };
    const lastActivity: Record<string, number> = {};
    for (const s of sessions) {
      total.total++;
      total[s.state]++;
      if (s.spaceId) {
        const c = bySpace[s.spaceId] ?? { total: 0, active: 0, waiting: 0, disconnected: 0, done: 0 };
        c.total++;
        c[s.state]++;
        bySpace[s.spaceId] = c;
        const t = parseTimestamp(s.lastEventAt);
        if (Number.isFinite(t) && t > (lastActivity[s.spaceId] ?? 0)) {
          lastActivity[s.spaceId] = t;
        }
      } else {
        orphans.total++;
        orphans[s.state]++;
      }
    }
    return { sessionCountsBySpace: bySpace, orphanCounts: orphans, totalCounts: total, lastActivityBySpace: lastActivity };
  }, [sessions]);

  // Drop meta-spaces from the Spaces summary cards: the chat bar already
  // renders Home as its own pill, so a `home` row in the spaces table would
  // surface a redundant card. __all__ and __archived__ are similar.
  // Sort by most recent session activity desc; spaces with no sessions
  // fall to the bottom in their original (alphabetical) order. Home and
  // Elsewhere cards are rendered around this list — always first / always
  // last regardless of activity.
  const realSpaces = useMemo(() => {
    const filtered = spaces.filter((s) => s.id !== "home" && s.id !== "__all__" && s.id !== "__archived__");
    return [...filtered].sort((a, b) => {
      const aT = lastActivityBySpace[a.id] ?? 0;
      const bT = lastActivityBySpace[b.id] ?? 0;
      return bT - aT;
    });
  }, [spaces, lastActivityBySpace]);

  // Memories scope mirrors the server `list(space_id)` semantics: a real
  // space includes both memories explicitly tagged with that space AND
  // global memories (no space_id) — globals are meant to apply everywhere,
  // and the agent's `recall(query, space_id)` already returns scope+global,
  // so the human-browsing surface should match.
  // Elsewhere narrows to memories not bound to any currently-known space
  // (orphans + memories pointing at deleted spaces).
  const scopedMemories = useMemo(() => {
    if (showElsewhere && isHomeView) {
      const real = new Set(spaces.filter((s) => s.id !== "home" && s.id !== "__all__" && s.id !== "__archived__").map((s) => s.id));
      return memories.filter((m) => !m.space_id || !real.has(m.space_id));
    }
    return scopedSpace
      ? memories.filter((m) => !m.space_id || m.space_id === scopedSpace)
      : memories;
  }, [memories, scopedSpace, showElsewhere, isHomeView, spaces]);

  // When scoped to Elsewhere, artefacts should mirror the sessions filter:
  // anything not attributed to a known real space (null spaceId or a stale
  // pointer to a deleted space). App.tsx hands us all artefacts on home —
  // we narrow them locally so artefacts and sessions tell the same story.
  const realSpaceIds = useMemo(() => new Set(realSpaces.map((s) => s.id)), [realSpaces]);
  const effectiveDesktopProps = useMemo(() => {
    if (showElsewhere && isHomeView) {
      return {
        ...desktopProps,
        artifacts: desktopProps.artifacts.filter((a) => !a.spaceId || !realSpaceIds.has(a.spaceId)),
      };
    }
    return desktopProps;
  }, [showElsewhere, isHomeView, desktopProps, realSpaceIds]);

  // Source-origin counts over the scoped artefacts (so the chip totals
  // reflect the current space pill, not the global pile).
  const artefactSourceCounts = useMemo(() => {
    const counts: Record<ArtefactSource, number> = { all: 0, manual: 0, ai_generated: 0, discovered: 0 };
    counts.all = effectiveDesktopProps.artifacts.length;
    for (const a of effectiveDesktopProps.artifacts) {
      const o = a.sourceOrigin ?? "manual";
      if (o === "manual" || o === "ai_generated" || o === "discovered") counts[o]++;
    }
    return counts;
  }, [effectiveDesktopProps.artifacts]);

  // Filter + collapse to an incremental preview. Each "Show more" click
  // grows artefactsLimit by ARTEFACTS_PREVIEW; the table view bypasses
  // the cap because it's already linear and easy to scan.
  const filteredArtefacts = useMemo(() => {
    if (artefactSource === "all") return effectiveDesktopProps.artifacts;
    return effectiveDesktopProps.artifacts.filter((a) => (a.sourceOrigin ?? "manual") === artefactSource);
  }, [effectiveDesktopProps.artifacts, artefactSource]);
  const visibleArtefacts = useMemo(() => {
    if (artefactsView === "table") return filteredArtefacts;
    return filteredArtefacts.slice(0, artefactsLimit);
  }, [filteredArtefacts, artefactsView, artefactsLimit]);
  const filteredArtefactsTotal = filteredArtefacts.length;

  // Resolve the active artefact against the FULL artifact list, not the
  // showElsewhere-filtered one. Cross-navigating from a session inspector
  // to an artefact in a different scope (e.g. clicking a registered-space
  // artefact while the user is in Elsewhere mode) shouldn't close the panel.
  const activeArtefact = activePanel?.kind === "artefact"
    ? desktopProps.artifacts.find((a) => a.id === activePanel.id)
    : null;

  // Close the panel if the active artefact disappears (e.g. archived from under the inspector)
  useEffect(() => {
    if (activePanel?.kind === "artefact" && !activeArtefact) {
      setActivePanel(null);
    }
  }, [activePanel, activeArtefact]);

  const activeSpaceRow = scopedSpace ? spaces.find((s) => s.id === scopedSpace) : null;
  const eyebrow = isHomeView ? (showElsewhere ? "Elsewhere" : "Home")
    : isAllView ? "All"
    : isArchivedView ? "Archived"
    : activeSpaceRow?.displayName ?? scopedSpace ?? "";

  return (
    <div className="home">
      <div className="home-glow" />
      <div className="home-orb" />
      <div className="home-grain" />

      <div className={`home-scroll${isHero ? " home-scroll--hero" : ""}`}>
        <header className="home-header">
          <div className="home-eyebrow">{eyebrow}</div>
          <h1 className="home-title">{isHomeView ? (showElsewhere ? "Everything else." : "Everything.") : eyebrow}</h1>
          {error && <div className="home-error">Couldn't load sessions: {error.message}</div>}
        </header>

        {!isAllView && !isArchivedView && (realSpaces.length > 0 || orphanCounts.total > 0) && (
          <div className="home-spaces-section">
            <div className="home-spaces-grid">
              <button
                className={`home-space-card home-space-card--home${isHomeView && !showElsewhere ? " selected" : ""}`}
                onClick={() => {
                  setShowElsewhere(false);
                  onSpaceChange("home");
                }}
                title="Everything across all spaces"
              >
                <div className="home-space-card-name">Home</div>
                <div className="home-space-card-counts">
                  {totalCounts.active > 0 && <span className="signal"><span className="pip pip-green" />{totalCounts.active} active</span>}
                  {totalCounts.waiting > 0 && <span className="signal"><span className="pip pip-amber" />{totalCounts.waiting} waiting</span>}
                  {totalCounts.disconnected > 0 && <span className="signal"><span className="pip pip-red" />{totalCounts.disconnected} disconnected</span>}
                  {totalCounts.done > 0 && <span className="signal"><span className="pip pip-dim" />{totalCounts.done} done</span>}
                  {totalCounts.total === 0 && <span className="signal signal-muted">no sessions yet</span>}
                </div>
              </button>
              {realSpaces.map((space) => {
                const counts = sessionCountsBySpace[space.id] ?? EMPTY_COUNTS;
                const isActive = scopedSpace === space.id;
                return (
                  <button
                    key={space.id}
                    className={`home-space-card${isActive ? " selected" : ""}`}
                    onClick={() => onSpaceChange(space.id)}
                  >
                    <div className="home-space-card-name">{space.displayName}</div>
                    <div className="home-space-card-counts">
                      {counts.active > 0 && <span className="signal"><span className="pip pip-green" />{counts.active} active</span>}
                      {counts.waiting > 0 && <span className="signal"><span className="pip pip-amber" />{counts.waiting} waiting</span>}
                      {counts.disconnected > 0 && <span className="signal"><span className="pip pip-red" />{counts.disconnected} disconnected</span>}
                      {counts.done > 0 && <span className="signal"><span className="pip pip-dim" />{counts.done} done</span>}
                      {counts.total === 0 && <span className="signal signal-muted">no sessions yet</span>}
                    </div>
                  </button>
                );
              })}
              {orphanCounts.total > 0 && (
                <button
                  className={`home-space-card home-space-card--elsewhere${isHomeView && showElsewhere ? " selected" : ""}`}
                  onClick={() => {
                    if (isHomeView) {
                      setShowElsewhere((v) => !v);
                    } else {
                      setShowElsewhere(true);
                      onSpaceChange("home");
                    }
                  }}
                  title="Sessions outside any registered space"
                >
                  <div className="home-space-card-name">Elsewhere</div>
                  <div className="home-space-card-counts">
                    {orphanCounts.active > 0 && <span className="signal"><span className="pip pip-green" />{orphanCounts.active} active</span>}
                    {orphanCounts.waiting > 0 && <span className="signal"><span className="pip pip-amber" />{orphanCounts.waiting} waiting</span>}
                    {orphanCounts.disconnected > 0 && <span className="signal"><span className="pip pip-red" />{orphanCounts.disconnected} disconnected</span>}
                    {orphanCounts.done > 0 && <span className="signal"><span className="pip pip-dim" />{orphanCounts.done} done</span>}
                  </div>
                </button>
              )}
            </div>
          </div>
        )}

        {sourcesSpaceId && (
          <section className="home-section">
            <div className="home-section-head">
              <span className="home-section-label">Folders</span>
              <span className="home-artefacts-count">{spaceSources.length}</span>
              <span className="home-section-rule" />
              <button
                type="button"
                className="home-memories-add-btn"
                onClick={() => setShowAttachForm((v) => !v)}
                aria-expanded={showAttachForm}
              >
                {showAttachForm ? "Cancel" : "+ Attach folder"}
              </button>
            </div>
            {showAttachForm && (
              <AttachFolderForm
                spaceId={sourcesSpaceId}
                onAttached={() => {
                  setShowAttachForm(false);
                  refreshSpaceSources();
                }}
                onCancel={() => setShowAttachForm(false)}
              />
            )}
            {spaceSourcesError ? (
              <div className="home-empty">
                Couldn't load folders: {spaceSourcesError.message}
              </div>
            ) : spaceSourcesLoading && spaceSources.length === 0 ? (
              <div className="home-empty">Loading folders…</div>
            ) : spaceSources.length === 0 ? (
              <div className="home-empty home-folders-empty">
                <strong>No folders attached to this space.</strong>{" "}
                Sessions started in unattached folders land in Elsewhere,
                and tile discovery relies on these.{" "}
                <span className="home-folders-empty-hint">
                  Click <em>+ Attach folder</em> above, or use{" "}
                  <code>/attach &lt;path&gt;</code> from the chat bar.
                </span>
              </div>
            ) : (
              <div className="home-memories-wrap">
                <div className="home-memories">
                  {spaceSources.map((s) => (
                    <FolderRow
                      key={s.id}
                      source={s}
                      onDetach={async () => {
                        try {
                          await removeSpaceSource(s.space_id, s.id);
                          refreshSpaceSources();
                        } catch (err) {
                          alert(`Couldn't detach: ${err instanceof Error ? err.message : String(err)}`);
                        }
                      }}
                    />
                  ))}
                </div>
              </div>
            )}
          </section>
        )}

        <section className="home-section">
          <div className="home-section-head">
            <span className="home-section-label">Sessions</span>
            <span className="home-section-stats">
              {FILTER_ORDER.map((f) => {
                const count = stateCounts[f];
                if (count === 0 && f !== "all" && f !== "live") return null;
                const showPip = f !== "all" && f !== "live";
                return (
                  <span key={f} style={{ display: "contents" }}>
                    <button
                      className={`stat-btn${stateFilter === f ? " active" : ""}`}
                      onClick={() => setStateFilter(f)}
                    >
                      {showPip && <span className={`pip pip-${stateColor(f as SessionState)}`} />}
                      {count} {FILTER_LABELS[f]}
                    </button>
                    {f === "live" && <span className="stat-divider" aria-hidden="true" />}
                  </span>
                );
              })}
            </span>
            <span className="home-section-rule" />
            <div className="home-view-toggle">
              <button
                className={`view-btn${sessionsView === "icons" ? " active" : ""}`}
                onClick={() => setSessionsView("icons")}
                title="Icon view"
                aria-label="Icon view"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="3" width="7" height="7" rx="1.5" />
                  <rect x="14" y="3" width="7" height="7" rx="1.5" />
                  <rect x="3" y="14" width="7" height="7" rx="1.5" />
                  <rect x="14" y="14" width="7" height="7" rx="1.5" />
                </svg>
              </button>
              <button
                className={`view-btn${sessionsView === "table" ? " active" : ""}`}
                onClick={() => setSessionsView("table")}
                title="Table view"
                aria-label="Table view"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="3" y1="6" x2="21" y2="6" />
                  <line x1="3" y1="12" x2="21" y2="12" />
                  <line x1="3" y1="18" x2="21" y2="18" />
                </svg>
              </button>
            </div>
          </div>

          {loading && sessions.length === 0 ? (
            <div className="home-empty">Loading sessions…</div>
          ) : visibleSessions.length === 0 ? (
            <div className="home-empty">No sessions match this filter.</div>
          ) : sessionsView === "icons" ? (
            <div className="home-surface">
              {visibleSessions.map((session) => (
                <SessionTile
                  key={session.id}
                  session={session}
                  spaces={spaces}
                  showSpaceChip={isMetaView}
                  onOpen={(id) => setActivePanel({ kind: "session", id })}
                />
              ))}
            </div>
          ) : (
            <div className="home-table-wrap">
              <div className="home-table">
                {visibleSessions.map((session) => (
                  <SessionRow
                    key={session.id}
                    session={session}
                    spaces={spaces}
                    onOpen={(id) => setActivePanel({ kind: "session", id })}
                  />
                ))}
              </div>
            </div>
          )}
        </section>

        <section className="home-section">
          <div className="home-section-head">
            <span className="home-section-label">Artefacts</span>
            <span className="home-section-stats">
              {ARTEFACT_SOURCE_ORDER.map((src) => {
                const count = artefactSourceCounts[src];
                if (count === 0 && src !== "all") return null;
                return (
                  <button
                    key={src}
                    className={`stat-btn${artefactSource === src ? " active" : ""}`}
                    onClick={() => setArtefactSource(src)}
                  >
                    {count} {ARTEFACT_SOURCE_LABELS[src]}
                  </button>
                );
              })}
            </span>
            <span className="home-section-rule" />
            <div className="home-view-toggle">
              <button
                className={`view-btn${artefactsView === "icons" ? " active" : ""}`}
                onClick={() => setArtefactsView("icons")}
                title="Icon view"
                aria-label="Icon view"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="3" width="7" height="7" rx="1.5" />
                  <rect x="14" y="3" width="7" height="7" rx="1.5" />
                  <rect x="3" y="14" width="7" height="7" rx="1.5" />
                  <rect x="14" y="14" width="7" height="7" rx="1.5" />
                </svg>
              </button>
              <button
                className={`view-btn${artefactsView === "table" ? " active" : ""}`}
                onClick={() => setArtefactsView("table")}
                title="Table view"
                aria-label="Table view"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="3" y1="6" x2="21" y2="6" />
                  <line x1="3" y1="12" x2="21" y2="12" />
                  <line x1="3" y1="18" x2="21" y2="18" />
                </svg>
              </button>
            </div>
          </div>
          {artefactsView === "icons" ? (
            <>
              <div className="home-artefacts">
                <Desktop
                  {...effectiveDesktopProps}
                  artifacts={visibleArtefacts}
                  isHero={false}
                  showMeta
                  onArtifactClick={(a) => setActivePanel({ kind: "artefact", id: a.id })}
                />
              </div>
              {artefactsLimit < filteredArtefactsTotal && (
                <ShowMore
                  onClick={() => setArtefactsLimit((n) => n + ARTEFACTS_PREVIEW)}
                  remaining={filteredArtefactsTotal - artefactsLimit}
                  searchHint
                />
              )}
            </>
          ) : (
            <ArtefactTable
              artifacts={visibleArtefacts}
              spaces={spaces}
              onArtifactClick={(a) => setActivePanel({ kind: "artefact", id: a.id })}
            />
          )}
        </section>

        <section className="home-section">
          <div className="home-section-head">
            <span className="home-section-label">Memories</span>
            <span className="home-artefacts-count">{scopedMemories.length}</span>
            <span className="home-section-rule" />
            <button
              type="button"
              className="home-memories-add-btn"
              onClick={() => setShowAddMemory((v) => !v)}
              aria-expanded={showAddMemory}
            >
              {showAddMemory ? "Cancel" : "+ Add memory"}
            </button>
          </div>
          {showAddMemory && (
            <AddMemoryForm
              defaultSpaceId={scopedSpace}
              spaces={spaces}
              onSaved={() => {
                setShowAddMemory(false);
                refreshMemories();
              }}
              onCancel={() => setShowAddMemory(false)}
            />
          )}
          {memoriesError ? (
            <div className="home-empty">
              Couldn't load memories: {memoriesError.message}
            </div>
          ) : memoriesLoading && memories.length === 0 ? (
            <div className="home-empty">Loading memories…</div>
          ) : scopedMemories.length === 0 ? (
            <div className="home-empty">
              No memories yet — agents store them via <code>remember</code>.
            </div>
          ) : (
            <div className="home-memories-wrap">
              <div className="home-memories">
                {scopedMemories.slice(0, memoriesLimit).map((m) => (
                  <MemoryCard key={m.id} memory={m} spaces={spaces} showSpaceChip={isMetaView} />
                ))}
              </div>
              {memoriesLimit < scopedMemories.length && (
                <ShowMore
                  onClick={() => setMemoriesLimit((n) => n + MEMORIES_PREVIEW)}
                  remaining={scopedMemories.length - memoriesLimit}
                />
              )}
            </div>
          )}
        </section>
      </div>
      <InspectorPanel active={activePanel} onClose={() => setActivePanel(null)}>
        {activePanel?.kind === "session" && (
          <SessionInspector
            sessionId={activePanel.id}
            onSwitchTo={setActivePanel}
            onClose={() => setActivePanel(null)}
            onNotFound={() => {
              setActivePanel(null);
              alert("Session no longer available");
            }}
          />
        )}
        {activePanel?.kind === "artefact" && activeArtefact && (
          <ArtefactInspector
            artifact={activeArtefact}
            onSwitchTo={setActivePanel}
            onClose={() => setActivePanel(null)}
            onOpen={(a) => {
              setActivePanel(null);
              desktopProps.onArtifactClick(a);
            }}
          />
        )}
      </InspectorPanel>
    </div>
  );
}

function stateColor(state: SessionState): "green" | "amber" | "red" | "dim" {
  switch (state) {
    case "active": return "green";
    case "waiting": return "amber";
    case "disconnected": return "red";
    case "done": return "dim";
  }
}

function spaceLabelFor(spaceId: string | null, spaces: Space[]): string | null {
  if (!spaceId) return null;
  return spaces.find((s) => s.id === spaceId)?.displayName ?? spaceId;
}

function metaForSession(session: Session): string {
  const rel = formatRelative(session.lastEventAt) ?? "—";
  if (session.state === "waiting") return `${session.agent} · waiting ${rel}`;
  if (session.state === "disconnected") return `${session.agent} · disconnected ${rel}`;
  return `${session.agent} · ${rel}`;
}

interface SessionTileProps {
  session: Session;
  spaces: Space[];
  showSpaceChip: boolean;
  onOpen?: (id: string) => void;
}

function SessionTile({ session, spaces, showSpaceChip, onOpen }: SessionTileProps) {
  const spaceLabel = spaceLabelFor(session.spaceId, spaces);
  const title = session.title ?? "(no title yet)";
  return (
    <div
      className="home-tile"
      onClick={() => onOpen?.(session.id)}
      onKeyDown={onOpen ? (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(session.id); }
      } : undefined}
      role={onOpen ? "button" : undefined}
      tabIndex={onOpen ? 0 : undefined}
    >
      <div className={`home-thumb ${AGENT_CLASS[session.agent]}`}>
        {showSpaceChip && spaceLabel && (
          <span className="home-space-chip">{spaceLabel}</span>
        )}
        <span className="home-agent-mark">{AGENT_LETTERS[session.agent]}</span>
        <span className={`home-status ${session.state}`} />
      </div>
      <div className="home-tile-label" title={title}>{title}</div>
      <div className="home-tile-meta">{metaForSession(session)}</div>
    </div>
  );
}

interface SessionRowProps {
  session: Session;
  spaces: Space[];
  onOpen?: (id: string) => void;
}

function SessionRow({ session, spaces, onOpen }: SessionRowProps) {
  const spaceLabel = spaceLabelFor(session.spaceId, spaces);
  const rel = formatRelative(session.lastEventAt) ?? "—";
  const time = session.state === "waiting" ? `waiting ${rel}`
    : session.state === "disconnected" ? `disconnected ${rel}`
    : rel;
  const title = session.title ?? "(no title yet)";
  return (
    <div
      className="home-row"
      onClick={() => onOpen?.(session.id)}
      onKeyDown={onOpen ? (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(session.id); }
      } : undefined}
      role={onOpen ? "button" : undefined}
      tabIndex={onOpen ? 0 : undefined}
    >
      <span className={`home-row-status ${session.state}`} />
      <span className="home-row-space">{spaceLabel ?? "—"}</span>
      <span className="home-row-title" title={title}>{title}</span>
      <span className={`home-row-agent ${AGENT_PIP_CLASS[session.agent]}`}>
        <span className="home-agent-pip" />
        {session.agent}
      </span>
      <span className="home-row-time">{time}</span>
    </div>
  );
}

interface ArtefactTableProps {
  artifacts: Parameters<typeof Desktop>[0]["artifacts"];
  spaces: Space[];
  onArtifactClick: Parameters<typeof Desktop>[0]["onArtifactClick"];
}

function ArtefactTable({ artifacts, spaces, onArtifactClick }: ArtefactTableProps) {
  if (artifacts.length === 0) {
    return <div className="home-empty">No artefacts here yet.</div>;
  }
  const sorted = [...artifacts].sort((a, b) => {
    const ta = parseTimestamp(a.createdAt);
    const tb = parseTimestamp(b.createdAt);
    return (Number.isFinite(tb) ? tb : 0) - (Number.isFinite(ta) ? ta : 0);
  });
  return (
    <div className="home-table-wrap">
      <div className="home-table">
        {sorted.map((art) => {
          const space = spaces.find((s) => s.id === art.spaceId);
          return (
            <div
              key={art.id}
              className="home-artefact-row"
              role="button"
              tabIndex={0}
              onClick={() => onArtifactClick(art)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onArtifactClick(art);
                }
              }}
            >
              <span className="home-artefact-row-title">{art.label}</span>
              <span className="home-artefact-row-space">{space?.displayName ?? art.spaceId}</span>
              <span className="home-artefact-row-kind">{art.artifactKind}</span>
              <span className="home-artefact-row-time">{formatRelative(art.createdAt) ?? "—"}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Reused under both the Memories and Artefacts sections. "Show more"
// loads another preview-sized batch (5 memories, 21 artefacts). The
// optional ⌘K hint only renders where Spotlight actually searches —
// artifacts today, eventually memories + sessions when #264 ships.
function ShowMore({
  onClick, remaining, searchHint = false,
}: { onClick: () => void; remaining: number; searchHint?: boolean }) {
  return (
    <div className="home-show-more">
      <button type="button" className="home-memories-toggle" onClick={onClick}>
        Show more
      </button>
      <span className="home-show-more-hint">
        {remaining} more
        {searchHint && (
          <>
            {" · "}<kbd>⌘K</kbd> to search
          </>
        )}
      </span>
    </div>
  );
}

interface AddMemoryFormProps {
  defaultSpaceId: string | null;
  spaces: Space[];
  onSaved: () => void;
  onCancel: () => void;
}

function AddMemoryForm({ defaultSpaceId, spaces, onSaved, onCancel }: AddMemoryFormProps) {
  const [content, setContent] = useState("");
  const [spaceId, setSpaceId] = useState<string>(defaultSpaceId ?? "");
  const [tagsInput, setTagsInput] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const realSpaces = useMemo(
    () => spaces.filter((s) => s.id !== "home" && s.id !== "__all__" && s.id !== "__archived__"),
    [spaces],
  );

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!content.trim() || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const tags = tagsInput
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      await createMemory({
        content: content.trim(),
        space_id: spaceId || undefined,
        tags: tags.length ? tags : undefined,
      });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="home-memories-add" onSubmit={submit}>
      <textarea
        className="home-memories-add-text"
        placeholder="What should I remember?"
        value={content}
        onChange={(e) => setContent(e.target.value)}
        rows={3}
        autoFocus
      />
      <div className="home-memories-add-row">
        <select
          className="home-memories-add-select"
          value={spaceId}
          onChange={(e) => setSpaceId(e.target.value)}
        >
          <option value="">No space (global)</option>
          {realSpaces.map((s) => (
            <option key={s.id} value={s.id}>{s.displayName}</option>
          ))}
        </select>
        <input
          className="home-memories-add-tags"
          placeholder="tags, comma-separated"
          value={tagsInput}
          onChange={(e) => setTagsInput(e.target.value)}
        />
        <div className="home-memories-add-actions">
          <button type="button" className="home-memories-add-cancel" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="submit"
            className="home-memories-add-save"
            disabled={!content.trim() || submitting}
          >
            {submitting ? "Saving…" : "Save memory"}
          </button>
        </div>
      </div>
      {error && <div className="home-memories-add-error">Couldn't save: {error}</div>}
    </form>
  );
}

function FolderRow({
  source, onDetach,
}: {
  source: SpaceSource;
  onDetach: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const basename = source.path.split("/").filter(Boolean).pop() ?? source.path;

  async function performDetach() {
    setBusy(true);
    try {
      await onDetach();
      setConfirmOpen(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="home-memory home-folder" title={source.path}>
        <div className="home-folder-row">
          <span className="home-memory-space">{basename}</span>
          <span className="home-folder-path">{source.path}</span>
          <span className="home-memory-time">attached {formatRelative(source.added_at) ?? "—"}</span>
          <button
            type="button"
            className="home-folder-detach"
            onClick={() => !busy && setConfirmOpen(true)}
            disabled={busy}
            aria-label={`Detach ${basename}`}
            title="Detach this folder"
          >
            {busy ? "…" : "Detach"}
          </button>
        </div>
      </div>
      <ConfirmModal
        open={confirmOpen}
        title={`Detach "${basename}"?`}
        body={
          <>
            <div style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--text-dim)", marginBottom: 8 }}>
              {source.path}
            </div>
            Its artefacts will be hidden. Reattach the same path to restore them.
          </>
        }
        confirmLabel="Detach"
        destructive
        onConfirm={performDetach}
        onCancel={() => !busy && setConfirmOpen(false)}
      />
    </>
  );
}

function AttachFolderForm({
  spaceId, onAttached, onCancel,
}: {
  spaceId: string;
  onAttached: () => void;
  onCancel: () => void;
}) {
  const [path, setPath] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!path.trim() || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await addSpaceSource(spaceId, path.trim());
      onAttached();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="home-memories-add" onSubmit={submit}>
      <input
        className="home-memories-add-text"
        style={{ minHeight: 0 }}
        placeholder="/absolute/path/to/folder (or ~/path)"
        value={path}
        onChange={(e) => setPath(e.target.value)}
        autoFocus
      />
      <div className="home-memories-add-row">
        <span className="home-memories-add-error" style={{ flex: 1, color: "var(--text-dim)" }}>
          The folder will be scanned in the background.
        </span>
        <div className="home-memories-add-actions">
          <button type="button" className="home-memories-add-cancel" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="submit"
            className="home-memories-add-save"
            disabled={!path.trim() || submitting}
          >
            {submitting ? "Attaching…" : "Attach"}
          </button>
        </div>
      </div>
      {error && <div className="home-memories-add-error">Couldn't attach: {error}</div>}
    </form>
  );
}

interface MemoryCardProps {
  memory: Memory;
  spaces: Space[];
  showSpaceChip: boolean;
}

function MemoryCard({ memory, spaces, showSpaceChip }: MemoryCardProps) {
  const spaceLabel = spaceLabelFor(memory.space_id, spaces);
  const rel = formatRelative(memory.created_at) ?? "—";
  return (
    <div className="home-memory">
      <div className="home-memory-text">{memory.content}</div>
      <div className="home-memory-meta">
        {showSpaceChip && spaceLabel && <span className="home-memory-space">{spaceLabel}</span>}
        {memory.tags.length > 0 && (
          <span className="home-memory-tags">
            {memory.tags.map((t) => (
              <span key={t} className="home-memory-tag">{t}</span>
            ))}
          </span>
        )}
        <span className="home-memory-time">{rel}</span>
      </div>
    </div>
  );
}

function formatRelative(iso: string): string | null {
  const t = parseTimestamp(iso);
  if (!Number.isFinite(t)) return null;
  const ms = Date.now() - t;
  if (ms < 0) return "just now";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d`;
  return new Date(t).toLocaleDateString();
}
