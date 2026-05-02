# Auth (free account, magic-link)

> **Status:** canonical for 0.7.0. Cites [`docs/requirements/oyster-cloud.md`](../requirements/oyster-cloud.md) — does not redefine those outcomes. If a requirement and this doc conflict, the requirement wins.

## Decision

**Cloudflare-native auth.** D1 for users + sessions, a Worker at `oyster.to/auth/*` for the flow, Resend for transactional email, an Oyster-internal device-code handoff to bridge the browser sign-in to the local server at `localhost:4444`. **GitHub OAuth is the primary sign-in path** as of #340 (see [`auth-oauth.md`](./auth-oauth.md)); magic-link is the secondary fallback documented below. No passwords. No MFA in 0.7.0.

```
Browser (oyster.to/sign-in)
   │   email entry
   ▼
Cloudflare Worker (oyster.to/auth/*)
   │   POST /auth/magic-link  →  D1 tokens row, Resend send
   ▼
User's mailbox  →  click link
   │
   ▼
Cloudflare Worker  GET /auth/verify?token=...
   │   D1 sessions row, Set-Cookie session=…  on .oyster.to
   ▼
Browser is now signed in for oyster.to (publish UI, viewer sign-in mode)

Local Oyster (localhost:4444) bridges via device flow:
   1. `oyster auth login` → server mints device_code, opens oyster.to/sign-in?d=<code>
   2. User signs in (steps above) — verify endpoint also associates session with device_code
   3. Local server polls oyster.to/auth/device/<code> for the session token
   4. Token persists at ~/Oyster/config/auth.json  →  every local request reads it
```

## Requirements served

- **R5 Publish & share** — sign-in mode (`mode = 'signin'`) requires a viewer to be authenticated; `publish_artifact` attributes ownership to the calling user. Both need an account system.
- **Funnel for free signups** — the pricing page promise of *free identity that lights up Publish* is true the moment this lands.
- **Foundation for 0.8.0 Pro continuity** — the same `~/Oyster/config/auth.json` token + same D1 user table become the identity layer for cloud memory store (R1, R3, R4). Building it now is the work the roadmap already has.

## Why Cloudflare-native (not Supabase, not hybrid)

The waitlist Worker has already paid the bootstrap cost (DNS, DKIM/SPF, account, deploy). 0.8.0's cloud memory store is described as Cloudflare-native in [`agent-memory-api.md`](./agent-memory-api.md). Picking Supabase here means either dragging it into 0.8.0 (half-Supabase / half-CF Cloud) or ripping it out between releases. The "less code with Supabase Auth" saving is ~150 lines of magic-link plumbing — real but not load-bearing, and the pieces it covers (deliverability, OAuth, MFA, password reset) are all things 0.7.0 doesn't need.

The full A/B/C tradeoff was worked through in conversation; this doc records the chosen path, not the alternatives.

## D1 schema

Four tables. Additive only — D1 supports `ALTER TABLE ADD COLUMN` so future fields (display_name, plan, etc.) can land without rebuilds.

```sql
CREATE TABLE users (
  id              TEXT PRIMARY KEY,                  -- ulid
  email           TEXT NOT NULL UNIQUE,              -- lowercased on insert
  created_at      INTEGER NOT NULL,                  -- unix ms
  last_seen_at    INTEGER NOT NULL                   -- unix ms; bump on session activity
);

CREATE TABLE magic_link_tokens (
  token_hash      TEXT PRIMARY KEY,                  -- sha256 of the random token; raw token never stored
  user_id         TEXT NOT NULL REFERENCES users(id),
  device_code     TEXT REFERENCES device_codes(device_code),  -- nullable; set when login originated from a device-flow
  expires_at      INTEGER NOT NULL,                  -- unix ms; default +15 min
  consumed_at     INTEGER                            -- unix ms; set on verify, single-use
);
CREATE INDEX magic_link_tokens_user_expires ON magic_link_tokens(user_id, expires_at);

CREATE TABLE sessions (
  id              TEXT PRIMARY KEY,                  -- ulid; opaque session token (cookie value + device-flow result)
  user_id         TEXT NOT NULL REFERENCES users(id),
  created_at      INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL,                  -- 30 days; sliding renewal on activity
  revoked_at      INTEGER                            -- unix ms; set on sign-out
);
CREATE INDEX sessions_user ON sessions(user_id);

-- Device-flow handoff. RFC 8628 shape: `device_code` is the long opaque token
-- the local server polls with (private to the device); `user_code` is the
-- short readable token that travels through the browser URL. Storing both
-- keeps the lookup direction unambiguous: browser submits `user_code` →
-- Worker resolves to `device_code` row → magic-link-verify writes
-- `session_id` → local poller reads by `device_code`.
CREATE TABLE device_codes (
  device_code     TEXT PRIMARY KEY,                  -- 32-char base64url; what the local server polls with
  user_code       TEXT NOT NULL UNIQUE,              -- 8-char base32 (e.g. BHRT-9KQ2); what the user sees in the URL
  session_id      TEXT REFERENCES sessions(id),      -- null until verify; set once
  expires_at      INTEGER NOT NULL,                  -- 10 min
  claimed_at      INTEGER                            -- set when local poller picks up the token
);
```

