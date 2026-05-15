// Session row (table-view list item). Extracted from Home/index.tsx.
import { useEffect, useState } from "react";
import type { Session } from "../../data/sessions-api";
import { patchSession } from "../../data/sessions-api";
import { fetchSpaceSources, type SpaceSource } from "../../data/spaces-api";
import type { Space } from "../../../../shared/types";
import {
  AGENT_PIP_CLASS, activeWriterChipFor, formatRelative,
  originDeviceChipFor, spaceLabelFor,
} from "./utils";

interface SessionRowProps {
  session: Session;
  spaces: Space[];
  /** Local device id; drives the cross-device chip. See SessionTile. */
  myDeviceId: string | null;
  onOpen?: (id: string) => void;
}

export function SessionRow({ session, spaces, myDeviceId, onOpen }: SessionRowProps) {
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
  const remoteChip = originDeviceChipFor(session, myDeviceId);
  const activeChip = activeWriterChipFor(session, myDeviceId);
  const isManual = session.assignmentMode === "manual";

  const [menuOpen, setMenuOpen] = useState(false);
  const [sourcesForSpace, setSourcesForSpace] = useState<SpaceSource[] | null>(null);
  const [sourcesLoading, setSourcesLoading] = useState(false);
  const [busy, setBusy] = useState(false);

  // Lazy-load the available sources the first time the menu opens. Scoped
  // to the session's current space (same-space moves are the common case;
  // cross-space moves go through MCP for now).
  useEffect(() => {
    if (!menuOpen || sourcesForSpace !== null || sourcesLoading) return;
    if (!session.spaceId) {
      setSourcesForSpace([]);
      return;
    }
    setSourcesLoading(true);
    fetchSpaceSources(session.spaceId)
      .then(setSourcesForSpace)
      .catch(() => setSourcesForSpace([]))
      .finally(() => setSourcesLoading(false));
  }, [menuOpen, sourcesForSpace, sourcesLoading, session.spaceId]);

  // Close on outside click — same pattern as ProjectTile.
  useEffect(() => {
    if (!menuOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (!(e.target as HTMLElement)?.closest(".home-row-menu, .home-row-more")) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("click", onDocClick);
    return () => document.removeEventListener("click", onDocClick);
  }, [menuOpen]);

  async function run(action: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    try {
      await action();
      setMenuOpen(false);
    } catch (err) {
      alert(`Couldn't update session: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  }

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
      <span className="home-row-title" title={title}>
        {remoteChip && (
          <span className="home-remote-chip" title={remoteChip.titleTooltip}>
            <span aria-hidden="true">↗</span> {remoteChip.label}
          </span>
        )}
        {activeChip && (
          <span className="home-active-chip" title={activeChip.titleTooltip}>
            {activeChip.label}
          </span>
        )}
        {isManual && (
          <span className="home-manual-chip" title="Pinned manually — Oyster's heuristic won't reassign this.">
            pinned
          </span>
        )}
        {title}
      </span>
      <span className={`home-row-agent ${AGENT_PIP_CLASS[session.agent]}`}>
        <span className="home-agent-pip" />
        {session.agent}
      </span>
      <span className="home-row-time">{time}</span>
      <button
        type="button"
        className={`home-row-more${menuOpen ? " open" : ""}`}
        onClick={(e) => { e.stopPropagation(); setMenuOpen((v) => !v); }}
        aria-label="Session actions"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
      >
        ⋯
      </button>
      {menuOpen && (
        <div
          className="home-row-menu"
          role="menu"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="home-row-menu-section-label">Move to source</div>
          {sourcesLoading ? (
            <div className="home-row-menu-hint">Loading…</div>
          ) : sourcesForSpace && sourcesForSpace.length > 0 ? (
            sourcesForSpace.map((s) => {
              const isCurrent = s.id === session.sourceId;
              const basename = s.path.split(/[\\/]/).filter(Boolean).pop() ?? s.path;
              return (
                <button
                  key={s.id}
                  type="button"
                  className="home-row-menu-item"
                  disabled={busy || isCurrent}
                  onClick={() => run(() => patchSession(session.id, { source_id: s.id }))}
                >
                  <span className="home-row-menu-item-label">{s.label ?? basename}</span>
                  {isCurrent && <span className="home-row-menu-item-hint">current</span>}
                </button>
              );
            })
          ) : (
            <div className="home-row-menu-hint">No folders attached in this space.</div>
          )}
          <div className="home-row-menu-divider" />
          <button
            type="button"
            className="home-row-menu-item"
            disabled={busy || session.sourceId === null}
            onClick={() => run(() => patchSession(session.id, { source_id: null }))}
          >
            Send to space vault
          </button>
          <button
            type="button"
            className="home-row-menu-item"
            disabled={busy || !isManual}
            onClick={() => run(() => patchSession(session.id, { assignment_mode: "auto" }))}
            title="Recompute the binding via longest-prefix match on this session's working directory."
          >
            Let Oyster decide
          </button>
        </div>
      )}
    </div>
  );
}
