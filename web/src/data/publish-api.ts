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

// Unpublish a cloud-only ghost (no local artefact row). Routes by share_token
// so it works on devices that never had the artefact locally — pick any
// device, retire any of your live publications.
export async function unpublishCloudShare(shareToken: string): Promise<UnpublishResponse> {
  const res = await fetch(`/api/publish/by-token/${encodeURIComponent(shareToken)}/unpublish`, {
    method: "POST",
  });
  if (!res.ok) {
    const json = (await res.json().catch(() => ({}))) as PublishErrorBody;
    const code = json.error ?? "unknown_error";
    const { error: _e, message: _m, ...details } = json;
    throw new PublishApiError(res.status, code, json.message ?? code, details);
  }
  return (await res.json()) as UnpublishResponse;
}

/** Result of a successful share update (mode / password change without re-upload). */
export interface UpdateShareResponse {
  share_token: string;
  share_url: string;
  mode: "open" | "password" | "signin";
  updated_at: number;
}

// Change mode + password on an existing publication without re-uploading
// bytes. Required for cloud-only ghosts; also works for locally-backed
// publications (cheaper than the full re-upload path when bytes haven't
// changed). `label` is optional — pass it when renaming.
export async function updateCloudShare(
  shareToken: string,
  mode: "open" | "password" | "signin",
  password?: string,
  label?: string,
): Promise<UpdateShareResponse> {
  const res = await fetch(`/api/publish/by-token/${encodeURIComponent(shareToken)}/update`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      mode,
      ...(password !== undefined ? { password } : {}),
      ...(label !== undefined ? { label } : {}),
    }),
  });
  if (!res.ok) {
    const json = (await res.json().catch(() => ({}))) as PublishErrorBody;
    const code = json.error ?? "unknown_error";
    const { error: _e, message: _m, ...details } = json;
    throw new PublishApiError(res.status, code, json.message ?? code, details);
  }
  return (await res.json()) as UpdateShareResponse;
}