**Why hash the magic-link token but not the session id.** Magic-link tokens are short-lived (15 min) and arrive in URLs that may be logged by mail servers and proxies; hashing limits the blast radius if the D1 row leaks. Session ids only travel over HTTPS in a cookie or as a `Bearer` header to localhost; a stolen DB row is a deeper breach already.

**Why D1 here is fine.** Users table is small and read-heavy on `email`. Sessions table is per-request hot but each row is ~80 bytes; even at 100k MAU we're well inside D1's free tier. No joins across regions; reads are local to the Worker's region.

## Auth Worker — endpoints

All endpoints live on a `oyster.to/auth/*` route group. The Worker owns its own `wrangler.toml`; deploy is independent of the local server.

- `POST /auth/magic-link  { email, user_code? }`
  Looks up or creates the user (idempotent on email). Generates a 32-byte random magic-link token (base64url, ~43 chars), stores `sha256(token)`, sends email via Resend with link `https://oyster.to/auth/verify?t=<raw>`. If `user_code` is present, resolves it to the row in `device_codes` and writes that row's `device_code` onto `magic_link_tokens.device_code` so verify can later attach the resulting session to the right poller. Per-email rate limit (3 sends per 10 minutes) is a D1 row-count over `magic_link_tokens`; per-IP rate limit (20 magic-link requests per hour) uses Cloudflare's [Workers Rate Limiting binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/) keyed on `cf.connecting_ip` — the schema deliberately doesn't store IPs. Returns `{ ok: true }` regardless of whether the email exists, so the endpoint can't be used to enumerate accounts.

- `GET /auth/verify?t=<token>`
  Hashes `t`, looks up the token row, checks `expires_at > now AND consumed_at IS NULL`, marks `consumed_at`, creates a session, then:
  - If the token had no `device_code`: `Set-Cookie session=<session_id>; Domain=.oyster.to; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000` and 302 to `/`.
  - If the token had a `device_code`: write `sessions.id` to `device_codes.session_id`, render a "you can close this window" page. The cookie is *also* set so the same browser can use the publish UI.

- `GET /auth/device/<device_code>`
  Polled by the local server using the long opaque `device_code` (not `user_code`). Returns `{ session_token: <id>, user: { id, email } }` once `device_codes.session_id` is set, then marks `claimed_at`. Subsequent calls return 410. Pre-claim returns 202.

- `POST /auth/sign-out  Cookie: session=...`
  Sets `sessions.revoked_at`, clears the cookie. Returns 204.

- `GET /auth/whoami  Cookie: session=...  OR  Authorization: Bearer <session_id>`
  Returns `{ id, email }` for a valid session, 401 otherwise. Used by both the oyster.to UI and the local server.

## Cookie / token model

Two surfaces, two storage shapes, **same session id**.

