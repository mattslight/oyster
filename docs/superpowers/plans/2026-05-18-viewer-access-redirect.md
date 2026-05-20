# Viewer access redirect — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a viewer-access bridge so an authorised visitor can reach a protected share without retyping the password — covering owner bypass for `password` mode and fixing the broken cross-host handoff for `signin` mode.

**Architecture:** A new `oyster.to`-hosted endpoint (where the apex session cookie lives) checks access, mints a single-use D1-backed nonce, and 302s the browser to `share.oyster.to/p/<token>?key=<nonce>`. The publish worker consumes the nonce and sets the existing `oyster_view_<token>` cookie (generalised to be a "recent-access proof for the artefact" honoured by both `password` and `signin` modes). `share_token` is in the consume `WHERE` clause so a nonce minted for one share cannot be burned against another. `/raw` cannot consume nonces — a required `consumeNonce` flag on `resolveViewerAccess` makes this an API contract.

**Tech Stack:** Cloudflare Workers (TypeScript), D1 (SQLite at the edge), vitest + `@cloudflare/vitest-pool-workers`, Web Crypto for HMAC cookie signing.

**Reference spec:** `docs/superpowers/specs/2026-05-18-viewer-access-redirect-design.md`.

**Branch:** `feat/viewer-access-redirect` (already checked out).

---

## File structure

### Create

| Path | Purpose |
|---|---|
| `infra/auth-worker/migrations/0011_viewer_access_nonces.sql` | D1 table for short-lived access nonces |
| `infra/oyster-publish/src/access-nonce.ts` | `mintAccessNonce` + `consumeAccessNonce` (the atomic single-use machinery) |
| `infra/oyster-publish/test/access-nonce.test.ts` | Unit tests for the nonce module |
| `infra/oyster-publish/test/access-redirect-handler.test.ts` | Integration tests for the new `GET /api/publish/access-redirect/:token` endpoint |
| `infra/oyster-publish/test/signin-mode-cookie-boundary.test.ts` | Cross-host cookie-scoping regression — proves the bug today's tests miss |

### Modify

| Path | Why |
|---|---|
| `infra/oyster-publish/test/fixtures/seed.ts` | Mirror the new D1 table in the test schema |
| `infra/oyster-publish/src/viewer-access.ts` | New `ok_via_nonce` kind; required `{ consumeNonce }` option; `signin` mode honours viewer cookie |
| `infra/oyster-publish/src/viewer-render.ts` | Add `referrer-policy: no-referrer` in `cacheHeaders()` |
| `infra/oyster-publish/src/viewer-pages.ts` | Add "Have access? Sign in to view" link on the password-gate page |
| `infra/oyster-publish/src/worker.ts` | New `/api/publish/access-redirect/:token` route; handle `ok_via_nonce`; pass `consumeNonce` flag from all three viewer call sites |
| `infra/oyster-publish/test/viewer-handler.test.ts` | Existing unauth signin-mode test asserts the new redirect target; add owner-bypass + replay + wrong-share + Referrer-Policy assertions |
| `infra/auth-worker/src/return-path.ts` | Allow `/api/publish/access-redirect/<token>` as a post-sign-in return target |
| `infra/auth-worker/test/return-path.test.ts` | Tests for the new allowlisted path |
| `CHANGELOG.md` | One user-visible bullet under `Added` |

### Pre-implementation audit item (out of code-changes scope)

Audit production log sinks (Cloudflare Logpush, Workers Analytics Engine, `wrangler tail` defaults) for query-string capture on `/p/<token>?key=…` and `/api/publish/access-redirect/<token>` paths. If any sink captures full URLs by default, disable that capture or scrub `?key=` for the path. This is operational, not code — record findings in the PR description.

---

## Task 1: Migration + test schema for `viewer_access_nonces`

**Files:**
- Create: `infra/auth-worker/migrations/0011_viewer_access_nonces.sql`
- Modify: `infra/oyster-publish/test/fixtures/seed.ts:6-64` (append the new `CREATE TABLE` + index to `SCHEMA_SQL`)

- [ ] **Step 1: Create the migration file**

Create `infra/auth-worker/migrations/0011_viewer_access_nonces.sql` with this exact content:

```sql
-- 0011_viewer_access_nonces.sql — single-use access nonces for the viewer access redirect.
--
-- Used by /api/publish/access-redirect/<token> to mint a short-lived, opaque
-- handoff token that share.oyster.to consumes. The viewer worker enforces
-- single-use via an atomic UPDATE ... WHERE consumed_at IS NULL, with
-- share_token in the WHERE clause so a nonce minted for share A cannot be
-- burned against share B's URL. user_id is for audit only; it is never
-- surfaced in any response.
--
-- TTL is 60s (enforced in application code). Mint is opportunistic and
-- deletes expired rows on each insert, so the table stays small.

CREATE TABLE viewer_access_nonces (
  nonce        TEXT    PRIMARY KEY,
  share_token  TEXT    NOT NULL,
  user_id      TEXT    NOT NULL,
  expires_at   INTEGER NOT NULL,
  consumed_at  INTEGER,
  created_at   INTEGER NOT NULL
);

CREATE INDEX idx_viewer_access_nonces_expires
  ON viewer_access_nonces(expires_at);
```

- [ ] **Step 2: Update the test fixture schema**

Edit `infra/oyster-publish/test/fixtures/seed.ts`. Inside the `SCHEMA_SQL` string (the multi-line template that contains the other `CREATE TABLE` statements), append the same DDL right before the closing backtick:

```sql
CREATE TABLE viewer_access_nonces (
  nonce        TEXT    PRIMARY KEY,
  share_token  TEXT    NOT NULL,
  user_id      TEXT    NOT NULL,
  expires_at   INTEGER NOT NULL,
  consumed_at  INTEGER,
  created_at   INTEGER NOT NULL
);
CREATE INDEX idx_viewer_access_nonces_expires
  ON viewer_access_nonces(expires_at);
```

Also update the leading comment block in `SCHEMA_SQL` to include the new migration in the "Keep in sync with" list:

```
--   infra/auth-worker/migrations/0011_viewer_access_nonces.sql (viewer_access_nonces)
```

- [ ] **Step 3: Verify the publish test suite still runs cleanly**

Run: `cd infra/oyster-publish && npm test -- --run`
Expected: existing tests still pass. The new table is present but not yet referenced.

- [ ] **Step 4: Commit**

```bash
git add infra/auth-worker/migrations/0011_viewer_access_nonces.sql \
        infra/oyster-publish/test/fixtures/seed.ts
git commit -m "$(cat <<'EOF'
feat(publish): add viewer_access_nonces table

Single-use, short-lived access nonces backing the viewer access redirect.
Mirrors into the publish-worker test fixture schema.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Nonce mint/consume helpers (TDD)

**Files:**
- Create: `infra/oyster-publish/src/access-nonce.ts`
- Create: `infra/oyster-publish/test/access-nonce.test.ts`

- [ ] **Step 1: Write the failing test file**

Create `infra/oyster-publish/test/access-nonce.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { applySchema } from "./fixtures/seed";
import { mintAccessNonce, consumeAccessNonce } from "../src/access-nonce";

beforeEach(async () => {
  await applySchema();
});

