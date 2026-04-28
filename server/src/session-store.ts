import type Database from "better-sqlite3";

// Sessions arc (0.5.0). See docs/plans/sessions-arc.md.
//
// Three tables, three row types. The store is pure DB — the watcher / SSE
// layers wrap calls in their own logic. Writes go through prepared statements
// so the high-volume session_events insert path stays cheap.

// ── Row types (mirror SQLite schema in db.ts) ──

export type SessionState = "running" | "awaiting" | "disconnected" | "done";
export type SessionAgent = "claude-code" | "opencode" | "codex";
export type SessionEventRole =
  | "user"
  | "assistant"
  | "tool"
  | "tool_result"
  | "system";
export type SessionArtifactRole = "create" | "modify" | "read";

export interface SessionRow {
  id: string;
  space_id: string | null;
  agent: SessionAgent;
  title: string | null;
  state: SessionState;
  started_at: string;
  ended_at: string | null;
  model: string | null;
  last_event_at: string;
}

export interface SessionEventRow {
  id: number;
  session_id: string;
  role: SessionEventRole;
  text: string;
  ts: string;
  raw: string | null;
}

export interface SessionArtifactRow {
  id: number;
  session_id: string;
  artifact_id: string;
  role: SessionArtifactRole;
  when_at: string;
}

// ── Insert shapes (let SQLite supply timestamps + auto-id) ──

export interface InsertSession {
  id: string;
  space_id: string | null;
  agent: SessionAgent;
  title?: string | null;
  state: SessionState;
  started_at?: string;
  model?: string | null;
  last_event_at?: string;
}

export interface InsertSessionEvent {
  session_id: string;
  role: SessionEventRole;
  text: string;
  ts?: string;
  raw?: string | null;
}

export interface InsertSessionArtifact {
  session_id: string;
  artifact_id: string;
  role: SessionArtifactRole;
}

// ── Store interface ──

export interface SessionStore {
  // sessions
  getAll(): SessionRow[];
  getById(id: string): SessionRow | undefined;
  insertSession(row: InsertSession): void;
  upsertSession(row: InsertSession): void;
  updateSessionState(id: string, state: SessionState, lastEventAt: string): void;
  updateSession(id: string, fields: Partial<Omit<SessionRow, "id" | "started_at">>): void;
  // session_events — bulk-friendly
  insertEvent(row: InsertSessionEvent): number;
  insertEvents(rows: InsertSessionEvent[]): void;
  getEventsBySession(sessionId: string, opts?: { limit?: number }): SessionEventRow[];
  // session_artifacts
  insertArtifactTouch(row: InsertSessionArtifact): void;
  getArtifactsBySession(sessionId: string): SessionArtifactRow[];
  getSessionsByArtifact(artifactId: string): SessionArtifactRow[];
}

// ── SQLite implementation ──

export class SqliteSessionStore implements SessionStore {
  private stmts: {
    getAll: Database.Statement;
    getById: Database.Statement;
    insertSession: Database.Statement;
    upsertSession: Database.Statement;
    updateSessionState: Database.Statement;
    insertEvent: Database.Statement;
    getEventsBySession: Database.Statement;
    getEventsBySessionLimit: Database.Statement;
    insertArtifactTouch: Database.Statement;
    getArtifactsBySession: Database.Statement;
    getSessionsByArtifact: Database.Statement;
  };

  private insertEventsTxn: (rows: InsertSessionEvent[]) => void;

