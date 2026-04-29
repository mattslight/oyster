import { useEffect, useMemo, useState } from "react";
import type { Session, SessionState, SessionAgent } from "../data/sessions-api";
import type { Space } from "../../../shared/types";
import { useSessions } from "../hooks/useSessions";
import { parseTimestamp } from "../utils/parseTimestamp";
import { Desktop } from "./Desktop";
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

// "live" is a preset bundling active+waiting+disconnected (everything that
// isn't archived). It's the default because that's the common case — done
// is review/history, not active inventory. The dot after "live" indicates
// the live cluster ends; the per-state chips after it are for fine-grained
// filtering.
const FILTER_ORDER: StateFilter[] = ["live", "active", "waiting", "disconnected", "done", "all"];
const LIVE_STATES: SessionState[] = ["active", "waiting", "disconnected"];

const EMPTY_COUNTS = { total: 0, active: 0, waiting: 0, disconnected: 0, done: 0 };

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
  const [stateFilter, setStateFilter] = useState<StateFilter>("live");
  const [sessionsView, setSessionsView] = useState<ViewMode>("icons");
  const [artefactsView, setArtefactsView] = useState<ViewMode>("icons");

  // Local "Elsewhere" scope: filters Sessions to those whose spaceId is null
  // (claude/codex sessions started in folders that aren't attached to any
  // registered space). Only applies in Home view; navigating to a real space
  // resets it.
  const [showElsewhere, setShowElsewhere] = useState(false);

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

  // Drop meta-spaces from the Spaces summary cards: the chat bar already
  // renders Home as its own pill, so a `home` row in the spaces table would
  // surface a redundant card. __all__ and __archived__ are similar.
  const realSpaces = useMemo(
    () => spaces.filter((s) => s.id !== "home" && s.id !== "__all__" && s.id !== "__archived__"),
    [spaces],
  );

  // Per-space session counts + a separate orphan tally (sessions with
  // spaceId === null), all in one pass.
  const { sessionCountsBySpace, orphanCounts } = useMemo(() => {
    const bySpace: Record<string, { total: number; active: number; waiting: number; disconnected: number; done: number }> = {};
    const orphans = { total: 0, active: 0, waiting: 0, disconnected: 0, done: 0 };
    for (const s of sessions) {
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
    return { sessionCountsBySpace: bySpace, orphanCounts: orphans };
  }, [sessions]);

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
          <h1 className="home-title">{isHomeView ? "Today." : eyebrow}</h1>
          {error && <div className="home-error">Couldn't load sessions: {error.message}</div>}
        </header>

        {!isAllView && !isArchivedView && (realSpaces.length > 0 || orphanCounts.total > 0) && (
          <div className="home-spaces-section">
            <div className="home-spaces-grid">
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
                  />
                ))}
              </div>
            </div>
          )}
        </section>

        <section className="home-section">
          <div className="home-section-head">
            <span className="home-section-label">Artefacts</span>
            <span className="home-artefacts-count">{desktopProps.artifacts.length}</span>
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
            <div className="home-artefacts">
              <Desktop {...desktopProps} isHero={false} showMeta />
            </div>
          ) : (
            <ArtefactTable
              artifacts={desktopProps.artifacts}
              spaces={spaces}
              onArtifactClick={desktopProps.onArtifactClick}
            />
          )}
        </section>
      </div>
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
}

function SessionTile({ session, spaces, showSpaceChip }: SessionTileProps) {
  const spaceLabel = spaceLabelFor(session.spaceId, spaces);
  const title = session.title ?? "(no title yet)";
  return (
    <div className="home-tile">
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
}

function SessionRow({ session, spaces }: SessionRowProps) {
  const spaceLabel = spaceLabelFor(session.spaceId, spaces);
  const rel = formatRelative(session.lastEventAt) ?? "—";
  const time = session.state === "waiting" ? `waiting ${rel}`
    : session.state === "disconnected" ? `disconnected ${rel}`
    : rel;
  const title = session.title ?? "(no title yet)";
  return (
    <div className="home-row">
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
