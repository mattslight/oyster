// TranscriptFilter — extracted from SessionInspector for navigability.
import type { SessionAgent } from "../../data/sessions-api";
import type { RoleCategory } from "./types";

export function TranscriptFilter({
  visible, onToggle, agent, onToggleSearch, searchActive,
}: {
  visible: Set<RoleCategory>;
  onToggle: (cat: RoleCategory) => void;
  agent: SessionAgent;
  onToggleSearch: () => void;
  searchActive: boolean;
}) {
  const labels: Array<[RoleCategory, string]> = [
    ["user", "User"],
    ["assistant", agent.toUpperCase()],
    ["tools", "Tools"],
    ["system", "System"],
    ["thinking", "Thinking"],
  ];
  return (
    <div className="transcript-filter" role="group" aria-label="Filter transcript by role">
      <button
        type="button"
        className={`transcript-filter-search${searchActive ? " active" : ""}`}
        onClick={onToggleSearch}
        aria-label={searchActive ? "Close search" : "Find in transcript"}
        aria-pressed={searchActive}
        title={searchActive ? "Close search (Esc)" : "Find in transcript (Cmd+F)"}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="11" cy="11" r="8" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
      </button>
      {labels.map(([cat, label]) => (
        <button
          key={cat}
          type="button"
          className={`transcript-filter-chip${visible.has(cat) ? " active" : ""}`}
          onClick={() => onToggle(cat)}
          aria-pressed={visible.has(cat)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
