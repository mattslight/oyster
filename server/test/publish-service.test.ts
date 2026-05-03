import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { createPublishService } from "../src/publish-service.js";

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE artifacts (
      id                   TEXT PRIMARY KEY,
      kind                 TEXT NOT NULL,
      owner_id             TEXT,
      created_at           INTEGER NOT NULL,
      updated_at           INTEGER NOT NULL,
      content_path         TEXT,
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

function seedArtifact(db: Database.Database, opts: { id?: string; kind?: string; owner_id?: string | null } = {}) {
  const id = opts.id ?? "art_1";
  const now = Date.now();
  db.prepare(
    `INSERT INTO artifacts (id, kind, owner_id, created_at, updated_at, content_path)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, opts.kind ?? "notes", opts.owner_id ?? null, now, now, "/tmp/fake.md");
  return id;
}

describe("publishArtifact", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("returns 401 when there is no signed-in user", async () => {
    const db = makeDb();
    seedArtifact(db);
    const svc = createPublishService({
      db,
      readArtifactBytes: async () => new Uint8Array([1, 2, 3]),
      currentUser: () => null,
      sessionToken: () => null,
      workerBase: "https://oyster.to",
      hashPassword: async () => "pbkdf2$x",
      fetch: vi.fn(),
    });
    await expect(svc.publishArtifact({ artifact_id: "art_1", mode: "open" }))
      .rejects.toMatchObject({ status: 401, code: "sign_in_required" });
  });

  it("returns 404 when the local artefact does not exist", async () => {
    const db = makeDb();
    const svc = createPublishService({
      db,
      readArtifactBytes: async () => new Uint8Array([1, 2, 3]),
      currentUser: () => ({ id: "u1", email: "a@a" }),
      sessionToken: () => "s1",
      workerBase: "https://oyster.to",
      hashPassword: async () => "pbkdf2$x",
      fetch: vi.fn(),
    });
    await expect(svc.publishArtifact({ artifact_id: "missing", mode: "open" }))
      .rejects.toMatchObject({ status: 404, code: "artifact_not_found" });
  });

  it("returns 403 when caller is not the local artefact owner", async () => {
    const db = makeDb();
    seedArtifact(db, { id: "art_1", owner_id: "other_user" });
    const svc = createPublishService({
      db,
      readArtifactBytes: async () => new Uint8Array([1, 2, 3]),
      currentUser: () => ({ id: "u1", email: "a@a" }),
      sessionToken: () => "s1",
      workerBase: "https://oyster.to",
      hashPassword: async () => "pbkdf2$x",
      fetch: vi.fn(),
    });
    await expect(svc.publishArtifact({ artifact_id: "art_1", mode: "open" }))
      .rejects.toMatchObject({ status: 403, code: "not_artifact_owner" });
  });

  it("happy path: hashes password, posts to worker, mirrors response into local SQLite, sets owner_id", async () => {
    const db = makeDb();
    seedArtifact(db, { id: "art_1", owner_id: null });

    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const headers = new Headers(init.headers);
      expect(headers.get("Cookie")).toBe("oyster_session=s1");
      expect(headers.get("Content-Type")).toBe("application/octet-stream");
      const meta = headers.get("X-Publish-Metadata");
      expect(meta).toBeTruthy();
      const decoded = JSON.parse(Buffer.from(meta!, "base64url").toString());
      expect(decoded.artifact_id).toBe("art_1");
      expect(decoded.mode).toBe("password");
      expect(decoded.password_hash).toBe("pbkdf2$test");
      // Plaintext password must never appear anywhere in the proxied request.
      expect(decoded.password).toBeUndefined();
      const allHeaders = [...new Headers(init.headers).entries()].map(([k, v]) => `${k}=${v}`).join("|");
      expect(allHeaders).not.toContain("hunter2");
      return new Response(JSON.stringify({
        share_token: "tok123",
        share_url: "https://oyster.to/p/tok123",
        mode: "password",
        published_at: 1700000000000,
        updated_at: 1700000005000,
      }), { status: 200, headers: { "content-type": "application/json" } });
    });

    const svc = createPublishService({
      db,
      readArtifactBytes: async () => new Uint8Array([1, 2, 3]),
      currentUser: () => ({ id: "u1", email: "a@a" }),
      sessionToken: () => "s1",
      workerBase: "https://oyster.to",
      hashPassword: async () => "pbkdf2$test",
      fetch: fetchMock as any,
    });

    const out = await svc.publishArtifact({ artifact_id: "art_1", mode: "password", password: "hunter2" });
    expect(out.share_token).toBe("tok123");
    expect(out.share_url).toBe("https://oyster.to/p/tok123");

    const row = db.prepare("SELECT * FROM artifacts WHERE id = 'art_1'").get() as any;
    expect(row.owner_id).toBe("u1");                  // set on first publish
    expect(row.share_token).toBe("tok123");
    expect(row.share_mode).toBe("password");
    expect(row.share_password_hash).toBe("pbkdf2$test");
    expect(row.published_at).toBe(1700000000000);     // from response
    expect(row.share_updated_at).toBe(1700000005000); // from response
    expect(row.unpublished_at).toBeNull();
  });

  it("propagates worker error responses (cap, size, etc.) verbatim", async () => {
    const db = makeDb();
    seedArtifact(db, { id: "art_1", owner_id: "u1" });
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ error: "publish_cap_exceeded", current: 5, limit: 5, message: "cap" }),
      { status: 402, headers: { "content-type": "application/json" } },
    ));
    const svc = createPublishService({
      db,
      readArtifactBytes: async () => new Uint8Array([1]),
      currentUser: () => ({ id: "u1", email: "a@a" }),
      sessionToken: () => "s1",
      workerBase: "https://oyster.to",
      hashPassword: async () => "pbkdf2$x",
      fetch: fetchMock as any,
    });
    await expect(svc.publishArtifact({ artifact_id: "art_1", mode: "open" }))
      .rejects.toMatchObject({ status: 402, code: "publish_cap_exceeded", details: { current: 5, limit: 5 } });
  });
});

describe("unpublishArtifact", () => {
  it("returns 404 publication_not_found when local row has no live share_token", async () => {
    const db = makeDb();
    seedArtifact(db, { id: "art_1", owner_id: "u1" });
    const svc = createPublishService({
      db,
      readArtifactBytes: async () => new Uint8Array(),
      currentUser: () => ({ id: "u1", email: "a@a" }),
      sessionToken: () => "s1",
      workerBase: "https://oyster.to",
      hashPassword: async () => "",
      fetch: vi.fn(),
    });
    await expect(svc.unpublishArtifact({ artifact_id: "art_1" }))
      .rejects.toMatchObject({ status: 404, code: "publication_not_found" });
  });

  it("happy path: posts DELETE, mirrors unpublished_at into local SQLite", async () => {
    const db = makeDb();
    seedArtifact(db, { id: "art_1", owner_id: "u1" });
    db.prepare(`UPDATE artifacts SET share_token='tokABC', share_mode='open', published_at=1, share_updated_at=1 WHERE id='art_1'`).run();

    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("https://oyster.to/api/publish/tokABC");
      expect(init.method).toBe("DELETE");
      return new Response(JSON.stringify({ ok: true, share_token: "tokABC", unpublished_at: 1700000099000 }),
        { status: 200, headers: { "content-type": "application/json" } });
    });

    const svc = createPublishService({
      db,
      readArtifactBytes: async () => new Uint8Array(),
      currentUser: () => ({ id: "u1", email: "a@a" }),
      sessionToken: () => "s1",
      workerBase: "https://oyster.to",
      hashPassword: async () => "",
      fetch: fetchMock as any,
    });

    const out = await svc.unpublishArtifact({ artifact_id: "art_1" });
    expect(out.unpublished_at).toBe(1700000099000);

    const row = db.prepare("SELECT share_token, unpublished_at FROM artifacts WHERE id='art_1'").get() as any;
    expect(row.share_token).toBe("tokABC");           // retained
    expect(row.unpublished_at).toBe(1700000099000);   // mirrored from response
  });
});
