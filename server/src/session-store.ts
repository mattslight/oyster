import type Database from "better-sqlite3";

// Sessions arc (0.5.0). See docs/plans/sessions-arc.md.
//
// Three tables, three row types. The store is pure DB — the watcher / SSE
// layers wrap calls in their own logic. Writes go through prepared statements
// so the high-volume session_events insert path stays cheap.

// ── Row types (mirror SQLite schema in db.ts) ──

export type SessionState = "active" | "waiting" | "disconnected" | "done";
export type SessionAgent = "claude-code" | "opencode" | "codex";
export type AssignmentMode = "auto" | "manual";
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
  /** Absolute on-disk path to the jsonl. NULL on rows that pre-date this
   *  column (back-compat) — pushBytes falls back to computing from cwd in
   *  that case. */
  jsonl_path: string | null;
  agent: SessionAgent;
  title: string | null;
  state: SessionState;
  started_at: string;
  ended_at: string | null;
  model: string | null;
  last_event_at: string;
  /** Who owns the (space_id, source_id) classification. `'auto'` is open to
   *  heuristic improvement as sources change; `'manual'` is pinned by the
   *  user / an MCP-driven agent and is never overwritten by the heuristic. */
  assignment_mode: AssignmentMode;
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
  /** Absolute path to the jsonl file on disk. The watcher knows this from
   *  its chokidar events; passing it on every upsert lets pushBytes locate
   *  the file directly instead of recomputing it from cwd. Required for
   *  cross-device resumed sessions where the events carry the origin
   *  device's cwd, not the actual local file location. */
  jsonl_path?: string | null;
  agent: SessionAgent;
  title?: string | null;
  state: SessionState;
  started_at?: string;
  model?: string | null;
  last_event_at?: string;
  /** Defaults to `'auto'` when omitted — only manual-flip flows pass `'manual'`. */
  assignment_mode?: AssignmentMode;
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
  /** Bind every `assignment_mode = 'auto'` session whose `cwd` is matched by
   *  `path` (exact OR `cwd LIKE path || '/%'`) to this source — *unless* a
   *  different active source has a strictly longer matching path, in which
   *  case the longer source wins. Idempotent. Returns the number of rows
   *  updated. Manual rows are immune. Already-bound auto rows may be moved
   *  to a more specific source (the "improve" case) but are never demoted
   *  to a less specific one. */
  rebindAutoSessionsForSource(spaceId: string, sourceId: string, path: string): number;
  /** Null out `source_id` on every session pointing at this source. Used by
   *  `removeSource` to keep the binding consistent after a soft-delete —
   *  the FK ON DELETE SET NULL never fires because the source row stays in
   *  the table. `assignment_mode` is left as-is so a manual-pinned session
   *  whose source vanishes becomes orphan-but-frozen (the user can choose
   *  "Let Oyster decide" to recompute). */
  detachSourceFromSessions(sourceId: string): number;
  /** Bulk re-point every session bound to `fromSourceId` onto `toSourceId`,
   *  setting space_id to the target's space. Used by consolidateSource. */
  reassignSourceForSessions(fromSourceId: string, toSourceId: string, toSpaceId: string): number;
  /** Count of sessions currently bound to a source. For the consolidate
   *  preview dialog so the user sees how many rows will move. */
  countBySource(sourceId: string): number;
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
        INSERT INTO sessions (id, space_id, source_id, cwd, jsonl_path, agent, title, state, started_at, model, last_event_at, assignment_mode)
        VALUES (
          @id, @space_id, @source_id, @cwd, @jsonl_path, @agent, @title, @state,
          COALESCE(@started_at, datetime('now')),
          @model,
          COALESCE(@last_event_at, datetime('now')),
          @assignment_mode
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
        INSERT INTO sessions (id, space_id, source_id, cwd, jsonl_path, agent, title, state, started_at, model, last_event_at, assignment_mode)
        VALUES (
          @id, @space_id, @source_id, @cwd, @jsonl_path, @agent, @title, @state,
          COALESCE(@started_at, datetime('now')),
          @model,
          COALESCE(@last_event_at, datetime('now')),
          @assignment_mode
        )
        ON CONFLICT(id) DO UPDATE SET
          -- Watcher upserts NEVER overwrite the user's manual classification.
          -- For 'auto' rows we let the watcher refresh space/source from the
          -- latest cwd resolution; for 'manual' rows the user pinned it, so
          -- the existing values stay.
          space_id      = CASE WHEN sessions.assignment_mode = 'manual' THEN sessions.space_id ELSE excluded.space_id END,
          source_id     = CASE WHEN sessions.assignment_mode = 'manual' THEN sessions.source_id ELSE excluded.source_id END,
          cwd           = COALESCE(excluded.cwd, sessions.cwd),
          -- jsonl_path: prefer the new value when the watcher knows where
          -- the file is. The watcher always passes the real path on every
          -- upsert, so this overwrite is what fixes cross-device rows
          -- whose cwd field was poisoned with the origin device's path.
          jsonl_path    = COALESCE(excluded.jsonl_path, sessions.jsonl_path),
          title         = excluded.title,
          state         = excluded.state,
          model         = excluded.model,
          started_at    = excluded.started_at,
          last_event_at = MAX(excluded.last_event_at, sessions.last_event_at)
          -- assignment_mode is deliberately omitted from the UPDATE — it can
          -- only be changed via the mutation surfaces (PATCH / MCP tool), not
          -- by a watcher upsert.
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
      jsonl_path: null,
      assignment_mode: "auto",
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
      jsonl_path: null,
      assignment_mode: "auto",
      ...row,
    });
  }

  updateSessionState(id: string, state: SessionState, lastEventAt: string): void {
    this.stmts.updateSessionState.run(state, lastEventAt, id);
  }

  private static readonly UPDATABLE_SESSION_COLUMNS = new Set([
    "space_id", "source_id", "cwd", "title", "state", "ended_at", "model", "last_event_at", "assignment_mode",
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

  rebindAutoSessionsForSource(spaceId: string, sourceId: string, path: string): number {
    // Longest-prefix rebind. Touches `assignment_mode = 'auto'` rows only.
    //
    // Match condition: `cwd == path` (exact) OR `cwd` starts with
    // `path + '/'`. Comparison is via `substr()` rather than `LIKE`
    // because SQL LIKE treats `_` and `%` as wildcards, and `_` is
    // unavoidable in real-world paths (`node_modules`, `my_repo`,
    // snake-case directories generally) — LIKE would silently mis-bind
    // wherever a path contains those characters. The substr form is
    // literal and cheap.
    //
    // The NOT EXISTS clause makes longest-prefix work both ways:
    //   - Orphan auto rows whose cwd matches this source bind here.
    //   - Auto rows currently bound to a *less specific* source move up
    //     to this one (the "improve" case — e.g. session was bound to
    //     `~/Oyster` when only that source existed; now `~/Oyster/web`
    //     is attached and the session's cwd is `~/Oyster/web/src`).
    //   - Auto rows bound to a more specific source are never demoted —
    //     NOT EXISTS finds the longer match and the row is skipped.
    //   - Manual rows are immune via the assignment_mode filter.
    const info = this.db
      .prepare(
        `UPDATE sessions
            SET space_id = @space_id, source_id = @source_id
          WHERE assignment_mode = 'auto'
            AND cwd IS NOT NULL
            AND (
              cwd = @path
              OR (substr(cwd, 1, length(@path)) = @path
                  AND substr(cwd, length(@path) + 1, 1) = '/')
            )
            AND NOT EXISTS (
              SELECT 1 FROM sources s
               WHERE s.removed_at IS NULL
                 AND s.id <> @source_id
                 AND length(s.path) > length(@path)
                 AND (
                   sessions.cwd = s.path
                   OR (substr(sessions.cwd, 1, length(s.path)) = s.path
                       AND substr(sessions.cwd, length(s.path) + 1, 1) = '/')
                 )
            )`,
      )
      .run({ space_id: spaceId, source_id: sourceId, path });
    return Number(info.changes);
  }

  detachSourceFromSessions(sourceId: string): number {
    // Soft-delete-aware detach companion: removeSource only flips
    // `sources.removed_at`, so the FK ON DELETE SET NULL never fires.
    // Without this update, `sessions.source_id` keeps pointing at a
    // soft-deleted row — silently broken state. Mode is left as-is so a
    // manually-pinned session whose source vanishes stays manual; the user
    // can run "Let Oyster decide" to recompute via the heuristic.
    const info = this.db
      .prepare("UPDATE sessions SET source_id = NULL WHERE source_id = ?")
      .run(sourceId);
    return Number(info.changes);
  }

  countBySource(sourceId: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS c FROM sessions WHERE source_id = ?")
      .get(sourceId) as { c: number } | undefined;
    return row?.c ?? 0;
  }

  reassignSourceForSessions(fromSourceId: string, toSourceId: string, toSpaceId: string): number {
    // Bulk-move every session bound to source A onto source B. Used by
    // SpaceService.consolidateSource when the user merges two folder tiles
    // (e.g. after a rename created duplicate sources). Preserves
    // assignment_mode — a manually-pinned session on A stays pinned on B,
    // mirroring the user's intent ("this work is mine to organise").
    const info = this.db
      .prepare("UPDATE sessions SET source_id = ?, space_id = ? WHERE source_id = ?")
      .run(toSourceId, toSpaceId, fromSourceId);
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
    // Two query shapes:
    //   - Single plain alphanumeric word → prefix match, so an
    //     incremental search ("ruth") finds "ruthless".
    //   - Anything else (whitespace, dots, dashes, underscores) →
    //     FTS5 phrase query, so "0.6.0" finds the version string
    //     instead of stripping dots → 060* → prefix-matching commit
    //     hashes, and "memory_recalls" finds the literal identifier
    //     instead of matching adjacent free-floating "memory" /
    //     "recalls" tokens.
    //
    // FTS5 unicode61 (default tokeniser) strips punctuation in the
    // index too, so phrase "0.6.0" tokenises identically on both sides
    // — the indexed text "0.6.0" is stored as adjacent tokens 0/6/0,
    // and the query parses to the same adjacent-tokens phrase.
    const trimmed = query.trim();
    if (trimmed.length === 0) return [];
    // Guard: a query of pure punctuation (e.g. "?", "()") would wrap
    // to a phrase that the unicode61 tokeniser strips entirely,
    // producing an FTS5 syntax error at execution time. Bail before
    // we hit SQLite.
    if (!/[A-Za-z0-9]/.test(trimmed)) return [];
    const isPlainWord = /^[A-Za-z0-9]+$/.test(trimmed);
    let ftsQuery: string;
    if (isPlainWord) {
      if (trimmed.length < 2) return [];
      ftsQuery = `${trimmed}*`;
    } else {
      // FTS5 escapes embedded double-quotes by doubling them.
      ftsQuery = `"${trimmed.replace(/"/g, '""')}"`;
    }
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
