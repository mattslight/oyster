import Database from "better-sqlite3";
import crypto from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { ToolDefiner } from "./mcp-tool.js";

// ── Contract ──────────────────────────────────────────────────

export interface Memory {
  id: string;
  content: string;
  space_id: string | null;
  tags: string[];
  created_at: string;
  // R6 traceable recall: which session produced this memory. NULL for
  // legacy rows and for writes that arrive without a known session
  // (e.g. internal calls outside the agent watcher's coverage).
  source_session_id: string | null;
}

export interface RememberInput {
  content: string;
  space_id?: string;
  tags?: string[];
  source_session_id?: string | null;
  cloud_owner_id?: string | null;
}

export interface RecallInput {
  query: string;
  space_id?: string;
  limit?: number;
  // The session asking; logged to memory_recalls so the inspector can
  // render "Pulled into this session". NULL leaves recall unattributed.
  recalling_session_id?: string | null;
}

/** A memory pulled into a session — Memory + when *this session* most
 *  recently recalled it. The recall timestamp is what the inspector
 *  should surface on the "Pulled into this session" list; the memory's
 *  own created_at can be days/weeks older than the recall event. */
export interface RecalledMemory extends Memory {
  recalled_at: string;
}

export interface MemoryProvider {
  init(): Promise<void>;
  remember(input: RememberInput): Promise<Memory>;
  recall(input: RecallInput): Promise<Memory[]>;
  /** Marks a memory as forgotten. Returns true if a row was updated, false if
   *  the id doesn't exist — callers can map false → 404. */
  forget(id: string, cloud_owner_id?: string | null): Promise<boolean>;
  /** Server-internal hard-redaction. Writes a purge event and nulls payload
   *  content. Not exposed via MCP in v1; reserved for "delete forever" UI,
   *  account deletion, and secret-exposure flows. */
  purge(id: string, cloud_owner_id?: string | null): Promise<boolean>;
  list(space_id?: string): Promise<Memory[]>;
  /** Synchronous existence check used by the import flow's dedupe — true
   *  when an active memory with this exact (content, space_id) already
   *  exists. Implementations are expected to do a single equality lookup. */
  findExact(content: string, spaceId?: string): boolean;
  exportMemories(): Promise<Memory[]>;
  importMemories(memories: Memory[]): Promise<void>;
  // R6: memories *written* during the given session.
  getBySourceSession(sessionId: string): Promise<Memory[]>;
  // R6: memories the given session pulled via recall(). Each row carries
  // recalled_at = MAX(memory_recalls.ts) for that (memory, session).
  getRecalledBySession(sessionId: string): Promise<RecalledMemory[]>;
  close(): void;
}

// ── SQLite FTS5 provider ──────────────────────────────────────

interface MemoryRow {
  id: string;
  space_id: string | null;
  content: string;
  tags: string;          // JSON array stored as text
  access_count: number;
  superseded_by: string | null;
  created_at: string;
  updated_at: string;
  source_session_id: string | null;
}

function rowToMemory(row: MemoryRow): Memory {
  return {
    id: row.id,
    content: row.content,
    space_id: row.space_id,
    tags: JSON.parse(row.tags),
    created_at: row.created_at,
    source_session_id: row.source_session_id ?? null,
  };
}

export class SqliteFtsMemoryProvider implements MemoryProvider {
  private db!: Database.Database;
  private stmts!: {
    insert: Database.Statement;
    findExact: Database.Statement;
    supersede: Database.Statement;
    listActive: Database.Statement;
    listActiveBySpace: Database.Statement;
    getById: Database.Statement;
    incrementAccess: Database.Statement;
    exportAll: Database.Statement;
    logRecall: Database.Statement;
    bySourceSession: Database.Statement;
    recalledBySession: Database.Statement;
  };
  // Wraps the per-row access-bump + recall-log inserts in a single
  // transaction so a 50-row recall is one fsync, not 100.
  private postRecallTxn!: (rows: MemoryRow[], recallerId: string | null) => void;
  private storagePath: string;

