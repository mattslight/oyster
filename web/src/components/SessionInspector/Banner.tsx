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
  // "Waiting" banner removed — the Resume actions cover the recovery
  // path, and the Resume button shows a fork warning when the session is
  // active/waiting outside Oyster.
  return null;
}
