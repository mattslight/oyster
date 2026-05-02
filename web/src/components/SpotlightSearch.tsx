import { useState, useEffect, useRef, useMemo } from "react";
import type { Artifact } from "../data/artifacts-api";
import { typeConfig } from "./ArtifactIcon";
import { spaceColor } from "../utils/spaceColor";
import { searchTranscripts } from "../data/sessions-api";
import type { TranscriptHit } from "../data/sessions-api";

interface Props {
  artifacts: Artifact[];
  onOpen: (artifact: Artifact) => void;
  onClose: () => void;
}

const ARTEFACTS_LIMIT = 8;
const TRANSCRIPTS_LIMIT = 8;
const DEBOUNCE_MS = 180;

type SpotlightHit =
  | { kind: "artefact"; artifact: Artifact }
  | { kind: "transcript"; hit: TranscriptHit };

export function SpotlightSearch({ artifacts, onOpen, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const [transcriptHits, setTranscriptHits] = useState<TranscriptHit[]>([]);
  const [transcriptsLoading, setTranscriptsLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const artefactHits = useMemo(() => {
    if (!query.trim()) return [];
    const q = query.toLowerCase();
    return artifacts
      .filter((a) =>
        a.label.toLowerCase().includes(q)
        || a.artifactKind.toLowerCase().includes(q)
        || a.spaceId.toLowerCase().includes(q),
      )
      .slice(0, ARTEFACTS_LIMIT);
  }, [query, artifacts]);

  // Debounced transcript search. Aborts in-flight requests so a fast
  // typist doesn't waterfall stale results into the dropdown.
  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      setTranscriptHits([]);
      setTranscriptsLoading(false);
      return;
    }
    setTranscriptsLoading(true);
    const ac = new AbortController();
    const timer = setTimeout(() => {
      searchTranscripts(trimmed, { limit: TRANSCRIPTS_LIMIT, signal: ac.signal })
        .then((hits) => {
          setTranscriptHits(hits);
          setTranscriptsLoading(false);
        })
        .catch((err) => {
          if (ac.signal.aborted) return;
          console.warn("[Spotlight] transcript search failed:", err);
          setTranscriptHits([]);
          setTranscriptsLoading(false);
        });
    }, DEBOUNCE_MS);
    return () => {
      ac.abort();
      clearTimeout(timer);
    };
  }, [query]);

  // Flat ordered list — used by keyboard nav. Artefacts first, then
  // transcript hits below.
  const flatHits: SpotlightHit[] = useMemo(() => [
    ...artefactHits.map((a): SpotlightHit => ({ kind: "artefact", artifact: a })),
    ...transcriptHits.map((h): SpotlightHit => ({ kind: "transcript", hit: h })),
  ], [artefactHits, transcriptHits]);

  useEffect(() => {
    // Reset highlighted result when the query changes.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSelected(0);
  }, [query]);

  useEffect(() => {
    const el = listRef.current?.children[selected] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  function activate(hit: SpotlightHit) {
    if (hit.kind === "artefact") {
      onOpen(hit.artifact);
    } else {
      // Bridge to Home's activePanel via a window event — Spotlight is
      // mounted at App level and doesn't have direct access to Home's
      // setActivePanel.
      window.dispatchEvent(new CustomEvent("oyster:open-session", {
        detail: { id: hit.hit.session_id },
      }));
    }
    onClose();
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") { onClose(); return; }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelected((s) => Math.min(s + 1, flatHits.length - 1));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelected((s) => Math.max(s - 1, 0));
      return;
    }
    if (e.key === "Enter" && flatHits[selected]) {
      activate(flatHits[selected]);
    }
  }

  const showResults = artefactHits.length > 0 || transcriptHits.length > 0 || transcriptsLoading;
  const showEmpty = !!query.trim() && !transcriptsLoading && flatHits.length === 0;

  return (
    <div className="spotlight-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`spotlight-panel${showResults || showEmpty ? " spotlight-panel--expanded" : ""}`}>
        <div className="spotlight-input-row">
          <svg className="spotlight-search-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
          <input
            ref={inputRef}
            className="spotlight-input"
            placeholder="Search artefacts, transcripts…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
          />
          {query && (
            <button className="spotlight-clear" onClick={() => setQuery("")}>✕</button>
          )}
        </div>

        {showResults && (
          <div className="spotlight-results" ref={listRef}>
            {artefactHits.map((a, i) => {
              const cfg = typeConfig[a.artifactKind] ?? typeConfig.app;
              const isSelected = i === selected;
              return (
                <div
                  key={`a-${a.id}`}
                  className={`spotlight-result${isSelected ? " spotlight-result--selected" : ""}`}
                  onMouseEnter={() => setSelected(i)}
                  onClick={() => activate({ kind: "artefact", artifact: a })}
                >
                  <span className="spotlight-result-dot" style={{ background: cfg.color }} />
                  <span className="spotlight-result-label">{a.label}</span>
                  <span className="spotlight-result-badge">{a.artifactKind}</span>
                  <span className="spotlight-result-space" style={{ color: spaceColor(a.spaceId), background: `${spaceColor(a.spaceId)}18` }}>{a.spaceId}</span>
                </div>
              );
            })}

            {(transcriptHits.length > 0 || transcriptsLoading) && (
              <div className="spotlight-section-label">Transcripts</div>
            )}
            {transcriptsLoading && transcriptHits.length === 0 && (
              <div className="spotlight-section-loading">Searching transcripts…</div>
            )}
            {transcriptHits.map((h, j) => {
              const flatIndex = artefactHits.length + j;
              const isSelected = flatIndex === selected;
              return (
                <div
                  key={`t-${h.event_id}`}
                  className={`spotlight-result spotlight-result--transcript${isSelected ? " spotlight-result--selected" : ""}`}
                  onMouseEnter={() => setSelected(flatIndex)}
                  onClick={() => activate({ kind: "transcript", hit: h })}
                >
                  <span className="spotlight-result-snippet">
                    <SnippetMarks text={h.snippet} />
                  </span>
                  <span className="spotlight-result-session">{h.session_title ?? h.session_id.slice(0, 8)}</span>
                  <span className="spotlight-result-role">{h.role}</span>
                </div>
              );
            })}
          </div>
        )}

        {showEmpty && (
          <div className="spotlight-empty">No results for "{query}"</div>
        )}
      </div>
    </div>
  );
}

/** Renders FTS5 snippet text, turning the [bracketed] match markers
 *  into <mark> spans so the highlight survives even if the user's CSS
 *  doesn't style square brackets specially. */
function SnippetMarks({ text }: { text: string }) {
  // Naive split — FTS5 uses literal '[' and ']' as our chosen markers
  // (configured in session-store.ts). Escape any pre-existing brackets
  // in source text isn't a concern at the inspector's volume.
  const parts: Array<{ text: string; mark: boolean }> = [];
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf("[", i);
    if (open === -1) {
      parts.push({ text: text.slice(i), mark: false });
      break;
    }
    if (open > i) parts.push({ text: text.slice(i, open), mark: false });
    const close = text.indexOf("]", open + 1);
    if (close === -1) {
      parts.push({ text: text.slice(open), mark: false });
      break;
    }
    parts.push({ text: text.slice(open + 1, close), mark: true });
    i = close + 1;
  }
  return (
    <>
      {parts.map((p, idx) => p.mark
        ? <mark key={idx} className="spotlight-snippet-mark">{p.text}</mark>
        : <span key={idx}>{p.text}</span>
      )}
    </>
  );
}
