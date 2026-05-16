# oyster-leaderboard-worker

Cloudflare Worker storing the Rocket Ship easter-egg leaderboard.

- `GET /api/leaderboard` → `{ list: [{ initials, score, created_at }, …] }` (top 10)
- `POST /api/leaderboard` body `{ initials, score }` → `{ ok: true, list: […] }`

Ranking: `score DESC, created_at ASC` — oldest wins ties (you held the slot first).

## First-time setup

```bash
cd infra/leaderboard-worker
npm install

# 1. Create the D1 database (remote — uses your Cloudflare account)
npx wrangler d1 create oyster-leaderboard
# Paste the returned database_id into wrangler.toml

# 2. Apply the schema
npm run db:migrate         # remote
npm run db:migrate:local   # local replica for `wrangler dev`

# 3. Deploy
npm run deploy
```

## Local UAT

```bash
npm run dev   # runs on http://localhost:8787

# read empty leaderboard
curl http://localhost:8787/api/leaderboard

# submit a score (must include an origin header that's whitelisted)
curl -X POST http://localhost:8787/api/leaderboard \
  -H 'content-type: application/json' \
  -H 'origin: http://localhost:8787' \
  -d '{"initials":"ABC","score":42}'
```

To test from the game iframe locally, the `LB_API` constant in `docs/rocket-ship.html` resolves to `/api/leaderboard` (same-origin). Either:

- Serve `docs/` through `wrangler dev` (Worker route + static asset) once configured, **or**
- Open the browser devtools console while the iframe is loaded and override:
  ```js
  window.__OYSTER_LB_API = 'http://localhost:8787/api/leaderboard'
  ```
  (Note: requires the iframe code to honour the override — not currently wired; deploy to production for end-to-end UAT.)

## Production routes

Worker is mounted at:

- `oyster.to/api/leaderboard`
- `www.oyster.to/api/leaderboard`

## Inspecting the live table

```bash
npm run db:dump    # prints the top 50 with human-readable dates
```