- **Browser on `oyster.to`** — session id in a `.oyster.to`-scoped HttpOnly Secure cookie. The viewer Worker (#316) reads this for sign-in mode; the publish UI on the marketing surface reads it for "Signed in as X".
- **Local server `localhost:4444`** — session id in `~/Oyster/config/auth.json` (`{ session_token: "...", user_id: "...", email: "..." }`). The local server adds `Authorization: Bearer <session_token>` when calling `auth.oyster.to/whoami` or any future cloud endpoint.

Same session row in D1 backs both. Sign-out from one surface revokes the other on next request.

## Local-server bridge (device flow)

The browser cookie can't reach `localhost:4444` (different origin, no shared cookie). And we don't want a copy-paste UX. Industry standard for this is OAuth 2.0 device authorization grant — what `gh auth login`, `stripe login`, and `vercel login` use.

Sequence (RFC 8628 shape):

1. User clicks **Sign in** in the local Oyster UI (or runs `oyster auth login`).
2. Local server calls `POST oyster.to/auth/device-init` → Worker creates a `device_codes` row and returns `{ device_code, user_code, expires_in }`. `device_code` is the long opaque key the device polls with; `user_code` is the short readable form that travels through the browser URL.
3. Local server opens `https://oyster.to/sign-in?d=<user_code>` in the system browser. The local server keeps the long `device_code` private.
4. The sign-in page reads `user_code` from the query string and submits `POST /auth/magic-link { email, user_code }`. The Worker resolves `user_code` → `device_code` via `device_codes` and writes that `device_code` onto `magic_link_tokens.device_code`.
5. User receives email, clicks the link, hits `/auth/verify`. The Worker creates the session, sets the `.oyster.to` cookie, and — if the consumed token has a `device_code` — writes `sessions.id` to `device_codes.session_id`.
6. Local server polls `GET /auth/device/<device_code>` every 2 seconds. On 200, it persists `~/Oyster/config/auth.json` and stops polling. Total flow ≤ ~30s of user time after they click the email.

The browser only ever sees `user_code`; the local server only ever sees `device_code`. `device_codes` is the lookup table that bridges them.

## Rate limiting / abuse

Two layers, two storage shapes:

- **Per-email** — D1 row count over `magic_link_tokens` for the user, capped at 3 sends per 10 minutes. O(1) on the `magic_link_tokens_user_expires` index. Prevents mail-bombing a target.
- **Per-IP** — [Workers Rate Limiting binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/) keyed on `cf.connecting_ip`, capped at 20 magic-link requests per hour. Edge-counted, no D1 row needed; the schema deliberately doesn't store IPs (no log/PII concern). Prevents enumeration spray.

Magic-link tokens expire after 15 minutes. Sessions expire after 30 days, sliding (every authenticated request bumps `expires_at` to `now + 30d` if it's <7d away — avoids hot-write per request).

## Email — Resend over Postmark

Resend, because (a) it runs on Cloudflare itself (lower hop), (b) the Workers SDK is one fetch call, (c) free tier (3k/month, 100/day) carries us through early launch, (d) the magic-link template is one HTML file we control. Postmark is the better-established alternative; if deliverability becomes an issue, switching providers is one Worker secret change.

The from address starts as `noreply@oyster.to` with `Reply-To: matthew@slight.me` so a confused user can email us. Subject: `Sign in to Oyster`. Body: short HTML, one button, six-hour quiet.

## Providers

GitHub OAuth is the primary sign-in path. The full design — endpoints, schema delta (`user_identities`, `oauth_states`), identity-resolution rules, and PR sequencing — lives in [`auth-oauth.md`](./auth-oauth.md). The magic-link substrate documented in this doc is unchanged; OAuth ships alongside it as the primary CTA, with magic-link as the secondary fallback.

## What 0.7.0 does NOT include

- **Google sign-in.** Deferred until GitHub lands cleanly. Same Worker, same schema, same identity-resolution rule — adds `/auth/google/start` and `/auth/google/callback`. See [`auth-oauth.md`](./auth-oauth.md) for the OAuth design.
- **MFA.** Not a free-tier requirement.
- **Password reset.** No passwords.
- **Account deletion.** Cap on the user table is an entitlement question for 0.7.0; the GDPR-shape "delete my account" can land as a one-shot Worker endpoint when the first user requests it.
- **Email change.** Same — when needed.
- **Display names / avatars.** When publish UI needs them.
- **Admin / staff tooling.** When real.

## Open questions to settle in implementation PRs

- **Worker layout.** Both auth and the viewer route live on `oyster.to` (path-based). Open question is whether one Worker handles `/auth/*` + `/s/*`, or each path gets its own Worker assigned to the same hostname via separate route patterns. Likely one Worker for now — fewer deploys, less Wrangler config — split if the viewer's bundle grows.
- **D1 schema migration tooling.** Cloudflare's `wrangler d1 migrations` is the obvious pick; settle when the first migration lands.
- **`device_code` polling cadence.** Currently 2s; could back off after 10s to 5s. Settle by feel during local testing.
- **Cookie name collision.** `session` is generic; if oyster.to ever hosts a non-Oyster service the cookie name would collide. Prefix with `oyster_` to be safe.
- **Local-server token rotation.** When the local server detects 401 from a cloud endpoint, does it auto-prompt re-sign-in or surface a banner? UX call when the first cloud-touching feature lands.

## Sequencing inside #295

Three PRs, smallest first:

1. **D1 schema + Worker scaffold.** `wrangler.toml`, four table migrations (`users`, `magic_link_tokens`, `sessions`, `device_codes`), `whoami` endpoint that always returns 401. Verifiable in isolation: deploy the Worker, hit the endpoint, see 401.
2. **Magic-link send + verify.** `POST /magic-link`, `GET /verify`, Resend integration, cookie issue. Verifiable: enter email, receive email, click link, browser is signed in, `whoami` returns the user.
3. **Device flow + local bridge.** `device-init`, `device/<code>`, `/auth/sign-out`, `~/Oyster/config/auth.json` writer in the local server, sign-in button in the local UI. Verifiable: click sign-in in Oyster, complete flow, local UI shows signed-in state.

Each PR is reviewable on its own; the milestone unblocks #316 (viewer sign-in mode) once PR 2 lands.

## How to update this doc

Replace, don't append, when a decision changes. If we ever swap the email provider or move sessions out of D1, that's a fork in this doc, not a layer added on top — and a check against R1–R7 to make sure the requirements still hold under the new shape.
