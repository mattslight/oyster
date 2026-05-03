// publish-service.ts — single source of truth for publish/unpublish.
// Called by both routes/publish.ts (HTTP) and mcp-server.ts (MCP tool).

import type Database from "better-sqlite3";

export interface PublishUser {
  id: string;
  email: string;
}

export interface PublishServiceDeps {
  db: Database.Database;
  readArtifactBytes: (artifactId: string) => Promise<Uint8Array>;
  currentUser: () => PublishUser | null;
  sessionToken: () => string | null;
  workerBase: string;        // e.g. "https://oyster.to"
  hashPassword: (plaintext: string) => Promise<string>;
  fetch: typeof fetch;
}

export interface PublishArgs {
  artifact_id: string;
  mode: "open" | "password" | "signin";
  password?: string;
}

export interface PublishResult {
  share_token: string;
  share_url: string;
  mode: "open" | "password" | "signin";
  published_at: number;
  updated_at: number;
}

export interface UnpublishResult {
  ok: true;
  share_token: string;
  unpublished_at: number;
}

export class PublishError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export interface PublishService {
  publishArtifact(args: PublishArgs): Promise<PublishResult>;
  unpublishArtifact(args: { artifact_id: string }): Promise<UnpublishResult>;
}

interface ArtifactRow {
  id: string;
  kind: string;
  owner_id: string | null;
  share_token: string | null;
  unpublished_at: number | null;
}

export function createPublishService(deps: PublishServiceDeps): PublishService {
  return {
    async publishArtifact(args) {
      const user = deps.currentUser();
      const token = deps.sessionToken();
      if (!user || !token) throw new PublishError(401, "sign_in_required", "Sign in to publish artefacts.");

      const row = deps.db.prepare(
        "SELECT id, kind, owner_id, share_token, unpublished_at FROM artifacts WHERE id = ?"
      ).get(args.artifact_id) as ArtifactRow | undefined;
      if (!row) throw new PublishError(404, "artifact_not_found", `No artefact with id ${args.artifact_id}`);

      if (row.owner_id !== null && row.owner_id !== user.id) {
        throw new PublishError(403, "not_artifact_owner", "This artefact belongs to a different account.");
      }

      if (args.mode === "password" && (!args.password || args.password.length === 0)) {
        throw new PublishError(400, "password_required", "Password mode requires a non-empty password.");
      }

      const passwordHash = args.mode === "password" ? await deps.hashPassword(args.password!) : undefined;
      const bytes = await deps.readArtifactBytes(args.artifact_id);

      const meta = {
        artifact_id: args.artifact_id,
        artifact_kind: row.kind,
        mode: args.mode,
        ...(passwordHash ? { password_hash: passwordHash } : {}),
      };
      const metaHeader = Buffer.from(JSON.stringify(meta)).toString("base64url");

      const res = await deps.fetch(`${deps.workerBase}/api/publish/upload`, {
        method: "POST",
        headers: {
          Cookie: `oyster_session=${token}`,
          "X-Publish-Metadata": metaHeader,
          "Content-Type": "application/octet-stream",
          "Content-Length": String(bytes.byteLength),
        },
        body: bytes,
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as Record<string, unknown>;
        const code = (typeof body.error === "string" ? body.error : "upload_failed");
        const { error: _e, message: _m, ...details } = body;
        throw new PublishError(res.status, code, (body.message as string) ?? code, details);
      }

      const result = await res.json() as PublishResult;

      // Mirror response into local SQLite. owner_id set on first publish.
      const ownerToSet = row.owner_id ?? user.id;
      deps.db.prepare(
        `UPDATE artifacts
            SET owner_id = ?, share_token = ?, share_mode = ?, share_password_hash = ?,
                published_at = ?, share_updated_at = ?, unpublished_at = NULL
          WHERE id = ?`
      ).run(
        ownerToSet, result.share_token, result.mode, passwordHash ?? null,
        result.published_at, result.updated_at, args.artifact_id,
      );

      return result;
    },

    async unpublishArtifact({ artifact_id }) {
      const user = deps.currentUser();
      const token = deps.sessionToken();
      if (!user || !token) throw new PublishError(401, "sign_in_required", "Sign in to unpublish artefacts.");

      const row = deps.db.prepare(
        "SELECT id, owner_id, share_token, unpublished_at FROM artifacts WHERE id = ?"
      ).get(artifact_id) as ArtifactRow | undefined;
      if (!row) throw new PublishError(404, "artifact_not_found");
      if (row.owner_id && row.owner_id !== user.id) {
        throw new PublishError(403, "not_publication_owner");
      }
      if (!row.share_token || row.unpublished_at !== null) {
        throw new PublishError(404, "publication_not_found");
      }

      const res = await deps.fetch(`${deps.workerBase}/api/publish/${row.share_token}`, {
        method: "DELETE",
        headers: { Cookie: `oyster_session=${token}` },
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as Record<string, unknown>;
        const code = (typeof body.error === "string" ? body.error : "unpublish_failed");
        throw new PublishError(res.status, code, (body.message as string) ?? code);
      }

      const result = await res.json() as UnpublishResult;
      deps.db.prepare(
        `UPDATE artifacts SET unpublished_at = ? WHERE id = ?`
      ).run(result.unpublished_at, artifact_id);

      return result;
    },
  };
}
