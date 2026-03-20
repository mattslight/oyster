# Move registry.json to Userland — Superseded

> This plan was superseded during implementation. The initial approach (move JSON file to userland) was replaced with a SQLite-backed artifact store after architectural review.

## What was implemented instead

- `server/registry.json` replaced with SQLite database at `userland/oyster.db`
- Three-layer architecture: `db.ts` → `artifact-store.ts` → `artifact-service.ts`
- Data model separates storage (where content lives) from runtime (how Oyster opens it)
- Wire type evolved: `label`, `artifactKind`, `spaceId`, `url`, `runtimeKind`, `runtimeConfig`
- One-time migration: `cd server && npx tsx scripts/migrate-registry.ts`

See PR #28 for full details.
