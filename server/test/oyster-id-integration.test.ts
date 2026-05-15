// Integration tests for the .oyster/id portable identity feature.
// Covers tests 1–10 from
// docs/superpowers/specs/2026-05-15-oyster-id-portable-identity-design.md

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync, mkdirSync, rmSync, realpathSync, writeFileSync, existsSync, readFileSync, chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb } from "../src/db.js";
import { SqliteSessionStore } from "../src/session-store.js";
import { SqliteSpaceStore } from "../src/space-store.js";
import { SpaceService } from "../src/space-service.js";
import { SqliteArtifactStore } from "../src/artifact-store.js";
import { ArtifactService } from "../src/artifact-service.js";
import { backfillPortableIds } from "../src/oyster-id-migration.js";
import { isValidUuid } from "../src/oyster-id.js";
import type Database from "better-sqlite3";

// ---------------------------------------------------------------------------
// Shared test harness — mirrors the shape from space-service-binding.test.ts
// ---------------------------------------------------------------------------

function makeEnv() {
  // Canonicalise the tmp dir (macOS tmpdir() returns a symlinked /var/... path;
  // real cwds from process.cwd() are already canonical).
  const workDir = realpathSync(mkdtempSync(join(tmpdir(), "oyster-id-integ-")));
  const db = initDb(workDir);
  const spaceStore = new SqliteSpaceStore(db);
  const sessionStore = new SqliteSessionStore(db);
  const artifactStore = new SqliteArtifactStore(db);
  const artifactService = new ArtifactService(
    artifactStore,
    { spacesDir: join(workDir, "spaces"), appsDir: join(workDir, "apps") } as any,
    { broadcast: () => {} } as any,
  );
  const service = new SpaceService(spaceStore, artifactStore, artifactService, sessionStore);

  // The "home" space is used by most tests. It is NOT auto-created by initDb;
  // we seed it once here using createSpace (slugifies "home" → "home").
  const home = service.createSpace({ name: "home" });

  // Track any read-only dirs so afterEach can restore permissions before rmSync.
  const readOnlyDirs: string[] = [];

  return {
    workDir,
    db,
    spaceStore,
    sessionStore,
    artifactStore,
    service,
    home,
    readOnlyDirs,
    cleanup() {
      // Restore permissions on read-only dirs first so rmSync can delete them.
      for (const d of readOnlyDirs) {
        try { chmodSync(d, 0o755); } catch { /* best-effort */ }
      }
      db.close();
      rmSync(workDir, { recursive: true, force: true });
    },
  };
}

// ---------------------------------------------------------------------------
// Helper: seed a session row directly into the DB (mirrors binding test file)
// ---------------------------------------------------------------------------

function seedSession(
  db: Database.Database,
  fields: {
    id: string;
    cwd?: string | null;
    source_id?: string | null;
    space_id?: string | null;
  },
) {
  db.prepare(
    `INSERT INTO sessions
       (id, space_id, source_id, cwd, agent, title, state,
        started_at, last_event_at, assignment_mode)
     VALUES (?, ?, ?, ?, 'claude-code', 't', 'done',
             '2026-05-15T10:00:00Z', '2026-05-15T10:30:00Z', 'auto')`,
  ).run(
    fields.id,
    fields.space_id ?? null,
    fields.source_id ?? null,
    fields.cwd ?? null,
  );
}

// ---------------------------------------------------------------------------
// Test 1: attach with no .oyster/id
// ---------------------------------------------------------------------------

