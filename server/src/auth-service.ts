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
const POLL_MAX_AGE_MS = 10 * 60 * 1000; // matches device_code TTL on the Worker

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

  // Kick off a sign-in flow. Returns the user_code so the UI can show
  // a fallback ("Open https://oyster.to/auth/sign-in?d=ABCD-1234 if your
  // browser didn't open") and the URL it tried to open. Idempotent: if
  // there's already an active poll, abort the old one first so a stale
  // device_code doesn't keep claiming the slot when the user retries.
  async startSignIn(): Promise<{ user_code: string; sign_in_url: string }> {
    if (this.activePoll) {
      this.activePoll.abort.abort();
      this.activePoll = null;
    }
    const init = await this.fetchJson<DeviceInitResponse>("/device-init", { method: "POST" });
    const signInUrl = `${AUTH_WORKER_BASE}/sign-in?d=${encodeURIComponent(init.user_code)}`;
    this.openBrowser(signInUrl);
    this.beginPolling(init.device_code);
    return { user_code: init.user_code, sign_in_url: signInUrl };
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
        await fetch(`${AUTH_WORKER_BASE}/sign-out`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
        });
      } catch (err) {
        // Cloud unreachable: revoke happens on the Worker side eventually
        // when we next call /whoami. Local sign-out still completes.
        console.error("[auth] cloud sign-out failed:", err);
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

  private beginPolling(deviceCode: string): void {
    const abort = new AbortController();
    this.activePoll = { deviceCode, abort };
    const startedAt = Date.now();

    const tick = async (): Promise<void> => {
      if (abort.signal.aborted) return;
      if (Date.now() - startedAt > POLL_MAX_AGE_MS) {
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
    // shows the user_code + URL for manual paste. Same pattern bin/oyster.mjs
    // uses for opening localhost:4444 on first launch.
    try {
      if (process.platform === "darwin") execSync(`open ${JSON.stringify(url)}`);
      else if (process.platform === "linux") execSync(`xdg-open ${JSON.stringify(url)}`);
      else if (process.platform === "win32") execSync(`start ${JSON.stringify(url)}`);
    } catch {
      // ignored — user can paste the URL from the UI
    }
  }
}
