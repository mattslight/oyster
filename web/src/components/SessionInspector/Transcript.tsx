// Transcript — extracted from SessionInspector for navigability.
import type { SessionAgent, SessionEvent } from "../../data/sessions-api";
import { Turn } from "./Turn";

export function Transcript({
  events, sessionId, agent, flashEventId, highlightQuery,
}: {
  events: SessionEvent[] | null;
  sessionId: string;
  agent: SessionAgent;
  flashEventId: number | undefined;
  highlightQuery: string;
}) {
  if (events === null) return <div className="inspector-empty">Loading transcript…</div>;
  if (events.length === 0) {
    return <div className="inspector-empty">No transcript yet. Live updates active.</div>;
  }
  return (
    <>
      {events.map((e) => (
        <Turn
          key={e.id}
          event={e}
          sessionId={sessionId}
          agent={agent}
          flash={e.id === flashEventId}
          highlightQuery={highlightQuery}
        />
      ))}
    </>
  );
}
