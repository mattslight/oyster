# Viewer access redirect — design

**Status:** Draft for review · 2026-05-18 · branch `feat/viewer-access-redirect`

## Goal

Let an authorised visitor reach a protected share without retyping the password — specifically:

1. The **owner** of a password-protected share can view their own publication while signed in to Oyster, with no password prompt.
2. Any visitor sitting at the password gate can choose **"Have access? Sign in to view"** as an alternative to typing the password. After sign-in, if they have access (today: ownership; tomorrow: an ACL membership), they get in.
3. The mechanism is general enough to also fix `signin` mode, which is currently broken in production for the cross-host case (see below).

Future scope — sharing to specific other Oyster users by id — is out of scope for v1. The mechanism we build here is the slot where that ACL widens.

## Current state

### Publish modes (already in place)

`published_artifacts.mode` is one of:

- `open` — public link, no gate.
- `password` — visitor types a password; PBKDF2-verified by the viewer worker; on success, a 24h HMAC cookie `oyster_view_<token>` is set scoped to `/p/<token>`.
- `signin` — visitor must have a valid `oyster_session` cookie at request time.

### Cookie scoping — the load-bearing constraint

`infra/auth-worker/src/worker.ts:138-141` sets `oyster_session` as **host-only on `oyster.to`** (production) — no `Domain=` attribute. This is intentional (#397): untrusted published content runs on `share.oyster.to`, so the apex session cookie must not leak across the host boundary.

`infra/oyster-publish/wrangler.toml` routes `oyster.to/p/*`, `www.oyster.to/p/*`, and `share.oyster.to/p/*` all to the same `oyster-publish` worker. The worker's top-of-handler 308 redirect (`worker.ts:60-74`) sends every `oyster.to/p/*` and `www.oyster.to/p/*` request to `share.oyster.to/p/*` so the cookie boundary is enforced for viewer traffic.

### What the constraint breaks today

The signin-mode dispatch in `viewer-access.ts:44-50` calls `resolveSession(req, env)` on `share.oyster.to`. Because the apex session cookie does not cross the host boundary, `resolveSession` returns null and the dispatch 302s the visitor to `oyster.to/auth/sign-in?return=/p/<token>`. After sign-in the visitor lands on `oyster.to/p/<token>`, which the worker 308s to `share.oyster.to/p/<token>` — where the cookie is again invisible. The loop is unbroken.

The test at `viewer-handler.test.ts:393-405` ("signed-in visitor → content") only passes because the vitest-pool-workers harness forges the cookie directly onto the `share.oyster.to` request, bypassing the real cookie boundary. **In production, signin mode is non-functional.**

There is no existing handoff mechanism that bridges `oyster.to`'s session to `share.oyster.to`'s viewer. This design is that mechanism.

## Non-goals

- Ambient client-side ownership detection (CORS fetch from gate page back to `oyster.to`). Adds CORS attack surface and exposes a session-bound endpoint to a sibling subdomain. Manual "Sign in" click is fine.
- Persistent owner cookie on `share.oyster.to`. Same security boundary; not worth a second auth concept on the publish-content host.
- Replacing the password gate. Visitors who don't have an Oyster account or who want to share with non-Oyster recipients still use the password flow.
- ACL widening (share-to-specific-user). Scoped here only as a foreseen extension point.

## Design

### Architecture overview

```
┌─────────────────────────────────────────────────────────────────┐
│ Visitor's browser                                               │
└─┬───────────────────────────────────────────────────────────────┘
  │ 1. GET share.oyster.to/p/<token>             (no session cookie here)
  ▼
┌─────────────────────────────────────────────────────────────────┐
│ oyster-publish worker (share.oyster.to)                         │
│   resolveViewerAccess → mode=password, no cookie → { gate }     │
└─┬───────────────────────────────────────────────────────────────┘
  │ 2. render password-gate page with "Sign in to view" link
  ▼
  ┌─ Visitor clicks "Sign in to view" ─┐
  │ link target:                       │
  │ oyster.to/api/publish/access-redirect/<token>
  ▼
┌─────────────────────────────────────────────────────────────────┐
│ oyster-publish worker (oyster.to)            (session visible)  │
│   - no session  → 302 to sign-in (return=this URL)              │
│   - session, mode=signin             → mint nonce               │
│   - session, mode=password + owner   → mint nonce               │
│   - session, mode=password, non-owner → 403 page                │
│   - session, mode=open               → 302 to viewer (no nonce) │
└─┬───────────────────────────────────────────────────────────────┘
  │ 3. 302 → share.oyster.to/p/<token>?key=<nonce>
  ▼
┌─────────────────────────────────────────────────────────────────┐
│ oyster-publish worker (share.oyster.to)                         │
│   resolveViewerAccess pre-check:                                │
│     consumeNonce(nonce, share_token)                            │
│   - hit  → { kind: ok_via_nonce }                               │
│   - miss → fall through to mode dispatch (gate / signin etc.)   │
└─┬───────────────────────────────────────────────────────────────┘
  │ 4. handleViewerGet sets oyster_view_<token> cookie (24h)
  │    302 → share.oyster.to/p/<token>     (key stripped)
  │    headers: cache-control: private, no-store; referrer-policy: no-referrer
  ▼
  Browser follows → next GET has cookie → ok → content rendered
```

### Data model

New table in `infra/auth-worker/migrations/` (same database the publish worker already binds to):

```sql
CREATE TABLE viewer_access_nonces (
  nonce        TEXT PRIMARY KEY,        -- 22-char base64url (128 bits of entropy)
  share_token  TEXT NOT NULL,
  user_id      TEXT NOT NULL,           -- for audit; never surfaced in any response
  expires_at   INTEGER NOT NULL,        -- unix ms
  consumed_at  INTEGER,                 -- null until single use
  created_at   INTEGER NOT NULL
);
CREATE INDEX idx_viewer_access_nonces_expires ON viewer_access_nonces(expires_at);
```

No FK on `share_token` because the source-of-truth row may be the live `published_artifacts` row or, post-retirement, gone — the nonce should fail consumption either way and the table holds its own invariants.

### Nonce module — `infra/oyster-publish/src/access-nonce.ts`

```ts
const TTL_MS = 60_000;

export async function mintAccessNonce(
  env: Env,
  shareToken: string,
  userId: string,
): Promise<string> {
  const nonce = base64urlRandom(16);           // 16 bytes → 22 chars
  const now = Date.now();
  // Opportunistic cleanup of expired rows. The table is small (60s TTL,
  // capped by mint rate), so an unindexed sweep on each mint is fine; the
  // expires_at index makes it a range scan.
  await env.DB.prepare(
    "DELETE FROM viewer_access_nonces WHERE expires_at < ?"
  ).bind(now).run();
  await env.DB.prepare(
    `INSERT INTO viewer_access_nonces
       (nonce, share_token, user_id, expires_at, consumed_at, created_at)
     VALUES (?, ?, ?, ?, NULL, ?)`
  ).bind(nonce, shareToken, userId, now + TTL_MS, now).run();
  return nonce;
}

/** Returns true iff this call atomically transitioned the nonce
 *  for THIS share_token from unconsumed-and-live to consumed.
 *  Wrong share_token, wrong nonce, expired, or already-consumed
 *  all return false without any side effect. */
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
        AND expires_at  > ?`
  ).bind(now, nonce, shareToken, now).run();
  return (res.meta?.changes ?? 0) === 1;
}
```

**Critical:** `share_token` is in the `WHERE` clause, not a post-hoc assertion. A nonce minted for share A presented against share B's URL does not consume the row — it just returns false, leaving the legitimate share-A consumption intact.

### Endpoint — `GET oyster.to/api/publish/access-redirect/:token`

In `infra/oyster-publish/src/worker.ts`, new top-level route. Pseudocode:

```ts
async function handleAccessRedirect(req: Request, env: Env, shareToken: string) {
  const row = await env.DB.prepare(
    "SELECT mode, owner_user_id, unpublished_at FROM published_artifacts WHERE share_token = ?"
  ).bind(shareToken).first<PubRow>();

  if (!row) return htmlPage(404, notFoundPage());
  if (row.unpublished_at !== null) return htmlPage(410, gonePage());

  // Open mode: nothing to gate; send the visitor straight to the viewer.
  if (row.mode === "open") {
    return redirectNoStore(`https://share.oyster.to/p/${shareToken}`);
  }

  const session = await resolveSession(req, env);
  if (!session) {
    // Cookie is host-only on oyster.to, so this is the only host where the
    // session is visible. Round-trip through sign-in and return to this URL.
    return redirectNoStore(
      `https://oyster.to/auth/sign-in?return=${encodeURIComponent(`/api/publish/access-redirect/${shareToken}`)}`
    );
  }

  // Access predicates — extend the password case for ACLs.
  // resolveSession() in this worker returns a flat { id, email, tier }
  // (see infra/oyster-publish/src/worker.ts:resolveSession).
  let mayAccess = false;
  if (row.mode === "signin")   mayAccess = true;
  if (row.mode === "password") mayAccess = session.id === row.owner_user_id;

  if (!mayAccess) return htmlPage(403, noAccessPage(shareToken));

  const nonce = await mintAccessNonce(env, shareToken, session.id);
  return redirectNoStore(`https://share.oyster.to/p/${shareToken}?key=${nonce}`);
}
```

The `redirectNoStore` helper sets `cache-control: private, no-store`. (The `?key=…` URL must never be cached.)

### Return-path allowlist

`infra/auth-worker/src/return-path.ts:8` currently accepts only `^/p/<token>$`. Extend the validator to also accept the access-redirect path:

```ts
const SHARE_VIEWER_PATH      = /^\/p\/[A-Za-z0-9_-]+$/;
const ACCESS_REDIRECT_PATH   = /^\/api\/publish\/access-redirect\/[A-Za-z0-9_-]+$/;

