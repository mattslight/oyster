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

// Default timeout for mutation calls (POST/PATCH/DELETE). The local server's
// add-source / scan flow can take a couple of seconds on a big repo, but a
// minute is way over any healthy ceiling — if we hit this, something has
// stalled and the UI needs to recover rather than locking out future attempts.
const DEFAULT_MUTATION_TIMEOUT_MS = 30_000;

// Compose a caller-supplied AbortSignal with a timer. Returns the signal to
// pass to fetch + a cleanup that clears the timer (call on settle).
function signalWithTimeout(signal: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; clear: () => void } {
  const ctrl = new AbortController();
  if (signal) {
    if (signal.aborted) ctrl.abort(signal.reason);
    else signal.addEventListener("abort", () => ctrl.abort(signal.reason), { once: true });
  }
  const timer = setTimeout(() => ctrl.abort(new DOMException(`Request timed out after ${timeoutMs}ms`, "TimeoutError")), timeoutMs);
  return { signal: ctrl.signal, clear: () => clearTimeout(timer) };
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
  opts?: { signal?: AbortSignal; timeoutMs?: number },
): Promise<T> {
  const { signal, clear } = signalWithTimeout(opts?.signal, opts?.timeoutMs ?? DEFAULT_MUTATION_TIMEOUT_MS);
  const init: RequestInit = { method: "POST", signal };
  if (body !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }
  try {
    const res = await fetch(url, init);
    if (!res.ok) throw await decodeError(res);
    return await res.json() as T;
  } catch (err) {
    if (err instanceof DOMException && err.name === "TimeoutError") {
      throw new ApiError(0, `Request timed out (${opts?.timeoutMs ?? DEFAULT_MUTATION_TIMEOUT_MS}ms) — server may be busy or unreachable.`);
    }
    throw err;
  } finally {
    clear();
  }
}

export async function patchJson<T>(
  url: string,
  body: unknown,
  opts?: { signal?: AbortSignal; timeoutMs?: number },
): Promise<T> {
  const { signal, clear } = signalWithTimeout(opts?.signal, opts?.timeoutMs ?? DEFAULT_MUTATION_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) throw await decodeError(res);
    return await res.json() as T;
  } catch (err) {
    if (err instanceof DOMException && err.name === "TimeoutError") {
      throw new ApiError(0, `Request timed out (${opts?.timeoutMs ?? DEFAULT_MUTATION_TIMEOUT_MS}ms) — server may be busy or unreachable.`);
    }
    throw err;
  } finally {
    clear();
  }
}

/** POST whose response body the caller doesn't need (e.g. archive/restore
 *  endpoints — the server may return JSON status, but it's discarded here).
 *  Throws ApiError on non-2xx; resolves to void otherwise. */
export async function postEmpty(
  url: string,
  body?: unknown,
  opts?: { signal?: AbortSignal; timeoutMs?: number },
): Promise<void> {
  const { signal, clear } = signalWithTimeout(opts?.signal, opts?.timeoutMs ?? DEFAULT_MUTATION_TIMEOUT_MS);
  const init: RequestInit = { method: "POST", signal };
  if (body !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }
  try {
    const res = await fetch(url, init);
    if (!res.ok) throw await decodeError(res);
  } catch (err) {
    if (err instanceof DOMException && err.name === "TimeoutError") {
      throw new ApiError(0, `Request timed out (${opts?.timeoutMs ?? DEFAULT_MUTATION_TIMEOUT_MS}ms) — server may be busy or unreachable.`);
    }
    throw err;
  } finally {
    clear();
  }
}

/** DELETE, optionally with a JSON body (deleteSpace passes folderName).
 *  Throws ApiError on non-2xx; resolves to void otherwise. */
export async function del(
  url: string,
  body?: unknown,
  opts?: { signal?: AbortSignal; timeoutMs?: number },
): Promise<void> {
  const { signal, clear } = signalWithTimeout(opts?.signal, opts?.timeoutMs ?? DEFAULT_MUTATION_TIMEOUT_MS);
  const init: RequestInit = { method: "DELETE", signal };
  if (body !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }
  try {
    const res = await fetch(url, init);
    if (!res.ok) throw await decodeError(res);
  } catch (err) {
    if (err instanceof DOMException && err.name === "TimeoutError") {
      throw new ApiError(0, `Request timed out (${opts?.timeoutMs ?? DEFAULT_MUTATION_TIMEOUT_MS}ms) — server may be busy or unreachable.`);
    }
    throw err;
  } finally {
    clear();
  }
}
