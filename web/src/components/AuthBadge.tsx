// Top-right badge showing the signed-in account, with a single click
// to start sign-in or sign out. Mounted at App-shell level so it sits
// above any space's surface. Auth state syncs over SSE — the local
// server emits `auth_changed` whenever the device-flow poll lands or
// the user signs out.

import { useEffect, useState } from "react";
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
}

export function AuthBadge() {
  const [phase, setPhase] = useState<Phase>("loading");
  const [user, setUser] = useState<AuthUser | null>(null);
  const [pending, setPending] = useState<SignInPending | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);

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
    };
  }, []);

  const handleSignIn = async () => {
    setPhase("signing-in");
    setPending(null);
    try {
      const res = await fetch("/api/auth/login", { method: "POST" });
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as SignInPending;
      setPending(body);
    } catch (err) {
      console.error("[auth] login failed:", err);
      setPhase("signed-out");
    }
  };

  const handleSignOut = async () => {
    setMenuOpen(false);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } catch (err) {
      console.error("[auth] logout failed:", err);
    }
    // Auth-changed SSE will pull state back, but pre-emptively flip the
    // UI so the menu doesn't sit on the screen with stale info while
    // we wait for the round-trip.
    setUser(null);
    setPhase("signed-out");
  };

  if (phase === "loading") {
    return null; // avoid a flash of "Sign in" before whoami resolves
  }

  if (phase === "signing-in" && pending) {
    return (
      <div className="auth-badge auth-badge--pending">
        <span className="auth-badge__hint">Check your email — sign-in link sent.</span>
        <a className="auth-badge__link" href={pending.sign_in_url} target="_blank" rel="noreferrer">
          Or open the sign-in page manually
        </a>
      </div>
    );
  }

  if (phase === "signing-in") {
    return <div className="auth-badge auth-badge--pending"><span>Starting sign-in…</span></div>;
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
