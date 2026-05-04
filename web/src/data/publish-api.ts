/** Result of a successful publish. Mirrors PublishResult from server/src/publish-service.ts. */
export interface PublishResponse {
  share_token: string;
  share_url: string;
  mode: "open" | "password" | "signin";
  published_at: number;
  updated_at: number;
}

/** Result of a successful unpublish. */
export interface UnpublishResponse {
  ok: true;
  share_token: string;
  unpublished_at: number;
}

/** Server error envelope. The server proxies this verbatim from the Worker. */
export interface PublishErrorBody {
  error: string;
  message?: string;
  [key: string]: unknown;
}

export class PublishApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Record<string, unknown>;

  constructor(
    status: number,
    code: string,
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "PublishApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

async function send<T>(
  method: "POST" | "DELETE",
  artifactId: string,
  body?: { mode: string; password?: string },
): Promise<T> {
  const res = await fetch(`/api/artifacts/${encodeURIComponent(artifactId)}/publish`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const json = (await res.json().catch(() => ({}))) as PublishErrorBody;
    const code = json.error ?? "unknown_error";
    const { error: _e, message: _m, ...details } = json;
    throw new PublishApiError(res.status, code, json.message ?? code, details);
  }
  return (await res.json()) as T;
}

export function publishArtifact(
  artifactId: string,
  mode: "open" | "password",
  password?: string,
): Promise<PublishResponse> {
  return send<PublishResponse>("POST", artifactId, { mode, password });
}

export function unpublishArtifact(artifactId: string): Promise<UnpublishResponse> {
  return send<UnpublishResponse>("DELETE", artifactId);
}
