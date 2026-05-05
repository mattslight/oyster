import { useEffect, useState } from "react";
import { subscribeUiEvents } from "../data/ui-events";

// Lightweight auth-status hook — no user details, just "is there a signed-in
// session right now?". Returns `null` while the first whoami is in flight so
// callers can avoid a flash of the wrong empty state. Mirrors the pattern in
// AuthBadge + PublishModal but without the OAuth polling concerns.
export function useAuthSignedIn(): boolean | null {
  const [signedIn, setSignedIn] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const res = await fetch("/api/auth/whoami");
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as { user: { email: string } | null };
        if (cancelled) return;
        setSignedIn(body.user != null);
      } catch {
        if (cancelled) return;
        setSignedIn(false);
      }
    };
    refresh();
    const unsub = subscribeUiEvents((e) => {
      if (e.command === "auth_changed") void refresh();
    });
    return () => { cancelled = true; unsub(); };
  }, []);

  return signedIn;
}
