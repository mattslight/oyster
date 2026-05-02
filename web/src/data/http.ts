// Shared fetch helpers. Every data module used to roll its own
// error decoder (`throwFromResponse` / `readErr` / inline shapes); now
// they share one. The server's mutation endpoints return `{error: "…"}`
// on failure — ApiError surfaces that string so UI alert()s show
// something actionable instead of `HTTP 400`.

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "ApiError";
  }
}

async function decodeError(res: Response): Promise<ApiError> {
  let message = `HTTP ${res.status}`;
  try {
    const body = await res.json() as { error?: string } | null;
    if (body && typeof body.error === "string") message = body.error;
  } catch { /* not JSON */ }
  return new ApiError(res.status, message);
}

export async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, { signal });
  if (!res.ok) throw await decodeError(res);
  return res.json() as Promise<T>;
}

export async function postJson<T>(
  url: string,
  body?: unknown,
  opts?: { signal?: AbortSignal },
): Promise<T> {
  const init: RequestInit = { method: "POST", signal: opts?.signal };
  if (body !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }
  const res = await fetch(url, init);
  if (!res.ok) throw await decodeError(res);
  return res.json() as Promise<T>;
}

export async function patchJson<T>(
  url: string,
  body: unknown,
  opts?: { signal?: AbortSignal },
): Promise<T> {
  const res = await fetch(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: opts?.signal,
  });
  if (!res.ok) throw await decodeError(res);
  return res.json() as Promise<T>;
}

/** POST whose response body the caller doesn't need (e.g. archive/restore
 *  endpoints — the server may return JSON status, but it's discarded here).
 *  Throws ApiError on non-2xx; resolves to void otherwise. */
export async function postEmpty(
  url: string,
  body?: unknown,
  opts?: { signal?: AbortSignal },
): Promise<void> {
  const init: RequestInit = { method: "POST", signal: opts?.signal };
  if (body !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }
  const res = await fetch(url, init);
  if (!res.ok) throw await decodeError(res);
}

/** DELETE, optionally with a JSON body (deleteSpace passes folderName).
 *  Throws ApiError on non-2xx; resolves to void otherwise. */
export async function del(
  url: string,
  body?: unknown,
  opts?: { signal?: AbortSignal },
): Promise<void> {
  const init: RequestInit = { method: "DELETE", signal: opts?.signal };
  if (body !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }
  const res = await fetch(url, init);
  if (!res.ok) throw await decodeError(res);
}
