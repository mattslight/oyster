import { useState, useEffect, useRef, useMemo } from "react";
import type { Artifact } from "../data/artifacts-api";
import { typeConfig } from "./ArtifactIcon";
import { spaceColor } from "../utils/spaceColor";
import { searchTranscripts } from "../data/sessions-api";
import type { TranscriptHit } from "../data/sessions-api";
import { searchMemories } from "../data/memories-api";
import type { Memory } from "../data/memories-api";

interface Props {
  artifacts: Artifact[];
  spaces: { id: string; name?: string }[];
  onOpen: (artifact: Artifact) => void;
  onClose: () => void;
}

const ARTEFACTS_LIMIT = 8;
const TRANSCRIPTS_LIMIT = 8;
const MEMORIES_LIMIT = 8;
const DEBOUNCE_MS = 180;

type FilterType = "session" | "artefact" | "memory" | null;
type SpotlightFilter = { type: FilterType; spaceId: string | null };

const TYPE_OPTS: { value: 'session' | 'artefact' | 'memory'; color: string }[] = [
  { value: 'session', color: '#4d9aff' },
  { value: 'artefact', color: '#ff8a5c' },
  { value: 'memory', color: '#a78bfa' },
];

type SpotlightHit =
  | { kind: "artefact"; artifact: Artifact }
  | { kind: "transcript"; hit: TranscriptHit }
  | { kind: "memory"; memory: Memory };