  constructor(storagePath: string) {
    this.storagePath = storagePath;
  }

  async init(): Promise<void> {
    mkdirSync(this.storagePath, { recursive: true });
    const dbPath = join(this.storagePath, "memory.db");
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");

    // Schema
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id            TEXT PRIMARY KEY,
        space_id      TEXT,
        content       TEXT NOT NULL,
        tags          TEXT NOT NULL DEFAULT '[]',
        access_count  INTEGER NOT NULL DEFAULT 0,
        superseded_by TEXT,
        created_at    TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);

    this.db.exec(`CREATE INDEX IF NOT EXISTS memories_space_id ON memories(space_id)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS memories_active ON memories(superseded_by) WHERE superseded_by IS NULL`);

    // R6 traceable recall (#310): each memory remembers the session that
    // produced it; each recall logs the session that pulled it. Schema is
    // additive so legacy rows survive (source_session_id NULL = unknown).
    try {
      this.db.exec(`ALTER TABLE memories ADD COLUMN source_session_id TEXT`);
    } catch (err) {
      // Only swallow the idempotent-rerun case ("duplicate column name").
      // DB-lock / I/O / corruption errors must surface.
      if (!(err instanceof Error) || !/duplicate column/i.test(err.message)) throw err;
    }
    this.db.exec(`CREATE INDEX IF NOT EXISTS memories_source_session ON memories(source_session_id)`);

