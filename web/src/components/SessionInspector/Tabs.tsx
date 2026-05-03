// Tabs — extracted from SessionInspector for navigability.
import type { Tab } from "./types";

export function Tabs({
  tab, setTab, eventsCount, hasMoreOlder, artefactsCount, memoryCount,
}: {
  tab: Tab;
  setTab: (t: Tab) => void;
  eventsCount: number;
  hasMoreOlder: boolean;
  artefactsCount: number;
  memoryCount: number;
}) {
  // While older events haven't all been loaded, clamp the badge to "1000+"
  // — the loaded count grows as the user scrolls, but the user wants the
  // single "more than a thousand" signal, not an interim 2000+/3000+/…
  const transcriptLabel = hasMoreOlder ? "1000+" : String(eventsCount);
  return (
    <div className="inspector-tabs">
      <button
        type="button"
        className={`inspector-tab${tab === "transcript" ? " active" : ""}`}
        onClick={() => setTab("transcript")}
      >
        Transcript <span className="badge">{transcriptLabel}</span>
      </button>
      <button
        type="button"
        className={`inspector-tab${tab === "artefacts" ? " active" : ""}`}
        onClick={() => setTab("artefacts")}
      >
        Artefacts <span className="badge">{artefactsCount}</span>
      </button>
      <button
        type="button"
        className={`inspector-tab${tab === "memory" ? " active" : ""}`}
        onClick={() => setTab("memory")}
      >
        Memory <span className="badge">{memoryCount}</span>
      </button>
    </div>
  );
}
