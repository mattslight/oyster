import { useEffect, useMemo, useState } from "react";
import { LayoutGroup, motion } from "framer-motion";
import { Folder, Shield } from "lucide-react";
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

// Sentinel for the Vault tile (artefacts with no source_id —
// natively-created via create_artifact, not from a linked folder).
const VAULT = "__vault__";

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

// Collapse `/Users/<name>/...` and `/home/<name>/...` to `~/...` so
// orphan-cwd labels read at a glance. Falls through unchanged for
// Windows paths and anything outside the user home tree.
function homeRelative(p: string): string {
  const m = p.match(/^\/(?:Users|home)\/[^/]+/);
  return m ? "~" + p.slice(m[0].length) : p;
}

// Compact pip + numeral, one per non-zero state. Same glow primitive
// the Active-projects tile signals use, just without the trailing
// state word — fits in a breadcrumb pill while keeping counts exact
// and the visual language consistent with the tiles.
function renderPipCounts(counts: { active?: number; waiting?: number; disconnected?: number }) {
  const a = counts.active ?? 0;
  const w = counts.waiting ?? 0;
  const d = counts.disconnected ?? 0;
  if (a + w + d === 0) return null;
  return (
    <>
      {a > 0 && <span className="pip-count"><span className="pip pip-green" />{a}</span>}
      {w > 0 && <span className="pip-count"><span className="pip pip-amber" />{w}</span>}
      {d > 0 && <span className="pip-count"><span className="pip pip-red" />{d}</span>}
    </>
  );
}

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
  // Project-tile filter: null = "All" (no folder scope), "__vault__" =
  // native artefacts, otherwise a source_id. The tile grid is the canonical
  // surface for switching between folders; selection is exclusive.
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);

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
  // the "show more" depth, source filter, or tile selection.
  useEffect(() => {
    setMemoriesLimit(MEMORIES_PREVIEW);
    setArtefactsLimit(ARTEFACTS_PREVIEW);
    setArtefactSource("all");
    setSelectedFolderId(null);
  }, [scopedSpace, showElsewhere, isHomeView]);

  const scopedSessions = useMemo(() => {
    if (showElsewhere && isHomeView) return sessions.filter((s) => s.spaceId === null);
    return scopedSpace ? sessions.filter((s) => s.spaceId === scopedSpace) : sessions;
  }, [sessions, scopedSpace, showElsewhere, isHomeView]);

  // Space-wide counts feed the "All" tile in ProjectTileGrid — that
  // tile is the user's reset button, so its counts must NOT narrow
  // when a folder is selected. Everything below this point (chips,
  // list) does narrow.
  const spaceCounts = useMemo(() => {
    const counts: Record<StateFilter, number> = { live: 0, active: 0, waiting: 0, disconnected: 0, done: 0, all: scopedSessions.length };
    for (const s of scopedSessions) counts[s.state]++;
    counts.live = counts.active + counts.waiting + counts.disconnected;
    return counts;
  }, [scopedSessions]);

  // Folder-narrowed sessions: when a project tile is selected, sessions
  // filter to that source (or sessions without a source for VAULT).
  const folderScopedSessions = useMemo(() => {
    if (selectedFolderId === VAULT) return scopedSessions.filter((s) => !s.sourceId);
    if (selectedFolderId) return scopedSessions.filter((s) => s.sourceId === selectedFolderId);
    return scopedSessions;
  }, [scopedSessions, selectedFolderId]);

  const stateCounts = useMemo(() => {
    const counts: Record<StateFilter, number> = { live: 0, active: 0, waiting: 0, disconnected: 0, done: 0, all: folderScopedSessions.length };
    for (const s of folderScopedSessions) counts[s.state]++;
    counts.live = counts.active + counts.waiting + counts.disconnected;
    return counts;
  }, [folderScopedSessions]);

  const visibleSessions = useMemo(() => {
    if (stateFilter === "all") return folderScopedSessions;
    if (stateFilter === "live") return folderScopedSessions.filter((s) => LIVE_STATES.includes(s.state));
    return folderScopedSessions.filter((s) => s.state === stateFilter);
  }, [folderScopedSessions, stateFilter]);

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

  // Active projects on Home: collapse sessions by sourceId, count
  // non-done states, drop projects with no live activity. Each entry
  // becomes a tile in the "Active projects" section so the user can
  // jump straight to the project that's currently in flight.
  const activeProjects = useMemo(() => {
    if (!isHomeView || showElsewhere) return [];
    const map = new Map<string, {
      sourceId: string;
      spaceId: string;
      label: string;
      counts: { active: number; waiting: number; disconnected: number };
      lastEventAt: number;
    }>();
    for (const s of sessions) {
      if (!s.sourceId || !s.spaceId || s.state === "done") continue;
      let entry = map.get(s.sourceId);
      if (!entry) {
        entry = {
          sourceId: s.sourceId,
          spaceId: s.spaceId,
          label: s.sourceLabel ?? s.sourceId,
          counts: { active: 0, waiting: 0, disconnected: 0 },
          lastEventAt: 0,
        };
        map.set(s.sourceId, entry);
      }
      if (s.state === "active") entry.counts.active++;
      else if (s.state === "waiting") entry.counts.waiting++;
      else if (s.state === "disconnected") entry.counts.disconnected++;
      const t = parseTimestamp(s.lastEventAt);
      if (Number.isFinite(t) && t > entry.lastEventAt) entry.lastEventAt = t;
    }
    return [...map.values()].sort((a, b) => b.lastEventAt - a.lastEventAt);
  }, [sessions, isHomeView, showElsewhere]);

  // Per-source live-session counts, keyed by source_id. Used by
  // ProjectTileGrid so a folder tile can show "1 active · 1 waiting"
  // alongside its artefact count when sessions are running there.
  const sessionCountsBySource = useMemo(() => {
    const out: Record<string, { active: number; waiting: number; disconnected: number }> = {};
    for (const s of sessions) {
      if (!s.sourceId || s.state === "done") continue;
      const c = out[s.sourceId] ?? { active: 0, waiting: 0, disconnected: 0 };
      if (s.state === "active") c.active++;
      else if (s.state === "waiting") c.waiting++;
      else if (s.state === "disconnected") c.disconnected++;
      out[s.sourceId] = c;
    }
    return out;
  }, [sessions]);

  // Orphan-cwd "projects" on Elsewhere — sessions whose cwd doesn't
  // match any registered source still came from somewhere. Group by
  // cwd so the user can see at a glance which rogue folders have
  // activity, not just an undifferentiated session list.
  const orphanCwdGroups = useMemo(() => {
    if (!showElsewhere || !isHomeView) return [];
    const map = new Map<string, {
      cwd: string;
      label: string;
      counts: { active: number; waiting: number; disconnected: number; done: number };
      lastEventAt: number;
    }>();
    for (const s of sessions) {
      if (s.spaceId !== null || !s.cwd) continue;
      let entry = map.get(s.cwd);
      if (!entry) {
        const label = s.cwd.split(/[\\/]/).filter(Boolean).pop() ?? s.cwd;
        entry = {
          cwd: s.cwd,
          label,
          counts: { active: 0, waiting: 0, disconnected: 0, done: 0 },
          lastEventAt: 0,
        };
        map.set(s.cwd, entry);
      }
      entry.counts[s.state]++;
      const t = parseTimestamp(s.lastEventAt);
      if (Number.isFinite(t) && t > entry.lastEventAt) entry.lastEventAt = t;
    }
    return [...map.values()].sort((a, b) => b.lastEventAt - a.lastEventAt);
  }, [sessions, showElsewhere, isHomeView]);

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

  // Per-source artefact counts for the project tile grid. "vault"
  // collects everything without a source_id (manual + ai_generated tiles
  // that didn't come from a linked folder). The tile grid itself drives
  // the SELECTED_FOLDER filter, separate from the source-origin chips.
  const folderArtefactCounts = useMemo(() => {
    const counts: Record<string, number> = { [VAULT]: 0 };
    for (const a of effectiveDesktopProps.artifacts) {
      if (a.sourceId) counts[a.sourceId] = (counts[a.sourceId] ?? 0) + 1;
      else counts[VAULT]++;
    }
    return counts;
  }, [effectiveDesktopProps.artifacts]);

  // Filter + collapse to an incremental preview. Each "Show more" click
  // grows artefactsLimit by ARTEFACTS_PREVIEW; the table view bypasses
  // the cap because it's already linear and easy to scan.
  const filteredArtefacts = useMemo(() => {
    let list = effectiveDesktopProps.artifacts;
    if (selectedFolderId === VAULT) {
      list = list.filter((a) => !a.sourceId);
    } else if (selectedFolderId) {
      list = list.filter((a) => a.sourceId === selectedFolderId);
    }
    if (artefactSource !== "all") {
      list = list.filter((a) => (a.sourceOrigin ?? "manual") === artefactSource);
    }
    return list;
  }, [effectiveDesktopProps.artifacts, artefactSource, selectedFolderId]);
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
        {/* Top space nav — stable on every screen. Pills carry numbered
            badges for non-zero active/waiting/disconnected counts so the
            at-a-glance dashboard info lives in the nav itself; no need
            for a separate "Spaces" content section that would just
            duplicate the same data. */}
        {(realSpaces.length > 0 || orphanCounts.total > 0) && (
          <nav className="home-breadcrumb" aria-label="Spaces">
            <LayoutGroup id="home-breadcrumb">
            <div className="home-breadcrumb-inner">
            <button
              type="button"
              className={`home-breadcrumb-pill home-breadcrumb-pill--home${isHomeView && !showElsewhere ? " selected" : ""}`}
              onClick={() => { onSpaceChange("home"); setShowElsewhere(false); }}
              title={`${totalCounts.active} active · ${totalCounts.waiting} waiting · ${totalCounts.disconnected} disconnected · ${totalCounts.done} done`}
            >
              {isHomeView && !showElsewhere && (
                <motion.span
                  layoutId="home-breadcrumb-bg"
                  className="home-breadcrumb-pill-bg"
                  transition={{ type: "spring", stiffness: 400, damping: 35 }}
                />
              )}
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg" style={{ position: "relative", zIndex: 1 }}>
                <path d="M11.03 2.59a1.5 1.5 0 0 1 1.94 0l7.5 6.363A1.5 1.5 0 0 1 21 10.097V19.5a2.5 2.5 0 0 1-2.5 2.5H15v-4a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v4H5.5A2.5 2.5 0 0 1 3 19.5v-9.403a1.5 1.5 0 0 1 .53-1.137l7.5-6.37Z"/>
              </svg>
            </button>
            {realSpaces.map((space) => {
              const counts = sessionCountsBySpace[space.id] ?? EMPTY_COUNTS;
              const tip = [
                counts.active > 0 && `${counts.active} active`,
                counts.waiting > 0 && `${counts.waiting} waiting`,
                counts.disconnected > 0 && `${counts.disconnected} disconnected`,
                counts.done > 0 && `${counts.done} done`,
              ].filter(Boolean).join(" · ") || "no sessions yet";
              const isSelected = scopedSpace === space.id;
              return (
                <button
                  key={space.id}
                  type="button"
                  className={`home-breadcrumb-pill${isSelected ? " selected" : ""}`}
                  onClick={() => onSpaceChange(space.id)}
                  title={tip}
                >
                  {isSelected && (
                    <motion.span
                      layoutId="home-breadcrumb-bg"
                      className="home-breadcrumb-pill-bg"
                      transition={{ type: "spring", stiffness: 400, damping: 35 }}
                    />
                  )}
                  {(counts.active > 0 || counts.waiting > 0 || counts.disconnected > 0) && (
                    <span className="home-breadcrumb-badges">
                      {renderPipCounts(counts)}
                    </span>
                  )}
                  <span className="home-breadcrumb-pill-label">{space.displayName}</span>
                </button>
              );
            })}
            {orphanCounts.total > 0 && (
              <button
                type="button"
                className={`home-breadcrumb-pill home-breadcrumb-pill--elsewhere${showElsewhere && isHomeView ? " selected" : ""}`}
                onClick={() => { onSpaceChange("home"); setShowElsewhere(true); }}
                title={[
                  orphanCounts.active > 0 && `${orphanCounts.active} active`,
                  orphanCounts.waiting > 0 && `${orphanCounts.waiting} waiting`,
                  orphanCounts.disconnected > 0 && `${orphanCounts.disconnected} disconnected`,
                  orphanCounts.done > 0 && `${orphanCounts.done} done`,
                ].filter(Boolean).join(" · ") || "Sessions outside any registered space"}
              >
                {showElsewhere && isHomeView && (
                  <motion.span
                    layoutId="home-breadcrumb-bg"
                    className="home-breadcrumb-pill-bg"
                    transition={{ type: "spring", stiffness: 400, damping: 35 }}
                  />
                )}
                {(orphanCounts.active > 0 || orphanCounts.waiting > 0 || orphanCounts.disconnected > 0) && (
                  <span className="home-breadcrumb-badges">
                    {renderPipCounts(orphanCounts)}
                  </span>
                )}
                <span className="home-breadcrumb-pill-label">Elsewhere</span>
              </button>
            )}
            </div>
            </LayoutGroup>
          </nav>
        )}

        <header className="home-header">
          {/* Eyebrow dropped — the breadcrumb above already shows the
              active scope, so a separate "HOME" / "OYSTER" label is
              redundant. */}
          <h1 className="home-title">{isHomeView ? (showElsewhere ? "Everything else." : "Everything.") : eyebrow}</h1>
          {error && <div className="home-error">Couldn't load sessions: {error.message}</div>}
        </header>

        {/* The rich space-cards grid was removed — pills in the top
            breadcrumb enumerate the spaces with numbered status badges,
            so a parallel content section was duplicate work. The
            home-space-card / home-spaces-section CSS is kept around in
            case the cards return as a settings or dashboard surface. */}

        {isHomeView && !showElsewhere && activeProjects.length > 0 && (
          <div className="home-section home-active-projects-section">
            <div className="home-active-projects-grid">
              {activeProjects.map((p) => {
                const space = spaces.find((s) => s.id === p.spaceId);
                return (
                  <button
                    type="button"
                    key={p.sourceId}
                    className="home-active-project-tile"
                    onClick={() => onSpaceChange(p.spaceId)}
                    title={`Jump to ${space?.displayName ?? p.spaceId}`}
                  >
                    <div className="home-active-project-meta">{space?.displayName ?? p.spaceId}</div>
                    <div className="home-active-project-name">{p.label}</div>
                    <div className="home-active-project-counts">
                      {p.counts.active > 0 && <span className="signal"><span className="pip pip-green" />{p.counts.active} active</span>}
                      {p.counts.waiting > 0 && <span className="signal"><span className="pip pip-amber" />{p.counts.waiting} waiting</span>}
                      {p.counts.disconnected > 0 && <span className="signal"><span className="pip pip-red" />{p.counts.disconnected} disconnected</span>}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {isHomeView && showElsewhere && orphanCwdGroups.length > 0 && (
          <div className="home-section home-active-projects-section">
            <div className="home-active-projects-grid">
              {orphanCwdGroups.map((p) => (
                <div
                  key={p.cwd}
                  className="home-active-project-tile home-active-project-tile--orphan"
                  title={p.cwd}
                >
                  <div className="home-active-project-name home-active-project-name--folder">
                    <Folder size={14} strokeWidth={1.75} aria-hidden="true" />
                    <span>{homeRelative(p.cwd)}</span>
                  </div>
                  <div className="home-active-project-counts">
                    {p.counts.active > 0 && <span className="signal"><span className="pip pip-green" />{p.counts.active} active</span>}
                    {p.counts.waiting > 0 && <span className="signal"><span className="pip pip-amber" />{p.counts.waiting} waiting</span>}
                    {p.counts.disconnected > 0 && <span className="signal"><span className="pip pip-red" />{p.counts.disconnected} disconnected</span>}
                    {p.counts.done > 0 && <span className="signal"><span className="pip pip-dim" />{p.counts.done} done</span>}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {sourcesSpaceId && (
          spaceSourcesError ? (
            <div className="home-spaces-section">
              <div className="home-spaces-grid">
                <div className="home-empty" style={{ gridColumn: "1 / -1" }}>
                  Couldn't load folders: {spaceSourcesError.message}
                </div>
              </div>
            </div>
          ) : spaceSources.length === 0 && !spaceSourcesLoading ? (
            <div className="home-spaces-section">
              <div className="home-folders-empty">
                <strong>No folders attached to this space.</strong>{" "}
                Sessions started in unattached folders land in Elsewhere,
                and tile discovery relies on these.{" "}
                <span className="home-folders-empty-hint">
                  Use <code>/attach &lt;path&gt;</code> from the chat bar, or{" "}
                  <button
                    type="button"
                    className="home-folders-empty-link"
                    onClick={() => setShowAttachForm(true)}
                  >
                    attach one now
                  </button>.
                </span>
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
            </div>
          ) : (
            <ProjectTileGrid
              spaceId={sourcesSpaceId}
              sources={spaceSources}
              folderArtefactCounts={folderArtefactCounts}
              sessionCountsBySource={sessionCountsBySource}
              selectedFolderId={selectedFolderId}
              setSelectedFolderId={setSelectedFolderId}
              totalCounts={spaceCounts}
              showAttachForm={showAttachForm}
              setShowAttachForm={setShowAttachForm}
              onSourcesChanged={refreshSpaceSources}
            />
          )
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
  // Prefer the most specific label available: source (folder) > space >
  // cwd basename for orphan sessions. Always tooltip the full cwd so
  // the user can identify where the session was running.
  const cwdBasename = session.cwd ? session.cwd.split(/[\\/]/).filter(Boolean).pop() ?? null : null;
  const projectLabel = session.sourceLabel ?? spaceLabel ?? cwdBasename ?? "—";
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
      <span className="home-row-space" title={session.cwd ?? undefined}>{projectLabel}</span>
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

// Project tile grid — same visual primitive as Home's space cards.
// Renders one tile per attached folder (plus an "All" meta-tile, a
// Vault tile for native artefacts, and a "+ Attach" tile). The
// selected tile is exclusive: clicking another switches scope, clicking
// the selected tile snaps back to All. Detach lives in a hover ⋯ menu
// on linked tiles only — Vault can't be detached.
function ProjectTileGrid({
  spaceId, sources, folderArtefactCounts, sessionCountsBySource,
  selectedFolderId, setSelectedFolderId,
  totalCounts, showAttachForm, setShowAttachForm, onSourcesChanged,
}: {
  spaceId: string;
  sources: SpaceSource[];
  folderArtefactCounts: Record<string, number>;
  sessionCountsBySource: Record<string, { active: number; waiting: number; disconnected: number }>;
  selectedFolderId: string | null;
  setSelectedFolderId: (next: string | null) => void;
  totalCounts: Record<StateFilter, number>;
  showAttachForm: boolean;
  setShowAttachForm: (v: boolean) => void;
  onSourcesChanged: () => void;
}) {
  // Sort linked tiles by tile count desc — busiest folders first.
  const sortedSources = useMemo(
    () => [...sources].sort((a, b) =>
      (folderArtefactCounts[b.id] ?? 0) - (folderArtefactCounts[a.id] ?? 0)
    ),
    [sources, folderArtefactCounts],
  );
  const vaultCount = folderArtefactCounts[VAULT] ?? 0;

  function pickTile(id: string | null) {
    setSelectedFolderId(selectedFolderId === id ? null : id);
  }

  return (
    <div className="home-spaces-section home-projects-section">
      <div className="home-spaces-grid">
        <button
          type="button"
          className={`home-space-card${selectedFolderId === null ? " selected" : ""}`}
          onClick={() => pickTile(null)}
          title="All projects in this space"
        >
          <div className="home-space-card-name">All</div>
          <div className="home-space-card-counts">
            {totalCounts.active > 0 && <span className="signal"><span className="pip pip-green" />{totalCounts.active} active</span>}
            {totalCounts.waiting > 0 && <span className="signal"><span className="pip pip-amber" />{totalCounts.waiting} waiting</span>}
            {totalCounts.disconnected > 0 && <span className="signal"><span className="pip pip-red" />{totalCounts.disconnected} disconnected</span>}
            {totalCounts.done > 0 && <span className="signal"><span className="pip pip-dim" />{totalCounts.done} done</span>}
            {totalCounts.all === 0 && <span className="signal signal-muted">no sessions yet</span>}
          </div>
        </button>

        {vaultCount > 0 && (
          <button
            type="button"
            className={`home-space-card home-project-tile--vault${selectedFolderId === VAULT ? " selected" : ""}`}
            onClick={() => pickTile(VAULT)}
            title="Native artefacts created in this space (not from a linked folder)"
          >
            <div className="home-space-card-name">
              <span>{spaceId}</span>
              <Shield size={12} strokeWidth={2} aria-hidden="true" className="home-project-glyph" />
              <span className="home-project-tag">vault</span>
            </div>
            <div className="home-space-card-counts">
              <span className="signal"><span className="pip pip-dim" />{vaultCount} {vaultCount === 1 ? "artefact" : "artefacts"}</span>
            </div>
          </button>
        )}

        {sortedSources.map((s) => (
          <ProjectTile
            key={s.id}
            source={s}
            artefactCount={folderArtefactCounts[s.id] ?? 0}
            sessionCounts={sessionCountsBySource[s.id]}
            selected={selectedFolderId === s.id}
            onSelect={() => pickTile(s.id)}
            onSourcesChanged={onSourcesChanged}
          />
        ))}

        <button
          type="button"
          className="home-space-card home-project-tile--add"
          onClick={() => setShowAttachForm(true)}
        >
          <div className="home-space-card-name">+ Attach folder</div>
          <div className="home-space-card-counts">
            <span className="signal signal-muted">link a repo or folder</span>
          </div>
        </button>
      </div>

      {showAttachForm && (
        <AttachFolderForm
          spaceId={spaceId}
          onAttached={() => {
            setShowAttachForm(false);
            onSourcesChanged();
          }}
          onCancel={() => setShowAttachForm(false)}
        />
      )}
    </div>
  );
}

function ProjectTile({
  source, artefactCount, sessionCounts, selected, onSelect, onSourcesChanged,
}: {
  source: SpaceSource;
  artefactCount: number;
  sessionCounts?: { active: number; waiting: number; disconnected: number };
  selected: boolean;
  onSelect: () => void;
  onSourcesChanged: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  // Separator-agnostic so Windows paths (`C:\Users\...`) display correctly too.
  const basename = source.path.split(/[\\/]/).filter(Boolean).pop() ?? source.path;

  // Close menu on outside click — same pattern as space-card menus.
  useEffect(() => {
    if (!menuOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (!(e.target as HTMLElement)?.closest(".home-project-tile-menu, .home-project-tile-more")) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("click", onDocClick);
    return () => document.removeEventListener("click", onDocClick);
  }, [menuOpen]);

  async function performDetach() {
    setBusy(true);
    try {
      await removeSpaceSource(source.space_id, source.id);
      onSourcesChanged();
      setConfirmOpen(false);
    } catch (err) {
      alert(`Couldn't detach: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className={`home-space-card home-project-tile${selected ? " selected" : ""}`}>
        <button
          type="button"
          className="home-project-tile-body"
          onClick={onSelect}
          title={source.path}
        >
          <div className="home-space-card-name">{basename}</div>
          <div className="home-space-card-counts">
            {sessionCounts && sessionCounts.active > 0 && <span className="signal"><span className="pip pip-green" />{sessionCounts.active} active</span>}
            {sessionCounts && sessionCounts.waiting > 0 && <span className="signal"><span className="pip pip-amber" />{sessionCounts.waiting} waiting</span>}
            {sessionCounts && sessionCounts.disconnected > 0 && <span className="signal"><span className="pip pip-red" />{sessionCounts.disconnected} disconnected</span>}
            <span className="signal"><span className="pip pip-dim" />{artefactCount} {artefactCount === 1 ? "artefact" : "artefacts"}</span>
          </div>
        </button>
        <button
          type="button"
          className={`home-project-tile-more${menuOpen ? " open" : ""}`}
          onClick={(e) => { e.stopPropagation(); setMenuOpen((v) => !v); }}
          aria-label="Folder actions"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
        >
          ⋯
        </button>
        {menuOpen && (
          <div className="home-project-tile-menu" role="menu">
            <div className="home-project-tile-menu-path">{source.path}</div>
            <div className="home-project-tile-menu-divider" />
            <button
              type="button"
              className="home-project-tile-menu-item danger"
              onClick={() => { setMenuOpen(false); setConfirmOpen(true); }}
            >
              Detach folder…
            </button>
          </div>
        )}
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
        confirmLabel={busy ? "Detaching…" : "Detach"}
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
