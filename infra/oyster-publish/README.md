# oyster-publish Worker

Cloudflare Worker for R5 publish (#315 spec):
- `POST /api/publish/upload` — server-to-server upload from the local Oyster server.
- `DELETE /api/publish/:share_token` — retire a publication.
- `GET /p/:share_token` — public viewer (501 here; body lands in #316).

Spec: [`docs/superpowers/specs/2026-05-03-r5-publish-backend-design.md`](../../docs/superpowers/specs/2026-05-03-r5-publish-backend-design.md).

## Setup (one-time)

```bash
# 1. Apply the D1 migration (creates published_artifacts in the shared
#    oyster-auth DB, adds users.tier).
cd infra/auth-worker
npm run db:migrate:0003

# 2. Provision the R2 bucket.
wrangler r2 bucket create oyster-artifacts
```

## Deploy

```bash
cd infra/oyster-publish
npm install
npm run deploy
```

## Local dev

```bash
npm run dev   # runs wrangler dev with miniflare D1 + R2 in-memory
npm test      # vitest with @cloudflare/vitest-pool-workers
```

## Notes

- Bindings: `DB` (shared with oyster-auth), `ARTIFACTS` (R2 bucket `oyster-artifacts`).
- No secrets: nothing in `wrangler secret put`. Sessions are validated by reading the
  shared `sessions` table.
- R2 key shape: `published/{owner_user_id}/{share_token}`.
