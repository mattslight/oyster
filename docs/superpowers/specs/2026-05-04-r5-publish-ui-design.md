# R5 Publish UI — Design Spec

**Date:** 2026-05-04
**Status:** Approved for implementation
**Scope:** Publish surface/UI plus required local-server plumbing: artefact wire-format extension and `artifact_changed` SSE broadcasts. Cloud Worker and publish/unpublish behaviour already shipped in #315 and #316 — unchanged here.

**Tracks:** Issue #317. Final piece of R5 in [`docs/requirements/oyster-cloud.md`](../../requirements/oyster-cloud.md). Builds on [`2026-05-03-r5-publish-backend-design.md`](./2026-05-03-r5-publish-backend-design.md) and [`2026-05-03-r5-viewer-design.md`](./2026-05-03-r5-viewer-design.md).

---

## Problem

The publish backend works end-to-end through MCP and through `curl`. The local server has the routes; the Worker serves the viewer; tokens, cookies, password hashing, and three access modes are all live in production. What's missing is the UI — there is no button anywhere in Oyster that lets a user publish an artefact. Pricing-page-led signups will not be MCP-savvy.

R5 is not "done" until the surface exposes Publish as a first-class action. This spec covers that exposure: where the entry points live, what the modal renders across its five visible states (unpublished, signed-out, in-flight, published, error), what indicator the tile carries when an artefact has an active share token, and the wire-format and SSE plumbing the client needs.

The visible surface decisions in this spec are deliberately narrow. Sign-in mode is omitted from the picker until it gates on something concrete (specific emails / org). The current backend `signin` mode keeps working for agents — the UI just doesn't ship a button for it.

---

## Goals

- A user can right-click any user-owned artefact, choose Publish, pick **Open** or **Password**, and get a copyable `oyster.to/p/<token>` URL — without leaving the modal.
- The same modal, re-opened on a published artefact, shows the live URL, a Copy button, a QR toggle, the access selector, and an Unpublish action.
- Tiles for currently-published artefacts carry a small **Published** (or **Password**) tag below the label, with an adjacent one-click copy-link icon.
- Tile state updates in real time across the surface: an agent calling `publish_artifact` causes the chip to appear without a manual refresh.
- A signed-out user encountering Publish is led through Oyster sign-in (existing device flow) without losing the modal context.

## Out of Scope

- **Sign-in mode in the picker.** The backend's `signin` mode keeps working for agents and existing publications, but the UI does not surface it as a third radio button. It returns to the picker when it gates on something real (email allowlist, organisations) — see Decisions log.
- **Email allowlist functionality.** Schema, viewer enforcement, and UI all deferred — separate issue.
- **Published-artefact management dashboard.** No "list all my publications" page in v1. The cap-exceeded error tells the user to unpublish one but doesn't show which.
- **Archive auto-unpublish.** Archiving a currently-published artefact does not unpublish it. Real corner — filed as a follow-up.
- **Cross-device cloud-mirror refresh.** A publish from machine A is invisible on machine B's UI until R3 sync arrives in 0.8.0+.
- **Republish-to-update-content from the UI.** Agents can republish via MCP to push fresh bytes; the UI only triggers a republish when the user changes mode. Pure content-refresh from the UI is deferred.
- **Quick-list-and-unpublish from the cap error.** Inline message only.
- **QR polish beyond a basic inline toggle.** No download, no resize, no styled corners.
- **Pro-tier behaviours.** 0.8.0+.

---

## Topology

