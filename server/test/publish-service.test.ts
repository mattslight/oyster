import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { createPublishService } from "../src/publish-service.js";

// Schema mirrors production (server/src/db.ts SCHEMA + the R5 ALTERs).
// Real columns: artifact_kind (NOT "kind"), storage_kind + storage_config
// (NOT "content_path"). Path lookup goes through ArtifactService.getDocFile
// at runtime; the test fakes that via the readArtifactBytes callback.
function makeDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE artifacts (
      id                   TEXT PRIMARY KEY,
      owner_id             TEXT,
      space_id             TEXT NOT NULL,
      label                TEXT NOT NULL,
      artifact_kind        TEXT NOT NULL,
      storage_kind         TEXT NOT NULL,
      storage_config       TEXT NOT NULL DEFAULT '{}',
      runtime_kind         TEXT NOT NULL,
      runtime_config       TEXT NOT NULL DEFAULT '{}',
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

function seedArtifact(db: Database.Database, opts: { id?: string; artifact_kind?: string; owner_id?: string | null } = {}) {
  const id = opts.id ?? "art_1";
  db.prepare(
    `INSERT INTO artifacts
       (id, owner_id, space_id, label, artifact_kind, storage_kind, storage_config, runtime_kind, runtime_config)
     VALUES (?, ?, 'home', 'test', ?, 'filesystem', '{"path":"/tmp/fake.md"}', 'static_file', '{}')`
  ).run(id, opts.owner_id ?? null, opts.artifact_kind ?? "notes");
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
      currentUser: () => ({ id: "u1", email: "a@a", tier: "free" }),
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
      currentUser: () => ({ id: "u1", email: "a@a", tier: "free" }),
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
      currentUser: () => ({ id: "u1", email: "a@a", tier: "pro" }),
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
      currentUser: () => ({ id: "u1", email: "a@a", tier: "free" }),
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
      currentUser: () => ({ id: "u1", email: "a@a", tier: "free" }),
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
      currentUser: () => ({ id: "u1", email: "a@a", tier: "free" }),
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

  it("is idempotent on already-unpublished — returns stored retirement state without calling Worker", async () => {
    const db = makeDb();
    seedArtifact(db, { id: "art_1", owner_id: "u1" });
    db.prepare(`UPDATE artifacts SET share_token='tokABC', share_mode='open', published_at=1, share_updated_at=1, unpublished_at=1700000099000 WHERE id='art_1'`).run();

    const fetchMock = vi.fn();   // must NOT be called
    const svc = createPublishService({
      db,
      readArtifactBytes: async () => new Uint8Array(),
      currentUser: () => ({ id: "u1", email: "a@a", tier: "free" }),
      sessionToken: () => "s1",
      workerBase: "https://oyster.to",
      hashPassword: async () => "",
      fetch: fetchMock as any,
    });

    const out = await svc.unpublishArtifact({ artifact_id: "art_1" });
    expect(out).toEqual({ ok: true, share_token: "tokABC", unpublished_at: 1700000099000 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("publishArtifact additional coverage", () => {
  it("preserves owner_id on second publish by the same user", async () => {
    const db = makeDb();
    seedArtifact(db, { id: "art_1", owner_id: "u1" });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      share_token: "tok123", share_url: "https://oyster.to/p/tok123",
      mode: "open", published_at: 1, updated_at: 1,
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const svc = createPublishService({
      db,
      readArtifactBytes: async () => new Uint8Array([1]),
      currentUser: () => ({ id: "u1", email: "a@a", tier: "free" }),
      sessionToken: () => "s1",
      workerBase: "https://oyster.to",
      hashPassword: async () => "pbkdf2$x",
      fetch: fetchMock as any,
    });
    await svc.publishArtifact({ artifact_id: "art_1", mode: "open" });
    const row = db.prepare("SELECT owner_id FROM artifacts WHERE id='art_1'").get() as any;
    expect(row.owner_id).toBe("u1");   // unchanged
  });

  it("rejects 413 locally when bytes exceed 10 MB without contacting Worker", async () => {
    const db = makeDb();
    seedArtifact(db, { id: "art_big", owner_id: "u1" });
    const fetchMock = vi.fn();
    const svc = createPublishService({
      db,
      readArtifactBytes: async () => new Uint8Array(11 * 1024 * 1024),
      currentUser: () => ({ id: "u1", email: "a@a", tier: "free" }),
      sessionToken: () => "s1",
      workerBase: "https://oyster.to",
      hashPassword: async () => "pbkdf2$x",
      fetch: fetchMock as any,
    });
    await expect(svc.publishArtifact({ artifact_id: "art_big", mode: "open" }))
      .rejects.toMatchObject({ status: 413, code: "artifact_too_large", details: { limit_bytes: 10 * 1024 * 1024 } });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("publishArtifact tier mode gating", () => {
  it("rejects free-tier password publish locally with 402 pro_required and never contacts the Worker", async () => {
    const db = makeDb();
    seedArtifact(db, { id: "art_1", owner_id: "u1" });
    const fetchMock = vi.fn();
    const svc = createPublishService({
      db,
      readArtifactBytes: async () => new Uint8Array([1, 2]),
      currentUser: () => ({ id: "u1", email: "a@a", tier: "free" }),
      sessionToken: () => "s1",
      workerBase: "https://oyster.to",
      hashPassword: async () => "pbkdf2$x",
      fetch: fetchMock as any,
    });
    await expect(svc.publishArtifact({ artifact_id: "art_1", mode: "password", password: "hunter2" }))
      .rejects.toMatchObject({ status: 402, code: "pro_required", details: { required_tier: "pro", mode: "password" } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allows pro-tier password publish through to the Worker", async () => {
    const db = makeDb();
    seedArtifact(db, { id: "art_1", owner_id: "u1" });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      share_token: "tok", share_url: "https://oyster.to/p/tok",
      mode: "password", published_at: 1, updated_at: 1,
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const svc = createPublishService({
      db,
      readArtifactBytes: async () => new Uint8Array([1]),
      currentUser: () => ({ id: "u1", email: "a@a", tier: "pro" }),
      sessionToken: () => "s1",
      workerBase: "https://oyster.to",
      hashPassword: async () => "pbkdf2$x",
      fetch: fetchMock as any,
    });
    await svc.publishArtifact({ artifact_id: "art_1", mode: "password", password: "hunter2" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("updateShareByToken", () => {
  it("rejects free-tier switch to password mode locally with 402 pro_required", async () => {
    const db = makeDb();
    const fetchMock = vi.fn();
    const svc = createPublishService({
      db,
      readArtifactBytes: async () => new Uint8Array(),
      currentUser: () => ({ id: "u1", email: "a@a", tier: "free" }),
      sessionToken: () => "s1",
      workerBase: "https://oyster.to",
      hashPassword: async () => "pbkdf2$x",
      fetch: fetchMock as any,
    });
    await expect(svc.updateShareByToken({ share_token: "tok", mode: "password", password: "p" }))
      .rejects.toMatchObject({ status: 402, code: "pro_required" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts PATCH to the worker with hashed password when mode=password", async () => {
    const db = makeDb();
    seedArtifact(db, { id: "art_local", owner_id: "u1" });
    db.prepare(`UPDATE artifacts SET share_token='tokABC', share_mode='open' WHERE id='art_local'`).run();

    let captured: { url?: string; method?: string; body?: any } = {};
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      captured = { url, method: init.method, body: JSON.parse(init.body as string) };
      return new Response(JSON.stringify({
        share_token: "tokABC",
        share_url: "https://oyster.to/p/tokABC",
        mode: "password",
        updated_at: 9999,
      }), { status: 200, headers: { "content-type": "application/json" } });
    });

    const svc = createPublishService({
      db,
      readArtifactBytes: async () => new Uint8Array(),
      currentUser: () => ({ id: "u1", email: "a@a", tier: "pro" }),
      sessionToken: () => "s1",
      workerBase: "https://oyster.to",
      hashPassword: async (p) => `pbkdf2$${p}`,
      fetch: fetchMock as any,
    });

    const out = await svc.updateShareByToken({ share_token: "tokABC", mode: "password", password: "hunter2" });
    expect(out.mode).toBe("password");
    expect(captured.url).toBe("https://oyster.to/api/publish/tokABC");
    expect(captured.method).toBe("PATCH");
    expect(captured.body.mode).toBe("password");
    expect(captured.body.password_hash).toBe("pbkdf2$hunter2");
    // Plaintext password must never appear in the proxied body.
    expect(captured.body.password).toBeUndefined();

    // Local row should be mirrored to match new mode + hash.
    const row = db.prepare("SELECT share_mode, share_password_hash, share_updated_at FROM artifacts WHERE id='art_local'").get() as any;
    expect(row.share_mode).toBe("password");
    expect(row.share_password_hash).toBe("pbkdf2$hunter2");
    expect(row.share_updated_at).toBe(9999);
  });

  it("clears local password_hash when switching to open mode", async () => {
    const db = makeDb();
    seedArtifact(db, { id: "art_local", owner_id: "u1" });
    db.prepare(`UPDATE artifacts SET share_token='tokA', share_mode='password', share_password_hash='pbkdf2$old' WHERE id='art_local'`).run();

    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      share_token: "tokA", share_url: "https://oyster.to/p/tokA",
      mode: "open", updated_at: 1,
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const svc = createPublishService({
      db,
      readArtifactBytes: async () => new Uint8Array(),
      currentUser: () => ({ id: "u1", email: "a@a", tier: "pro" }),
      sessionToken: () => "s1",
      workerBase: "https://oyster.to",
      hashPassword: async () => "pbkdf2$x",
      fetch: fetchMock as any,
    });
    await svc.updateShareByToken({ share_token: "tokA", mode: "open" });
    const row = db.prepare("SELECT share_mode, share_password_hash FROM artifacts WHERE id='art_local'").get() as any;
    expect(row.share_mode).toBe("open");
    expect(row.share_password_hash).toBeNull();
  });
});

describe("unpublishByShareToken", () => {
  it("returns 401 when signed out", async () => {
    const db = makeDb();
    const svc = createPublishService({
      db,
      readArtifactBytes: async () => new Uint8Array(),
      currentUser: () => null,
      sessionToken: () => null,
      workerBase: "https://oyster.to",
      hashPassword: async () => "",
      fetch: vi.fn() as any,
    });
    await expect(svc.unpublishByShareToken("tok")).rejects.toMatchObject({ status: 401 });
  });

  it("posts DELETE to the worker keyed by share_token, no local row required", async () => {
    const db = makeDb();
    let captured: { url?: string; method?: string } = {};
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      captured = { url, method: init.method };
      return new Response(JSON.stringify({ ok: true, share_token: "tok", unpublished_at: 5 }),
        { status: 200, headers: { "content-type": "application/json" } });
    });
    const svc = createPublishService({
      db,
      readArtifactBytes: async () => new Uint8Array(),
      currentUser: () => ({ id: "u1", email: "a@a", tier: "free" }),
      sessionToken: () => "s1",
      workerBase: "https://oyster.to",
      hashPassword: async () => "",
      fetch: fetchMock as any,
    });
    const out = await svc.unpublishByShareToken("tok");
    expect(out.unpublished_at).toBe(5);
    expect(captured.url).toBe("https://oyster.to/api/publish/tok");
    expect(captured.method).toBe("DELETE");
  });
});

describe("backfillPublications", () => {
  it("returns {0,0} and does nothing when signed-out", async () => {
    const db = makeDb();
    const fetchMock = vi.fn();
    const svc = createPublishService({
      db,
      readArtifactBytes: async () => new Uint8Array(),
      currentUser: () => null,
      sessionToken: () => null,
      workerBase: "https://oyster.to",
      hashPassword: async () => "",
      fetch: fetchMock as any,
    });
    expect(await svc.backfillPublications()).toEqual({ mirrored: 0, skipped: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("mirrors live publications onto matching local rows; skips rows missing locally", async () => {
    const db = makeDb();
    seedArtifact(db, { id: "art_present", owner_id: null });

    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("https://oyster.to/api/publish/mine");
      expect(new Headers(init.headers).get("Cookie")).toBe("oyster_session=s1");
      return new Response(JSON.stringify({
        publications: [
          { share_token: "tok_present", artifact_id: "art_present", artifact_kind: "notes",
            mode: "open", content_type: "text/plain", size_bytes: 10,
            published_at: 1700000000000, updated_at: 1700000005000,
            label: "Test artefact", space_id: "home" },
          { share_token: "tok_missing", artifact_id: "art_missing", artifact_kind: "notes",
            mode: "open", content_type: "text/plain", size_bytes: 10,
            published_at: 1700000000000, updated_at: 1700000005000,
            label: "Missing locally", space_id: "client-projects" },
        ],
      }), { status: 200, headers: { "content-type": "application/json" } });
    });

    const svc = createPublishService({
      db,
      readArtifactBytes: async () => new Uint8Array(),
      currentUser: () => ({ id: "u1", email: "a@a", tier: "free" }),
      sessionToken: () => "s1",
      workerBase: "https://oyster.to",
      hashPassword: async () => "",
      fetch: fetchMock as any,
    });

    const out = await svc.backfillPublications();
    expect(out).toEqual({ mirrored: 1, skipped: 1 });

    const row = db.prepare("SELECT * FROM artifacts WHERE id='art_present'").get() as any;
    expect(row.share_token).toBe("tok_present");
    expect(row.share_mode).toBe("open");
    expect(row.published_at).toBe(1700000000000);
    expect(row.share_updated_at).toBe(1700000005000);
    expect(row.unpublished_at).toBeNull();
    expect(row.owner_id).toBe("u1");          // backfilled (was null)
  });

  it("preserves a non-null owner_id (COALESCE), never overwriting a real owner", async () => {
    const db = makeDb();
    seedArtifact(db, { id: "art_present", owner_id: "u_pre_existing" });

    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      publications: [{
        share_token: "tok", artifact_id: "art_present", artifact_kind: "notes",
        mode: "open", content_type: "text/plain", size_bytes: 10,
        published_at: 1, updated_at: 1,
        label: null, space_id: null,
      }],
    }), { status: 200, headers: { "content-type": "application/json" } }));

    const svc = createPublishService({
      db,
      readArtifactBytes: async () => new Uint8Array(),
      currentUser: () => ({ id: "u1", email: "a@a", tier: "free" }),
      sessionToken: () => "s1",
      workerBase: "https://oyster.to",
      hashPassword: async () => "",
      fetch: fetchMock as any,
    });
    await svc.backfillPublications();

    const row = db.prepare("SELECT owner_id FROM artifacts WHERE id='art_present'").get() as any;
    expect(row.owner_id).toBe("u_pre_existing");
  });

  it("returns {0,0} and leaves DB alone when Worker is unreachable", async () => {
    const db = makeDb();
    seedArtifact(db, { id: "art_present", owner_id: null });
    const fetchMock = vi.fn(async () => { throw new Error("network down"); });

    const svc = createPublishService({
      db,
      readArtifactBytes: async () => new Uint8Array(),
      currentUser: () => ({ id: "u1", email: "a@a", tier: "free" }),
      sessionToken: () => "s1",
      workerBase: "https://oyster.to",
      hashPassword: async () => "",
      fetch: fetchMock as any,
    });
    expect(await svc.backfillPublications()).toEqual({ mirrored: 0, skipped: 0 });
    const row = db.prepare("SELECT share_token FROM artifacts WHERE id='art_present'").get() as any;
    expect(row.share_token).toBeNull();
  });
});
