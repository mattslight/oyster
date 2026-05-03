-- 0004_return_path.sql — generic post-sign-in redirect for #316.
-- Spec: docs/superpowers/specs/2026-05-03-r5-viewer-design.md
-- Both columns are nullable; existing rows get NULL, current handlers
-- ignore the column. Wrapped in idempotent ALTERs so re-running the
-- migration on a partially-applied DB doesn't fail.

ALTER TABLE magic_link_tokens ADD COLUMN return_path TEXT;
ALTER TABLE oauth_states     ADD COLUMN return_path TEXT;
