import { useMemo, useCallback } from "react";
import type { Artifact } from "../data/artifacts-api";
import type { SortMode, SortDir, GroupBy } from "./useDesktopPreferences";

const STORAGE_KEY_PREFIX = "oyster-icon-order:";

export type DesktopItem =
  | { type: "group"; key: string; name: string; artifacts: Artifact[] }
  | { type: "artifact"; key: string; artifact: Artifact };

export function kindLabel(k: string): string {
  return k === "notes" ? "notes" : k + "s";
}

export function getStoredOrder(space: string): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_PREFIX + space);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}

function applyOrder(items: DesktopItem[], order: string[]): DesktopItem[] {
  if (order.length === 0) return items;
  const map = new Map(items.map((it) => [it.key, it]));
  const ordered: DesktopItem[] = [];
  for (const key of order) {
    const item = map.get(key);
    if (item) { ordered.push(item); map.delete(key); }
  }
  for (const item of map.values()) ordered.push(item);
  return ordered;
}

interface Params {
  filteredArtifacts: Artifact[];
  isAllSpace: boolean;
  sortMode: SortMode;
  sortDir: SortDir;
  groupBy: GroupBy;
  space: string;
  flatMode: boolean;
}

export function useDesktopSections({ filteredArtifacts, isAllSpace, sortMode, sortDir, groupBy, space, flatMode }: Params) {
  const dir = sortDir === "asc" ? 1 : -1;

  const sortArtifacts = useCallback((arts: Artifact[]): Artifact[] => {
    if (sortMode === "timeline") {
      return [...arts].sort((a, b) => dir * (new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()));
    }
    if (sortMode === "kind") {
      return [...arts].sort((a, b) => {
        const k = a.artifactKind.localeCompare(b.artifactKind);
        return k !== 0 ? dir * k : a.label.localeCompare(b.label);
      });
    }
    if (sortMode === "space") {
      return [...arts].sort((a, b) => {
        const s = a.spaceId.localeCompare(b.spaceId);
        return s !== 0 ? dir * s : a.label.localeCompare(b.label);
      });
    }
    return [...arts].sort((a, b) => dir * a.label.localeCompare(b.label));
  }, [sortMode, sortDir]); // eslint-disable-line react-hooks/exhaustive-deps

  const { groups, ungrouped } = useMemo(() => {
    const groups: Record<string, Artifact[]> = {};
    const ungrouped: Artifact[] = [];
    if (isAllSpace) {
      for (const a of filteredArtifacts) (groups[a.spaceId] ??= []).push(a);
      return { groups, ungrouped };
    }
    for (const a of filteredArtifacts) {
      if (a.groupName) (groups[a.groupName] ??= []).push(a);
      else ungrouped.push(a);
    }
    return { groups, ungrouped };
  }, [filteredArtifacts, isAllSpace]);

  const baseItems = useMemo<DesktopItem[]>(() => {
    const items: DesktopItem[] = [];
    if (flatMode) {
      // Flatten: all grouped artifacts render individually, no group cards
      for (const name of Object.keys(groups).sort()) {
        for (const artifact of groups[name]) {
          items.push({ type: "artifact", key: artifact.id, artifact });
        }
      }
    } else {
      for (const name of Object.keys(groups).sort()) {
        items.push({ type: "group", key: `group:${name}`, name, artifacts: groups[name] });
      }
    }
    for (const artifact of ungrouped) {
      items.push({ type: "artifact", key: artifact.id, artifact });
    }
    return items;
  }, [groups, ungrouped, flatMode]);

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

  const listSections = useMemo(() => {
    type Section = { key: string; header: string | null; artifacts: Artifact[] };

    if (isAllSpace) {
      if (groupBy === "none") {
        return [{ key: "__all__", header: null, artifacts: sortArtifacts(filteredArtifacts) }] as Section[];
      }
      if (groupBy === "kind") {
        const kindMap: Record<string, Artifact[]> = {};
        for (const a of filteredArtifacts) (kindMap[a.artifactKind] ??= []).push(a);
        return Object.keys(kindMap).sort().map((k) => ({
          key: `kind:${k}`, header: kindLabel(k), artifacts: sortArtifacts(kindMap[k]),
        })) as Section[];
      }
      const spaceMap: Record<string, Artifact[]> = {};
      for (const a of filteredArtifacts) (spaceMap[a.spaceId] ??= []).push(a);
      return Object.keys(spaceMap).sort().map((id) => ({
        key: `space:${id}`, header: id, artifacts: sortArtifacts(spaceMap[id]),
      })) as Section[];
    }

    if (sortMode === "group" && !flatMode) {
      const groupMap: Record<string, Artifact[]> = {};
      const rest: Artifact[] = [];
      for (const a of filteredArtifacts) {
        if (a.groupName) (groupMap[a.groupName] ??= []).push(a);
        else rest.push(a);
      }
      const sections: Section[] = Object.keys(groupMap).sort().map((g) => ({
        key: `group:${g}`, header: g,
        artifacts: groupMap[g].sort((a, b) => a.label.localeCompare(b.label)),
      }));
      if (rest.length) sections.push({
        key: "__ungrouped__",
        header: rest.length === filteredArtifacts.length ? null : "Other",
        artifacts: rest.sort((a, b) => a.label.localeCompare(b.label)),
      });
      return sections;
    }

    if (sortMode === "alpha") {
      return [{ key: "__all__", header: null, artifacts: [...filteredArtifacts].sort((a, b) => a.label.localeCompare(b.label)) }] as Section[];
    }

    if (sortMode === "kind") {
      const kindMap: Record<string, Artifact[]> = {};
      for (const a of filteredArtifacts) (kindMap[a.artifactKind] ??= []).push(a);
      return Object.keys(kindMap).sort().map((k) => ({
        key: `kind:${k}`, header: kindLabel(k),
        artifacts: kindMap[k].sort((a, b) => a.label.localeCompare(b.label)),
      })) as Section[];
    }

    // timeline buckets
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
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
    const bucketMap: Record<string, Artifact[]> = {};
    for (const a of sorted) (bucketMap[bucket(a.createdAt)] ??= []).push(a);
    return (["Today", "This week", "This month", "Earlier"] as const)
      .filter((b) => bucketMap[b]?.length)
      .map((b) => ({ key: b, header: b, artifacts: bucketMap[b] })) as Section[];
  }, [filteredArtifacts, isAllSpace, sortMode, sortArtifacts, groupBy, flatMode]);

  const allGridSections = useMemo(() => {
    if (!isAllSpace || groupBy === "none") return null;
    if (groupBy === "kind") {
      const kindMap: Record<string, Artifact[]> = {};
      for (const a of filteredArtifacts) (kindMap[a.artifactKind] ??= []).push(a);
      return Object.keys(kindMap).sort().map((k) => ({
        spaceId: k, header: kindLabel(k),
        items: sortArtifacts(kindMap[k]).map((a): DesktopItem => ({ type: "artifact", key: a.id, artifact: a })),
      }));
    }
    // groupBy === "space": show artifact-group folders within each space section (unless flatMode)
    const spaceMap: Record<string, Artifact[]> = {};
    for (const a of filteredArtifacts) (spaceMap[a.spaceId] ??= []).push(a);
    return Object.keys(spaceMap).sort().map((id) => {
      const arts = spaceMap[id];
      if (flatMode) {
        return {
          spaceId: id, header: id,
          items: sortArtifacts(arts).map((a): DesktopItem => ({ type: "artifact", key: a.id, artifact: a })),
        };
      }
      const groupMap: Record<string, Artifact[]> = {};
      const ungroupedArts: Artifact[] = [];
      for (const a of arts) {
        if (a.groupName) (groupMap[a.groupName] ??= []).push(a);
        else ungroupedArts.push(a);
      }
      const items: DesktopItem[] = [];
      for (const name of Object.keys(groupMap).sort()) {
        items.push({ type: "group", key: `group:${id}:${name}`, name, artifacts: groupMap[name] });
      }
      for (const a of sortArtifacts(ungroupedArts)) {
        items.push({ type: "artifact", key: a.id, artifact: a });
      }
      return { spaceId: id, header: id, items };
    });
  }, [filteredArtifacts, isAllSpace, sortArtifacts, groupBy, flatMode]);

  return { orderedItems, listSections, allGridSections };
}
