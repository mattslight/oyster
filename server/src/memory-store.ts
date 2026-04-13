import Database from "better-sqlite3";
import crypto from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

// ── Contract ──────────────────────────────────────────────────

export interface Memory {
  id: string;
  content: string;
  space_id: string | null;
  tags: string[];
  created_at: string;
}

export interface RememberInput {
  content: string;
  space_id?: string;
  tags?: string[];
}

export interface RecallInput {
  query: string;
  space_id?: string;
  limit?: number;
}

export interface MemoryProvider {
  init(): Promise<void>;
  remember(input: RememberInput): Promise<Memory>;
  recall(input: RecallInput): Promise<Memory[]>;
  forget(id: string): Promise<void>;
  list(space_id?: string): Promise<Memory[]>;
  exportMemories(): Promise<Memory[]>;
  importMemories(memories: Memory[]): Promise<void>;
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
}

function rowToMemory(row: MemoryRow): Memory {
  return {
    id: row.id,
    content: row.content,
    space_id: row.space_id,
    tags: JSON.parse(row.tags),
    created_at: row.created_at,
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
  };
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
        `INSERT INTO memories (id, space_id, content, tags, created_at, updated_at)
         VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))`,
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
    };
  }

  async remember(input: RememberInput): Promise<Memory> {
    const spaceId = input.space_id ?? null;
    const tags = JSON.stringify(input.tags ?? []);

    // Conservative dedupe: exact content match in same scope
    const existing = this.stmts.findExact.get(input.content, spaceId, spaceId) as MemoryRow | undefined;
    if (existing) {
      return rowToMemory(existing);
    }

    const id = crypto.randomUUID();
    this.stmts.insert.run(id, spaceId, input.content, tags);
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

    // Increment access counts
    for (const row of rows) {
      this.stmts.incrementAccess.run(row.id);
    }

    return rows.map(rowToMemory);
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
      `INSERT OR IGNORE INTO memories (id, space_id, content, tags, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))`,
    );
    const tx = this.db.transaction((items: Memory[]) => {
      for (const m of items) {
        insertOrIgnore.run(m.id, m.space_id, m.content, JSON.stringify(m.tags), m.created_at);
      }
    });
    tx(memories);
  }

  close(): void {
    this.db?.close();
  }
}

// ── MCP tool registration ─────────────────────────────────────

export function registerMemoryTools(server: McpServer, provider: MemoryProvider): void {
  server.tool(
    "remember",
    "Store a memory for future sessions. Use when the user says 'remember this', shares a preference, or makes a decision worth preserving. Do not auto-remember — only store when explicitly asked or when the fact is clearly durable.",
    {
      content: z.string().describe("The memory content — freeform text describing what to remember"),
      space_id: z.string().optional().describe("Scope to a space (e.g. 'tokinvest'). Omit for global memory."),
      tags: z.array(z.string()).optional().describe("Categorisation tags (e.g. ['preference'], ['decision', 'project:tokinvest'])"),
    },
    async ({ content, space_id, tags }) => {
      try {
        const memory = await provider.remember({ content, space_id, tags });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(memory, null, 2) }],
        };
      } catch (err) {
        return { content: [{ type: "text" as const, text: (err as Error).message }], isError: true };
      }
    },
  );

  server.tool(
    "recall",
    "Search memories by natural language query. Returns ranked matches from this space and global memories. Use at session start to load relevant context, or when the user asks what you remember.",
    {
      query: z.string().describe("Natural language search query"),
      space_id: z.string().optional().describe("Scope search to a space plus global memories. Omit to search everything."),
      limit: z.number().int().min(1).max(50).optional().describe("Max results (default 10)"),
    },
    async ({ query, space_id, limit }) => {
      try {
        const memories = await provider.recall({ query, space_id, limit });
        if (memories.length === 0) {
          return { content: [{ type: "text" as const, text: "No memories found." }] };
        }
        return {
          content: [{ type: "text" as const, text: JSON.stringify(memories, null, 2) }],
        };
      } catch (err) {
        return { content: [{ type: "text" as const, text: (err as Error).message }], isError: true };
      }
    },
  );

  server.tool(
    "forget",
    "Remove a memory from active recall by ID. The user will no longer see this memory in searches or lists.",
    {
      id: z.string().describe("Memory ID to forget"),
    },
    async ({ id }) => {
      try {
        await provider.forget(id);
        return { content: [{ type: "text" as const, text: `Memory "${id}" forgotten.` }] };
      } catch (err) {
        return { content: [{ type: "text" as const, text: (err as Error).message }], isError: true };
      }
    },
  );

  server.tool(
    "list_memories",
    "List all active memories, optionally filtered by space. Returns memories ordered by most recently updated.",
    {
      space_id: z.string().optional().describe("Filter by space. Omit to list all memories."),
    },
    async ({ space_id }) => {
      try {
        const memories = await provider.list(space_id);
        if (memories.length === 0) {
          return { content: [{ type: "text" as const, text: "No memories stored yet." }] };
        }
        return {
          content: [{ type: "text" as const, text: JSON.stringify(memories, null, 2) }],
        };
      } catch (err) {
        return { content: [{ type: "text" as const, text: (err as Error).message }], isError: true };
      }
    },
  );
}