```
Desktop tile (ArtifactIcon.tsx)
     │
     ├── right-click → Desktop.tsx context menu — adds "Publish…" entry
     │
     └── PublishedChip (new) — "Published" tag + copy-link icon
            └── click icon → navigator.clipboard.writeText(publication.shareUrl)

ViewerWindow.tsx header
     │
     └── Share button (new) — opens PublishModal

ChatBar.tsx slash commands
     │
     └── "/p <search>" — mirrors "/o" — opens PublishModal for matched artefact

PublishModal (new — components/PublishModal.tsx)
     │
     ├── pre-publish state: mode picker + Publish button
     ├── signed-out state:  inline sign-in CTA (reuses AuthBadge's device flow)
     ├── in-flight state:   spinner, buttons disabled
     ├── published state:   URL + Copy + QR toggle + access picker + Unpublish + Done
     └── error state:       inline error row at top, modal stays open

publishApi (new — data/publish-api.ts)
     │
     ├── publishArtifact(id, mode, password?) → POST /api/artifacts/:id/publish
     └── unpublishArtifact(id)               → DELETE /api/artifacts/:id/publish

Local server
     │
     ├── routes/publish.ts  — already exists; emits artifact_changed SSE post-call (NEW)
     ├── routes/artifacts.ts — extends Artifact response with publication sub-object (NEW)
     └── mcp-server.ts publish_artifact / unpublish_artifact — also broadcast artifact_changed (NEW)
```

Three load-bearing topology decisions:

- **One modal, five visible states.** Driven by the artefact's `publication` field and an internal `phase` variable (`idle` | `signing-in` | `publishing` | `unpublishing`). Visible state is derived from both: e.g. `(publication=null, phase=idle)` → unpublished view; `(publication=live, phase=publishing)` → in-flight view over the published view.
- **Backend stays untouched.** Publish/unpublish routes and MCP tools are unchanged in behaviour. The only server-side delta is (a) extending the artefacts wire format with the `publication` object and (b) broadcasting `artifact_changed` after publish/unpublish completes.
- **Sign-in flow reuses AuthBadge's device flow.** No new auth surface. The modal opens the same `sign_in_url`, polls `/api/auth/whoami` with the same hook, and on success re-enables Publish.

---

## Wire format

### `Artifact.publication`

`shared/types.ts` extends `Artifact` with one new field:

```ts
export interface Artifact {
  // …existing fields…
  publication?: ArtefactPublication | null;
}

export interface ArtefactPublication {
  shareToken: string;
  shareUrl: string;                  // pre-rendered "https://oyster.to/p/<token>"
  shareMode: 'open' | 'password' | 'signin';
  publishedAt: number;               // unix ms — first publication of this token
  updatedAt: number;                 // unix ms — last publish call
  unpublishedAt: number | null;      // null = live; non-null = retired
}
```

**Live vs retired:** the chip's "is published" check is `publication && publication.unpublishedAt == null`. Retired publications stay on the wire so the UI can later add a "previously published at /p/abc, now offline" affordance — out of scope here, but the format doesn't preclude it.

**Wire convention:** when a row has no share token, the JSON omits the `publication` field entirely (rather than serialising it as `null`). On the client, `artifact.publication` is therefore `undefined`, not `null`. Tests should assert `expect(artifact.publication).toBeUndefined()` for unpublished rows.

### Server mapping

`server/src/routes/artifacts.ts` (or whichever module emits the artefact wire format) maps SQLite snake_case to the camelCase wire shape. `publication` is built from `artifacts.share_token`, `share_mode`, `share_updated_at`, `published_at`, `unpublished_at`. When `share_token IS NULL`, the `publication` field is omitted from the JSON entirely (per wire convention above). `shareUrl` is rendered server-side from `${workerBase}/p/${share_token}`, where `workerBase` is the same constant already wired into `publish-service.ts` (created in `server/src/index.ts` alongside the rest of the service deps). One source of URL truth.

### Existing fields untouched

No other Artifact fields change. No DB migration — all the columns are already present from #314 and #315.

---

## SSE event: `artifact_changed`

New event broadcast on `/api/ui/events`, following the `session_changed` precedent:

```ts
{
  version: 1,
  command: "artifact_changed",
  payload: { id: string }
}
```

**Emitted by:**

- `routes/publish.ts` — after successful POST or DELETE, post-service-call.
- `mcp-server.ts` `publish_artifact` and `unpublish_artifact` — same point, after the service returns.

