import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { ArtifactService } from "../src/artifact-service.js";
import { SqliteArtifactStore } from "../src/artifact-store.js";

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE artifacts (
      id                   TEXT PRIMARY KEY,
      owner_id             TEXT,
      space_id             TEXT NOT NULL,
      label                TEXT NOT NULL,
      artifact_kind        TEXT NOT NULL,
      storage_kind         TEXT NOT NULL DEFAULT 'filesystem',
      storage_config       TEXT NOT NULL DEFAULT '{}',
      runtime_kind         TEXT NOT NULL DEFAULT 'static_file',
      runtime_config       TEXT NOT NULL DEFAULT '{}',
      group_name           TEXT,
      removed_at           TEXT,
      source_origin        TEXT NOT NULL DEFAULT 'manual',
      source_ref           TEXT,
      source_id            TEXT,
      created_at           TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at           TEXT NOT NULL DEFAULT (datetime('now')),
      share_token          TEXT,
      share_mode           TEXT,
      share_password_hash  TEXT,
      published_at         INTEGER,
      share_updated_at     INTEGER,
      unpublished_at       INTEGER
    );
  `);
  return db;
}

function seed(
  db: Database.Database,
  fields: Partial<{
    id: string;
    share_token: string | null;
    share_mode: string | null;
    published_at: number | null;
    share_updated_at: number | null;
    unpublished_at: number | null;
  }> = {},
) {
  const id = fields.id ?? "art_1";
  db.prepare(
    `INSERT INTO artifacts
       (id, space_id, label, artifact_kind, storage_kind, storage_config,
        runtime_kind, runtime_config, share_token, share_mode, published_at,
        share_updated_at, unpublished_at)
     VALUES (?, 'home', 'Test artefact', 'notes', 'url', '{}',
             'static_file', '{}', ?, ?, ?, ?, ?)`,
  ).run(
    id,
    fields.share_token ?? null,
    fields.share_mode ?? null,
    fields.published_at ?? null,
    fields.share_updated_at ?? null,
    fields.unpublished_at ?? null,
  );
  return id;
}

describe("artifact wire format — publication", () => {
  let db: Database.Database;
  let service: ArtifactService;

  beforeEach(() => {
    db = makeDb();
    const store = new SqliteArtifactStore(db);
    service = new ArtifactService(store, "https://oyster.to");
  });

  it("omits the publication field when share_token is NULL", async () => {
    seed(db);
    const [a] = await service.getAllArtifacts(() => {});
    expect((a as any).publication).toBeUndefined();
  });

  it("emits a live publication when share_token is set and unpublished_at is NULL", async () => {
    seed(db, {
      share_token: "Hk3qm9p_ZxN",
      share_mode: "open",
      published_at: 1717000000000,
      share_updated_at: 1717000000000,
    });
    const [a] = await service.getAllArtifacts(() => {});
    expect((a as any).publication).toEqual({
      shareToken: "Hk3qm9p_ZxN",
      shareUrl: "https://oyster.to/p/Hk3qm9p_ZxN",
      shareMode: "open",
      publishedAt: 1717000000000,
      updatedAt: 1717000000000,
      unpublishedAt: null,
    });
  });

  it("emits a retired publication when unpublished_at is set", async () => {
    seed(db, {
      share_token: "Hk3qm9p_ZxN",
      share_mode: "password",
      published_at: 1717000000000,
      share_updated_at: 1717000000500,
      unpublished_at: 1717000005000,
    });
    const [a] = await service.getAllArtifacts(() => {});
    expect((a as any).publication?.unpublishedAt).toBe(1717000005000);
    expect((a as any).publication?.shareMode).toBe("password");
  });
});
