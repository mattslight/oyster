import { useEffect, useState } from "react";

// One-shot fetch of the local device identity. Used to distinguish "local"
// (this device produced it) from "remote" (another device produced it,
// pulled cross-device). The identity is stable across the server lifetime,
// so a single fetch per page load is enough — no SSE refresh needed.

export interface DeviceIdentity {
  deviceId: string;
  label: string;
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
    fetch("/api/device/identity")
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status));
        return (await res.json()) as DeviceIdentity;
      })
      .then((body) => {
        if (!cancelled) setIdentity(body);
      })
      .catch(() => {
        // Leave identity at null — UI degrades gracefully (no remote chip,
        // no Resume button). A 503 means device_identity isn't seeded yet
        // (race on first boot); other failures are network glitches.
      });
    return () => { cancelled = true; };
  }, []);

  return identity;
}
