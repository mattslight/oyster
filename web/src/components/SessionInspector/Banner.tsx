// Banner — extracted from SessionInspector for navigability.
import type { Session } from "../../data/sessions-api";
import { formatRel } from "./utils";

export function Banner({ session }: { session: Session }) {
  if (session.state === "disconnected") {
    return (
      <div className="inspector-banner disconnected">
        <div>
          Quiet since <strong>{formatRel(session.lastEventAt)}</strong>. The agent looks like it's closed — copy the resume command above to pick it back up.
        </div>
      </div>
    );
  }
  if (session.state === "waiting") {
    return (
      <div className="inspector-banner waiting">
        <div>
          The agent is waiting on you — usually for tool approval. Open the terminal where it's running to respond.
        </div>
      </div>
    );
  }
  return null;
}
