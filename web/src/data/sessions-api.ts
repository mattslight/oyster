export type { Session, SessionState, SessionAgent } from "../../../shared/types";
import type { Session } from "../../../shared/types";

export async function fetchSessions(): Promise<Session[]> {
  const res = await fetch("/api/sessions");
  if (!res.ok) throw new Error(`Server returned ${res.status}`);
  return res.json();
}
