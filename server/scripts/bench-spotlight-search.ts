/**
 * Manual benchmark for SqliteSessionStore.searchSessions — the query that
 * powers Spotlight's transcript hits. Not a CI gate.
 *
 * Usage: cd server && npx tsx scripts/bench-spotlight-search.ts <query> [db-path]
 *
 * Examples:
 *   npx tsx scripts/bench-spotlight-search.ts sp                 # uses ~/Oyster/db/oyster.db
 *   npx tsx scripts/bench-spotlight-search.ts test /tmp/snap.db
 */

import Database from "better-sqlite3";
import { homedir } from "node:os";
import { join } from "node:path";
import { SqliteSessionStore } from "../src/session-store.js";

const query = process.argv[2];
const dbPath = process.argv[3] ?? join(homedir(), "Oyster", "db", "oyster.db");

if (!query) {
  console.error("usage: bench-spotlight-search.ts <query> [db-path]");
  process.exit(2);
}

const db = new Database(dbPath, { readonly: true, fileMustExist: true });
const store = new SqliteSessionStore(db);

const t0 = performance.now();
const hits = store.searchSessions(query, { limit: 8 });
const ms = performance.now() - t0;

console.log(`db: ${dbPath}`);
console.log(`q:  ${JSON.stringify(query)}  limit: 8`);
console.log(`hits: ${hits.length}  time: ${ms.toFixed(1)}ms`);
db.close();
