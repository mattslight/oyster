// Top-left badge showing the signed-in account, with a single click
// to start sign-in or sign out. Mounted at App-shell level so it sits
// above any space's surface. Auth state syncs over SSE — the local
// server emits `auth_changed` whenever the device-flow poll lands or
// the user signs out.

import { useEffect, useRef, useState } from "react";
import { subscribeUiEvents } from "../data/ui-events";
import "./AuthBadge.css";

interface AuthUser {
  id: string;
  email: string;
}

type Phase = "loading" | "signed-out" | "signing-in" | "signed-in";

interface SignInPending {
  user_code: string;
  sign_in_url: string;
  expires_in: number;
}

export function AuthBadge() {
  const [phase, setPhase] = useState<Phase>("loading");
  const [user, setUser] = useState<AuthUser | null>(null);
  const [pending, setPending] = useState<SignInPending | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);

  // Client-side timeout that mirrors the device_code TTL on the Worker.
  // Without it, the badge can stay stuck in `signing-in` indefinitely:
  // the local server's poller goes silent on timeout/410 and never
  // emits an auth_changed event (state didn't change — user is still
  // null). The expires_in from /api/auth/login tells us how long to wait.
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearAbortTimeout = () => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  };

  // Initial whoami + SSE subscription. The server emits `auth_changed`
  // when the device-flow poll resolves or sign-out completes; we
  // refetch the canonical state rather than trusting the payload.
  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const res = await fetch("/api/auth/whoami");
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as { user: AuthUser | null };
        if (cancelled) return;
        setUser(body.user);
        setPending(null);
        clearAbortTimeout();
        setPhase(body.user ? "signed-in" : "signed-out");
      } catch {
        if (cancelled) return;
        setPhase("signed-out");
      }
    };
    refresh();
    const unsub = subscribeUiEvents((event) => {
      if (event.command === "auth_changed") refresh();
    });
    return () => {
      cancelled = true;
      unsub();
      clearAbortTimeout();
    };
  }, []);

  const handleSignIn = async () => {
    // If a previous flow is still pending, restart cleanly. The local
    // server's startSignIn() also aborts the old poll on its end.
    clearAbortTimeout();
    setPhase("signing-in");
    setPending(null);
    setSignOutError(null);
    try {
      const res = await fetch("/api/auth/login", { method: "POST" });
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as SignInPending;
      setPending(body);
      // Mirror the server-side device_code TTL on the client. If the
      // poll ages out or the cloud 410s, no auth_changed event will
      // fire; this timer is what flips the UI back to signed-out.
      timeoutRef.current = setTimeout(() => {
        setPhase("signed-out");
        setPending(null);
      }, body.expires_in * 1000);
    } catch (err) {
      console.error("[auth] login failed:", err);
      setPhase("signed-out");
    }
  };

  const handleCancelSignIn = () => {
    clearAbortTimeout();
    setPending(null);
    setPhase("signed-out");
  };

  const handleSignOut = async () => {
    setMenuOpen(false);
    setSignOutError(null);
    try {
      const res = await fetch("/api/auth/logout", { method: "POST" });
      if (!res.ok) {
        // Local server failed to sign out (cloud unreachable / D1
        // transient). Don't flip the UI — the user is still signed in
        // as far as the system is concerned. Show an error so they can
        // retry rather than silently leaving them in an inconsistent
        // state until reload.
        setSignOutError("Sign-out failed. Try again.");
        console.error("[auth] logout returned", res.status);
        return;
      }
    } catch (err) {
      setSignOutError("Sign-out failed. Try again.");
      console.error("[auth] logout failed:", err);
      return;
    }
    // The server emits auth_changed on success; pre-emptively flip the
    // UI so the menu doesn't sit on stale info while the SSE round-trips.
    setUser(null);
    setPhase("signed-out");
  };

  if (phase === "loading") {
    return null; // avoid a flash of "Sign in" before whoami resolves
  }

  if (phase === "signing-in" && pending) {
    return (
      <div className="auth-badge auth-badge--pending">
        <span className="auth-badge__hint">Sign-in opened in a new tab — enter your email there.</span>
        <a className="auth-badge__link" href={pending.sign_in_url} target="_blank" rel="noreferrer">
          Or open the sign-in page manually
        </a>
        <button type="button" className="auth-badge__cancel" onClick={handleCancelSignIn}>
          Cancel
        </button>
      </div>
    );
  }

  if (phase === "signing-in") {
    return (
      <div className="auth-badge auth-badge--pending">
        <span>Starting sign-in…</span>
        <button type="button" className="auth-badge__cancel" onClick={handleCancelSignIn}>
          Cancel
        </button>
      </div>
    );
  }

  if (phase === "signed-in" && user) {
    return (
      <div className="auth-badge">
        <button
          type="button"
          className="auth-badge__chip"
          onClick={() => setMenuOpen((v) => !v)}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
        >
          {user.email}
        </button>
        {menuOpen && (
          <div className="auth-badge__menu" role="menu">
            <button type="button" className="auth-badge__menu-item" onClick={handleSignOut}>
              Sign out
            </button>
          </div>
        )}
        {signOutError && <div className="auth-badge__error">{signOutError}</div>}
      </div>
    );
  }

  return (
    <div className="auth-badge">
      <button type="button" className="auth-badge__chip" onClick={handleSignIn}>
        Sign in
      </button>
    </div>
  );
}
