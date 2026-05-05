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
      unpublished_at       INTEGER,
      pinned_at            INTEGER
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
    pinned_at: number | null;
    removed_at: string | null;
  }> = {},
) {
  const id = fields.id ?? "art_1";
  db.prepare(
    `INSERT INTO artifacts
       (id, space_id, label, artifact_kind, storage_kind, storage_config,
        runtime_kind, runtime_config, share_token, share_mode, published_at,
        share_updated_at, unpublished_at, pinned_at, removed_at)
     VALUES (?, 'home', 'Test artefact', 'notes', 'url', '{}',
             'static_file', '{}', ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    fields.share_token ?? null,
    fields.share_mode ?? null,
    fields.published_at ?? null,
    fields.share_updated_at ?? null,
    fields.unpublished_at ?? null,
    fields.pinned_at ?? null,
    fields.removed_at ?? null,
  );
  return id;
}

describe("artifact wire format — publication", () => {
  let db: Database.Database;
  let service: ArtifactService;

  beforeEach(() => {
    db = makeDb();
    const store = new SqliteArtifactStore(db);
    service = new ArtifactService(store, "https://oyster.to", "https://share.oyster.to");
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
      shareUrl: "https://share.oyster.to/p/Hk3qm9p_ZxN",
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

describe("artifact wire format — cloud-only ghosts", () => {
  let db: Database.Database;
  let service: ArtifactService;

  beforeEach(() => {
    db = makeDb();
    service = new ArtifactService(new SqliteArtifactStore(db), "https://oyster.to", "https://share.oyster.to");
  });

  it("synthesises a cloudOnly ghost using the cloud label, falling back to artifact_id", async () => {
    service.setCloudOnlyPublicationsSource(() => [
      {
        shareToken: "tok_abc",
        artifactId: "missing_locally",
        artifactKind: "notes",
        mode: "open",
        publishedAt: 1717000000000,
        updatedAt: 1717000000500,
        label: "Friendly Label",
        spaceId: null,
      },
      {
        shareToken: "tok_no_label",
        artifactId: "fallback_id",
        artifactKind: "notes",
        mode: "open",
        publishedAt: 1717000001000,
        updatedAt: 1717000001000,
        label: null,
        spaceId: null,
      },
    ]);
    const list = await service.getAllArtifacts(() => {});
    expect(list).toHaveLength(2);
    const labelled = list.find((a) => a.id === "cloud:tok_abc")!;
    expect(labelled.label).toBe("Friendly Label");
    expect(labelled.cloudOnly).toBe(true);
    expect(labelled.spaceId).toBe("_cloud");      // no spaceStore wired in this test
    const fallback = list.find((a) => a.id === "cloud:tok_no_label")!;
    expect(fallback.label).toBe("fallback_id");   // artifact_id when label NULL
  });

  it("does NOT emit a ghost when a local artefact has the matching id", async () => {
    seed(db, { id: "art_local" });
    service.setCloudOnlyPublicationsSource(() => [
      {
        shareToken: "tok",
        artifactId: "art_local",
        artifactKind: "notes",
        mode: "open",
        publishedAt: 1, updatedAt: 1,
        label: null, spaceId: null,
      },
    ]);
    const list = await service.getAllArtifacts(() => {});
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe("art_local");
    expect(list[0]!.cloudOnly).toBeUndefined();
  });

  it("emits no ghosts when the source returns an empty list", async () => {
    service.setCloudOnlyPublicationsSource(() => []);
    const list = await service.getAllArtifacts(() => {});
    expect(list).toHaveLength(0);
  });
});

describe("artifact wire format — pin (#387)", () => {
  let db: Database.Database;
  let service: ArtifactService;

  beforeEach(() => {
    db = makeDb();
    service = new ArtifactService(new SqliteArtifactStore(db), "https://oyster.to", "https://share.oyster.to");
  });

  it("omits pinnedAt when pinned_at is NULL", async () => {
    seed(db);
    const [a] = await service.getAllArtifacts(() => {});
    expect((a as any).pinnedAt).toBeUndefined();
  });

  it("emits pinnedAt when pinned_at is set (static_file path)", async () => {
    // Regression guard: the static_file branch of rowToArtifact dropped
    // pinnedAt in the initial implementation. notes/markdown/html flow
    // through this branch.
    seed(db, { pinned_at: 1717000000000 });
    const [a] = await service.getAllArtifacts(() => {});
    expect((a as any).pinnedAt).toBe(1717000000000);
  });
});

describe("ArtifactService.pinArtifact / unpinArtifact (#387)", () => {
  let db: Database.Database;
  let service: ArtifactService;

  beforeEach(() => {
    db = makeDb();
    service = new ArtifactService(new SqliteArtifactStore(db), "https://oyster.to", "https://share.oyster.to");
  });

  it("pinArtifact stamps pinned_at and returns the timestamp", () => {
    const id = seed(db);
    const before = Date.now();
    const result = service.pinArtifact(id);
    const after = Date.now();
    expect(result.id).toBe(id);
    expect(result.pinnedAt).toBeGreaterThanOrEqual(before);
    expect(result.pinnedAt).toBeLessThanOrEqual(after);
    const row = db.prepare("SELECT pinned_at FROM artifacts WHERE id = ?").get(id) as { pinned_at: number };
    expect(row.pinned_at).toBe(result.pinnedAt);
  });

  it("pinArtifact rejects archived artefacts", () => {
    const id = seed(db, { removed_at: "2026-01-01 00:00:00" });
    expect(() => service.pinArtifact(id)).toThrow(/archived/);
  });

  it("pinArtifact rejects unknown ids", () => {
    expect(() => service.pinArtifact("does-not-exist")).toThrow(/not found/);
  });

  it("re-pinning bumps pinned_at to the current timestamp", async () => {
    const id = seed(db, { pinned_at: 1000 });
    const result = service.pinArtifact(id);
    expect(result.pinnedAt).toBeGreaterThan(1000);
  });

  it("unpinArtifact clears pinned_at", () => {
    const id = seed(db, { pinned_at: 1717000000000 });
    const result = service.unpinArtifact(id);
    expect(result).toEqual({ id, pinnedAt: null });
    const row = db.prepare("SELECT pinned_at FROM artifacts WHERE id = ?").get(id) as { pinned_at: number | null };
    expect(row.pinned_at).toBeNull();
  });

  it("unpinArtifact is idempotent on already-unpinned artefacts", () => {
    const id = seed(db);
    expect(() => service.unpinArtifact(id)).not.toThrow();
    const row = db.prepare("SELECT pinned_at FROM artifacts WHERE id = ?").get(id) as { pinned_at: number | null };
    expect(row.pinned_at).toBeNull();
  });
});
