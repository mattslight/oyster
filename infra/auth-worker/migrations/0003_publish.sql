-- 0003_publish.sql — R5 Publish: tier hook on users + published_artifacts table.
-- Spec: docs/superpowers/specs/2026-05-03-r5-publish-backend-design.md
-- D1 supports ALTER TABLE ADD COLUMN; both bindings (oyster-auth + oyster-publish)
-- read/write this DB.

-- Tier hook for entitlement checks. Always 'free' in 0.7.0; Pro values land in 0.8.0+.
ALTER TABLE users ADD COLUMN tier TEXT NOT NULL DEFAULT 'free';

CREATE TABLE published_artifacts (
  share_token       TEXT    PRIMARY KEY,
  owner_user_id     TEXT    NOT NULL REFERENCES users(id),
  artifact_id       TEXT    NOT NULL,
  artifact_kind     TEXT    NOT NULL,
  mode              TEXT    NOT NULL CHECK (mode IN ('open','password','signin')),
  password_hash     TEXT,
  r2_key            TEXT    NOT NULL,
  content_type      TEXT    NOT NULL,
  size_bytes        INTEGER NOT NULL,
  published_at      INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  unpublished_at    INTEGER,
  CHECK (
    (mode = 'password' AND password_hash IS NOT NULL) OR
    (mode <> 'password' AND password_hash IS NULL)
  )
);

CREATE INDEX idx_pubart_owner ON published_artifacts(owner_user_id);

-- Active-publication uniqueness scoped to (owner, artefact). artifact_id alone
-- is not globally unique across users.
CREATE UNIQUE INDEX idx_pubart_active_per_owner_artifact
  ON published_artifacts(owner_user_id, artifact_id)
  WHERE unpublished_at IS NULL;
