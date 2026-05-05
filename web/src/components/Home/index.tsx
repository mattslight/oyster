import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { LayoutGroup, motion } from "framer-motion";
import { ArrowUpRight, Folder, FolderPlus, Shield } from "lucide-react";
import type { SessionState } from "../../data/sessions-api";
import type { Artifact, Space } from "../../../../shared/types";
import { useSessions } from "../../hooks/useSessions";
import { useMemories } from "../../hooks/useMemories";
import { useAuthSignedIn } from "../../hooks/useAuthSignedIn";
import { useSpaceSources } from "../../hooks/useSpaceSources";
import { parseTimestamp } from "../../utils/parseTimestamp";
import { Desktop } from "../Desktop";
import { InspectorPanel, type ActivePanel } from "../InspectorPanel";
import { SessionInspector } from "../SessionInspector";
import { ArtefactInspector } from "../ArtefactInspector";
import { ConfirmModal } from "../ConfirmModal";
import { SpaceContextMenu } from "../SpaceContextMenu";
import { SessionTile } from "./SessionTile";
import { SessionRow } from "./SessionRow";
import { ArtefactTable } from "./ArtefactTable";
import { ShowMore } from "./ShowMore";
import { AddMemoryForm } from "./AddMemoryForm";
import { ProjectTileGrid } from "./ProjectTileGrid";
import { AttachFolderForm } from "./AttachFolderForm";
import { AttachOrphanPopover } from "./AttachOrphanPopover";
import { MemoryCard } from "./MemoryCard";
import { VaultInfo } from "./VaultInfo";
import { homeRelative, renderPipCounts, stateColor } from "./utils";
import { VAULT, type ArtefactSource, type StateFilter, type ViewMode } from "./types";
import { addSpaceSource } from "../../data/spaces-api";
import { deleteMemory, type Memory } from "../../data/memories-api";
import { ApiError } from "../../data/http";
import "./Home.css";

interface Props {
  activeSpace: string;
  spaces: Space[];
  desktopProps: Omit<Parameters<typeof Desktop>[0], "isHero">;
  isHero?: boolean;
  onSpaceChange: (space: string) => void;
  onPromoteFolderToSpace?: (path: string) => Promise<Space | null>;
  /** Removing the last folder from a real space collapses the space —
   *  Home delegates the delete (+ redirect) to App so spaces state
   *  stays consistent. */
  onSpaceDelete?: (spaceId: string) => Promise<void> | void;
  /** Used by the breadcrumb-pill context menu (rename). */
  onSpaceUpdate?: (id: string, fields: { displayName?: string; color?: string }) => void;
  /** Fires when the user toggles between the bare Home feed and a Home
   *  sub-view (Pro vault preview or Unsorted orphans). App uses this to
   *  drop the chat bar out of hero mode so it stops occluding sub-view
   *  content. */
  onSubViewActiveChange?: (active: boolean) => void;
}

const ARTEFACT_SOURCE_ORDER: ArtefactSource[] = ["all", "manual", "ai_generated", "discovered", "published", "pinned"];
const ARTEFACT_SOURCE_LABELS: Record<ArtefactSource, string> = {
  all: "all",
  manual: "mine",
  ai_generated: "from agents",
  discovered: "linked",
  published: "published",
  pinned: "pinned",
};

// Mirrors PublishedChip's live-check. A publication exists once a share token
// has been minted; unpublishedAt becomes non-null when the publication is retired.
const isLivePublication = (a: Artifact): boolean =>
  a.publication != null && a.publication.unpublishedAt == null;

// Artefacts list cap. Matches Sessions (10) so both sections stay
// compact and the table view doesn't dump dozens of rows at once;
// Show more pages an extra ten in.
const ARTEFACTS_PREVIEW = 10;

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

// Sessions list cap. Busy spaces can run dozens of concurrent sessions
// and previously pushed Artefacts below the fold; ten keeps the section
// compact in both icon and table views and Show more surfaces the rest.
const SESSIONS_PREVIEW = 10;

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

