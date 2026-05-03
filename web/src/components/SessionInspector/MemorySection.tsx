// MemorySection — extracted from SessionInspector for navigability.
import type { SessionMemoryEntry } from "../../data/sessions-api";
import type { ActivePanel } from "../InspectorPanel";
import { MemoryRow } from "./MemoryRow";

export function MemorySection({
  title, emptyHint, items, sessionId, onSwitchTo, timestampOf,
}: {
  title: string;
  emptyHint: string;
  items: SessionMemoryEntry[];
  sessionId: string;
  onSwitchTo: (next: ActivePanel) => void;
  timestampOf: (m: SessionMemoryEntry) => string;
}) {
  return (
    <section className="memory-section">
      <h3 className="memory-section-title">{title} <span className="badge">{items.length}</span></h3>
      {items.length === 0 ? (
        <div className="memory-section-empty">{emptyHint}</div>
      ) : (
        <ul className="memory-list">
          {items.map((m) => (
            <MemoryRow
              key={m.id}
              memory={m}
              displayTs={timestampOf(m)}
              currentSessionId={sessionId}
              onSwitchTo={onSwitchTo}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