export function validateReturnPath(raw): string | null {
  // ...existing length/control-char checks...
  if (SHARE_VIEWER_PATH.test(raw) || ACCESS_REDIRECT_PATH.test(raw)) return raw;
  return null;
}
```

Without this change, the auth worker silently drops the `?return=` parameter and the user lands somewhere generic after sign-in.

### Viewer pre-check — `infra/oyster-publish/src/viewer-access.ts`

Two changes:

1. Add a `?key=` pre-check before the mode switch, gated by an **explicit `consumeNonce` flag** on the resolver API so that `/raw` can never accidentally consume a nonce.
2. Make the `signin` case accept the `oyster_view_<token>` cookie as a valid access proof, alongside the apex session check. Without this, the clean redirect after nonce consumption loops back to `signin → resolveSession → null` and bounces the visitor to sign-in again.

```ts
export type ViewerAccess =
  | { kind: "ok"; row: PublicationRow }
  | { kind: "ok_via_nonce"; row: PublicationRow }   // NEW
  | { kind: "gate"; row: PublicationRow; error?: "wrong_password" }
  | { kind: "redirect"; location: string }
  | { kind: "gone"; row: PublicationRow }
  | { kind: "not_found" };

export interface ResolveOptions {
  /**
   * When true, a valid `?key=<nonce>` consumes the nonce and yields
   * `ok_via_nonce`. When false, the `?key=` parameter is ignored
   * (the caller is responsible for any cookie-based check).
   * Only `/p/<token>` passes true; `/raw` MUST pass false.
   */
  consumeNonce: boolean;
}

