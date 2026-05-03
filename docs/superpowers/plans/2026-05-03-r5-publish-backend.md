# R5 Publish Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the backend that turns an Oyster artefact into a published share URL — `publish_artifact` / `unpublish_artifact` MCP tools, matching HTTP routes on the local server, and a new `oyster-publish` Cloudflare Worker that owns the cloud publication state and R2 object storage.

**Architecture:** New Cloudflare Worker at `oyster.to/api/publish/*` (admin) and `oyster.to/p/*` (viewer; scaffolded as `501` here, body lands in #316). The Worker shares the existing `oyster-auth` D1 binding so it can read `sessions` and own a new `published_artifacts` table. The local server proxies upload bytes from `~/Oyster/spaces/...` to the Worker, derives PBKDF2 password hashes locally so plaintext never crosses the wire, and mirrors the Worker's response into `artifacts` row columns for fast UI render. Spec: [`docs/superpowers/specs/2026-05-03-r5-publish-backend-design.md`](../specs/2026-05-03-r5-publish-backend-design.md).

**Tech Stack:** TypeScript, Cloudflare Workers, D1 (SQLite), R2 (object store), Vitest + `@cloudflare/vitest-pool-workers` for Worker integration tests, Node `crypto` (PBKDF2) on the local server.

---

## File Structure

| Action | Path | Responsibility |
|---|---|---|
| Create | `infra/auth-worker/migrations/0003_publish.sql` | DDL: `ALTER users ADD tier`, `CREATE published_artifacts` + indexes + CHECK |
| Modify | `infra/auth-worker/package.json` | Add `db:migrate:0003` + `db:migrate:0003:local` scripts |
| Create | `infra/oyster-publish/package.json` | Worker package manifest + scripts |
| Create | `infra/oyster-publish/wrangler.toml` | Worker config: name, routes, D1 + R2 bindings |
| Create | `infra/oyster-publish/tsconfig.json` | TypeScript config |
| Create | `infra/oyster-publish/vitest.config.ts` | Vitest with `@cloudflare/vitest-pool-workers` |
| Create | `infra/oyster-publish/README.md` | Setup + deploy instructions |
| Create | `infra/oyster-publish/src/types.ts` | `Env` interface + shared types |
| Create | `infra/oyster-publish/src/publish-helpers.ts` | Pure helpers: `generateShareToken`, `parseMetadataHeader`, `r2KeyFor`, `CAPS` |
| Create | `infra/oyster-publish/src/worker.ts` | Router + handlers + D1/R2 ops |
| Create | `infra/oyster-publish/test/publish-helpers.test.ts` | Unit tests for pure helpers |
| Create | `infra/oyster-publish/test/publish-handler.test.ts` | Integration tests for `POST /api/publish/upload` |
| Create | `infra/oyster-publish/test/unpublish-handler.test.ts` | Integration tests for `DELETE /api/publish/:token` |
| Create | `infra/oyster-publish/test/fixtures/seed.ts` | D1 seed helpers (insert user / session / publication rows) |
| Modify | `server/src/db.ts` | Idempotent `ALTER TABLE artifacts ADD COLUMN share_updated_at` |
| Create | `server/src/password-hash.ts` | `hashPassword(plaintext)` using Node `crypto.pbkdf2` |
| Create | `server/src/publish-service.ts` | `publishArtifact()` / `unpublishArtifact()` — single helper called by HTTP route + MCP tool |
| Create | `server/src/routes/publish.ts` | `POST` / `DELETE /api/artifacts/:id/publish` |
| Modify | `server/src/index.ts` | Wire `tryHandlePublishRoute` |
| Modify | `server/src/mcp-server.ts` | Register `publish_artifact` + `unpublish_artifact` MCP tools |
| Create | `server/test/password-hash.test.ts` | Hash format + PBKDF2 round-trip tests |
| Create | `server/test/publish-service.test.ts` | Service-level tests with a mocked Worker fetch |
| Modify | `CHANGELOG.md` | One-line entry under `[Unreleased] / Added` |

**Decisions encoded in the structure:**

- **Pure helpers split out into `publish-helpers.ts`.** Same precedent as auth-worker's `oauth-helpers.ts` — keeps unit tests fast and importable without dragging in `Env` or `D1Database`. Token generation, header parsing, R2 key derivation, and the `CAPS` map all live here.
- **Single `worker.ts` for routing + handlers + D1/R2 ops.** Mirrors auth-worker's shape. Keeps the integration surface in one file so the integration tests cover whole-handler behaviour, not artificial seams.
- **Integration tests use `@cloudflare/vitest-pool-workers`.** Spec calls for a real D1 + R2 round-trip; the pool runs tests inside a Workers runtime with a real (in-memory) D1 and R2. Auth-worker chose pure-unit + smoke; we override here because the spec explicitly requires integration coverage of cap, race recovery, CHECK constraint, etc.
- **Local server: `publish-service.ts` is the *only* place that knows the Worker URL.** Both `routes/publish.ts` and the MCP tool import it. No duplicate proxy logic.
- **No tests for the local server's HTTP route.** Same precedent as `routes/auth.ts` and the other extracted routes — the route file is a thin glue layer; the tested unit is `publish-service.ts`.

---

## Phase 1 — Schema + Worker scaffold (PR 1)

End state: `0003_publish.sql` applied to remote D1 (`users.tier` column live, `published_artifacts` empty), `oyster-publish` Worker deployed at `oyster.to/api/publish/*` and `oyster.to/p/*` returning `501 Not Implemented` for everything, R2 bucket `oyster-artifacts` provisioned, README documents setup.

### Task 1.1: D1 migration `0003_publish.sql`

**Files:**
- Create: `infra/auth-worker/migrations/0003_publish.sql`
- Modify: `infra/auth-worker/package.json`

- [ ] **Step 1: Write the migration.**

Create `infra/auth-worker/migrations/0003_publish.sql`:

```sql
-- 0003_publish.sql — R5 Publish: tier hook on users + published_artifacts table.
-- Spec: docs/superpowers/specs/2026-05-03-r5-publish-backend-design.md
-- D1 supports ALTER TABLE ADD COLUMN; both bindings (oyster-auth + oyster-publish)
-- read/write this DB.

-- Tier hook for entitlement checks. Always 'free' in 0.7.0; Pro values land in 0.8.0+.
ALTER TABLE users ADD COLUMN tier TEXT NOT NULL DEFAULT 'free';

CREATE TABLE published_artifacts (
  share_token       TEXT    PRIMARY KEY,
  owner_user_id     TEXT    NOT NULL REFERENCES users(id),
  artifact_id       TEXT    NOT NULL,
  artifact_kind     TEXT    NOT NULL,
  mode              TEXT    NOT NULL CHECK (mode IN ('open','password','signin')),
  password_hash     TEXT,
  r2_key            TEXT    NOT NULL,
  content_type      TEXT    NOT NULL,
  size_bytes        INTEGER NOT NULL,
  published_at      INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  unpublished_at    INTEGER,
  CHECK (
    (mode = 'password' AND password_hash IS NOT NULL) OR
    (mode <> 'password' AND password_hash IS NULL)
  )
);

CREATE INDEX idx_pubart_owner ON published_artifacts(owner_user_id);

-- Active-publication uniqueness scoped to (owner, artefact). artifact_id alone
-- is not globally unique across users.
CREATE UNIQUE INDEX idx_pubart_active_per_owner_artifact
  ON published_artifacts(owner_user_id, artifact_id)
  WHERE unpublished_at IS NULL;
```

- [ ] **Step 2: Add migrate scripts to `infra/auth-worker/package.json`.**

Add the two scripts inside `"scripts"` (keep alongside the existing `db:migrate:0002` pair):

```json
"db:migrate:0003": "wrangler d1 execute oyster-auth --file=migrations/0003_publish.sql --remote",
"db:migrate:0003:local": "wrangler d1 execute oyster-auth --file=migrations/0003_publish.sql --local",
```

- [ ] **Step 3: Apply locally and verify.**

```bash
cd infra/auth-worker
npm run db:migrate:0003:local
wrangler d1 execute oyster-auth --local --command "SELECT name, sql FROM sqlite_master WHERE type IN ('table','index') AND name LIKE '%pubart%' OR name='published_artifacts';"
wrangler d1 execute oyster-auth --local --command "SELECT name FROM pragma_table_info('users') WHERE name='tier';"
```

Expected: the `SELECT` returns the `published_artifacts` table DDL plus both indexes; the second returns one row with `name='tier'`.

- [ ] **Step 4: Commit.**

```bash
git add infra/auth-worker/migrations/0003_publish.sql infra/auth-worker/package.json
git commit -m "feat(auth-worker): D1 migration 0003 — published_artifacts + users.tier (#315)"
```

---

### Task 1.2: Apply migration to remote D1

**Files:** none (operational task).

- [ ] **Step 1: Run the remote migration.**

```bash
cd infra/auth-worker
npm run db:migrate:0003
```

Expected: `Executed N commands` with no error.

- [ ] **Step 2: Verify remote schema.**

```bash
wrangler d1 execute oyster-auth --remote --command "SELECT name FROM sqlite_master WHERE name IN ('published_artifacts','idx_pubart_owner','idx_pubart_active_per_owner_artifact');"
wrangler d1 execute oyster-auth --remote --command "SELECT name FROM pragma_table_info('users') WHERE name='tier';"
```

Expected: three rows for the schema, one row for the column.

- [ ] **Step 3: Backfill `users.tier` (no-op confirmation).**

The `DEFAULT 'free'` populates new rows. Existing rows pre-migration may have `NULL` if SQLite's default-on-add doesn't fill back. Run an explicit backfill to be safe:

```bash
wrangler d1 execute oyster-auth --remote --command "UPDATE users SET tier = 'free' WHERE tier IS NULL;"
```

Expected: report of rows changed (likely 1 — `matthew@slight.me` from the existing fixture).

(No commit — this is a remote DB op, not a code change.)

---

### Task 1.3: Provision R2 bucket

**Files:** none (operational task).

- [ ] **Step 1: Create the bucket.**

```bash
wrangler r2 bucket create oyster-artifacts
```

Expected: `Successfully created bucket 'oyster-artifacts'`.

- [ ] **Step 2: Confirm bucket exists.**

```bash
wrangler r2 bucket list
```

Expected: `oyster-artifacts` appears in the list.

(No commit.)

---

### Task 1.4: Bootstrap `infra/oyster-publish/` skeleton

**Files:**
- Create: `infra/oyster-publish/package.json`
- Create: `infra/oyster-publish/tsconfig.json`
- Create: `infra/oyster-publish/.gitignore`
- Create: `infra/oyster-publish/src/types.ts`
- Create: `infra/oyster-publish/src/worker.ts`

- [ ] **Step 1: Create `package.json`.**

```json
{
  "name": "oyster-publish-worker",
  "version": "0.0.0",
  "private": true,
  "description": "Cloudflare Worker for R5 publish: artefact upload + publication state + R2 storage",
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy",
    "tail": "wrangler tail",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "@cloudflare/workers-types": "^4.20260101.0",
    "@cloudflare/vitest-pool-workers": "^0.5.0",
    "typescript": "^5.4.0",
    "vitest": "^2.1.0",
    "wrangler": "^4.0.0"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`.**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022"],
    "types": ["@cloudflare/workers-types"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "isolatedModules": true,
    "noEmit": true,
    "skipLibCheck": true,
    "resolveJsonModule": true
  },
  "include": ["src/**/*", "test/**/*"]
}
```

- [ ] **Step 3: Create `.gitignore`.**

```
node_modules/
.dev.vars
.wrangler/
```

- [ ] **Step 4: Create `src/types.ts`.**

```ts
// Env interface for the oyster-publish Worker.
// Bindings declared in wrangler.toml.

export interface Env {
  DB: D1Database;          // shared with oyster-auth (same database_id)
  ARTIFACTS: R2Bucket;     // oyster-artifacts
}