export function Home({ activeSpace, spaces, desktopProps, isHero, onSpaceChange, onPromoteFolderToSpace, onSpaceDelete, onSpaceUpdate, onSubViewActiveChange }: Props) {
  const { sessions, error, loading } = useSessions();
  const signedIn = useAuthSignedIn();
  const [signingIn, setSigningIn] = useState(false);
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
  const [stateFilter, setStateFilter] = useState<StateFilter>("all");
  const [sessionsView, setSessionsView] = useStickyView("oyster.home.sessionsView", "table");
  const [artefactsView, setArtefactsView] = useStickyView("oyster.home.artefactsView", "icons");
  const [activePanel, setActivePanel] = useState<ActivePanel | null>(null);
  const [pendingMemoryDelete, setPendingMemoryDelete] = useState<Memory | null>(null);

  // Local "Elsewhere" scope: filters Sessions to those whose spaceId is null
  // (claude/codex sessions started in folders that aren't attached to any
  // registered space). Only applies in Home view; navigating to a real space
  // resets it.
  const [showElsewhere, setShowElsewhere] = useState(false);
  // Vault info page (cloud-sync teaser). Sits next to Home in the breadcrumb;
  // mutually exclusive with showElsewhere and resets when navigating away
  // from Home, same lifecycle as showElsewhere.
  const [showVault, setShowVault] = useState(false);
  // Memories collapse: long lists are noisy on Home. Default to 5 rows;
  // "Show all" expands. Resets when the user changes scope so a different
  // space starts collapsed too.
  const [memoriesLimit, setMemoriesLimit] = useState(MEMORIES_PREVIEW);
  const [showAddMemory, setShowAddMemory] = useState(false);
  const [sessionsLimit, setSessionsLimit] = useState(SESSIONS_PREVIEW);
  // Artefact source filter (#280) + 3-row collapse. Reset on scope change
  // so each space starts compact and at "all".
  const [artefactSource, setArtefactSource] = useState<ArtefactSource>("all");
  const [artefactsLimit, setArtefactsLimit] = useState(ARTEFACTS_PREVIEW);
  // Elsewhere project-tile filter: orphan tiles aren't backed by a
  // source row, so they're keyed by cwd instead of source_id. Lives
  // alongside selectedFolderId; resets when scope changes.
  const [selectedOrphanCwd, setSelectedOrphanCwd] = useState<string | null>(null);
  // Cwd of the orphan tile currently mid-promotion (or mid-attach). Disables
  // every FolderPlus button so a slow server response can't kick off a
  // duplicate; also gates the picker popover. Set while either flow runs.
  const [promotingCwd, setPromotingCwd] = useState<string | null>(null);
  // Orphan attach picker. Anchored to the FolderPlus button on the matching
  // tile; rendered via portal alongside SpaceContextMenu at the end of the
  // tree so it overlays cleanly.
  const [attachPicker, setAttachPicker] = useState<{ cwd: string; rect: DOMRect } | null>(null);
  // Space-delete confirm. Set to a real space id to open. Two entry points
  // share this state: the empty-shell banner button (acts on the active
  // space) and the breadcrumb-pill context menu (acts on the clicked one).
  const [spaceToDelete, setSpaceToDelete] = useState<string | null>(null);
  // Right-click context menu on a breadcrumb pill — owns rename / color /
  // delete entry points. Anchored by the clicked pill's bounding rect.
  const [pillCtx, setPillCtx] = useState<{ spaceId: string; rect: DOMRect } | null>(null);
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
    if (!isHomeView) {
      setShowElsewhere(false);
      setShowVault(false);
    }
  }, [isHomeView]);

  // Tell App when the user is on a Home sub-view so it can drop the chat
  // bar out of hero mode (otherwise the centered overlay occludes the
  // vault preview / orphan tiles). Sub-views only exist while on Home.
  useLayoutEffect(() => {
    onSubViewActiveChange?.(isHomeView && (showVault || showElsewhere));
  }, [isHomeView, showVault, showElsewhere, onSubViewActiveChange]);

  const showVaultPage = showVault && isHomeView;

  // Collapse limits + filter reset on scope change — switching from a
  // 60-item Home view to a single-space view shouldn't carry over either
  // the "show more" depth, source filter, or tile selection. Exception:
  // the Active-projects jump arrow lets the user "open this space with
  // this project pre-selected" — the click stashes a source_id in the
  // pending ref before triggering onSpaceChange, and this effect honours
  // it instead of the default null reset.
  const pendingFolderSelection = useRef<string | null>(null);
  useEffect(() => {
    setMemoriesLimit(MEMORIES_PREVIEW);
    setArtefactsLimit(ARTEFACTS_PREVIEW);
    setSessionsLimit(SESSIONS_PREVIEW);
    setArtefactSource("all");
    if (pendingFolderSelection.current) {
      setSelectedFolderId(pendingFolderSelection.current);
      pendingFolderSelection.current = null;
    } else {
      setSelectedFolderId(null);
    }
    setSelectedOrphanCwd(null);
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
  // filter to that source (or sessions without a source for VAULT, or
  // by cwd when an Elsewhere orphan tile is picked).
  const folderScopedSessions = useMemo(() => {
    if (showElsewhere && isHomeView && selectedOrphanCwd) {
      return scopedSessions.filter((s) => s.cwd === selectedOrphanCwd);
    }
    if (selectedFolderId === VAULT) return scopedSessions.filter((s) => !s.sourceId);
    if (selectedFolderId) return scopedSessions.filter((s) => s.sourceId === selectedFolderId);
    return scopedSessions;
  }, [scopedSessions, selectedFolderId, selectedOrphanCwd, showElsewhere, isHomeView]);

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
  // spaceId === null) + a grand total for the Home card.
  const { sessionCountsBySpace, orphanCounts, totalCounts } = useMemo(() => {
    const bySpace: Record<string, { total: number; active: number; waiting: number; disconnected: number; done: number }> = {};
    const orphans = { total: 0, active: 0, waiting: 0, disconnected: 0, done: 0 };
    const total = { total: 0, active: 0, waiting: 0, disconnected: 0, done: 0 };
    for (const s of sessions) {
      total.total++;
      total[s.state]++;
      if (s.spaceId) {
        const c = bySpace[s.spaceId] ?? { total: 0, active: 0, waiting: 0, disconnected: 0, done: 0 };
        c.total++;
        c[s.state]++;
        bySpace[s.spaceId] = c;
      } else {
        orphans.total++;
        orphans[s.state]++;
      }
    }
    return { sessionCountsBySpace: bySpace, orphanCounts: orphans, totalCounts: total };
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
      counts: { active: number; waiting: number; disconnected: number; done: number };
      lastEventAt: number;
    }>();
    for (const s of sessions) {
      if (s.spaceId !== null || !s.cwd) continue;
      let entry = map.get(s.cwd);
      if (!entry) {
        entry = {
          cwd: s.cwd,
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
  // Stable breadcrumb order: bucket by strongest signal (green → amber →
  // red → quiet), then alphabetise within each bucket. Sorting by
  // last-activity caused pill order to flip every time a session updated,
  // which made re-finding a space a chore.
  const realSpaces = useMemo(() => {
    const filtered = spaces.filter((s) => s.id !== "home" && s.id !== "__all__" && s.id !== "__archived__");
    const rank = (id: string): number => {
      const c = sessionCountsBySpace[id] ?? EMPTY_COUNTS;
      if (c.active > 0) return 0;
      if (c.waiting > 0) return 1;
      if (c.disconnected > 0) return 2;
      return 3;
    };
    return [...filtered].sort((a, b) => {
      const ra = rank(a.id), rb = rank(b.id);
      if (ra !== rb) return ra - rb;
      return a.displayName.localeCompare(b.displayName);
    });
  }, [spaces, sessionCountsBySpace]);

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
    const counts: Record<ArtefactSource, number> = { all: 0, manual: 0, ai_generated: 0, discovered: 0, published: 0, pinned: 0 };
    counts.all = effectiveDesktopProps.artifacts.length;
    for (const a of effectiveDesktopProps.artifacts) {
      const o = a.sourceOrigin ?? "manual";
      if (o === "manual" || o === "ai_generated" || o === "discovered") counts[o]++;
      if (isLivePublication(a)) counts.published++;
      if (a.pinnedAt != null) counts.pinned++;
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
  // grows artefactsLimit by ARTEFACTS_PREVIEW; the cap applies to both
  // icon and table views so busy spaces don't push later sections far
  // below the fold.
  const filteredArtefacts = useMemo(() => {
    let list = effectiveDesktopProps.artifacts;
    if (selectedFolderId === VAULT) {
      list = list.filter((a) => !a.sourceId);
    } else if (selectedFolderId) {
      list = list.filter((a) => a.sourceId === selectedFolderId);
    }
    if (artefactSource === "published") {
      list = list.filter(isLivePublication);
    } else if (artefactSource === "pinned") {
      list = list.filter((a) => a.pinnedAt != null);
    } else if (artefactSource !== "all") {
      list = list.filter((a) => (a.sourceOrigin ?? "manual") === artefactSource);
    }
    // Pinned-first within the active scope (#387), then most-recent
    // first. Sorting by createdAt here (not just inside ArtefactTable)
    // means the artefactsLimit slice picks the freshest rows; each
    // view (icon = alpha, table = createdAt DESC) can still re-arrange
    // that sliced set however it wants.
    list = [...list].sort((a, b) => {
      const ap = a.pinnedAt ?? 0;
      const bp = b.pinnedAt ?? 0;
      if (ap !== bp) return bp - ap;
      const ta = parseTimestamp(a.createdAt);
      const tb = parseTimestamp(b.createdAt);
      return (Number.isFinite(tb) ? tb : 0) - (Number.isFinite(ta) ? ta : 0);
    });
    return list;
  }, [effectiveDesktopProps.artifacts, artefactSource, selectedFolderId]);
  const visibleArtefacts = useMemo(
    () => filteredArtefacts.slice(0, artefactsLimit),
    [filteredArtefacts, artefactsLimit],
  );
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

  // Allow App-level surfaces (Spotlight, etc.) to request a session
  // inspector via a window event — saves threading a callback through
  // the App→Home prop boundary just for this one cross-cutting hook.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ id?: string; eventId?: number; query?: string }>).detail;
      if (detail && typeof detail.id === "string") {
        setActivePanel({
          kind: "session",
          id: detail.id,
          focusEventId: typeof detail.eventId === "number" ? detail.eventId : undefined,
          initialSearchQuery: typeof detail.query === "string" && detail.query.length > 0
            ? detail.query
            : undefined,
        });
      }
    };
    window.addEventListener("oyster:open-session", handler);
    return () => window.removeEventListener("oyster:open-session", handler);
  }, []);

  const activeSpaceRow = scopedSpace ? spaces.find((s) => s.id === scopedSpace) : null;
  const eyebrow = isHomeView ? (showElsewhere ? "Unsorted" : "Home")
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
              className={`home-breadcrumb-pill home-breadcrumb-pill--home${isHomeView && !showElsewhere && !showVault ? " selected" : ""}`}
              onClick={() => { onSpaceChange("home"); setShowElsewhere(false); setShowVault(false); }}
              onContextMenu={(e) => e.preventDefault()}
              title={`${totalCounts.active} active · ${totalCounts.waiting} waiting · ${totalCounts.disconnected} disconnected · ${totalCounts.done} done`}
            >
              {isHomeView && !showElsewhere && !showVault && (
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
            <button
              type="button"
              className={`home-breadcrumb-pill home-breadcrumb-pill--vault${showVaultPage ? " selected" : ""}`}
              onClick={() => { onSpaceChange("home"); setShowElsewhere(false); setShowVault(true); }}
              onContextMenu={(e) => e.preventDefault()}
              title="Oyster Pro — coming soon"
              aria-label="Oyster Pro"
            >
              {showVaultPage && (
                <motion.span
                  layoutId="home-breadcrumb-bg"
                  className="home-breadcrumb-pill-bg"
                  transition={{ type: "spring", stiffness: 400, damping: 35 }}
                />
              )}
              <Shield size={14} strokeWidth={2} fill="currentColor" aria-hidden="true" style={{ position: "relative", zIndex: 1 }} />
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
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setPillCtx({ spaceId: space.id, rect: e.currentTarget.getBoundingClientRect() });
                  }}
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
                onClick={() => { onSpaceChange("home"); setShowElsewhere(true); setShowVault(false); }}
                onContextMenu={(e) => e.preventDefault()}
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
                <span className="home-breadcrumb-pill-label">Unsorted</span>
              </button>
            )}
            </div>
            </LayoutGroup>
          </nav>
        )}

        {showVaultPage ? (
          <VaultInfo />
        ) : (<>
        <header className="home-header">
          {/* Eyebrow dropped — the breadcrumb above already shows the
              active scope, so a separate "HOME" / "OYSTER" label is
              redundant. */}
          <h1 className="home-title">{isHomeView ? (showElsewhere ? "Everything else." : "Everything active.") : eyebrow}</h1>
          {/* First-run teaching line on Unsorted: orphan tiles look passive,
              so point at the per-tile affordance. With zero spaces the action
              is *creating* one (the popover says "promote this folder"), not
              attaching — so frame as "set up". Drops once any real space
              exists; by then the user has met the model. Inlines the actual
              FolderPlus glyph (size + stroke matches the tile button) so the
              instruction visually points at exactly the icon to click. */}
          {isHomeView && showElsewhere && realSpaces.length === 0 && (
            <div className="home-subtitle">
              Click the
              {" "}
              <FolderPlus size={14} strokeWidth={2} role="img" aria-label="folder plus" className="home-subtitle-glyph" />
              {" "}
              on a tile to set up your first space.
            </div>
          )}
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
                const isSelected = selectedFolderId === p.sourceId;
                return (
                  <div
                    key={p.sourceId}
                    className={`home-active-project-tile${isSelected ? " selected" : ""}`}
                  >
                    <button
                      type="button"
                      className="home-active-project-tile-body"
                      onClick={() => setSelectedFolderId(isSelected ? null : p.sourceId)}
                      title={`Filter sessions to ${p.label}`}
                    >
                      <div className="home-active-project-meta">{space?.displayName ?? p.spaceId}</div>
                      <div className="home-active-project-name">{p.label}</div>
                      <div className="home-active-project-counts">
                        {p.counts.active > 0 && <span className="signal"><span className="pip pip-green" />{p.counts.active} active</span>}
                        {p.counts.waiting > 0 && <span className="signal"><span className="pip pip-amber" />{p.counts.waiting} waiting</span>}
                        {p.counts.disconnected > 0 && <span className="signal"><span className="pip pip-red" />{p.counts.disconnected} disconnected</span>}
                      </div>
                    </button>
                    <button
                      type="button"
                      className="home-active-project-tile-jump"
                      onClick={(e) => {
                        e.stopPropagation();
                        pendingFolderSelection.current = p.sourceId;
                        onSpaceChange(p.spaceId);
                      }}
                      aria-label={`Open ${space?.displayName ?? p.spaceId}`}
                      title={`Open ${space?.displayName ?? p.spaceId}`}
                    >
                      <ArrowUpRight size={14} strokeWidth={2} aria-hidden="true" />
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {isHomeView && showElsewhere && orphanCwdGroups.length > 0 && (
          <div className="home-section home-active-projects-section">
            <div className="home-active-projects-grid">
              {orphanCwdGroups.map((p) => {
                const isSelected = selectedOrphanCwd === p.cwd;
                // Disable every promote button while *any* promotion is in
                // flight — the click handler also short-circuits in that
                // case, so the disabled state is honest about it.
                const isPromoting = Boolean(promotingCwd);
                return (
                  <div
                    key={p.cwd}
                    className={`home-active-project-tile home-active-project-tile--orphan${isSelected ? " selected" : ""}`}
                  >
                    <button
                      type="button"
                      className="home-active-project-tile-body"
                      onClick={() => setSelectedOrphanCwd(isSelected ? null : p.cwd)}
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
                    </button>
                    {onPromoteFolderToSpace && (
                      <button
                        type="button"
                        className="home-active-project-tile-jump"
                        disabled={isPromoting && attachPicker?.cwd !== p.cwd}
                        onClick={(e) => {
                          e.stopPropagation();
                          if (promotingCwd && attachPicker?.cwd !== p.cwd) return;
                          if (attachPicker?.cwd === p.cwd) {
                            setAttachPicker(null);
                            return;
                          }
                          const rect = (e.currentTarget as HTMLButtonElement).getBoundingClientRect();
                          setAttachPicker({ cwd: p.cwd, rect });
                        }}
                        aria-label={`Attach ${homeRelative(p.cwd)} to a space`}
                        title={`Attach ${homeRelative(p.cwd)} to a space`}
                      >
                        <FolderPlus size={14} strokeWidth={2} aria-hidden="true" />
                      </button>
                    )}
                  </div>
                );
              })}
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
                  {onSpaceDelete && (
                    <>
                      {" "}If this space was created in error, you can{" "}
                      <button
                        type="button"
                        className="home-folders-empty-link"
                        onClick={() => setSpaceToDelete(sourcesSpaceId)}
                      >
                        delete it
                      </button>.
                    </>
                  )}
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
              spaceDisplayName={spaces.find((s) => s.id === sourcesSpaceId)?.displayName ?? sourcesSpaceId}
              sources={spaceSources}
              folderArtefactCounts={folderArtefactCounts}
              sessionCountsBySource={sessionCountsBySource}
              selectedFolderId={selectedFolderId}
              setSelectedFolderId={setSelectedFolderId}
              totalCounts={spaceCounts}
              showAttachForm={showAttachForm}
              setShowAttachForm={setShowAttachForm}
              onSourcesChanged={refreshSpaceSources}
              onSpaceDelete={onSpaceDelete}
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
          ) : (
            <>
              {sessionsView === "icons" ? (
                <div className="home-surface">
                  {visibleSessions.slice(0, sessionsLimit).map((session) => (
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
                    {visibleSessions.slice(0, sessionsLimit).map((session) => (
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
              {sessionsLimit < visibleSessions.length && (
                <ShowMore
                  onClick={() => setSessionsLimit((n) => n + SESSIONS_PREVIEW)}
                  remaining={visibleSessions.length - sessionsLimit}
                />
              )}
            </>
          )}
        </section>

        <section className="home-section">
          <div className="home-section-head">
            <span className="home-section-label">Artefacts</span>
            <span className="home-section-stats">
              {ARTEFACT_SOURCE_ORDER.map((src) => {
                const count = artefactSourceCounts[src];
                // Origin pills hide at 0 (clutter); "all" stays unconditional;
                // "published" and "pinned" stay visible as discoverability surfaces —
                // clicking them at 0 lands on a how-to hint instead of an empty grid.
                if (count === 0 && src !== "all" && src !== "published" && src !== "pinned") return null;
                return (
                  <button
                    key={src}
                    className={`stat-btn${artefactSource === src ? " active" : ""}`}
                    onClick={() => setArtefactSource(src)}
                  >
                    {src === "published" && <span className="pip pip-published" />}
                    {src === "pinned" && <span className="pip pip-pinned" />}
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
          {artefactSource === "published" && filteredArtefactsTotal === 0 ? (
            <div className="home-empty">
              {signedIn === false ? (
                <>
                  <div>Sign in to see your published artefacts. Publishing requires an account.</div>
                  <button
                    type="button"
                    className="home-empty__cta"
                    disabled={signingIn}
                    onClick={async () => {
                      setSigningIn(true);
                      try {
                        const res = await fetch("/api/auth/login", { method: "POST" });
                        if (!res.ok) throw new Error(String(res.status));
                        const body = (await res.json()) as { sign_in_url: string };
                        window.open(body.sign_in_url, "_blank", "noopener,noreferrer");
                      } catch (err) {
                        console.error("[home] sign-in trigger failed:", err);
                      } finally {
                        setSigningIn(false);
                      }
                    }}
                  >
                    {signingIn ? "Opening sign-in…" : "Sign in"}
                  </button>
                </>
              ) : (
                <>No published artefacts yet — type <code>/p &lt;name&gt;</code> in the chat bar, or right-click any artefact and choose <strong>Publish…</strong></>
              )}
            </div>
          ) : artefactSource === "pinned" && filteredArtefactsTotal === 0 ? (
            <div className="home-empty">
              No pinned artefacts yet — right-click any artefact and choose <strong>Pin</strong> to keep it at the top of the surface.
            </div>
          ) : artefactsView === "icons" ? (
            <>
              <div className="home-artefacts">
                <Desktop
                  {...effectiveDesktopProps}
                  artifacts={visibleArtefacts}
                  isHero={false}
                  showMeta
                  flatten={artefactSource === "published" || artefactSource === "pinned"}
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
            <>
              <ArtefactTable
                artifacts={visibleArtefacts}
                spaces={spaces}
                onArtifactClick={(a) => setActivePanel({ kind: "artefact", id: a.id })}
              />
              {artefactsLimit < filteredArtefactsTotal && (
                <ShowMore
                  onClick={() => setArtefactsLimit((n) => n + ARTEFACTS_PREVIEW)}
                  remaining={filteredArtefactsTotal - artefactsLimit}
                  searchHint
                />
              )}
            </>
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
                  <MemoryCard
                    key={m.id}
                    memory={m}
                    spaces={spaces}
                    showSpaceChip={isMetaView}
                    onOpenSession={(id) => setActivePanel({ kind: "session", id })}
                    onRequestDelete={setPendingMemoryDelete}
                  />
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
        </>)}
      </div>
      <InspectorPanel active={activePanel} onClose={() => setActivePanel(null)}>
        {activePanel?.kind === "session" && (
          <SessionInspector
            sessionId={activePanel.id}
            focusEventId={activePanel.focusEventId}
            initialSearchQuery={activePanel.initialSearchQuery}
            onSwitchTo={setActivePanel}
            onOpenArtefact={(a) => desktopProps.onArtifactClick(a)}
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
      {attachPicker && onPromoteFolderToSpace && (() => {
        const meta = new Set(["home", "__all__", "__archived__"]);
        const candidates = spaces.filter((s) => !meta.has(s.id));
        const cwd = attachPicker.cwd;
        return (
          <AttachOrphanPopover
            path={cwd}
            anchorRect={attachPicker.rect}
            spaces={candidates}
            onClose={() => setAttachPicker(null)}
            onPickSpace={async (spaceId) => {
              if (promotingCwd) throw new Error("Another attach is already in progress");
              setPromotingCwd(cwd);
              try {
                await addSpaceSource(spaceId, cwd);
              } finally {
                setPromotingCwd(null);
              }
            }}
            onPromoteToNew={async () => {
              if (promotingCwd) throw new Error("Another attach is already in progress");
              setPromotingCwd(cwd);
              try {
                await onPromoteFolderToSpace(cwd);
              } finally {
                setPromotingCwd(null);
              }
            }}
          />
        );
      })()}
      {pillCtx && (() => {
        const target = spaces.find((s) => s.id === pillCtx.spaceId);
        if (!target) return null;
        return (
          <SpaceContextMenu
            spaceId={pillCtx.spaceId}
            spaceName={target.displayName}
            anchorRect={pillCtx.rect}
            onClose={() => setPillCtx(null)}
            onRename={(id, name) => onSpaceUpdate?.(id, { displayName: name })}
            onRequestDelete={(id) => setSpaceToDelete(id)}
          />
        );
      })()}
      {spaceToDelete && onSpaceDelete && (() => {
        const targetId = spaceToDelete;
        const displayName = spaces.find((s) => s.id === targetId)?.displayName ?? targetId;
        const sessionCount = sessions.filter((s) => s.spaceId === targetId).length;
        const artefactCount = desktopProps.artifacts.filter((a) => a.spaceId === targetId).length;
        const memoryCount = memories.filter((m) => m.space_id === targetId).length;
        const plural = (n: number, one: string, many: string) => n === 1 ? `1 ${one}` : `${n} ${many}`;
        const lines: React.ReactNode[] = [];
        if (sessionCount > 0) lines.push(<>{plural(sessionCount, "session", "sessions")} → Elsewhere</>);
        if (artefactCount > 0) lines.push(<>{plural(artefactCount, "artefact", "artefacts")} → Home, grouped under <strong>{displayName}</strong></>);
        if (memoryCount > 0) lines.push(<>{plural(memoryCount, "memory", "memories")} → Elsewhere (unbound from this space)</>);
        return (
          <ConfirmModal
            open={true}
            title={`Delete ${displayName}?`}
            body={
              lines.length === 0 ? (
                <><strong>{displayName}</strong> has no sessions, artefacts, or memories. It will be removed.</>
              ) : (
                <>
                  Linked folders will be detached. The space's contents will move:
                  <ul style={{ margin: "8px 0 0", paddingLeft: 20 }}>
                    {lines.map((line, i) => <li key={i}>{line}</li>)}
                  </ul>
                </>
              )
            }
            confirmLabel="Delete space"
            destructive
            onConfirm={async () => {
              await onSpaceDelete(targetId);
              setSpaceToDelete(null);
            }}
            onCancel={() => setSpaceToDelete(null)}
          />
        );
      })()}
      {pendingMemoryDelete && (
        <ConfirmModal
          open={true}
          title="Forget this memory?"
          body={
            <div style={{ fontSize: 13, lineHeight: 1.5, color: "var(--text)", whiteSpace: "pre-wrap" }}>
              {pendingMemoryDelete.content}
            </div>
          }
          confirmLabel="Forget"
          destructive
          onConfirm={async () => {
            const target = pendingMemoryDelete;
            try {
              await deleteMemory(target.id);
            } catch (err) {
              // 404 means another tab already forgot it — same end state.
              const status = err instanceof ApiError ? err.status : null;
              if (status !== 404) {
                alert(`Couldn't forget memory: ${err instanceof Error ? err.message : String(err)}`);
                setPendingMemoryDelete(null);
                return;
              }
            }
            refreshMemories();
            setPendingMemoryDelete(null);
          }}
          onCancel={() => setPendingMemoryDelete(null)}
        />
      )}
    </div>
  );
}