export async function resolveViewerAccess(
  req: Request,
  env: Env,
  shareToken: string,
  opts: ResolveOptions,
): Promise<ViewerAccess> {
  const row = await fetchRow(...);
  if (!row) return { kind: "not_found" };
  if (row.unpublished_at != null) return { kind: "gone", row };

  // Nonce pre-check: only when the caller has opted in. Applies to
  // password + signin modes; open mode never needs one. Invalid /
  // expired / wrong-share nonces fall through silently — no oracle
  // on whether a presented nonce was real.
  if (opts.consumeNonce) {
    const key = new URL(req.url).searchParams.get("key");
    if (key && (row.mode === "password" || row.mode === "signin")) {
      if (await consumeAccessNonce(env, key, shareToken)) {
        return { kind: "ok_via_nonce", row };
      }
    }
  }

  switch (row.mode) {
    case "open":
      return { kind: "ok", row };

    case "password": {
      // Existing path — cookie verifies the recent-access proof.
      if (await checkViewerCookie(req, shareToken, env.VIEWER_COOKIE_SECRET)) {
        return { kind: "ok", row };
      }
      return { kind: "gate", row };
    }

    case "signin": {
      // CHANGED: the viewer cookie is a recent-access proof for the
      // artefact regardless of which gate-clearing path minted it
      // (password POST, owner-via-nonce, signin-via-nonce). Honour it
      // first; only fall back to apex session if no cookie. Without
      // this, the post-consumption clean redirect loops back through
      // signin → resolveSession → null on share.oyster.to.
      if (await checkViewerCookie(req, shareToken, env.VIEWER_COOKIE_SECRET)) {
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
  }
}

// `checkViewerCookie` is the existing read-cookie + verifyViewerCookie
// pair extracted into a single helper for reuse across modes.
```

Note the signin redirect target is now the new access-redirect endpoint, not `/auth/sign-in` directly — the redirect path handles the unauth case, mints a nonce post-sign-in, and produces a working cross-host handoff. There is no parallel direct-to-sign-in path; all signin-mode viewer misses route through `/api/publish/access-redirect/<token>`.

### Viewer-side handling of `ok_via_nonce`

In `handleViewerGet`:

```ts
case "ok_via_nonce": {
  const cookieValue = await signViewerCookie(shareToken, env.VIEWER_COOKIE_SECRET);
  const host = new URL(req.url).host;
  const secureFlag = isLoopback(host) ? "" : " Secure;";
  return new Response(null, {
    status: 302,
    headers: {
      "set-cookie": `oyster_view_${shareToken}=${cookieValue}; HttpOnly;${secureFlag} SameSite=Lax; Path=/p/${shareToken}; Max-Age=86400`,
      "location": `/p/${shareToken}`,
      "cache-control": "private, no-store",
      "referrer-policy": "no-referrer",
    },
  });
}
```

### `/raw` MUST NOT consume nonces

`handleViewerRaw` calls `resolveViewerAccess(req, env, token, { consumeNonce: false })`. Because the flag is required on the resolver API, any future change to `/raw` cannot accidentally start consuming nonces without a deliberate edit to the call site.

Rationale: `/raw` is loaded as the inner iframe of `/p/<token>`. By the time the iframe loads, the outer page has already consumed the nonce, set `oyster_view_<token>`, and stripped the key from the URL. The iframe carries the cookie and uses the standard mode dispatch. The consume-then-redirect flow is also semantically wrong for `/raw` — the iframe body must be the response body, not a 302.

If a `?key=` ever does appear on a `/raw` URL (defensively constructed, mis-pasted, or a future code change misroutes a nonce), it is simply ignored — the nonce stays unconsumed and remains usable at the proper `/p/<token>?key=…` URL.

### Cookie semantics — generalised

`oyster_view_<token>` is **a recent-access proof for the artefact**, not specifically "password entered". The HMAC + TTL scheme in `viewer-cookie.ts` already encodes nothing more than "this visitor cleared an access check for `<token>` at time T, signed by the worker secret"; today it is minted only by the password POST handler, but the design treats it as the canonical access-proof for any successful gate-clearing path:

| Gate-clearing path | Mints `oyster_view_<token>` |
|---|---|
| Password POST + correct password (existing) | yes (existing) |
| Owner via nonce — `ok_via_nonce` | yes (new) |
| Signin-mode visitor via nonce — `ok_via_nonce` | yes (new) |
| Open mode | no — no gate to clear |

Spec / comment changes in `viewer-cookie.ts` describe the cookie generically. The cookie name stays `oyster_view_<token>`; no schema change.

### Gate-page copy

`passwordGatePage(shareToken)` in `viewer-pages.ts` adds a single new affordance below the password form. It renders in both the empty-form and wrong-password states (the wrong-password error block sits above the form, so the link below is visible in both):

```html
<p class="hint-link">
  Have access? <a href="https://oyster.to/api/publish/access-redirect/<token>">Sign in to view</a>
</p>
```

`<token>` is HTML-escaped via the existing `escapeHtml` helper.

The "Have access?" phrasing rather than "Own this share?" anticipates the ACL widening — the same line is correct today (where "access" = ownership) and after the ACL ships (where "access" = ownership OR ACL membership).

## Security considerations

| Concern | Mitigation |
|---|---|
| Nonce replay within TTL | Single-use enforced by atomic `UPDATE ... WHERE consumed_at IS NULL`. Second click on the same URL falls through silently to the gate. |
| Nonce cross-share misuse | `share_token` is in the consume `WHERE` clause. A nonce minted for share A presented at share B does not consume and returns false. |
| Nonce in URL → visible address / shareable links | The consumption 302 immediately redirects the browser to the cleaned `/p/<token>` URL, so the final visible URL in the address bar carries no key. Precise browser-history retention of intermediate redirect targets is user-agent-specific and not relied on; the security claim is "the user does not see, share, or screenshot the key-bearing URL", not "the key URL is absent from history". |
| Nonce in Referer to subresources | `referrer-policy: no-referrer` on the consumption 302 strips Referer for the destination's initial GET and its subresource fetches. Additionally, the **final rendered viewer responses** (`renderMarkdownPage` / `renderMermaidPage` / `renderChromeWithIframe` / `renderRawHtmlBody` / `renderImageInline`) also emit `referrer-policy: no-referrer` — added in the shared `cacheHeaders()` helper. Defence in depth so any future URL-shaped sensitive parameter (or a paste-edited share URL) cannot leak via subresource or onward-navigation Referer from the rendered page itself. |
| Nonce in application logs | `mintAccessNonce` and `consumeAccessNonce` log only counts/booleans, never the nonce value. The endpoint logs the share token, not the query string. **Platform-level request logs (Cloudflare Logpush / `wrangler tail` / Workers Analytics Engine) are out of band of application code and must be reviewed separately** — if any of these capture the full request URL by default, the query string will include the nonce. Action item before implementation: audit the production log sinks for query-string capture and either disable or scrub `?key=` on the access-redirect destination paths. |
| Nonce theft from server | A leaked nonce is single-use, 60s lifetime, and bound to one `share_token`. The blast radius is "view this one artefact once within a minute"; the cookie minted on consumption is bound to that same artefact too. |
| Ownership change after mint | `consumeAccessNonce` does not re-check ownership; the row stores `user_id` for audit only. Ownership transfers in Oyster are not a current feature; the predicate runs at mint time. |
| Cross-site request forgery against `/api/publish/access-redirect/...` | The endpoint is `GET` with no side effects beyond a D1 insert that only matters if the visitor follows the resulting 302. The session is `SameSite=Lax`, so a cross-site `GET` does carry the session — but the consequence is a wasted nonce, not an authenticated action against the artefact. |
| Open redirect via `?return=` | Existing `validateReturnPath` allowlist; extended to include the access-redirect path only. |
| Untrusted content on `share.oyster.to` reading the session | Unchanged — the apex cookie still does not leak across hosts. The nonce in the URL is the *only* data passed across, and it conveys nothing the apex hasn't already authorised. |

## Test plan

### Nonce module — `infra/oyster-publish/test/access-nonce.test.ts`

- Mint then consume → `true`; row's `consumed_at` is set.
- Consume the same nonce twice → first `true`, second `false`.
- Consume with wrong `share_token` → `false`; row remains unconsumed. **Then** consume with the correct `share_token` → still succeeds. This is the regression that catches the "consume first, assert later" bug pattern.
- Consume an expired nonce → `false`.
- Consume a never-minted nonce → `false`.
- Mint also opportunistically deletes expired rows.

### Access-redirect handler — `infra/oyster-publish/test/access-redirect-handler.test.ts`

Cover the full matrix:

| Setup | Expected |
|---|---|
| token not found | 404 page |
| publication retired | 410 gone page |
| mode=open | 302 → `share.oyster.to/p/<token>` (no key) |
| mode=signin, no session | 302 → `/auth/sign-in?return=/api/publish/access-redirect/<token>` |
| mode=signin, session | 302 → `…?key=<22 chars>` and a row exists in `viewer_access_nonces` |
| mode=password, no session | 302 → `/auth/sign-in?return=/api/publish/access-redirect/<token>` |
| mode=password, session = owner | 302 → `…?key=…` |
| mode=password, session ≠ owner | 403 page |
| All 302s | include `cache-control: private, no-store` |

### Viewer integration — `infra/oyster-publish/test/viewer-handler.test.ts` additions

- Owner-bypass golden path (password mode): mint nonce for `(token, owner)`, GET `/p/<token>?key=<nonce>`, expect 302 to `/p/<token>` with `set-cookie: oyster_view_<token>=...`, `referrer-policy: no-referrer`. Then GET `/p/<token>` with that cookie → 200 content, and the 200 response **also carries `referrer-policy: no-referrer`** (asserts the `cacheHeaders()` change).
- **Signin-mode end-to-end (regression for the cookie-honouring fix):** mint nonce for `(token, signed-in user)`, GET `/p/<token>?key=<nonce>`, follow the 302, then GET `/p/<token>` with only the `oyster_view_<token>` cookie set and **no `oyster_session` cookie at all** (modelling the cross-host browser reality) — expect 200 content. Without the signin-mode cookie acceptance change this final GET would 302 back to access-redirect / sign-in, looping.
- Replay: a second GET `/p/<token>?key=<nonce>` (after consumption) falls through to the password gate (or signin redirect) — i.e., behaviour identical to no-key.
- Wrong-share nonce on `/p/<other_token>?key=<nonce>` falls through; the nonce remains consumable on its real token afterwards. (Regression for the atomic-WHERE fix.)
- **`/raw` MUST NOT consume nonces:** GET `/raw?key=<valid_nonce>` returns the existing no-cookie behaviour for an iframe-kind share (gate redirect or 404 per current logic). Critically, after the call, `SELECT consumed_at FROM viewer_access_nonces WHERE nonce = ?` is still `NULL`, and a subsequent GET `/p/<token>?key=<nonce>` succeeds. This is the regression for the explicit `consumeNonce` flag — a future code change that drops the flag on the `/raw` resolver call will fail this test.

### Cookie-scoping regression — `infra/oyster-publish/test/signin-mode-cookie-boundary.test.ts` (new)

Models real browser cookie scoping by **not** passing `oyster_session` on requests to `share.oyster.to`, and confirms the production loop that the in-process test harness has been hiding:

```ts
it("signin mode without access-redirect is a closed loop across the host boundary", async () => {
  // 1. Visitor with apex session lands on share.oyster.to/p/<token>.
  //    Real browser would NOT send the host-only oyster.to cookie here.
  const res1 = await call(getReq(`https://share.oyster.to/p/${token}`));  // no cookie
  expect(res1.status).toBe(302);
  const loc = new URL(res1.headers.get("location")!);
  expect(loc.origin + loc.pathname).toBe("https://oyster.to/auth/sign-in");
  expect(loc.searchParams.get("return")).toBe(`/p/${token}`);

  // 2. Simulate post-sign-in: visitor lands on oyster.to/p/<token>.
  //    The apex session IS visible here, but the publish worker 308s
  //    every oyster.to/p/* to share.oyster.to/p/* unconditionally.
  const res2 = await call(getReq(`https://oyster.to/p/${token}`,
    { cookie: `oyster_session=${u.sessionToken}` }));
  expect(res2.status).toBe(308);
  expect(res2.headers.get("location"))
    .toBe(`https://share.oyster.to/p/${token}`);

  // 3. Browser follows to share.oyster.to — cookie is dropped at the
  //    host boundary again. Same as step 1. The loop is unbroken.
  const res3 = await call(getReq(`https://share.oyster.to/p/${token}`));
  expect(res3.status).toBe(302);  // back to /auth/sign-in
});

it("signin mode is reachable via /api/publish/access-redirect/<token>", async () => {
  // The apex session IS visible on oyster.to/api/publish/... because the
  // cookie is host-scoped to oyster.to.
  const res1 = await call(getReq(
    `https://oyster.to/api/publish/access-redirect/${token}`,
    { cookie: `oyster_session=${u.sessionToken}` }));
  expect(res1.status).toBe(302);
  const loc = new URL(res1.headers.get("location")!);
  expect(loc.origin + loc.pathname).toBe(`https://share.oyster.to/p/${token}`);
  const nonce = loc.searchParams.get("key");
  expect(nonce).toMatch(/^[A-Za-z0-9_-]{22}$/);

  // share.oyster.to/p/<token>?key=<nonce> succeeds even with no cookie.
  const res2 = await call(getReq(loc.toString()));  // no cookie
  expect(res2.status).toBe(302);
  expect(res2.headers.get("location")).toBe(`/p/${token}`);
  expect(res2.headers.get("set-cookie")).toContain(`oyster_view_${token}=`);
  expect(res2.headers.get("referrer-policy")).toBe("no-referrer");
});
```

The first test will pass today (and continues to pass after the change — the access-redirect endpoint is opt-in via the gate page link). The second test fails today and passes after the change.

### Return-path allowlist — `infra/auth-worker/test/return-path.test.ts`

- `/api/publish/access-redirect/<token>` → accepted.
- `/api/publish/access-redirect/<token>/extra` → rejected.
- `/api/publish/access-redirect/<token>?evil=…` → rejected (no query allowed by current regex anchoring).

### Seed fixture

`infra/oyster-publish/test/fixtures/seed.ts` adds `viewer_access_nonces` to the in-memory schema so the new tests can mint/consume in isolation.

## Migration / rollout

- Migration file: `infra/auth-worker/migrations/0011_viewer_access_nonces.sql` (next ordinal after `0010_device_label.sql`). Pure additive; no down-migration needed.
- Worker deploys: both workers (well, the one `oyster-publish` worker that handles both hosts) ship together. No staged rollout needed because the endpoint and the pre-check are independent — old browsers without the gate-page link continue to use password POST normally; new gate pages can use either path.
- No local-server changes; no surface UI changes; no MCP changes.
- CHANGELOG.md under `Added`: one user-visible bullet, e.g. **"Sign in to view your own password-protected shares"**. No mention of nonces, workers, or D1.

## Out of scope (foreseen extensions)

- **ACL widening.** When sharing-to-specific-user lands, the predicate in `handleAccessRedirect`'s password branch becomes `session.user.id === row.owner_user_id || isInShareAcl(env, shareToken, session.user.id)`. Everything else (nonce machinery, viewer pre-check, gate-page link) is unchanged.
- **Auto-bypass for ambient ownership.** A future polish could have the gate-page JS prefetch the access-redirect with `Sec-Fetch-Site` discrimination so that signed-in owners never see the gate. Deferred — explicit click is acceptable for v1 and avoids the CORS/security trade-off.
- **Sharing across devices when offline.** The local Oyster server already shows the user their own artefact bytes; the cloud share URL is independent.