describe("access-nonce — mint + consume", () => {
  it("a freshly minted nonce consumes once and only once", async () => {
    const nonce = await mintAccessNonce(env, "tok_a", "user_1");
    expect(nonce).toMatch(/^[A-Za-z0-9_-]{22}$/);

    expect(await consumeAccessNonce(env, nonce, "tok_a")).toBe(true);
    expect(await consumeAccessNonce(env, nonce, "tok_a")).toBe(false);
  });

  it("consume with a wrong share_token returns false AND leaves the row unconsumed", async () => {
    // Regression for the atomic-share_token-in-WHERE invariant. If consume
    // updates before asserting the share_token, the row is burned and the
    // legitimate consumption against tok_a would then fail.
    const nonce = await mintAccessNonce(env, "tok_a", "user_1");
    expect(await consumeAccessNonce(env, nonce, "tok_b")).toBe(false);

    const row = await env.DB.prepare(
      "SELECT consumed_at FROM viewer_access_nonces WHERE nonce = ?",
    ).bind(nonce).first<{ consumed_at: number | null }>();
    expect(row?.consumed_at).toBeNull();

    expect(await consumeAccessNonce(env, nonce, "tok_a")).toBe(true);
  });

  it("an expired nonce cannot be consumed", async () => {
    const nonce = await mintAccessNonce(env, "tok_a", "user_1");
    // Force-expire the row.
    await env.DB.prepare(
      "UPDATE viewer_access_nonces SET expires_at = ? WHERE nonce = ?",
    ).bind(Date.now() - 1, nonce).run();
    expect(await consumeAccessNonce(env, nonce, "tok_a")).toBe(false);
  });

  it("a never-minted nonce cannot be consumed", async () => {
    expect(await consumeAccessNonce(env, "no-such-nonce-1234567x", "tok_a")).toBe(false);
  });

  it("mint opportunistically deletes expired rows", async () => {
    const stale = await mintAccessNonce(env, "tok_a", "user_1");
    await env.DB.prepare(
      "UPDATE viewer_access_nonces SET expires_at = ? WHERE nonce = ?",
    ).bind(Date.now() - 1, stale).run();

    await mintAccessNonce(env, "tok_b", "user_2");  // triggers cleanup

    const stillThere = await env.DB.prepare(
      "SELECT 1 AS x FROM viewer_access_nonces WHERE nonce = ?",
    ).bind(stale).first<{ x: number }>();
    expect(stillThere).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd infra/oyster-publish && npm test -- --run test/access-nonce.test.ts`
Expected: FAIL with "Cannot find module '../src/access-nonce'".

- [ ] **Step 3: Implement the nonce module**

Create `infra/oyster-publish/src/access-nonce.ts`:

```ts
// Short-lived, single-use access nonces for the viewer access redirect.
// Spec: docs/superpowers/specs/2026-05-18-viewer-access-redirect-design.md
//
// Mint: oyster.to/api/publish/access-redirect/<token> after the access
// predicate passes. Consume: share.oyster.to/p/<token>?key=<nonce> on the
// viewer pre-check. The atomic UPDATE pins share_token in the WHERE clause
// so a nonce minted for one share cannot consume against another.

import type { Env } from "./types";

const TTL_MS = 60_000;

/**
 * Mint a fresh nonce bound to (share_token, user_id). Also opportunistically
 * deletes expired rows. Returns the nonce — 22 base64url chars, 128 bits of
 * entropy.
 */
export async function mintAccessNonce(
  env: Env,
  shareToken: string,
  userId: string,
): Promise<string> {
  const now = Date.now();

  // Opportunistic cleanup. The expires_at index makes this a range scan;
  // the table is small (60s TTL bounds the steady-state size).
  await env.DB.prepare(
    "DELETE FROM viewer_access_nonces WHERE expires_at < ?",
  ).bind(now).run();

  const nonce = base64urlRandom(16);  // 16 bytes → 22 chars
  await env.DB.prepare(
    `INSERT INTO viewer_access_nonces
       (nonce, share_token, user_id, expires_at, consumed_at, created_at)
     VALUES (?, ?, ?, ?, NULL, ?)`,
  ).bind(nonce, shareToken, userId, now + TTL_MS, now).run();
  return nonce;
}

/**
 * Returns true iff this call atomically transitioned the nonce for THIS
 * share_token from unconsumed-and-live to consumed. Wrong share_token,
 * wrong nonce, expired, or already-consumed all return false WITHOUT any
 * side effect on the row.
 */
export async function consumeAccessNonce(
  env: Env,
  nonce: string,
  shareToken: string,
): Promise<boolean> {
  const now = Date.now();
  const res = await env.DB.prepare(
    `UPDATE viewer_access_nonces
        SET consumed_at = ?
      WHERE nonce       = ?
        AND share_token = ?
        AND consumed_at IS NULL
        AND expires_at  > ?`,
  ).bind(now, nonce, shareToken, now).run();
  return (res.meta?.changes ?? 0) === 1;
}

function base64urlRandom(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  let bin = "";
  for (const b of buf) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd infra/oyster-publish && npm test -- --run test/access-nonce.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add infra/oyster-publish/src/access-nonce.ts \
        infra/oyster-publish/test/access-nonce.test.ts
git commit -m "$(cat <<'EOF'
feat(publish): mint/consume helpers for viewer access nonces

Single-use, 60s TTL, atomic UPDATE with share_token in the WHERE clause
(a nonce minted for share A cannot consume against share B). Opportunistic
cleanup of expired rows on mint.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Return-path allowlist accepts the access-redirect path

**Files:**
- Modify: `infra/auth-worker/src/return-path.ts`
- Modify: `infra/auth-worker/test/return-path.test.ts`

- [ ] **Step 1: Write the failing tests**

In `infra/auth-worker/test/return-path.test.ts`, append a new describe block at the end of the file (before the final closing line):

```ts
describe("validateReturnPath — accepts access-redirect path", () => {
  it("accepts /api/publish/access-redirect/<token>", () => {
    expect(validateReturnPath("/api/publish/access-redirect/abc123"))
      .toBe("/api/publish/access-redirect/abc123");
  });

  it("accepts /api/publish/access-redirect/<token> with - and _ in the token", () => {
    expect(validateReturnPath("/api/publish/access-redirect/AaBb_-_-9"))
      .toBe("/api/publish/access-redirect/AaBb_-_-9");
  });

  it("rejects /api/publish/access-redirect/ with no token", () => {
    expect(validateReturnPath("/api/publish/access-redirect/")).toBeNull();
  });

  it("rejects /api/publish/access-redirect/<token>/extra", () => {
    expect(validateReturnPath("/api/publish/access-redirect/abc123/raw")).toBeNull();
  });

  it("rejects /api/publish/access-redirect/<token>?evil=1", () => {
    expect(validateReturnPath("/api/publish/access-redirect/abc?x=1")).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd infra/auth-worker && npm test -- --run test/return-path.test.ts`
Expected: the two "accepts" tests FAIL (validator returns null); the "rejects" tests PASS already.

- [ ] **Step 3: Update the validator**

Edit `infra/auth-worker/src/return-path.ts`. Replace the body of the file with:

```ts
// Generic post-sign-in redirect target validation for #316 and the
// viewer access redirect (2026-05-18 spec).
//
// Allowlist matches the share-viewer route AND the access-redirect route,
// and nothing else. We reject /p/<token>/raw because that's the iframe-
// content endpoint — landing a user there would strand them with no
// navigation. We reject query strings and fragments so attackers cannot
// smuggle params through the validator.

const SHARE_VIEWER_PATH    = /^\/p\/[A-Za-z0-9_-]+$/;
const ACCESS_REDIRECT_PATH = /^\/api\/publish\/access-redirect\/[A-Za-z0-9_-]+$/;
const MAX_PATH_LEN = 256;

export function validateReturnPath(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  if (typeof raw !== "string") return null;
  if (raw.length === 0 || raw.length > MAX_PATH_LEN) return null;
  // JS regex `$` matches before a trailing newline; reject any control
  // chars (especially CR/LF) explicitly so they never reach a Location header.
  if (/[\x00-\x1f\x7f]/.test(raw)) return null;
  if (SHARE_VIEWER_PATH.test(raw) || ACCESS_REDIRECT_PATH.test(raw)) return raw;
  return null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd infra/auth-worker && npm test -- --run test/return-path.test.ts`
Expected: PASS (all tests, including existing ones).

- [ ] **Step 5: Commit**

```bash
git add infra/auth-worker/src/return-path.ts \
        infra/auth-worker/test/return-path.test.ts
git commit -m "$(cat <<'EOF'
feat(auth): allowlist access-redirect path as a post-sign-in return target

Without this, the auth worker drops ?return=/api/publish/access-redirect/...
and the post-sign-in handoff strands the user on a generic page.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Signin mode honours `oyster_view_<token>` cookie

The signin-mode switch case in `viewer-access.ts` currently only checks `resolveSession()`. After the access-redirect mints the cookie, the clean-URL follow-up GET hits the signin case again — and would loop if we don't accept the cookie here too. This task is the cookie-acceptance change. Task 5 then adds the nonce pre-check.

**Files:**
- Modify: `infra/oyster-publish/src/viewer-access.ts`
- Modify: `infra/oyster-publish/test/viewer-handler.test.ts:381-407` (existing signin describe block)

- [ ] **Step 1: Write the failing test — signin mode with viewer cookie only**

In `infra/oyster-publish/test/viewer-handler.test.ts`, inside the existing `describe("GET /p/:token — signin mode", ...)` block, add this test before the closing `});`:

```ts
it("signed-in cookie-only visitor (no apex session) → content", async () => {
  // Models the post-nonce-consumption follow-up GET: the viewer cookie
  // was minted by the consume handler, but the apex session cookie was
  // NEVER on share.oyster.to in the first place. Without the signin-mode
  // cookie acceptance change, this would loop back to access-redirect.
  const u = await seedUser();
  const { shareToken } = await seedActiveOpenWithBody({
    ownerUserId: u.id, artifactId: "art3cookie", body: "# private",
  });
  await env.DB.prepare("UPDATE published_artifacts SET mode = 'signin' WHERE share_token = ?")
    .bind(shareToken).run();

  const viewerCookie = await signViewerCookie(shareToken, env.VIEWER_COOKIE_SECRET);
  const res = await call(getReq(`/p/${shareToken}`, {
    cookie: `oyster_view_${shareToken}=${viewerCookie}`,  // no oyster_session
  }));
  expect(res.status).toBe(200);
  expect(await res.text()).toContain("private");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd infra/oyster-publish && npm test -- --run test/viewer-handler.test.ts -t "cookie-only"`
Expected: FAIL — status is 302 (redirect to sign-in), not 200.

- [ ] **Step 3: Update `viewer-access.ts` — signin honours cookie**

Edit `infra/oyster-publish/src/viewer-access.ts`. Replace the entire file with:

```ts
// Access dispatch for the public viewer.
// Spec: docs/superpowers/specs/2026-05-03-r5-viewer-design.md (Access dispatch)
//       docs/superpowers/specs/2026-05-18-viewer-access-redirect-design.md
//
// `oyster_view_<token>` is treated as a generic recent-access proof for
// the artefact: any successful gate-clearing path (password POST,
// owner-via-nonce, signin-via-nonce) mints it, and both password and
// signin modes accept it. Without that semantics, the post-nonce
// clean-URL follow-up GET in signin mode would loop back to access-
// redirect because the apex session is not visible on share.oyster.to.

import { resolveSession } from "./worker";
import { verifyViewerCookie } from "./viewer-cookie";
import type { Env, PublicationRow } from "./types";

export type ViewerAccess =
  | { kind: "ok"; row: PublicationRow }
  | { kind: "gate"; row: PublicationRow; error?: "wrong_password" }
  | { kind: "redirect"; location: string }
  | { kind: "gone"; row: PublicationRow }
  | { kind: "not_found" };

export async function resolveViewerAccess(
  req: Request,
  env: Env,
  shareToken: string,
): Promise<ViewerAccess> {
  // Step 1: row lookup.
  const row = await env.DB.prepare(
    "SELECT * FROM published_artifacts WHERE share_token = ?",
  ).bind(shareToken).first<PublicationRow>();
  if (!row) return { kind: "not_found" };

  // Step 2: gone check.
  if (row.unpublished_at !== null && row.unpublished_at !== undefined) {
    return { kind: "gone", row };
  }

  // Step 3: mode dispatch.
  switch (row.mode) {
    case "open":
      return { kind: "ok", row };

    case "password": {
      if (await hasValidViewerCookie(req, shareToken, env.VIEWER_COOKIE_SECRET)) {
        return { kind: "ok", row };
      }
      return { kind: "gate", row };
    }

    case "signin": {
      // Honour the viewer cookie as a generic recent-access proof. The
      // apex `oyster_session` is host-only on oyster.to and is NOT
      // visible on share.oyster.to in production (auth-worker #397), so
      // resolveSession() returns null in the cross-host case — the
      // cookie is the only access proof we'll see on this host.
      if (await hasValidViewerCookie(req, shareToken, env.VIEWER_COOKIE_SECRET)) {
        return { kind: "ok", row };
      }
      const session = await resolveSession(req, env);
      if (!session) {
        return {
          kind: "redirect",
          location: `https://oyster.to/api/publish/access-redirect/${shareToken}`,
        };
      }
      return { kind: "ok", row };
    }

    default:
      // Unreachable per the D1 CHECK constraint, but typescript-safe.
      return { kind: "not_found" };
  }
}

export function readCookie(req: Request, name: string): string | null {
  const cookie = req.headers.get("Cookie");
  if (!cookie) return null;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = cookie.match(new RegExp(`(?:^|;\\s*)${escaped}=([^;]+)`));
  return m && m[1] ? m[1] : null;
}

async function hasValidViewerCookie(
  req: Request,
  shareToken: string,
  secret: string,
): Promise<boolean> {
  const value = readCookie(req, `oyster_view_${shareToken}`);
  if (!value) return false;
  return await verifyViewerCookie(value, shareToken, secret);
}
```

- [ ] **Step 4: Update the existing unsigned-visitor test for the new redirect target**

Still in `infra/oyster-publish/test/viewer-handler.test.ts`, find the existing test at the top of the signin describe block and update its expectation:

```ts
it("unsigned visitor → 302 to /api/publish/access-redirect/<token>", async () => {
  const u = await seedUser();
  const token = await seedActivePublication({
    ownerUserId: u.id, artifactId: "art3", mode: "signin",
  });
  const res = await call(getReq(`/p/${token}`));
  expect(res.status).toBe(302);
  const location = res.headers.get("location") ?? "";
  expect(location).toBe(`https://oyster.to/api/publish/access-redirect/${token}`);
});
```

(The test title also changes — it was "→ 302 to /auth/sign-in?return=/p/<token>".)

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd infra/oyster-publish && npm test -- --run test/viewer-handler.test.ts`
Expected: PASS — both the cookie-only test and the updated unsigned-visitor test.

- [ ] **Step 6: Commit**

```bash
git add infra/oyster-publish/src/viewer-access.ts \
        infra/oyster-publish/test/viewer-handler.test.ts
git commit -m "$(cat <<'EOF'
feat(publish): signin mode honours oyster_view_<token> cookie

oyster_view_<token> is now treated as a generic recent-access proof,
honoured by both password and signin modes. Without this, the
post-nonce-consumption clean-URL GET in signin mode loops back to
access-redirect because the apex session is not visible on share.oyster.to.
Unsigned-visitor redirect target updated to access-redirect endpoint.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: `resolveViewerAccess` takes a required `consumeNonce` option

This task adds the `?key=` pre-check, the new `ok_via_nonce` access kind, and forces every caller (`/p`, `/raw`, password POST) to opt in or out explicitly. `/raw` MUST pass `false`.

**Files:**
- Modify: `infra/oyster-publish/src/viewer-access.ts`
- Modify: `infra/oyster-publish/src/worker.ts` (three call sites)

- [ ] **Step 1: Write failing tests — `/raw` must not consume, `/p` does**

Append to `infra/oyster-publish/test/viewer-handler.test.ts` (inside the file, at the bottom before the final closing of describes):

```ts
describe("nonce pre-check — consumeNonce flag", () => {
  it("/p/<token>?key=<valid_nonce> consumes the nonce and returns ok_via_nonce", async () => {
    const u = await seedUser();
    const { shareToken } = await seedActiveOpenWithBody({
      ownerUserId: u.id, artifactId: "art_n1", body: "# nonce content",
    });
    await env.DB.prepare("UPDATE published_artifacts SET mode = 'signin' WHERE share_token = ?")
      .bind(shareToken).run();

    const nonce = await mintAccessNonce(env, shareToken, u.id);
    const res = await call(getReq(`/p/${shareToken}?key=${nonce}`));
    // The handler 302s to the clean URL; assert on the redirect itself
    // here. Cookie + clean URL + headers are asserted in Task 6.
    expect(res.status).toBe(302);

    // Nonce row is consumed.
    const row = await env.DB.prepare(
      "SELECT consumed_at FROM viewer_access_nonces WHERE nonce = ?",
    ).bind(nonce).first<{ consumed_at: number | null }>();
    expect(row?.consumed_at).not.toBeNull();
  });

  it("/p/<token>/raw?key=<valid_nonce> does NOT consume the nonce", async () => {
    // Regression for the explicit consumeNonce: false on /raw. If a future
    // change drops the flag, this test fails.
    const u = await seedUser();
    const { shareToken } = await seedActiveOpenWithBody({
      ownerUserId: u.id, artifactId: "art_n_raw", body: "<h1>iframe</h1>",
      artifactKind: "app", contentType: "text/html",
    });
    await env.DB.prepare("UPDATE published_artifacts SET mode = 'signin' WHERE share_token = ?")
      .bind(shareToken).run();

    const nonce = await mintAccessNonce(env, shareToken, u.id);
    await call(getReq(`/p/${shareToken}/raw?key=${nonce}`));

    const row = await env.DB.prepare(
      "SELECT consumed_at FROM viewer_access_nonces WHERE nonce = ?",
    ).bind(nonce).first<{ consumed_at: number | null }>();
    expect(row?.consumed_at).toBeNull();

    // The nonce remains usable on the proper /p endpoint.
    expect(await consumeAccessNonce(env, nonce, shareToken)).toBe(true);
  });

  it("/p/<token>?key=<wrong_share> falls through silently AND leaves the nonce unconsumed", async () => {
    const u = await seedUser();
    const tokA = await seedActivePublication({ ownerUserId: u.id, artifactId: "art_A", mode: "signin" });
    const tokB = await seedActivePublication({ ownerUserId: u.id, artifactId: "art_B", mode: "signin" });

    const nonce = await mintAccessNonce(env, tokA, u.id);
    const res = await call(getReq(`/p/${tokB}?key=${nonce}`));
    // signin mode, no cookie/session → 302 to access-redirect (silent fall-through).
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      `https://oyster.to/api/publish/access-redirect/${tokB}`,
    );

    // Nonce is still alive for its real share.
    const row = await env.DB.prepare(
      "SELECT consumed_at FROM viewer_access_nonces WHERE nonce = ?",
    ).bind(nonce).first<{ consumed_at: number | null }>();
    expect(row?.consumed_at).toBeNull();
  });
});
```

And add these imports at the top of the test file (alongside the existing imports from `./fixtures/seed`):

```ts
import { mintAccessNonce, consumeAccessNonce } from "../src/access-nonce";
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd infra/oyster-publish && npm test -- --run test/viewer-handler.test.ts -t "consumeNonce flag"`
Expected: all three FAIL — the `?key=` query is currently ignored, so the nonce stays unconsumed and `/p` does not 302 with the expected shape.

- [ ] **Step 3: Add the option + pre-check to `resolveViewerAccess`**

Edit `infra/oyster-publish/src/viewer-access.ts`. Replace the file with:

```ts
// Access dispatch for the public viewer.
// Spec: docs/superpowers/specs/2026-05-03-r5-viewer-design.md (Access dispatch)
//       docs/superpowers/specs/2026-05-18-viewer-access-redirect-design.md
//
// `oyster_view_<token>` is treated as a generic recent-access proof for
// the artefact: any successful gate-clearing path (password POST,
// owner-via-nonce, signin-via-nonce) mints it, and both password and
// signin modes accept it. Without that semantics, the post-nonce
// clean-URL follow-up GET in signin mode would loop back to access-
// redirect because the apex session is not visible on share.oyster.to.
//
// The `consumeNonce` option on resolveViewerAccess is REQUIRED on every
// call site so that /raw cannot accidentally start consuming nonces
// without a deliberate edit. /p passes true, /raw and the password POST
// pass false.

import { resolveSession } from "./worker";
import { verifyViewerCookie } from "./viewer-cookie";
import { consumeAccessNonce } from "./access-nonce";
import type { Env, PublicationRow } from "./types";

export type ViewerAccess =
  | { kind: "ok"; row: PublicationRow }
  | { kind: "ok_via_nonce"; row: PublicationRow }
  | { kind: "gate"; row: PublicationRow; error?: "wrong_password" }
  | { kind: "redirect"; location: string }
  | { kind: "gone"; row: PublicationRow }
  | { kind: "not_found" };

export interface ResolveOptions {
  /**
   * When true, a valid `?key=<nonce>` consumes the nonce and yields
   * `ok_via_nonce`. When false, the `?key=` parameter is ignored entirely
   * (the caller is responsible for any cookie-based check). /p MUST pass
   * true; /raw and the password POST handler MUST pass false. Making the
   * flag required prevents a future regression from silently turning the
   * iframe endpoint into a nonce-consuming endpoint.
   */
  consumeNonce: boolean;
}

export async function resolveViewerAccess(
  req: Request,
  env: Env,
  shareToken: string,
  opts: ResolveOptions,
): Promise<ViewerAccess> {
  // Step 1: row lookup.
  const row = await env.DB.prepare(
    "SELECT * FROM published_artifacts WHERE share_token = ?",
  ).bind(shareToken).first<PublicationRow>();
  if (!row) return { kind: "not_found" };

  // Step 2: gone check.
  if (row.unpublished_at !== null && row.unpublished_at !== undefined) {
    return { kind: "gone", row };
  }

  // Step 3: nonce pre-check (caller opt-in). Open mode never needs a
  // nonce — the viewer would serve content anyway. Invalid / expired /
  // wrong-share nonces fall through silently — no oracle.
  if (opts.consumeNonce && (row.mode === "password" || row.mode === "signin")) {
    const key = new URL(req.url).searchParams.get("key");
    if (key && await consumeAccessNonce(env, key, shareToken)) {
      return { kind: "ok_via_nonce", row };
    }
  }

  // Step 4: mode dispatch.
  switch (row.mode) {
    case "open":
      return { kind: "ok", row };

    case "password": {
      if (await hasValidViewerCookie(req, shareToken, env.VIEWER_COOKIE_SECRET)) {
        return { kind: "ok", row };
      }
      return { kind: "gate", row };
    }

    case "signin": {
      if (await hasValidViewerCookie(req, shareToken, env.VIEWER_COOKIE_SECRET)) {
        return { kind: "ok", row };
      }
      const session = await resolveSession(req, env);
      if (!session) {
        return {
          kind: "redirect",
          location: `https://oyster.to/api/publish/access-redirect/${shareToken}`,
        };
      }
      return { kind: "ok", row };
    }

    default:
      return { kind: "not_found" };
  }
}

export function readCookie(req: Request, name: string): string | null {
  const cookie = req.headers.get("Cookie");
  if (!cookie) return null;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = cookie.match(new RegExp(`(?:^|;\\s*)${escaped}=([^;]+)`));
  return m && m[1] ? m[1] : null;
}

async function hasValidViewerCookie(
  req: Request,
  shareToken: string,
  secret: string,
): Promise<boolean> {
  const value = readCookie(req, `oyster_view_${shareToken}`);
  if (!value) return false;
  return await verifyViewerCookie(value, shareToken, secret);
}
```

- [ ] **Step 4: Update all three callers in `worker.ts` to pass the flag**

Edit `infra/oyster-publish/src/worker.ts`. Find these three call sites and update each to pass `{ consumeNonce }`:

Around line 699 (in `handleViewerGet`):

```ts
async function handleViewerGet(req: Request, env: Env, shareToken: string): Promise<Response> {
  const access = await resolveViewerAccess(req, env, shareToken, { consumeNonce: true });
  // ...rest unchanged...
}
```

Around line 718 (in `handleViewerRaw`):

```ts
async function handleViewerRaw(req: Request, env: Env, shareToken: string): Promise<Response> {
  const access = await resolveViewerAccess(req, env, shareToken, { consumeNonce: false });
  // ...rest unchanged...
}
```

Around line 739 (in `handleViewerPost`):

```ts
async function handleViewerPost(req: Request, env: Env, shareToken: string): Promise<Response> {
  const access = await resolveViewerAccess(req, env, shareToken, { consumeNonce: false });
  // ...rest unchanged...
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd infra/oyster-publish && npm test -- --run test/viewer-handler.test.ts`
Expected: PASS — the three new pre-check tests pass; existing tests still pass (no behaviour change for non-`?key=` paths).

Note: `ok_via_nonce` is not yet handled in `handleViewerGet` — that's Task 6. The current 302 the test asserts on is the existing default-case behaviour (any kind not handled falls through to the switch statement). TypeScript's exhaustiveness check may fail at compile time; if so, add a `case "ok_via_nonce":` that throws "TODO Task 6" temporarily — Task 6 replaces it.

Actually safer: add the placeholder now so compilation succeeds. Add to the switch statement at the bottom of `handleViewerGet`:

```ts
case "ok_via_nonce":
  // Placeholder — real handling lands in Task 6.
  throw new Error("ok_via_nonce: handler not yet implemented (Task 6)");
```

Re-run the test — the `/p?key=` test will now throw instead of 302. Adjust that single assertion temporarily to `expect(res.status).toBe(500)` and add a `// TODO Task 6: assert 302 + cookie + clean URL` comment. Task 6 reverts the assertion.

If you prefer not to touch the test twice, skip the consume assertion for now and re-enable in Task 6 — but the rest of this task should compile and the wrong-share + /raw assertions should pass.

- [ ] **Step 6: Commit**

```bash
git add infra/oyster-publish/src/viewer-access.ts \
        infra/oyster-publish/src/worker.ts \
        infra/oyster-publish/test/viewer-handler.test.ts
git commit -m "$(cat <<'EOF'
feat(publish): nonce pre-check on resolveViewerAccess with required consumeNonce flag

/p opts in (consumeNonce: true), /raw and the password POST opt out
(consumeNonce: false). Making the flag required prevents a future
regression from silently turning /raw into a nonce-consuming endpoint.
share_token in the consume WHERE clause means a nonce minted for one
share cannot burn against another. ok_via_nonce handler arrives in the
next commit.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Handle `ok_via_nonce` in `handleViewerGet`

**Files:**
- Modify: `infra/oyster-publish/src/worker.ts` (handleViewerGet switch)
- Modify: `infra/oyster-publish/test/viewer-handler.test.ts` (extend the nonce-flag describe with golden-path assertions)

- [ ] **Step 1: Replace the placeholder test with the golden-path assertions**

In `infra/oyster-publish/test/viewer-handler.test.ts`, find the first test of the `consumeNonce flag` describe (the one that asserts `res.status === 302` after `getReq(/p/<token>?key=<nonce>)`). Replace it with this fuller version:

```ts
it("/p/<token>?key=<valid_nonce> sets viewer cookie, 302s to clean URL, no-referrer", async () => {
  const u = await seedUser();
  const { shareToken } = await seedActiveOpenWithBody({
    ownerUserId: u.id, artifactId: "art_n1", body: "# nonce content",
  });
  await env.DB.prepare("UPDATE published_artifacts SET mode = 'signin' WHERE share_token = ?")
    .bind(shareToken).run();

  const nonce = await mintAccessNonce(env, shareToken, u.id);
  const res = await call(getReq(`/p/${shareToken}?key=${nonce}`));

  expect(res.status).toBe(302);
  expect(res.headers.get("location")).toBe(`/p/${shareToken}`);
  expect(res.headers.get("cache-control")).toBe("private, no-store");
  expect(res.headers.get("referrer-policy")).toBe("no-referrer");

  const setCookie = res.headers.get("set-cookie") ?? "";
  expect(setCookie).toContain(`oyster_view_${shareToken}=`);
  expect(setCookie).toContain(`Path=/p/${shareToken}`);
  expect(setCookie).toContain("HttpOnly");
  expect(setCookie).toContain("SameSite=Lax");

  // Follow-up GET with the cookie returns content. We pass NO oyster_session
  // here on purpose — the cookie is the only proof on share.oyster.to.
  const cookieValue = setCookie.match(/oyster_view_[^=]+=([^;]+)/)?.[1] ?? "";
  const follow = await call(getReq(`/p/${shareToken}`, {
    cookie: `oyster_view_${shareToken}=${cookieValue}`,
  }));
  expect(follow.status).toBe(200);
  expect(await follow.text()).toContain("nonce content");
});
```

Also add the replay test in the same describe block:

```ts
it("a replayed key falls through to the standard mode dispatch", async () => {
  const u = await seedUser();
  const token = await seedActivePublication({ ownerUserId: u.id, artifactId: "art_replay", mode: "signin" });
  const nonce = await mintAccessNonce(env, token, u.id);

  // First call consumes.
  const first = await call(getReq(`/p/${token}?key=${nonce}`));
  expect(first.status).toBe(302);
  expect(first.headers.get("location")).toBe(`/p/${token}`);

  // Second call with the same (now-consumed) key behaves identically to
  // a no-key request: signin mode, no cookie → 302 to access-redirect.
  const second = await call(getReq(`/p/${token}?key=${nonce}`));
  expect(second.status).toBe(302);
  expect(second.headers.get("location"))
    .toBe(`https://oyster.to/api/publish/access-redirect/${token}`);
});
```

- [ ] **Step 2: Run to verify the first test fails (placeholder throws)**

Run: `cd infra/oyster-publish && npm test -- --run test/viewer-handler.test.ts -t "sets viewer cookie"`
Expected: FAIL — currently throws "ok_via_nonce: handler not yet implemented".

- [ ] **Step 3: Implement the `ok_via_nonce` handler**

Edit `infra/oyster-publish/src/worker.ts`. Find the `handleViewerGet` switch. Replace the placeholder `case "ok_via_nonce":` block with this real implementation:

```ts
case "ok_via_nonce": {
  // The visitor proved they have access (owner of a password share, or
  // any signed-in user for a signin share) via /api/publish/access-redirect.
  // Mint the standard recent-access cookie and 302 to the clean URL so
  // that ?key=<nonce> does not linger in the address bar / Referer.
  const cookieValue = await signViewerCookie(access.row.share_token, env.VIEWER_COOKIE_SECRET);
  const host = new URL(req.url).host;
  const secureFlag = isLoopback(host) ? "" : " Secure;";
  return new Response(null, {
    status: 302,
    headers: {
      "set-cookie": `oyster_view_${access.row.share_token}=${cookieValue}; HttpOnly;${secureFlag} SameSite=Lax; Path=/p/${access.row.share_token}; Max-Age=86400`,
      "location": `/p/${access.row.share_token}`,
      "cache-control": "private, no-store",
      "referrer-policy": "no-referrer",
    },
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd infra/oyster-publish && npm test -- --run test/viewer-handler.test.ts`
Expected: PASS — the golden-path test and the replay test both pass; existing tests still pass.

- [ ] **Step 5: Commit**

```bash
git add infra/oyster-publish/src/worker.ts \
        infra/oyster-publish/test/viewer-handler.test.ts
git commit -m "$(cat <<'EOF'
feat(publish): handle ok_via_nonce — set recent-access cookie, 302 to clean URL

Sets oyster_view_<token> (24h, HttpOnly, SameSite=Lax, Path-scoped)
and 302s to /p/<token> with the ?key= stripped. cache-control: no-store
and referrer-policy: no-referrer on the redirect so the nonce-bearing URL
does not surface in caches or Referer headers.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: New endpoint `GET /api/publish/access-redirect/:token`

**Files:**
- Modify: `infra/oyster-publish/src/worker.ts` (register route + handler)
- Create: `infra/oyster-publish/test/access-redirect-handler.test.ts`

- [ ] **Step 1: Write the failing test file**

Create `infra/oyster-publish/test/access-redirect-handler.test.ts`:

```ts
import { describe, it, expect, beforeEach, beforeAll } from "vitest";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/worker";
import {
  applySchema, seedUser, seedActivePublication, retirePublication,
} from "./fixtures/seed";

beforeAll(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (env as any).VIEWER_PASSWORD_LIMIT = { limit: async () => ({ success: true }) };
});

beforeEach(async () => {
  await applySchema();
});

function getReq(path: string, opts: { cookie?: string } = {}): Request {
  const headers = new Headers();
  if (opts.cookie) headers.set("Cookie", opts.cookie);
  return new Request(`https://oyster.to${path}`, { method: "GET", headers });
}

async function call(req: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(req, env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

const PATH = (t: string) => `/api/publish/access-redirect/${t}`;

describe("GET /api/publish/access-redirect/:token", () => {
  it("returns 404 for an unknown token", async () => {
    const res = await call(getReq(PATH("no-such")));
    expect(res.status).toBe(404);
  });

  it("returns 410 for a retired publication", async () => {
    const u = await seedUser();
    const token = await seedActivePublication({ ownerUserId: u.id, artifactId: "art1", mode: "open" });
    await retirePublication(token);
    const res = await call(getReq(PATH(token)));
    expect(res.status).toBe(410);
  });

  it("open mode → 302 straight to viewer with no key", async () => {
    const u = await seedUser();
    const token = await seedActivePublication({ ownerUserId: u.id, artifactId: "art1", mode: "open" });
    const res = await call(getReq(PATH(token)));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`https://share.oyster.to/p/${token}`);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(new URL(res.headers.get("location")!).searchParams.get("key")).toBeNull();
  });

  it("signin mode + no session → 302 to sign-in with return target", async () => {
    const u = await seedUser();
    const token = await seedActivePublication({ ownerUserId: u.id, artifactId: "art2", mode: "signin" });
    const res = await call(getReq(PATH(token)));
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.origin + loc.pathname).toBe("https://oyster.to/auth/sign-in");
    expect(loc.searchParams.get("return")).toBe(PATH(token));
  });

  it("signin mode + session → 302 to viewer with a fresh ?key= and a row in viewer_access_nonces", async () => {
    const u = await seedUser();
    const token = await seedActivePublication({ ownerUserId: u.id, artifactId: "art2", mode: "signin" });
    const res = await call(getReq(PATH(token), { cookie: `oyster_session=${u.sessionToken}` }));
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.origin + loc.pathname).toBe(`https://share.oyster.to/p/${token}`);
    const key = loc.searchParams.get("key");
    expect(key).toMatch(/^[A-Za-z0-9_-]{22}$/);

    const row = await env.DB.prepare(
      "SELECT share_token, user_id, consumed_at FROM viewer_access_nonces WHERE nonce = ?",
    ).bind(key).first<{ share_token: string; user_id: string; consumed_at: number | null }>();
    expect(row?.share_token).toBe(token);
    expect(row?.user_id).toBe(u.id);
    expect(row?.consumed_at).toBeNull();
  });

  it("password mode + no session → 302 to sign-in with return target", async () => {
    const u = await seedUser();
    const token = await seedActivePublication({ ownerUserId: u.id, artifactId: "art3", mode: "password" });
    const res = await call(getReq(PATH(token)));
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.searchParams.get("return")).toBe(PATH(token));
  });

  it("password mode + owner session → 302 to viewer with a fresh ?key=", async () => {
    const owner = await seedUser();
    const token = await seedActivePublication({
      ownerUserId: owner.id, artifactId: "art4", mode: "password",
    });
    const res = await call(getReq(PATH(token), { cookie: `oyster_session=${owner.sessionToken}` }));
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.origin + loc.pathname).toBe(`https://share.oyster.to/p/${token}`);
    expect(loc.searchParams.get("key")).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });

  it("password mode + non-owner session → 403 page (no nonce minted)", async () => {
    const owner = await seedUser({ id: "user_owner" });
    const other = await seedUser({ id: "user_other" });
    const token = await seedActivePublication({
      ownerUserId: owner.id, artifactId: "art5", mode: "password",
    });
    const res = await call(getReq(PATH(token), { cookie: `oyster_session=${other.sessionToken}` }));
    expect(res.status).toBe(403);
    expect(res.headers.get("content-type")).toMatch(/^text\/html/);
    // Body should give them a way back to the public gate.
    expect(await res.text()).toContain(`/p/${token}`);

    // No nonce minted.
    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM viewer_access_nonces WHERE share_token = ?",
    ).bind(token).first<{ n: number }>();
    expect(count?.n).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd infra/oyster-publish && npm test -- --run test/access-redirect-handler.test.ts`
Expected: all tests FAIL — endpoint doesn't exist; everything returns 404 (the worker's default).

- [ ] **Step 3: Add a 403 page renderer to `viewer-pages.ts`**

Edit `infra/oyster-publish/src/viewer-pages.ts`. Add this exported function (place it after `notFoundPage` and before `internalErrorPage`):

```ts
export function noAccessPage(shareToken: string): string {
  return basePage("No access", `
    <div class="icon">🔒</div>
    <h1>You don't have access to this share</h1>
    <p class="hint">This publication belongs to a different account.</p>
    <p><a href="/p/${escapeHtml(shareToken)}">Enter the password instead</a></p>
  `);
}
```

- [ ] **Step 4: Register the route and implement the handler in `worker.ts`**

Edit `infra/oyster-publish/src/worker.ts`. At the top of the fetch handler, **before** the existing `if (url.pathname.startsWith("/api/publish/") && req.method === "DELETE")` block, add:

```ts
if (url.pathname.startsWith("/api/publish/access-redirect/") && req.method === "GET") {
  const token = url.pathname.slice("/api/publish/access-redirect/".length);
  if (!token || token.includes("/")) {
    return new Response("Not Found", { status: 404 });
  }
  return handleAccessRedirect(req, env, token);
}
```

Also extend the `viewer-pages` import at the top to include `noAccessPage`:

```ts
import {
  passwordGatePage, gonePage, notFoundPage, noAccessPage, internalErrorPage, rateLimitedPage,
} from "./viewer-pages";
```

And add a `mintAccessNonce` import:

```ts
import { mintAccessNonce } from "./access-nonce";
```

Then add the handler function somewhere below the existing `handleViewerGet` group (after `handleViewerPost`):

```ts
async function handleAccessRedirect(req: Request, env: Env, shareToken: string): Promise<Response> {
  type Row = { mode: "open" | "password" | "signin"; owner_user_id: string; unpublished_at: number | null };
  const row = await env.DB.prepare(
    "SELECT mode, owner_user_id, unpublished_at FROM published_artifacts WHERE share_token = ?",
  ).bind(shareToken).first<Row>();

  if (!row) return htmlPage(404, notFoundPage());
  if (row.unpublished_at !== null) return htmlPage(410, gonePage());

  // Open mode: no gate to clear, no nonce to mint.
  if (row.mode === "open") {
    return redirectNoStore(`https://share.oyster.to/p/${shareToken}`);
  }

  const session = await resolveSession(req, env);
  if (!session) {
    return redirectNoStore(
      `https://oyster.to/auth/sign-in?return=${encodeURIComponent(`/api/publish/access-redirect/${shareToken}`)}`,
    );
  }

  // Access predicates — widen the password case to an ACL when sharing-
  // to-specific-user lands. resolveSession() in this worker returns flat
  // { id, email, tier } (see top of this file).
  let mayAccess = false;
  if (row.mode === "signin")   mayAccess = true;
  if (row.mode === "password") mayAccess = session.id === row.owner_user_id;

  if (!mayAccess) return htmlPage(403, noAccessPage(shareToken));

  const nonce = await mintAccessNonce(env, shareToken, session.id);
  return redirectNoStore(`https://share.oyster.to/p/${shareToken}?key=${nonce}`);
}

function redirectNoStore(location: string): Response {
  return new Response(null, {
    status: 302,
    headers: {
      location,
      "cache-control": "private, no-store",
    },
  });
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd infra/oyster-publish && npm test -- --run test/access-redirect-handler.test.ts`
Expected: PASS — all 8 tests.

Run also: `cd infra/oyster-publish && npm test -- --run`
Expected: PASS — no regressions elsewhere.

- [ ] **Step 6: Commit**

```bash
git add infra/oyster-publish/src/viewer-pages.ts \
        infra/oyster-publish/src/worker.ts \
        infra/oyster-publish/test/access-redirect-handler.test.ts
git commit -m "$(cat <<'EOF'
feat(publish): GET /api/publish/access-redirect/:token

The owner-bypass / signin-handoff endpoint. Lives on oyster.to where the
apex session cookie is visible, checks ownership/membership, mints a
single-use nonce, and 302s the browser to share.oyster.to with the key.
Open mode skips the nonce. Non-owner of a password share gets a 403
page that links back to the public password gate.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Gate-page link — "Have access? Sign in to view"

**Files:**
- Modify: `infra/oyster-publish/src/viewer-pages.ts`
- Modify: `infra/oyster-publish/test/viewer-handler.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `infra/oyster-publish/test/viewer-handler.test.ts`:

```ts
describe("password gate — sign-in link", () => {
  it('shows "Have access? Sign in to view" link pointing at access-redirect', async () => {
    const u = await seedUser();
    const token = await seedActivePublication({
      ownerUserId: u.id, artifactId: "art_gate", mode: "password",
    });
    const res = await call(getReq(`/p/${token}`));
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Have access?");
    expect(body).toContain(`https://oyster.to/api/publish/access-redirect/${token}`);
  });

  it("link is present on the wrong-password error state too", async () => {
    const u = await seedUser();
    // Use a real PBKDF2 hash so the password check can run, then submit a wrong password.
    const token = await seedActivePublication({
      ownerUserId: u.id, artifactId: "art_gate2", mode: "password",
      // Hash for "correct-password" — but we'll submit "wrong" to trigger the error block.
      passwordHash: "pbkdf2$100000$AAAA$BBBB",  // bogus but well-formed; verifyPbkdf2 returns false
    });
    const res = await call(postReq(`/p/${token}`, { password: "wrong" }));
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Incorrect password.");
    expect(body).toContain("Have access?");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd infra/oyster-publish && npm test -- --run test/viewer-handler.test.ts -t "sign-in link"`
Expected: FAIL — the gate page does not yet contain "Have access?".

- [ ] **Step 3: Update `passwordGatePage`**

Edit `infra/oyster-publish/src/viewer-pages.ts`. Replace the `passwordGatePage` function with:

```ts
export function passwordGatePage(shareToken: string, opts?: { error?: "wrong_password" }): string {
  const errorBlock = opts?.error === "wrong_password"
    ? `<p class="err">Incorrect password.</p>`
    : "";
  const tokenSafe = escapeHtml(shareToken);
  return basePage("Password required", `
    <div class="icon">🔒</div>
    <h1>Password required</h1>
    <p class="hint">This share is password-protected.</p>
    ${errorBlock}
    <form method="POST" action="/p/${tokenSafe}">
      <input type="password" name="password" placeholder="Password" autofocus required>
      <button type="submit">Unlock</button>
    </form>
    <p class="hint-link">Have access? <a href="https://oyster.to/api/publish/access-redirect/${tokenSafe}">Sign in to view</a></p>
  `);
}
```

Also extend the page-style block inside `basePage()` so `.hint-link` is laid out cleanly. Find the existing `<style>` and add this rule next to the other selectors (e.g. after the `.tag` rule):

```css
.hint-link { font-size: 0.85rem; color: var(--muted); margin-top: 1.25rem; }
.hint-link a { color: inherit; text-decoration: underline; }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd infra/oyster-publish && npm test -- --run test/viewer-handler.test.ts -t "sign-in link"`
Expected: PASS — both tests.

- [ ] **Step 5: Commit**

```bash
git add infra/oyster-publish/src/viewer-pages.ts \
        infra/oyster-publish/test/viewer-handler.test.ts
git commit -m "$(cat <<'EOF'
feat(publish): password gate offers "Have access? Sign in to view"

Links to /api/publish/access-redirect/<token>. The "Have access?"
phrasing (rather than "Own this share?") is forward-compatible with
the ACL widening for share-to-specific-user.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Referrer-Policy on the final rendered viewer responses

**Files:**
- Modify: `infra/oyster-publish/src/viewer-render.ts:37-48` (the `cacheHeaders` helper)
- Modify: `infra/oyster-publish/test/viewer-handler.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `infra/oyster-publish/test/viewer-handler.test.ts`:

```ts
describe("rendered viewer responses — Referrer-Policy", () => {
  it("open-mode markdown render carries referrer-policy: no-referrer", async () => {
    const u = await seedUser();
    const { shareToken } = await seedActiveOpenWithBody({
      ownerUserId: u.id, artifactId: "art_rp_open", body: "# hi",
    });
    const res = await call(getReq(`/p/${shareToken}`));
    expect(res.status).toBe(200);
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("password-mode (post-unlock) render carries referrer-policy: no-referrer", async () => {
    const u = await seedUser();
    const { shareToken } = await seedActiveOpenWithBody({
      ownerUserId: u.id, artifactId: "art_rp_pw", body: "# secret",
    });
    await env.DB.prepare(
      "UPDATE published_artifacts SET mode = 'password', password_hash = 'pbkdf2$100000$AAAA$BBBB' WHERE share_token = ?",
    ).bind(shareToken).run();

    // Hand-mint a valid viewer cookie so we exercise the rendered response path.
    const cookieValue = await signViewerCookie(shareToken, env.VIEWER_COOKIE_SECRET);
    const res = await call(getReq(`/p/${shareToken}`, {
      cookie: `oyster_view_${shareToken}=${cookieValue}`,
    }));
    expect(res.status).toBe(200);
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd infra/oyster-publish && npm test -- --run test/viewer-handler.test.ts -t "Referrer-Policy"`
Expected: FAIL — header is currently absent on rendered responses.

- [ ] **Step 3: Update `cacheHeaders`**

Edit `infra/oyster-publish/src/viewer-render.ts`. Replace the `cacheHeaders` function with:

```ts
export function cacheHeaders(row: PublicationRow, contentType: string): HeadersInit {
  const headers: Record<string, string> = { "content-type": contentType };
  if (row.mode === "open") {
    headers["cache-control"] = "public, max-age=60, must-revalidate";
    headers["etag"] = `"${row.share_token}-${row.updated_at}"`;
  } else {
    headers["cache-control"] = "private, no-store";
  }
  // Block content-type sniffing across all responses.
  headers["x-content-type-options"] = "nosniff";
  // Defence in depth: don't surface URL info on subresource fetches or
  // onward navigation from the rendered page. Consistent with the
  // nonce-consumption 302; matters most if a future change introduces
  // any URL-shaped sensitive parameter on the viewer URL.
  headers["referrer-policy"] = "no-referrer";
  return headers;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd infra/oyster-publish && npm test -- --run test/viewer-handler.test.ts`
Expected: PASS — the two new Referrer-Policy tests, plus all previous tests.

- [ ] **Step 5: Commit**

```bash
git add infra/oyster-publish/src/viewer-render.ts \
        infra/oyster-publish/test/viewer-handler.test.ts
git commit -m "$(cat <<'EOF'
feat(publish): referrer-policy: no-referrer on rendered viewer responses

Defence in depth alongside the same header on the nonce-consumption 302.
Prevents any URL-shaped sensitive parameter from leaking via subresource
or onward-navigation Referer.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: Cross-host cookie-scoping regression test

This is the dedicated test file the spec calls out — it models real browser cookie behaviour (the apex session is NOT sent to `share.oyster.to`) and proves both the original loop AND the fix.

**Files:**
- Create: `infra/oyster-publish/test/signin-mode-cookie-boundary.test.ts`

- [ ] **Step 1: Write the test file**

Create `infra/oyster-publish/test/signin-mode-cookie-boundary.test.ts`:

```ts
// Regression: signin-mode handoff across the oyster.to / share.oyster.to
// cookie boundary.
//
// Production reality: the auth-worker sets `oyster_session` host-only on
// oyster.to (no Domain=), so browsers DO NOT send it to share.oyster.to.
// Tests in viewer-handler.test.ts that forge the cookie onto a
// share.oyster.to request hide this — they bypass the host-scoping the
// browser would enforce.
//
// This file models the real behaviour: cookies on oyster.to vs not on
// share.oyster.to, and asserts:
//   (a) without the access-redirect, signin mode is a closed loop, and
//   (b) with the access-redirect, the visitor can reach content.

import { describe, it, expect, beforeEach, beforeAll } from "vitest";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/worker";
import { applySchema, seedUser, seedActiveOpenWithBody } from "./fixtures/seed";

beforeAll(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (env as any).VIEWER_PASSWORD_LIMIT = { limit: async () => ({ success: true }) };
});

beforeEach(async () => {
  await applySchema();
});

function req(absUrl: string, opts: { cookie?: string } = {}): Request {
  const headers = new Headers();
  if (opts.cookie) headers.set("Cookie", opts.cookie);
  return new Request(absUrl, { method: "GET", headers });
}

async function call(r: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(r, env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

describe("signin mode across the oyster.to / share.oyster.to cookie boundary", () => {
  it("direct signin-mode visit to share.oyster.to without apex cookie → redirect to access-redirect", async () => {
    const u = await seedUser();
    const { shareToken } = await seedActiveOpenWithBody({
      ownerUserId: u.id, artifactId: "art_loop1", body: "# private",
    });
    await env.DB.prepare("UPDATE published_artifacts SET mode = 'signin' WHERE share_token = ?")
      .bind(shareToken).run();

    // Real browser: would NOT send oyster.to-host-only cookie to share.oyster.to.
    const res = await call(req(`https://share.oyster.to/p/${shareToken}`));
    expect(res.status).toBe(302);
    expect(res.headers.get("location"))
      .toBe(`https://oyster.to/api/publish/access-redirect/${shareToken}`);
  });

  it("oyster.to/p/<token> 308s to share.oyster.to even with an apex session — loop is real", async () => {
    // Demonstrates that the cookie boundary is enforced by the worker's
    // own legacy-origin 308: even though oyster.to/p sees the cookie,
    // the redirect strips the host and the next hop is share.oyster.to,
    // where the cookie cannot follow. Combined with the previous test,
    // this is the closed loop that existed before access-redirect.
    const u = await seedUser();
    const { shareToken } = await seedActiveOpenWithBody({
      ownerUserId: u.id, artifactId: "art_loop2", body: "# private",
    });
    await env.DB.prepare("UPDATE published_artifacts SET mode = 'signin' WHERE share_token = ?")
      .bind(shareToken).run();

    const res = await call(req(`https://oyster.to/p/${shareToken}`, {
      cookie: `oyster_session=${u.sessionToken}`,
    }));
    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toBe(`https://share.oyster.to/p/${shareToken}`);
  });

  it("access-redirect on oyster.to sees the apex session and produces a working cross-host handoff", async () => {
    const u = await seedUser();
    const { shareToken } = await seedActiveOpenWithBody({
      ownerUserId: u.id, artifactId: "art_loop3", body: "# private content",
    });
    await env.DB.prepare("UPDATE published_artifacts SET mode = 'signin' WHERE share_token = ?")
      .bind(shareToken).run();

    // Step 1: oyster.to sees the apex cookie (host-only on oyster.to).
    const step1 = await call(req(
      `https://oyster.to/api/publish/access-redirect/${shareToken}`,
      { cookie: `oyster_session=${u.sessionToken}` },
    ));
    expect(step1.status).toBe(302);
    const handoff = new URL(step1.headers.get("location")!);
    expect(handoff.origin + handoff.pathname).toBe(`https://share.oyster.to/p/${shareToken}`);
    const nonce = handoff.searchParams.get("key");
    expect(nonce).toMatch(/^[A-Za-z0-9_-]{22}$/);

    // Step 2: share.oyster.to consumes the nonce — NO apex cookie sent
    // here, matching real browser cookie scoping.
    const step2 = await call(req(handoff.toString()));
    expect(step2.status).toBe(302);
    expect(step2.headers.get("location")).toBe(`/p/${shareToken}`);
    const setCookie = step2.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain(`oyster_view_${shareToken}=`);
    const cookieValue = setCookie.match(/oyster_view_[^=]+=([^;]+)/)?.[1] ?? "";

    // Step 3: clean URL follow-up — still no apex cookie, only the
    // recent-access proof — must serve content.
    const step3 = await call(req(`https://share.oyster.to/p/${shareToken}`, {
      cookie: `oyster_view_${shareToken}=${cookieValue}`,
    }));
    expect(step3.status).toBe(200);
    expect(await step3.text()).toContain("private content");
  });
});
```

- [ ] **Step 2: Run to verify they pass**

Run: `cd infra/oyster-publish && npm test -- --run test/signin-mode-cookie-boundary.test.ts`
Expected: PASS — all 3 tests. (These tests describe behaviour that should already be in place after Tasks 4–7.)

- [ ] **Step 3: Commit**

```bash
git add infra/oyster-publish/test/signin-mode-cookie-boundary.test.ts
git commit -m "$(cat <<'EOF'
test(publish): cross-host cookie-scoping regression for signin mode

Models real browser cookie behaviour (apex oyster_session NOT sent to
share.oyster.to). Proves the original closed loop and the working
access-redirect handoff end-to-end. Catches future regressions where the
fix gets unwound or signin mode is otherwise re-tied to the apex cookie
boundary.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: CHANGELOG entry + regenerate docs/changelog.html

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `docs/changelog.html` (auto-generated)

- [ ] **Step 1: Add the CHANGELOG entry**

Edit `CHANGELOG.md`. Under the current "Unreleased" or topmost section, add one bullet under `Added` (create the `### Added` heading if absent). The bullet — user-visible only, no internal terminology:

```markdown
- **Sign in to view your own protected shares.** A password-protected share now offers a "Have access? Sign in to view" option alongside the password field; if you're signed in to Oyster as the owner, you skip the password.
```

- [ ] **Step 2: Regenerate the static changelog page**

Run: `cd /Users/Matthew.Slight/Dev/oyster-dev && npm run build:changelog`
Expected: rewrites `docs/changelog.html`.

- [ ] **Step 3: Commit**

```bash
git add CHANGELOG.md docs/changelog.html
git commit -m "$(cat <<'EOF'
docs(changelog): sign in to view your own protected shares

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 12: Full-suite sanity + PR

- [ ] **Step 1: Run the full test suites that the change touches**

```bash
cd /Users/Matthew.Slight/Dev/oyster-dev/infra/oyster-publish && npm test -- --run
cd /Users/Matthew.Slight/Dev/oyster-dev/infra/auth-worker && npm test -- --run
```

Expected: all tests pass in both packages. No skipped tests introduced.

- [ ] **Step 2: Type-check the whole repo**

```bash
cd /Users/Matthew.Slight/Dev/oyster-dev && npm run build
```

Expected: clean build. (`npm run build` runs `tsc` for web + server + copies web into server/dist/public/, per CLAUDE.md.)

- [ ] **Step 3: Push and open the PR**

```bash
git push -u origin feat/viewer-access-redirect
gh pr create --title "Viewer access redirect: owner bypass + signin handoff" --body "$(cat <<'EOF'
## Summary

- Adds `GET oyster.to/api/publish/access-redirect/:token` — owners of password shares (and any signed-in visitor for signin shares) get a single-click bypass.
- D1 `viewer_access_nonces` table with atomic single-use semantics; `share_token` is in the consume `WHERE` clause so a nonce minted for one share cannot be burned against another.
- Fixes a production bug in `signin` mode where the apex/share cookie split made the handoff a closed loop. `oyster_view_<token>` is now a generic recent-access proof honoured by both password and signin modes.
- `resolveViewerAccess` takes a required `{ consumeNonce }` option so `/raw` cannot accidentally start consuming nonces in a future change.
- New "Have access? Sign in to view" link on the password gate.
- Referrer-Policy: no-referrer on the nonce-consumption 302 AND on rendered viewer responses (defence in depth).

## Test plan

- [x] `infra/oyster-publish` test suite green (incl. new `access-nonce`, `access-redirect-handler`, `signin-mode-cookie-boundary`, and additions to `viewer-handler`).
- [x] `infra/auth-worker` test suite green (incl. new `return-path` cases).
- [x] Full TypeScript build clean.
- [ ] Manual: publish a password share locally; visit `share.oyster.to/p/<token>` while signed in; click "Sign in to view"; confirm 302 → consumption → content with no password prompt.
- [ ] Manual: same flow while signed out → sign in flow → bypass.
- [ ] Manual: non-owner clicks "Sign in to view" → 403 page with link back to the public gate.
- [ ] **Audit Cloudflare Logpush / Workers Analytics / wrangler tail for query-string capture on viewer URLs; disable or scrub `?key=` capture before merge.**

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Expected: PR URL printed.

---

## Self-review

**Spec coverage check:**

| Spec section | Plan task(s) |
|---|---|
| D1 table `viewer_access_nonces` | Task 1 |
| `mintAccessNonce` / `consumeAccessNonce` with atomic share_token-in-WHERE | Task 2 |
| Return-path allowlist accepts access-redirect path | Task 3 |
| Signin mode honours `oyster_view_<token>` cookie | Task 4 |
| `consumeNonce` required option on `resolveViewerAccess`; `/raw` MUST pass false; new `ok_via_nonce` kind | Task 5 |
| `handleViewerGet` handles `ok_via_nonce` — cookie + clean URL + cache-control + referrer-policy | Task 6 |
| `GET /api/publish/access-redirect/:token` full matrix (open / signin × auth / password × owner / non-owner / unauth) | Task 7 |
| 403 page for non-owner of password share | Task 7 (Step 3) |
| Gate-page "Have access? Sign in to view" link | Task 8 |
| `referrer-policy: no-referrer` on rendered viewer responses | Task 9 |
| Cross-host cookie-scoping regression test | Task 10 |
| CHANGELOG entry | Task 11 |
| Platform-log audit | Task 12 PR checklist (operational, not code) |
| Future: ACL widening | Documented inline in Task 7 handler ("widen the password case to an ACL") — no code change |

No gaps.

**Placeholder scan:** searched for TBD, TODO, "implement later", "similar to Task N" — none. Every step has the actual code or command. The one "TODO Task 6" mention in Task 5 Step 5 is a *transient* placeholder used during that single task and immediately replaced in Task 6.

**Type consistency:**
- `mintAccessNonce(env, shareToken, userId)` and `consumeAccessNonce(env, nonce, shareToken)` — same signatures everywhere they appear.
- `resolveViewerAccess(req, env, shareToken, opts)` — four-arg signature consistent across the function definition and all three callers in `worker.ts`.
- `noAccessPage(shareToken)` — single param, used in handler and imported in worker.ts.
- `hasValidViewerCookie(req, shareToken, secret)` — private helper, used twice within `viewer-access.ts`.
- `ViewerAccess` union extended with `ok_via_nonce` in Task 5, handled in Task 6 — no naming drift.

Looks coherent.