// Decoded X-Publish-Metadata payload — produced by the local server.
export interface PublishMetadata {
  artifact_id: string;
  artifact_kind: string;
  mode: "open" | "password" | "signin";
  password_hash?: string;  // present iff mode === 'password'
}

// Row shape for published_artifacts.
export interface PublicationRow {
  share_token: string;
  owner_user_id: string;
  artifact_id: string;
  artifact_kind: string;
  mode: "open" | "password" | "signin";
  password_hash: string | null;
  r2_key: string;
  content_type: string;
  size_bytes: number;
  published_at: number;
  updated_at: number;
  unpublished_at: number | null;
}
```

- [ ] **Step 5: Create `src/worker.ts` with stub handlers.**

```ts
// oyster-publish — R5 publish endpoints + viewer scaffold.
// All real handler bodies land in Phase 2 (#315 PR 2).

import type { Env } from "./types";

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    // POST /api/publish/upload
    if (url.pathname === "/api/publish/upload" && req.method === "POST") {
      return notImplemented("publish_upload");
    }

    // DELETE /api/publish/:share_token
    if (url.pathname.startsWith("/api/publish/") && req.method === "DELETE") {
      return notImplemented("publish_unpublish");
    }

    // GET /p/:share_token — viewer body lands in #316.
    if (url.pathname.startsWith("/p/") && req.method === "GET") {
      return notImplemented("publish_viewer");
    }

    return new Response("Not Found", { status: 404 });
  },
};

function notImplemented(handler: string): Response {
  return new Response(
    JSON.stringify({ error: "not_implemented", handler }),
    { status: 501, headers: { "content-type": "application/json" } },
  );
}
```

- [ ] **Step 6: Install + typecheck.**

```bash
cd infra/oyster-publish
npm install
npm run typecheck
```

Expected: install succeeds; `typecheck` produces no output (success).

- [ ] **Step 7: Commit.**

```bash
git add infra/oyster-publish/package.json \
        infra/oyster-publish/package-lock.json \
        infra/oyster-publish/tsconfig.json \
        infra/oyster-publish/.gitignore \
        infra/oyster-publish/src/types.ts \
        infra/oyster-publish/src/worker.ts
git commit -m "feat(oyster-publish): scaffold Worker with 501 stub handlers (#315)"
```

---

### Task 1.5: `wrangler.toml` with bindings

**Files:**
- Create: `infra/oyster-publish/wrangler.toml`

- [ ] **Step 1: Write the config.**

```toml
name = "oyster-publish"
main = "src/worker.ts"
compatibility_date = "2026-04-01"

# Shared D1 binding — same database_id as oyster-auth so we can read sessions/users
# and own the published_artifacts table inside the same DB. Single source of truth.
[[d1_databases]]
binding = "DB"
database_name = "oyster-auth"
database_id = "44086805-fbfa-4446-8626-126af7e2ec19"

# R2 bucket for published artefact bytes.
[[r2_buckets]]
binding = "ARTIFACTS"
bucket_name = "oyster-artifacts"

# Routes: admin API + public viewer. Both apex and www so the Worker is
# reachable from either origin (matches auth-worker pattern).
[[routes]]
pattern = "oyster.to/api/publish/*"
zone_name = "oyster.to"

[[routes]]
pattern = "www.oyster.to/api/publish/*"
zone_name = "oyster.to"

[[routes]]
pattern = "oyster.to/p/*"
zone_name = "oyster.to"

[[routes]]
pattern = "www.oyster.to/p/*"
zone_name = "oyster.to"
```

- [ ] **Step 2: Verify with `wrangler deploy --dry-run`.**

```bash
cd infra/oyster-publish
npx wrangler deploy --dry-run
```

Expected: `Dry run, the following changes would be applied`, listing the four routes, the D1 binding, and the R2 binding. No errors.

- [ ] **Step 3: Commit.**

```bash
git add infra/oyster-publish/wrangler.toml
git commit -m "feat(oyster-publish): wrangler config with D1 + R2 bindings (#315)"
```

---

### Task 1.6: Vitest + `@cloudflare/vitest-pool-workers` setup

**Files:**
- Create: `infra/oyster-publish/vitest.config.ts`
- Create: `infra/oyster-publish/test/.gitkeep`

The pool runs tests inside a Workers runtime against a real (in-memory) D1 + R2. We seed the test D1 from the same SQL files used in production so schema parity is guaranteed.

- [ ] **Step 1: Create `vitest.config.ts`.**

```ts
import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    include: ["test/**/*.test.ts"],
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          // Use isolated in-memory D1 + R2 per test file.
          d1Databases: ["DB"],
          r2Buckets: ["ARTIFACTS"],
        },
      },
    },
  },
});
```

- [ ] **Step 2: Create `test/.gitkeep`.**

```bash
mkdir -p infra/oyster-publish/test
touch infra/oyster-publish/test/.gitkeep
```

- [ ] **Step 3: Verify Vitest discovers no tests but exits clean.**

```bash
cd infra/oyster-publish
npm run test -- --reporter=verbose
```

Expected: vitest reports `No test files found` and exits with code 0 (or similar). If install missed something, fix before continuing.

- [ ] **Step 4: Commit.**

```bash
git add infra/oyster-publish/vitest.config.ts \
        infra/oyster-publish/test/.gitkeep
git commit -m "chore(oyster-publish): vitest with workers pool (#315)"
```

---

### Task 1.7: First deploy + smoke test

**Files:** none.

- [ ] **Step 1: Deploy.**

```bash
cd infra/oyster-publish
npm run deploy
```

Expected: `Deployed oyster-publish triggers...` listing the four routes. Note the deployment id from the output.

- [ ] **Step 2: Smoke-test the four routes.**

```bash
curl -s -o /dev/null -w "POST upload:    %{http_code}\n" -X POST  https://oyster.to/api/publish/upload
curl -s -o /dev/null -w "DELETE token:   %{http_code}\n" -X DELETE https://oyster.to/api/publish/anytoken
curl -s -o /dev/null -w "GET viewer:     %{http_code}\n"          https://oyster.to/p/anytoken
curl -s -o /dev/null -w "GET unmatched:  %{http_code}\n"          https://oyster.to/api/publish/
```

Expected:
```
POST upload:    501
DELETE token:   501
GET viewer:     501
GET unmatched:  404
```

- [ ] **Step 3: Confirm 501 body.**

```bash
curl -s -X POST https://oyster.to/api/publish/upload
```

Expected: `{"error":"not_implemented","handler":"publish_upload"}`.

(No commit — operational verification only.)

---

### Task 1.8: README

**Files:**
- Create: `infra/oyster-publish/README.md`

- [ ] **Step 1: Write the README.**

```markdown
# oyster-publish Worker

Cloudflare Worker for R5 publish (#315 spec):
- `POST /api/publish/upload` — server-to-server upload from the local Oyster server.
- `DELETE /api/publish/:share_token` — retire a publication.
- `GET /p/:share_token` — public viewer (501 here; body lands in #316).

Spec: [`docs/superpowers/specs/2026-05-03-r5-publish-backend-design.md`](../../docs/superpowers/specs/2026-05-03-r5-publish-backend-design.md).

## Setup (one-time)

```bash
# 1. Apply the D1 migration (creates published_artifacts in the shared
#    oyster-auth DB, adds users.tier).
cd infra/auth-worker
npm run db:migrate:0003

# 2. Provision the R2 bucket.
wrangler r2 bucket create oyster-artifacts
```

## Deploy

```bash
cd infra/oyster-publish
npm install
npm run deploy
```

## Local dev

```bash
npm run dev   # runs wrangler dev with miniflare D1 + R2 in-memory
npm test      # vitest with @cloudflare/vitest-pool-workers
```

## Notes

- Bindings: `DB` (shared with oyster-auth), `ARTIFACTS` (R2 bucket `oyster-artifacts`).
- No secrets: nothing in `wrangler secret put`. Sessions are validated by reading the
  shared `sessions` table.
- R2 key shape: `published/{owner_user_id}/{share_token}`.
```

- [ ] **Step 2: Commit.**

```bash
git add infra/oyster-publish/README.md
git commit -m "docs(oyster-publish): setup + deploy README (#315)"
```

---

### Task 1.9: Open Phase 1 PR

**Files:** none.

- [ ] **Step 1: Push the branch.**

```bash
git push -u origin feat/r5-publish-backend
```

- [ ] **Step 2: Open the PR.**

```bash
gh pr create --title "feat(publish): Worker scaffold + D1 migration + R2 bucket (#315 PR 1/3)" --body "$(cat <<'EOF'
## Summary

- New `oyster-publish` Cloudflare Worker, deployed at `oyster.to/api/publish/*` and `oyster.to/p/*`. All endpoints currently return `501` — bodies land in PRs 2 + 3.
- D1 migration `0003_publish.sql` against the shared `oyster-auth` DB: adds `users.tier` (default `'free'`) and creates `published_artifacts` with the spec's indexes + CHECK.
- R2 bucket `oyster-artifacts` provisioned.

Spec: `docs/superpowers/specs/2026-05-03-r5-publish-backend-design.md`.
Plan: `docs/superpowers/plans/2026-05-03-r5-publish-backend.md`.

## Test plan

- [ ] `wrangler d1 execute oyster-auth --remote --command "SELECT * FROM published_artifacts;"` returns no rows, no error.
- [ ] `wrangler r2 bucket list` shows `oyster-artifacts`.
- [ ] `curl -X POST https://oyster.to/api/publish/upload` returns `501 {"error":"not_implemented","handler":"publish_upload"}`.
- [ ] `curl https://oyster.to/p/anything` returns `501`.
- [ ] No regression in `oyster-auth` — sign-in still works at `oyster.to/auth/sign-in`.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 3: Confirm CI is green and request review.**

(Pause here for review/merge before starting Phase 2.)

---

## Phase 2 — Worker publish + unpublish endpoints (PR 2)

End state: `oyster-publish` Worker fully implements the spec's `POST /api/publish/upload` (with race recovery + stream-size enforcement + cap + CHECK) and `DELETE /api/publish/:share_token`. Vitest pool-workers integration suite passes. Local server is still untouched — calls are smoke-tested with `curl` only.

### Task 2.1: `generateShareToken` + `r2KeyFor` + `CAPS` (TDD, pure helpers)

**Files:**
- Create: `infra/oyster-publish/src/publish-helpers.ts`
- Create: `infra/oyster-publish/test/publish-helpers.test.ts`

- [ ] **Step 1: Write the failing tests.**

Create `infra/oyster-publish/test/publish-helpers.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { generateShareToken, r2KeyFor, CAPS, parseMetadataHeader } from "../src/publish-helpers";

describe("generateShareToken", () => {
  it("is 32 base64url characters (24 bytes, no padding)", () => {
    const t = generateShareToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]{32}$/);
  });

  it("produces a different value on each call", () => {
    const a = generateShareToken();
    const b = generateShareToken();
    expect(a).not.toBe(b);
  });
});

describe("r2KeyFor", () => {
  it("composes published/{owner}/{token}", () => {
    expect(r2KeyFor("user_abc", "tok_xyz")).toBe("published/user_abc/tok_xyz");
  });
});

describe("CAPS.free", () => {
  it("max_active is 5", () => {
    expect(CAPS.free.max_active).toBe(5);
  });

  it("max_size_bytes is exactly 10 MB", () => {
    expect(CAPS.free.max_size_bytes).toBe(10 * 1024 * 1024);
  });
});

describe("parseMetadataHeader", () => {
  function encode(payload: object): string {
    const json = JSON.stringify(payload);
    return Buffer.from(json).toString("base64url");
  }

  it("decodes a valid 'open' payload", () => {
    const blob = encode({ artifact_id: "a", artifact_kind: "notes", mode: "open" });
    const result = parseMetadataHeader(blob);
    expect(result).toEqual({ artifact_id: "a", artifact_kind: "notes", mode: "open" });
  });

  it("decodes a 'password' payload with hash", () => {
    const blob = encode({
      artifact_id: "a", artifact_kind: "notes", mode: "password",
      password_hash: "pbkdf2$100000$xx$yy",
    });
    const result = parseMetadataHeader(blob);
    expect(result.mode).toBe("password");
    expect(result.password_hash).toBe("pbkdf2$100000$xx$yy");
  });

  it("throws 'invalid_metadata' for malformed base64url", () => {
    expect(() => parseMetadataHeader("!!! not base64 !!!")).toThrow("invalid_metadata");
  });

  it("throws 'invalid_metadata' for missing required fields", () => {
    const blob = encode({ artifact_id: "a", mode: "open" });
    expect(() => parseMetadataHeader(blob)).toThrow("invalid_metadata");
  });

  it("throws 'invalid_metadata' for invalid mode value", () => {
    const blob = encode({ artifact_id: "a", artifact_kind: "k", mode: "weird" });
    expect(() => parseMetadataHeader(blob)).toThrow("invalid_metadata");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail.**

```bash
cd infra/oyster-publish
npm run test -- --reporter=verbose publish-helpers
```

Expected: failures because `publish-helpers.ts` doesn't exist yet.

- [ ] **Step 3: Implement `publish-helpers.ts`.**

```ts
// Pure helpers for oyster-publish. No D1, no R2, no Workers globals beyond
// crypto.getRandomValues / atob — safe to unit-test under any runtime.

import type { PublishMetadata } from "./types";

export const CAPS = {
  free: { max_active: 5, max_size_bytes: 10 * 1024 * 1024 },
  // pro: { … }   ← lands in 0.8.0+
} as const;

export type Tier = keyof typeof CAPS;

export function generateShareToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return base64urlEncode(bytes);
}

export function r2KeyFor(ownerUserId: string, shareToken: string): string {
  return `published/${ownerUserId}/${shareToken}`;
}

export function parseMetadataHeader(blob: string): PublishMetadata {
  let json: string;
  try {
    json = base64urlDecodeToString(blob);
  } catch {
    throw new Error("invalid_metadata");
  }

  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error("invalid_metadata");
  }

  if (!raw || typeof raw !== "object") throw new Error("invalid_metadata");
  const r = raw as Record<string, unknown>;

  if (typeof r.artifact_id !== "string" || r.artifact_id.length === 0) throw new Error("invalid_metadata");
  if (typeof r.artifact_kind !== "string" || r.artifact_kind.length === 0) throw new Error("invalid_metadata");
  if (r.mode !== "open" && r.mode !== "password" && r.mode !== "signin") throw new Error("invalid_metadata");
  if (r.password_hash !== undefined && typeof r.password_hash !== "string") throw new Error("invalid_metadata");

  return {
    artifact_id: r.artifact_id,
    artifact_kind: r.artifact_kind,
    mode: r.mode,
    password_hash: r.password_hash as string | undefined,
  };
}

