# R5 Publish Backend — Design Spec

**Date:** 2026-05-03
**Status:** Approved for implementation
**Scope:** Backend only — `publish_artifact` / `unpublish_artifact` MCP tools, the matching HTTP routes on the local server, and a new `oyster-publish` Cloudflare Worker that owns the cloud publication state and R2 object storage. Public viewer (`GET /p/:token`) is scaffolded as `501 Not Implemented`; the viewer body lands in #316. UI lands in #317.

**Tracks:** Issue #315. Part of R5 in [`docs/requirements/oyster-cloud.md`](../../requirements/oyster-cloud.md).

---

## Problem

A user can produce an artefact in Oyster (markdown plan, single-file HTML mockup, mermaid diagram, deck-as-HTML) but has no way to share it. R5 requires *Publish* to turn any artefact into a resolvable URL with three access modes: open / password-protected / sign-in-required. The free account tier exists primarily to make this work — identity is needed both to publish and to view sign-in-gated content.

The R5 schema columns (`share_token`, `share_mode`, `share_password_hash`, `published_at`, `unpublished_at`) landed on the local `artifacts` table in #314. What's missing is the action that turns those columns from inert into populated: an MCP tool, an HTTP API, and the cloud infrastructure that actually serves bytes.

---

## Goals

- An agent calling `publish_artifact({ artifact_id, mode, password? })` gets back a **reserved** `share_url`. The URL becomes viewable when the public viewer (`GET /p/:token`) lands in #316; #315 reserves the token, stores the bytes in R2, and persists publication state in D1. Acceptance for #315 is that the token + R2 object + D1 row exist correctly, not that the URL serves bytes.
- The same call from the web UI (`POST /api/artifacts/:id/publish`) does the same thing — single internal helper, two callers.
- Publishing is upsert-by-artefact: stable URL across content edits and mode changes, only `unpublish_artifact` retires the token.
- Free-tier caps are enforced authoritatively (5 active publications per account, 10 MB per artefact).
- Plaintext passwords never leave the local server.

## Out of Scope

