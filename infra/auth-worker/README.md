# Oyster auth worker

Cloudflare Worker that handles magic-link sign-in for the free Oyster account, plus the device-flow bridge that lets the local server at `localhost:4444` see the signed-in state. Design: [`docs/plans/auth.md`](../../docs/plans/auth.md).

```
GET  /auth/sign-in        HTML form (browser entry point)
POST /auth/magic-link     {email, user_code?} → email a sign-in link
GET  /auth/verify?t=...   consume token, set session cookie, redirect to /auth/welcome
GET  /auth/welcome        landing page after verify (shows the signed-in email)
GET  /auth/whoami         {id, email} for a valid session, 401 otherwise
```

PR 3 will add `/auth/device-init`, `/auth/device/<code>`, `/auth/sign-out`, and the local-server bridge that writes `~/Oyster/config/auth.json`.

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

### 3. Run the schema migration

The D1 database (`oyster-auth`) is already provisioned and its `database_id` is committed in `wrangler.toml`.

```bash
npm run db:migrate
```

Applies `migrations/0001_init.sql` — creates `users`, `sessions`, `device_codes`, `magic_link_tokens`. Re-running is safe (every `CREATE TABLE` and `CREATE INDEX` has `IF NOT EXISTS`).

### 4. Resend domain verification

The waitlist worker already uses Resend with `oyster.to` verified. The auth worker reuses the verified domain but sends from `noreply@oyster.to` rather than `matt@oyster.to`. If your Resend account already has `oyster.to` verified you can skip straight to the API key step.

1. Sign in at https://resend.com.
2. Domains → confirm `oyster.to` is verified (green tick on MX/SPF/DKIM rows).
3. API Keys → Create → name it `oyster-auth-worker`. Copy the key.

### 5. Set the Resend secret

```bash
npx wrangler secret put RESEND_API_KEY
```

Paste the key when prompted.

### 6. Deploy

```bash
npm run deploy
```

Worker is now live at `https://oyster.to/auth/*`. The per-IP rate-limit binding is provisioned automatically on deploy from the `[[unsafe.bindings]]` block in `wrangler.toml` — no separate command needed.

### 7. Smoke test the full flow

In a browser, open `https://oyster.to/auth/sign-in`. Enter your email. The form should report "Check your inbox". Click the link in the email. You should land on `/auth/welcome` with `Signed in as <your email>`.

Then verify the cookie set:

```bash
# Pull the cookie out of your browser dev tools (oyster_session=...) and:
curl -i https://oyster.to/auth/whoami -H "cookie: oyster_session=<paste>"
# → HTTP/2 200
# → {"id":"...","email":"..."}
```

Without a cookie:

```bash
curl -i https://oyster.to/auth/whoami
# → HTTP/2 401
# → {"error":"unauthenticated"}
```

## Day-to-day

```bash
npm run typecheck   # tsc --noEmit
npm run dev         # local Worker on localhost:8787 with a local D1
npm run tail        # stream Worker logs from production
```

`wrangler dev` won't actually send email unless `RESEND_API_KEY` is in `.dev.vars`; absent that the Worker logs the failure but still returns `{ ok: true }` so the rest of the flow is testable. To exercise sending locally, drop the key into `infra/auth-worker/.dev.vars` (gitignored).

## Local development

```bash
npm run db:migrate:local   # one-time, creates a local D1
npm run dev                # runs the Worker on localhost:8787
# Open http://localhost:8787/auth/sign-in
```

## Cost (as of 2026)

| Service | Free tier | Paid |
|---|---|---|
| Workers | 100k req/day | $5/mo if exceeded |
| D1 | 5 GB · 5M reads/day · 100k writes/day | Far past realistic free-tier sign-in |
| Workers Rate Limiting | 1k req/s default | Free at this scale |
| Resend | 3,000 emails/mo · 100/day | $20/mo for 50k |
