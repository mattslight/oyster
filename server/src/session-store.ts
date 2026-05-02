import type Database from "better-sqlite3";

// Sessions arc (0.5.0). See docs/plans/sessions-arc.md.
//
// Three tables, three row types. The store is pure DB — the watcher / SSE
// layers wrap calls in their own logic. Writes go through prepared statements
// so the high-volume session_events insert path stays cheap.

// ── Row types (mirror SQLite schema in db.ts) ──

export type SessionState = "active" | "waiting" | "disconnected" | "done";
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
  source_id: string | null;
  cwd: string | null;
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

/** A transcript-search hit. Slim by design — full `text`/`raw` would
 *  bloat the result for callers that just want to render a snippet
 *  list. Click-through to the inspector loads the full event via
 *  getEventById. */
export interface SessionEventSearchHit {
  id: number;
  session_id: string;
  /** The session this event belongs to, denormalised for display convenience. */
  session_title: string | null;
  role: SessionEventRole;
  ts: string;
  /** Highlighted excerpt with `[…]` ellipsis around the match. */
  snippet: string;
}

// ── Insert shapes (let SQLite supply timestamps + auto-id) ──

export interface InsertSession {
  id: string;
  space_id: string | null;
  source_id?: string | null;
  cwd?: string | null;
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
  /** Most-recently-active session for the given agent (R6 attribution). */
  getMostRecentActiveByAgent(agent: SessionAgent): SessionRow | undefined;
  insertSession(row: InsertSession): void;
  upsertSession(row: InsertSession): void;
  updateSessionState(id: string, state: SessionState, lastEventAt: string): void;
  updateSession(id: string, fields: Partial<Omit<SessionRow, "id" | "started_at">>): void;
  /** Re-attribute orphan sessions (source_id NULL) whose cwd matches a newly-attached folder.
   *  Without this, "done" sessions stay stuck in Elsewhere when the user promotes / attaches. */
  backfillSourceForCwd(cwd: string, spaceId: string, sourceId: string): number;
  // session_events — bulk-friendly
  insertEvent(row: InsertSessionEvent): number;
  insertEvents(rows: InsertSessionEvent[]): void;
  getEventsBySession(sessionId: string, opts?: { limit?: number }): SessionEventRow[];
  // Cursor pagination: scroll-up to load older, live SSE to append newer.
  getEventsBeforeBySession(sessionId: string, beforeId: number, limit: number): SessionEventRow[];
  getEventsAfterBySession(sessionId: string, afterId: number, limit: number): SessionEventRow[];
  getEventById(sessionId: string, eventId: number): SessionEventRow | undefined;
  // session_artifacts
  insertArtifactTouch(row: InsertSessionArtifact): void;
  getArtifactsBySession(sessionId: string): SessionArtifactRow[];
  getSessionsByArtifact(artifactId: string): SessionArtifactRow[];
  // last_offset — JSONL bytes already ingested for this session.
  getLastOffset(sessionId: string): number;
  setLastOffset(sessionId: string, offset: number): void;
  /** R2 verbatim recall (#311): FTS5 search across all session_events.text.
   *  `query` is natural language; tokenised to OR-joined terms inside the
   *  implementation. `sessionId` optionally scopes to one session. */
  searchEvents(query: string, opts?: { limit?: number; sessionId?: string }): SessionEventSearchHit[];
}

// ── SQLite implementation ──

export class SqliteSessionStore implements SessionStore {
  private stmts: {
    getAll: Database.Statement;
    getById: Database.Statement;
    getMostRecentActiveByAgent: Database.Statement;
    insertSession: Database.Statement;
    upsertSession: Database.Statement;
    updateSessionState: Database.Statement;
    insertEvent: Database.Statement;
    getEventsBySession: Database.Statement;
    getEventsBySessionLimit: Database.Statement;
    getEventsBefore: Database.Statement;
    getEventsAfter: Database.Statement;
    getEventById: Database.Statement;
    insertArtifactTouch: Database.Statement;
    getArtifactsBySession: Database.Statement;
    getSessionsByArtifact: Database.Statement;
    getLastOffset: Database.Statement;
    setLastOffset: Database.Statement;
  };