    // Grows monotonically — one row per recall result per call. At expected
    // single-digit recalls/min during active use this stays small for
    // months. Pruning lives in the 0.8.0 sync work where we'll need a
    // retention policy anyway (cloud cost). For v1, accept unbounded.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_recalls (
        id          INTEGER PRIMARY KEY,
        memory_id   TEXT NOT NULL,
        session_id  TEXT NOT NULL,
        ts          TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS memory_recalls_session ON memory_recalls(session_id);
      CREATE INDEX IF NOT EXISTS memory_recalls_memory ON memory_recalls(memory_id);
    `);

    // ── #318 cloud sync substrate ─────────────────────────────────
    // Append-only event log. Doubles as outbox via cloud_synced_at IS NULL.
    // Per-type uniqueness mirrors the cloud constraints (spec Q6) so backfill
    // and replay are safely idempotent locally too.
    // cloud_owner_id is captured at write time from auth state; events are
    // only pushed when cloud_owner_id matches the current Pro user. This is
    // the single-Pro-account-per-device guard (see "Account-switching policy").
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_events (
        event_id        TEXT    PRIMARY KEY,
        memory_id       TEXT    NOT NULL,
        event_type      TEXT    NOT NULL CHECK (event_type IN ('memory_created','memory_forgotten','memory_purged')),
        space_id        TEXT,
        cloud_owner_id  TEXT,
        created_at      INTEGER NOT NULL,    -- Unix epoch ms (not ISO string; matches D1 cloud schema for cross-device events)
        cloud_synced_at INTEGER
      )
    `);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_memory_events_memory ON memory_events(memory_id)`);
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS idx_memory_events_pending
         ON memory_events(cloud_synced_at) WHERE cloud_synced_at IS NULL`,
    );
    this.db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS uniq_memory_events_created
         ON memory_events(memory_id) WHERE event_type = 'memory_created'`,
    );
    this.db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS uniq_memory_events_forgotten
         ON memory_events(memory_id) WHERE event_type = 'memory_forgotten'`,
    );
    this.db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS uniq_memory_events_purged
         ON memory_events(memory_id) WHERE event_type = 'memory_purged'`,
    );

    // Redactable content store. Purge nulls content + tags (tags are
    // redacted alongside content so no PII can leak via tag text) and
    // sets purged_at.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_payloads (
        memory_id  TEXT PRIMARY KEY,
        content    TEXT,
        tags       TEXT NOT NULL DEFAULT '[]',
        purged_at  INTEGER
      )
    `);

    // Add purged_at to memories. Recall code filters this column out so
    // forgotten and purged rows behave identically for FTS5 readers.
    try {
      this.db.exec(`ALTER TABLE memories ADD COLUMN purged_at INTEGER`);
    } catch (err) {
      if (!(err instanceof Error) || !/duplicate column/i.test(err.message)) throw err;
    }

    // FTS5 virtual table
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
        content,
        tags,
        content=memories,
        content_rowid=rowid
      )
    `);

    // Triggers to keep FTS in sync
    for (const sql of [
      `CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, content, tags) VALUES (new.rowid, new.content, new.tags);
      END`,
      `CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content, tags) VALUES('delete', old.rowid, old.content, old.tags);
      END`,
      `CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content, tags) VALUES('delete', old.rowid, old.content, old.tags);
        INSERT INTO memories_fts(rowid, content, tags) VALUES (new.rowid, new.content, new.tags);
      END`,
    ]) {
      this.db.exec(sql);
    }

    // Prepared statements
    this.stmts = {
      insert: this.db.prepare(
        `INSERT INTO memories (id, space_id, content, tags, source_session_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
      ),
      findExact: this.db.prepare(
        `SELECT * FROM memories
         WHERE content = ? AND (space_id = ? OR (space_id IS NULL AND ? IS NULL))
           AND superseded_by IS NULL`,
      ),
      supersede: this.db.prepare(
        `UPDATE memories SET superseded_by = ?, updated_at = datetime('now') WHERE id = ?`,
      ),
      listActive: this.db.prepare(
        `SELECT * FROM memories WHERE superseded_by IS NULL ORDER BY updated_at DESC`,
      ),
      listActiveBySpace: this.db.prepare(
        `SELECT * FROM memories WHERE superseded_by IS NULL AND (space_id = ? OR space_id IS NULL)
         ORDER BY updated_at DESC`,
      ),
      getById: this.db.prepare(`SELECT * FROM memories WHERE id = ?`),
      incrementAccess: this.db.prepare(
        `UPDATE memories SET access_count = access_count + 1 WHERE id = ?`,
      ),
      exportAll: this.db.prepare(
        `SELECT * FROM memories WHERE superseded_by IS NULL ORDER BY created_at ASC`,
      ),
      logRecall: this.db.prepare(
        `INSERT INTO memory_recalls (memory_id, session_id) VALUES (?, ?)`,
      ),
      bySourceSession: this.db.prepare(
        `SELECT * FROM memories
         WHERE source_session_id = ? AND superseded_by IS NULL
         ORDER BY created_at ASC`,
      ),
      recalledBySession: this.db.prepare(
        // De-dupe: a session can recall the same memory many times; we want
        // each memory once, ordered by most-recent recall. last_ts is
        // projected so the inspector can show "pulled <relative time>"
        // rather than the memory's own created_at.
        `SELECT m.*, r.last_ts AS recalled_at
         FROM memories m
         JOIN (
           SELECT memory_id, MAX(ts) AS last_ts
           FROM memory_recalls
           WHERE session_id = ?
           GROUP BY memory_id
         ) r ON r.memory_id = m.id
         WHERE m.superseded_by IS NULL
         ORDER BY r.last_ts DESC`,
      ),
    };

    const incrementAccess = this.stmts.incrementAccess;
    const logRecall = this.stmts.logRecall;
    this.postRecallTxn = this.db.transaction((rows: MemoryRow[], recallerId: string | null) => {
      for (const row of rows) {
        incrementAccess.run(row.id);
        if (recallerId) logRecall.run(row.id, recallerId);
      }
    });

    this.backfillFromLegacy();
  }

  findExact(content: string, spaceId?: string): boolean {
    const sid = spaceId ?? null;
    return !!(this.stmts.findExact.get(content, sid, sid) as MemoryRow | undefined);
  }

  writeCreated(input: {
    memory_id?: string;
    content: string;
    space_id?: string | null;
    tags?: string[];
    source_session_id?: string | null;
    created_at?: number;
    cloud_owner_id?: string | null;
  }): { memory_id: string; event_id: string; inserted: boolean } {
    const memory_id = input.memory_id ?? crypto.randomUUID();
    const event_id  = crypto.randomUUID();
    const space_id  = input.space_id ?? null;
    const tags      = JSON.stringify(input.tags ?? []);
    const ssid      = input.source_session_id ?? null;
    const created_at = input.created_at ?? Date.now();
    const owner_id  = input.cloud_owner_id ?? null;

    let inserted = false;
    let returned_event_id: string = event_id;

    const txn = this.db.transaction(() => {
      const info = this.db.prepare(
        `INSERT OR IGNORE INTO memory_events
           (event_id, memory_id, event_type, space_id, cloud_owner_id, created_at, cloud_synced_at)
         VALUES (?, ?, 'memory_created', ?, ?, ?, NULL)`,
      ).run(event_id, memory_id, space_id, owner_id, created_at);
      inserted = info.changes > 0;

      if (!inserted) {
        // A memory_created event already exists for this memory_id. Look up
        // its event_id so the caller can reference the canonical event.
        const existing = this.db.prepare(
          `SELECT event_id FROM memory_events WHERE memory_id = ? AND event_type = 'memory_created'`,
        ).get(memory_id) as { event_id: string } | undefined;
        if (existing) returned_event_id = existing.event_id;
      }

      this.db.prepare(
        `INSERT OR IGNORE INTO memory_payloads (memory_id, content, tags)
         VALUES (?, ?, ?)`,
      ).run(memory_id, input.content, tags);

      this.materialiseMemory(memory_id, { ssid });
    });
    txn();
    return { memory_id, event_id: returned_event_id, inserted };
  }

  materialiseMemory(memory_id: string, opts?: { ssid?: string | null }): void {
    // Pick highest-precedence event for this memory_id.
    type EvRow = { event_type: string; space_id: string | null; created_at: number };
    const events = this.db.prepare(
      `SELECT event_type, space_id, created_at FROM memory_events WHERE memory_id = ?`,
    ).all(memory_id) as EvRow[];
    if (events.length === 0) {
      this.db.prepare(`DELETE FROM memories WHERE id = ?`).run(memory_id);
      return;
    }
    const has = (t: string) => events.some((e) => e.event_type === t);
    const created = events.find((e) => e.event_type === "memory_created");

    if (has("memory_purged")) {
      // Purge: nullify payload + remove from recall surface.
      this.db.prepare(
        `UPDATE memory_payloads SET content = NULL, tags = '[]', purged_at = ? WHERE memory_id = ?`,
      ).run(Date.now(), memory_id);
      this.db.prepare(`DELETE FROM memories WHERE id = ?`).run(memory_id);
      return;
    }

    if (!created) {
      // Forget arrived before create. Nothing to materialise yet.
      return;
    }

    const payload = this.db.prepare(
      `SELECT content, tags FROM memory_payloads WHERE memory_id = ?`,
    ).get(memory_id) as { content: string | null; tags: string } | undefined;
    if (!payload || payload.content === null) {
      // Created event with no payload yet, or payload purged. Nothing to show.
      this.db.prepare(`DELETE FROM memories WHERE id = ?`).run(memory_id);
      return;
    }

    const ssid = opts?.ssid ?? null;
    const supersededBy = has("memory_forgotten") ? "forgotten" : null;

    // Upsert the recall surface. FTS5 triggers on memories keep the index in sync.
    this.db.prepare(
      `INSERT INTO memories (id, space_id, content, tags, source_session_id, superseded_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime(?, 'unixepoch'), datetime('now'))
       ON CONFLICT(id) DO UPDATE SET
         space_id = excluded.space_id,
         content = excluded.content,
         tags = excluded.tags,
         superseded_by = excluded.superseded_by,
         updated_at = datetime('now')`,
    ).run(
      memory_id,
      created.space_id,
      payload.content,
      payload.tags,
      ssid,
      supersededBy,
      Math.floor(created.created_at / 1000),
    );
  }

  /** One-time backfill: for each row in `memories` without a matching
   *  memory_created event, write events + payload from the legacy state.
   *  Idempotent because the per-type uniqueness indexes reject duplicates. */
  private backfillFromLegacy(): void {
    type LegacyRow = {
      id: string; space_id: string | null; content: string; tags: string;
      superseded_by: string | null; created_at: string; source_session_id: string | null;
    };
    const rows = this.db.prepare(
      `SELECT m.id, m.space_id, m.content, m.tags, m.superseded_by, m.created_at, m.source_session_id
         FROM memories m
         LEFT JOIN memory_events e ON e.memory_id = m.id AND e.event_type = 'memory_created'
        WHERE e.memory_id IS NULL`,
    ).all() as LegacyRow[];

    if (rows.length === 0) return;

    // Hoist statements once; the loop reuses them inside a single transaction
    // so N legacy rows produce one fsync, not 3*N.
    const insertCreatedEvent = this.db.prepare(
      `INSERT OR IGNORE INTO memory_events
         (event_id, memory_id, event_type, space_id, cloud_owner_id, created_at, cloud_synced_at)
       VALUES (?, ?, 'memory_created', ?, NULL, ?, NULL)`,
    );
    const insertPayload = this.db.prepare(
      `INSERT OR IGNORE INTO memory_payloads (memory_id, content, tags)
       VALUES (?, ?, ?)`,
    );
    const insertSecondaryEvent = this.db.prepare(
      `INSERT OR IGNORE INTO memory_events
         (event_id, memory_id, event_type, space_id, cloud_owner_id, created_at, cloud_synced_at)
       VALUES (?, ?, ?, NULL, NULL, ?, NULL)`,
    );

    const txn = this.db.transaction(() => {
      for (const r of rows) {
        // SQLite text timestamps may be either "YYYY-MM-DD HH:MM:SS" (from
        // datetime('now')) or "YYYY-MM-DD" (date-only). V8's Date.parse rejects
        // the space-separated form, so normalise to the ISO `T` separator
        // before appending the UTC marker. Fall back to now() if still unparseable.
        const isoText = r.created_at.includes("T") ? r.created_at : r.created_at.replace(" ", "T");
        const parsed = Date.parse(isoText.endsWith("Z") ? isoText : isoText + "Z");
        const created_ms = Number.isFinite(parsed) ? parsed : Date.now();

        // cloud_owner_id intentionally NULL — backfilled events do not push to
        // any current Pro account. Pre-existing memories stay local until an
        // explicit claim flow is shipped (see "Account-switching policy").
        // source_session_id is fetched into LegacyRow for completeness but
        // intentionally not forwarded — the existing `memories` row retains
        // its original value, and the cloud event log doesn't carry session
        // attribution.
        insertCreatedEvent.run(crypto.randomUUID(), r.id, r.space_id, created_ms);
        insertPayload.run(r.id, r.content, r.tags);

        if (r.superseded_by !== null) {
          // Map legacy 'forgotten' / 'purged' marker to the appropriate event.
          const evType = r.superseded_by === "purged" ? "memory_purged" : "memory_forgotten";
          insertSecondaryEvent.run(crypto.randomUUID(), r.id, evType, created_ms + 1);
        }
      }
    });
    txn();
  }

  writeForgotten(memory_id: string, cloud_owner_id: string | null = null): boolean {
    // Idempotent: per-type uniqueness means a second forget event is rejected.
    let inserted = false;
    const txn = this.db.transaction(() => {
      const info = this.db.prepare(
        `INSERT OR IGNORE INTO memory_events
           (event_id, memory_id, event_type, space_id, cloud_owner_id, created_at, cloud_synced_at)
         VALUES (?, ?, 'memory_forgotten', NULL, ?, ?, NULL)`,
      ).run(crypto.randomUUID(), memory_id, cloud_owner_id, Date.now());
      if (info.changes === 0) return;
      inserted = true;
      this.materialiseMemory(memory_id);
    });
    txn();
    return inserted;
  }

  writePurged(memory_id: string, cloud_owner_id: string | null = null): boolean {
    // Succeeds even when no memory_created event exists yet (purge-before-create
    // is a valid sequence — purge dominates regardless of arrival order).
    // Returns false only when a memory_purged event already exists for this
    // memory_id (idempotent).
    let inserted = false;
    const txn = this.db.transaction(() => {
      const info = this.db.prepare(
        `INSERT OR IGNORE INTO memory_events
           (event_id, memory_id, event_type, space_id, cloud_owner_id, created_at, cloud_synced_at)
         VALUES (?, ?, 'memory_purged', NULL, ?, ?, NULL)`,
      ).run(crypto.randomUUID(), memory_id, cloud_owner_id, Date.now());
      if (info.changes === 0) return;
      inserted = true;
      // Ensure a payload row exists so the materialisation pass can null its content.
      this.db.prepare(
        `INSERT OR IGNORE INTO memory_payloads (memory_id, content, tags) VALUES (?, NULL, '[]')`,
      ).run(memory_id);
      this.materialiseMemory(memory_id);
    });
    txn();
    return inserted;
  }

  async remember(input: RememberInput): Promise<Memory> {
    const spaceId = input.space_id ?? null;

    // Conservative dedupe: exact content match in same scope. Preserves the
    // existing surface contract — `remember` returns the existing row instead
    // of duplicating. Skip for empty content (defensive).
    if (input.content.length > 0) {
      const existing = this.stmts.findExact.get(input.content, spaceId, spaceId) as MemoryRow | undefined;
      if (existing) return rowToMemory(existing);
    }

    const { memory_id } = this.writeCreated({
      content: input.content,
      space_id: spaceId,
      tags: input.tags,
      source_session_id: input.source_session_id,
      cloud_owner_id: input.cloud_owner_id ?? null,
    });
    const row = this.stmts.getById.get(memory_id) as MemoryRow;
    return rowToMemory(row);
  }

  async recall(input: RecallInput): Promise<Memory[]> {
    const limit = input.limit ?? 10;
    const spaceId = input.space_id ?? null;

    // Convert query to OR-joined terms so partial matches work
    // "how old am I" → "how OR old OR am OR I"
    const terms = input.query
      .replace(/[^\w\s]/g, "")
      .split(/\s+/)
      .filter((t) => t.length > 1);
    if (terms.length === 0) return [];
    const ftsQuery = terms.join(" OR ");

    let sql: string;
    let params: unknown[];

    if (spaceId) {
      sql = `SELECT m.* FROM memories m
             JOIN memories_fts fts ON m.rowid = fts.rowid
             WHERE memories_fts MATCH ? AND m.superseded_by IS NULL
               AND (m.space_id = ? OR m.space_id IS NULL)
             ORDER BY fts.rank
             LIMIT ?`;
      params = [ftsQuery, spaceId, limit];
    } else {
      sql = `SELECT m.* FROM memories m
             JOIN memories_fts fts ON m.rowid = fts.rowid
             WHERE memories_fts MATCH ? AND m.superseded_by IS NULL
             ORDER BY fts.rank
             LIMIT ?`;
      params = [ftsQuery, limit];
    }

    const rows = this.db.prepare(sql).all(...params) as MemoryRow[];

    // Increment access counts; log the (memory, session) pair when we
    // know which session is asking (R6 traceable recall). One transaction
    // per recall so a 50-row result is one fsync, not 100.
    this.postRecallTxn(rows, input.recalling_session_id ?? null);

    return rows.map(rowToMemory);
  }

  async getBySourceSession(sessionId: string): Promise<Memory[]> {
    const rows = this.stmts.bySourceSession.all(sessionId) as MemoryRow[];
    return rows.map(rowToMemory);
  }

  async getRecalledBySession(sessionId: string): Promise<RecalledMemory[]> {
    const rows = this.stmts.recalledBySession.all(sessionId) as Array<MemoryRow & { recalled_at: string }>;
    return rows.map((row) => ({ ...rowToMemory(row), recalled_at: row.recalled_at }));
  }

  async forget(id: string, cloud_owner_id: string | null = null): Promise<boolean> {
    const row = this.stmts.getById.get(id) as MemoryRow | undefined;
    if (!row) return false;
    this.writeForgotten(id, cloud_owner_id);
    return true;
  }

  async purge(id: string, cloud_owner_id: string | null = null): Promise<boolean> {
    const row = this.stmts.getById.get(id) as MemoryRow | undefined;
    const hasEvent = this.db.prepare(
      `SELECT 1 FROM memory_events WHERE memory_id = ? LIMIT 1`,
    ).get(id);
    if (!row && !hasEvent) return false;
    this.writePurged(id, cloud_owner_id);
    return true;
  }

  async list(space_id?: string): Promise<Memory[]> {
    const rows = space_id
      ? (this.stmts.listActiveBySpace.all(space_id) as MemoryRow[])
      : (this.stmts.listActive.all() as MemoryRow[]);
    return rows.map(rowToMemory);
  }

  async exportMemories(): Promise<Memory[]> {
    const rows = this.stmts.exportAll.all() as MemoryRow[];
    return rows.map(rowToMemory);
  }

  async importMemories(memories: Memory[]): Promise<void> {
    const insertOrIgnore = this.db.prepare(
      `INSERT OR IGNORE INTO memories (id, space_id, content, tags, source_session_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
    );
    const tx = this.db.transaction((items: Memory[]) => {
      for (const m of items) {
        insertOrIgnore.run(
          m.id,
          m.space_id,
          m.content,
          JSON.stringify(m.tags),
          m.source_session_id ?? null,
          m.created_at,
        );
      }
    });
    tx(memories);
  }

  close(): void {
    this.db?.close();
  }
}

// ── MCP tool registration ─────────────────────────────────────

export function registerMemoryTools(
  tool: ToolDefiner,
  provider: MemoryProvider,
  // R6: returns the session id of the agent making this request, or null
  // when we can't attribute (no matching active session, internal-only call,
  // unknown user-agent). Stamps memories at write time and logs recalls.
  resolveActiveSessionId: () => string | null = () => null,
  resolveCurrentOwnerId: () => string | null = () => null,
): void {
  tool(
    "remember",
    "Store a memory for future sessions. Use when the user says 'remember this', shares a preference, or makes a decision worth preserving. Do not auto-remember — only store when explicitly asked or when the fact is clearly durable.",
    {
      content: z.string().describe("The memory content — freeform text describing what to remember"),
      space_id: z.string().optional().describe("Scope to a space (e.g. 'tokinvest'). Omit for global memory."),
      tags: z.array(z.string()).optional().describe("Categorisation tags (e.g. ['preference'], ['decision', 'project:tokinvest'])"),
    },
    async ({ content, space_id, tags }) => provider.remember({
      content,
      space_id,
      tags,
      source_session_id: resolveActiveSessionId(),
      cloud_owner_id: resolveCurrentOwnerId(),
    }),
  );

  tool(
    "recall",
    "Search memories by natural language query. Returns ranked matches from this space and global memories. Use at session start to load relevant context, or when the user asks what you remember.",
    {
      query: z.string().describe("Natural language search query"),
      space_id: z.string().optional().describe("Scope search to a space plus global memories. Omit to search everything."),
      limit: z.number().int().min(1).max(50).optional().describe("Max results (default 10)"),
    },
    async ({ query, space_id, limit }) => {
      const memories = await provider.recall({
        query,
        space_id,
        limit,
        recalling_session_id: resolveActiveSessionId(),
      });
      if (memories.length === 0) return "No memories found.";
      return memories;
    },
  );

  tool(
    "forget",
    "Remove a memory from active recall by ID. The user will no longer see this memory in searches or lists.",
    {
      id: z.string().describe("Memory ID to forget"),
    },
    async ({ id }) => {
      await provider.forget(id, resolveCurrentOwnerId());
      return `Memory "${id}" forgotten.`;
    },
  );

  tool(
    "list_memories",
    "List all active memories, optionally filtered by space. Returns memories ordered by most recently updated.",
    {
      space_id: z.string().optional().describe("Filter by space. Omit to list all memories."),
    },
    async ({ space_id }) => {
      const memories = await provider.list(space_id);
      if (memories.length === 0) return "No memories stored yet.";
      return memories;
    },
  );
}
