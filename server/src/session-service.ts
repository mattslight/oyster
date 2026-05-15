import type Database from "better-sqlite3";
import type { SessionRow, SessionStore, AssignmentMode } from "./session-store.js";
import type { SpaceStore } from "./space-store.js";

// Session-level mutation logic that REST and MCP both share. Until this
// existed, route handlers wrote directly to the store and MCP had no way to
// move sessions at all. Pulling the logic here keeps the two surfaces in
// lock-step: a tweak to the manual/auto invariants lands once, applies to
// both.
//
// The service deliberately knows nothing about HTTP or SSE — callers do
// their own response shaping and broadcasting. Keeps the unit boundary
// clean and tests trivial (in-memory DB, no network).

export interface MoveSessionInput {
  session_id: string;
  /** A source id pins this session there; `null` sends it to the space's
   *  vault; `undefined` means "don't change the source binding". */
  source_id?: string | null;
  /** Only honoured when `source_id` is null/absent — if the source is set,
   *  the resulting space_id is derived from the source row to keep the
   *  (space, source) pair internally consistent. */
  space_id?: string;
  /** `'manual'` flips this session to user-controlled; `'auto'` triggers an
   *  atomic recompute (clear + longest-prefix lookup). Implied to `'manual'`
   *  when `source_id` is set explicitly. */
  assignment_mode?: AssignmentMode;
}

export class SessionNotFoundError extends Error {
  constructor(id: string) { super(`Session "${id}" not found`); }
}

export class SourceNotFoundError extends Error {
  constructor(id: string) { super(`Source "${id}" not found`); }
}

export class SessionService {
  constructor(
    private db: Database.Database,
    private sessionStore: SessionStore,
    private spaceStore: SpaceStore,
  ) {}

  /** Apply a user/agent-initiated move to a session row. Branches:
   *  - `source_id: "<id>"`              → bind to that source, flip to manual,
   *                                       derive space_id from the source.
   *  - `source_id: null`                → unbind (vault), flip to manual.
   *  - `assignment_mode: 'auto'` (only) → atomic recompute via longest-prefix
   *                                       lookup on the row's cwd.
   *  - `assignment_mode: 'manual'` only → freeze whatever the current binding
   *                                       is. (Edge case — lets a user pin
   *                                       a row that's auto-bound right now.)
   *
   *  Returns the post-update session row. Throws if the session or
   *  referenced source doesn't exist (or is soft-deleted). */
  moveSession(input: MoveSessionInput): SessionRow {
    const row = this.sessionStore.getById(input.session_id);
    if (!row) throw new SessionNotFoundError(input.session_id);

    // Branch 1: assignment_mode: 'auto' with no source override → recompute.
    if (input.assignment_mode === "auto" && input.source_id === undefined) {
      return this.resetSessionToAuto(input.session_id);
    }

    // Build the new (space_id, source_id, mode) tuple.
    let newSourceId: string | null;
    let newSpaceId: string | null;
    let newMode: AssignmentMode;

    if (input.source_id === undefined) {
      // Mode-only flip (the implied case is mode === 'manual'). Keep current
      // binding; just freeze it.
      newSourceId = row.source_id;
      newSpaceId = row.space_id;
      newMode = input.assignment_mode ?? "manual";
    } else if (input.source_id === null) {
      newSourceId = null;
      newSpaceId = input.space_id ?? row.space_id;
      newMode = "manual";
    } else {
      const source = this.spaceStore.getSourceById(input.source_id);
      if (!source || source.removed_at) throw new SourceNotFoundError(input.source_id);
      newSourceId = source.id;
      // Always derive space_id from the source — ignores any body.space_id
      // when source_id is set, which prevents inconsistent (source in space
      // X, session claiming space Y) state.
      newSpaceId = source.space_id;
      newMode = "manual";
    }

    this.sessionStore.updateSession(input.session_id, {
      source_id: newSourceId,
      space_id: newSpaceId,
      assignment_mode: newMode,
    });
    return this.sessionStore.getById(input.session_id)!;
  }

  /** Atomic "Let Oyster decide": clear the manual pin, recompute the
   *  longest-prefix source for the row's cwd, write back in a single
   *  transaction so observers never see an intermediate "orphan" state. */
  resetSessionToAuto(sessionId: string): SessionRow {
    return this.db.transaction(() => {
      const row = this.sessionStore.getById(sessionId);
      if (!row) throw new SessionNotFoundError(sessionId);
      const match = row.cwd ? this.spaceStore.getActiveSourceForCwd(row.cwd) : undefined;
      this.sessionStore.updateSession(sessionId, {
        source_id: match?.id ?? null,
        space_id: match?.space_id ?? null,
        assignment_mode: "auto",
      });
      return this.sessionStore.getById(sessionId)!;
    })();
  }
}
