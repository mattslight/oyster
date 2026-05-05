-- 0005_publish_context.sql — carry space_id + label with each publication so
-- the surface on a fresh device knows what a publication is and where it came
-- from, without needing the local artefact row to exist (R5 hardening, 0.7.0).
--
-- Backfilling existing rows: not done here. Older publications surface as
-- ghosts with label = artifact_id (UUID-ish for AI-generated artefacts) and
-- space "Cloud". Re-publish refreshes the row.

ALTER TABLE published_artifacts ADD COLUMN label TEXT;
ALTER TABLE published_artifacts ADD COLUMN space_id TEXT;
