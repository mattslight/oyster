# R5 Public Viewer — Design Spec

**Date:** 2026-05-03
**Status:** Approved for implementation
**Scope:** Public viewer at `GET /p/:share_token` in the `oyster-publish` Worker, plus a generic `?return=<path>` flow added to `auth-worker` so `signin` mode can redirect cleanly. Replaces the `501 Not Implemented` stub left by #315. UI for publishing lands in #317.

**Tracks:** Issue #316. Part of R5 in [`docs/requirements/oyster-cloud.md`](../../requirements/oyster-cloud.md). Builds on [`2026-05-03-r5-publish-backend-design.md`](./2026-05-03-r5-publish-backend-design.md).

---

## Problem

#315 shipped the publish backend: an agent or the local server can call `publish_artifact`, bytes land in R2, a row lands in `published_artifacts`, and a `share_url` like `https://oyster.to/p/<token>` is returned. Visiting that URL in a browser today returns:

```json
{ "error": "not_implemented", "handler": "publish_viewer" }
```

R5 is not a feature until that URL serves bytes. The viewer must:

- Resolve `share_token` → the publication row.
- Enforce the three access modes: `open`, `password`, `signin`.
- Render the artefact correctly per `artifact_kind` (markdown, mermaid, single-file HTML, image).
- Treat retired tokens (`unpublished_at IS NOT NULL`) as `410 Gone`.
- Be safe to host arbitrary user-supplied HTML on `oyster.to` without exposing signed-in users.

The `signin` mode also requires a generic post-sign-in redirect mechanism that `auth-worker` doesn't yet have.

---

## Goals

- A user clicking a published URL sees the rendered artefact under each access mode (open immediately; password after unlock; sign-in after authenticating).
- A user clicking a retired URL sees a clean "this share has been removed" page.
- A signed-in publisher sharing a `mode=signin` URL sees content; an unsigned visitor is sent through sign-in and lands back on the artefact.
- User-controlled HTML in published artefacts cannot read the `oyster_session` cookie or call our APIs (origin-isolated by sandbox iframe).
- Single coherent PR. Cloud-surface delta is small but non-zero: one new Worker secret (`VIEWER_COOKIE_SECRET` on `oyster-publish`), one new rate-limiter binding (`VIEWER_PASSWORD_LIMIT` on `oyster-publish`), two additive nullable columns on the auth-worker D1 (`magic_link_tokens.return_path`, `oauth_states.return_path`). All listed in *Operational changes* below.

## Out of Scope