function base64urlEncode(bytes: Uint8Array): string {
  let str = "";
  for (const b of bytes) str += String.fromCharCode(b);
  const b64 = btoa(str);
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlDecodeToString(s: string): string {
  // Restore standard base64 padding/alphabet for atob.
  const padded = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  const decoded = atob(padded);
  // atob returns a "binary string" (one char per byte). For UTF-8 JSON we need
  // to round-trip through bytes → TextDecoder.
  const bytes = new Uint8Array(decoded.length);
  for (let i = 0; i < decoded.length; i++) bytes[i] = decoded.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
```

- [ ] **Step 4: Run the tests to verify they pass.**

```bash
npm run test -- publish-helpers
```

Expected: 9 tests pass (3 generate + 1 r2Key + 2 CAPS + 5 parseMetadata, allowing for grouping).

- [ ] **Step 5: Commit.**

```bash
git add infra/oyster-publish/src/publish-helpers.ts \
        infra/oyster-publish/test/publish-helpers.test.ts
git commit -m "feat(oyster-publish): pure helpers — token, R2 key, CAPS, metadata parse (#315)"
```

---

### Task 2.2: Test fixtures (D1 seed helpers)

**Files:**
- Create: `infra/oyster-publish/test/fixtures/seed.ts`

Each integration test starts with an empty D1 (the workers pool gives isolated bindings per test file). We need helpers that apply the schema and seed users + sessions so handlers can resolve auth.

- [ ] **Step 1: Write the seed helpers.**

```ts
// Test fixtures for oyster-publish integration tests.
// Each test file gets isolated D1 + R2 bindings via @cloudflare/vitest-pool-workers.

import { env } from "cloudflare:test";

const SCHEMA_SQL = `
-- Mirror of oyster-auth's relevant schema for tests. Keep in sync with:
--   infra/auth-worker/migrations/0001_init.sql  (users, sessions)
--   infra/auth-worker/migrations/0003_publish.sql (users.tier, published_artifacts)
CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER,
  tier          TEXT NOT NULL DEFAULT 'free'
);
CREATE TABLE sessions (
  session_token TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id),
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL
);
CREATE TABLE published_artifacts (
  share_token       TEXT    PRIMARY KEY,
  owner_user_id     TEXT    NOT NULL REFERENCES users(id),
  artifact_id       TEXT    NOT NULL,
  artifact_kind     TEXT    NOT NULL,
  mode              TEXT    NOT NULL CHECK (mode IN ('open','password','signin')),
  password_hash     TEXT,
  r2_key            TEXT    NOT NULL,
  content_type      TEXT    NOT NULL,
  size_bytes        INTEGER NOT NULL,
  published_at      INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  unpublished_at    INTEGER,
  CHECK (
    (mode = 'password' AND password_hash IS NOT NULL) OR
    (mode <> 'password' AND password_hash IS NULL)
  )
);
CREATE INDEX idx_pubart_owner ON published_artifacts(owner_user_id);
CREATE UNIQUE INDEX idx_pubart_active_per_owner_artifact
  ON published_artifacts(owner_user_id, artifact_id)
  WHERE unpublished_at IS NULL;
`;

export async function applySchema(): Promise<void> {
  // D1 .exec runs multi-statement SQL but ignores comments inconsistently;
  // split on semicolons and run each non-empty statement.
  const stmts = SCHEMA_SQL.split(";").map(s => s.trim()).filter(Boolean);
  for (const s of stmts) {
    await env.DB.prepare(s).run();
  }
}

export interface SeededUser {
  id: string;
  email: string;
  sessionToken: string;
}

export async function seedUser(opts: { id?: string; email?: string; tier?: string } = {}): Promise<SeededUser> {
  const id = opts.id ?? `user_${crypto.randomUUID().slice(0, 8)}`;
  const email = opts.email ?? `${id}@example.com`;
  const tier = opts.tier ?? "free";
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO users (id, email, created_at, last_seen_at, tier) VALUES (?, ?, ?, ?, ?)"
  ).bind(id, email, now, now, tier).run();

  const sessionToken = `sess_${crypto.randomUUID()}`;
  const expiresAt = now + 30 * 86400 * 1000;
  await env.DB.prepare(
    "INSERT INTO sessions (session_token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)"
  ).bind(sessionToken, id, now, expiresAt).run();

  return { id, email, sessionToken };
}

export async function seedActivePublication(opts: {
  ownerUserId: string;
  artifactId: string;
  shareToken?: string;
  mode?: "open" | "password" | "signin";
  passwordHash?: string | null;
  publishedAt?: number;
}): Promise<string> {
  const token = opts.shareToken ?? `seeded_${crypto.randomUUID().slice(0, 8)}`;
  const mode = opts.mode ?? "open";
  const passwordHash = mode === "password" ? (opts.passwordHash ?? "pbkdf2$100000$x$y") : null;
  const now = opts.publishedAt ?? Date.now();
  await env.DB.prepare(
    `INSERT INTO published_artifacts
     (share_token, owner_user_id, artifact_id, artifact_kind, mode, password_hash,
      r2_key, content_type, size_bytes, published_at, updated_at, unpublished_at)
     VALUES (?, ?, ?, 'notes', ?, ?, ?, 'text/plain', 5, ?, ?, NULL)`
  ).bind(token, opts.ownerUserId, opts.artifactId, mode, passwordHash,
         `published/${opts.ownerUserId}/${token}`, now, now).run();
  return token;
}

export function authHeader(sessionToken: string): { Cookie: string } {
  return { Cookie: `oyster_session=${sessionToken}` };
}

export function metadataHeader(payload: object): string {
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}
```

- [ ] **Step 2: Commit (no test yet — fixtures are exercised by Task 2.4 onward).**

```bash
git add infra/oyster-publish/test/fixtures/seed.ts
git commit -m "test(oyster-publish): D1 seed helpers for integration tests (#315)"
```

---

### Task 2.3: Implement `worker.ts` — session resolution + router skeleton

**Files:**
- Modify: `infra/oyster-publish/src/worker.ts`

We start by adding the shared infrastructure (session resolution, JSON error helper, router) before the handler bodies. Handlers stay 501 stubs at this point.

- [ ] **Step 1: Replace `worker.ts` with the router skeleton.**

```ts
// oyster-publish — R5 publish endpoints + viewer scaffold.
// Spec: docs/superpowers/specs/2026-05-03-r5-publish-backend-design.md

import type { Env } from "./types";

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/api/publish/upload" && req.method === "POST") {
      return handlePublishUpload(req, env);
    }

    if (url.pathname.startsWith("/api/publish/") && req.method === "DELETE") {
      const token = url.pathname.slice("/api/publish/".length);
      return handlePublishDelete(req, env, token);
    }

    if (url.pathname.startsWith("/p/") && req.method === "GET") {
      // Viewer body lands in #316.
      return jsonError(501, "not_implemented", "viewer lands in #316");
    }

    return new Response("Not Found", { status: 404 });
  },
};

// ─── Handlers (bodies in tasks 2.5 and 2.6) ────────────────────────────────

async function handlePublishUpload(req: Request, env: Env): Promise<Response> {
  return jsonError(501, "not_implemented", "publish_upload — body in Task 2.5");
}

async function handlePublishDelete(req: Request, env: Env, shareToken: string): Promise<Response> {
  return jsonError(501, "not_implemented", "publish_unpublish — body in Task 2.6");
}

// ─── Shared helpers ────────────────────────────────────────────────────────

interface SessionUser {
  id: string;
  email: string;
  tier: string;
}

/**
 * Resolve the session cookie to a user. Returns null on missing/expired session.
 * Reads from the shared sessions + users tables.
 */
export async function resolveSession(req: Request, env: Env): Promise<SessionUser | null> {
  const cookie = req.headers.get("Cookie");
  if (!cookie) return null;
  const m = cookie.match(/(?:^|;\s*)oyster_session=([^;]+)/);
  if (!m) return null;
  const token = m[1];

  const row = await env.DB.prepare(
    `SELECT u.id AS id, u.email AS email, u.tier AS tier, s.expires_at AS expires_at
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.session_token = ?`
  ).bind(token).first<{ id: string; email: string; tier: string; expires_at: number }>();

  if (!row) return null;
  if (row.expires_at <= Date.now()) return null;
  return { id: row.id, email: row.email, tier: row.tier };
}