**Client behaviour:** App's existing SSE listener already routes by `command`. New handler refetches `/api/artifacts` and merges into local state. Refetching the full list (rather than the single artefact) matches the existing pattern for other mutations and keeps the wire surface tiny — typical N is tens of artefacts; cost is negligible.

**Service stays pure.** The broadcast is a side-effect at the call-site (route or MCP handler), not inside `publish-service.ts`. Keeps the service unit-testable without an SSE harness.

---

## Entry points

### Right-click context menu (Desktop.tsx)

Add a new "Publish…" entry to the artefact context menu, alongside Rename / Regenerate icon / Archive. Position: between "Regenerate icon" and the Archive separator.

```
Rename
Regenerate icon
Publish…             ← NEW (or "Manage publication…" when published)
─────────────
Archive
```

Label is "Publish…" when `publication` is null/retired; "Manage publication…" when live. Click opens `PublishModal` with that artefact.

**Hidden when:**
- `artifact.builtin === true` (first-party; no user content to publish)
- `artifact.plugin === true` (third-party plugin code, not user content)
- `artifact.status === "generating"` (file may not exist or be partial)
- `isArchivedView === true` (archived artefacts can't be published)

### ViewerWindow header

Add a Share button to the viewer chrome header, left of the existing close (×) and overflow (⋯) actions. Lucide `Share2` icon + visible label "Publish" (or "Published" in purple when live). Click opens `PublishModal` for the current artefact.

Same hide rules as above. Builtin / plugin / generating-state artefacts don't get the button.

### Slash command `/p <search>`

Mirror `/o`'s implementation in `ChatBar.tsx`:

- Add `{ cmd: "/p", args: "<search>", desc: "Publish artifact", example: "/p competitor analysis" }` to `SLASH_COMMANDS`.
- In `slashItems`, route `^/p(\s+(.*))?$` through the same scoring as `/o` (`scoreArtifacts`).
- In `handleSend`, route `cmd === 'p'` to a new handler that opens `PublishModal` with the matched artefact (single match auto-opens; multiple shows autocomplete; zero shows "No artifact matching X" message).
- **Filter results** to exclude builtin / plugin / generating artefacts before scoring. A user typing `/p pomodoro` should not see the bundled Pomodoro plugin in the dropdown.

The slash command goes through `App.tsx`'s existing `onArtifactOpen`-style prop; introduce a sibling `onArtifactPublish` prop on `ChatBar` that the App-shell wires to the modal opener.

---

## PublishModal — states

One component, five visible states. Driven by `artifact.publication` and an internal `phase` (`idle` | `signing-in` | `publishing` | `unpublishing`). The modal also keeps a recoverable `error` field that surfaces in state E whenever it is non-null:

### A. Unpublished state (publication is null/retired, phase=idle)

```
┌─────────────────────────────────┐
│ Publish artefact                │
│ competitor-analysis.notes       │
│                                 │
│ ◉ Open · anyone with the link   │
│ ○ Password · link + password    │
│                                 │
│ ┌─[hidden until Password mode]─┐│
│ │ [password input]              ││
│ └───────────────────────────────┘│
│                                 │
│             [Cancel] [Publish]  │
└─────────────────────────────────┘
```

- Compact radio rows, no icons (two modes; visual differentiation isn't pulling weight).
- Selecting Password reveals a password input below the picker. Publish button disabled while password mode is selected and password is empty.
- Switching back to Open clears the password input (avoids the "saved a password I never see" footgun if the user toggles modes mid-edit).
- Cancel closes; Esc closes; backdrop click closes.

### B. Signed-out state (currentUser is null, phase=idle or signing-in)

```
┌─────────────────────────────────┐
│ Publish artefact                │
│ competitor-analysis.notes       │
│                                 │
│ Sign in to Oyster to publish.   │
│ Publishing requires an account. │
│                                 │
│         [Cancel] [Sign in]      │
│                                 │
│ ─── after click ───             │
│ Waiting for sign-in… (cancel)   │
└─────────────────────────────────┘
```

- Detects signed-out via a single `GET /api/auth/whoami` call when the modal mounts. Result cached on the modal instance for the duration. SSE `auth_changed` events also flip the cached value so a sign-in via AuthBadge while the modal is open is reflected without a manual refresh.
- Sign in button calls `POST /api/auth/login` (the device-flow start endpoint AuthBadge uses), opens the returned `sign_in_url` in a new tab, switches phase to `signing-in`.
- Polls `/api/auth/whoami` while in `signing-in` (reuse the AuthBadge polling logic — extract to `hooks/useAuthPolling.ts` during implementation, or import directly if extraction proves too tangled in plan-time).
- On sign-in success, returns to the **unpublished** state (phase=idle). **No auto-publish.** User clicks Publish themselves — preserves explicit intent and avoids surprises after a long idle.
- On user cancel during polling, returns to phase=idle without unwinding the sign-in (the new tab continues; if they sign in later, AuthBadge will reflect it).
- Polling timeout matches AuthBadge's existing timeout to avoid stuck-spinner.

### C. In-flight state (phase=publishing or unpublishing)

- Buttons disabled.
- Spinner replaces the Publish (or Unpublish) button label.
- Modal cannot be dismissed via Esc / backdrop while in-flight. Close button still works — Close hides the modal; the in-flight request continues and the eventual SSE event reconciles state.
- No progress bar in v1 (10 MB cap; typical publish is <1 s on broadband; over-engineering otherwise).
- Aborting an in-flight upload is not exposed as a UI action — partial-state recovery is deferred.

### D. Published state (publication is live, phase=idle)

```
┌─────────────────────────────────┐
│ Published                       │
│ competitor-analysis.notes       │
│                                 │
│ ┌─URL trophy───────────────────┐│
│ │ oyster.to/p/Hk3qm9p_ZxN…     ││
│ │ [Copy link]      [▦ QR]      ││
│ │                              ││
│ │ [QR canvas — when toggled]   ││
│ └──────────────────────────────┘│
│ Live · published 2 minutes ago  │
│                                 │
│ ACCESS                          │
│ ◉ Open · anyone with the link   │
│ ○ Password · link + password    │
│                                 │
│ [Unpublish]   [Save] [Done]     │
└─────────────────────────────────┘
```

- **URL trophy** — readonly input + full-width Copy button + small QR icon button beside it. Copy button label flashes "Copied" for 1.5 s on click.
- **QR toggle** — clicking the icon button reveals an inline SVG below, regenerated from `publication.shareUrl`. Library: `qrcode-generator` (~6 KB, no DOM, no peer deps), lazy-loaded via dynamic `import()` on first toggle so the QR module isn't in the initial bundle. Mode picker stays visible while QR is open; modal grows vertically.
- **Access picker** — same radio rows as the unpublished state, pre-selected to current `publication.shareMode`. **Edge case (currently empty):** if a publication is somehow already `signin`-mode (set by an agent), show the URL and a helper line — *"This publication is sign-in restricted. Pick Open or Password to manage it from the UI."* — and let the user pick one. Save appears once they do. No agents currently create signin-mode publications, so this branch is defensive.
- **Save** — appears next to **Done** *only* when (a) the picker differs from the current mode, OR (b) the user has typed a non-empty password while still on Password mode. Otherwise Save is hidden — no clutter on a no-op.
- Switching modes within the modal clears the password input (same logic as state A).
- **Password field on re-open** — when current mode is Password and modal opens, password input is empty with placeholder "Password is set. Leave blank to keep it." Save is hidden if mode unchanged and password input is empty (no-op locally — never reaches the backend).
- **Unpublish** — left-aligned, red text, no border. Click triggers a small `ConfirmModal` overlay: "Unpublish this artefact? This retires the URL — re-publishing creates a new one." On confirm, modal switches to phase=unpublishing, calls `DELETE /api/artifacts/:id/publish`, on success returns to the **unpublished** state so the user can re-publish without dismissing.
- **Done** — closes the modal. Same as backdrop / Esc.

### E. Error state

- Inline error row at the top of the modal (above the artefact label).
- Red text, no banner chrome — just a single line.
- Modal stays open in whatever phase preceded the error; user can fix and retry.
- 502 / network errors get a Retry button next to the error row.

---

## Tile chip (PublishedChip component)

Renders below the `<ArtifactIcon>` label when `artifact.publication?.unpublishedAt == null`. New component `web/src/components/PublishedChip.tsx`, mounted from inside `ArtifactIcon.tsx` after the label.

```
[icon thumb]
plan.notes
PUBLISHED  [▭ icon]
```

- **Tag** — small uppercase pill. Background `rgba(167,139,250,0.12)`, foreground `#a78bfa` for Open mode. Foreground `#fbbf24` and a small lock glyph (Lucide `Lock`) prefix for Password mode (background tinted to match). Hover: tooltip showing `publication.shareUrl`.
- **Tag is informational only** — not clickable. No click handler, no cursor:pointer.
- **Icon button** — adjacent, ~14×14 px, Lucide `Link2` (or `Share2`). Hover: tooltip "Copy link" + button highlights. Click: `navigator.clipboard.writeText(publication.shareUrl)`, button briefly turns green with a `Check` glyph for ~1.2 s, then fades back.
- **Tag mounts only on tiles, not in groups, not in archived view, not on builtin/plugin tiles.** A built-in artefact can't be published, so it never has `publication`; the chip naturally won't render. Same for archived view (the artefact may have a retired publication, but the chip's render condition is `!unpublishedAt` so it stays hidden).

The chip never renders for retired publications. No "previously published" affordance in v1.

---

## Errors

All HTTP error codes proxied verbatim from `routes/publish.ts`. Modal handling:

| Code | Status | UX in modal |
|---|---|---|
| `sign_in_required` | 401 | Switches to **signed-out state**. Not shown as an error — handled as a flow. |
| `not_artifact_owner` | 403 | "This artefact belongs to <other-account-email>." (Backend returns owner detail in `details`; surface it.) |
| `not_publication_owner` | 403 | "This publication belongs to a different account." |
| `artifact_not_found` | 404 | "This artefact no longer exists." Modal closes after 2 s. |
| `publication_not_found` | 404 | (Unpublish path only — race with another client.) "Already unpublished." Modal returns to unpublished state. |
| `publish_cap_exceeded` | 402 | "5 of 5 publications. Unpublish one to free a slot." No Retry button. |
| `artifact_too_large` | 413 | "This artefact is X.X MB. Free tier limit is 10 MB." |
| `password_required` | 400 | (Should never reach here — client-side guard. Defence in depth.) "Enter a password." |
| `invalid_mode` | 400 | (Should never reach here — radio-only input.) "Pick a mode." |
| `upload_failed` | 502 | "Couldn't upload — try again." Retry button. |
| Network failure | n/a | "Check your connection — try again." Retry button. |

Errors clear automatically when the user changes a field or clicks a different button.

---

## Behaviour details

### Mode change as a republish

Switching mode in the published-state modal and clicking Save calls `POST /api/artifacts/:id/publish` with the new mode. The backend's upsert keeps the same `share_token` and bumps `updated_at` (per backend spec). The URL trophy doesn't change visually; the access picker just updates its checked radio and the Save button hides.

### Password-only update

User on Password mode wants to rotate the password: types a new password into the previously-empty input, clicks Save. Same `POST` call with `mode='password'` + new `password`. Backend re-hashes the stored `password_hash`.

**Open question for implementation:** whether existing visitor unlock cookies (`oyster_view_<token>`) are invalidated by the hash change. The cookie is HMAC'd against `share_token` plus a timestamp, not against the password hash, so a password rotation does not by itself force re-entry — the cookie's path-scope and Max-Age remain. Verify the viewer cookie-verify code path before claiming password rotation re-gates current visitors. If today it doesn't, two paths: (a) accept it as-is and document, (b) extend the cookie to embed the password-hash version so verify-time mismatch invalidates. Decision deferred to implementation; spec must not assert otherwise.

### Copy-on-tile vs copy-in-modal

Tile icon button and modal Copy button do the same thing — write `publication.shareUrl` to clipboard. They share a small `useCopyLink(url)` hook so behaviour stays identical (timing, "Copied" feedback duration).

### Concurrent publishes from agent and UI

If an agent publishes via MCP while the user has the modal open, the `artifact_changed` SSE event arrives. The modal listens and reconciles: if the modal's local state still matches the new `publication`, no visual change. If the modal was in the unpublished state and the agent just published it, the modal hops to the published state (with the new URL). Edge case but captured by the same SSE listener that drives the chip.

### Sign-in window left open

If the user clicks "Sign in" and the modal stays open polling, then closes the modal, then completes sign-in in the new tab — `AuthBadge`'s polling continues independently (it always polls when in `signing-in` phase). When they next open the modal, they're signed in and the unpublished state renders normally.

### Builtin / plugin gating in the slash command

`/p pomodoro` should not return the bundled Pomodoro plugin. The scoring filter applied before `scoreArtifacts` runs:

```ts
const publishable = artifacts.filter(a =>
  !a.builtin && !a.plugin && a.status !== "generating"
);
```

Same filter for "no match" messages.

---

## Testing

### Unit (Vitest, web/src)

- `PublishedChip` — renders only when `publication.unpublishedAt == null`. Renders amber + lock glyph when `shareMode === 'password'`. Click on icon button writes to clipboard (jsdom mock) and shows transient ✓.
- `PublishModal` state transitions — pre-publish → in-flight → published; published → unpublishing → unpublished; signed-out → signing-in → unpublished (post sign-in).
- Save-button visibility — hidden when no diff; visible when mode picker differs from current; visible when password input non-empty on Password mode.
- Password-on-reopen — placeholder shows, save hidden when input empty + mode unchanged.
- Slash-command filter — `/p pomodoro` excludes plugin artefacts from scoring results.
- `useCopyLink` — same behaviour from chip and modal.
- Wire-format mapper — server response with snake_case columns produces correct `publication` camelCase. `share_token = NULL` produces no `publication` field at all (assert `publication === undefined`, not `null`).

### Integration (existing server test pattern)

- `routes/publish.ts` after success emits `artifact_changed` SSE event with the right `id`.
- `mcp-server.ts` `publish_artifact` after success emits `artifact_changed`.
- `mcp-server.ts` `unpublish_artifact` emits `artifact_changed`.
- Artefact wire format includes `publication` for published rows, omits for unpublished rows, includes-with-`unpublishedAt` for retired rows.

### Manual smoke (post-merge, against deployed Worker)

- Right-click a notes artefact → Publish → Open → confirm URL → click Copy → paste — URL works in incognito.
- Re-open right-click → Manage publication → switch to Password → enter password → Save — URL still works, password gate enforces.
- Re-open → Unpublish → confirm — URL returns 410.
- Publish again — fresh URL (different token).
- Open ViewerWindow on a notes artefact → click Publish in the header → same flow.
- Use `/p competitor` → modal opens for the matched artefact.
- Right-click on a builtin (e.g. the Pomodoro plugin tile if installed) → no Publish entry.
- Right-click on a generating artefact mid-creation → no Publish entry.
- Sign out via AuthBadge, then attempt Publish → modal shows sign-in CTA → click → sign in → modal returns to unpublished state.
- Trigger 5 publishes via MCP from an agent → 6th publish from UI returns 402; modal shows "5 of 5" inline.

---

## Known limitations (explicit deferrals)

1. **Cross-device blindness.** Publishing from one machine doesn't update the surface on another machine until R3 cloud sync. The chip on machine B will be stale.
2. **Archive doesn't unpublish.** Archiving a currently-published artefact retains the share URL. Filed as a separate issue. Worth a banner-or-confirm in a follow-up that says "This artefact is published — also unpublish?" but out of scope here.
3. **Cap-exceeded UX.** No "show me my 5 publications, let me unpublish one" affordance. User has to find the tiles themselves.
4. **No UI republish-content action.** Editing an artefact after publication does not update the published copy. The UI can change access mode or password only — Save is hidden when neither differs from current state. Agents can still republish fresh bytes via MCP. A "Republish content" affordance is deferred.
5. **Mode-only change re-uploads bytes.** `POST /api/artifacts/:id/publish` always reads the artefact bytes and forwards them — there is no "only update mode" path. For a 10 MB artefact this is a wasted upload on a mode switch. Cost is bounded; not worth a backend extension yet.
6. **Sign-in flow leaves a tab.** The device flow opens a new tab; if the user signs in there and never closes it, the tab lingers. Same as today's AuthBadge behaviour.
7. **Tile chip can't show retired publications.** Once `unpublishedAt` is set, the chip vanishes. No "was published, now offline" affordance.
8. **No bulk publish.** Each artefact is published individually. No multi-select.

---

## Decisions log

| Question | Decision | Reason |
|---|---|---|
| Sign-in mode in the picker? | No. Open + Password only in v1. | `signin` mode today is "Open + sign-up tax" — no visible benefit. Returns when it gates on something real (email allowlist). |
| Email allowlist scope? | Out. | Scope creep into backend (D1 column, viewer enforcement, UI input). Separate issue. |
| Compact radio list vs cards vs segmented? | Radio list. | Two modes; icons / cards over-decorate. |
| Modal closes + toast vs morphs in place? | Morphs. | Keeps URL on screen for copy. One modal, five visible states. |
| QR in v1? | Yes. | ~6 KB lib, ~30 lines TSX, real benefit for Oyster's mobile-tested HTML/deck/wireframe artefacts. |
| Tile chip: dot vs glyph vs text vs glow? | Text tag + adjacent copy-link icon. | Tag is self-explanatory; icon is one-click utility. Avoids existing corner collisions (source-glyph top-right, status-dot bottom-right). |
| Tag clickable? | No. | Two click targets ~14 px apart invites mis-clicks. Tag informational; icon does the work. Modal is reachable via three other entry points anyway. |
| Sign-in flow integration? | Reuse AuthBadge's device flow. | No new auth surface; modal polls the same whoami endpoint. |
| Auto-publish after sign-in? | No. | User intent could be stale after long idle. Show signed-in state, let user click. |
| Password on re-open? | Empty field with placeholder; Save no-op when mode unchanged + empty input. | No backend extension needed. Preserves rotate-without-mode-change. |
| Mode-change semantics? | Same `share_token`; bumps `updated_at`. | Backend already does this. UI just hides Save when no diff. |
| Builtin / plugin / generating publishable? | No — UI hides Publish entirely. | Their bytes aren't user content; backend doesn't gate so UI must. |
| Wire format shape? | Nested `publication` object on `Artifact`. | Cleaner than five flat optional columns; idiomatic for "is published" check. |
| Wire format `shareUrl`? | Pre-rendered server-side. | Single source of truth for URL shape; client doesn't reimplement. |
| SSE event name? | `artifact_changed` with `{ id }`. | Matches `session_changed` precedent. Generic — reusable for future mutations. |
| SSE-driven refetch granularity? | Full artefact list refetch. | Matches existing pattern. N is small. |
| Slash command? | `/p <search>`. | Mirrors `/o`. Single-letter follows convention. |
| Errors inline or banner? | Inline row in modal. | Modal stays open for retry; less surface than a banner system. |
| Cap-exceeded quick-list? | No. | Defer until cap actually bites in practice. |
| Unpublish rotates URL — surface to user? | Yes — confirmation copy. | Avoid the "I unpublished to fix typo, now my URL is gone" surprise. |
| Copy feedback? | Button morphs to green ✓ for ~1.2 s. | No toast system; in-place feedback matches existing Copy patterns. |
| Loading state in flight? | Spinner on the action button; modal undismissible via backdrop. | 10 MB cap; typical publish is sub-second. No progress bar. |

---

## Implementation sequence (for the plan that follows)

This spec is single-PR-able. Suggested task ordering inside that PR:

1. **Wire format extension.** Extend `Artifact` interface in `shared/types.ts` with `publication?: ArtefactPublication | null`. Update `routes/artifacts.ts` (or wherever the artefact wire format is built) to render the nested object from snake_case columns. Add `shareUrl` rendering helper.
2. **SSE event.** Add `artifact_changed` broadcast at the call sites in `routes/publish.ts` and `mcp-server.ts`. Extend the App's SSE listener to refetch artefacts on `artifact_changed`.
3. **`publishApi` data layer.** New `web/src/data/publish-api.ts` with `publishArtifact` and `unpublishArtifact`.
4. **`useCopyLink` hook.** Shared between chip and modal.
5. **Sign-in polling hook.** Extract from `AuthBadge.tsx` if not already shared, or import directly. Settle naming.
6. **`PublishedChip` component.** Renders below the artefact label. Mode-tinted. Copy-link icon with click handler.
7. **`PublishModal` component.** Five state branches (unpublished / signed-out / in-flight / published / error). Reuses `ConfirmModal` for the unpublish-confirm overlay.
8. **`ArtifactIcon.tsx` integration.** Mount `PublishedChip` after the label.
9. **`Desktop.tsx` integration.** Add "Publish…" / "Manage publication…" entry to the artefact context menu, gated on builtin / plugin / generating / archived. Wire to `App.tsx`'s modal opener.
10. **`ViewerWindow.tsx` integration.** Add Share button to header. Same gating, same opener.
11. **`ChatBar.tsx` integration.** Add `/p` to `SLASH_COMMANDS`, add scoring branch with builtin/plugin/generating filter, wire to `App.tsx`'s modal opener.
12. **`App.tsx` glue.** Mount `PublishModal` at the App-shell level (sibling to `InspectorPanel`); thread `onArtifactPublish` prop through `ChatBar`, `Desktop`, and `ViewerWindow`.
13. **Tests.** Unit tests for chip, modal state transitions, slash filter, wire mapper. Integration tests for SSE emission. Manual smoke against deployed Worker post-merge.
14. **CHANGELOG.** Single entry under Added: short user-visible bullet ("Publish artefacts directly from the surface — right-click a tile, hit /p, or use the Share button in the viewer.").

Anchors:

- `web/src/components/ConfirmModal.tsx` and `PromptModal.tsx` — modal chrome and Esc/backdrop behaviour to match.
- `web/src/components/AuthBadge.tsx` — sign-in device flow to reuse.
- `web/src/components/Desktop.tsx` — context-menu pattern to extend.
- `web/src/components/ChatBar.tsx` — slash command pattern (`/o`) to mirror.
- `web/src/components/ArtifactIcon.tsx` — tile structure where the chip mounts.
- `web/src/components/ViewerWindow.tsx` — header structure where Share button mounts.
- `server/src/publish-service.ts` and `routes/publish.ts` — already shipped; no behaviour change here, only the SSE broadcast at the call site.

---

## Anchor docs

- [`docs/superpowers/specs/2026-05-03-r5-publish-backend-design.md`](./2026-05-03-r5-publish-backend-design.md) — backend that produces the bytes this UI reaches.
- [`docs/superpowers/specs/2026-05-03-r5-viewer-design.md`](./2026-05-03-r5-viewer-design.md) — viewer chrome and access enforcement on the cloud side.
- [`docs/requirements/oyster-cloud.md`](../../requirements/oyster-cloud.md) — R5 canonical requirement.
- [`docs/plans/roadmap.md`](../../plans/roadmap.md) — 0.7.0 milestone scope.
- Issue #317.
