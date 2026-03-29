import { useMemo, useRef, useState, useCallback, useEffect, type PointerEvent } from "react";
import { LayoutGrid, List, ArrowDownAZ, Tag, Clock, Folder, AlignLeft, AlignCenter, AlignRight } from "lucide-react";
import type { Artifact } from "../data/artifacts-api";
import { ArtifactIcon, typeConfig } from "./ArtifactIcon";
import { GroupIcon } from "./GroupIcon";
import Grainient from "./reactbits/Grainient";
import { spaceColor } from "../utils/spaceColor";

interface Props {
  space: string;
  spaces: string[];
  artifacts: Artifact[];
  isHero?: boolean;
  onArtifactClick: (artifact: Artifact) => void;
  onArtifactStop?: (artifact: Artifact) => void;
  onGroupClick: (groupName: string) => void;
  onSpaceChange: (space: string) => void;
}

type DesktopItem =
  | { type: "group"; key: string; name: string; artifacts: Artifact[] }
  | { type: "artifact"; key: string; artifact: Artifact };

const DRAG_THRESHOLD = 6;
const STORAGE_KEY_PREFIX = "oyster-icon-order:";
const VIEW_MODE_KEY = "oyster-view-mode";

function getStoredOrder(space: string): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_PREFIX + space);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function setStoredOrder(space: string, keys: string[]) {
  localStorage.setItem(STORAGE_KEY_PREFIX + space, JSON.stringify(keys));
}

function applyOrder(items: DesktopItem[], order: string[]): DesktopItem[] {
  if (order.length === 0) return items;
  const map = new Map(items.map((it) => [it.key, it]));
  const ordered: DesktopItem[] = [];
  for (const key of order) {
    const item = map.get(key);
    if (item) {
      ordered.push(item);
      map.delete(key);
    }
  }
  // Append any items not in the stored order
  for (const item of map.values()) {
    ordered.push(item);
  }
  return ordered;
}