export function jsonError(status: number, code: string, message?: string, extra: Record<string, unknown> = {}): Response {
  const body: Record<string, unknown> = { error: code, ...extra };
  if (message) body.message = message;
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function jsonOk(payload: object, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}
```

- [ ] **Step 2: Typecheck.**

```bash
cd infra/oyster-publish
npm run typecheck
```

Expected: no output (success).

- [ ] **Step 3: Commit.**

```bash
git add infra/oyster-publish/src/worker.ts
git commit -m "feat(oyster-publish): session resolver + router skeleton (#315)"
```

---

### Task 2.4: Auth + metadata validation tests (set the test pattern)

**Files:**
- Create: `infra/oyster-publish/test/publish-handler.test.ts`

This task lays down the test file with the easiest cases (auth, metadata validation). Subsequent tasks add cases for cap, race, etc.

- [ ] **Step 1: Write the auth + metadata test cases.**

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/worker";
import { applySchema, seedUser, authHeader, metadataHeader } from "./fixtures/seed";

beforeEach(async () => {
  await applySchema();
});

function uploadRequest(opts: {
  cookieHeader?: Record<string, string>;
  metadata?: string;
  contentType?: string;
  contentLength?: string | null;
  body?: BodyInit | null;
} = {}): Request {
  const headers = new Headers();
  if (opts.cookieHeader?.Cookie) headers.set("Cookie", opts.cookieHeader.Cookie);
  if (opts.metadata !== undefined) headers.set("X-Publish-Metadata", opts.metadata);
  if (opts.contentType) headers.set("Content-Type", opts.contentType);
  if (opts.contentLength !== null) {
    const len = opts.contentLength ?? (opts.body ? String((opts.body as string).length) : "0");
    headers.set("Content-Length", len);
  }
  return new Request("https://oyster.to/api/publish/upload", {
    method: "POST",
    headers,
    body: opts.body ?? null,
  });
}

async function call(req: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(req, env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

describe("POST /api/publish/upload — auth", () => {
  it("returns 401 sign_in_required when cookie is missing", async () => {
    const res = await call(uploadRequest());
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: "sign_in_required" });
  });

  it("returns 401 sign_in_required when cookie has unknown token", async () => {
    const res = await call(uploadRequest({ cookieHeader: { Cookie: "oyster_session=fake" } }));
    expect(res.status).toBe(401);
  });
});

describe("POST /api/publish/upload — metadata + size validation", () => {
  it("returns 400 invalid_metadata when X-Publish-Metadata is missing", async () => {
    const u = await seedUser();
    const res = await call(uploadRequest({ cookieHeader: authHeader(u.sessionToken) }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_metadata" });
  });

  it("returns 400 invalid_metadata when payload is malformed", async () => {
    const u = await seedUser();
    const res = await call(uploadRequest({
      cookieHeader: authHeader(u.sessionToken),
      metadata: "!!!not-base64!!!",
    }));
    expect(res.status).toBe(400);
  });

  it("returns 400 password_required when mode=password and hash absent", async () => {
    const u = await seedUser();
    const res = await call(uploadRequest({
      cookieHeader: authHeader(u.sessionToken),
      metadata: metadataHeader({ artifact_id: "a", artifact_kind: "notes", mode: "password" }),
    }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "password_required" });
  });

  it("returns 411 content_length_required when Content-Length missing", async () => {
    const u = await seedUser();
    const res = await call(uploadRequest({
      cookieHeader: authHeader(u.sessionToken),
      metadata: metadataHeader({ artifact_id: "a", artifact_kind: "notes", mode: "open" }),
      contentLength: null,
      contentType: "text/plain",
    }));
    expect(res.status).toBe(411);
    expect(await res.json()).toMatchObject({ error: "content_length_required" });
  });

  it("returns 413 artifact_too_large when Content-Length > cap", async () => {
    const u = await seedUser();
    const res = await call(uploadRequest({
      cookieHeader: authHeader(u.sessionToken),
      metadata: metadataHeader({ artifact_id: "a", artifact_kind: "notes", mode: "open" }),
      contentType: "text/plain",
      contentLength: String(11 * 1024 * 1024),
      body: "x",
    }));
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ error: "artifact_too_large", limit_bytes: 10 * 1024 * 1024 });
  });
});
```

- [ ] **Step 2: Run the suite — expect all to fail (501 responses).**

```bash
cd infra/oyster-publish
npm test -- publish-handler
```

Expected: every test fails with `expected 501 to be …`.

(No commit yet — implementing the validation in the next task makes them pass.)

---

### Task 2.5: Implement `handlePublishUpload` — validation + early errors

**Files:**
- Modify: `infra/oyster-publish/src/worker.ts`

This task implements steps 1–5 of the spec (auth, metadata parse, password presence, content-length presence + cap). It does *not* yet handle the find-or-claim, R2 PUT, or D1 upsert — those come in Task 2.6.

- [ ] **Step 1: Update `handlePublishUpload` to handle validation.**

Replace the stub with the validation phase:

```ts
async function handlePublishUpload(req: Request, env: Env): Promise<Response> {
  // Step 1: session.
  const user = await resolveSession(req, env);
  if (!user) return jsonError(401, "sign_in_required", "Sign in to publish artefacts.");

  // Step 2: metadata.
  const metaHeader = req.headers.get("X-Publish-Metadata");
  if (!metaHeader) return jsonError(400, "invalid_metadata");
  let meta;
  try {
    meta = parseMetadataHeader(metaHeader);
  } catch {
    return jsonError(400, "invalid_metadata");
  }

  // Step 3: password presence iff mode=password (defence in depth — local server already checked).
  if (meta.mode === "password" && (!meta.password_hash || meta.password_hash.length === 0)) {
    return jsonError(400, "password_required");
  }
  if (meta.mode !== "password" && meta.password_hash) {
    // Local server bug: hash sent for non-password mode. Reject.
    return jsonError(400, "invalid_metadata");
  }

  // Step 4: Content-Length present.
  const lenHeader = req.headers.get("Content-Length");
  if (!lenHeader) return jsonError(411, "content_length_required");
  const contentLength = Number(lenHeader);
  if (!Number.isFinite(contentLength) || contentLength < 0) {
    return jsonError(411, "content_length_required");
  }

  // Step 5: tier + size cap.
  const tier = (user.tier in CAPS ? user.tier : "free") as Tier;
  const cap = CAPS[tier];
  if (contentLength > cap.max_size_bytes) {
    return jsonError(413, "artifact_too_large", "Free tier allows published artefacts up to 10 MB.", {
      limit_bytes: cap.max_size_bytes,
    });
  }

  // Steps 6–9 land in Task 2.6.
  return jsonError(501, "not_implemented", "find-or-claim + R2 PUT + D1 upsert — Task 2.6");
}
```

- [ ] **Step 2: Add the imports at the top of `worker.ts`.**

```ts
import type { Env, PublicationRow } from "./types";
import { CAPS, generateShareToken, parseMetadataHeader, r2KeyFor, type Tier } from "./publish-helpers";
```

(Adjust the existing import line if a partial one is already present.)

- [ ] **Step 3: Run the validation tests.**

```bash
npm test -- publish-handler
```

Expected: all 7 tests in the auth + validation describe blocks pass.

- [ ] **Step 4: Commit.**

```bash
git add infra/oyster-publish/src/worker.ts
git commit -m "feat(oyster-publish): publish_upload validation + cap pre-check (#315)"
```

---

### Task 2.6: Implement `handlePublishUpload` — find-or-claim + R2 PUT + D1 upsert

**Files:**
- Modify: `infra/oyster-publish/src/worker.ts`
- Modify: `infra/oyster-publish/test/publish-handler.test.ts`

This is the heart of the spec: steps 6–9, including race recovery and stream-size enforcement.

- [ ] **Step 1: Add the happy-path tests first.**

Append to `publish-handler.test.ts`:

```ts
describe("POST /api/publish/upload — first publish (open mode)", () => {
  it("creates a row, writes R2, returns 200 with token + URL", async () => {
    const u = await seedUser();
    const body = "# Hello world";
    const res = await call(uploadRequest({
      cookieHeader: authHeader(u.sessionToken),
      metadata: metadataHeader({ artifact_id: "art_1", artifact_kind: "notes", mode: "open" }),
      contentType: "text/markdown",
      contentLength: String(new TextEncoder().encode(body).byteLength),
      body,
    }));
    expect(res.status).toBe(200);
    const json = await res.json() as { share_token: string; share_url: string; mode: string; published_at: number; updated_at: number };
    expect(json.share_token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(json.share_url).toBe(`https://oyster.to/p/${json.share_token}`);
    expect(json.mode).toBe("open");
    expect(json.published_at).toBeTypeOf("number");
    expect(json.updated_at).toBe(json.published_at);

    // D1 row exists.
    const row = await env.DB.prepare("SELECT * FROM published_artifacts WHERE share_token = ?")
      .bind(json.share_token).first();
    expect(row).toBeTruthy();
    expect((row as any).owner_user_id).toBe(u.id);
    expect((row as any).artifact_id).toBe("art_1");
    expect((row as any).unpublished_at).toBeNull();

    // R2 object exists with the right bytes.
    const obj = await env.ARTIFACTS.get(`published/${u.id}/${json.share_token}`);
    expect(obj).toBeTruthy();
    expect(await obj!.text()).toBe(body);
  });
});

describe("POST /api/publish/upload — re-publish (upsert)", () => {
  it("keeps share_token, refreshes bytes + mode, preserves published_at", async () => {
    const u = await seedUser();
    const firstBody = "v1";
    const first = await call(uploadRequest({
      cookieHeader: authHeader(u.sessionToken),
      metadata: metadataHeader({ artifact_id: "art_1", artifact_kind: "notes", mode: "open" }),
      contentType: "text/plain",
      contentLength: String(firstBody.length),
      body: firstBody,
    }));
    const firstJson = await first.json() as any;
    expect(first.status).toBe(200);

    // Wait a beat so updated_at can plausibly differ from published_at.
    await new Promise(r => setTimeout(r, 5));

    const secondBody = "v2 with hash";
    const second = await call(uploadRequest({
      cookieHeader: authHeader(u.sessionToken),
      metadata: metadataHeader({
        artifact_id: "art_1", artifact_kind: "notes",
        mode: "password", password_hash: "pbkdf2$100000$x$y",
      }),
      contentType: "text/plain",
      contentLength: String(secondBody.length),
      body: secondBody,
    }));
    expect(second.status).toBe(200);
    const secondJson = await second.json() as any;
    expect(secondJson.share_token).toBe(firstJson.share_token);  // stable
    expect(secondJson.mode).toBe("password");
    expect(secondJson.published_at).toBe(firstJson.published_at);  // preserved
    expect(secondJson.updated_at).toBeGreaterThanOrEqual(firstJson.updated_at);

    const obj = await env.ARTIFACTS.get(`published/${u.id}/${firstJson.share_token}`);
    expect(await obj!.text()).toBe(secondBody);

    const row = await env.DB.prepare("SELECT mode, password_hash FROM published_artifacts WHERE share_token = ?")
      .bind(firstJson.share_token).first<any>();
    expect(row.mode).toBe("password");
    expect(row.password_hash).toBe("pbkdf2$100000$x$y");
  });
});

