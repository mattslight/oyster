// Env interface for the oyster-publish Worker.
// Bindings declared in wrangler.toml.

export interface Env {
  DB: D1Database;          // shared with oyster-auth (same database_id)
  ARTIFACTS: R2Bucket;     // oyster-artifacts
  VIEWER_COOKIE_SECRET: string;     // HMAC key for password-mode unlock cookies (#316)
  VIEWER_PASSWORD_LIMIT: RateLimit; // wrong-password gate (#316)
}

// `RateLimit` is a Workers binding — typed inline since it's not in
// @cloudflare/workers-types yet. The runtime shape is:
//   limit({ key: string }) → Promise<{ success: boolean }>
interface RateLimit {
  limit(opts: { key: string }): Promise<{ success: boolean }>;
}

// Decoded X-Publish-Metadata payload — produced by the local server.
export interface PublishMetadata {
  artifact_id: string;
  artifact_kind: string;
  mode: "open" | "password" | "signin";
  password_hash?: string;  // present iff mode === 'password'
}

// Row shape for published_artifacts.
export interface PublicationRow {
  share_token: string;
  owner_user_id: string;
  artifact_id: string;
  artifact_kind: string;
  mode: "open" | "password" | "signin";
  password_hash: string | null;
  r2_key: string;
  content_type: string;
  size_bytes: number;
  published_at: number;
  updated_at: number;
  unpublished_at: number | null;
}
