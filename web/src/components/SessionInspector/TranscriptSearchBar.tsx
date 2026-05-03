// TranscriptSearchBar — extracted from SessionInspector for navigability.
import { useEffect, useRef } from "react";

export function TranscriptSearchBar({
  query, matchCount, matchIdx, onChange, onNext, onPrev, onClose,
}: {
  query: string;
  matchCount: number;
  matchIdx: number;
  onChange: (v: string) => void;
  onNext: () => void;
  onPrev: () => void;
  onClose: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { inputRef.current?.focus(); inputRef.current?.select(); }, []);
  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") { onClose(); return; }
    if (e.key === "Enter") {
      e.preventDefault();
      e.shiftKey ? onPrev() : onNext();
      return;
    }
  }
  const counter = query.trim()
    ? (matchCount === 0 ? "0" : `${matchIdx + 1}/${matchCount}`)
    : "";
  return (
    <div className="transcript-search">
      <input
        ref={inputRef}
        className="transcript-search-input"
        placeholder="Find in transcript…"
        value={query}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
      />
      <span className="transcript-search-count">{counter}</span>
      <button
        type="button"
        className="transcript-search-step"
        onClick={onPrev}
        disabled={matchCount === 0}
        aria-label="Previous match"
        title="Previous match (Shift+Enter)"
      >
        ↑
      </button>
      <button
        type="button"
        className="transcript-search-step"
        onClick={onNext}
        disabled={matchCount === 0}
        aria-label="Next match"
        title="Next match (Enter)"
      >
        ↓
      </button>
      <button
        type="button"
        className="transcript-search-close"
        onClick={onClose}
        aria-label="Close search (Esc)"
      >
        ✕
      </button>
    </div>
  );
}