  private insertEventsTxn: (rows: InsertSessionEvent[]) => void;

  constructor(private db: Database.Database) {
    this.stmts = {
      getAll: db.prepare("SELECT * FROM sessions ORDER BY last_event_at DESC"),
      getById: db.prepare("SELECT * FROM sessions WHERE id = ?"),
      // R6 (#310): attribute MCP writes to the most recent active session of
      // the calling agent. Falls through 'active' → 'waiting' so a session
      // that's been quiet for a few seconds still gets the credit; 'done' /
      // 'disconnected' are excluded so we don't stamp memories on something
      // the user has clearly moved on from.
      getMostRecentActiveByAgent: db.prepare(`
        SELECT * FROM sessions
        WHERE agent = ? AND state IN ('active','waiting')
        ORDER BY last_event_at DESC
        LIMIT 1
      `),
      insertSession: db.prepare(`
        INSERT INTO sessions (id, space_id, source_id, cwd, agent, title, state, started_at, model, last_event_at)
        VALUES (
          @id, @space_id, @source_id, @cwd, @agent, @title, @state,
          COALESCE(@started_at, datetime('now')),
          @model,
          COALESCE(@last_event_at, datetime('now'))
        )
      `),
      // Idempotent boot scan needs upsert: re-seeing a session file should
      // refresh metadata without duplicating the row. The watcher is the
      // authoritative source for everything but `last_event_at` — when it
      // re-derives a column (with, e.g., better filters than a previous
      // version, or by replacing a stale naive `datetime('now')` with an
      // ISO timestamp), the new value should overwrite. last_event_at
      // ratchets forward via MAX so a stale boot scan can't rewind it.
      // The watcher always passes ISO for started_at (see consumeAppended +
      // reconcileExistingFile), so the overwrite here keeps the column
      // shape consistent across rows.
      upsertSession: db.prepare(`
        INSERT INTO sessions (id, space_id, source_id, cwd, agent, title, state, started_at, model, last_event_at)
        VALUES (
          @id, @space_id, @source_id, @cwd, @agent, @title, @state,
          COALESCE(@started_at, datetime('now')),
          @model,
          COALESCE(@last_event_at, datetime('now'))
        )
        ON CONFLICT(id) DO UPDATE SET
          space_id      = excluded.space_id,
          source_id     = excluded.source_id,
          cwd           = COALESCE(excluded.cwd, sessions.cwd),
          title         = excluded.title,
          state         = excluded.state,
          model         = excluded.model,
          started_at    = excluded.started_at,
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
      getEventsBefore: db.prepare(
        "SELECT * FROM session_events WHERE session_id = ? AND id < ? ORDER BY id DESC LIMIT ?"
      ),
      getEventsAfter: db.prepare(
        "SELECT * FROM session_events WHERE session_id = ? AND id > ? ORDER BY id ASC LIMIT ?"
      ),
      getEventById: db.prepare(
        "SELECT * FROM session_events WHERE session_id = ? AND id = ? LIMIT 1"
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
      getLastOffset: db.prepare(
        "SELECT last_offset FROM sessions WHERE id = ?"
      ),
      setLastOffset: db.prepare(
        "UPDATE sessions SET last_offset = ? WHERE id = ?"
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

  getMostRecentActiveByAgent(agent: SessionAgent): SessionRow | undefined {
    return this.stmts.getMostRecentActiveByAgent.get(agent) as SessionRow | undefined;
  }

  insertSession(row: InsertSession): void {
    this.stmts.insertSession.run({
      title: null,
      started_at: null,
      model: null,
      last_event_at: null,
      source_id: null,
      cwd: null,
      ...row,
    });
  }

  upsertSession(row: InsertSession): void {
    this.stmts.upsertSession.run({
      title: null,
      started_at: null,
      model: null,
      last_event_at: null,
      source_id: null,
      cwd: null,
      ...row,
    });
  }

  updateSessionState(id: string, state: SessionState, lastEventAt: string): void {
    this.stmts.updateSessionState.run(state, lastEventAt, id);
  }

  private static readonly UPDATABLE_SESSION_COLUMNS = new Set([
    "space_id", "source_id", "cwd", "title", "state", "ended_at", "model", "last_event_at",
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

  backfillSourceForCwd(cwd: string, spaceId: string, sourceId: string): number {
    // Only re-attribute genuinely-orphan rows. Both space_id and source_id
    // must be NULL — a session manually attached to a "logical-only" space
    // (no source) should not get yanked into the freshly-promoted folder
    // just because its cwd happens to match.
    const info = this.db
      .prepare("UPDATE sessions SET space_id = ?, source_id = ? WHERE cwd = ? AND source_id IS NULL AND space_id IS NULL")
      .run(spaceId, sourceId, cwd);
    return Number(info.changes);
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

  getEventById(sessionId: string, eventId: number): SessionEventRow | undefined {
    return this.stmts.getEventById.get(sessionId, eventId) as SessionEventRow | undefined;
  }

  // Returns up to `limit` events with id < beforeId, oldest first within the
  // slice. Used for scroll-up infinite load.
  getEventsBeforeBySession(sessionId: string, beforeId: number, limit: number): SessionEventRow[] {
    const rows = this.stmts.getEventsBefore.all(sessionId, beforeId, limit) as SessionEventRow[];
    return rows.reverse();
  }

  // Returns up to `limit` events with id > afterId, oldest first. Used for
  // live append: SSE fires, fetch only the new events past the latest cursor.
  getEventsAfterBySession(sessionId: string, afterId: number, limit: number): SessionEventRow[] {
    return this.stmts.getEventsAfter.all(sessionId, afterId, limit) as SessionEventRow[];
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

  getLastOffset(sessionId: string): number {
    const row = this.stmts.getLastOffset.get(sessionId) as { last_offset: number } | undefined;
    return row?.last_offset ?? 0;
  }

  setLastOffset(sessionId: string, offset: number): void {
    this.stmts.setLastOffset.run(offset, sessionId);
  }

  searchEvents(
    query: string,
    opts: { limit?: number; sessionId?: string } = {},
  ): SessionEventSearchHit[] {
    // Mirror the memory-store tokenisation: strip punctuation, drop
    // 1-char tokens, OR-join. Keeps natural-language queries forgiving
    // ("what did we decide about pricing?") without making the agent
    // learn FTS5 query syntax.
    //
    // Trailing `*` enables prefix matching so an incremental search
    // (Spotlight typing "ruth") matches "ruthless" before the user has
    // finished the word. FTS5 prefix matching is O(log n) on the
    // index — no scan penalty.
    const terms = query
      .replace(/[^\w\s]/g, "")
      .split(/\s+/)
      .filter((t) => t.length > 1)
      .map((t) => `${t}*`);
    if (terms.length === 0) return [];
    const ftsQuery = terms.join(" OR ");
    const limit = opts.limit ?? 20;

    // Only project columns the result type actually needs — full text and
    // raw JSONL can be hundreds of KB per row, and every caller today
    // slims them out anyway.
    const cols = `e.id, e.session_id, e.role, e.ts,
                  s.title AS session_title,
                  snippet(session_events_fts, 0, '[', ']', '…', 12) AS snippet`;
    const sql = opts.sessionId
      ? `SELECT ${cols}
         FROM session_events e
         JOIN session_events_fts fts ON e.id = fts.rowid
         JOIN sessions s             ON s.id = e.session_id
         WHERE session_events_fts MATCH ? AND e.session_id = ?
         ORDER BY fts.rank
         LIMIT ?`
      : `SELECT ${cols}
         FROM session_events e
         JOIN session_events_fts fts ON e.id = fts.rowid
         JOIN sessions s             ON s.id = e.session_id
         WHERE session_events_fts MATCH ?
         ORDER BY fts.rank
         LIMIT ?`;

    const params = opts.sessionId ? [ftsQuery, opts.sessionId, limit] : [ftsQuery, limit];
    return this.db.prepare(sql).all(...params) as SessionEventSearchHit[];
  }
}
