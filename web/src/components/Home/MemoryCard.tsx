// Single memory card. Extracted from Home/index.tsx.
import { Trash2 } from "lucide-react";
import type { Memory } from "../../data/memories-api";
import type { Space } from "../../../../shared/types";
import { formatRelative, spaceLabelFor } from "./utils";

interface MemoryCardProps {
  memory: Memory;
  spaces: Space[];
  showSpaceChip: boolean;
  onOpenSession: (id: string) => void;
  onRequestDelete: (memory: Memory) => void;
}

export function MemoryCard({ memory, spaces, showSpaceChip, onOpenSession, onRequestDelete }: MemoryCardProps) {
  const spaceLabel = spaceLabelFor(memory.space_id, spaces);
  const rel = formatRelative(memory.created_at) ?? "—";

  return (
    <div className="home-memory">
      <button
        type="button"
        className="home-memory-delete"
        onClick={() => onRequestDelete(memory)}
        title="Forget this memory"
        aria-label="Forget this memory"
      >
        <Trash2 size={13} />
      </button>
      <div className="home-memory-text">{memory.content}</div>
      <div className="home-memory-meta">
        {showSpaceChip && spaceLabel && <span className="home-memory-space">{spaceLabel}</span>}
        {memory.tags.length > 0 && (
          <span className="home-memory-tags">
            {memory.tags.map((t) => (
              <span key={t} className="home-memory-tag">{t}</span>
            ))}
          </span>
        )}
        {memory.source_session_id && (
          <button
            type="button"
            className="home-memory-source"
            onClick={() => onOpenSession(memory.source_session_id!)}
            title="Open the session that wrote this memory"
          >
            from session
          </button>
        )}
        <span className="home-memory-time">{rel}</span>
      </div>
    </div>
  );
}
