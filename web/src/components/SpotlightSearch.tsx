import { useState, useEffect, useRef, useMemo } from "react";
import type { Artifact } from "../data/artifacts-api";
import { typeConfig } from "./ArtifactIcon";
import { spaceColor } from "../utils/spaceColor";

interface Props {
  artifacts: Artifact[];
  onOpen: (artifact: Artifact) => void;
  onClose: () => void;
}

export function SpotlightSearch({ artifacts, onOpen, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const results = useMemo(() => {
    if (!query.trim()) return [];
    const q = query.toLowerCase();
    return artifacts
      .filter((a) => a.label.toLowerCase().includes(q) || a.artifactKind.toLowerCase().includes(q) || a.spaceId.toLowerCase().includes(q))
      .slice(0, 12);
  }, [query, artifacts]);

  useEffect(() => {
    // Reset highlighted result when the query changes.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSelected(0);
  }, [query]);

  useEffect(() => {
    const el = listRef.current?.children[selected] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") { onClose(); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); setSelected((s) => Math.min(s + 1, results.length - 1)); return; }
    if (e.key === "ArrowUp") { e.preventDefault(); setSelected((s) => Math.max(s - 1, 0)); return; }
    if (e.key === "Enter" && results[selected]) { onOpen(results[selected]); onClose(); }
  }

  return (
    <div className="spotlight-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`spotlight-panel${results.length > 0 || (query.trim() && results.length === 0) ? " spotlight-panel--expanded" : ""}`}>
        <div className="spotlight-input-row">
          <svg className="spotlight-search-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
          <input
            ref={inputRef}
            className="spotlight-input"
            placeholder="Search artifacts…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
          />
          {query && (
            <button className="spotlight-clear" onClick={() => setQuery("")}>✕</button>
          )}
        </div>

        {results.length > 0 && (
          <div className="spotlight-results" ref={listRef}>
            {results.map((a, i) => {
              const cfg = typeConfig[a.artifactKind] ?? typeConfig.app;
              return (
                <div
                  key={a.id}
                  className={`spotlight-result${i === selected ? " spotlight-result--selected" : ""}`}
                  onMouseEnter={() => setSelected(i)}
                  onClick={() => { onOpen(a); onClose(); }}
                >
                  <span className="spotlight-result-dot" style={{ background: cfg.color }} />
                  <span className="spotlight-result-label">{a.label}</span>
                  <span className="spotlight-result-badge">{a.artifactKind}</span>
                  <span className="spotlight-result-space" style={{ color: spaceColor(a.spaceId), background: `${spaceColor(a.spaceId)}18` }}>{a.spaceId}</span>
                </div>
              );
            })}
          </div>
        )}

        {query.trim() && results.length === 0 && (
          <div className="spotlight-empty">No results for "{query}"</div>
        )}
      </div>
    </div>
  );
}