describe("POST /api/publish/upload — cap enforcement", () => {
  it("returns 402 publish_cap_exceeded on 6th distinct artefact", async () => {
    const u = await seedUser();
    for (let i = 0; i < 5; i++) {
      const body = `body ${i}`;
      const res = await call(uploadRequest({
        cookieHeader: authHeader(u.sessionToken),
        metadata: metadataHeader({ artifact_id: `art_${i}`, artifact_kind: "notes", mode: "open" }),
        contentType: "text/plain",
        contentLength: String(body.length),
        body,
      }));
      expect(res.status).toBe(200);
    }
    const body = "boom";
    const res = await call(uploadRequest({
      cookieHeader: authHeader(u.sessionToken),
      metadata: metadataHeader({ artifact_id: "art_6", artifact_kind: "notes", mode: "open" }),
      contentType: "text/plain",
      contentLength: String(body.length),
      body,
    }));
    expect(res.status).toBe(402);
    const json = await res.json() as any;
    expect(json.error).toBe("publish_cap_exceeded");
    expect(json.current).toBe(5);
    expect(json.limit).toBe(5);
  });

  it("does not count unpublished rows toward the cap", async () => {
    const u = await seedUser();
    // Seed 5 unpublished rows directly.
    const now = Date.now();
    for (let i = 0; i < 5; i++) {
      const tok = `seeded_${i}`;
      await env.DB.prepare(
        `INSERT INTO published_artifacts
         (share_token, owner_user_id, artifact_id, artifact_kind, mode, password_hash,
          r2_key, content_type, size_bytes, published_at, updated_at, unpublished_at)
         VALUES (?, ?, ?, 'notes', 'open', NULL, ?, 'text/plain', 5, ?, ?, ?)`
      ).bind(tok, u.id, `seeded_art_${i}`, `published/${u.id}/${tok}`, now, now, now).run();
    }
    const body = "fresh";
    const res = await call(uploadRequest({
      cookieHeader: authHeader(u.sessionToken),
      metadata: metadataHeader({ artifact_id: "fresh_art", artifact_kind: "notes", mode: "open" }),
      contentType: "text/plain",
      contentLength: String(body.length),
      body,
    }));
    expect(res.status).toBe(200);
  });
});
```

- [ ] **Step 2: Implement steps 6–9 of `handlePublishUpload`.**

Replace the trailing `return jsonError(501, …)` with:

```ts
  // Step 6: find-or-claim final share_token.
  type ActiveRow = { share_token: string; published_at: number };
  const existing = await env.DB.prepare(
    `SELECT share_token, published_at FROM published_artifacts
      WHERE owner_user_id = ? AND artifact_id = ? AND unpublished_at IS NULL`
  ).bind(user.id, meta.artifact_id).first<ActiveRow>();

  let shareToken: string;
  let publishedAt: number;
  let path: "first-publish" | "upsert";

  if (existing) {
    shareToken = existing.share_token;
    publishedAt = existing.published_at;
    path = "upsert";
  } else {
    // Cap check before generating a token.
    const countRow = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM published_artifacts
        WHERE owner_user_id = ? AND unpublished_at IS NULL`
    ).bind(user.id).first<{ n: number }>();
    const current = countRow?.n ?? 0;
    if (current >= cap.max_active) {
      return jsonError(402, "publish_cap_exceeded",
        `Free tier allows ${cap.max_active} active published artefacts. Unpublish one first.`,
        { current, limit: cap.max_active });
    }

    // Generate token and try to claim it.
    const candidate = generateShareToken();
    const now = Date.now();
    try {
      await env.DB.prepare(
        `INSERT INTO published_artifacts
         (share_token, owner_user_id, artifact_id, artifact_kind, mode, password_hash,
          r2_key, content_type, size_bytes, published_at, updated_at, unpublished_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`
      ).bind(
        candidate, user.id, meta.artifact_id, meta.artifact_kind, meta.mode,
        meta.password_hash ?? null,
        r2KeyFor(user.id, candidate),
        req.headers.get("Content-Type") ?? "application/octet-stream",
        contentLength, now, now,
      ).run();
      shareToken = candidate;
      publishedAt = now;
      path = "first-publish";
    } catch (err) {
      // Race recovery: concurrent first-publish for the same (owner, artifact) won.
      // Re-SELECT and treat as upsert.
      const won = await env.DB.prepare(
        `SELECT share_token, published_at FROM published_artifacts
          WHERE owner_user_id = ? AND artifact_id = ? AND unpublished_at IS NULL`
      ).bind(user.id, meta.artifact_id).first<ActiveRow>();
      if (!won) {
        // Some other constraint failed; surface as 500.
        console.error("[publish] insert failed and no winning row found:", err);
        return jsonError(500, "internal_error");
      }
      shareToken = won.share_token;
      publishedAt = won.published_at;
      path = "upsert";
    }
  }

  // Step 7: stream body to R2 with size enforcement.
  const r2Key = r2KeyFor(user.id, shareToken);
  let putError: Error | null = null;
  try {
    const stream = req.body;
    if (!stream) {
      // No body; size 0 is allowed.
      await env.ARTIFACTS.put(r2Key, "", {
        httpMetadata: { contentType: req.headers.get("Content-Type") ?? "application/octet-stream" },
      });
    } else {
      const enforced = streamWithSizeCap(stream, cap.max_size_bytes);
      await env.ARTIFACTS.put(r2Key, enforced.stream, {
        httpMetadata: { contentType: req.headers.get("Content-Type") ?? "application/octet-stream" },
      });
      if (enforced.exceeded) {
        putError = new Error("artifact_too_large");
      }
    }
  } catch (err) {
    putError = err as Error;
  }

  if (putError) {
    // Rollback: delete the speculatively-inserted row only if first-publish.
    if (path === "first-publish") {
      await env.DB.prepare("DELETE FROM published_artifacts WHERE share_token = ?")
        .bind(shareToken).run();
    }
    // Best-effort R2 cleanup.
    try { await env.ARTIFACTS.delete(r2Key); } catch { /* swallow */ }

    if (putError.message === "artifact_too_large") {
      return jsonError(413, "artifact_too_large",
        "Free tier allows published artefacts up to 10 MB.",
        { limit_bytes: cap.max_size_bytes });
    }
    console.error("[publish] R2 put failed:", putError);
    return jsonError(502, "upload_failed");
  }

  // Step 8: D1 commit.
  const updatedAt = Date.now();
  if (path === "upsert") {
    await env.DB.prepare(
      `UPDATE published_artifacts
          SET mode = ?, password_hash = ?, content_type = ?, size_bytes = ?, updated_at = ?
        WHERE share_token = ?`
    ).bind(
      meta.mode, meta.password_hash ?? null,
      req.headers.get("Content-Type") ?? "application/octet-stream",
      contentLength, updatedAt, shareToken,
    ).run();
  } else {
    // First-publish: row already inserted; bump updated_at if R2 PUT took meaningful time.
    await env.DB.prepare(
      `UPDATE published_artifacts SET updated_at = ? WHERE share_token = ?`
    ).bind(updatedAt, shareToken).run();
  }

  // Step 9: respond.
  return jsonOk({
    share_token: shareToken,
    share_url: `https://oyster.to/p/${shareToken}`,
    mode: meta.mode,
    published_at: publishedAt,
    updated_at: updatedAt,
  });
}

// streamWithSizeCap wraps a ReadableStream so that if total bytes exceed `max`
// the stream errors out, the consumer (R2.put) aborts, and `exceeded` flips true.
function streamWithSizeCap(input: ReadableStream<Uint8Array>, max: number): {
  stream: ReadableStream<Uint8Array>;
  exceeded: boolean;
} {
  let total = 0;
  const handle = { exceeded: false };
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = input.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > max) {
            handle.exceeded = true;
            controller.error(new Error("artifact_too_large"));
            return;
          }
          controller.enqueue(value);
        }
        controller.close();
      } catch (err) {
        controller.error(err);
      }
    },
  });
  return { stream, get exceeded() { return handle.exceeded; } };
}
```

- [ ] **Step 3: Run the suite.**

```bash
npm test -- publish-handler
```

Expected: validation cases (Task 2.4) still pass, and the new first-publish, re-publish, cap, and unpublished-not-counted tests pass too.

- [ ] **Step 4: Commit.**

```bash
git add infra/oyster-publish/src/worker.ts \
        infra/oyster-publish/test/publish-handler.test.ts
git commit -m "feat(oyster-publish): publish_upload — find-or-claim, R2 PUT, D1 upsert (#315)"
```

---

### Task 2.7: Race recovery + cross-owner non-conflict + CHECK constraint tests

**Files:**
- Modify: `infra/oyster-publish/test/publish-handler.test.ts`

- [ ] **Step 1: Add the three remaining integration cases.**

Append:

```ts
describe("POST /api/publish/upload — race recovery", () => {
  it("two concurrent first-publishes return the same share_token, one D1 row, one R2 object", async () => {
    const u = await seedUser();
    const body = "racing";

    function call6() {
      return call(uploadRequest({
        cookieHeader: authHeader(u.sessionToken),
        metadata: metadataHeader({ artifact_id: "art_race", artifact_kind: "notes", mode: "open" }),
        contentType: "text/plain",
        contentLength: String(body.length),
        body,
      }));
    }

    const [r1, r2] = await Promise.all([call6(), call6()]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    const j1 = await r1.json() as any;
    const j2 = await r2.json() as any;
    expect(j1.share_token).toBe(j2.share_token);

    // Exactly one row.
    const rows = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM published_artifacts WHERE owner_user_id = ? AND artifact_id = ? AND unpublished_at IS NULL"
    ).bind(u.id, "art_race").first<{ n: number }>();
    expect(rows?.n).toBe(1);

    // R2 object exists at the winning token.
    const obj = await env.ARTIFACTS.get(`published/${u.id}/${j1.share_token}`);
    expect(obj).toBeTruthy();
  });
});

describe("POST /api/publish/upload — cross-owner non-conflict", () => {
  it("two users may publish artefacts that share an artifact_id without conflict", async () => {
    const a = await seedUser({ id: "user_a", email: "a@example.com" });
    const b = await seedUser({ id: "user_b", email: "b@example.com" });

    const body = "shared";
    const ra = await call(uploadRequest({
      cookieHeader: authHeader(a.sessionToken),
      metadata: metadataHeader({ artifact_id: "shared_id", artifact_kind: "notes", mode: "open" }),
      contentType: "text/plain",
      contentLength: String(body.length),
      body,
    }));
    const rb = await call(uploadRequest({
      cookieHeader: authHeader(b.sessionToken),
      metadata: metadataHeader({ artifact_id: "shared_id", artifact_kind: "notes", mode: "open" }),
      contentType: "text/plain",
      contentLength: String(body.length),
      body,
    }));
    expect(ra.status).toBe(200);
    expect(rb.status).toBe(200);
    const ja = await ra.json() as any;
    const jb = await rb.json() as any;
    expect(ja.share_token).not.toBe(jb.share_token);

    const rows = await env.DB.prepare(
      "SELECT owner_user_id FROM published_artifacts WHERE artifact_id = ? AND unpublished_at IS NULL ORDER BY owner_user_id"
    ).bind("shared_id").all<{ owner_user_id: string }>();
    expect(rows.results.map(r => r.owner_user_id)).toEqual(["user_a", "user_b"]);
  });
});

describe("POST /api/publish/upload — D1 CHECK enforcement", () => {
  it("rejects an open-mode publish that smuggles a password_hash", async () => {
    const u = await seedUser();
    const body = "x";
    const res = await call(uploadRequest({
      cookieHeader: authHeader(u.sessionToken),
      metadata: metadataHeader({
        artifact_id: "art_check", artifact_kind: "notes", mode: "open",
        password_hash: "pbkdf2$100000$x$y",  // illegal for open mode
      }),
      contentType: "text/plain",
      contentLength: String(body.length),
      body,
    }));
    // Caught by the handler's defence-in-depth (Task 2.5) before reaching D1.
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_metadata" });
  });
});

describe("POST /api/publish/upload — streamed-size enforcement", () => {
  it("aborts mid-stream when streamed bytes exceed cap despite Content-Length under cap", async () => {
    const u = await seedUser();
    const liedLength = 10;  // claim 10 bytes
    const realBody = new Uint8Array(11 * 1024 * 1024);  // actually send 11 MB
    realBody.fill(0x41);
    const res = await call(uploadRequest({
      cookieHeader: authHeader(u.sessionToken),
      metadata: metadataHeader({ artifact_id: "art_stream", artifact_kind: "notes", mode: "open" }),
      contentType: "application/octet-stream",
      contentLength: String(liedLength),
      body: realBody,
    }));
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ error: "artifact_too_large" });
    // No D1 row left behind.
    const row = await env.DB.prepare(
      "SELECT * FROM published_artifacts WHERE owner_user_id = ? AND artifact_id = ?"
    ).bind(u.id, "art_stream").first();
    expect(row).toBeNull();
  });
});
```

- [ ] **Step 2: Run the suite.**

```bash
npm test -- publish-handler
```

Expected: all describe blocks pass.

- [ ] **Step 3: Commit.**

```bash
git add infra/oyster-publish/test/publish-handler.test.ts
git commit -m "test(oyster-publish): race recovery + cross-owner + CHECK + stream-cap (#315)"
```

---

### Task 2.8: Implement `handlePublishDelete`

**Files:**
- Modify: `infra/oyster-publish/src/worker.ts`
- Create: `infra/oyster-publish/test/unpublish-handler.test.ts`

- [ ] **Step 1: Write the unpublish tests.**

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/worker";
import { applySchema, seedUser, seedActivePublication, authHeader, metadataHeader } from "./fixtures/seed";

beforeEach(async () => {
  await applySchema();
});

async function call(req: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(req, env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

function deleteRequest(token: string, sessionToken?: string): Request {
  const headers = new Headers();
  if (sessionToken) headers.set("Cookie", `oyster_session=${sessionToken}`);
  return new Request(`https://oyster.to/api/publish/${token}`, { method: "DELETE", headers });
}

