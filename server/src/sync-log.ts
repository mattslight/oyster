// Shared helpers for sync error logging. Two purposes:
//
//   1. Format known transient network errors as a one-line summary
//      (`cloud unreachable (ENOTFOUND)`) instead of a 30-line stack trace.
//      A laptop that loses wifi triggers a DNS failure every reconcile
//      cycle; the raw error spammed the terminal.
//
//   2. Dedupe repeated failures with createOfflineLogger: log once on
//      first failure, suppress identical follow-ups, log every Nth as a
//      heartbeat so the user can see "still offline, attempt 30", and log
//      "back online" the first time a success follows a failure streak.
//
// Used by session-sync-service and memory-sync-service for their pull /
// push error handlers. Push paths that involve chunk uploads (sessions
// pushBytes) get their own logger so a long upload stream of network
// errors collapses to a single line instead of one per chunk attempt.

/** Codes Node + undici raise when the cloud is unreachable for the obvious
 *  reasons: DNS down (wifi off), TCP can't connect, peer reset, timeout.
 *  Distinguished from non-network errors (4xx/5xx responses, malformed
 *  JSON, code bugs) which we still want to surface with a real trace. */
const NETWORK_ERR_CODES = new Set([
  "ENOTFOUND",            // DNS resolution failed (wifi off, captive portal)
  "EAI_AGAIN",            // DNS temporary failure
  "ECONNREFUSED",         // peer rejected
  "ECONNRESET",           // peer dropped mid-stream
  "ENETUNREACH",          // no route to network
  "ETIMEDOUT",            // socket timeout
  "UND_ERR_CONNECT_TIMEOUT", // undici-specific: TCP connect timeout
  "UND_ERR_SOCKET",       // undici-specific: socket error
]);

/** Format an error for logging. For known transient network errors,
 *  return a concise one-liner naming the code. For everything else, fall
 *  through to the full message (callers can still console.warn with the
 *  raw err object for a stack trace on real bugs). */
export function formatSyncError(err: unknown): string {
  if (!err) return "unknown error";
  const e = err as {
    code?: string;
    message?: string;
    cause?: { code?: string; message?: string };
  };
  const code = e.cause?.code ?? e.code;
  if (code && NETWORK_ERR_CODES.has(code)) {
    return `cloud unreachable (${code})`;
  }
  if (e.cause?.message && e.message) {
    return `${e.message}: ${e.cause.message}`;
  }
  return e.message ?? String(err);
}

/** Return true when the error is a known transient network failure. */
export function isOfflineLikeError(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } } | null;
  const code = e?.cause?.code ?? e?.code;
  return !!code && NETWORK_ERR_CODES.has(code);
}

export interface OfflineLogger {
  /** Call on a sync failure. Logs the first occurrence with a concise
   *  summary, suppresses subsequent ones, prints a "still offline,
   *  attempt N" heartbeat every `heartbeatEvery` failures. Non-offline
   *  errors are always logged (with `withStack`'s full err so debug
   *  context isn't lost). */
  failure(err: unknown): void;
  /** Call after a successful round-trip. Prints "back online" if this
   *  follows a failure streak; otherwise no-op. Resets the counter. */
  success(): void;
}

interface OfflineLoggerOptions {
  /** Log a heartbeat every N consecutive failures. Defaults to 30 —
   *  with a ~30 s reconcile cadence, that's roughly one line per
   *  15 minutes of continuous offline. */
  heartbeatEvery?: number;
}

/** Create a dedupe-aware logger for a single sync operation. Holds a
 *  consecutive-failures counter in closure; one logger per call-site so
 *  pull and push (and bytes-push and reassemble) all track independently. */
export function createOfflineLogger(
  prefix: string,
  options: OfflineLoggerOptions = {},
): OfflineLogger {
  const heartbeatEvery = options.heartbeatEvery ?? 30;
  let consecutive = 0;
  return {
    failure(err: unknown): void {
      if (!isOfflineLikeError(err)) {
        // Real error — log full so a stack/details survive. Don't touch
        // the consecutive counter so a transient cloud-side bug in the
        // middle of an offline streak doesn't reset our offline tracking.
        console.warn(`${prefix} failed:`, err);
        return;
      }
      consecutive++;
      if (consecutive === 1) {
        console.warn(`${prefix} ${formatSyncError(err)} (further offline retries suppressed)`);
      } else if (consecutive % heartbeatEvery === 0) {
        console.warn(`${prefix} still offline (${consecutive} attempts) — ${formatSyncError(err)}`);
      }
    },
    success(): void {
      if (consecutive > 0) {
        console.warn(`${prefix} back online (after ${consecutive} failed attempt${consecutive === 1 ? "" : "s"})`);
      }
      consecutive = 0;
    },
  };
}