describe("Test 1 — attach with no .oyster/id", () => {
  let env: ReturnType<typeof makeEnv>;
  beforeEach(() => { env = makeEnv(); });
  afterEach(() => { env.cleanup(); });

  it("creates .oyster/id, stores valid UUID as portable_id; sources.id and portable_id are independent UUIDs", () => {
    const repo = join(env.workDir, "repo");
    mkdirSync(repo);

    const source = env.service.addSource(env.home.id, repo);

    // portable_id must be a valid UUID.
    expect(isValidUuid(source.portable_id)).toBe(true);

    // .oyster/id file must have been written.
    const idFile = join(repo, ".oyster", "id");
    expect(existsSync(idFile)).toBe(true);

    // File contents (trimmed) must match the stored portable_id.
    const fileContents = readFileSync(idFile, "utf8").trim();
    expect(fileContents).toBe(source.portable_id);

    // sources.id and sources.portable_id are independently generated UUIDs.
    expect(source.id).not.toBe(source.portable_id);
    expect(isValidUuid(source.id)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Test 2: attach with existing .oyster/id
// ---------------------------------------------------------------------------

describe("Test 2 — attach with existing .oyster/id", () => {
  let env: ReturnType<typeof makeEnv>;
  beforeEach(() => { env = makeEnv(); });
  afterEach(() => { env.cleanup(); });

  it("honours the pre-existing UUID; does not overwrite the file", () => {
    const repo = join(env.workDir, "repo2");
    mkdirSync(repo);
    const existingId = "aaaabbbb-cccc-dddd-eeee-ffffffffffff";
    mkdirSync(join(repo, ".oyster"));
    writeFileSync(join(repo, ".oyster", "id"), existingId + "\n", "utf8");

    const source = env.service.addSource(env.home.id, repo);

    // portable_id must equal the pre-existing UUID.
    expect(source.portable_id).toBe(existingId);

    // File must be unchanged (still the exact content we wrote).
    const fileContents = readFileSync(join(repo, ".oyster", "id"), "utf8").trim();
    expect(fileContents).toBe(existingId);
  });
});

// ---------------------------------------------------------------------------
// Test 3: two sources, same portable_id (worktree / clone case)
// ---------------------------------------------------------------------------

describe("Test 3 — two separate dirs with the same .oyster/id (worktree case)", () => {
  let env: ReturnType<typeof makeEnv>;
  beforeEach(() => { env = makeEnv(); });
  afterEach(() => { env.cleanup(); });

  it("stores the same portable_id for both sources; sources.id values differ", () => {
    const sharedId = "11112222-3333-4444-5555-666677778888";

    const repo1 = join(env.workDir, "repo1");
    const repo2 = join(env.workDir, "repo2");
    mkdirSync(repo1);
    mkdirSync(repo2);

    // Both physical dirs have the SAME .oyster/id value.
    mkdirSync(join(repo1, ".oyster"));
    writeFileSync(join(repo1, ".oyster", "id"), sharedId + "\n", "utf8");
    mkdirSync(join(repo2, ".oyster"));
    writeFileSync(join(repo2, ".oyster", "id"), sharedId + "\n", "utf8");

    const sp = env.service.createSpace({ name: "worktrees" });
    const src1 = env.service.addSource(sp.id, repo1);
    const src2 = env.service.addSource(sp.id, repo2);

    // Both rows share the same portable_id.
    expect(src1.portable_id).toBe(sharedId);
    expect(src2.portable_id).toBe(sharedId);

    // But their sources.id values are distinct.
    expect(src1.id).not.toBe(src2.id);

    // Confirm at the SQL level that exactly 2 rows share this portable_id.
    const rows = env.db
      .prepare("SELECT id FROM sources WHERE portable_id = ? AND removed_at IS NULL")
      .all(sharedId) as { id: string }[];
    expect(rows).toHaveLength(2);
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(src1.id);
    expect(ids).toContain(src2.id);
  });
});

// ---------------------------------------------------------------------------
// Test 4: scan updates portable_id when .oyster/id file changes
// ---------------------------------------------------------------------------

describe("Test 4 — scanSpace reconciles portable_id when the file changes", () => {
  let env: ReturnType<typeof makeEnv>;
  beforeEach(() => { env = makeEnv(); });
  afterEach(() => { env.cleanup(); });

  it("updates sources.portable_id to the new UUID; sources.id is unchanged", async () => {
    const repo = join(env.workDir, "repo4");
    mkdirSync(repo);
    // Write a README so the scan has something to process.
    writeFileSync(join(repo, "README.md"), "# repo4\n");

    const source = env.service.addSource(env.home.id, repo);
    const originalSourceId = source.id;
    const originalPortableId = source.portable_id;
    expect(isValidUuid(originalPortableId)).toBe(true);

    // Externally rewrite .oyster/id to a different valid UUID.
    const newPortableId = "deadbeef-dead-beef-dead-beefdeadbeef";
    writeFileSync(join(repo, ".oyster", "id"), newPortableId + "\n", "utf8");

    // Run scanSpace — reconcilePortableId fires per-source.
    await env.service.scanSpace(env.home.id);

    // Fetch the updated row.
    const updated = env.spaceStore.getSourceById(source.id);
    expect(updated?.portable_id).toBe(newPortableId);
    expect(updated?.portable_id).not.toBe(originalPortableId);

    // sources.id must be unchanged.
    expect(updated?.id).toBe(originalSourceId);
  });
});

// ---------------------------------------------------------------------------
// Test 5: malformed .oyster/id
// ---------------------------------------------------------------------------

describe("Test 5 — malformed .oyster/id", () => {
  let env: ReturnType<typeof makeEnv>;
  beforeEach(() => { env = makeEnv(); });
  afterEach(() => { env.cleanup(); });

  it("leaves portable_id NULL and does NOT overwrite the malformed file", () => {
    const repo = join(env.workDir, "repo5");
    mkdirSync(repo);
    const garbage = "not-a-uuid-at-all";
    mkdirSync(join(repo, ".oyster"));
    writeFileSync(join(repo, ".oyster", "id"), garbage, "utf8");

    const source = env.service.addSource(env.home.id, repo);

    expect(source.portable_id).toBeNull();

    // File must be preserved as-is (not overwritten).
    const fileContents = readFileSync(join(repo, ".oyster", "id"), "utf8");
    expect(fileContents).toBe(garbage);
  });
});

// ---------------------------------------------------------------------------
// Test 6: sessions / artefacts stay bound to sources.id
// ---------------------------------------------------------------------------

describe("Test 6 — sessions/artefacts stay bound to sources.id across portable_id changes", () => {
  let env: ReturnType<typeof makeEnv>;
  beforeEach(() => { env = makeEnv(); });
  afterEach(() => { env.cleanup(); });

  it("sources.id and sessions.source_id remain unchanged after file rewrite + scan + migration", async () => {
    const repo = join(env.workDir, "repo6");
    mkdirSync(repo);
    writeFileSync(join(repo, "README.md"), "# repo6\n");

    const source = env.service.addSource(env.home.id, repo);
    const stableSourceId = source.id;

    // Seed a session pointing at this source.
    seedSession(env.db, {
      id: "sess-6",
      cwd: repo,
      source_id: source.id,
      space_id: env.home.id,
    });

    // Externally rewrite .oyster/id to a new value.
    const newPortableId = "cafecafe-cafe-cafe-cafe-cafecafecafe";
    writeFileSync(join(repo, ".oyster", "id"), newPortableId + "\n", "utf8");

    // Trigger all portable_id code paths.
    await env.service.scanSpace(env.home.id);
    backfillPortableIds(env.db);

    // sources.id must be unchanged.
    const updatedSource = env.spaceStore.getSourceById(stableSourceId);
    expect(updatedSource?.id).toBe(stableSourceId);
    expect(updatedSource?.portable_id).toBe(newPortableId);

    // sessions.source_id must still point at the original sources.id.
    const session = env.sessionStore.getById("sess-6");
    expect(session?.source_id).toBe(stableSourceId);
  });
});

// ---------------------------------------------------------------------------
// Test 7: migration never mutates sources.id; idempotent
// ---------------------------------------------------------------------------

describe("Test 7 — backfillPortableIds: idempotent; never mutates sources.id", () => {
  let env: ReturnType<typeof makeEnv>;
  beforeEach(() => { env = makeEnv(); });
  afterEach(() => { env.cleanup(); });

  it("first run populates portable_id; second run is a no-op; sources.id unchanged", () => {
    // Create a physical directory (migration only processes existsSync paths).
    const repo = join(env.workDir, "repo7");
    mkdirSync(repo);

    // Manually INSERT a sources row with portable_id = NULL, bypassing SpaceService.
    const fixedId = "bbbbbbbb-cccc-dddd-eeee-ffffffffffff";
    env.db.prepare(
      `INSERT INTO sources (id, space_id, type, path, label, portable_id, added_at)
       VALUES (?, ?, 'local_folder', ?, NULL, NULL, datetime('now'))`,
    ).run(fixedId, env.home.id, repo);

    // First run: should populate portable_id (writes .oyster/id and sets the column).
    backfillPortableIds(env.db);

    const afterFirst = env.db
      .prepare("SELECT id, portable_id FROM sources WHERE id = ?")
      .get(fixedId) as { id: string; portable_id: string | null };

    expect(afterFirst.id).toBe(fixedId);
    expect(isValidUuid(afterFirst.portable_id)).toBe(true);
    const portableAfterFirst = afterFirst.portable_id!;

    // Second run: must be a no-op (portable_id unchanged).
    backfillPortableIds(env.db);

    const afterSecond = env.db
      .prepare("SELECT id, portable_id FROM sources WHERE id = ?")
      .get(fixedId) as { id: string; portable_id: string | null };

    expect(afterSecond.id).toBe(fixedId);
    expect(afterSecond.portable_id).toBe(portableAfterFirst);
  });
});

// ---------------------------------------------------------------------------
// Test 8: addSource to a non-existent path (#490 advisory case)
// ---------------------------------------------------------------------------

describe("Test 8 — addSource to a non-existent path (#490 advisory case)", () => {
  let env: ReturnType<typeof makeEnv>;
  beforeEach(() => { env = makeEnv(); });
  afterEach(() => { env.cleanup(); });

  it("inserts row with portable_id = NULL; no .oyster/ created; scan populates portable_id once dir exists", async () => {
    const missing = join(env.workDir, "not-on-disk-yet");

    // addSource must succeed even though the path doesn't exist.
    const source = env.service.addSource(env.home.id, missing);
    expect(source.path).toBe(missing);
    expect(source.portable_id).toBeNull();

    // No .oyster/ directory should have been created.
    expect(existsSync(join(missing, ".oyster"))).toBe(false);
    expect(existsSync(missing)).toBe(false);

    // Now create the directory and add a file so scanSpace has something to do.
    mkdirSync(missing);
    writeFileSync(join(missing, "README.md"), "# now exists\n");

    // scanSpace should reconcile portable_id.
    await env.service.scanSpace(env.home.id);

    const updated = env.spaceStore.getSourceById(source.id);
    expect(isValidUuid(updated?.portable_id)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Test 9: addSource writes the row exactly once (read-only FS case)
// ---------------------------------------------------------------------------

describe("Test 9 — addSource on a read-only FS writes exactly one row", () => {
  let env: ReturnType<typeof makeEnv>;
  beforeEach(() => { env = makeEnv(); });
  afterEach(() => { env.cleanup(); });

  it("inserts exactly one sources row with portable_id = NULL; no corrective UPDATE", () => {
    const repo = join(env.workDir, "repo9");
    mkdirSync(repo);

    // Make the directory read-only so writeOysterId throws.
    chmodSync(repo, 0o555);
    env.readOnlyDirs.push(repo);

    const source = env.service.addSource(env.home.id, repo);

    // Row was inserted.
    expect(source.path).toBe(repo);
    // Write failed → portable_id must be NULL.
    expect(source.portable_id).toBeNull();

    // Query the DB directly: exactly one row for this path.
    const rows = env.db
      .prepare("SELECT id, portable_id FROM sources WHERE path = ?")
      .all(repo) as { id: string; portable_id: string | null }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(source.id);
    expect(rows[0].portable_id).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Test 10: .oyster/ never registered as artefact (invariant 6)
// ---------------------------------------------------------------------------

describe("Test 10 — .oyster/ is never registered as an artefact (invariant 6)", () => {
  let env: ReturnType<typeof makeEnv>;
  beforeEach(() => { env = makeEnv(); });
  afterEach(() => { env.cleanup(); });

  it("scan produces a README artefact but no artefact whose path contains /.oyster/; SKIP_DIRS has .oyster", async () => {
    const repo = join(env.workDir, "repo10");
    mkdirSync(repo);
    // Create .oyster/id AND a README.md.
    mkdirSync(join(repo, ".oyster"));
    writeFileSync(join(repo, ".oyster", "id"), "cccccccc-dddd-eeee-ffff-000011112222\n");
    writeFileSync(join(repo, "README.md"), "# repo10\n");

    env.service.addSource(env.home.id, repo);
    await env.service.scanSpace(env.home.id);

    const artifacts = env.artifactStore.getBySpaceId(env.home.id);

    // There must be an artefact for README.md.
    const readmeArtifact = artifacts.find((a) => {
      const cfg = a.storage_config ? JSON.parse(a.storage_config) : {};
      return typeof cfg.path === "string" && cfg.path.endsWith("README.md");
    });
    expect(readmeArtifact).toBeDefined();

    // There must be NO artefact whose storage_config path contains /.oyster/.
    const oysterArtifact = artifacts.find((a) => {
      const cfg = a.storage_config ? JSON.parse(a.storage_config) : {};
      return typeof cfg.path === "string" && cfg.path.includes("/.oyster/");
    });
    expect(oysterArtifact).toBeUndefined();

    // ALSO verify that '.oyster' appears literally in SKIP_DIRS in space-service.ts.
    const spaceServiceSrc = readFileSync(
      new URL("../src/space-service.ts", import.meta.url),
      "utf8",
    );
    expect(spaceServiceSrc).toContain('".oyster"');
    expect(spaceServiceSrc).toMatch(/SKIP_DIRS\s*=\s*new Set\([^)]*"\.oyster"[^)]*\)/);
  });
});
