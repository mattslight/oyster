import { useMemo, useState } from "react";
import type { Session, SessionState } from "../data/sessions-api";
import type { Artifact, Space } from "../../../shared/types";
import { useSessions } from "../hooks/useSessions";
import { Desktop } from "./Desktop";
import "./Home.css";

interface Props {
  activeSpace: string;
  spaces: Space[];
  // Forwarded to Desktop for the artefacts section. App.tsx handles the
  // already-scoped filtering and event wiring; we just pass it through.
  desktopProps: Omit<Parameters<typeof Desktop>[0], "isHero">;
  isHero?: boolean;
  onSpaceChange: (space: string) => void;
}

const STATE_FILTERS: Array<{ key: SessionState | "all"; label: string }> = [
  { key: "all", label: "All" },
  { key: "running", label: "Running" },
  { key: "awaiting", label: "Awaiting" },
  { key: "disconnected", label: "Disconnected" },
  { key: "done", label: "Done" },
];

const AGENT_LABEL: Record<Session["agent"], string> = {
  "claude-code": "CC",
  opencode: "OC",
  codex: "CX",
};

export function Home({ activeSpace, spaces, desktopProps, isHero, onSpaceChange }: Props) {
  const { sessions, error } = useSessions();
  const [stateFilter, setStateFilter] = useState<SessionState | "all">("all");

  const isHomeView = activeSpace === "home";
  const isAllView = activeSpace === "__all__";
  const isArchivedView = activeSpace === "__archived__";
  const isMetaView = isHomeView || isAllView || isArchivedView;
  const scopedSpace = !isMetaView ? activeSpace : null;

  // Sessions filtered by the active space pill + state chip.
  const visibleSessions = useMemo(() => {
    let rows = sessions;
    if (scopedSpace) {
      rows = rows.filter((s) => s.spaceId === scopedSpace);
    }
    if (stateFilter !== "all") {
      rows = rows.filter((s) => s.state === stateFilter);
    }
    return rows;
  }, [sessions, scopedSpace, stateFilter]);

  const stateCounts = useMemo(() => {
    const scoped = scopedSpace
      ? sessions.filter((s) => s.spaceId === scopedSpace)
      : sessions;
    const counts = { running: 0, awaiting: 0, disconnected: 0, done: 0 };
    for (const s of scoped) counts[s.state]++;
    return counts;
  }, [sessions, scopedSpace]);

  const activeSpaceRow = scopedSpace ? spaces.find((s) => s.id === scopedSpace) : null;
  const eyebrow = isHomeView ? "Home"
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

        {isHomeView && spaces.length > 0 && (
          <section className="home-section home-spaces">
            <div className="home-spaces-grid">
              {spaces.map((space) => {
                const spaceSessions = sessions.filter((s) => s.spaceId === space.id);
                const running = spaceSessions.filter((s) => s.state === "running").length;
                const awaiting = spaceSessions.filter((s) => s.state === "awaiting").length;
                const disconnected = spaceSessions.filter((s) => s.state === "disconnected").length;
                return (
                  <button
                    key={space.id}
                    className="home-space-card"
                    style={space.color ? { borderColor: space.color } : undefined}
                    onClick={() => onSpaceChange(space.id)}
                  >
                    <div className="home-space-name">{space.displayName}</div>
                    <div className="home-space-meta">
                      {running > 0 && <span className="dot dot-running" title="running" />}
                      {awaiting > 0 && <span className="dot dot-awaiting" title="awaiting" />}
                      {disconnected > 0 && <span className="dot dot-disconnected" title="disconnected" />}
                      <span className="home-space-count">
                        {spaceSessions.length} session{spaceSessions.length === 1 ? "" : "s"}
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>
          </section>
        )}

        <section className="home-section">
          <div className="home-section-head">
            <span className="home-section-label">Sessions</span>
            <span className="home-section-stats">
              {stateCounts.running > 0 && <span><span className="dot dot-running" /> {stateCounts.running} running</span>}
              {stateCounts.awaiting > 0 && <span><span className="dot dot-awaiting" /> {stateCounts.awaiting} awaiting</span>}
              {stateCounts.disconnected > 0 && <span><span className="dot dot-disconnected" /> {stateCounts.disconnected} disconnected</span>}
              {stateCounts.done > 0 && <span><span className="dot dot-done" /> {stateCounts.done} done</span>}
            </span>
            <span className="home-section-rule" />
            <div className="home-chips">
              {STATE_FILTERS.map((f) => (
                <button
                  key={f.key}
                  className={`home-chip${stateFilter === f.key ? " home-chip-active" : ""}`}
                  onClick={() => setStateFilter(f.key)}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>
          {visibleSessions.length === 0 ? (
            <div className="home-empty">No sessions match this filter.</div>
          ) : (
            <div className="home-sessions-grid">
              {visibleSessions.map((session) => (
                <SessionTile key={session.id} session={session} spaces={spaces} />
              ))}
            </div>
          )}
        </section>

        <section className="home-section">
          <div className="home-section-head">
            <span className="home-section-label">Artefacts</span>
            <span className="home-section-rule" />
          </div>
          <div className="home-artefacts">
            <Desktop {...desktopProps} isHero={false} />
          </div>
        </section>
      </div>
    </div>
  );
}

interface SessionTileProps {
  session: Session;
  spaces: Space[];
}

function SessionTile({ session, spaces }: SessionTileProps) {
  const space = session.spaceId ? spaces.find((s) => s.id === session.spaceId) : null;
  const agentTag = AGENT_LABEL[session.agent] ?? session.agent.slice(0, 2).toUpperCase();
  const subtitle = formatRelative(session.lastEventAt) ?? "—";
  const title = session.title ?? "(no title yet)";
  return (
    <div className={`home-session-tile state-${session.state}`}>
      <div className="home-session-thumb">
        <span className="home-session-agent">{agentTag}</span>
        <span className={`home-session-dot dot-${session.state}`} />
      </div>
      <div className="home-session-title" title={title}>{title}</div>
      <div className="home-session-meta">
        {space ? <span className="home-session-space">{space.displayName}</span> : null}
        <span className="home-session-when">{subtitle}</span>
      </div>
    </div>
  );
}

// Compact relative-time formatter matching the brain-prototype mockup.
// Falls back to absolute date if input is older than ~30 days.
function formatRelative(iso: string): string | null {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const ms = Date.now() - t;
  if (ms < 0) return "just now";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(t).toLocaleDateString();
}
