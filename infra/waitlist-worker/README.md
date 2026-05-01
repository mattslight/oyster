# Oyster waitlist worker

Cloudflare Worker that collects email signups for the Oyster Pro waitlist, stores them in D1, and fires a confirmation email via Resend.

```
POST oyster.to/api/waitlist
Content-Type: application/json
{ "email": "you@example.com", "source": "pricing-page" }
→ 200 { "ok": true }
```

## One-time setup

Done in your terminal from inside `infra/waitlist-worker/`.

### 1. Install deps

```bash
npm install
```

### 2. Cloudflare auth

```bash
npx wrangler login
```

Opens a browser to authorise the CLI against your CF account.

### 3. Create the D1 database

```bash
npx wrangler d1 create oyster-waitlist
```

Output looks like:

```
✅ Successfully created DB 'oyster-waitlist'
[[d1_databases]]
binding = "DB"
database_name = "oyster-waitlist"
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

Copy the `database_id` into `wrangler.toml` (replace `REPLACE_WITH_D1_ID`).

### 4. Run the schema migration

```bash
npm run db:migrate
```

Creates the `waitlist` table on the remote D1.

### 5. Resend domain verification

1. Sign up at https://resend.com (free, no credit card)
2. Domains → Add Domain → enter `oyster.to`
3. Resend gives you 3 DNS records (MX, TXT for SPF, TXT for DKIM)
4. Add them in Cloudflare DNS (oyster.to zone). Resend's UI has a "Verify" button — click once you've added them.
5. Once verified, create an API key (Resend → API Keys → Create). Copy it.

### 6. Set the Resend secret

```bash
npx wrangler secret put RESEND_API_KEY
```

Paste the key when prompted.

### 7. Deploy

```bash
npm run deploy
```

Worker is now live at `https://oyster.to/api/waitlist`.

### 8. Smoke test

The Worker enforces an `Origin` check (`oyster.to` or `www.oyster.to` only). Pass it explicitly when testing with curl:

```bash
curl -X POST https://oyster.to/api/waitlist \
  -H "content-type: application/json" \
  -H "origin: https://oyster.to" \
  -d '{"email":"matt+test@oyster.to","source":"smoke-test"}'
```

Should return `{"ok":true}`. Check matt+test@oyster.to for the confirmation email.

Without the `origin` header you'll get `403 Forbidden` — that's the protection working.

```bash
npm run db:dump
```

Should list `matt+test@oyster.to`.

## Cloudflare rate limiting (recommended)

The Origin check stops casual abuse but a determined bot can still spoof headers. Add a CF rate-limiting rule so a single IP can't burn through Resend's 100/day free tier:

1. CF dashboard → select `oyster.to`
2. Sidebar → **Security** → **Security rules** (or **WAF** in older UI) → **Rate limiting rules**
3. **Create rule**:
   - Name: `waitlist-rate-limit`
   - **If incoming requests match**: `(http.request.uri.path eq "/api/waitlist")`
   - **Same characteristics**: IP source address
   - **Period**: 10 seconds
   - **Requests**: 3
   - **Then take action**: Block
   - **Duration**: 10 minutes
4. Deploy

Free plan includes 1 rate-limiting rule, which is exactly what we need.

This caps a single IP at 3 signup attempts per 10 seconds, then blocks for 10 minutes. Real users hit it once; bots get rejected fast.

## Day-to-day

```bash
npm run tail        # stream Worker logs
npm run db:dump     # CSV-ish dump of all signups
```

## At launch

Export the list:

```bash
npx wrangler d1 execute oyster-waitlist --remote \
  --command "SELECT email FROM waitlist ORDER BY joined_at" \
  --json > waitlist.json
```

Upload to Resend's Broadcasts UI, or use their API to send the launch announcement programmatically.

## Local development

```bash
npm run db:migrate:local   # one-time, creates a local D1
npm run dev                # runs the Worker on localhost:8787
```

POST to `http://localhost:8787/api/waitlist` to test without hitting prod.

## Cost (as of 2026)

| Service | Free tier | Paid |
|---|---|---|
| Workers | 100k req/day | $5/mo if exceeded |
| D1 | 5 GB · 5M reads/day · 100k writes/day | Far past realistic waitlist |
| Resend | 3,000 emails/mo · 100/day | $20/mo for 50k |

For a beta waitlist: $0/month until you broadcast a launch email to a few thousand subscribers.
