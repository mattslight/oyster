# Auth: OAuth (GitHub primary, Google deferred)

> **Status:** canonical for 0.7.0 OAuth work (#340). Supplements [`auth.md`](./auth.md), which covers the magic-link substrate (#336/#337/#338/#339). When this doc and `auth.md` disagree on the OAuth path, this doc wins; `auth.md` remains canonical for magic-link. If a requirement in [`docs/requirements/oyster-cloud.md`](../requirements/oyster-cloud.md) and this doc conflict, the requirement wins.

## Decision

OAuth via the existing `oyster-auth` Cloudflare Worker on `oyster.to`. **GitHub** is the only provider for 0.7.0; Google is deferred to a follow-up issue. **Magic-link stays as a secondary fallback** for users without a GitHub account or who prefer email.

Identity is resolved through a new `user_identities` table keyed on `(provider, provider_user_id)` — provider IDs are stable across email changes, email is not. The local Oyster app's existing sign-in handoff (`device-init` → `?d=<user_code>` → poll, shipped in #339) is reused unchanged; OAuth is the *inner* loop, not a replacement.

## User-facing description

> Sign in with GitHub. Oyster opens your browser, you authorise, and Oyster signs in.

Three clicks: Sign in (in Oyster) → Continue with GitHub (in browser) → Authorise (on GitHub). No inbox, no codes.

```
Local Oyster (UNCHANGED — shipped in #339):
  POST oyster.to/auth/device-init       → { device_code, user_code }
  open browser to oyster.to/auth/sign-in?d=<user_code>
  poll oyster.to/auth/device/<device_code> until session attaches

oyster.to/auth/sign-in?d=<user_code>:
  Primary CTA: "Continue with GitHub" (NEW)
  Fallback below a divider: existing email form (UNCHANGED)

NEW: Continue with GitHub →
  GET /auth/github/start?d=<user_code>
    Validate ?d=<user_code> if present — fail closed if invalid
    Generate state + PKCE verifier, store in oauth_states
    302 to https://github.com/login/oauth/authorize?...

GitHub consent → Authorise → 302 back:
  GET /auth/github/callback?code=...&state=...
    Validate + atomic-consume state row
    Exchange code at GitHub token endpoint (PKCE verifier round-trips)
    Fetch GitHub /user + /user/emails (user:email scope)
    Pick the email row where primary && verified — fail closed otherwise
    Resolve identity (rules below)
    Create session, attach to device_codes row if user_code was set
    Render WELCOME_HTML

Local server poll picks up the attached session; writes ~/Oyster/config/auth.json.
```

## Why cloud-first (and not local-only OAuth)

A simpler-on-paper alternative — OAuth callback registered to `localhost:4444/auth/github/callback`, session in local SQLite — was considered and rejected. The same `oyster_session` cookie this flow sets later powers (a) the publish/share UI on oyster.to, (b) the public viewer (#316) in sign-in mode, (c) cloud memory store reads in 0.8.0, (d) any future synced-docs surface. Local-only OAuth would force a second sign-in (and a second auth implementation) the moment any cloud-side gate ships. The dual-surface property is the reason auth lives on `oyster.to` at all.

## D1 schema delta

Two new tables, both in `0002_oauth.sql`. Existing tables (`users`, `sessions`, `device_codes`, `magic_link_tokens`) unchanged.

```sql
CREATE TABLE IF NOT EXISTS user_identities (
  provider           TEXT NOT NULL,                  -- 'github' (later: 'google')
  provider_user_id   TEXT NOT NULL,                  -- GitHub's stable numeric id, as text
  user_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider_email     TEXT,                           -- informational; current verified primary email
  linked_at          INTEGER NOT NULL,               -- unix ms
  last_seen_at       INTEGER NOT NULL,               -- unix ms; bumped per sign-in
  PRIMARY KEY (provider, provider_user_id)
);
CREATE INDEX IF NOT EXISTS user_identities_user ON user_identities(user_id);

CREATE TABLE IF NOT EXISTS oauth_states (
  state              TEXT PRIMARY KEY,               -- 32-byte base64url, single-use CSRF token
  provider           TEXT NOT NULL,
  pkce_verifier      TEXT NOT NULL,                  -- 43-char base64url, S256-only
  user_code          TEXT,                           -- nullable; ties this flow to a local-sign-in handoff
  created_at         INTEGER NOT NULL,
  expires_at         INTEGER NOT NULL,               -- 5 min from created_at
  consumed_at        INTEGER                         -- set on /callback; replay defence
);
```

`(provider, provider_user_id)` is the natural key. GitHub's user `id` (numeric) is stable across email and username changes; email is not, which is why STEP 1 of identity resolution reads provider_user_id and never email.

`ON DELETE CASCADE` is enforceable on D1 — Cloudflare's docs confirm foreign-key enforcement is on by default (equivalent to SQLite's `PRAGMA foreign_keys = on`). The escape hatch for migrations that need to bypass FKs is `PRAGMA defer_foreign_keys = on`; not relevant here, this migration is purely additive.

`oauth_states.consumed_at` provides server-side replay defence that a stateless signed cookie couldn't.

## Worker endpoints

### `GET /auth/github/start?d=<user_code>`

1. Per-IP gate via the existing `MAGIC_LINK_LIMIT` binding (shared 20/hour bucket with `/magic-link` and `/device-init` — auth-attempt surface is one budget).
2. **If `?d=` is present, validate before going further.** Look up `device_codes` by `user_code`. Fail closed (the "Sign-in request expired" page) if the row doesn't exist, has expired, has `session_id IS NOT NULL`, or has `claimed_at IS NOT NULL`. Saves a wasted GitHub round-trip when the handoff is already dead. If `?d=` is absent, this validation is skipped — cloud-only sign-in is allowed.
3. Generate `state` (32-byte base64url) and `pkce_verifier` (43-char base64url, S256).
4. Insert `oauth_states` row.
5. 302 to:
   ```
   https://github.com/login/oauth/authorize
     ?client_id=<GITHUB_OAUTH_CLIENT_ID>
     &redirect_uri=https://oyster.to/auth/github/callback
     &scope=user:email
     &state=<state>
     &code_challenge=<base64url(sha256(verifier))>
     &code_challenge_method=S256
     &allow_signup=true
   ```
6. `Cache-Control: no-store`.

### `GET /auth/github/callback?code=...&state=...`

1. **Validate + atomic-consume state.** Single statement, mirroring the existing `handleVerify` pattern:
   ```sql
   UPDATE oauth_states
      SET consumed_at = ?
    WHERE state = ? AND consumed_at IS NULL AND expires_at > ?
    RETURNING provider, pkce_verifier, user_code
   ```
   No row returned (missing / already consumed / expired) → 400 with the "Sign-in request expired" page. Two concurrent callbacks for the same `state` cannot both pass: only one sees the `RETURNING` row.
2. **Exchange code at GitHub token endpoint.** `POST https://github.com/login/oauth/access_token` with `client_id`, `client_secret`, `code`, `redirect_uri`, `code_verifier`. Header `Accept: application/json` so the response is JSON. Non-200 or missing `access_token` → 502 generic error page.
3. **Fetch identity.**
   - `GET https://api.github.com/user` (`Authorization: Bearer <access_token>`, `User-Agent: oyster-auth`) → `{ id, login, ... }`. The numeric `id` is `provider_user_id`.
   - `GET https://api.github.com/user/emails` → array of `{ email, primary, verified, visibility }`. Pick the entry where `primary && verified`. **No match → fail closed** with the verified-email error page (specific copy below). Discard the access token after this — we don't need it again.
4. **Resolve identity** (rules below). Output: a `user_id`.
5. **Create session, attach, render.** Mirrors `handleVerify`:
   - Insert into `sessions`, bump `users.last_seen_at` (batched).
   - If `oauth_states.user_code` was set: atomic `UPDATE device_codes SET session_id = ? WHERE device_code = ? AND session_id IS NULL AND expires_at > now`. If `meta.changes !== 1`, the row TTL'd during the OAuth round-trip — render "Sign-in request expired". (The session row in `sessions` stays valid; the user is signed in for the browser cookie. The error page tells them to retry from the local app.)
   - Set `oyster_session` cookie via the existing `sessionCookie()` helper.
   - Render `WELCOME_HTML(email, deviceLogin)` — same component, no fork. `deviceLogin = oauth_states.user_code !== null`.

All callback responses set `Cache-Control: no-store`. Cookie shape (Domain, Secure, HttpOnly, SameSite=Lax, Max-Age) is identical to magic-link verify — same helper, same cookie name.

### Where this lives

All four handlers + helpers go in `infra/auth-worker/src/worker.ts`. Two new pathname matches in the existing router. Roughly +200 LOC. No new files in the Worker.

### No new bindings, no local-server changes

Two new env entries: `GITHUB_OAUTH_CLIENT_ID` (in `[vars]`) and `GITHUB_OAUTH_CLIENT_SECRET` (via `wrangler secret put`). No new D1 bindings, no new rate-limit bindings. Local Oyster (`server/`, `web/`) is untouched — `AuthService` already speaks only to `/auth/device-init`, `/auth/sign-in?d=...`, and `/auth/device/<code>`, none of which know or care which provider produced the session.

## Identity resolution

Run on every successful `/callback` after token exchange and verified-primary-email pick. Inputs: `provider = 'github'`, `provider_user_id` (GitHub's numeric id, stringified), `provider_email` (the picked verified primary, lowercased).

```
STEP 1 — identity match (provider_user_id is the truth)
  SELECT user_id FROM user_identities
   WHERE provider = 'github' AND provider_user_id = ?

  HIT → user_id is the answer.
        UPDATE user_identities
           SET provider_email = ?, last_seen_at = now
         WHERE provider = 'github' AND provider_user_id = ?;
        try UPDATE users SET email = ?, last_seen_at = now WHERE id = ?
          → UNIQUE violation on email (another users row owns it):
              keep users.email unchanged
              log structured event { kind: 'oauth_email_conflict',
                                     user_id, conflicting_user_id,
                                     attempted_email, kept_email }
              proceed with the sign-in (no automatic merge)
          → success: users.email is now the current verified primary GitHub email,
                    closing the magic-link footgun for this user from now on.
        Skip to STEP 4.

STEP 2 — first-time link, email match (only path that reads provider_email)
  SELECT id FROM users WHERE email = ?     -- COLLATE NOCASE on the column

  HIT → user_id is that row.
        INSERT INTO user_identities
          (provider, provider_user_id, user_id, provider_email, linked_at, last_seen_at)
          VALUES ('github', ?, ?, ?, now, now);
        Skip to STEP 4.

STEP 3 — first-time link, no existing user
  INSERT INTO users (id, email, created_at, last_seen_at) VALUES (newUlid(), ?, now, now);
  INSERT INTO user_identities (...);
  Continue to STEP 4.

STEP 4 — done; return user_id to /callback (which creates the session).
```

### Properties

- **Email change is safe.** A returning user changes their GitHub email; STEP 1 hits on `provider_user_id`, returns the same `user_id`, *and* updates `users.email` to the new one (with the conflict guard). Their existing artefacts/memory stay attached.
- **Existing magic-link users get linked, not duplicated.** A user who signed up by email and later clicks "Continue with GitHub" hits STEP 2: same `users.id` row, new `user_identities` row attached. No data migration, no duplicate account.
- **Unverified email never creates a user.** STEP 3 is only reachable after STEP 2 missed; STEP 2 reads only the email returned under the `primary && verified` rule. If GitHub returned no such email, the callback already failed before resolution started.
- **Multiple GitHub accounts on one Oyster user is allowed when they share the same verified primary email at link time.** STEP 2 attaches the second identity to the existing `users` row; both `(provider, provider_user_id)` rows resolve to the same `user_id`. Same human, two GitHub accounts.

### Concurrency

Two simultaneous first-link sign-ins for the same email are vanishingly unlikely. Schema handles it: `users.email` has `UNIQUE COLLATE NOCASE`, so the second `INSERT INTO users` errors; we catch and re-run STEP 2 (now a hit). `user_identities` similarly has `PRIMARY KEY (provider, provider_user_id)`. INSERT-or-fall-through retry around STEP 3 — three attempts max, same shape as the existing `randomUserCode` collision retry in `handleDeviceInit`. After three retries: 503 with "Sign-in failed. Please try again."

### Known limitation: stale-email window

Between the moment a user changes their GitHub primary email and their next OAuth sign-in, `users.email` is stale. Someone who acquires the old address could sign in via magic-link during that window. Closing this fully would require GitHub email-change webhooks or revalidating on every magic-link send (which would cripple the magic-link path). For 0.7.0 we accept the window. Documented; not blocking.

## Sign-in page

The existing `SIGN_IN_HTML(userCode)` in `worker.ts` grows a button row above the email form.

```
┌──────────────────────────────┐
│  Sign in to Oyster           │
│                              │
│  ┌────────────────────────┐  │   ← primary CTA
│  │  ▶ Continue with GitHub│  │     full-width <a href>, GitHub mark glyph
│  └────────────────────────┘  │
│                              │
│  ── or use email ──          │   ← divider, lower visual weight
│                              │
│  Email                       │
│  ┌────────────────────────┐  │   ← existing email input (UNCHANGED)
│  │                        │  │
│  └────────────────────────┘  │
│  ┌────────────────────────┐  │
│  │  Send magic link       │  │   ← secondary CTA
│  └────────────────────────┘  │
└──────────────────────────────┘
```

- The GitHub button is an `<a href>`, not a JS submit. `href` is `/auth/github/start?d=${encodeURIComponent(userCode)}` when `userCode` is present, `/auth/github/start` otherwise. Server-rendered, works without JS.
- Magic-link form below is structurally unchanged (same `<form>`, same JS handler, same `POST /auth/magic-link` body). Visible by default — fallback is not a hidden affordance.
- Inline GitHub mark SVG (one `<svg>` literal in the HTML string). No external assets, matches the existing self-contained-template style.

`WELCOME_HTML(email, deviceLogin)` and `SIGN_IN_ERROR_HTML(message)` don't need structural changes.

### New error pages (both reuse `SIGN_IN_ERROR_HTML`'s shape — same template, different copy)

**Sign-in request expired** — for an invalid/expired/already-attached/already-claimed local handoff at `/start`, or an attach UPDATE that affected 0 rows at `/callback`:

> Return to the Oyster app and start sign-in again.
>
> *(button)* Close this window

If the failing flow had no `user_code` (cloud-only sign-in), the page links back to `/auth/sign-in` instead of saying "return to Oyster". The branch is decided at render time from the same state-row lookup that produced the failure.

**No verified primary email** — for the GitHub `/user/emails` no-match case:

> GitHub didn't return a verified primary email. Add and verify a primary email at github.com/settings/emails, or sign in with the email link below.

This is the only failure path that names GitHub to the user — because the user has to take a provider-specific action to recover. Every other failure uses generic copy.

## Failure modes

| Stage | Trigger | Status | User sees |
|---|---|---|---|
| `/start` | `?d=` resolves to non-existent / expired / already-attached / already-claimed `device_codes` row | 400 | Sign-in request expired page |
| `/start` | per-IP rate limit exceeded | 429 | "Too many sign-in attempts. Try again shortly." |
| `/callback` | `state` missing, unknown, expired, or already consumed | 400 | Sign-in request expired page |
| `/callback` | GitHub `access_token` exchange returns non-200 or no `access_token` | 502 | "Sign-in failed. Please try again." |
| `/callback` | `/user` or `/user/emails` returns non-200 | 502 | "Sign-in failed. Please try again." |
| `/callback` | no entry in `/user/emails` with `primary && verified` | 400 | No verified primary email page (only path that names GitHub) |
| `/callback` | `oauth_states.user_code` was set but the device_codes attach UPDATE affected 0 rows (TTL ran out during OAuth round-trip) | 400 | Sign-in request expired page |
| `/callback` | new `users` insert collides on `email` UNIQUE (concurrency) | retry STEP 2 up to 3 times, then 503 | "Sign-in failed. Please try again." |
| Worker boundary | unhandled exception | 503 (existing single-point catch) | `service_unavailable` (JSON for clients, generic page for browsers) |

User-facing copy is generic for everything except the verified-email case. No leaking of GitHub internals, response bodies, or provider names beyond the one path where the user can act on it.

The structured `oauth_email_conflict` log event from STEP 1 is **not** a user-facing failure — sign-in succeeds, the event is server-side telemetry only.

## Setup work (one-time, external)

1. github.com/settings/developers → New OAuth App.
2. Application name: `Oyster`.
3. Homepage URL: `https://oyster.to`.
4. Authorization callback URL: `https://oyster.to/auth/github/callback`.
5. Generate a new client secret. Keep the client ID and secret accessible.

That's all. No org installation, no GitHub App (different mechanism — we want OAuth App, not GitHub App).

## Worker config

```toml
# infra/auth-worker/wrangler.toml — additions
[vars]
# ...existing FROM_ADDRESS, REPLY_TO...
GITHUB_OAUTH_CLIENT_ID = "Iv1.xxxxxxxxxxxxxxxx"
```

```sh
wrangler secret put GITHUB_OAUTH_CLIENT_SECRET
```

## Dev story (deliberate trade-off)

**No local live OAuth testing for 0.7.0.** Local development uses mocked GitHub responses (`/user`, `/user/emails`) at the test boundary; the real OAuth round-trip is verified after deploying the Worker.

GitHub OAuth Apps register exactly one callback URL, with subdirectory matching only — host and port must exactly match. `localhost:8787` is not a subdirectory of `oyster.to`, so live local testing would require a second OAuth App. We accept a slower feedback loop in exchange for not maintaining a second app's secrets and not deviating from prod config. Magic-link's existing `if (!env.RESEND_API_KEY) console.log(verifyURL)` dev fallback continues to cover local sign-in development.

If we later need live local OAuth, registering a second OAuth App is a 10-minute change.

## PR sequencing

Three PRs, each independently reviewable and deployable.

1. **Schema + scaffolding.** `0002_oauth.sql` (`oauth_states` + `user_identities`). Helper functions (`pkceVerifier()`, `pickPrimaryVerifiedEmail()`, `resolveIdentity()`). Unit tests against mocked GitHub responses. `/auth/github/start` returns a 503 stub. Mergeable in isolation; verifies the resolution rule against fixtures with zero blast radius.
2. **`/auth/github/start` + `/auth/github/callback` end-to-end.** Both endpoints fully wired, `oauth_states` integration, device-code attach, `WELCOME_HTML` reuse. Sign-in page still email-only — endpoints reachable by direct URL but unsurfaced. After deploy, the maintainer **smoke-tests both paths**:
   - **Cloud-only sign-in:** visit `https://oyster.to/auth/github/start` directly in a browser.
   - **Local handoff:** start sign-in from local Oyster (so `?d=<user_code>` is present) and confirm the local app picks up the session via the existing poll loop.
3. **Sign-in page + `auth.md` doc update.** GitHub button promoted to primary, magic-link demoted to fallback below the divider. `docs/plans/auth.md` updated to drop "OAuth deferred" framing, add a "Providers" section pointing here, and revise wording about which path is primary.

The order is chosen so PR 1 verifies the resolution rule with zero blast radius, PR 2 ships the live OAuth code path *invisibly* (URL-only access for smoke testing), and PR 3 is a UI flip. If any PR exposes a problem, the previous PR(s) are still safely merged — there's no point at which the system is in a half-broken state.

## What this does NOT include

- **Google.** Deferred until GitHub lands cleanly. Same Worker, same schema, same resolution rule — adds `/auth/google/start` and `/auth/google/callback`. New issue at that time.
- **Account-management UI.** No "linked accounts" page, no unlink button, no profile/avatar/display-name surface.
- **Multi-identity merge tooling.** The `oauth_email_conflict` event is logged; resolution is a manual D1 query if it ever fires.
- **GitHub email-change webhooks.** The known stale-email window above stays known.
- **Org/SAML SSO.** GitHub orgs that enforce SAML still let OAuth Apps sign individual users in by their personal email; we get whatever that personal account exposes. Enterprise SSO isn't on the near roadmap.
- **MFA, passwords, password reset.** Not relevant — same as `auth.md`.

## Followups (file as issues after #340 ships)

- **Magic-link silent-degrade fix.** Pre-existing UX bug: `handleMagicLink` resolves `user_code` at send-time and proceeds with `deviceCode = null` if it's bad. Same browser-says-success / local-keeps-polling split-brain that the `/start` validation fixes for OAuth. Bring magic-link in line with the same fail-closed rule.
- **Local-server token rotation on cloud 401.** Carried forward from `auth.md`'s open questions. Settle when the first cloud-touching feature lands (publish, #315).
- **`oauth_email_conflict` observability.** Currently a structured log event; if it ever fires in real traffic, surface it via Workers Logs filter or a small admin endpoint.

## How to update this doc

Replace, don't append, when a decision changes. If we ever fork providers (different Worker, different schema), that's a fork in this doc — and a check against R1–R7 to make sure the requirements still hold under the new shape.
