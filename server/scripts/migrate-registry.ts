/**
 * One-time migration: reads server/registry.json and writes rows into userland/oyster.db.
 *
 * Usage: cd server && npx tsx scripts/migrate-registry.ts
 */

import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = join(__dirname, "..");
const PROJECT_ROOT = join(SERVER_ROOT, "..");
const REGISTRY_PATH = join(SERVER_ROOT, "registry.json");
const USERLAND_DIR = process.env.OYSTER_USERLAND || join(PROJECT_ROOT, "userland");
const DB_PATH = join(USERLAND_DIR, "oyster.db");

import { SCHEMA } from "../src/db.js";

// ── Registry types (legacy) ──

interface AppEntry {
  name: string;
  label: string;
  dir: string;
  port: number;
  space: string;
}

interface DocEntry {
  name: string;
  label: string;
  type: string;
  file: string;
  space: string;
}

// ── Main ──

if (!existsSync(REGISTRY_PATH)) {
  console.error(`[migrate] registry.json not found at ${REGISTRY_PATH}`);
  process.exit(1);
}

const raw = readFileSync(REGISTRY_PATH, "utf8");
const registry: { apps: AppEntry[]; docs: DocEntry[] } = JSON.parse(raw);

mkdirSync(USERLAND_DIR, { recursive: true });
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.exec(SCHEMA);

const insert = db.prepare(`
  INSERT OR REPLACE INTO artifacts (id, owner_id, space_id, label, artifact_kind, storage_kind, storage_config, runtime_kind, runtime_config)
  VALUES (@id, @owner_id, @space_id, @label, @artifact_kind, @storage_kind, @storage_config, @runtime_kind, @runtime_config)
`);

const tx = db.transaction(() => {
  for (const app of registry.apps) {
    insert.run({
      id: app.name,
      owner_id: null,
      space_id: app.space,
      label: app.label,
      artifact_kind: "app",
      storage_kind: "filesystem",
      storage_config: JSON.stringify({ path: app.dir }),
      runtime_kind: "local_process",
      runtime_config: JSON.stringify({
        command: "npx vite",
        cwd: app.dir,
        port: app.port,
      }),
    });
    console.log(`  app: ${app.name} (${app.label}) → ${app.space}`);
  }

  for (const doc of registry.docs) {
    insert.run({
      id: doc.name,
      owner_id: null,
      space_id: doc.space,
      label: doc.label,
      artifact_kind: doc.type,
      storage_kind: "filesystem",
      storage_config: JSON.stringify({ path: doc.file }),
      runtime_kind: "static_file",
      runtime_config: "{}",
    });
    console.log(`  doc: ${doc.name} (${doc.label}) → ${doc.space}`);
  }
});

tx();

const count = (db.prepare("SELECT COUNT(*) as n FROM artifacts").get() as { n: number }).n;
console.log(`\n[migrate] imported ${count} artifacts into ${DB_PATH}`);

db.close();