  constructor(private db: Database.Database) {
    this.stmts = {
      getAll: db.prepare("SELECT * FROM sessions ORDER BY last_event_at DESC"),
      getById: db.prepare("SELECT * FROM sessions WHERE id = ?"),
      insertSession: db.prepare(`
        INSERT INTO sessions (id, space_id, agent, title, state, started_at, model, last_event_at)
        VALUES (
          @id, @space_id, @agent, @title, @state,
          COALESCE(@started_at, datetime('now')),
          @model,
          COALESCE(@last_event_at, datetime('now'))
        )
      `),
      // Idempotent boot scan needs upsert: re-seeing a session file should
      // refresh metadata (state / last_event_at / title once derived) without
      // duplicating the row. ON CONFLICT preserves started_at (the original
      // birth) and only ratchets last_event_at forward.
      upsertSession: db.prepare(`
        INSERT INTO sessions (id, space_id, agent, title, state, started_at, model, last_event_at)
        VALUES (
          @id, @space_id, @agent, @title, @state,
          COALESCE(@started_at, datetime('now')),
          @model,
          COALESCE(@last_event_at, datetime('now'))
        )
        ON CONFLICT(id) DO UPDATE SET
          space_id      = COALESCE(excluded.space_id, sessions.space_id),
          title         = COALESCE(excluded.title, sessions.title),
          state         = excluded.state,
          model         = COALESCE(excluded.model, sessions.model),
          last_event_at = MAX(excluded.last_event_at, sessions.last_event_at)
      `),
      updateSessionState: db.prepare(
        "UPDATE sessions SET state = ?, last_event_at = ? WHERE id = ?"
      ),
      insertEvent: db.prepare(`
        INSERT INTO session_events (session_id, role, text, ts, raw)
        VALUES (@session_id, @role, @text, COALESCE(@ts, datetime('now')), @raw)
      `),
      getEventsBySession: db.prepare(
        "SELECT * FROM session_events WHERE session_id = ? ORDER BY id"
      ),
      getEventsBySessionLimit: db.prepare(
        "SELECT * FROM session_events WHERE session_id = ? ORDER BY id DESC LIMIT ?"
      ),
      insertArtifactTouch: db.prepare(`
        INSERT INTO session_artifacts (session_id, artifact_id, role)
        VALUES (@session_id, @artifact_id, @role)
      `),
      getArtifactsBySession: db.prepare(
        "SELECT * FROM session_artifacts WHERE session_id = ? ORDER BY when_at"
      ),
      getSessionsByArtifact: db.prepare(
        "SELECT * FROM session_artifacts WHERE artifact_id = ? ORDER BY when_at DESC"
      ),
    };

    // Bulk insert helper. Wrap N inserts in a single transaction so a JSONL
    // backfill (hundreds of lines) commits in O(1) fsyncs instead of O(N).
    const insertOne = this.stmts.insertEvent;
    this.insertEventsTxn = db.transaction((rows: InsertSessionEvent[]) => {
      for (const r of rows) {
        insertOne.run({ ts: null, raw: null, ...r });
      }
    });
  }

  getAll(): SessionRow[] {
    return this.stmts.getAll.all() as SessionRow[];
  }

  getById(id: string): SessionRow | undefined {
    return this.stmts.getById.get(id) as SessionRow | undefined;
  }

  insertSession(row: InsertSession): void {
    this.stmts.insertSession.run({
      title: null,
      started_at: null,
      model: null,
      last_event_at: null,
      ...row,
    });
  }

  upsertSession(row: InsertSession): void {
    this.stmts.upsertSession.run({
      title: null,
      started_at: null,
      model: null,
      last_event_at: null,
      ...row,
    });
  }

  updateSessionState(id: string, state: SessionState, lastEventAt: string): void {
    this.stmts.updateSessionState.run(state, lastEventAt, id);
  }

  private static readonly UPDATABLE_SESSION_COLUMNS = new Set([
    "space_id", "title", "state", "ended_at", "model", "last_event_at",
  ]);

  updateSession(
    id: string,
    fields: Partial<Omit<SessionRow, "id" | "started_at">>,
  ): void {
    const sets: string[] = [];
    const values: Record<string, unknown> = { id };
    for (const [key, value] of Object.entries(fields)) {
      if (!SqliteSessionStore.UPDATABLE_SESSION_COLUMNS.has(key)) continue;
      sets.push(`${key} = @${key}`);
      values[key] = value;
    }
    if (sets.length === 0) return;
    this.db.prepare(`UPDATE sessions SET ${sets.join(", ")} WHERE id = @id`).run(values);
  }

  insertEvent(row: InsertSessionEvent): number {
    const info = this.stmts.insertEvent.run({ ts: null, raw: null, ...row });
    return Number(info.lastInsertRowid);
  }

  insertEvents(rows: InsertSessionEvent[]): void {
    if (rows.length === 0) return;
    this.insertEventsTxn(rows);
  }

  getEventsBySession(sessionId: string, opts?: { limit?: number }): SessionEventRow[] {
    if (opts?.limit !== undefined) {
      const rows = this.stmts.getEventsBySessionLimit.all(sessionId, opts.limit) as SessionEventRow[];
      return rows.reverse();
    }
    return this.stmts.getEventsBySession.all(sessionId) as SessionEventRow[];
  }

  insertArtifactTouch(row: InsertSessionArtifact): void {
    this.stmts.insertArtifactTouch.run(row);
  }

  getArtifactsBySession(sessionId: string): SessionArtifactRow[] {
    return this.stmts.getArtifactsBySession.all(sessionId) as SessionArtifactRow[];
  }

  getSessionsByArtifact(artifactId: string): SessionArtifactRow[] {
    return this.stmts.getSessionsByArtifact.all(artifactId) as SessionArtifactRow[];
  }
}
