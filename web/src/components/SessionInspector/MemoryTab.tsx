// MemoryTab — extracted from SessionInspector for navigability.
import type { SessionMemory } from "../../data/sessions-api";
import type { ActivePanel } from "../InspectorPanel";
import { MemorySection } from "./MemorySection";

export function MemoryTab({
  memory, memoryError, onSwitchTo, sessionId,
}: {
  memory: SessionMemory | null;
  memoryError: string | null;
  onSwitchTo: (next: ActivePanel) => void;
  sessionId: string;
}) {
  if (memoryError) {
    return (
      <div className="inspector-empty">
        Couldn't load memory traffic: {memoryError}
      </div>
    );
  }
  if (memory === null) return <div className="inspector-empty">Loading memory…</div>;
  // Both sections always render with their badges, even when empty —
  // keeps the structure stable so a 0-count is a real "the agent hasn't
  // written/pulled anything here" signal, not a missing affordance.
  return (
    <div className="memory-tab">
      <MemorySection
        title="Written by this session"
        emptyHint="No memories were written by this session yet."
        timestampOf={(m) => m.created_at}
        items={memory.written}
        sessionId={sessionId}
        onSwitchTo={onSwitchTo}
      />
      <MemorySection
        title="Pulled into this session"
        emptyHint="No memories were recalled in this session yet."
        timestampOf={(m) => m.recalled_at ?? m.created_at}
        items={memory.pulled}
        sessionId={sessionId}
        onSwitchTo={onSwitchTo}
      />
    </div>
  );
}
