// Turn — extracted from SessionInspector for navigability.
import type { SessionAgent, SessionEvent } from "../../data/sessions-api";
import { Highlighted } from "./Highlighted";
import { ToolTurn } from "./ToolTurn";
import { TOOL_ONLY_RE } from "./utils";

export function Turn({
  event, sessionId, agent, flash, highlightQuery,
}: {
  event: SessionEvent;
  sessionId: string;
  agent: SessionAgent;
  flash: boolean;
  highlightQuery: string;
}) {
  const isToolish =
    event.role === "tool"
    || event.role === "tool_result"
    || (event.role === "assistant" && TOOL_ONLY_RE.test(event.text.trim()));
  if (isToolish) {
    return <ToolTurn event={event} sessionId={sessionId} flash={flash} highlightQuery={highlightQuery} />;
  }
  const label = event.role === "assistant" ? agent.toUpperCase() : event.role.toUpperCase();
  return (
    <div className={`turn ${event.role}${flash ? " turn-flash" : ""}`} data-event-id={event.id}>
      <div className="turn-role">{label}</div>
      <div className="turn-text">
        {event.text
          ? <Highlighted text={event.text} query={highlightQuery} />
          : "(empty)"}
      </div>
    </div>
  );
}
