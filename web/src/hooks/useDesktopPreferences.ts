import { useState, useMemo, useEffect } from "react";
import type { Artifact } from "../data/artifacts-api";

const VIEW_MODE_KEY = "oyster-view-mode";
const SORT_DIR_KEY = "oyster-sort-dir";
const SORT_KEY_PREFIX = "oyster-sort-mode:";
const GROUP_BY_KEY = "oyster-group-by";
const HEADER_ALIGN_KEY = "oyster-header-align";
const ACTIVE_KIND_KEY = "oyster-active-kind";
const FLAT_MODE_KEY_PREFIX = "oyster-flat-mode:";

export type SortMode = "alpha" | "kind" | "timeline" | "space" | "group";
export type SortDir = "asc" | "desc";
export type ViewMode = "grid" | "list";
export type GroupBy = "space" | "kind" | "none";
export type HeaderAlign = "left" | "center" | "right";

function lsGet(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function lsSet(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch { /* ignore */ }
}
function lsRemove(key: string) {
  try { localStorage.removeItem(key); } catch { /* ignore */ }
}

export function useDesktopPreferences(space: string, artifacts: Artifact[]) {
  const [viewMode, setViewMode] = useState<ViewMode>(() =>
    lsGet(VIEW_MODE_KEY) === "list" ? "list" : "grid",
  );

  const [sortMode, setSortMode] = useState<SortMode>(() => {
    const s = lsGet(SORT_KEY_PREFIX + space);
    if (s === "alpha" || s === "kind" || s === "timeline" || s === "space") return s;
    return "alpha";
  });

  const [sortDir, setSortDir] = useState<SortDir>(() =>
    lsGet(SORT_DIR_KEY) === "desc" ? "desc" : "asc",
  );

  const [groupBy, setGroupBy] = useState<GroupBy>(() => {
    const s = lsGet(GROUP_BY_KEY);
    if (s === "space" || s === "kind" || s === "none") return s;
    return "space";
  });

  const [headerAlign, setHeaderAlign] = useState<HeaderAlign>(() => {
    const s = lsGet(HEADER_ALIGN_KEY);
    if (s === "left" || s === "center" || s === "right") return s;
    return "center";
  });

  const [activeKind, setActiveKind] = useState<string | null>(() => lsGet(ACTIVE_KIND_KEY));

  const [flatMode, setFlatMode] = useState<boolean>(() =>
    lsGet(FLAT_MODE_KEY_PREFIX + space) === "true",
  );

  const [kindDropdownOpen, setKindDropdownOpen] = useState(false);

  // Sync sort mode + flat mode when space tab changes — reactive reset from
  // localStorage per space, not derivable without an effect since it reads
  // external (browser) state.
  useEffect(() => {
    const s = lsGet(SORT_KEY_PREFIX + space);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSortMode(s === "alpha" || s === "kind" || s === "timeline" ? s : "alpha");
    setFlatMode(lsGet(FLAT_MODE_KEY_PREFIX + space) === "true");
  }, [space]);

  // Close kind dropdown on outside click
  useEffect(() => {
    if (!kindDropdownOpen) return;
    function close() { setKindDropdownOpen(false); }
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [kindDropdownOpen]);

  function setAndSaveViewMode(mode: ViewMode) {
    setViewMode(mode); lsSet(VIEW_MODE_KEY, mode);
  }
  function setAndSaveSortMode(mode: SortMode) {
    setSortMode(mode); lsSet(SORT_KEY_PREFIX + space, mode);
  }
  function setAndSaveSortDir(dir: SortDir) {
    setSortDir(dir); lsSet(SORT_DIR_KEY, dir);
  }
  function setAndSaveFlatMode(value: boolean) {
    setFlatMode(value); lsSet(FLAT_MODE_KEY_PREFIX + space, String(value));
  }
  function setAndSaveGroupBy(mode: GroupBy) {
    setGroupBy(mode); lsSet(GROUP_BY_KEY, mode);
  }
  function setAndSaveHeaderAlign(align: HeaderAlign) {
    setHeaderAlign(align); lsSet(HEADER_ALIGN_KEY, align);
  }
  function selectKind(k: string | null) {
    setActiveKind(k);
    if (k) lsSet(ACTIVE_KIND_KEY, k); else lsRemove(ACTIVE_KIND_KEY);
  }
  function handleColSort(mode: "alpha" | "kind" | "timeline" | "space") {
    if (sortMode === mode) {
      setAndSaveSortDir(sortDir === "asc" ? "desc" : "asc");
    } else {
      setAndSaveSortMode(mode);
      setAndSaveSortDir("asc");
    }
  }

  const uniqueKinds = useMemo(
    () => Array.from(new Set(artifacts.map((a) => a.artifactKind))).sort(),
    [artifacts],
  );

  const filteredArtifacts = useMemo(
    () => (activeKind ? artifacts.filter((a) => a.artifactKind === activeKind) : artifacts),
    [artifacts, activeKind],
  );

  // When a kind filter is active, always flatten — folders add no value
  const effectiveFlatMode = flatMode || !!activeKind;

  return {
    viewMode, setAndSaveViewMode,
    sortMode, setAndSaveSortMode,
    sortDir,
    groupBy, setAndSaveGroupBy,
    headerAlign, setAndSaveHeaderAlign,
    activeKind, selectKind,
    flatMode, setAndSaveFlatMode, effectiveFlatMode,
    kindDropdownOpen, setKindDropdownOpen,
    handleColSort,
    uniqueKinds,
    filteredArtifacts,
  };
}