- Publish UI in the artefact panel (#317).
- Multi-file bundles (#242–#248). Single-file artefacts only.
- Image-as-`artifact_kind`. Images render correctly via content-type dispatch but no `image` kind is added.
- Bandwidth metering / view counts.
- Token rotation as a discrete operation (still unpublish-then-republish).
- Pro-tier behaviours (no-watermark, custom domains, etc.).
- Server-rendered mermaid (uses CDN client-side).
- Syntax highlighting for code blocks in markdown.
- Cross-Worker session sync beyond what already exists (shared D1 binding to `sessions`).

---

## Topology

```
Visitor browser
     │
     ▼
oyster.to/p/<token>          ─── (Cloudflare zone routes to oyster-publish Worker)
     │
     ▼
oyster-publish Worker (infra/oyster-publish/src/)
     │
     ├─→ D1 (oyster-auth, shared binding)
     │     - SELECT published_artifacts WHERE share_token = ?
     │     - SELECT sessions JOIN users  (signin mode auth check)
     │
     ├─→ R2 (oyster-artifacts)
     │     - GET published/<owner>/<token>  (after auth passes)
     │
     └─→ Render dispatch by content_type then artifact_kind
           - image/*       → bytes inline
           - notes (md)    → server-render via markdown-it (html: false), wrap in chrome
           - diagram (mmd) → server-render HTML page that loads pinned mermaid via CDN
           - app/deck/...  → chrome page with <iframe sandbox> pointing at /p/<token>/raw
```

`/p/<token>/raw` is a sibling endpoint that serves the artefact bytes directly with strict CSP and no chrome — it exists solely as the iframe `src` for HTML kinds. It honours the same auth as `/p/<token>` (no separate cookie path).

For `signin` mode, the viewer 302s to `https://oyster.to/auth/sign-in?return=/p/<token>`. This is a new param on `auth-worker`'s sign-in flow (see *Auth-worker change* below).

---

## Routes

```
GET /p/:share_token         — viewer entry point (chrome page, gate, or 302)
GET /p/:share_token/raw     — iframe content endpoint for HTML kinds
POST /p/:share_token        — password gate form submit (mode=password only)
```

The two GET endpoints share the same auth path (`resolveViewerAccess` below) and differ only in what they emit on success. POST is a thin handler that processes the password form and either sets the unlock cookie + 302s, or re-renders the gate.

---

## Access dispatch

Single function `resolveViewerAccess(req, env, shareToken)` returns a tagged union:

```ts
type ViewerAccess =
  | { ok: true; row: PublicationRow }              // serve content
  | { gate: 'password'; row: PublicationRow; error?: 'wrong_password' }
  | { redirect: string }                            // 302 (signin mode → auth-worker)
  | { gone: true; row: PublicationRow }             // 410
  | { not_found: true };                            // 404
```

Sequence:

1. **Lookup.** `SELECT * FROM published_artifacts WHERE share_token = ?`. No row → `{ not_found: true }`.
2. **Gone check.** `unpublished_at IS NOT NULL` → `{ gone: true, row }`.
3. **Mode dispatch:**
   - `open` → `{ ok: true, row }`.
   - `password`:
     - Read `oyster_view_<token>` cookie. If present and HMAC verifies (key from `env.VIEWER_COOKIE_SECRET`), `{ ok: true, row }`.
     - Else `{ gate: 'password', row }`.
   - `signin`:
     - Reuse the existing `resolveSession` helper from `worker.ts` (already shared across publish handlers). Returns `null` on missing/expired cookie.
     - Signed in → `{ ok: true, row }`.
     - Not signed in → `{ redirect: 'https://oyster.to/auth/sign-in?return=/p/<token>' }`.

The `POST` form handler is separate but builds on the same row lookup:

```ts
async function handlePasswordSubmit(req, env, shareToken) {
  const access = await resolveViewerAccess(req, env, shareToken);
  if ('not_found' in access) return notFoundResponse();
  if ('gone' in access) return goneResponse();
  // Only mode=password reaches here meaningfully; other modes ignore the post.
  if (access.row.mode !== 'password') return methodNotAllowedResponse();

  const form = await req.formData();
  const password = form.get('password');
  if (typeof password !== 'string' || password.length === 0) {
    return renderGate(access.row, { error: 'wrong_password' });
  }
  const ok = await verifyPbkdf2(password, access.row.password_hash!);
  if (!ok) return renderGate(access.row, { error: 'wrong_password' });

  const cookie = await signViewerCookie(shareToken, env.VIEWER_COOKIE_SECRET);
  return new Response(null, {
    status: 302,
    headers: {
      'set-cookie': `oyster_view_${shareToken}=${cookie}; HttpOnly; Secure; SameSite=Lax; Path=/p/${shareToken}; Max-Age=86400`,
      'location': `/p/${shareToken}`,
      'cache-control': 'private, no-store',
    },
  });
}
```

**Wrong-password rate-limiting** is enforced by a new rate-limiter binding `VIEWER_PASSWORD_LIMIT` on the `oyster-publish` Worker (scoped per IP, ~10 attempts / 60s — exact budget mirrors `auth-worker`'s `MAGIC_LINK_LIMIT`). Wrong-password attempts beyond the budget see a 429 page (same shape as the auth-worker's existing 429 HTML). Declared in `infra/oyster-publish/wrangler.toml`; no runtime config beyond the binding.

---

## Render dispatch

After `resolveViewerAccess` returns `{ ok: true, row }`, fetch the bytes from R2 and dispatch.

```ts
const obj = await env.ARTIFACTS.get(row.r2_key);
if (!obj) return internalErrorResponse(); // R2/D1 inconsistency — log + 500

const bytes = new Uint8Array(await obj.arrayBuffer());
const contentType = row.content_type;

if (contentType.startsWith('image/')) {
  return imageInlineResponse(bytes, contentType, row);
}

switch (row.artifact_kind) {
  case 'notes':
    return renderMarkdownPage(bytes, row);
  case 'diagram':
    return renderMermaidPage(bytes, row);
  case 'app':
  case 'deck':
  case 'wireframe':
  case 'table':
  case 'map':
    return renderChromeWithIframe(row);  // /raw will serve bytes
  default:
    // Unknown kind — fall back to attempted markdown render if text/* mime,
    // else iframe-with-raw. Conservative.
    return contentType.startsWith('text/')
      ? renderMarkdownPage(bytes, row)
      : renderChromeWithIframe(row);
}
```

Dispatch order — **content-type first, then kind** — so a `notes` artefact whose bytes are actually a PNG (rare but possible if someone edits a note's file directly) gets served correctly. Image MIME wins.

### Markdown (`notes`)

- Library: `markdown-it@^14`, configured `{ html: false, linkify: true, typographer: false }`.
- `html: false` means raw HTML in markdown is escaped — no XSS path through `<script>` or `<img onerror=>` injected into a notes file.
- Decode bytes via `new TextDecoder().decode(bytes)`. UTF-8 assumed; invalid sequences fall through to U+FFFD (markdown-it accepts).
- Wrap output in chrome page (`renderChromePage(html, row)`).
- CSP: `default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; script-src 'self'`.
  - Inline styles allowed (chrome stylesheet).
  - Inline scripts NOT allowed.
  - Images from any HTTPS source (markdown often references public images).

### Mermaid (`diagram`)

- Server-renders an HTML page with the source embedded in `<pre class="mermaid">…</pre>` plus a CDN script tag.
- Pinned: `https://cdn.jsdelivr.net/npm/mermaid@10.9.1/dist/mermaid.min.js` with subresource integrity (`integrity="sha384-…"` — value populated at build time, verified once and committed).
- Initialiser: `mermaid.initialize({ startOnLoad: false }); mermaid.run({ querySelector: 'pre.mermaid' }).catch(showSourceFallback)`.
- Fallback: on `mermaid.run()` rejection, replace the `<pre class="mermaid">` content with the original source wrapped in `<pre><code>` so the user sees diagram source rather than a blank page.
- CSP: `default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; img-src 'self' data:`.
  - Inline scripts allowed (the `mermaid.run()` initialiser is inline).
  - jsdelivr is the only off-origin script source.

### Single-file HTML kinds (`app`, `deck`, `wireframe`, `table`, `map`)

- The chrome page contains a header, footer, and `<iframe sandbox="allow-scripts" src="/p/<token>/raw" style="border:0;width:100%;height:calc(100vh - <chrome-height>);"></iframe>`.
- No `allow-same-origin` in the sandbox attribute → the iframe document is treated as a unique opaque origin. It cannot read `document.cookie` from the parent or fetch the parent's URLs.
- The `/raw` endpoint:
  - Same auth check (`resolveViewerAccess`).
  - Serves bytes directly with `Content-Type: row.content_type`.
  - Headers: `Cache-Control: <per mode>` (same rule as parent), `Content-Security-Policy: default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; connect-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none';`, `X-Frame-Options: SAMEORIGIN`.
  - The strict CSP forbids the artefact from making outgoing fetches (`connect-src 'none'`) and from being framed by anyone other than us (`X-Frame-Options: SAMEORIGIN`).

### Image content-type

- Serve bytes inline with `Content-Type: <recorded>` and `Content-Disposition: inline`.
- No chrome — the image is the page. (Browsers render bare images cleanly; wrapping them in chrome would be hostile to drag-to-save, right-click etc.)
- Same cache headers as the per-mode rule.

---

## Chrome

Chrome appears only on **successful published views** (open content / password viewer post-unlock / signin viewer post-auth). Intermediary states (gates, 410, 404, errors) get **minimal pages** — no chrome.

Chrome layout:

```
┌──────────────────────────────────────────────┐
│ 🦪 oyster                       <action>    │  ← header (height ~36px)
├──────────────────────────────────────────────┤
│                                              │
│   <rendered content or iframe>               │
│                                              │
├──────────────────────────────────────────────┤
│ Powered by Oyster · oyster.to               │  ← footer (height ~24px)
└──────────────────────────────────────────────┘
```

The `<action>` slot in the header is mode-aware:

| State | Action slot |
|---|---|
| Open viewer | "Get your own at oyster.to" link |
| Password viewer (post-unlock) | "Get your own at oyster.to" link |
| Signin viewer (signed in) | (empty in v1; user email in a future iteration) |

Footer is the same across success states. No additional buttons in v1 (no Share, no QR — those are good UX but explicitly deferred to keep PR scope tight; can be added without architecture change).

Chrome HTML+CSS is a single template module (`viewer-chrome.ts`) returning a string. Total weight ≤ 4 KB. No external CSS, no external fonts.

---

## Minimal pages (gates and errors)

Same template family — small lock/info icon, heading, hint paragraph, action(s). No header/footer chrome. Single discreet "Shared via Oyster" tagline at the bottom (small, low-contrast).

| Page | Heading | Body | Action(s) |
|---|---|---|---|
| Password gate | "Password required" | "This share is password-protected." | `<form method="POST">` with password input + Unlock button |
| Password gate (wrong) | same | "Incorrect password." (red, inline above input) | same |
| Sign-in gate (mode=signin, unsigned) | n/a | (no gate page — direct 302 to auth-worker) | n/a |
| 410 Gone | "This share has been removed" | "The owner has unpublished this artefact." | (none) |
| 404 Not found | "Share not found" | "The link may have been mistyped or removed." | (none) |
| Internal error | "Something went wrong" | "Try again in a moment." | (none) |
| Rate-limited (POST) | "Too many attempts" | "Wait a minute and try again." | (none) |

Plain HTML rendering with `Content-Type: text/html`. JSON variants returned only when `Accept: application/json` is set on the request — same body in `{ error: <code>, message: <human> }` shape, identical to other Worker error responses.

---

## Auth-worker change: generic `?return=`

`auth-worker`'s `/auth/sign-in` page and post-sign-in handlers (magic-link callback, GitHub callback) currently support only the device-code handoff (`?d=<user_code>`). For `signin` mode in the viewer, we add a generic `?return=<path>` param.

### Allowlist

Only paths matching `^\/p\/[A-Za-z0-9_\-]+$` are honoured. Anything else (including `https://`-prefixed URLs, `..` traversals, query strings, fragments) is silently dropped — sign-in proceeds, return path defaults to the existing landing.

This is closed against open-redirect: the only places we can land a visitor post-sign-in are share-token routes on our own zone.

### Wiring

- `/auth/sign-in?return=…` — render the existing form with `<input type="hidden" name="return" value="…">`. The magic-link POST handler reads it from the form body. The `?d=<user_code>` device flow is mutually exclusive with `?return=`: if both are present, `?d=` wins (device flow is its own destination), `?return=` is dropped.
- Magic-link request flow — pass `return` through to the magic-link record so the eventual click-through respects it.
- GitHub OAuth callback — store `return` in the `oauth_states` row alongside `pkce_verifier`, retrieve on callback.
- After successful session creation, if a valid `return` is recorded, 302 to it. Else default to current behaviour (`oyster.to/`).

### Schema impact

One additive nullable column on each of `magic_link_tokens` and `oauth_states`:

```sql
-- infra/auth-worker/migrations/0004_return_path.sql
ALTER TABLE magic_link_tokens ADD COLUMN return_path TEXT;
ALTER TABLE oauth_states ADD COLUMN return_path TEXT;
```

Both nullable, both ignored on existing rows. Wrapped in idempotent try/catch (auth-worker convention).

### Backwards compatibility

Pages that currently link to `/auth/sign-in` (no return) continue to work — empty/missing `return_path` falls through to the default.

---

## Cookie scheme (password mode)

`oyster_view_<token>` cookie shape:

```
<token>.<timestamp>.<hmac>

  token     — the share_token (redundant but explicit; lets us assert consistency)
  timestamp — unix seconds when the cookie was issued
  hmac      — HMAC-SHA256 over (token || "." || timestamp), keyed by env.VIEWER_COOKIE_SECRET
              base64url-encoded, no padding
```

Verification:

1. Parse `<token>.<timestamp>.<hmac>`. Reject malformed cookie.
2. Recompute HMAC; compare in constant time. Reject mismatch.
3. Require `token === <expected share_token>` (the cookie path scopes this, but assert anyway).
4. Require `now - timestamp <= 86400`. Reject expired (browser may have ignored Max-Age).

**Secret rotation** = ship a new `VIEWER_COOKIE_SECRET`; existing cookies become invalid; users re-enter password. Acceptable failure mode.

`VIEWER_COOKIE_SECRET` is a new Worker secret — set once via `wrangler secret put VIEWER_COOKIE_SECRET` against `oyster-publish` before this change merges. Spec'd here so it doesn't surprise the PR reviewer.

---

## Cache headers

| Surface | Header |
|---|---|
| Open viewer (chrome page) | `Cache-Control: public, max-age=60, must-revalidate` + `ETag: W/"<token>-<updated_at>"` |
| `/raw` (open mode, HTML kinds) | same |
| Image inline (open mode) | same |
| Password viewer (post-unlock) | `Cache-Control: private, no-store` |
| Signin viewer | `Cache-Control: private, no-store` |
| Password gate page | `Cache-Control: private, no-store` |
| 410 / 404 / errors | `Cache-Control: private, no-store` |
| 302 redirects (signin → auth) | `Cache-Control: private, no-store` |

`max-age=60` is short enough that an unpublish becomes visible almost immediately; long enough to absorb a viral share's burst on a single CDN node. `must-revalidate` ensures CDN-aged responses revalidate against origin rather than serving stale on errors.

`ETag` uses `updated_at` (not `published_at`) so a republish (which bumps `updated_at`) invalidates cached responses without changing the URL.

---

## Error matrix

| Condition | HTTP | Body |
|---|---|---|
| Share token not in D1 | 404 | minimal HTML "Share not found" / `{error:"not_found"}` |
| Token in D1, `unpublished_at NOT NULL` | 410 | minimal HTML "This share has been removed" / `{error:"gone"}` |
| `mode=password`, no/invalid cookie, GET | 200 | minimal HTML password gate |
| `mode=password`, POST, empty body | 200 | gate re-rendered with "Incorrect password" |
| `mode=password`, POST, wrong password | 200 | gate re-rendered with "Incorrect password" |
| `mode=password`, POST, rate-limit hit | 429 | minimal HTML "Too many attempts" |
| `mode=signin`, no/expired session, GET | 302 | `Location: /auth/sign-in?return=/p/<token>` |
| Auth passes, R2 object missing | 500 | minimal HTML "Something went wrong" / `{error:"internal_error"}` |
| Method not allowed (POST on `mode=open`) | 405 | minimal HTML / JSON |
| `?return=` value rejected by allowlist | n/a | sign-in proceeds; param silently dropped |

---

## Testing

### Worker unit tests (`infra/oyster-publish/test/`)

Add `viewer-handler.test.ts` and `viewer-helpers.test.ts`.

- HMAC cookie sign/verify round-trip (correct verifies, tampered rejects, expired rejects).
- Allowlist for `?return=` path: positive (`/p/abcXYZ_-`), negative (`/p/`, `/p/../etc`, `https://attacker.com`, `/dashboard`, empty).
- markdown-it config: raw `<script>` in input is escaped, not executed (assert via output string).
- mermaid HTML wrapper: contains pinned CDN URL with SRI hash, initialiser script, and source embedded.
- ETag generation: same `(token, updated_at)` → same etag; different `updated_at` → different etag.

### Worker integration tests (vitest-pool-workers)

- **Open mode happy path:** publish → GET `/p/<token>` → 200, chrome present, content rendered, etag set, cache-control `public, max-age=60`.
- **Open mode if-none-match:** second GET with `If-None-Match` header matching previous etag → 304.
- **410 gone:** publish → unpublish → GET → 410, "this share has been removed" page.
- **404 not found:** GET unknown token → 404.
- **Password mode, no cookie:** GET → 200 gate page; no `oyster_view_*` cookie set.
- **Password mode, correct password:** POST → 302 with cookie; follow-up GET → 200 content.
- **Password mode, wrong password:** POST wrong → 200 gate with error; no cookie set.
- **Password mode, expired cookie:** craft a cookie with timestamp older than 86400s → GET → 200 gate (cookie rejected).
- **Password mode, tampered cookie:** flip a byte in HMAC → GET → 200 gate.
- **Signin mode, unsigned visitor:** GET → 302 to `/auth/sign-in?return=/p/<token>`.
- **Signin mode, signed in:** GET with valid `oyster_session` cookie → 200 content.
- **Image content-type:** publish a tiny PNG, dispatch returns image/png inline (no chrome wrapping).
- **HTML kind iframe:** publish an `app`, GET → chrome page with `<iframe sandbox="allow-scripts" src="/p/<token>/raw">`. GET `/raw` → bytes with strict CSP.
- **Sandbox isolation assertion (best-effort):** `/raw` response includes the strict CSP header; `Content-Security-Policy` value contains `connect-src 'none'`.
- **Mode + cache header matrix:** assert each of the seven surface cases above sets the right `Cache-Control`.

### Auth-worker tests (`infra/auth-worker/test/`)

- `?return=/p/abc123` honoured: form's hidden input contains the return path; magic-link landing 302s to it.
- `?return=` injected as `https://attacker.com` is dropped; sign-in proceeds, post-sign-in 302 goes to default.
- `?return=` together with `?d=<user_code>` (device flow): `?d=` wins, return is dropped (deliberate — device flow is its own destination).
- GitHub OAuth callback honours stored return path; rejected paths are dropped.

### Manual smoke (post-deploy)

- Publish three artefacts (open / password / signin) via MCP against the local server.
- Visit each share URL in a fresh browser:
  - Open: content renders, chrome visible, etag in DevTools, second load is 304.
  - Password: gate renders, wrong password shows error, correct password unlocks, reload shows content (no re-prompt).
  - Signin: 302 to sign-in form, sign in via GitHub OAuth, land back on the share, content renders.
- Visit a published HTML `app`: confirm iframe wraps it, `document.cookie` from the iframe's devtools console returns `""` (no `oyster_session`).
- Unpublish one: visit URL → 410 page.

---

## Known limitations

1. **CDN dependency for mermaid.** jsdelivr outage = mermaid diagrams show source-fallback. Acceptable; falling back to source is graceful.
2. **No sanitiser for markdown beyond `html: false`.** A determined attacker can still produce a markdown link to `javascript:…` — markdown-it's `linkify: true` doesn't catch this. Solution: post-process the rendered HTML to strip `href` values matching `^javascript:` (~5 lines of regex). Spec'd here, implemented in the PR.
3. **Sandbox iframe's CSP is best-effort.** A clever HTML artefact could in theory use forms or `<base>` to escape — that's why the `/raw` CSP includes `base-uri 'none'` and `form-action 'none'`. Not all browsers enforce every CSP directive uniformly; Cloudflare's egress logs would catch widespread abuse.
4. **No rate-limiting on `GET /p/<token>`.** Public reads are uncapped. Bandwidth abuse is bounded by R2 read pricing; if it becomes a problem, add a per-IP rate limiter (existing `MAGIC_LINK_LIMIT` pattern is reusable).
5. **`oyster_view_<token>` cookie is per-token, not per-user.** Two visitors sharing a browser would share the unlocked state for a given share. Acceptable — password sharing is the threat model the publisher already accepted.
6. **No view counts or analytics.** A `published_artifacts.view_count` is a future column; out of scope here.
7. **No "I forgot the password" recovery flow.** The publisher unpublishes and republishes (with a new token + new password). Acceptable for v1.

---

## Decisions log

| Question | Decision | Reason |
|---|---|---|
| One Worker or split chrome / `/raw`? | One Worker, two routes. | `/raw` is just an alternate render of the same auth-checked row; sharing `resolveViewerAccess` keeps logic single-sourced. |
| Sandbox iframe vs separate origin (e.g. `pub.oyster.to`)? | Sandbox iframe (`allow-scripts` only). | Achieves origin isolation without introducing a new domain or cookie-domain change. Sandbox-no-`allow-same-origin` is the standard pattern. |
| markdown lib? | `markdown-it` with `html: false`. | Disables raw HTML at the parser level. No DOMPurify dependency, no DOM in Worker. Smaller than marked + sanitizer combo. |
| mermaid lib? | Pinned CDN (jsdelivr `mermaid@10.9.1`) with SRI. | Mermaid is ~600 KB; bundling in the Worker would inflate cold-start and bytes-deployed. Client-side render is the upstream-recommended path. |
| mermaid fallback on failure? | Show source in `<pre><code>`. | A blank page is the worst failure mode; source-as-fallback is informative and graceful. |
| Chrome on every viewer surface? | No — chrome on success states only; minimal pages on gates/errors. | Chrome competes with single-task pages (gates have one job). Cleaner UX, smaller HTML for failure paths. |
| Action slot in header for password mode? | Empty. | "Sign in" or "Get Oyster" links would compete with the gate's primary action. |
| Sign-in redirect mechanism? | Generic `?return=<path>` param on auth-worker, allowlisted to `/p/*`. | Standard pattern. Allowlist closes open-redirect. Future Workers (e.g. /apps/*) reuse the same param. |
| Cookie for password unlock? | HMAC-signed, per-token, `Path=/p/<token>`, 24h, HttpOnly+Secure+SameSite=Lax. | Per-token scope prevents one unlock from leaking to other shares. Path-scoping limits cookie surface. 24h is a reasonable session window for a shared link. |
| Cache `max-age` for open mode? | 60 seconds. | Long enough to absorb a single-node burst; short enough that unpublish becomes visible quickly. |
| ETag basis? | `W/"<token>-<updated_at>"`. | Republish bumps `updated_at` → cache invalidated. Weak etag is fine (HTML responses aren't byte-identical across renders due to timestamps). |
| 404/410 page format? | HTML by default; JSON if `Accept: application/json`. | Browsers default to `*/*` or `text/html`; agents can opt in. |
| `?return=` allowlist regex? | `^/p/[A-Za-z0-9_-]+$`. | Matches the share-token charset. Anything else (full URLs, traversal, other paths) is rejected. |
| Image content-type dispatch order? | content-type → kind. | If bytes are image/* the chrome doesn't matter; serve inline regardless of `artifact_kind`. |
| Auth-worker schema change for `return_path`? | Yes — additive nullable columns on `magic_links` and `oauth_states`. | Sign-in is async (magic link, OAuth callback); we need to persist the return path across the round-trip. |
| Single PR or split? | Single PR. | The auth-worker schema delta is two additive nullable columns — small enough not to warrant its own PR. Reviewing the viewer + the return-path plumbing together is clearer than splitting them. |
| New secrets? | `VIEWER_COOKIE_SECRET` on `oyster-publish`. | Required for HMAC. One-time `wrangler secret put` before merge. |

---

## Operational changes

Cloud-surface delta introduced by this PR. All listed here so the deploy story is clear.

| Change | Where | Operational step |
|---|---|---|
| New secret `VIEWER_COOKIE_SECRET` | `oyster-publish` Worker | `wrangler secret put VIEWER_COOKIE_SECRET --name oyster-publish` (32-byte random hex) before merge |
| New rate-limiter binding `VIEWER_PASSWORD_LIMIT` | `infra/oyster-publish/wrangler.toml` | declared in repo; deployed automatically with the Worker |
| Additive column `magic_link_tokens.return_path TEXT` | `infra/auth-worker/migrations/0004_return_path.sql` | applied via wrangler at deploy; idempotent try/catch in worker startup as fallback |
| Additive column `oauth_states.return_path TEXT` | same migration | same |
| New routes already covered by existing wrangler.toml | `oyster.to/p/*` and `www.oyster.to/p/*` | already routed (the 501 stub uses these); no change |

No new D1 databases, no new R2 buckets, no new domains, no DNS changes.

---

## Implementation sequence (for the plan that follows)

This spec is single-PR. Suggested task ordering inside that PR (will be settled by `superpowers:writing-plans`):

1. **Auth-worker `?return=` plumbing** — `0004_return_path.sql` migration, allowlist helper, sign-in form hidden input, magic-link callback, GitHub OAuth callback. Tests. Independent of `oyster-publish` changes.
2. **`oyster-publish` bindings** — declare `VIEWER_PASSWORD_LIMIT` rate-limiter in `wrangler.toml`; document `VIEWER_COOKIE_SECRET` in README and prepare the deploy runbook entry.
3. **`oyster-publish` viewer scaffold** — `resolveViewerAccess`, the new GET/POST route handlers (still returning bare 200/404/410/302 with no body) so the dispatch table is testable.
4. **Chrome + minimal-page templates** — `viewer-chrome.ts`, `viewer-pages.ts`. Pure functions returning strings. Snapshot tests.
5. **Render dispatch** — markdown, mermaid, image, iframe. One function each in `viewer-render.ts`.
6. **`/raw` endpoint** — strict-CSP byte serving for HTML kinds.
7. **Cookie HMAC** — `viewer-cookie.ts` with sign/verify; consume `env.VIEWER_COOKIE_SECRET`.
8. **Cache headers + ETag** — inject into each response path.
9. **Wiring** — replace the `501` stub in `worker.ts` with the full dispatch.
10. **Worker integration tests** — full happy/sad-path matrix.
11. **Manual smoke against deployed Worker** post-merge — three modes, iframe isolation check, 410 after unpublish.

Anchors: `infra/oyster-publish/src/worker.ts` is the home; `infra/auth-worker/src/worker.ts` (lines 649-663 `handleWhoami`) is the session-cookie pattern; `server/src/password-hash.ts` is the PBKDF2 producer that the viewer's Web Crypto verifier must match exactly.

---

## Anchor docs

- [`docs/superpowers/specs/2026-05-03-r5-publish-backend-design.md`](./2026-05-03-r5-publish-backend-design.md) — backend that produces the bytes this viewer serves.
- [`docs/requirements/oyster-cloud.md`](../../requirements/oyster-cloud.md) — R5 canonical requirement.
- [`docs/plans/roadmap.md`](../../plans/roadmap.md) — 0.7.0 milestone scope.
- Issue #316.
