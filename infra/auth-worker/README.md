# Oyster auth worker

Cloudflare Worker that handles magic-link sign-in for the free Oyster account, plus the device-flow bridge that lets the local server at `localhost:4444` see the signed-in state. Design: [`docs/plans/auth.md`](../../docs/plans/auth.md).

PR 1 scaffold — only `GET /auth/whoami` is wired (returns 401). Magic-link send/verify and the device-flow endpoints land in PR 2 + PR 3.

```
GET /auth/whoami
→ 401 { "error": "unauthenticated" }
```

## One-time setup

Done in your terminal from inside `infra/auth-worker/`.

### 1. Install deps

```bash
npm install
```

### 2. Cloudflare auth

```bash
npx wrangler login
```

Opens a browser to authorise the CLI against your CF account. Same login the waitlist worker uses — already done if you've deployed that.

### 3. Create the D1 database

```bash
npx wrangler d1 create oyster-auth
```

Output looks like:

```
✅ Successfully created DB 'oyster-auth'
[[d1_databases]]
binding = "DB"
database_name = "oyster-auth"
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

Copy the `database_id` into `wrangler.toml` (replace `REPLACE_WITH_D1_ID`).

### 4. Run the schema migration

```bash
npm run db:migrate
```

Applies `migrations/0001_init.sql` — creates `users`, `sessions`, `device_codes`, `magic_link_tokens`. Re-running is safe (every `CREATE TABLE` and `CREATE INDEX` has `IF NOT EXISTS`).

### 5. Deploy

```bash
npm run deploy
```

Worker is now live at `https://oyster.to/auth/*`.

### 6. Smoke test

```bash
curl -i https://oyster.to/auth/whoami
# → HTTP/2 401
# → content-type: application/json
# → {"error":"unauthenticated"}
```

That's all PR 1 verifies. PR 2 will add `/auth/magic-link` + `/auth/verify` and the Resend secret + per-IP rate-limit binding; PR 3 will add the device-flow endpoints + sign-out + the local-server bridge.

## Day-to-day

```bash
npm run typecheck   # tsc --noEmit
npm run dev         # local Worker on localhost:8787 with a local D1
npm run tail        # stream Worker logs from production
```

## Local development

```bash
npm run db:migrate:local   # one-time, creates a local D1
npm run dev                # runs the Worker on localhost:8787
curl -i http://localhost:8787/auth/whoami  # expect 401
```

## Cost (as of 2026)

| Service | Free tier | Paid |
|---|---|---|
| Workers | 100k req/day | $5/mo if exceeded |
| D1 | 5 GB · 5M reads/day · 100k writes/day | Far past realistic free-tier sign-in |
