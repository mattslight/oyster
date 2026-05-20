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
import type { PresenceInfo } from "../../hooks/useTerminalPresence";

interface SessionRowProps {
  session: Session;
  spaces: Space[];
  /** Local device id; drives the cross-device chip. See SessionTile. */
  myDeviceId: string | null;
  /** Presence info from useTerminalPresence; undefined when no live terminal. */
  livePresence?: PresenceInfo;
  onOpen?: (id: string) => void;
  /** Focus an already-open terminal window for this session. */
  onTerminalFocus?: (terminalId: string) => void;
  /** Restore a minimised terminal window for this session. */
  onTerminalRestore?: (sessionId: string, terminalId: string) => void;
  /** Resume a non-live session (spawns `claude --resume <id>`). */
  onResume?: (sessionId: string) => void;
}

export function SessionRow({ session, spaces, myDeviceId, livePresence, onOpen, onTerminalFocus, onTerminalRestore, onResume }: SessionRowProps) {
  const spaceLabel = spaceLabelFor(session.spaceId, spaces);
  const rel = formatRelative(session.lastEventAt) ?? "—";
  const time = session.state === "waiting" ? `waiting ${rel}`
    : session.state === "disconnected" ? `disconnected ${rel}`
    : rel;
  const title = session.title ?? "(no title yet)";
  // Prefer the most specific label available: space > cwd basename for
  // orphan sessions. Always tooltip the full cwd so the user can identify
  // where the session was running.
  const cwdBasename = session.cwd ? session.cwd.split(/[\\/]/).filter(Boolean).pop() ?? null : null;
  const projectLabel = spaceLabel ?? cwdBasename ?? "—";
  const remoteChip = originDeviceChipFor(session, myDeviceId);
  const activeChip = activeWriterChipFor(session, myDeviceId);
  const isManual = session.assignmentMode === "manual";
  const rowExtraClass = livePresence
    ? (livePresence.state === "attached" ? " sr--attached" : " sr--running")
    : "";
  const statusDotClass = livePresence
    ? (livePresence.state === "attached" ? "rd--attached" : "rd--running")
    : session.state;

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

  // Row click always opens the Session Inspector. The Connect chip (live
  // sessions) and Resume chip (non-live sessions) handle the terminal
  // restore / resume paths so the row's primary action stays predictable.
  const handleRowActivate = () => {
    if (onOpen) onOpen(session.id);
  };

  // Connect (live row): focus the open terminal or restore the minimised one.
  // Resume (non-live row): spawn claude --resume in this session's cwd.
  const handleConnect = () => {
    if (!livePresence) return;
    if (livePresence.state === "attached") onTerminalFocus?.(livePresence.terminalId);
    else onTerminalRestore?.(session.id, livePresence.terminalId);
  };
  const canResume = !livePresence && !!onResume;
  return (
    <div
      className={`home-row${rowExtraClass}`}
      onClick={handleRowActivate}
      onKeyDown={onOpen ? (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); handleRowActivate(); }
      } : undefined}
      role={onOpen ? "button" : undefined}
      tabIndex={onOpen ? 0 : undefined}
    >
      <span className={`home-row-status ${statusDotClass}`} />
      <span className="home-row-space" title={session.cwd ?? undefined}>{projectLabel}</span>
      <span className="home-row-title">
        <span className="home-row-title-inner" title={title}>
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
        {livePresence && (
          <button
            type="button"
            className="sl-chip sl-chip--connect"
            onClick={(e) => { e.stopPropagation(); handleConnect(); }}
            title={livePresence.state === "attached" ? "Bring the open terminal forward" : "Restore this minimised terminal"}
          >
            Connect
          </button>
        )}
        {canResume && (
          <button
            type="button"
            className="sl-chip sl-chip--resume"
            onClick={(e) => { e.stopPropagation(); onResume!(session.id); }}
            title="Start a new claude --resume in this session's folder"
          >
            Resume
          </button>
        )}
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
