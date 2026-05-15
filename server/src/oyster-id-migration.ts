// Boot data migration: backfill sources.portable_id for rows that have
// no value yet. Runs once per boot after schema migrations; idempotent
// (any row whose portable_id is already populated is skipped).
//
// Never mutates sources.id; never touches sessions or artefacts.
// See docs/superpowers/specs/2026-05-15-oyster-id-portable-identity-design.md

import { existsSync } from "node:fs";
import type Database from "better-sqlite3";
import { readOysterId, writeOysterId } from "./oyster-id.js";

interface SourceRow {
  id: string;
  path: string;
}

export function backfillPortableIds(db: Database.Database): void {
  const rows = db
    .prepare("SELECT id, path FROM sources WHERE portable_id IS NULL AND removed_at IS NULL")
    .all() as SourceRow[];
  if (rows.length === 0) return;

  const update = db.prepare("UPDATE sources SET portable_id = ? WHERE id = ?");
  let updated = 0;
  let skipped = 0;

  for (const row of rows) {
    if (!existsSync(row.path)) {
      skipped++;
      continue; // #490 advisory case; will populate after the user runs "Update folder location…"
    }
    const result = readOysterId(row.path);
    switch (result.status) {
      case "valid":
        update.run(result.id, row.id);
        updated++;
        break;
      case "missing": {
        const newId = crypto.randomUUID();
        try {
          writeOysterId(row.path, newId);
          update.run(newId, row.id);
          updated++;
        } catch (err) {
          console.warn(`[oyster-id migration] write failed for ${row.path}; portable_id stays NULL`, err);
          skipped++;
        }
        break;
      }
      case "malformed":
      case "unreadable":
      case "blocked":
        console.warn(`[oyster-id migration] skipping ${row.path} (${result.status}) — leaving portable_id NULL`);
        skipped++;
        break;
    }
  }
  if (updated > 0 || skipped > 0) {
    console.log(`[oyster-id migration] portable_id backfill: ${updated} updated, ${skipped} skipped`);
  }
}