- Public viewer at `/p/:token` (#316). Worker scaffolds the route as `501 Not Implemented`.
- Publish UI in the artefact panel (#317).
- Multi-file bundles. Single-file artefacts only — bundles are #242–#248.
- Bandwidth metering. Count cap only.
- Token rotation as a distinct operation. The unpublish-then-republish path is the rotation primitive for 0.7.0.
- Pro-tier limits. 0.8.0+.
- Cross-device sync of publication state. Local SQLite mirror is single-machine; cloud D1 is the source of truth if local ever needs to be rebuilt (rebuilding is itself out of scope here).
- Automatic R2 orphan cleanup. See *Known limitations*.

---

## Topology

```
Local agent (MCP) ──┐
                    ├──> oyster-os local server  (server/src/routes/publish.ts)
Web UI ─────────────┘         │
                              │ - resolves current_user_id from oyster_session cookie
                              │ - reads artefact bytes from filesystem (~/Oyster/spaces/...)
                              │ - validates size locally (cheap pre-check, 10 MB)
                              │ - applies/validates artifacts.owner_id assignment
                              │ - if mode=password: derives password_hash (PBKDF2-SHA256, Node crypto)
                              │ - assembles X-Publish-Metadata blob
                              │ - proxies POST with raw bytes
                              ▼
              oyster-publish Worker  (NEW: infra/oyster-publish/)
                              │ - re-validates oyster_session via D1 sessions table (defence in depth)
                              │ - re-validates Content-Length ≤ 10 MB (authoritative)
                              │ - re-validates publish cap (authoritative)
                              │ - upserts published_artifacts row in D1
                              │ - PUTs bytes to R2 at published/{owner_user_id}/{share_token}
                              ▼
              D1 (oyster-auth DB, shared binding)
              R2 (oyster-artifacts bucket, NEW)
```

Three load-bearing topology decisions:

- **New Worker, not extension of `oyster-auth`.** Different failure domains (an R2 outage shouldn't take down sign-in), different deploy cadence (publish will iterate faster), cleaner secrets surface. Trade extra-binding for blast-radius isolation.
- **Shared D1 binding.** Both Workers bind to the same `oyster-auth` D1. `oyster-publish` reads `sessions` for auth and owns the new `published_artifacts` table. Avoids a service-to-service hop on every request.
- **Local server proxies the upload.** Client → local server → Worker. Not signed PUT URLs direct from client to R2. Single-file artefacts are small (≤ 10 MB); the round-trip cost is negligible and the hop lets the local server do owner-attribution against the local SQLite before bytes leave the machine.

---

## Schema

### Cloud — D1 migration `0003_publish.sql` (in `infra/auth-worker/migrations/`)

The migration lives with the auth-worker migration history because it shares the DB. The `oyster-publish` Worker doesn't manage its own migrations; it only binds and reads/writes.

```sql
-- Tier hook for entitlement checks. Always 'free' in 0.7.0; Pro lands in 0.8.0+.
ALTER TABLE users ADD COLUMN tier TEXT NOT NULL DEFAULT 'free';

CREATE TABLE published_artifacts (
  share_token       TEXT    PRIMARY KEY,
  owner_user_id     TEXT    NOT NULL REFERENCES users(id),
  artifact_id       TEXT    NOT NULL,            -- the source artefact id from local Oyster (uuid)
  artifact_kind     TEXT    NOT NULL,            -- denormalised for viewer rendering hints
  mode              TEXT    NOT NULL CHECK (mode IN ('open','password','signin')),
  password_hash     TEXT,                        -- "pbkdf2$100000$<salt_b64u>$<hash_b64u>", only when mode='password'
  r2_key            TEXT    NOT NULL,            -- "published/{owner_user_id}/{share_token}"
  content_type      TEXT    NOT NULL,
  size_bytes        INTEGER NOT NULL,
  published_at      INTEGER NOT NULL,            -- unix ms — first publication of this token (preserved across upserts)
  updated_at        INTEGER NOT NULL,            -- unix ms — last publish call
  unpublished_at    INTEGER,                     -- NULL while live; unix ms when retired
  CHECK (
    (mode = 'password' AND password_hash IS NOT NULL) OR
    (mode <> 'password' AND password_hash IS NULL)
  )
);

CREATE INDEX idx_pubart_owner ON published_artifacts(owner_user_id);

-- Active-publication uniqueness is scoped to (owner, artefact). artifact_id alone is not
-- globally unique across all users — two users can independently publish artefacts that
-- happen to share an id.
CREATE UNIQUE INDEX idx_pubart_active_per_owner_artifact
  ON published_artifacts(owner_user_id, artifact_id)
  WHERE unpublished_at IS NULL;
```

Historical rows are retained on unpublish (set `unpublished_at`, leave the row in place). This keeps token lookup correct: an old retired token resolves to a row whose `unpublished_at IS NOT NULL`, which the viewer (in #316) will render as `410 Gone`.

### Local — additive migration in `server/src/db.ts`

```sql
ALTER TABLE artifacts ADD COLUMN share_updated_at INTEGER;
-- existing R5 columns from #314: share_token, share_mode, share_password_hash, published_at, unpublished_at
```

**Local mirror semantics:**

- The Worker's response is the source of truth for timestamps. Local SQLite copies them verbatim — never derives `now()` locally for publish-lifecycle fields.
- On successful publish: write `share_token` ← `response.share_token`, `share_mode` ← `response.mode`, `share_password_hash` ← (the hash the local server forwarded — Worker doesn't echo it back), `published_at` ← `response.published_at`, `share_updated_at` ← `response.updated_at`, `unpublished_at` ← `NULL`.
- On successful unpublish: `unpublished_at` ← `response.unpublished_at`; **retain** `share_token`, `share_mode`, etc. The badge query is `share_token IS NOT NULL AND unpublished_at IS NULL`. Retaining the retired token gives the UI later affordances like *"Was published at /p/abc, now offline."*
- The local mirror is a fast-render cache. Cloud D1 is source of truth (which is exactly why timestamps come from the Worker, not from the local clock).

---

## Ownership rules

Two different ownership concepts; keep them separated:

- **Local artefact ownership** is `artifacts.owner_id` in the local SQLite. The local server enforces it.
  - On `publish_artifact`: if `owner_id IS NULL`, set it to the current signed-in user. If `owner_id` is non-NULL and `!= current_user.id`, reject with 403.
  - Once set, never overwrite.
- **Cloud publication ownership** is `published_artifacts.owner_user_id` in the cloud D1. The Worker enforces it.
  - On `publish_artifact` upsert: every active-row lookup is scoped to the calling session's `owner_user_id`. The unique index is `(owner_user_id, artifact_id) WHERE unpublished_at IS NULL`, so different users may publish artefacts that happen to share an `artifact_id` without conflict — they live as separate rows with different tokens. The Worker never queries by `artifact_id` alone.
  - On `unpublish_artifact`: row's `owner_user_id` must equal the calling session's user — else 403.

The Worker does not (and cannot) check local artefact ownership. The local server has already done that before bytes leave the machine.

---

## MCP tools

Registered in `server/src/mcp-server.ts`. Both call into a shared internal helper (`server/src/publish-service.ts` or similar — exact module name to be settled in the plan) so the HTTP routes don't duplicate logic.

```ts
publish_artifact({
  artifact_id: string,
  mode: 'open' | 'password' | 'signin',
  password?: string,                  // required & non-empty when mode='password'
}) → {
  share_token: string,
  share_url: string,                  // "https://oyster.to/p/{token}"
  mode: 'open' | 'password' | 'signin',
  published_at: number,               // unix ms — first publication
  updated_at: number,                 // unix ms — this call
}

unpublish_artifact({
  artifact_id: string,
}) → {
  ok: true,
  share_token: string,                // for caller's confirmation; echoes the retired token
  unpublished_at: number,             // unix ms
}
```

Password is never echoed in any response — only `mode === 'password'` is observable.

---

## HTTP routes (local server)

In a new `server/src/routes/publish.ts`, following the extraction pattern from `routes/oauth-mcp.ts`, `routes/import.ts`, `routes/static.ts`.

```
POST   /api/artifacts/:id/publish
  Headers: Cookie: oyster_session=…
  Body:    JSON { mode: 'open'|'password'|'signin', password?: string }
  → 200 { share_token, share_url, mode, published_at, updated_at }
  → 401 sign_in_required
  → 403 not_artifact_owner
  → 404 artifact_not_found
  → 402 publish_cap_exceeded
  → 413 artifact_too_large
  → 400 password_required | invalid_mode

DELETE /api/artifacts/:id/publish
  Headers: Cookie: oyster_session=…
  → 200 { ok: true, share_token, unpublished_at }
  → 401 sign_in_required
  → 403 not_publication_owner
  → 404 publication_not_found    (local artefact has no live share_token in mirror)
```

The local server derives `share_token` from the local SQLite mirror (`artifacts.share_token` of the row matching `:id`), then calls `DELETE /api/publish/:share_token` on the Worker. If the local row has no `share_token`, or `unpublished_at IS NOT NULL`, the local server returns 404 `publication_not_found` without contacting the Worker.

---

## Worker endpoints (`oyster-publish`)

Two real endpoints in #315; viewer is scaffolded.

```
POST /api/publish/upload
  Headers:
    Cookie: oyster_session=…                       (required)
    X-Publish-Metadata: <base64url(json)>          (required — see schema below)
    Content-Type: <mime>                           (recorded as content_type)
    Content-Length: <bytes>                        (REQUIRED — 411 if missing)
  Body: raw bytes (≤ 10 MB)

  X-Publish-Metadata payload (decoded from base64url):
    {
      "artifact_id":   string,
      "artifact_kind": string,
      "mode":          "open" | "password" | "signin",
      "password_hash": string                       // only when mode='password';
                                                    // format "pbkdf2$100000$<salt_b64u>$<hash_b64u>"
                                                    // produced by the local server
    }

  Steps:
    1. resolveSession(cookie) → owner_user_id, or 401 sign_in_required
    2. parse + validate X-Publish-Metadata → 400 invalid_metadata if malformed
    3. assert mode='password' implies password_hash present → 400 password_required
    4. assert Content-Length present → 411 content_length_required
    5. SELECT user.tier; lookup CAPS[tier];
       assert Content-Length ≤ CAPS[tier].max_size_bytes → 413 artifact_too_large
    6. Determine final share_token via "find or claim":
       a. SELECT existing active row WHERE owner_user_id = current AND artifact_id = requested
          (queries are always scoped to current owner_user_id — the unique index is per
           (owner, artifact), so different owners never collide)
       b. if exists: share_token = existing.share_token; path = 'upsert';
                     preserve existing published_at
       c. if not exists:
          i.   count active publications for owner_user_id
          ii.  if count ≥ CAPS[tier].max_active → 402 publish_cap_exceeded
          iii. generate candidate_token via crypto.getRandomValues(new Uint8Array(24)) → base64url
          iv.  try INSERT new published_artifacts row with candidate_token, metadata from
               headers, size_bytes from Content-Length, r2_key derived from candidate_token,
               published_at = updated_at = now
               - on success: share_token = candidate_token; path = 'first-publish'
               - on unique-constraint violation (race with concurrent first-publish):
                 re-SELECT existing active row for (owner_user_id, artifact_id);
                 share_token = existing.share_token; path = 'upsert' (race-recovered);
                 preserve existing published_at
    7. Stream body to R2 at published/{owner_user_id}/{share_token}; abort + return 413
       artifact_too_large if streamed bytes exceed CAPS[tier].max_size_bytes (defence
       against a lying or absent Content-Length); on abort, if path = 'first-publish',
       DELETE the speculatively-inserted D1 row; if path = 'upsert', leave existing row
       untouched (no UPDATE was applied yet).
    8. D1 commit:
       - if path = 'upsert': UPDATE row — mode, password_hash, content_type, size_bytes,
                             updated_at = now (published_at preserved)
       - if path = 'first-publish': row already inserted in step 6; no-op (or UPDATE
                                    updated_at if step 7 took meaningful time)
    9. Return 200 { share_token, share_url, mode, published_at, updated_at }

DELETE /api/publish/:share_token
  Headers: Cookie: oyster_session=…                (required)
  Steps:
    1. resolveSession → user_id, or 401
    2. SELECT row WHERE share_token = ? → 404 publication_not_found if missing
    3. If row.owner_user_id != user_id → 403 not_publication_owner
    4. If row.unpublished_at IS NOT NULL → 200 idempotent (no-op, return current state)
    5. UPDATE row SET unpublished_at = now()
    6. R2 DELETE published/{owner_user_id}/{share_token} — best effort
       (D1 is source of truth; R2 orphan is acceptable, see Known limitations)
    7. Return 200 { ok: true, share_token, unpublished_at }

GET /p/:share_token
  → 501 Not Implemented (viewer body lands in #316)
```

**`signin` mode in #315 is metadata-only.** The mode is stored in D1 by `POST /api/publish/upload`; viewer enforcement (rejecting unsigned visitors, accepting signed ones) is implemented in #316. Storing it now means the viewer in #316 can land without a schema change.

---

## Password handling

Plaintext passwords never leave the local server. Two reasons: (a) headers are routinely captured in logs / traces / proxies / dev tooling, (b) the Worker doesn't need the plaintext — verification happens later in the viewer (#316).

**Hash format:** `pbkdf2$<iter>$<salt_b64url>$<hash_b64url>`

| Param | Value |
|---|---|
| Algorithm | PBKDF2-SHA256 |
| Iterations | 100000 |
| Salt | 16 random bytes (`crypto.randomBytes(16)` in Node) |
| Hash length | 32 bytes |
| Encoding | base64url (no padding) |

Local server uses Node's `crypto.pbkdf2` and `crypto.randomBytes`. Worker viewer (in #316) verifies via Web Crypto's `subtle.deriveBits` with PBKDF2 — same parameters, same output, portable.

Empty password with `mode='password'` is rejected at the local server with 400 `password_required`. The Worker also rejects (defence in depth) if the `password_hash` field is missing from the metadata blob.

---

## Tier caps

A single source of truth in the Worker:

```ts
const CAPS = {
  free: { max_active: 5, max_size_bytes: 10 * 1024 * 1024 },  // 10 MB
  // pro: { … }   ← lands in 0.8.0+
} as const;
```

Per-tier values are read off `users.tier` and used at the Worker for both `publish_cap_exceeded` (402) and `artifact_too_large` (413). Local server pre-checks size against the free-tier value (the only tier that exists in 0.7.0); if the user is on a higher tier it'll just be a smaller-than-needed pre-check (always safe — the Worker is authoritative).

## Token generation

```
crypto.getRandomValues(new Uint8Array(24))  →  base64url-encode  →  32-char string
```

~192 bits of entropy. URL-safe by construction. No charset translation.

---

## R2

- **Bucket:** `oyster-artifacts` (provisioned via `wrangler r2 bucket create oyster-artifacts` as part of the deploy step).
- **Key shape:** `published/{owner_user_id}/{share_token}`.
- **Object metadata:** content-type recorded both on the R2 object (HTTP serve hint) and in D1 (source of truth).
- **Lifecycle rules:** none. Unpublish triggers explicit `R2 DELETE`. Orphan cleanup is deferred (see Known limitations).

---

## Error matrix

All errors return JSON `{ error: <code>, message: <human-readable>, ... }`. The local server proxies Worker error responses verbatim so MCP callers and HTTP callers see the same shapes.

| Condition | HTTP | `error` code | Notes |
|---|---|---|---|
| Missing/invalid `oyster_session` cookie | 401 | `sign_in_required` | "Sign in to publish artefacts." |
| Wrong owner on existing local artefact | 403 | `not_artifact_owner` | Local server enforced. |
| Wrong owner on existing cloud publication | 403 | `not_publication_owner` | Worker enforced. |
| Local artefact not found | 404 | `artifact_not_found` | Local server. |
| Cloud publication not found (DELETE) | 404 | `publication_not_found` | Worker. |
| Cap exceeded | 402 | `publish_cap_exceeded` | `{current, limit:5, message:"Free tier allows 5 active published artefacts. Unpublish one first."}`. Authoritative at Worker. |
| `Content-Length` missing | 411 | `content_length_required` | Worker. |
| Body > 10 MB | 413 | `artifact_too_large` | `{limit_bytes:10485760, message:"Free tier allows published artefacts up to 10 MB."}`. Local server pre-checks; Worker is authoritative. |
| `mode='password'` with empty password | 400 | `password_required` | Local server. |
| Invalid `mode` value | 400 | `invalid_mode` | Local server (and Worker, defence in depth). |
| Invalid metadata blob | 400 | `invalid_metadata` | Worker only — happens if local server is buggy. |
| R2 PUT failure (transient) | 502 | `upload_failed` | Worker logs cause; client retry-safe. |

---

## Testing

### Unit (Worker, Vitest + miniflare)

- Token generation: format conforms to base64url, length 32, entropy via 24-byte buffer.
- PBKDF2 verify round-trip: hash a known plaintext via Node's `crypto.pbkdf2`, verify via Web Crypto in the Worker, assert match.
- Cap calculation: count of active publications correctly ignores rows with `unpublished_at IS NOT NULL`.

### Integration (Worker, Vitest + miniflare D1 + R2 mock)

- Publish → re-publish: same `share_token`, fresh bytes in R2, `published_at` preserved, `updated_at` bumped, `mode` change reflected.
- Publish → unpublish → publish: new `share_token`, old row marked `unpublished_at`, R2 object for old token deleted, R2 object for new token present.
- 6th publish hits 402: 5 active rows in fixture, attempt to publish a 6th unrelated artefact returns `publish_cap_exceeded`.
- 11 MB Content-Length returns 413 before any body is read.
- Streamed body exceeds 10 MB despite Content-Length under 10 MB: stream is aborted, 413 returned, no D1 row left behind.
- Two concurrent first-publish calls for the same `(owner, artifact_id)` both return 200 with the *same* `share_token`; D1 has exactly one row; R2 has one object; loser's bytes win (last-write-wins).
- Two different users publish artefacts that share an `artifact_id`: both succeed, two distinct rows, two distinct tokens, no conflict.
- D1 CHECK constraint rejects an INSERT with `mode='open'` and a non-NULL `password_hash`, and rejects `mode='password'` with NULL `password_hash`.
- Wrong-owner attempt on existing publication returns 403 `not_publication_owner`.
- DELETE on already-unpublished row is idempotent (returns 200, doesn't change `unpublished_at`).

### Local server (server/tests, existing pattern)

- `routes/publish.ts` correctly assembles `X-Publish-Metadata` (decoded matches expected JSON for each mode).
- Plaintext password is hashed before forwarding; raw password never appears in any header or proxied byte stream.
- `artifacts.owner_id` set on first publish, preserved thereafter, rejected if mismatched.
- Worker error responses (status code + JSON body) propagate verbatim to the HTTP caller.

### Smoke (post-deploy, manual)

- `curl` round-trip against `oyster.to`: publish a 1 KB markdown, fetch the row from D1 (`wrangler d1 execute`), unpublish, confirm `unpublished_at` set, confirm R2 object gone (`wrangler r2 object list oyster-artifacts`).

---

## Known limitations (explicit deferrals)

1. **R2 orphan cleanup is deferred.** Order of operations is `R2 PUT → D1 upsert`. If D1 upsert fails after R2 PUT succeeds, the bytes are orphaned. D1 is source of truth — orphans are invisible to users (no row → no token → no URL). Cleanup is deferred to a future janitor (could be a Cron Trigger that lists R2, joins to D1, deletes objects with no live row).
2. **Cap pre-check is skipped at the local server.** The local server has no live view of the publish cap; it would have to call the Worker. The local server still pre-checks size, owner attribution, and password validity (all local), but the cap check happens authoritatively at the Worker. A user may upload bytes only to learn at the Worker that they're over cap — acceptable tradeoff (10 MB max upload, single round-trip).
3. **Cross-device awareness of publish state.** Local SQLite mirror is single-machine. If a user publishes from machine A and signs in on machine B, machine B's UI will not show the publication until R3 sync arrives in 0.8.0+. Cloud D1 retains the truth; the Worker can serve the public URL regardless.
4. **No bandwidth metering.** Free-tier abuse vector is bounded by the count cap (5 × 10 MB = 50 MB total bytes published per free user). Bandwidth metering is a future concern.
5. **Token rotation requires unpublish + republish.** No dedicated rotate operation. If anyone needs token rotation as a discrete action, a future `rotate_share_token` MCP tool can be added.

---

## Decisions log (for future-me)

| Question | Decision | Reason |
|---|---|---|
| New Worker vs. extend `oyster-auth`? | New `oyster-publish` Worker. | Blast-radius isolation; different deploy cadence; cleaner secrets. |
| Free tier max active publications? | 5. | Bounds bandwidth via cap × size limit. |
| Free tier max artefact size? | 10 MB. | Comfortably covers prose markdown, single-HTML, mermaid, lightweight decks. Image-heavy is a Pro concern. |
| Token format? | base64url, 32 chars, 192-bit entropy. | URL-safe by construction; no charset translation. |
| Re-publish semantics? | Upsert by artifact_id, stable token, fresh bytes + mode every call. `published_at` preserved; `updated_at` bumped. | Matches user mental model: "publish my updated mockup" → same URL, fresh content. |
| Where is plaintext password? | Stays at the local server; PBKDF2-hashed before transit. | Headers are routinely logged. Worker doesn't need plaintext. |
| Active-publication uniqueness? | Scoped to `(owner_user_id, artifact_id)`. | `artifact_id` alone is not globally unique across users. |
| Local DB on unpublish? | Retain `share_token`; mark `unpublished_at`. Badge query is `share_token IS NOT NULL AND unpublished_at IS NULL`. | Enables "Was published at /p/abc, now offline" affordances later. |
| R2 PUT vs. D1 upsert order? | R2 first, then D1. Accept orphan risk. | Avoids D1 row pointing at missing bytes. D1 is source of truth. |
| `signin` mode in #315? | Stored as metadata only. Viewer enforcement is #316. | Lets the viewer ship without a schema change. |
| Upload payload format? | Raw bytes in body, JSON metadata in `X-Publish-Metadata` header (base64url). | Simpler than multipart; lets metadata extend without more headers; keeps body purely bytes. |
| Cap pre-check at local server? | Skipped (size-only pre-check). | No live cap view at local server; one extra round-trip not worth it. Worker is authoritative. |
| Tier hook in 0.7.0? | Yes — `users.tier TEXT NOT NULL DEFAULT 'free'` + `CAPS` map at the Worker. | One-line schema add. Avoids a 0.8.0 backfill migration on every existing user. Pro values land in 0.8.0. |
| First-publish concurrency? | INSERT-then-recover. Race losers re-SELECT the active row, treat as upsert path, return 200 with the winning token. | Atomic claim via the partial unique index; cleaner than pre-locking. Last-write-wins for body bytes. |
| Local SQLite timestamps? | Mirror Worker response verbatim (`response.published_at`, `response.updated_at`, `response.unpublished_at`). | Avoids clock drift between local and cloud; cloud is source of truth for publication state. |
| D1 CHECK on `password_hash`? | Yes — `(mode='password' AND password_hash NOT NULL) OR (mode≠'password' AND password_hash NULL)`. | Catches metadata-tampering bugs and mode/hash drift at the schema level. |
| Stream-size enforcement? | Yes — Worker aborts the R2 upload if streamed bytes exceed `CAPS[tier].max_size_bytes`, regardless of `Content-Length`. | `Content-Length` is client-controlled; trust it for the pre-check, enforce it for real on the stream. |

---

## Implementation sequence (for the plan that follows)

This spec is single-PR-able but heavy. Suggested split (will be settled by `superpowers:writing-plans`):

1. **PR 1 — `oyster-publish` Worker scaffold + D1 migration + R2 bucket.** Empty endpoints (`501`), wrangler.toml, Vitest setup, deploy. No client integration.
2. **PR 2 — Worker publish + unpublish endpoints.** Real upload + storage + cap + size enforcement. Contract tests against the Worker only. Local server still untouched.
3. **PR 3 — Local server `routes/publish.ts` + `publish-service.ts`.** HTTP route + MCP tool registration + ALTER on local SQLite. End-to-end against the deployed Worker.

Anchors: `infra/auth-worker/` is the template for PR 1's Worker shape (Vitest setup, D1 + secret patterns, route registration, structured console error logging). Route extraction pattern (`routes/oauth-mcp.ts`, `routes/import.ts`, `routes/static.ts`) is the template for PR 3.

---

## Anchor docs

- [`docs/requirements/oyster-cloud.md`](../../requirements/oyster-cloud.md) — R5 canonical requirement.
- [`docs/plans/roadmap.md`](../../plans/roadmap.md) — 0.7.0 milestone scope.
- [`docs/plans/0.5.0-gap-matrix.md`](../../plans/0.5.0-gap-matrix.md) — R5 section.
- [`docs/plans/auth.md`](../../plans/auth.md) and [`docs/plans/auth-oauth.md`](../../plans/auth-oauth.md) — identity substrate this builds on.
- Issue #315.