export function Desktop({ space, spaces, artifacts, isHero, onArtifactClick, onArtifactStop, onGroupClick, onSpaceChange }: Props) {
  const isAllSpace = space === "__all__";

  // ── Topbar auto-hide ──
  const [topbarVisible, setTopbarVisible] = useState(true);
  const topbarHideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showTopbar = useCallback(() => {
    if (topbarHideTimer.current) clearTimeout(topbarHideTimer.current);
    setTopbarVisible(true);
  }, []);

  const scheduleHideTopbar = useCallback(() => {
    if (topbarHideTimer.current) clearTimeout(topbarHideTimer.current);
    topbarHideTimer.current = setTimeout(() => setTopbarVisible(false), 2000);
  }, []);

  useEffect(() => {
    scheduleHideTopbar();
    return () => { if (topbarHideTimer.current) clearTimeout(topbarHideTimer.current); };
  }, [scheduleHideTopbar]);

  const SORT_KEY_PREFIX = "oyster-sort-mode:";

  const [viewMode, setViewMode] = useState<"grid" | "list">(() => {
    try {
      const stored = localStorage.getItem(VIEW_MODE_KEY);
      if (stored === "grid" || stored === "list") return stored;
    } catch { /* ignore */ }
    return "grid";
  });

  const [sortMode, setSortMode] = useState<"alpha" | "kind" | "timeline" | "space" | "group">(() => {
    try {
      const stored = localStorage.getItem(SORT_KEY_PREFIX + space);
      if (stored === "alpha" || stored === "kind" || stored === "timeline" || stored === "space") return stored;
    } catch { /* ignore */ }
    return "alpha";
  });

  const SORT_DIR_KEY = "oyster-sort-dir";
  const [sortDir, setSortDir] = useState<"asc" | "desc">(() => {
    try {
      const stored = localStorage.getItem(SORT_DIR_KEY);
      return stored === "desc" ? "desc" : "asc";
    } catch { return "asc"; }
  });

  function setAndSaveSortDir(dir: "asc" | "desc") {
    setSortDir(dir);
    try { localStorage.setItem(SORT_DIR_KEY, dir); } catch { /* ignore */ }
  }

  useEffect(() => {
    try {
      const stored = localStorage.getItem(SORT_KEY_PREFIX + space);
      setSortMode(stored === "alpha" || stored === "kind" || stored === "timeline" ? stored : "alpha");
    } catch {
      setSortMode("alpha");
    }
  }, [space, isAllSpace]);

  function setAndSaveViewMode(mode: "grid" | "list") {
    setViewMode(mode);
    try { localStorage.setItem(VIEW_MODE_KEY, mode); } catch { /* ignore */ }
  }

  function setAndSaveSortMode(mode: "alpha" | "kind" | "timeline" | "space") {
    setSortMode(mode);
    try { localStorage.setItem(SORT_KEY_PREFIX + space, mode); } catch { /* ignore */ }
  }

  function handleColSort(mode: "alpha" | "kind" | "timeline" | "space") {
    if (sortMode === mode) {
      setAndSaveSortDir(sortDir === "asc" ? "desc" : "asc");
    } else {
      setAndSaveSortMode(mode);
      setAndSaveSortDir("asc");
    }
  }

  const GROUP_BY_KEY = "oyster-group-by";
  const [groupBy, setGroupBy] = useState<"space" | "kind" | "none">(() => {
    try {
      const stored = localStorage.getItem(GROUP_BY_KEY);
      if (stored === "space" || stored === "kind" || stored === "none") return stored;
    } catch { /* ignore */ }
    return "space";
  });

  function setAndSaveGroupBy(mode: "space" | "kind" | "none") {
    setGroupBy(mode);
    try { localStorage.setItem(GROUP_BY_KEY, mode); } catch { /* ignore */ }
  }

  const HEADER_ALIGN_KEY = "oyster-header-align";
  const [headerAlign, setHeaderAlign] = useState<"left" | "center" | "right">(() => {
    try {
      const stored = localStorage.getItem(HEADER_ALIGN_KEY);
      if (stored === "left" || stored === "center" || stored === "right") return stored;
    } catch { /* ignore */ }
    return "center";
  });

  function setAndSaveHeaderAlign(align: "left" | "center" | "right") {
    setHeaderAlign(align);
    try { localStorage.setItem(HEADER_ALIGN_KEY, align); } catch { /* ignore */ }
  }

  const ACTIVE_KIND_KEY = "oyster-active-kind";

  const [activeKind, setActiveKind] = useState<string | null>(() => {
    try { return localStorage.getItem(ACTIVE_KIND_KEY) || null; } catch { return null; }
  });

  const [kindDropdownOpen, setKindDropdownOpen] = useState(false);
  useEffect(() => {
    if (!kindDropdownOpen) return;
    function close() { setKindDropdownOpen(false); }
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [kindDropdownOpen]);

  function selectKind(k: string | null) {
    setActiveKind(k);
    try {
      if (k) localStorage.setItem(ACTIVE_KIND_KEY, k);
      else localStorage.removeItem(ACTIVE_KIND_KEY);
    } catch { /* ignore */ }
  }

  const uniqueKinds = useMemo(() => {
    const kinds = new Set(artifacts.map((a) => a.artifactKind));
    return Array.from(kinds).sort();
  }, [artifacts]);

  const filteredArtifacts = useMemo(() => {
    if (activeKind) return artifacts.filter((a) => a.artifactKind === activeKind);
    return artifacts;
  }, [artifacts, activeKind]);

  const { groups, ungrouped } = useMemo(() => {
    const groups: Record<string, Artifact[]> = {};
    const ungrouped: Artifact[] = [];
    if (isAllSpace) {
      for (const a of filteredArtifacts) {
        (groups[a.spaceId] ??= []).push(a);
      }
      return { groups, ungrouped };
    }
    for (const a of filteredArtifacts) {
      if (a.groupName) {
        (groups[a.groupName] ??= []).push(a);
      } else {
        ungrouped.push(a);
      }
    }
    return { groups, ungrouped };
  }, [filteredArtifacts, isAllSpace]);

  const baseItems = useMemo<DesktopItem[]>(() => {
    const sortedGroupNames = Object.keys(groups).sort();
    const items: DesktopItem[] = [];
    for (const name of sortedGroupNames) {
      items.push({ type: "group", key: `group:${name}`, name, artifacts: groups[name] });
    }
    for (const artifact of ungrouped) {
      items.push({ type: "artifact", key: artifact.id, artifact });
    }
    return items;
  }, [groups, ungrouped]);

  const orderedItems = useMemo(() => {
    if (sortMode === "alpha") return applyOrder(baseItems, getStoredOrder(space));
    if (sortMode === "kind") {
      return [...baseItems].sort((a, b) => {
        const ka = a.type === "artifact" ? a.artifact.artifactKind : "zzz";
        const kb = b.type === "artifact" ? b.artifact.artifactKind : "zzz";
        if (ka !== kb) return ka.localeCompare(kb);
        const la = a.type === "artifact" ? a.artifact.label : a.name;
        const lb = b.type === "artifact" ? b.artifact.label : b.name;
        return la.localeCompare(lb);
      });
    }
    // timeline
    return [...baseItems].sort((a, b) => {
      const da = a.type === "artifact" ? new Date(a.artifact.createdAt).getTime() : 0;
      const db = b.type === "artifact" ? new Date(b.artifact.createdAt).getTime() : 0;
      return db - da;
    });
  }, [baseItems, sortMode, space]);

  // Drag state
  const gridRef = useRef<HTMLDivElement>(null);
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [displayItems, setDisplayItems] = useState(orderedItems);
  const dragState = useRef<{
    key: string;
    startX: number;
    startY: number;
    isDragging: boolean;
    clone: HTMLElement | null;
    sourceRect: DOMRect | null;
    currentOrder: DesktopItem[];
  } | null>(null);

  // Keep displayItems in sync when orderedItems changes (space switch, new artifacts)
  useEffect(() => {
    if (!dragState.current?.isDragging) {
      setDisplayItems(orderedItems);
    }
  }, [orderedItems]);

  const getGridSlotFromPoint = useCallback((clientX: number, clientY: number): number => {
    const grid = gridRef.current;
    if (!grid) return -1;
    const rect = grid.getBoundingClientRect();
    const style = getComputedStyle(grid);
    const padLeft = parseFloat(style.paddingLeft);
    const padTop = parseFloat(style.paddingTop);
    const gap = parseFloat(style.gap) || 12;
    const colWidth = 130;

    const innerWidth = rect.width - padLeft - parseFloat(style.paddingRight);
    const cols = Math.max(1, Math.floor((innerWidth + gap) / (colWidth + gap)));

    const x = clientX - rect.left - padLeft;
    const y = clientY - rect.top - padTop + grid.scrollTop;

    // Get actual item height from first child
    const firstChild = grid.firstElementChild as HTMLElement | null;
    const itemH = firstChild ? firstChild.offsetHeight : 120;

    const col = Math.max(0, Math.min(cols - 1, Math.floor((x + gap / 2) / (colWidth + gap))));
    const row = Math.max(0, Math.floor((y + gap / 2) / (itemH + gap)));
    return row * cols + col;
  }, []);

  const onPointerDown = useCallback((e: PointerEvent, key: string) => {
    if (e.button !== 0) return;
    if (sortMode !== "alpha") return; // sorted modes: no manual reorder
    const target = e.currentTarget as HTMLElement;
    dragState.current = {
      key,
      startX: e.clientX,
      startY: e.clientY,
      isDragging: false,
      clone: null,
      sourceRect: target.getBoundingClientRect(),
      currentOrder: displayItems,
    };
  }, [displayItems, sortMode]);

  useEffect(() => {
    function onMove(e: globalThis.PointerEvent) {
      const ds = dragState.current;
      if (!ds) return;

      if (!ds.isDragging) {
        const dx = e.clientX - ds.startX;
        const dy = e.clientY - ds.startY;
        if (Math.sqrt(dx * dx + dy * dy) < DRAG_THRESHOLD) return;

        // Start dragging — create floating clone
        ds.isDragging = true;
        setDragKey(ds.key);

        const grid = gridRef.current;
        if (!grid) return;

        // Find the source element
        const items = grid.querySelectorAll<HTMLElement>("[data-drag-key]");
        let sourceEl: HTMLElement | null = null;
        items.forEach((el) => {
          if (el.dataset.dragKey === ds.key) sourceEl = el;
        });
        if (!sourceEl) return;

        const rect = sourceEl.getBoundingClientRect();
        ds.sourceRect = rect;

        const clone = sourceEl.cloneNode(true) as HTMLElement;
        clone.className = sourceEl.className + " drag-clone";
        clone.style.position = "fixed";
        clone.style.left = rect.left + "px";
        clone.style.top = rect.top + "px";
        clone.style.width = rect.width + "px";
        clone.style.height = rect.height + "px";
        clone.style.zIndex = "10000";
        clone.style.pointerEvents = "none";
        clone.style.opacity = "1";
        clone.style.transition = "transform 0.05s ease";
        document.body.appendChild(clone);
        ds.clone = clone;

        document.body.style.userSelect = "none";
      }

      // Move clone
      if (ds.clone && ds.sourceRect) {
        const dx = e.clientX - ds.startX;
        const dy = e.clientY - ds.startY;
        ds.clone.style.transform = `translate(${dx}px, ${dy}px) scale(1.08)`;
      }

      // Calculate which slot cursor is over and reorder
      const slotIndex = getGridSlotFromPoint(e.clientX, e.clientY);
      if (slotIndex < 0) return;

      const order = [...ds.currentOrder];
      const fromIndex = order.findIndex((it) => it.key === ds.key);
      if (fromIndex < 0) return;

      const toIndex = Math.min(slotIndex, order.length - 1);
      if (fromIndex !== toIndex) {
        const [moved] = order.splice(fromIndex, 1);
        order.splice(toIndex, 0, moved);
        ds.currentOrder = order;
        setDisplayItems(order);
      }
    }

    function onUp() {
      const ds = dragState.current;
      if (!ds) return;

      if (ds.isDragging) {
        // Save order
        setStoredOrder(space, ds.currentOrder.map((it) => it.key));
        setDisplayItems(ds.currentOrder);

        // Cleanup clone
        if (ds.clone) {
          ds.clone.remove();
        }
        document.body.style.userSelect = "";
        setDragKey(null);
      }

      dragState.current = null;
    }

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [space, getGridSlotFromPoint]);

  const kindLabel = (k: string) =>
    k === "notes" ? "notes" : k + "s";

  const dir = sortDir === "asc" ? 1 : -1;

  const sortArtifacts = useCallback((arts: Artifact[]): Artifact[] => {
    if (sortMode === "timeline") {
      return [...arts].sort((a, b) => dir * (new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()));
    }
    if (sortMode === "kind") {
      return [...arts].sort((a, b) => {
        const k = a.artifactKind.localeCompare(b.artifactKind);
        if (k !== 0) return dir * k;
        return a.label.localeCompare(b.label);
      });
    }
    if (sortMode === "space") {
      return [...arts].sort((a, b) => {
        const s = a.spaceId.localeCompare(b.spaceId);
        if (s !== 0) return dir * s;
        return a.label.localeCompare(b.label);
      });
    }
    return [...arts].sort((a, b) => dir * a.label.localeCompare(b.label));
  }, [sortMode, sortDir]);

  const listSections = useMemo(() => {
    type Section = { key: string; header: string | null; artifacts: Artifact[] };

    // __all__ groups by space or kind; sortMode applies within each section
    if (isAllSpace) {
      if (groupBy === "none") {
        return [{ key: "__all__", header: null, artifacts: sortArtifacts(filteredArtifacts) }] as Section[];
      }
      if (groupBy === "kind") {
        const kindMap: Record<string, Artifact[]> = {};
        for (const a of filteredArtifacts) (kindMap[a.artifactKind] ??= []).push(a);
        return Object.keys(kindMap).sort().map((k) => ({
          key: `kind:${k}`,
          header: kindLabel(k),
          artifacts: sortArtifacts(kindMap[k]),
        })) as Section[];
      }
      const spaceMap: Record<string, Artifact[]> = {};
      for (const a of filteredArtifacts) (spaceMap[a.spaceId] ??= []).push(a);
      return Object.keys(spaceMap).sort().map((id) => ({
        key: `space:${id}`,
        header: id,
        artifacts: sortArtifacts(spaceMap[id]),
      })) as Section[];
    }

    if (sortMode === "group") {
      const groupMap: Record<string, Artifact[]> = {};
      const ungrouped: Artifact[] = [];
      for (const a of filteredArtifacts) {
        if (a.groupName) (groupMap[a.groupName] ??= []).push(a);
        else ungrouped.push(a);
      }
      const sections: Section[] = Object.keys(groupMap).sort().map((g) => ({
        key: `group:${g}`,
        header: g,
        artifacts: groupMap[g].sort((a, b) => a.label.localeCompare(b.label)),
      }));
      if (ungrouped.length) sections.push({
        key: "__ungrouped__",
        header: ungrouped.length === filteredArtifacts.length ? null : "Other",
        artifacts: ungrouped.sort((a, b) => a.label.localeCompare(b.label)),
      });
      return sections;
    }

    if (sortMode === "alpha") {
      const sorted = [...filteredArtifacts].sort((a, b) => a.label.localeCompare(b.label));
      return [{ key: "__all__", header: null, artifacts: sorted }] as Section[];
    }

    if (sortMode === "kind") {
      const kindMap: Record<string, Artifact[]> = {};
      for (const a of filteredArtifacts) (kindMap[a.artifactKind] ??= []).push(a);
      const sortedKinds = Object.keys(kindMap).sort();
      return sortedKinds.map((k) => ({
        key: `kind:${k}`,
        header: kindLabel(k),
        artifacts: kindMap[k].sort((a, b) => a.label.localeCompare(b.label)),
      })) as Section[];
    }

    // timeline
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const weekStart = new Date(todayStart.getTime() - 6 * 24 * 60 * 60 * 1000);
    const monthStart = new Date(todayStart.getTime() - 29 * 24 * 60 * 60 * 1000);
    const bucket = (iso: string) => {
      const d = new Date(iso);
      if (d >= todayStart) return "Today";
      if (d >= weekStart) return "This week";
      if (d >= monthStart) return "This month";
      return "Earlier";
    };
    const sorted = [...filteredArtifacts].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
    const bucketMap: Record<string, Artifact[]> = {};
    for (const a of sorted) (bucketMap[bucket(a.createdAt)] ??= []).push(a);
    const BUCKET_ORDER = ["Today", "This week", "This month", "Earlier"];
    return BUCKET_ORDER
      .filter((b) => bucketMap[b]?.length)
      .map((b) => ({ key: b, header: b, artifacts: bucketMap[b] })) as Section[];
  }, [filteredArtifacts, isAllSpace, sortMode, sortArtifacts, groupBy]);

  const allGridSections = useMemo(() => {
    if (!isAllSpace) return null;
    if (groupBy === "none") return null;
    if (groupBy === "kind") {
      const kindMap: Record<string, Artifact[]> = {};
      for (const a of filteredArtifacts) (kindMap[a.artifactKind] ??= []).push(a);
      return Object.keys(kindMap).sort().map((k) => ({
        spaceId: k,
        header: kindLabel(k),
        artifacts: sortArtifacts(kindMap[k]),
      }));
    }
    const spaceMap: Record<string, Artifact[]> = {};
    for (const a of filteredArtifacts) (spaceMap[a.spaceId] ??= []).push(a);
    return Object.keys(spaceMap).sort().map((id) => ({
      spaceId: id,
      header: id,
      artifacts: sortArtifacts(spaceMap[id]),
    }));
  }, [filteredArtifacts, isAllSpace, sortArtifacts, groupBy]);

  return (
    <div className="desktop">
      <div className="desktop-bg">
        <Grainient
          color1="#07060f"
          color2="#7c6bff"
          color3="#5227FF"
          timeSpeed={0.15}
          colorBalance={0}
          warpStrength={2}
          warpFrequency={6.5}
          warpSpeed={2}
          warpAmplitude={20}
          blendAngle={0}
          blendSoftness={0.05}
          rotationAmount={500}
          noiseScale={2}
          grainAmount={0.15}
          grainScale={2}
          grainAnimated={false}
          contrast={1.2}
          gamma={0.8}
          saturation={0.7}
          centerX={0}
          centerY={0}
          zoom={1}
        />
      </div>

      <div className="topbar-hover-zone" onMouseEnter={showTopbar} />
      <div
        className={`desktop-topbar${topbarVisible ? "" : " desktop-topbar-hidden"}`}
        onMouseEnter={showTopbar}
        onMouseLeave={scheduleHideTopbar}
      >
        <div className="topbar-left">
          <div className="ctrl-group-labeled">
            <span className="ctrl-group-label">sort</span>
            <div className="ctrl-group">
              <button className={`view-btn${sortMode === "alpha" ? " active" : ""}`} onClick={() => setAndSaveSortMode("alpha")} title="A–Z">
                <ArrowDownAZ size={13} />
              </button>
              <button className={`view-btn${sortMode === "kind" ? " active" : ""}`} onClick={() => setAndSaveSortMode("kind")} title="By kind">
                <Tag size={13} />
              </button>
              <button className={`view-btn${sortMode === "timeline" ? " active" : ""}`} onClick={() => setAndSaveSortMode("timeline")} title="Recent">
                <Clock size={13} />
              </button>
              {!isAllSpace && (
                <button className={`view-btn${sortMode === "group" ? " active" : ""}`} onClick={() => setAndSaveSortMode("group")} title="By folder">
                  <Folder size={13} />
                </button>
              )}
            </div>
          </div>
          {isAllSpace && (
            <>
              <div className="ctrl-group-labeled">
                <span className="ctrl-group-label">group</span>
                <div className="ctrl-group">
                  <button className={`view-btn filter-pill-btn${groupBy === "none" ? " active" : ""}`} onClick={() => setAndSaveGroupBy("none")}>none</button>
                  <button className={`view-btn filter-pill-btn${groupBy === "space" ? " active" : ""}`} onClick={() => setAndSaveGroupBy("space")}>space</button>
                  <button className={`view-btn filter-pill-btn${groupBy === "kind" ? " active" : ""}`} onClick={() => setAndSaveGroupBy("kind")}>kind</button>
                </div>
              </div>
              <div className="ctrl-group-labeled">
                <span className="ctrl-group-label">align</span>
                <div className="ctrl-group">
                  <button className={`view-btn${headerAlign === "left" ? " active" : ""}`} onClick={() => setAndSaveHeaderAlign("left")} title="Left"><AlignLeft size={13} /></button>
                  <button className={`view-btn${headerAlign === "center" ? " active" : ""}`} onClick={() => setAndSaveHeaderAlign("center")} title="Center"><AlignCenter size={13} /></button>
                  <button className={`view-btn${headerAlign === "right" ? " active" : ""}`} onClick={() => setAndSaveHeaderAlign("right")} title="Right"><AlignRight size={13} /></button>
                </div>
              </div>
            </>
          )}
          <div className="ctrl-group-labeled">
            <span className="ctrl-group-label">show</span>
            <div className="ctrl-group topbar-filter-pills">
              <button className={`view-btn filter-pill-btn${!activeKind ? " active" : ""}`} onClick={() => selectKind(null)}>all</button>
              {uniqueKinds.map((k) => (
                <button key={k} className={`view-btn filter-pill-btn${activeKind === k ? " active" : ""}`} onClick={() => selectKind(k)}>{kindLabel(k)}</button>
              ))}
            </div>
          </div>
        </div>

        <div className="topbar-right" />
      </div>

      <div className={`desktop-scroll${isHero ? " desktop-scroll--hero" : ""}`}>
        {activeKind ? (
          <div className="filter-notice">
            <span>Showing</span>
            <div className="filter-notice-kind-wrap">
              <button
                className="filter-notice-kind"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => setKindDropdownOpen((v) => !v)}
              >
                {kindLabel(activeKind)} ▾
              </button>
              {kindDropdownOpen && (
                <div className="filter-kind-dropdown">
                  {uniqueKinds.filter((k) => k !== activeKind).map((k) => (
                    <button
                      key={k}
                      className="filter-kind-option"
                      onClick={() => { selectKind(k); setKindDropdownOpen(false); }}
                    >
                      {kindLabel(k)}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <button className="filter-notice-clear" onClick={() => { selectKind(null); setKindDropdownOpen(false); }}>✕</button>
          </div>
        ) : (
          <div className="view-toggle-float">
            <button className={`view-btn${viewMode === "grid" ? " active" : ""}`} onClick={() => setAndSaveViewMode("grid")} title="Grid">
              <LayoutGrid size={13} />
            </button>
            <button className={`view-btn${viewMode === "list" ? " active" : ""}`} onClick={() => setAndSaveViewMode("list")} title="List">
              <List size={13} />
            </button>
          </div>
        )}
        {viewMode === "list" ? (
          <div className={`list-view${isAllSpace && groupBy === "kind" ? " list-view--no-badge" : ""}${!isAllSpace || groupBy === "space" ? " list-view--no-space" : ""}`}>
            <div className="list-col-headers">
              <span />
              <button className={`list-col-header${sortMode === "alpha" ? " active" : ""}`} onClick={() => handleColSort("alpha")}>
                Name{sortMode === "alpha" ? (sortDir === "desc" ? " ↓" : " ↑") : ""}
              </button>
              {(!isAllSpace || groupBy !== "kind") && (
                <button className={`list-col-header list-col-header--right${sortMode === "kind" ? " active" : ""}`} onClick={() => handleColSort("kind")}>
                  Kind{sortMode === "kind" ? (sortDir === "desc" ? " ↓" : " ↑") : ""}
                </button>
              )}
              {isAllSpace && groupBy !== "space" && (
                <button className={`list-col-header list-col-header--right${sortMode === "space" ? " active" : ""}`} onClick={() => handleColSort("space")}>
                  Space{sortMode === "space" ? (sortDir === "desc" ? " ↓" : " ↑") : ""}
                </button>
              )}
            </div>
            {listSections.map((section) => (
              <div key={section.key} className="list-section">
                {section.header && (
                  <div className="list-section-header" style={{ textAlign: headerAlign }}>{section.header}</div>
                )}
                {section.artifacts.map((a) => (
                  <div key={a.id} className="list-row" onClick={() => onArtifactClick(a)}>
                    <div className="list-row-dot" style={{ background: (typeConfig[a.artifactKind] || typeConfig.app).color }} />
                    <span className="list-row-label">{a.label}</span>
                    {(!isAllSpace || groupBy !== "kind") && <span className="list-row-badge">{a.artifactKind}</span>}
                    {isAllSpace && groupBy !== "space" && (() => {
                      const c = spaceColor(a.spaceId);
                      return <span className="list-row-space" style={{ color: c, background: `${c}28` }}>{a.spaceId}</span>;
                    })()}
                  </div>
                ))}
              </div>
            ))}
          </div>
        ) : isAllSpace && allGridSections ? (
          <div className="all-grid-view">
            {allGridSections.map((section) => (
              <div key={section.spaceId} className="all-grid-section">
                <div className="all-grid-section-header" style={{ textAlign: headerAlign }}>{section.header}</div>
                <div className="icon-grid icon-grid--inline" style={{ justifyContent: headerAlign === "left" ? "start" : headerAlign === "right" ? "end" : "center" }}>
                  {section.artifacts.map((a, i) => (
                    <ArtifactIcon
                      key={a.id}
                      artifact={a}
                      index={i}
                      onClick={() => onArtifactClick(a)}
                      onStop={onArtifactStop ? () => onArtifactStop(a) : undefined}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="icon-grid" ref={gridRef}>
            {displayItems.map((item, i) => {
              const isDragged = item.key === dragKey;
              if (item.type === "group") {
                return (
                  <div
                    key={item.key}
                    data-drag-key={item.key}
                    className={isDragged ? "drag-placeholder" : ""}
                    onPointerDown={(e) => onPointerDown(e, item.key)}
                    style={isDragged ? undefined : { transition: "transform 0.25s ease" }}
                  >
                    <GroupIcon name={item.name} artifacts={item.artifacts} index={i} onClick={() => onGroupClick(item.name)} />
                  </div>
                );
              }
              return (
                <div
                  key={item.key}
                  data-drag-key={item.key}
                  className={isDragged ? "drag-placeholder" : ""}
                  onPointerDown={(e) => onPointerDown(e, item.key)}
                  style={isDragged ? undefined : { transition: "transform 0.25s ease" }}
                >
                  <ArtifactIcon
                    artifact={item.artifact}
                    index={i}
                    onClick={() => onArtifactClick(item.artifact)}
                    onStop={onArtifactStop ? () => onArtifactStop(item.artifact) : undefined}
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
