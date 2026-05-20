# oyster-arcade-site

Cloudflare Worker that serves the contents of `docs/arcade/` at
`arcade.oyster.to/*` via Workers Static Assets.

The worker entry point forwards most requests to the `ASSETS` binding,
with one carve-out: `/assets/*` (shared fonts + `crt.png`, owned by the
main oyster.to site at `docs/assets/`) is proxied through to
`https://oyster.to/assets/*` so we don't duplicate those files. The
assets directory is checked into git — no build step.

## Deploy

```sh
cd infra/oyster-arcade-site
npm install
npx wrangler deploy
```

First deploy will prompt Cloudflare to provision the `arcade.oyster.to`
DNS record automatically (Workers route binding handles it). After the
deploy, browse `https://arcade.oyster.to/` to verify.

## Local dev

```sh
npx wrangler dev
```

Serves at `http://localhost:8787/`. Note: `/api/leaderboard` requests
will go to the dev server too, not to the production worker — to test
the full flow you can either:

- Run `wrangler dev` in `infra/leaderboard-worker/` on a different port
  and reverse-proxy, or
- Point the platformer's leaderboard URL at `https://oyster.to` in dev
  by editing `docs/arcade/shared/leaderboard.js` temporarily.

For most arcade landing-page work the dev server alone is fine; the
leaderboard fetches degrade to the local mirror on failure.

## Why a worker (and not Pages)?

- One repo, one deploy story (`wrangler deploy`).
- Shares the same `oyster.to` zone as the existing workers.
- Easy to add intercept logic later (e.g. add cache headers, rewrite
  paths, gate on auth) without changing platforms.

Path B would have been Cloudflare Pages with `docs/arcade/` as the
build output. Equally valid; we chose Worker + Assets for monorepo
parity.
