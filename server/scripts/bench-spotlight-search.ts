/**
 * Manual benchmark for SqliteSessionStore.searchSessions — the query that
 * powers Spotlight's transcript hits. Not a CI gate.
 *
 * Usage: cd server && npx tsx scripts/bench-spotlight-search.ts <query> [limit] [db-path]
 *
 * Examples:
 *   npx tsx scripts/bench-spotlight-search.ts sp                    # limit 50, ~/Oyster/db/oyster.db
 *   npx tsx scripts/bench-spotlight-search.ts test 50 /tmp/snap.db
 */

import Database from "better-sqlite3";
import { homedir } from "node:os";
import { join } from "node:path";
import { SqliteSessionStore } from "../src/session-store.js";

const query = process.argv[2];
// Defaults to 50 to match Spotlight's request limit (web/SpotlightSearch
// TRANSCRIPTS_LIMIT). A numeric second arg overrides; anything else is
// treated as the db path.
const arg3 = process.argv[3];
const arg3IsLimit = arg3 !== undefined && /^\d+$/.test(arg3);
const limit = arg3IsLimit ? Number(arg3) : 50;
const dbPath = arg3IsLimit
  ? (process.argv[4] ?? join(homedir(), "Oyster", "db", "oyster.db"))
  : (arg3 ?? join(homedir(), "Oyster", "db", "oyster.db"));

if (!query) {
  console.error("usage: bench-spotlight-search.ts <query> [limit] [db-path]");
  process.exit(2);
}

const db = new Database(dbPath, { readonly: true, fileMustExist: true });
const store = new SqliteSessionStore(db);

const t0 = performance.now();
const hits = store.searchSessions(query, { limit });
const ms = performance.now() - t0;

console.log(`db: ${dbPath}`);
console.log(`q:  ${JSON.stringify(query)}  limit: ${limit}`);
console.log(`hits: ${hits.length}  time: ${ms.toFixed(1)}ms`);
db.close();
