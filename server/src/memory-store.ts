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
  forget(id: string): Promise<void>;
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
  }

  findExact(content: string, spaceId?: string): boolean {
    const sid = spaceId ?? null;
    return !!(this.stmts.findExact.get(content, sid, sid) as MemoryRow | undefined);
  }

  async remember(input: RememberInput): Promise<Memory> {
    const spaceId = input.space_id ?? null;
    const tags = JSON.stringify(input.tags ?? []);
    const sourceSessionId = input.source_session_id ?? null;

    // Conservative dedupe: exact content match in same scope
    const existing = this.stmts.findExact.get(input.content, spaceId, spaceId) as MemoryRow | undefined;
    if (existing) {
      return rowToMemory(existing);
    }

    const id = crypto.randomUUID();
    this.stmts.insert.run(id, spaceId, input.content, tags, sourceSessionId);
    const row = this.stmts.getById.get(id) as MemoryRow;
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

  async forget(id: string): Promise<void> {
    const row = this.stmts.getById.get(id) as MemoryRow | undefined;
    if (!row) return;
    this.stmts.supersede.run("forgotten", id);
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
      await provider.forget(id);
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