describe("DELETE /api/publish/:share_token", () => {
  it("returns 401 sign_in_required without a session cookie", async () => {
    const res = await call(deleteRequest("anytoken"));
    expect(res.status).toBe(401);
  });

  it("returns 404 publication_not_found for an unknown token", async () => {
    const u = await seedUser();
    const res = await call(deleteRequest("ghost", u.sessionToken));
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "publication_not_found" });
  });

  it("returns 403 not_publication_owner when caller is not the owner", async () => {
    const owner = await seedUser({ id: "owner", email: "owner@example.com" });
    const stranger = await seedUser({ id: "stranger", email: "stranger@example.com" });
    const tok = await seedActivePublication({ ownerUserId: owner.id, artifactId: "art_x" });
    const res = await call(deleteRequest(tok, stranger.sessionToken));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "not_publication_owner" });
  });

  it("returns 200 and marks unpublished_at on first call", async () => {
    const u = await seedUser();
    const tok = await seedActivePublication({ ownerUserId: u.id, artifactId: "art_x" });
    // Seed an R2 object so we can verify the delete.
    await env.ARTIFACTS.put(`published/${u.id}/${tok}`, "bytes");

    const res = await call(deleteRequest(tok, u.sessionToken));
    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(json.ok).toBe(true);
    expect(json.share_token).toBe(tok);
    expect(json.unpublished_at).toBeTypeOf("number");

    const row = await env.DB.prepare("SELECT unpublished_at FROM published_artifacts WHERE share_token = ?")
      .bind(tok).first<{ unpublished_at: number | null }>();
    expect(row?.unpublished_at).toBeTypeOf("number");

    const obj = await env.ARTIFACTS.get(`published/${u.id}/${tok}`);
    expect(obj).toBeNull();
  });

  it("is idempotent on a second call (already unpublished)", async () => {
    const u = await seedUser();
    const tok = await seedActivePublication({ ownerUserId: u.id, artifactId: "art_x" });
    await call(deleteRequest(tok, u.sessionToken));
    const second = await call(deleteRequest(tok, u.sessionToken));
    expect(second.status).toBe(200);
    const json = await second.json() as any;
    expect(json.ok).toBe(true);
  });
});

describe("publish → unpublish → publish round-trip", () => {
  // This test crosses both handlers; it lives here because the lifecycle is
  // anchored by unpublish (without it, the second publish would be an upsert).
  it("issues a new share_token after unpublish; old R2 object gone, new R2 object present", async () => {
    const u = await seedUser();
    const body = "first-bytes";

    // 1. First publish via the handler so we get a real generated token.
    const headers = new Headers();
    headers.set("Cookie", `oyster_session=${u.sessionToken}`);
    headers.set("X-Publish-Metadata", Buffer.from(JSON.stringify({
      artifact_id: "art_cycle", artifact_kind: "notes", mode: "open",
    })).toString("base64url"));
    headers.set("Content-Type", "text/plain");
    headers.set("Content-Length", String(body.length));
    const first = await call(new Request("https://oyster.to/api/publish/upload", {
      method: "POST", headers, body,
    }));
    expect(first.status).toBe(200);
    const firstJson = await first.json() as { share_token: string };

    // 2. Unpublish.
    const del = await call(deleteRequest(firstJson.share_token, u.sessionToken));
    expect(del.status).toBe(200);

    // 3. Republish.
    const second = await call(new Request("https://oyster.to/api/publish/upload", {
      method: "POST", headers, body: "second-bytes",
    }));
    expect(second.status).toBe(200);
    const secondJson = await second.json() as { share_token: string; share_url: string };

    // New token (not the same as first).
    expect(secondJson.share_token).not.toBe(firstJson.share_token);

    // Old R2 object gone (deleted by unpublish).
    const oldObj = await env.ARTIFACTS.get(`published/${u.id}/${firstJson.share_token}`);
    expect(oldObj).toBeNull();

    // New R2 object present with new bytes.
    const newObj = await env.ARTIFACTS.get(`published/${u.id}/${secondJson.share_token}`);
    expect(newObj).toBeTruthy();
    expect(await newObj!.text()).toBe("second-bytes");

    // Old D1 row marked unpublished; new row live.
    const oldRow = await env.DB.prepare("SELECT unpublished_at FROM published_artifacts WHERE share_token = ?")
      .bind(firstJson.share_token).first<{ unpublished_at: number | null }>();
    expect(oldRow?.unpublished_at).toBeTypeOf("number");
    const newRow = await env.DB.prepare("SELECT unpublished_at FROM published_artifacts WHERE share_token = ?")
      .bind(secondJson.share_token).first<{ unpublished_at: number | null }>();
    expect(newRow?.unpublished_at).toBeNull();
  });
});
```

- [ ] **Step 2: Implement `handlePublishDelete`.**

Replace the stub in `worker.ts`:

```ts
async function handlePublishDelete(req: Request, env: Env, shareToken: string): Promise<Response> {
  const user = await resolveSession(req, env);
  if (!user) return jsonError(401, "sign_in_required");

  type Row = { owner_user_id: string; r2_key: string; unpublished_at: number | null };
  const row = await env.DB.prepare(
    "SELECT owner_user_id, r2_key, unpublished_at FROM published_artifacts WHERE share_token = ?"
  ).bind(shareToken).first<Row>();

  if (!row) return jsonError(404, "publication_not_found");
  if (row.owner_user_id !== user.id) return jsonError(403, "not_publication_owner");

  if (row.unpublished_at !== null) {
    return jsonOk({ ok: true, share_token: shareToken, unpublished_at: row.unpublished_at });
  }

  const now = Date.now();
  await env.DB.prepare("UPDATE published_artifacts SET unpublished_at = ? WHERE share_token = ?")
    .bind(now, shareToken).run();

  // Best-effort R2 delete; D1 is the source of truth.
  try { await env.ARTIFACTS.delete(row.r2_key); } catch (err) {
    console.warn("[publish] R2 delete failed (orphan accepted):", err);
  }

  return jsonOk({ ok: true, share_token: shareToken, unpublished_at: now });
}
```

- [ ] **Step 3: Run the suite.**

```bash
npm test
```

Expected: all publish + unpublish describe blocks pass (publish-handler.test.ts and unpublish-handler.test.ts).

- [ ] **Step 4: Commit.**

```bash
git add infra/oyster-publish/src/worker.ts \
        infra/oyster-publish/test/unpublish-handler.test.ts
git commit -m "feat(oyster-publish): unpublish endpoint + tests (#315)"
```

---

### Task 2.9: Deploy + smoke test against the live Worker

**Files:** none.

- [ ] **Step 1: Deploy.**

```bash
cd infra/oyster-publish
npm run deploy
```

- [ ] **Step 2: Smoke-test publish.**

You need a real `oyster_session` cookie value. Sign in once at `https://oyster.to/auth/sign-in` in a browser, then copy the `oyster_session` cookie value (DevTools → Application → Cookies → `oyster.to`).

```bash
SESSION=<paste-here>
META=$(printf '%s' '{"artifact_id":"smoke_test","artifact_kind":"notes","mode":"open"}' | base64 | tr '+/' '-_' | tr -d '=')
echo "# Hello from smoke test" > /tmp/smoke.md
curl -s -X POST https://oyster.to/api/publish/upload \
  -H "Cookie: oyster_session=$SESSION" \
  -H "X-Publish-Metadata: $META" \
  -H "Content-Type: text/markdown" \
  --data-binary @/tmp/smoke.md
```

Expected: `{"share_token":"…","share_url":"https://oyster.to/p/…","mode":"open","published_at":…,"updated_at":…}`.

- [ ] **Step 3: Verify D1 + R2.**

```bash
SHARE_TOKEN=<from step 2 response>
wrangler d1 execute oyster-auth --remote --command "SELECT share_token, owner_user_id, mode, size_bytes FROM published_artifacts WHERE share_token = '$SHARE_TOKEN';"
wrangler r2 object get oyster-artifacts published/<your-user-id>/$SHARE_TOKEN -- /tmp/check.md
diff /tmp/smoke.md /tmp/check.md && echo "R2 bytes match"
```

- [ ] **Step 4: Smoke-test unpublish.**

```bash
curl -s -X DELETE https://oyster.to/api/publish/$SHARE_TOKEN \
  -H "Cookie: oyster_session=$SESSION"
```

Expected: `{"ok":true,"share_token":"…","unpublished_at":…}`.

- [ ] **Step 5: Confirm `unpublished_at` set + R2 object gone.**

```bash
wrangler d1 execute oyster-auth --remote --command "SELECT unpublished_at FROM published_artifacts WHERE share_token = '$SHARE_TOKEN';"
wrangler r2 object get oyster-artifacts published/<your-user-id>/$SHARE_TOKEN -- /tmp/should-fail.md 2>&1 || echo "R2 object deleted (expected)"
```

(No commit.)

---

### Task 2.10: Open Phase 2 PR

**Files:** none.

- [ ] **Step 1: Push.**

```bash
git push
```

- [ ] **Step 2: Open the PR.**

```bash
gh pr create --title "feat(publish): Worker upload + unpublish endpoints (#315 PR 2/3)" --body "$(cat <<'EOF'
## Summary

- `POST /api/publish/upload`: full spec implementation — auth, metadata parse, password presence check, Content-Length + tier-cap pre-check, find-or-claim with race recovery on the partial unique index, streamed R2 upload with size cap (defence against lying Content-Length), D1 upsert, response with stable token.
- `DELETE /api/publish/:share_token`: idempotent unpublish; updates `unpublished_at`, best-effort R2 delete.
- Vitest pool-workers integration suite covers: auth, metadata validation, first publish, re-publish (stable token + bytes refresh + mode change), cap (with unpublished rows correctly ignored), race recovery, cross-owner non-conflict, streamed-size enforcement, owner-scoped delete, idempotent delete.

Spec: `docs/superpowers/specs/2026-05-03-r5-publish-backend-design.md`.
Plan: `docs/superpowers/plans/2026-05-03-r5-publish-backend.md`.

## Test plan

- [ ] `cd infra/oyster-publish && npm test` passes.
- [ ] Smoke test from the plan (Task 2.9) round-trips publish → row + R2 object exist → unpublish → `unpublished_at` set → R2 object gone.
- [ ] `oyster.to/p/anything` still returns `501` (viewer is #316).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 3: Pause for review/merge before Phase 3.**

---

## Phase 3 — Local server + MCP tool (PR 3)

End state: an Oyster user (signed in) calling `publish_artifact` via MCP — or hitting `POST /api/artifacts/:id/publish` from the web UI — gets a working `share_url` from the deployed Worker. Local SQLite mirrors the response. CHANGELOG entry under `[Unreleased]`.

### Task 3.1: Local SQLite migration — `share_updated_at`

**Files:**
- Modify: `server/src/db.ts`

- [ ] **Step 1: Find the existing R5 column ALTERs (added in #314) and add the new one alongside.**

Search for `share_token` in `server/src/db.ts`. Add the new ALTER in the same try/catch block pattern (idempotent — the codebase convention is to swallow "duplicate column" errors so re-running on a populated DB is safe):

```ts
try { db.prepare(`ALTER TABLE artifacts ADD COLUMN share_updated_at INTEGER`).run(); } catch { /* idempotent */ }
```

- [ ] **Step 2: Restart the dev server and verify schema.**

```bash
cd ~/Dev/oyster-os.worktrees/315-r5-publish-backend
npm run dev   # in another terminal
# In the first terminal:
sqlite3 ./userland/db/oyster.db "SELECT name FROM pragma_table_info('artifacts') WHERE name='share_updated_at';"
```

Expected: one row with `name=share_updated_at`. Stop the dev server.

- [ ] **Step 3: Commit.**

```bash
git add server/src/db.ts
git commit -m "feat(server): artifacts.share_updated_at for R5 publish mirror (#315)"
```

---

### Task 3.2: `password-hash.ts` — Node PBKDF2 helper (TDD)

**Files:**
- Create: `server/src/password-hash.ts`
- Create: `server/test/password-hash.test.ts`

- [ ] **Step 1: Write failing tests.**

```ts
// server/test/password-hash.test.ts
import { describe, it, expect } from "vitest";
import { hashPassword } from "../src/password-hash";