export function SpotlightSearch({ artifacts, spaces, onOpen, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const [transcriptHits, setTranscriptHits] = useState<TranscriptHit[]>([]);
  const [transcriptsLoading, setTranscriptsLoading] = useState(false);
  const [memoryHits, setMemoryHits] = useState<Memory[]>([]);
  const [memoriesLoading, setMemoriesLoading] = useState(false);
  const [filter, setFilter] = useState<SpotlightFilter & { order: ('type' | 'space')[] }>({
    type: null,
    spaceId: null,
    order: [],
  });
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  type ActiveAc = { prefix: '@' | '#'; fragment: string; start: number } | null;
  const activeAc: ActiveAc = useMemo(() => {
    const at = query.lastIndexOf('@');
    const hash = query.lastIndexOf('#');
    const candidate = at > hash ? '@' : (hash > -1 ? '#' : null);
    if (!candidate) return null;
    const idx = candidate === '@' ? at : hash;
    if (idx > 0 && !/\s/.test(query[idx - 1])) return null;
    const fragment = query.slice(idx + 1);
    if (/\s/.test(fragment)) return null;
    return { prefix: candidate, fragment, start: idx };
  }, [query]);

  const acOptions = useMemo(() => {
    if (!activeAc) return [];
    const frag = activeAc.fragment.toLowerCase();
    if (activeAc.prefix === '@') {
      return TYPE_OPTS.filter(o => o.value.startsWith(frag));
    }
    return spaces
      .filter(s => s.id.toLowerCase().includes(frag))
      .slice(0, 8)
      .map(s => ({ value: s.id, color: spaceColor(s.id) }));
  }, [activeAc, spaces]);

  const [acSelected, setAcSelected] = useState(0);
  useEffect(() => {
    // Reset highlighted autocomplete option when the active prefix/fragment changes.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setAcSelected(0);
  }, [activeAc?.prefix, activeAc?.fragment]);

  function commitAcOption(value: string) {
    if (!activeAc) return;
    const isType = activeAc.prefix === '@';
    setFilter(f => ({
      type: isType ? (value as FilterType) : f.type,
      spaceId: isType ? f.spaceId : value,
      order: [...f.order.filter(o => o !== (isType ? 'type' : 'space')), isType ? 'type' : 'space'],
    }));
    setQuery(q => q.slice(0, activeAc.start) + q.slice(activeAc.start + 1 + activeAc.fragment.length));
  }

  const artefactHits = useMemo(() => {
    if (!query.trim()) return [];
    if (filter.type !== null && filter.type !== "artefact") return [];
    const q = query.toLowerCase();
    return artifacts
      .filter((a) =>
        (filter.spaceId ? a.spaceId === filter.spaceId : true) &&
        (a.label.toLowerCase().includes(q)
          || a.artifactKind.toLowerCase().includes(q)
          || a.spaceId.toLowerCase().includes(q)),
      )
      .slice(0, ARTEFACTS_LIMIT);
  }, [query, artifacts, filter]);

  // Debounced transcript search. AbortController cancels the request,
  // but a fetch that has already resolved before we abort can still
  // run its .then() with stale results. The transcriptReqIdRef guard rejects any
  // result that doesn't match the most recently issued request.
  const transcriptReqIdRef = useRef(0);
  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      setTranscriptHits([]);
      setTranscriptsLoading(false);
      return;
    }
    if (filter.type !== null && filter.type !== "session") {
      setTranscriptHits([]);
      setTranscriptsLoading(false);
      return;
    }
    setTranscriptsLoading(true);
    const reqId = ++transcriptReqIdRef.current;
    const ac = new AbortController();
    const timer = setTimeout(() => {
      searchTranscripts(trimmed, { limit: TRANSCRIPTS_LIMIT, spaceId: filter.spaceId, signal: ac.signal })
        .then((hits) => {
          if (reqId !== transcriptReqIdRef.current) return;
          setTranscriptHits(hits);
          setTranscriptsLoading(false);
        })
        .catch((err) => {
          if (ac.signal.aborted || reqId !== transcriptReqIdRef.current) return;
          console.warn("[Spotlight] transcript search failed:", err);
          setTranscriptHits([]);
          setTranscriptsLoading(false);
        });
    }, DEBOUNCE_MS);
    return () => {
      ac.abort();
      clearTimeout(timer);
    };
  }, [query, filter]);

  // Debounced memory search — mirrors the transcript effect:
  // request id + abort controller protect against stale resolutions.
  const memoryReqIdRef = useRef(0);
  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      setMemoryHits([]);
      setMemoriesLoading(false);
      return;
    }
    if (filter.type !== null && filter.type !== "memory") {
      setMemoryHits([]);
      setMemoriesLoading(false);
      return;
    }
    setMemoriesLoading(true);
    const reqId = ++memoryReqIdRef.current;
    const ac = new AbortController();
    const timer = setTimeout(() => {
      searchMemories(trimmed, { limit: MEMORIES_LIMIT, spaceId: filter.spaceId, signal: ac.signal })
        .then((hits) => {
          if (reqId !== memoryReqIdRef.current) return;
          setMemoryHits(hits);
          setMemoriesLoading(false);
        })
        .catch((err) => {
          if (ac.signal.aborted || reqId !== memoryReqIdRef.current) return;
          console.warn("[Spotlight] memory search failed:", err);
          setMemoryHits([]);
          setMemoriesLoading(false);
        });
    }, DEBOUNCE_MS);
    return () => {
      ac.abort();
      clearTimeout(timer);
    };
  }, [query, filter]);

  // Flat ordered list — used by keyboard nav. Artefacts first, then
  // transcript hits, then memory hits.
  const flatHits: SpotlightHit[] = useMemo(() => [
    ...artefactHits.map((a): SpotlightHit => ({ kind: "artefact", artifact: a })),
    ...transcriptHits.map((h): SpotlightHit => ({ kind: "transcript", hit: h })),
    ...memoryHits.map((m): SpotlightHit => ({ kind: "memory", memory: m })),
  ], [artefactHits, transcriptHits, memoryHits]);

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
    } else if (hit.kind === "transcript") {
      // Bridge to Home's activePanel via a window event — Spotlight is
      // mounted at App level and doesn't have direct access to Home's
      // setActivePanel. eventId asks the inspector to scroll to + flash
      // that turn after open; query pre-fills the in-transcript find
      // bar so the user sees inline highlights + can step through
      // other matches in the same session.
      window.dispatchEvent(new CustomEvent("oyster:open-session", {
        detail: {
          id: hit.hit.session_id,
          eventId: hit.hit.event_id,
          query: query.trim(),
        },
      }));
    } else {
      const targetSpace = hit.memory.space_id ?? "home";
      window.dispatchEvent(new CustomEvent("oyster:open-memory", {
        detail: { id: hit.memory.id, spaceId: targetSpace },
      }));
    }
    onClose();
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Backspace" && query === "" && filter.order.length > 0) {
      const last = filter.order[filter.order.length - 1];
      setFilter(f => ({
        ...f,
        type: last === 'type' ? null : f.type,
        spaceId: last === 'space' ? null : f.spaceId,
        order: f.order.slice(0, -1),
      }));
      e.preventDefault();
      return;
    }
    if (activeAc && acOptions.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setAcSelected(s => Math.min(s + 1, acOptions.length - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setAcSelected(s => Math.max(s - 1, 0));
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        commitAcOption(acOptions[acSelected].value);
        return;
      }
    }
    if (e.key === "Escape") { onClose(); return; }
    // Arrow keys are no-ops on an empty list — without this guard,
    // ArrowDown's Math.min(s+1, -1) would set selected to -1.
    if ((e.key === "ArrowDown" || e.key === "ArrowUp") && flatHits.length === 0) {
      e.preventDefault();
      return;
    }
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

  const showResults = artefactHits.length > 0
    || transcriptHits.length > 0 || transcriptsLoading
    || memoryHits.length > 0 || memoriesLoading;
  const showEmpty = !!query.trim() && !transcriptsLoading && !memoriesLoading && flatHits.length === 0;

  return (
    <div className="spotlight-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`spotlight-panel${showResults || showEmpty || (activeAc && acOptions.length > 0) ? " spotlight-panel--expanded" : ""}`}>
        <div className="spotlight-input-row">
          <svg className="spotlight-search-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
          {filter.type && (
            <span className="spotlight-token-chip spotlight-token-chip--type">
              @{filter.type}
              <span className="x" onClick={() => setFilter(f => ({
                ...f,
                type: null,
                order: f.order.filter(o => o !== 'type'),
              }))}>×</span>
            </span>
          )}
          {filter.spaceId && (
            <span className="spotlight-token-chip spotlight-token-chip--space">
              #{filter.spaceId}
              <span className="x" onClick={() => setFilter(f => ({
                ...f,
                spaceId: null,
                order: f.order.filter(o => o !== 'space'),
              }))}>×</span>
            </span>
          )}
          <input
            ref={inputRef}
            className="spotlight-input"
            placeholder="Search artefacts, sessions, memories — type @ to filter"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
          />
          {query && (
            <button className="spotlight-clear" onClick={() => setQuery("")}>✕</button>
          )}
        </div>

        {activeAc && acOptions.length > 0 && (
          <div className="spotlight-ac">
            <div className="spotlight-ac-hint">
              {activeAc.prefix === '@' ? 'Filter by type' : 'Filter by space'}
            </div>
            {acOptions.map((o, i) => (
              <div
                key={o.value}
                className={`spotlight-ac-item${i === acSelected ? ' spotlight-ac-item--sel' : ''}`}
                onMouseEnter={() => setAcSelected(i)}
                onMouseDown={(e) => { e.preventDefault(); commitAcOption(o.value); }}
              >
                <span className="spotlight-ac-prefix">{activeAc.prefix}</span>
                <span className="spotlight-ac-swatch" style={{ background: o.color }} />
                <span className="spotlight-ac-label">{o.value}</span>
              </div>
            ))}
            <div className="spotlight-ac-hint spotlight-ac-hint--bottom">
              also try {activeAc.prefix === '@' ? '#space' : '@type'}
            </div>
          </div>
        )}

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

            {(memoryHits.length > 0 || memoriesLoading) && (
              <div className="spotlight-section-label">Memories</div>
            )}
            {memoriesLoading && memoryHits.length === 0 && (
              <div className="spotlight-section-loading">Searching memories…</div>
            )}
            {memoryHits.map((m, k) => {
              const flatIndex = artefactHits.length + transcriptHits.length + k;
              const isSelected = flatIndex === selected;
              return (
                <div
                  key={`m-${m.id}`}
                  className={`spotlight-result spotlight-result--memory${isSelected ? " spotlight-result--selected" : ""}`}
                  onMouseEnter={() => setSelected(flatIndex)}
                  onClick={() => activate({ kind: "memory", memory: m })}
                >
                  <span className="spotlight-result-dot" style={{ background: "#a78bfa" }} />
                  <span className="spotlight-result-label">{m.content.length > 80 ? m.content.slice(0, 80) + "…" : m.content}</span>
                  <span className="spotlight-result-badge">memory</span>
                  {m.space_id && (
                    <span className="spotlight-result-space" style={{ color: spaceColor(m.space_id), background: `${spaceColor(m.space_id)}18` }}>{m.space_id}</span>
                  )}
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
