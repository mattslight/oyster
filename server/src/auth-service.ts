// Auth bridge between the local Oyster server and the cloud auth Worker.
//
// Flow (per docs/plans/auth.md):
//   1. UI calls POST /api/auth/login.
//   2. Service calls POST <AUTH_WORKER_BASE>/device-init → { device_code, user_code }.
//   3. Service opens browser to <AUTH_WORKER_BASE>/sign-in?d=<user_code>.
//   4. Service polls <AUTH_WORKER_BASE>/device/<device_code> every 2s.
//   5. On 200 with { session_token, user }, persist to <CONFIG_DIR>/auth.json,
//      emit auth_changed SSE so the UI re-fetches whoami.
//   6. On 410 / timeout, give up silently — UI stays in signed-out state.
//
// State is cached in memory; auth.json is the durable source of truth on disk.

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

export interface AuthUser {
  id: string;
  email: string;
}

export interface AuthState {
  user: AuthUser | null;
  sessionToken: string | null;
  signedInAt: number | null;
}

interface PersistedAuth {
  session_token: string;
  user_id: string;
  email: string;
  signed_in_at: number;
}

interface DeviceInitResponse {
  device_code: string;
  user_code: string;
  expires_in: number;
}

interface DevicePollSuccess {
  session_token: string;
  user: AuthUser;
}

const AUTH_WORKER_BASE = process.env.OYSTER_AUTH_BASE ?? "https://oyster.to/auth";
const POLL_INTERVAL_MS = 2_000;

export type AuthChangedListener = (state: AuthState) => void;

export class AuthService {
  private state: AuthState = { user: null, sessionToken: null, signedInAt: null };
  private listeners = new Set<AuthChangedListener>();
  private activePoll: { deviceCode: string; abort: AbortController } | null = null;
  private readonly authJsonPath: string;

  constructor(configDir: string) {
    this.authJsonPath = join(configDir, "auth.json");
    this.loadFromDisk();
  }

  getState(): AuthState {
    return this.state;
  }