describe("hashPassword", () => {
  it("returns format pbkdf2$100000$<salt>$<hash>", async () => {
    const h = await hashPassword("hunter2");
    const parts = h.split("$");
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe("pbkdf2");
    expect(parts[1]).toBe("100000");
    expect(parts[2]).toMatch(/^[A-Za-z0-9_-]+$/);  // base64url salt
    expect(parts[3]).toMatch(/^[A-Za-z0-9_-]+$/);  // base64url hash
  });

  it("uses a different salt each call (so identical plaintexts hash differently)", async () => {
    const a = await hashPassword("same");
    const b = await hashPassword("same");
    expect(a).not.toBe(b);
  });

  it("rejects empty plaintext", async () => {
    await expect(hashPassword("")).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Add Vitest to `server/` if not already wired.**

Check `server/package.json`. If `vitest` is not in `devDependencies`, add it and a `test` script:

```bash
cd server
npm install --save-dev vitest@^2.1.0
```

Then add to `package.json` scripts:

```json
"test": "vitest run"
```

(Skip this step if Vitest is already configured.)

- [ ] **Step 3: Run tests to verify they fail.**

```bash
cd server
npm test -- password-hash
```

Expected: cannot find module `../src/password-hash`.

- [ ] **Step 4: Implement.**

```ts
// server/src/password-hash.ts — PBKDF2-SHA256 password hashing.
// Format: pbkdf2$<iter>$<salt_b64url>$<hash_b64url>
// Verifier (Web Crypto in oyster-publish viewer #316) reads the same format.

import { pbkdf2, randomBytes } from "node:crypto";
import { promisify } from "node:util";

const pbkdf2Async = promisify(pbkdf2);

const ITERATIONS = 100_000;
const SALT_BYTES = 16;
const HASH_BYTES = 32;

export async function hashPassword(plaintext: string): Promise<string> {
  if (plaintext.length === 0) throw new Error("password_required");
  const salt = randomBytes(SALT_BYTES);
  const hash = await pbkdf2Async(plaintext, salt, ITERATIONS, HASH_BYTES, "sha256");
  return `pbkdf2$${ITERATIONS}$${b64url(salt)}$${b64url(hash)}`;
}

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}
```

- [ ] **Step 5: Run tests to verify they pass.**

```bash
npm test -- password-hash
```

Expected: 3 tests pass.

- [ ] **Step 6: Commit.**

```bash
git add server/src/password-hash.ts server/test/password-hash.test.ts \
        server/package.json server/package-lock.json
git commit -m "feat(server): PBKDF2 password hash helper for publish (#315)"
```

---

### Task 3.3: `publish-service.ts` — internal helper (TDD against a mocked Worker)

**Files:**
- Create: `server/src/publish-service.ts`
- Create: `server/test/publish-service.test.ts`

The service is the single place that knows the Worker URL, applies owner-attribution to local SQLite, and mirrors the Worker response into the `artifacts` row. Both the HTTP route and the MCP tool import from it.

- [ ] **Step 1: Write failing tests.**

```ts
// server/test/publish-service.test.ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { createPublishService } from "../src/publish-service";

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
      // Assert the request shape.
      const headers = new Headers(init.headers);
      expect(headers.get("Cookie")).toBe("oyster_session=s1");
      expect(headers.get("Content-Type")).toBe("application/octet-stream");
      const meta = headers.get("X-Publish-Metadata");
      expect(meta).toBeTruthy();
      const decoded = JSON.parse(Buffer.from(meta!, "base64url").toString());
      expect(decoded.artifact_id).toBe("art_1");
      expect(decoded.mode).toBe("password");
      expect(decoded.password_hash).toBe("pbkdf2$test");
      // The plaintext password must never appear anywhere in the proxied request.
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
    expect(row.owner_id).toBe("u1");                 // set on first publish
    expect(row.share_token).toBe("tok123");
    expect(row.share_mode).toBe("password");
    expect(row.share_password_hash).toBe("pbkdf2$test");
    expect(row.published_at).toBe(1700000000000);    // from response
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
```

- [ ] **Step 2: Run the tests to verify they fail.**

```bash
npm test -- publish-service
```

Expected: cannot find module `../src/publish-service`.

- [ ] **Step 3: Implement.**

```ts
// server/src/publish-service.ts — single source of truth for publish/unpublish.
// Called by both routes/publish.ts (HTTP) and mcp-server.ts (MCP tool).

import type Database from "better-sqlite3";

export interface PublishUser {
  id: string;
  email: string;
}

export interface PublishServiceDeps {
  db: Database.Database;
  readArtifactBytes: (artifactId: string) => Promise<Uint8Array>;
  currentUser: () => PublishUser | null;
  sessionToken: () => string | null;
  workerBase: string;        // e.g. "https://oyster.to"
  hashPassword: (plaintext: string) => Promise<string>;
  fetch: typeof fetch;
}

export interface PublishArgs {
  artifact_id: string;
  mode: "open" | "password" | "signin";
  password?: string;
}

export interface PublishResult {
  share_token: string;
  share_url: string;
  mode: "open" | "password" | "signin";
  published_at: number;
  updated_at: number;
}

export interface UnpublishResult {
  ok: true;
  share_token: string;
  unpublished_at: number;
}

export class PublishError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export interface PublishService {
  publishArtifact(args: PublishArgs): Promise<PublishResult>;
  unpublishArtifact(args: { artifact_id: string }): Promise<UnpublishResult>;
}

interface ArtifactRow {
  id: string;
  kind: string;
  owner_id: string | null;
  share_token: string | null;
  unpublished_at: number | null;
}

export function createPublishService(deps: PublishServiceDeps): PublishService {
  return {
    async publishArtifact(args) {
      const user = deps.currentUser();
      const token = deps.sessionToken();
      if (!user || !token) throw new PublishError(401, "sign_in_required", "Sign in to publish artefacts.");

      const row = deps.db.prepare(
        "SELECT id, kind, owner_id, share_token, unpublished_at FROM artifacts WHERE id = ?"
      ).get(args.artifact_id) as ArtifactRow | undefined;
      if (!row) throw new PublishError(404, "artifact_not_found", `No artefact with id ${args.artifact_id}`);

      if (row.owner_id !== null && row.owner_id !== user.id) {
        throw new PublishError(403, "not_artifact_owner", "This artefact belongs to a different account.");
      }

      if (args.mode === "password" && (!args.password || args.password.length === 0)) {
        throw new PublishError(400, "password_required", "Password mode requires a non-empty password.");
      }

      const passwordHash = args.mode === "password" ? await deps.hashPassword(args.password!) : undefined;
      const bytes = await deps.readArtifactBytes(args.artifact_id);

      const meta = {
        artifact_id: args.artifact_id,
        artifact_kind: row.kind,
        mode: args.mode,
        ...(passwordHash ? { password_hash: passwordHash } : {}),
      };
      const metaHeader = Buffer.from(JSON.stringify(meta)).toString("base64url");

      const res = await deps.fetch(`${deps.workerBase}/api/publish/upload`, {
        method: "POST",
        headers: {
          Cookie: `oyster_session=${token}`,
          "X-Publish-Metadata": metaHeader,
          "Content-Type": "application/octet-stream",
          "Content-Length": String(bytes.byteLength),
        },
        body: bytes,
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as Record<string, unknown>;
        const code = (typeof body.error === "string" ? body.error : "upload_failed");
        const { error: _e, message: _m, ...details } = body;
        throw new PublishError(res.status, code, (body.message as string) ?? code, details);
      }

      const result = await res.json() as PublishResult;

      // Mirror response into local SQLite. owner_id set on first publish.
      const ownerToSet = row.owner_id ?? user.id;
      deps.db.prepare(
        `UPDATE artifacts
            SET owner_id = ?, share_token = ?, share_mode = ?, share_password_hash = ?,
                published_at = ?, share_updated_at = ?, unpublished_at = NULL
          WHERE id = ?`
      ).run(
        ownerToSet, result.share_token, result.mode, passwordHash ?? null,
        result.published_at, result.updated_at, args.artifact_id,
      );

      return result;
    },

    async unpublishArtifact({ artifact_id }) {
      const user = deps.currentUser();
      const token = deps.sessionToken();
      if (!user || !token) throw new PublishError(401, "sign_in_required", "Sign in to unpublish artefacts.");

      const row = deps.db.prepare(
        "SELECT id, owner_id, share_token, unpublished_at FROM artifacts WHERE id = ?"
      ).get(artifact_id) as ArtifactRow | undefined;
      if (!row) throw new PublishError(404, "artifact_not_found");
      if (row.owner_id && row.owner_id !== user.id) {
        throw new PublishError(403, "not_publication_owner");
      }
      if (!row.share_token || row.unpublished_at !== null) {
        throw new PublishError(404, "publication_not_found");
      }

      const res = await deps.fetch(`${deps.workerBase}/api/publish/${row.share_token}`, {
        method: "DELETE",
        headers: { Cookie: `oyster_session=${token}` },
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as Record<string, unknown>;
        const code = (typeof body.error === "string" ? body.error : "unpublish_failed");
        throw new PublishError(res.status, code, (body.message as string) ?? code);
      }

      const result = await res.json() as UnpublishResult;
      deps.db.prepare(
        `UPDATE artifacts SET unpublished_at = ? WHERE id = ?`
      ).run(result.unpublished_at, artifact_id);

      return result;
    },
  };
}
```

- [ ] **Step 4: Run the tests.**

```bash
npm test -- publish-service
```

Expected: all 7 tests pass.

- [ ] **Step 5: Commit.**

```bash
git add server/src/publish-service.ts server/test/publish-service.test.ts
git commit -m "feat(server): publish-service with owner attribution + response mirror (#315)"
```

---

### Task 3.4: `routes/publish.ts` — HTTP routes

**Files:**
- Create: `server/src/routes/publish.ts`
- Modify: `server/src/index.ts`

- [ ] **Step 1: Write the route handler.**

```ts
// server/src/routes/publish.ts — POST/DELETE /api/artifacts/:id/publish
// Thin glue layer over publish-service. Same precedent as routes/auth.ts.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { PublishService, PublishError } from "../publish-service.js";
import type { RouteCtx } from "../http-utils.js";

export interface PublishRouteDeps {
  publishService: PublishService;
}

const PATH_RE = /^\/api\/artifacts\/([^/]+)\/publish$/;

export async function tryHandlePublishRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: string,
  ctx: RouteCtx,
  deps: PublishRouteDeps,
): Promise<boolean> {
  const m = url.match(PATH_RE);
  if (!m) return false;
  const artifactId = decodeURIComponent(m[1]);
  const { sendJson, rejectIfNonLocalOrigin, readJsonBody } = ctx;

  if (req.method === "POST") {
    if (rejectIfNonLocalOrigin()) return true;
    const body = await readJsonBody<{ mode?: string; password?: string }>(req);
    const mode = body?.mode;
    if (mode !== "open" && mode !== "password" && mode !== "signin") {
      sendJson({ error: "invalid_mode", message: "mode must be open, password, or signin" }, 400);
      return true;
    }
    try {
      const result = await deps.publishService.publishArtifact({
        artifact_id: artifactId,
        mode,
        password: body?.password,
      });
      sendJson(result);
    } catch (err) {
      writePublishError(sendJson, err);
    }
    return true;
  }

  if (req.method === "DELETE") {
    if (rejectIfNonLocalOrigin()) return true;
    try {
      const result = await deps.publishService.unpublishArtifact({ artifact_id: artifactId });
      sendJson(result);
    } catch (err) {
      writePublishError(sendJson, err);
    }
    return true;
  }

  return false;
}

function writePublishError(sendJson: RouteCtx["sendJson"], err: unknown): void {
  if (err && typeof err === "object" && "status" in err && "code" in err) {
    const e = err as PublishError;
    sendJson({ error: e.code, message: e.message, ...e.details }, e.status);
    return;
  }
  console.error("[publish] unexpected error:", err);
  sendJson({ error: "internal_error" }, 500);
}
```

- [ ] **Step 2: Wire the route into `server/src/index.ts`.**

Find where `tryHandleAuthRoute` is called (look for `routes/auth`). Add the publish wiring next to it:

1. At the top with the other route imports:
   ```ts
   import { tryHandlePublishRoute } from "./routes/publish.js";
   import { createPublishService } from "./publish-service.js";
   import { hashPassword } from "./password-hash.js";
   import { readFileSync } from "node:fs";
   ```

2. After `authService` is constructed, build the publish service:
   ```ts
   const WORKER_BASE = process.env.OYSTER_AUTH_BASE ?? "https://oyster.to";
   const publishService = createPublishService({
     db,
     readArtifactBytes: async (artifactId) => {
       // The artefact's content_path is set by createArtifact. For 0.7.0
       // single-file scope, read it directly off disk.
       const row = db.prepare("SELECT content_path FROM artifacts WHERE id = ?")
         .get(artifactId) as { content_path: string | null } | undefined;
       if (!row?.content_path) throw new Error(`artefact ${artifactId} has no content_path`);
       return new Uint8Array(readFileSync(row.content_path));
     },
     currentUser: () => {
       const u = authService.getState().user;
       return u ? { id: u.id, email: u.email } : null;
     },
     sessionToken: () => authService.getState().sessionToken,
     workerBase: WORKER_BASE,
     hashPassword,
     fetch,
   });
   ```

3. Inside the request router (next to `tryHandleAuthRoute(...)`):
   ```ts
   if (await tryHandlePublishRoute(req, res, url, ctx, { publishService })) return;
   ```

(If `WORKER_BASE` already exists from `auth-service`, reuse the same constant rather than redeclaring.)

- [ ] **Step 3: Manual smoke from the worktree.**

```bash
cd ~/Dev/oyster-os.worktrees/315-r5-publish-backend
npm run dev
# In another terminal:
# Sign in via the web UI at http://localhost:7337 (Vite proxies to 3333).
# Then create an artefact via the UI, copy its id from the URL.
# Then:
ARTIFACT_ID=<paste>
curl -s -X POST "http://localhost:3333/api/artifacts/$ARTIFACT_ID/publish" \
  -H "Content-Type: application/json" \
  -d '{"mode":"open"}'
```

Expected: JSON `{"share_token":"…","share_url":"…","mode":"open","published_at":…,"updated_at":…}`. If you get `not_artifact_owner`, this is a previously-created artefact whose `owner_id` is non-NULL and points at a different user; create a new one and try again.

- [ ] **Step 4: Commit.**

```bash
git add server/src/routes/publish.ts server/src/index.ts
git commit -m "feat(server): /api/artifacts/:id/publish HTTP routes (#315)"
```

---

### Task 3.5: MCP tool registration

**Files:**
- Modify: `server/src/mcp-server.ts`

- [ ] **Step 1: Find the tool-registration block.**

Search `mcp-server.ts` for `tool(` or `registerTool` to locate the existing tool definitions. The convention is `server.tool("name", { schema }, async (input) => {...})` or similar — match the existing style.

- [ ] **Step 2: Register `publish_artifact`.**

Add inside the tool-registration block (adapt to the existing pattern — the snippet below is the expected shape):

```ts
server.tool(
  "publish_artifact",
  {
    description: "Publish an artefact to a public share URL. Mode 'open' = anyone with the link; 'password' = link plus shared password (you must supply `password`); 'signin' = viewer must be signed into a free Oyster account. Returns a stable share_token and share_url; calling again on the same artefact upserts (same URL, fresh bytes + mode).",
    inputSchema: {
      type: "object",
      properties: {
        artifact_id:  { type: "string", description: "The local artefact id (uuid)." },
        mode:         { type: "string", enum: ["open", "password", "signin"] },
        password:     { type: "string", description: "Required and non-empty when mode='password'." },
      },
      required: ["artifact_id", "mode"],
    },
  },
  async (input: { artifact_id: string; mode: "open" | "password" | "signin"; password?: string }) => {
    try {
      const result = await deps.publishService.publishArtifact(input);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      const e = err as { status?: number; code?: string; message?: string; details?: Record<string, unknown> };
      return {
        isError: true,
        content: [{
          type: "text",
          text: JSON.stringify({
            error: e.code ?? "internal_error",
            message: e.message,
            ...(e.details ?? {}),
          }, null, 2),
        }],
      };
    }
  },
);
```

- [ ] **Step 3: Register `unpublish_artifact` (same shape, simpler input).**

```ts
server.tool(
  "unpublish_artifact",
  {
    description: "Retire a previously-published artefact. The share URL returns 410. Republishing later issues a new token.",
    inputSchema: {
      type: "object",
      properties: {
        artifact_id: { type: "string", description: "The local artefact id (uuid)." },
      },
      required: ["artifact_id"],
    },
  },
  async (input: { artifact_id: string }) => {
    try {
      const result = await deps.publishService.unpublishArtifact(input);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      const e = err as { status?: number; code?: string; message?: string };
      return {
        isError: true,
        content: [{
          type: "text",
          text: JSON.stringify({ error: e.code ?? "internal_error", message: e.message }, null, 2),
        }],
      };
    }
  },
);
```

- [ ] **Step 4: Add `publishService` to the `McpDeps` interface.**

Find the existing `McpDeps` interface in `mcp-server.ts` and add:

```ts
publishService: import("./publish-service.js").PublishService;
```

- [ ] **Step 5: Pass `publishService` through to MCP construction in `index.ts`.**

Find where MCP server is constructed (search for `McpDeps` in `index.ts`) and add `publishService` to the deps object passed in.

- [ ] **Step 6: Manual MCP smoke.**

Restart `npm run dev`. From another terminal:

```bash
curl -s http://localhost:3333/mcp/list-tools | grep -E '"name":"(publish|unpublish)_artifact"'
```

Expected: both tool names appear. (The exact endpoint may differ — check the existing MCP route to confirm the listing path.)

- [ ] **Step 7: Commit.**

```bash
git add server/src/mcp-server.ts server/src/index.ts
git commit -m "feat(mcp): publish_artifact + unpublish_artifact tools (#315)"
```

---

### Task 3.6: End-to-end smoke test against deployed Worker

**Files:** none.

- [ ] **Step 1: Sign in via the dev UI.**

Start `npm run dev`. Open `http://localhost:7337/auth/sign-in`, complete the GitHub OAuth flow, return to the app.

- [ ] **Step 2: Create an artefact.**

In the chat bar, ask the agent to create a markdown artefact in the current space, e.g. *"create a notes artefact called 'publish smoke' with content '# Hello R5 publish'"*.

- [ ] **Step 3: Ask the agent to publish it.**

*"publish this artefact"* — the agent should call `publish_artifact`. Observe in the dev console / SSE stream:

Expected: a JSON response with `share_token`, `share_url`, `mode: "open"`. The share_url is `https://oyster.to/p/<token>`.

- [ ] **Step 4: Verify cloud state.**

```bash
SHARE_TOKEN=<from step 3>
wrangler d1 execute oyster-auth --remote --command "SELECT share_token, owner_user_id, mode, size_bytes FROM published_artifacts WHERE share_token='$SHARE_TOKEN';"
```

Expected: one row with the right owner.

- [ ] **Step 5: Verify local mirror.**

```bash
sqlite3 ./userland/db/oyster.db "SELECT id, owner_id, share_token, share_mode, published_at, share_updated_at FROM artifacts WHERE share_token='$SHARE_TOKEN';"
```

Expected: matching row, `owner_id` set, `share_updated_at` matches the cloud's `updated_at`.

- [ ] **Step 6: Ask the agent to unpublish.**

*"unpublish that artefact"* — observe `{"ok":true,"share_token":"…","unpublished_at":…}`.

- [ ] **Step 7: Verify both stores reflect the unpublish.**

```bash
wrangler d1 execute oyster-auth --remote --command "SELECT unpublished_at FROM published_artifacts WHERE share_token='$SHARE_TOKEN';"
sqlite3 ./userland/db/oyster.db "SELECT share_token, unpublished_at FROM artifacts WHERE share_token='$SHARE_TOKEN';"
```

Expected: cloud has `unpublished_at` set; local row retains `share_token` and has `unpublished_at` set (per spec — local mirror keeps the retired token).

(No commit.)

---

### Task 3.7: CHANGELOG entry

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Add an entry under `[Unreleased] / Added`.**

```markdown
- **Publish artefacts.** Turn any single-file artefact into a `oyster.to/p/...` share URL via the chat bar — open, password-protected, or sign-in-required. Free accounts can publish up to 5 artefacts at a time.
```

(Bullet style: user-visible outcome, no file paths or MCP tool names — per `feedback_changelog_style.md`.)

- [ ] **Step 2: Regenerate the rendered changelog.**

```bash
npm run build:changelog
```

- [ ] **Step 3: Commit.**

```bash
git add CHANGELOG.md docs/changelog.html
git commit -m "docs(changelog): publish artefacts (#315)"
```

---

### Task 3.8: Open Phase 3 PR

**Files:** none.

- [ ] **Step 1: Push.**

```bash
git push
```

- [ ] **Step 2: Open the PR.**

```bash
gh pr create --title "feat(publish): MCP tools + local server route + SQLite mirror (#315 PR 3/3)" --body "$(cat <<'EOF'
## Summary

- New MCP tools: `publish_artifact({artifact_id, mode, password?})` and `unpublish_artifact({artifact_id})`.
- New HTTP routes: `POST /api/artifacts/:id/publish` and `DELETE /api/artifacts/:id/publish`.
- Local `artifacts` row mirrors the cloud response — `share_token`, `share_mode`, `share_password_hash`, `published_at`, `share_updated_at`, `unpublished_at` — using the Worker's timestamps verbatim. `owner_id` is set on first publish; subsequent publishes by a different account are rejected 403.
- Plaintext password is hashed locally (PBKDF2-SHA256, 100k iter) and only the hash crosses the wire.
- CHANGELOG entry under [Unreleased].

Closes #315.

Spec: `docs/superpowers/specs/2026-05-03-r5-publish-backend-design.md`.
Plan: `docs/superpowers/plans/2026-05-03-r5-publish-backend.md`.

## Test plan

- [ ] `cd server && npm test` passes (publish-service + password-hash).
- [ ] End-to-end smoke from the plan (Task 3.6) round-trips publish → cloud + local mirror match → unpublish → both reflect retirement.
- [ ] No regression in existing `/api/auth/*` or other extracted routes.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Decisions (encoded in this plan, recap from spec)

- One Worker per concern: `oyster-publish` is separate from `oyster-auth` for blast-radius isolation, even though they share a D1 binding.
- Race recovery via INSERT-then-recover: simpler than locking, atomic via the partial unique index, cheap because the race is rare.
- Local SQLite uses Worker timestamps verbatim — no clock-drift between local and cloud.
- Pure helpers split out for unit testing; D1 + R2 paths covered by integration tests via `@cloudflare/vitest-pool-workers`.
- Smoke tests sit alongside automated coverage; they catch regressions in the deployed environment that integration tests can't (DNS, real R2 latency, real D1 commit semantics).

## Anchor references

- Spec: `docs/superpowers/specs/2026-05-03-r5-publish-backend-design.md`
- R5 requirement: `docs/requirements/oyster-cloud.md`
- Roadmap (0.7.0 milestone): `docs/plans/roadmap.md`
- Auth substrate this builds on: `infra/auth-worker/` (`docs/plans/auth-oauth.md`)
- Issue #315
