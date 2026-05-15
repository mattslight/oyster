import type Database from "better-sqlite3";
import type { SessionRow, SessionStore } from "./session-store.js";

// Session-level mutation logic that REST and MCP both share. Today only the
// project_id binding is mutable from outside the watcher — sources have been
// superseded by .oyster/id-derived projects.

export interface MoveSessionInput {
  session_id: string;
  /** A project id binds this session to that project (space_id is derived
   *  from the project row); `null` clears the project binding and leaves
   *  the session in the space vault. */
  project_id?: string | null;
}

export class SessionNotFoundError extends Error {
  constructor(id: string) { super(`Session "${id}" not found`); }
}

export class ProjectNotFoundError extends Error {
  constructor(id: string) { super(`Project "${id}" not found`); }
}

/** Thrown when a move request doesn't specify anything to change. The route
 *  layer turns these into 400s. */
export class InvalidMoveSessionInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidMoveSessionInputError";
  }
}

export class SessionService {
  constructor(
    private db: Database.Database,
    private sessionStore: SessionStore,
  ) {}

  /** Apply a project-binding change to a session row. Pass `project_id` to
   *  bind to a project (space_id is derived from the project row); pass
   *  `null` to clear the binding and leave the session in its current space.
   *  Returns the post-update session row. Throws if the session or
   *  referenced project doesn't exist. */
  moveSession(input: MoveSessionInput): SessionRow {
    const row = this.sessionStore.getById(input.session_id);
    if (!row) throw new SessionNotFoundError(input.session_id);

    if (input.project_id === undefined) {
      throw new InvalidMoveSessionInputError("project_id must be provided");
    }

    if (input.project_id === null) {
      this.sessionStore.updateSession(input.session_id, { project_id: null });
      return this.sessionStore.getById(input.session_id)!;
    }

    const project = this.db
      .prepare("SELECT id, space_id FROM projects WHERE id = ? AND removed_at IS NULL")
      .get(input.project_id) as { id: string; space_id: string } | undefined;
    if (!project) throw new ProjectNotFoundError(input.project_id);
    this.sessionStore.updateSession(input.session_id, {
      project_id: project.id,
      space_id: project.space_id,
    });
    return this.sessionStore.getById(input.session_id)!;
  }
}
