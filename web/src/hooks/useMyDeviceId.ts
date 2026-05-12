import { useEffect, useState } from "react";

// One-shot fetch of the local device identity. Used to distinguish "local"
// (this device produced it) from "remote" (another device produced it,
// pulled cross-device). The identity is stable across the server lifetime,
// so a single fetch per page load is enough — the module-level promise
// cache below ensures every consumer of this hook shares one request.

export interface DeviceIdentity {
  deviceId: string;
  label: string;
}

// Shared in-flight promise so concurrent mounts (Home + SessionInspector
// header etc.) reuse the same fetch rather than each firing its own.
// Cache strategy:
//   - 200 → stays cached for the page lifetime (identity never changes)
//   - any non-2xx (503 not-seeded, 4xx forbidden, 5xx) → cache cleared so
//     the next hook mount retries
//   - thrown error (network, abort) → cache cleared, retry on next mount
// The "retry on any failure" stance is intentional: a 503 is the
// not-seeded race, but a 403 from the rejectIfNonLocalOrigin guard would
// also benefit from a retry once the request comes from an expected
// origin (e.g. after dev/prod URL swap).
let pending: Promise<DeviceIdentity | null> | null = null;

async function fetchIdentity(): Promise<DeviceIdentity | null> {
  try {
    const res = await fetch("/api/device/identity");
    if (!res.ok) {
      // 503 = not seeded yet, retry on next hook mount. Other failures also
      // retryable — leave the cache empty so a subsequent hook re-fires.
      pending = null;
      return null;
    }
    return (await res.json()) as DeviceIdentity;
  } catch {
    pending = null;
    return null;
  }
}

function loadIdentity(): Promise<DeviceIdentity | null> {
  if (pending === null) pending = fetchIdentity();
  return pending;
}

/** Returns the local device id + label, or null while loading / on error.
 *  Callers gate cross-device UI affordances on a non-null value:
 *  during the brief window before the fetch returns, sessions are
 *  rendered as if all-local (no chip, no Resume button). That's a
 *  conservative default — better than flashing chips on local sessions. */
export function useMyDeviceId(): DeviceIdentity | null {
  const [identity, setIdentity] = useState<DeviceIdentity | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadIdentity().then((body) => {
      if (!cancelled && body) setIdentity(body);
    });
    return () => { cancelled = true; };
  }, []);

  return identity;
}

/** Test-only: reset the module-level cache. Not exported through the
 *  package surface but available to vitest if we ever add web tests for
 *  this hook. */
export function __resetDeviceIdentityCacheForTests(): void {
  pending = null;
}