  onAuthChanged(listener: AuthChangedListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // Kick off a sign-in flow. Returns the user_code, the URL the browser
  // was directed to, and the expires_in window so the UI can run a
  // matching client-side timeout (badge flips back to signed-out if the
  // poll ages out without producing a session). Idempotent: an existing
  // active poll is aborted first so a stale device_code doesn't keep
  // claiming the slot when the user retries.
  async startSignIn(): Promise<{ user_code: string; sign_in_url: string; expires_in: number }> {
    if (this.activePoll) {
      this.activePoll.abort.abort();
      this.activePoll = null;
    }
    const init = await this.fetchJson<DeviceInitResponse>("/device-init", { method: "POST" });
    const signInUrl = `${AUTH_WORKER_BASE}/sign-in?d=${encodeURIComponent(init.user_code)}`;
    this.openBrowser(signInUrl);
    this.beginPolling(init.device_code, init.expires_in * 1000);
    return { user_code: init.user_code, sign_in_url: signInUrl, expires_in: init.expires_in };
  }

  // Validate the persisted session against the cloud Worker. If the
  // server was offline when the session was revoked elsewhere (sign-out
  // on another device, manual D1 revoke), the local cache shows
  // signed-in until next refresh — this catches that on startup.
  // Network failure leaves the state alone (don't punish offline users
  // by signing them out on every flaky boot).
  async validatePersistedSession(): Promise<void> {
    const token = this.state.sessionToken;
    if (!token) return;
    try {
      const res = await fetch(`${AUTH_WORKER_BASE}/whoami`, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (res.status === 401) {
        console.warn("[auth] persisted session is no longer valid; clearing");
        this.setState({ user: null, sessionToken: null, signedInAt: null });
        try { if (existsSync(this.authJsonPath)) unlinkSync(this.authJsonPath); }
        catch (err) { console.error("[auth] failed to delete auth.json:", err); }
        return;
      }
      // 200 or any other status: leave state untouched. 5xx / network
      // errors are handled the same as success here — we trust the disk
      // cache until the Worker tells us otherwise (401).
    } catch (err) {
      console.error("[auth] startup whoami probe failed (offline?); keeping cached session:", err);
    }
  }

  // Local sign-out: revoke on the cloud side (best-effort), then clear
  // the local cache + auth.json. UI sees the SSE event and re-renders.
  async signOut(): Promise<void> {
    const token = this.state.sessionToken;
    if (this.activePoll) {
      this.activePoll.abort.abort();
      this.activePoll = null;
    }
    if (token) {
      try {
        const res = await fetch(`${AUTH_WORKER_BASE}/sign-out`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
        });
        if (!res.ok) {
          // Cloud reachable but rejected the call (5xx / 503 / DB
          // transient). The local sign-out still completes, but the
          // cloud row remains valid until validatePersistedSession()
          // hits a 401 on next start. Log so it's visible in dev.
          const detail = await res.text().catch(() => "");
          console.error(`[auth] cloud sign-out non-ok ${res.status}: ${detail}`);
        }
      } catch (err) {
        // Cloud unreachable. Same caveat as the !res.ok branch — local
        // sign-out completes, cloud cleanup deferred to next whoami probe.
        console.error("[auth] cloud sign-out threw:", err);
      }
    }
    this.setState({ user: null, sessionToken: null, signedInAt: null });
    try { if (existsSync(this.authJsonPath)) unlinkSync(this.authJsonPath); }
    catch (err) { console.error("[auth] failed to delete auth.json:", err); }
  }

  // ── internals ──

  private loadFromDisk(): void {
    if (!existsSync(this.authJsonPath)) return;
    try {
      const raw = readFileSync(this.authJsonPath, "utf-8");
      const parsed = JSON.parse(raw) as PersistedAuth;
      if (typeof parsed.session_token !== "string" || typeof parsed.user_id !== "string" || typeof parsed.email !== "string") {
        console.error("[auth] auth.json has unexpected shape; ignoring");
        return;
      }
      this.state = {
        user: { id: parsed.user_id, email: parsed.email },
        sessionToken: parsed.session_token,
        signedInAt: parsed.signed_in_at ?? null,
      };
    } catch (err) {
      console.error("[auth] failed to read auth.json:", err);
    }
  }

  private persistToDisk(): void {
    if (!this.state.user || !this.state.sessionToken) return;
    const payload: PersistedAuth = {
      session_token: this.state.sessionToken,
      user_id: this.state.user.id,
      email: this.state.user.email,
      signed_in_at: this.state.signedInAt ?? Date.now(),
    };
    try {
      mkdirSync(dirname(this.authJsonPath), { recursive: true });
      writeFileSync(this.authJsonPath, JSON.stringify(payload, null, 2), { mode: 0o600 });
    } catch (err) {
      console.error("[auth] failed to write auth.json:", err);
    }
  }

  private setState(next: AuthState): void {
    this.state = next;
    for (const listener of this.listeners) {
      try { listener(next); } catch (err) { console.error("[auth] listener threw:", err); }
    }
  }

  private beginPolling(deviceCode: string, maxAgeMs: number): void {
    const abort = new AbortController();
    this.activePoll = { deviceCode, abort };
    const startedAt = Date.now();

    const tick = async (): Promise<void> => {
      if (abort.signal.aborted) return;
      if (Date.now() - startedAt > maxAgeMs) {
        if (this.activePoll?.deviceCode === deviceCode) this.activePoll = null;
        return;
      }
      try {
        const res = await fetch(`${AUTH_WORKER_BASE}/device/${encodeURIComponent(deviceCode)}`, {
          signal: abort.signal,
        });
        if (res.status === 200) {
          const body = await res.json() as DevicePollSuccess;
          this.handleSignInSuccess(body);
          if (this.activePoll?.deviceCode === deviceCode) this.activePoll = null;
          return;
        }
        if (res.status === 410) {
          // Code expired or already claimed — give up. UI stays signed-out.
          if (this.activePoll?.deviceCode === deviceCode) this.activePoll = null;
          return;
        }
        // 202 or transient error — keep polling.
      } catch (err) {
        if ((err as { name?: string }).name === "AbortError") return;
        console.error("[auth] poll error:", err);
      }
      setTimeout(tick, POLL_INTERVAL_MS).unref?.();
    };
    setTimeout(tick, POLL_INTERVAL_MS).unref?.();
  }

  private handleSignInSuccess(body: DevicePollSuccess): void {
    this.setState({
      user: body.user,
      sessionToken: body.session_token,
      signedInAt: Date.now(),
    });
    this.persistToDisk();
  }

  private async fetchJson<T>(path: string, init: RequestInit): Promise<T> {
    const res = await fetch(`${AUTH_WORKER_BASE}${path}`, init);
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`auth worker ${path} ${res.status}: ${detail}`);
    }
    return res.json() as Promise<T>;
  }

  private openBrowser(url: string): void {
    // Best-effort. If the spawn fails (e.g. headless env), the UI still
    // shows the user_code + URL for manual paste. Windows note: `start`
    // treats the first quoted argument as the window title — passing
    // an empty title placeholder before the URL is the documented fix
    // (otherwise the URL itself becomes the title and nothing opens).
    try {
      if (process.platform === "darwin") execSync(`open ${JSON.stringify(url)}`);
      else if (process.platform === "linux") execSync(`xdg-open ${JSON.stringify(url)}`);
      else if (process.platform === "win32") execSync(`start "" ${JSON.stringify(url)}`);
    } catch {
      // ignored — user can paste the URL from the UI
    }
  }
}
