// Shared fetch helpers. Every data module used to roll its own
// error decoder (`throwFromResponse` / `readErr` / inline shapes); now
// they share one. The server's mutation endpoints return `{error: "…"}`
// on failure — ApiError surfaces that string so UI alert()s show
// something actionable instead of `HTTP 400`.

export class ApiError extends Error {
  status: number;
  /** Decoded JSON response body when the server returned one. Callers that
   *  need structured error payloads (e.g. would_consolidate on a 409
   *  source-rename collision) check `body` rather than parsing the
   *  message string. Undefined when the body wasn't valid JSON. */
  body?: unknown;
  constructor(status: number, message: string, body?: unknown) {
    super(message);
    this.status = status;
    this.name = "ApiError";
    this.body = body;
  }
}

// Default timeout for mutation calls (POST/PATCH/DELETE). 15s is a safe
// global ceiling — long enough for legitimate slow paths (archiveGroup
// rewriting many artifacts, convertFolderToSpace re-attribution,
// createMemory with embedding/dedupe on a slower machine or larger
// workspace) without being so tight that a request that actually
// completed server-side gets reported as a failure to the user.
// Call sites with known sub-second budgets can pass a tighter
// `timeoutMs` override; call sites that legitimately need longer can
// pass a higher one. Hitting the default ceiling should be rare and
// indicate a dead socket or genuinely stuck server.
const DEFAULT_MUTATION_TIMEOUT_MS = 15_000;

interface MutateOpts {
  signal?: AbortSignal;
  timeoutMs?: number;
}

// Wrap a fetch-driven mutation with an AbortController-backed timeout and
// caller-signal composition. Centralises:
//   - timer setup + cleanup,
//   - caller `abort` listener registration AND cleanup (no leak — see below),
//   - TimeoutError → ApiError mapping (so the UI sees a friendly message).
//
// Leak note: the previous version added a `{ once: true }` listener to the
// caller's signal and never removed it on settle. For a long-lived caller
// signal that drives many short requests (e.g. a component-lifetime
// AbortController), every completed call accumulated a dead listener until
// the outer signal aborted or was GC'd. The `finally` here explicitly
// removes the listener, killing the slow leak.
async function runWithTimeout<T>(opts: MutateOpts, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_MUTATION_TIMEOUT_MS;
  const ctrl = new AbortController();
  let onCallerAbort: (() => void) | null = null;
  const caller = opts.signal;

  if (caller) {
    if (caller.aborted) {
      ctrl.abort(caller.reason);
    } else {
      onCallerAbort = () => ctrl.abort(caller.reason);
      caller.addEventListener("abort", onCallerAbort);
    }
  }

  const timer = setTimeout(
    () => ctrl.abort(new DOMException(`Request timed out after ${timeoutMs}ms`, "TimeoutError")),
    timeoutMs,
  );

  try {
    return await run(ctrl.signal);
  } catch (err) {
    if (err instanceof DOMException && err.name === "TimeoutError") {
      throw new ApiError(0, `Request timed out after ${timeoutMs}ms — server may be busy or unreachable.`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
    if (onCallerAbort && caller) caller.removeEventListener("abort", onCallerAbort);
  }
}

async function decodeError(res: Response): Promise<ApiError> {
  let message = `HTTP ${res.status}`;
  let body: unknown;
  try {
    body = await res.json();
    if (body && typeof (body as { error?: unknown }).error === "string") {
      message = (body as { error: string }).error;
    }
  } catch { /* not JSON */ }
  return new ApiError(res.status, message, body);
}

export async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, { signal });
  if (!res.ok) throw await decodeError(res);
  return res.json() as Promise<T>;
}

export async function postJson<T>(
  url: string,
  body?: unknown,
  opts?: MutateOpts,
): Promise<T> {
  return runWithTimeout(opts ?? {}, async (signal) => {
    const init: RequestInit = { method: "POST", signal };
    if (body !== undefined) {
      init.headers = { "Content-Type": "application/json" };
      init.body = JSON.stringify(body);
    }
    const res = await fetch(url, init);
    if (!res.ok) throw await decodeError(res);
    return await res.json() as T;
  });
}

export async function patchJson<T>(
  url: string,
  body: unknown,
  opts?: MutateOpts,
): Promise<T> {
  return runWithTimeout(opts ?? {}, async (signal) => {
    const res = await fetch(url, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) throw await decodeError(res);
    return await res.json() as T;
  });
}

/** POST whose response body the caller doesn't need (e.g. archive/restore
 *  endpoints — the server may return JSON status, but it's discarded here).
 *  Throws ApiError on non-2xx; resolves to void otherwise. */
export async function postEmpty(
  url: string,
  body?: unknown,
  opts?: MutateOpts,
): Promise<void> {
  return runWithTimeout(opts ?? {}, async (signal) => {
    const init: RequestInit = { method: "POST", signal };
    if (body !== undefined) {
      init.headers = { "Content-Type": "application/json" };
      init.body = JSON.stringify(body);
    }
    const res = await fetch(url, init);
    if (!res.ok) throw await decodeError(res);
  });
}

/** DELETE, optionally with a JSON body (deleteSpace passes folderName).
 *  Throws ApiError on non-2xx; resolves to void otherwise. */
export async function del(
  url: string,
  body?: unknown,
  opts?: MutateOpts,
): Promise<void> {
  return runWithTimeout(opts ?? {}, async (signal) => {
    const init: RequestInit = { method: "DELETE", signal };
    if (body !== undefined) {
      init.headers = { "Content-Type": "application/json" };
      init.body = JSON.stringify(body);
    }
    const res = await fetch(url, init);
    if (!res.ok) throw await decodeError(res);
  });
}
