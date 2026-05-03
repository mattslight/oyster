// MemoryRow — extracted from SessionInspector for navigability.
import type { SessionMemoryEntry } from "../../data/sessions-api";
import type { ActivePanel } from "../InspectorPanel";
import { formatTs } from "./utils";

export function MemoryRow({
  memory, displayTs, currentSessionId, onSwitchTo,
}: {
  memory: SessionMemoryEntry;
  displayTs: string;
  currentSessionId: string;
  onSwitchTo: (next: ActivePanel) => void;
}) {
  // Source link only appears when (a) the memory has an attributable
  // source, and (b) it isn't this very session — pointing the user at
  // the inspector they already have open is noise.
  const showSource = memory.source_session_id && memory.source_session_id !== currentSessionId;
  return (
    <li className="memory-row">
      <div className="memory-row-content">{memory.content}</div>
      <div className="memory-row-meta">
        {memory.space_id && <span className="memory-row-space">{memory.space_id}</span>}
        {memory.tags.length > 0 && memory.tags.map((t) => (
          <span key={t} className="memory-row-tag">{t}</span>
        ))}
        {showSource && (
          <button
            type="button"
            className="memory-row-source"
            onClick={() => onSwitchTo({ kind: "session", id: memory.source_session_id! })}
            title={`Open source session: ${memory.source_session_title ?? memory.source_session_id}`}
          >
            from {memory.source_session_title ?? memory.source_session_id!.slice(0, 8)}
          </button>
        )}
        <span className="memory-row-ts">{formatTs(displayTs)}</span>
      </div>
    </li>
  );
}
