// Session row (table-view list item). Extracted from Home/index.tsx.
import { useEffect, useState } from "react";
import type { Session } from "../../data/sessions-api";
import { patchSession } from "../../data/sessions-api";
import { fetchProjectsForSpace, type Project } from "../../data/projects-api";
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
  // Cache keyed by the spaceId we loaded for, so an empty result (or a
  // failure) doesn't lock subsequent opens out — if the user closes the
  // menu and re-opens it, or the session's space changes, the next open
  // refetches. `null` means "haven't tried for this space yet".
  const [projectsCache, setProjectsCache] = useState<{ spaceId: string | null; projects: Project[] } | null>(null);
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [busy, setBusy] = useState(false);

  // Lazy-load the available projects each time the menu opens for a
  // space we haven't loaded yet. Scoped to the session's current space —
  // same-space moves are the common case; cross-space moves go through
  // the orphan-attach popover or MCP.
  useEffect(() => {
    if (!menuOpen) return;
    if (projectsCache && projectsCache.spaceId === session.spaceId) return;
    if (!session.spaceId) {
      setProjectsCache({ spaceId: null, projects: [] });
      return;
    }
    const targetSpaceId = session.spaceId;
    const ctrl = new AbortController();
    let ignore = false;
    setProjectsLoading(true);
    fetchProjectsForSpace(targetSpaceId, ctrl.signal)
      .then((projects) => { if (!ignore) setProjectsCache({ spaceId: targetSpaceId, projects }); })
      .catch(() => { /* aborted or failed — next open retries */ })
      .finally(() => { if (!ignore) setProjectsLoading(false); });
    return () => {
      ignore = true;
      ctrl.abort();
    };
  }, [menuOpen, projectsCache, session.spaceId]);

  // Reset the cache when the menu closes so a fresh open always sees the
  // latest project list (a user might have just created one).
  useEffect(() => {
    if (!menuOpen) setProjectsCache(null);
  }, [menuOpen]);

  const projectsForSpace = projectsCache?.projects ?? null;

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
          <div className="home-row-menu-section-label">Move to project</div>
          {projectsLoading ? (
            <div className="home-row-menu-hint">Loading…</div>
          ) : projectsForSpace && projectsForSpace.length > 0 ? (
            projectsForSpace.map((p) => {
              const isCurrent = p.id === session.projectId;
              return (
                <button
                  key={p.id}
                  type="button"
                  className="home-row-menu-item"
                  disabled={busy || isCurrent}
                  onClick={() => run(() => patchSession(session.id, { project_id: p.id }))}
                >
                  <span className="home-row-menu-item-label">{p.name}</span>
                  {isCurrent && <span className="home-row-menu-item-hint">current</span>}
                </button>
              );
            })
          ) : (
            <div className="home-row-menu-hint">No projects in this space.</div>
          )}
          <div className="home-row-menu-divider" />
          <button
            type="button"
            className="home-row-menu-item"
            disabled={busy || session.projectId === null}
            onClick={() => run(() => patchSession(session.id, { project_id: null }))}
          >
            Send to space vault
          </button>
        </div>
      )}
    </div>
  );
}
