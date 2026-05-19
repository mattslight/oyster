// Centered command-palette modal for starting a fresh Claude session.
// Renders search + grouped list (recents, then all). Keyboard nav +
// disabled rows. Spawn wiring is added in a follow-up task — for now
// `onActivate` is the seam.

import { useEffect, useMemo, useRef, useState } from "react";
import type { Project } from "../data/projects-api";
import type { Space } from "../../../shared/types";
import { getRecentProjectIds } from "../lib/new-session-recents";
import "./NewSessionPicker.css";

export interface NewSessionPickerProps {
  /** True when the modal should be mounted. Parent controls open/close. */
  open: boolean;
  /** Fired when the user presses Esc or clicks the overlay. */
  onClose: () => void;
  /** Pre-fill text for the search input (e.g. active space name when
   *  invoked from inside a multi-project space). */
  initialQuery?: string;
  /** Projects across all spaces. Loaded by the parent via `useAllProjects`. */
  projects: Project[];
  /** Spaces for breadcrumb display + folder-attach dropdown. */
  spaces: Space[];
  /** Fired when a non-disabled row is activated (click or ↵). */
  onActivate: (project: Project) => void;
  /** Error to surface inline (e.g. binary_not_found). Cleared by the parent. */
  errorMessage?: string | null;
}

interface Row {
  project: Project;
  spaceName: string;
  group: "recent" | "all";
  disabled: boolean;
}

export function NewSessionPicker({
  open, onClose, initialQuery, projects, spaces, onActivate, errorMessage,
}: NewSessionPickerProps) {
  const [query, setQuery] = useState(initialQuery ?? "");
  const [highlightIdx, setHighlightIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Reset state every open. We deliberately don't preserve search across
  // open/close — each invocation is a fresh task.
  useEffect(() => {
    if (open) {
      setQuery(initialQuery ?? "");
      setHighlightIdx(0);
      // Focus on next tick so the modal mounts before the focus call.
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open, initialQuery]);

  // Esc closes; ↑↓ moves highlight; ↵ activates. Mounted only while open.
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setHighlightIdx((i) => Math.min(i + 1, rows.length - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setHighlightIdx((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        const row = rows[highlightIdx];
        if (row && !row.disabled) onActivate(row.project);
        return;
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
    // No dep array: handler closes over `rows`/`highlightIdx` so it always
    // sees current values without stale-closure bugs. The attach/detach
    // cost on every render is negligible for a small modal. Refs would be
    // more idiomatic if this list ever gets long; for v1 this is fine.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  });

  const spaceNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const s of spaces) map.set(s.id, s.displayName ?? s.id);
    return map;
  }, [spaces]);

  const recentIds = useMemo(() => getRecentProjectIds(), [open]);

  const rows: Row[] = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matches = (p: Project) => {
      if (!q) return true;
      const name = p.name.toLowerCase();
      const path = (p.recentPath ?? "").toLowerCase();
      const space = (spaceNameById.get(p.spaceId) ?? "").toLowerCase();
      return name.includes(q) || path.includes(q) || space.includes(q);
    };

    const filtered = projects.filter(matches);
    const recentSet = new Set(recentIds);
    const recents = recentIds
      .map((id) => filtered.find((p) => p.id === id))
      .filter((p): p is Project => !!p);
    const others = filtered.filter((p) => !recentSet.has(p.id));

    const toRow = (p: Project, group: "recent" | "all"): Row => ({
      project: p,
      spaceName: spaceNameById.get(p.spaceId) ?? p.spaceId,
      group,
      disabled: p.hasLivePath === false,
    });

    return [
      ...recents.map((p) => toRow(p, "recent")),
      ...others.map((p) => toRow(p, "all")),
    ];
  }, [projects, query, recentIds, spaceNameById]);

  // Keep highlight in range when rows shrink (e.g. user types and the
  // list filters to fewer items).
  useEffect(() => {
    if (highlightIdx >= rows.length) setHighlightIdx(Math.max(0, rows.length - 1));
  }, [rows.length, highlightIdx]);

  const recentRows = rows.filter((r) => r.group === "recent");
  const allRows = rows.filter((r) => r.group === "all");

  if (!open) return null;

  return (
    <div
      className="nsp-overlay"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="nsp-modal" role="dialog" aria-modal="true" aria-label="Start new session">
        <div className="nsp-search-row">
          <input
            ref={inputRef}
            className="nsp-search-input"
            placeholder="Search projects…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <span className="nsp-search-kbd">⌘N</span>
        </div>

        {errorMessage && <div className="nsp-error">{errorMessage}</div>}

        <div className="nsp-list">
          {rows.length === 0 ? (
            <div className="nsp-empty">No projects match.</div>
          ) : (
            <>
              {recentRows.length > 0 && <div className="nsp-group-label">Recent</div>}
              {recentRows.map((row, idx) => (
                <RowView
                  key={row.project.id}
                  row={row}
                  highlighted={idx === highlightIdx}
                  onClick={() => !row.disabled && onActivate(row.project)}
                />
              ))}
              {allRows.length > 0 && <div className="nsp-group-label">All projects</div>}
              {allRows.map((row, i) => {
                const idx = recentRows.length + i;
                return (
                  <RowView
                    key={row.project.id}
                    row={row}
                    highlighted={idx === highlightIdx}
                    onClick={() => !row.disabled && onActivate(row.project)}
                  />
                );
              })}
            </>
          )}
        </div>

        <div className="nsp-footer">
          <span><span className="nsp-kbd">↑↓</span>nav <span className="nsp-kbd">↵</span>start</span>
          <span><span className="nsp-kbd">esc</span>close</span>
        </div>
      </div>
    </div>
  );
}

function RowView({ row, highlighted, onClick }: {
  row: Row;
  highlighted: boolean;
  onClick: () => void;
}) {
  const path = row.project.recentPath ?? "";
  const meta = row.disabled ? `${row.spaceName} · no folder` : `${row.spaceName} · ${path}`;
  return (
    <div
      className={[
        "nsp-row",
        highlighted && "nsp-row--highlighted",
        row.disabled && "nsp-row--disabled",
      ].filter(Boolean).join(" ")}
      onClick={onClick}
      title={row.disabled ? "This project has no folder on this machine." : undefined}
    >
      <span className="nsp-row-name">{row.project.name}</span>
      <span className="nsp-row-meta">{meta}</span>
    </div>
  );
}
