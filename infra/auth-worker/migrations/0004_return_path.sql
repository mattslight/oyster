-- 0004_return_path.sql — generic post-sign-in redirect for #316.
-- Spec: docs/superpowers/specs/2026-05-03-r5-viewer-design.md
-- Both columns are nullable; existing rows get NULL, current handlers
-- ignore the column. Run once per environment via npm run db:migrate:0004
-- (or :local). Rerun fails with 'duplicate column name' — that's the
-- expected SQLite behaviour for ADD COLUMN; matches 0001-0003 convention.

ALTER TABLE magic_link_tokens ADD COLUMN return_path TEXT;
ALTER TABLE oauth_states     ADD COLUMN return_path TEXT;
