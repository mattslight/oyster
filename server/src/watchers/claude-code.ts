import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import type { ArtifactStore } from "../artifact-store.js";
import type { SpaceStore } from "../space-store.js";
import type {
  InsertSessionEvent,
  SessionArtifactRole,
  SessionEventRole,
  SessionState,
  SessionStore,
} from "../session-store.js";
import { activeClaudeCwdCounts } from "./claude-process-probe.js";

// claude-code session log watcher (Sprint 2 of the 0.5.0 sessions arc).
// See docs/plans/sessions-arc.md.
//
// claude-code writes one JSONL file per session under
//   ~/.claude/projects/<url-encoded-cwd>/<session-uuid>.jsonl
// Each line is a transcript event. We tail every file under that root and
// turn the events into rows in `sessions` / `session_events` /
// `session_artifacts`. The format is not a public API — the parser ignores
// fields it doesn't recognise rather than failing.

const DEFAULT_PROJECTS_ROOT = join(homedir(), ".claude", "projects");

// State derivation: JSONL recency is the source of truth, process probe
// only gates whether a recent-but-not-fresh session reads as `waiting`
// vs `disconnected`. We can't externally identify *which* claude process
// is driving *which* session — there's no PID in the JSONL and the file
// isn't held open between turns. Anything more ambitious than "is there
// some claude at this cwd?" devolves into heuristics with edge cases.
//
//   ageMs < ACTIVE_WINDOW_MS                                → active
//   ageMs < WAITING_WINDOW_MS    + signal != "absent"       → waiting
//   ageMs < DONE_THRESHOLD_MS                               → disconnected
//   otherwise                                               → done
//
// `signal` is tri-state to handle Windows / probe-unavailable gracefully:
//   "alive"   — probe ran, found a claude process at this cwd
//   "absent"  — probe ran, found no claude at this cwd (terminal closed)
//   "unknown" — probe couldn't run at all (no pgrep). Treat as benefit-
//               of-doubt: a recent session reads as waiting, not
//               disconnected. Otherwise Windows would force every idle
//               session to disconnected, worse than the pre-probe state.
//
// The 30-min waiting window is the honest cap: a JSONL untouched for
// 30 min reads as disconnected regardless of probe. That means an old
// transcript at a cwd where the user is currently working doesn't get
// falsely elevated to waiting. False negative: a claude tab idle for
// >30min on POSIX reads as disconnected even if the process is live —
// flips back to active the moment the user types.
export type ProbeSignal = "alive" | "absent" | "unknown";
const ACTIVE_WINDOW_MS = 60_000;
const WAITING_WINDOW_MS = 30 * 60 * 1000;
const DONE_THRESHOLD_MS = 24 * 60 * 60 * 1000;

// How often the heartbeat sweep runs. Each tick probes processes (~40ms on
// macOS for a few claude PIDs) and recomputes state for every claude-code
// session. 15s is the longest a freshly-closed claude can linger as
// "active"/"waiting" before flipping to "disconnected". Tighten if needed.
const HEARTBEAT_INTERVAL_MS = 15_000;

// Truncation budgets for transcript text. We store the raw JSONL in `raw`
// for fidelity; `text` is the rendered preview. Keep it short — the home
// feed renders a single line per event.
const TEXT_PREVIEW_MAX = 280;
const TITLE_MAX = 80;

export interface ClaudeCodeWatcherDeps {
  sessionStore: SessionStore;
  spaceStore: SpaceStore;
  artifactStore: ArtifactStore;
  /** Called whenever a session row is inserted/updated, for SSE broadcast. */
  emitSessionChanged?: (sessionId: string) => void;
  /** Override the watch root (tests). */
  projectsRoot?: string;
  /** Override `now()` (tests). */
  now?: () => Date;
}

interface FileTracker {
  // Byte offset into the .jsonl already consumed.
  offset: number;
  // Cached session metadata extracted from the file's first event(s). The
  // session row may not yet exist in the DB if the very first event is still
  // partial (rare — we read line-by-line, so partial lines are buffered).
  sessionId: string | null;
  cwd: string | null;
  startedAt: string | null;
  model: string | null;
  // Title sources, in descending priority: customTitle > agentName >
  // userMessage > slug. claude-code now persists a named title via
  // {type:"custom-title"} / {type:"agent-name"} events; fall back to the
  // first real user prompt only if neither is present, and to the cute
  // slug ("encapsulated-nibbling-scroll" etc.) as a last resort.
  customTitle: string | null;
  agentName: string | null;
  userMessageTitle: string | null;
  slug: string | null;
  // Carry-over for partial trailing lines between change events.
  partial: string;
}

function effectiveTitle(t: Pick<FileTracker, "customTitle" | "agentName" | "userMessageTitle" | "slug">): string | null {
  return t.customTitle ?? t.agentName ?? t.userMessageTitle ?? t.slug ?? null;
}

export class ClaudeCodeWatcher {
  private watcher: FSWatcher | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  // Guard against overlapping heartbeat sweeps. Each sweep does a subprocess
  // probe (pgrep + lsof) plus per-session DB updates. If a slow lsof call
  // pushes a sweep past HEARTBEAT_INTERVAL_MS, the next tick would otherwise
  // start in parallel and duplicate work.
  private heartbeatInFlight = false;
  private trackers = new Map<string, FileTracker>();
  // Per-file serialisation: chokidar can fire two `change` events for the
  // same path before the first read finishes. Without a lock, both reads
  // see the same `tracker.offset`, both read the same byte range, and both
  // insert duplicate session_event rows. "queued" coalesces N pending
  // events into a single follow-up pass — the next read covers everything
  // appended between the lock acquisition and release.
  private fileLocks = new Map<string, "running" | "queued">();
  private readonly root: string;
  private readonly now: () => Date;

  constructor(private deps: ClaudeCodeWatcherDeps) {
    this.root = deps.projectsRoot ?? DEFAULT_PROJECTS_ROOT;
    this.now = deps.now ?? (() => new Date());
  }

  async start(): Promise<void> {
    // Stat the root first — if the user has never run claude-code, the dir
    // doesn't exist and chokidar would warn. Silently no-op until then.
    try {
      await fs.access(this.root);
    } catch {
      return;
    }

    await this.bootScan();

    const watcher = chokidar.watch(this.root, {
      persistent: true,
      ignoreInitial: true, // bootScan handled existing files
      depth: 2, // projects/<encoded-cwd>/<file>.jsonl
      awaitWriteFinish: false,
      ignored: (path) => {
        // Only care about .jsonl. Cheaper than letting chokidar hand us
        // every file then filtering downstream.
        const base = basename(path);
        if (base.startsWith(".")) return true;
        // Allow dirs through (they have no extension); reject other files.
        return base.includes(".") && !base.endsWith(".jsonl");
      },
    });
    this.watcher = watcher;

    watcher.on("add", (path) => this.onFileAppeared(path).catch(this.logError));
    watcher.on("change", (path) => this.onFileChanged(path).catch(this.logError));
    watcher.on("error", (err) => this.logError(err));

    // Don't return until chokidar has finished its initial scan. Otherwise
    // a caller that creates a session file immediately after start() can
    // race the watcher's setup and miss the resulting `add` event.
    await new Promise<void>((resolve) => {
      watcher.once("ready", () => resolve());
    });

    // Run an immediate sweep so state reflects current process reality
    // straight away rather than waiting up to HEARTBEAT_INTERVAL_MS for
    // the first scheduled tick.
    await this.heartbeatSweep().catch(this.logError);

    this.heartbeat = setInterval(() => {
      this.heartbeatSweep().catch(this.logError);
    }, HEARTBEAT_INTERVAL_MS);
  }

  async stop(): Promise<void> {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
    this.trackers.clear();
    this.fileLocks.clear();
  }

  // ── Boot reconciliation ─────────────────────────────────────────────────
  // Walk every .jsonl already on disk, upsert a session row for it, and seed
  // the offset tracker with the current file size so we don't replay history
  // into session_events on every restart. State derives from probe+recency
  // (see deriveState), so a session whose claude process is still running
  // comes back as 'active'/'waiting' even after a server restart.
  private async bootScan(): Promise<void> {
    const probe = await activeClaudeCwdCounts();
    let projectDirs: string[];
    try {
      projectDirs = await fs.readdir(this.root);
    } catch {
      return;
    }

    for (const projectDir of projectDirs) {
      const dirPath = join(this.root, projectDir);
      let stat;
      try {
        stat = await fs.stat(dirPath);
      } catch {
        continue;
      }
      if (!stat.isDirectory()) continue;

      let entries: string[];
      try {
        entries = await fs.readdir(dirPath);
      } catch {
        continue;
      }

      for (const entry of entries) {
        if (!entry.endsWith(".jsonl")) continue;
        const filePath = join(dirPath, entry);
        await this.reconcileExistingFile(filePath, probe).catch(this.logError);
      }
    }
  }

  private async reconcileExistingFile(filePath: string, probe: { counts: Map<string, number>; available: boolean }): Promise<void> {
    let stat;
    try {
      stat = await fs.stat(filePath);
    } catch {
      return;
    }

    const meta = await this.readSessionMetadata(filePath);
    if (!meta) return;

    const ageMs = this.now().getTime() - stat.mtime.getTime();
    const signal: ProbeSignal = !probe.available
      ? "unknown"
      : meta.cwd && (probe.counts.get(meta.cwd) ?? 0) > 0 ? "alive" : "absent";
    const state = deriveState(ageMs, signal);

    // Always pass ISO-8601 timestamps. If the JSONL didn't have a usable
    // event timestamp in the first 32KB, fall back to the file's birth time
    // (or mtime as a last resort) — both are better proxies for "session
    // started" than the boot-scan moment, and they keep the column shape
    // consistent (`YYYY-MM-DDTHH:MM:SS.mmmZ`).
    const startedAt = meta.startedAt ?? (stat.birthtime ?? stat.mtime).toISOString();

    this.deps.sessionStore.upsertSession({
      id: meta.sessionId,
      space_id: this.resolveSpaceId(meta.cwd),
      agent: "claude-code",
      title: effectiveTitle(meta),
      state,
      started_at: startedAt,
      model: meta.model,
      last_event_at: stat.mtime.toISOString(),
    });
    this.deps.emitSessionChanged?.(meta.sessionId);

    // Seed offset at end-of-file so future appends are read incrementally.
    this.trackers.set(filePath, {
      offset: stat.size,
      sessionId: meta.sessionId,
      cwd: meta.cwd,
      startedAt: meta.startedAt,
      model: meta.model,
      customTitle: meta.customTitle,
      agentName: meta.agentName,
      userMessageTitle: meta.userMessageTitle,
      slug: meta.slug,
      partial: "",
    });
  }

  // Read enough of a file to populate the session row. JSONLs grow to
  // multiple MB, and claude-code emits {type:"custom-title"} repeatedly:
  // the first occurrence is usually an auto-generated slug, and the
  // user-set title appears LATER in the file. So we scan two windows:
  //
  //   head (~64KB)  — cwd, startedAt, model, slug, first userMessageTitle
  //   tail (~128KB) — the LATEST customTitle / agentName the file holds
  //
  // For small files (<head+tail) the windows overlap and we just scan
  // everything once. The tail scan is bounded; even a 50 MB file pays
  // a flat 128KB read on boot.
  private async readSessionMetadata(
    filePath: string,
  ): Promise<{
    sessionId: string;
    cwd: string | null;
    startedAt: string | null;
    model: string | null;
    customTitle: string | null;
    agentName: string | null;
    userMessageTitle: string | null;
    slug: string | null;
  } | null> {
    const HEAD_BYTES = 65_536;
    const TAIL_BYTES = 131_072;

    let head: Buffer;
    let tail: Buffer | null;
    try {
      const fh = await fs.open(filePath, "r");
      try {
        const stat = await fh.stat();
        const headLen = Math.min(stat.size, HEAD_BYTES);
        head = Buffer.alloc(headLen);
        await fh.read(head, 0, headLen, 0);

        if (stat.size > HEAD_BYTES) {
          const tailLen = Math.min(stat.size - HEAD_BYTES, TAIL_BYTES);
          const tailStart = stat.size - tailLen;
          tail = Buffer.alloc(tailLen);
          await fh.read(tail, 0, tailLen, tailStart);
        } else {
          tail = null;
        }
      } finally {
        await fh.close();
      }
    } catch {
      return null;
    }

    const sessionIdFromName = filenameToSessionId(filePath);
    if (!sessionIdFromName) return null;

    let cwd: string | null = null;
    let startedAt: string | null = null;
    let model: string | null = null;
    let customTitle: string | null = null;
    let agentName: string | null = null;
    let userMessageTitle: string | null = null;
    let slug: string | null = null;

    // Pass 1 — head: early metadata + first-user-message title.
    for (const line of head.toString("utf8").split("\n")) {
      if (!line) continue;
      const ev = safeParse(line);
      if (!ev) continue;

      if (cwd === null && typeof ev.cwd === "string") cwd = ev.cwd;
      if (startedAt === null && typeof ev.timestamp === "string") startedAt = ev.timestamp;
      if (model === null && ev.type === "assistant" && ev.message?.model) {
        model = String(ev.message.model);
      }
      if (slug === null && typeof ev.slug === "string") slug = ev.slug;
      if (ev.type === "custom-title" && typeof ev.customTitle === "string") {
        customTitle = ev.customTitle.trim().slice(0, TITLE_MAX) || customTitle;
      }
      if (ev.type === "agent-name" && typeof ev.agentName === "string") {
        agentName = ev.agentName.trim().slice(0, TITLE_MAX) || agentName;
      }
      if (userMessageTitle === null) {
        const candidate = userMessageTitleCandidate(ev);
        if (candidate) userMessageTitle = candidate.slice(0, TITLE_MAX);
      }
    }

    // Pass 2 — tail: take the LAST customTitle / agentName so user renames
    // override the auto-generated slug-style ones written near the start.
    // Skip the first line of the tail buffer since reads at an arbitrary
    // byte offset usually start mid-line.
    if (tail) {
      const tailLines = tail.toString("utf8").split("\n");
      tailLines.shift(); // skip partial leading line
      for (const line of tailLines) {
        if (!line) continue;
        const ev = safeParse(line);
        if (!ev) continue;
        if (ev.type === "custom-title" && typeof ev.customTitle === "string") {
          const t = ev.customTitle.trim().slice(0, TITLE_MAX);
          if (t) customTitle = t;
        }
        if (ev.type === "agent-name" && typeof ev.agentName === "string") {
          const t = ev.agentName.trim().slice(0, TITLE_MAX);
          if (t) agentName = t;
        }
      }
    }

    return { sessionId: sessionIdFromName, cwd, startedAt, model, customTitle, agentName, userMessageTitle, slug };
  }

  // ── Live updates ────────────────────────────────────────────────────────

  private async onFileAppeared(filePath: string): Promise<void> {
    if (!filePath.endsWith(".jsonl")) return;
    if (this.trackers.has(filePath)) return; // boot scan already seeded it

    // Brand-new file: start at offset 0 so we ingest the whole transcript
    // (which for a freshly-spawned session is just the first event or two).
    this.trackers.set(filePath, {
      offset: 0,
      sessionId: filenameToSessionId(filePath),
      cwd: null,
      startedAt: null,
      model: null,
      customTitle: null,
      agentName: null,
      userMessageTitle: null,
      slug: null,
      partial: "",
    });
    await this.consumeAppended(filePath);
  }

  private async onFileChanged(filePath: string): Promise<void> {
    if (!filePath.endsWith(".jsonl")) return;
    if (!this.trackers.has(filePath)) {
      // Race: change fired before add (rare). Treat as new.
      await this.onFileAppeared(filePath);
      return;
    }
    await this.consumeAppended(filePath);
  }

  private async consumeAppended(filePath: string): Promise<void> {
    if (this.fileLocks.has(filePath)) {
      // Either a read is in flight ("running") or a follow-up is already
      // scheduled ("queued"). In both cases, mark queued so the in-flight
      // read knows to make another pass when it finishes — coalescing N
      // pending events into a single follow-up. Treating only "running"
      // as locked would let a third arrival start a second concurrent
      // consumeOnce while a follow-up was pending, reintroducing the
      // duplicate-insert race the lock was meant to prevent.
      this.fileLocks.set(filePath, "queued");
      return;
    }
    this.fileLocks.set(filePath, "running");
    try {
      await this.consumeOnce(filePath);
    } finally {
      const wasQueued = this.fileLocks.get(filePath) === "queued";
      this.fileLocks.delete(filePath);
      if (wasQueued) {
        // New events arrived during the read; coalesce them into one
        // follow-up pass. The next consumeOnce reads from the new offset
        // to current size, so any number of intermediate change events is
        // covered by a single read.
        await this.consumeAppended(filePath);
      }
    }
  }

  private async consumeOnce(filePath: string): Promise<void> {
    const tracker = this.trackers.get(filePath);
    if (!tracker) return;

    let stat;
    try {
      stat = await fs.stat(filePath);
    } catch {
      return; // file removed mid-flight
    }

    if (stat.size <= tracker.offset) {
      // Truncation or no growth — not expected for append-only logs.
      // Reset offset to current size and bail.
      tracker.offset = stat.size;
      return;
    }

    const fh = await fs.open(filePath, "r");
    let chunk: Buffer;
    try {
      const len = stat.size - tracker.offset;
      chunk = Buffer.alloc(len);
      await fh.read(chunk, 0, len, tracker.offset);
    } finally {
      await fh.close();
    }
    tracker.offset = stat.size;

    const text = tracker.partial + chunk.toString("utf8");
    const lines = text.split("\n");
    // Last element is whatever's after the final newline — empty on a clean
    // boundary, partial line otherwise. Buffer it for the next change event.
    tracker.partial = lines.pop() ?? "";

    const events: InsertSessionEvent[] = [];
    let latestTimestamp: string | null = null;
    let sessionEnsured = false;
    let titleChanged = false;

    for (const line of lines) {
      if (!line) continue;
      const ev = safeParse(line);
      if (!ev) continue;

      if (tracker.sessionId) {
        // Metadata refresh — every event can contribute. cwd/startedAt/model
        // are usually set on the first event, but the named title arrives
        // on a `custom-title` event that may be later in the file. We track
        // four title sources and keep upgrading whenever a higher-priority
        // one shows up (custom > agent-name > user message > slug).
        if (!tracker.cwd && typeof ev.cwd === "string") tracker.cwd = ev.cwd;
        if (!tracker.startedAt && typeof ev.timestamp === "string") {
          tracker.startedAt = ev.timestamp;
        }
        if (!tracker.slug && typeof ev.slug === "string") tracker.slug = ev.slug;

        const before = effectiveTitle(tracker);
        // Always take the latest custom-title / agent-name — claude-code
        // overwrites these when the user renames a session via /title etc.,
        // so the last one wins.
        if (ev.type === "custom-title" && typeof ev.customTitle === "string") {
          const t = ev.customTitle.trim().slice(0, TITLE_MAX) || null;
          if (t && t !== tracker.customTitle) tracker.customTitle = t;
        }
        if (ev.type === "agent-name" && typeof ev.agentName === "string") {
          const t = ev.agentName.trim().slice(0, TITLE_MAX) || null;
          if (t && t !== tracker.agentName) tracker.agentName = t;
        }
        if (!tracker.userMessageTitle) {
          const candidate = userMessageTitleCandidate(ev);
          if (candidate) tracker.userMessageTitle = candidate.slice(0, TITLE_MAX);
        }
        const after = effectiveTitle(tracker);
        if (after !== before && sessionEnsured) titleChanged = true;

        if (!tracker.model && ev.type === "assistant" && ev.message?.model) {
          tracker.model = String(ev.message.model);
        }
      }

      // First event from a brand-new file: upsert the row before any events
      // are inserted (FK constraint).
      if (!sessionEnsured && tracker.sessionId) {
        this.deps.sessionStore.upsertSession({
          id: tracker.sessionId,
          space_id: this.resolveSpaceId(tracker.cwd),
          agent: "claude-code",
          title: effectiveTitle(tracker),
          state: "active",
          // Always pass ISO. Falling through to SQL's datetime('now')
          // produces the naive `YYYY-MM-DD HH:MM:SS` form which Date.parse()
          // is allowed to reject in some browsers — kept the wire contract
          // mixed and the home feed flaky on those rows.
          started_at: tracker.startedAt ?? this.now().toISOString(),
          model: tracker.model,
          last_event_at: typeof ev.timestamp === "string" ? ev.timestamp : undefined,
        });
        this.deps.emitSessionChanged?.(tracker.sessionId);
        sessionEnsured = true;
      }

      const rendered = renderEvent(ev);
      if (rendered && tracker.sessionId) {
        events.push({
          session_id: tracker.sessionId,
          role: rendered.role,
          text: rendered.text.slice(0, TEXT_PREVIEW_MAX),
          ts: typeof ev.timestamp === "string" ? ev.timestamp : undefined,
          raw: line,
        });
        if (typeof ev.timestamp === "string") latestTimestamp = ev.timestamp;
      }

      // Artifact touches from tool_use blocks.
      if (ev.type === "assistant" && Array.isArray(ev.message?.content) && tracker.sessionId) {
        const spaceId = this.resolveSpaceId(tracker.cwd);
        // Skip touch attribution entirely for orphan sessions (cwd not
        // mapped to any space). Without a session→space link we can't
        // tell whether the touch belongs here or is bleed-through from a
        // tool reading across spaces, so creating provenance edges from a
        // homeless session into other spaces would be misleading.
        if (!spaceId) continue;
        for (const block of ev.message.content) {
          const touch = artifactTouchFromToolUse(block);
          if (!touch) continue;
          const artifact = this.deps.artifactStore.getByPath(touch.path);
          if (!artifact) continue;
          if (artifact.space_id !== spaceId) continue;
          this.deps.sessionStore.insertArtifactTouch({
            session_id: tracker.sessionId,
            artifact_id: artifact.id,
            role: touch.role,
          });
        }
      }
    }

    if (events.length > 0) {
      this.deps.sessionStore.insertEvents(events);
    }

    if (tracker.sessionId) {
      // Bytes just landed → JSONL is fresh by definition, so this session is
      // 'active'. Even if the heartbeat had previously demoted it to
      // 'waiting'/'disconnected', a new event resurrects it. If a title we
      // couldn't derive on the first pass (e.g. opening event was a caveat)
      // is now available, patch it through here in the same write.
      const ts = latestTimestamp ?? this.now().toISOString();
      if (titleChanged) {
        this.deps.sessionStore.updateSession(tracker.sessionId, {
          state: "active",
          last_event_at: ts,
          title: effectiveTitle(tracker),
        });
      } else {
        this.deps.sessionStore.updateSessionState(tracker.sessionId, "active", ts);
      }
      this.deps.emitSessionChanged?.(tracker.sessionId);
    }
  }

  // ── Heartbeat ───────────────────────────────────────────────────────────
  // Probe every running `claude` process for its cwd. The probe answers
  // "does any claude process have this cwd open?" — coarser than per-session
  // identity, but it's the strongest signal we can observe externally
  // (claude doesn't log its PID in the JSONL, and the file isn't held open
  // between turns). The recency cap in deriveState handles the one-live-
  // claude-many-old-transcripts case cleanly.
  private async heartbeatSweep(): Promise<void> {
    if (this.heartbeatInFlight) return;
    this.heartbeatInFlight = true;
    try {
      await this.runHeartbeatSweep();
    } finally {
      this.heartbeatInFlight = false;
    }
  }

  private async runHeartbeatSweep(): Promise<void> {
    const probe = await activeClaudeCwdCounts();
    const now = this.now().getTime();

    // sessionId → cwd, from in-memory trackers seeded by bootScan + watch.
    const sessionCwds = new Map<string, string>();
    for (const t of this.trackers.values()) {
      if (t.sessionId && t.cwd) sessionCwds.set(t.sessionId, t.cwd);
    }

    for (const session of this.deps.sessionStore.getAll()) {
      if (session.agent !== "claude-code") continue;
      const last = Date.parse(session.last_event_at);
      if (!Number.isFinite(last)) continue;
      const ageMs = now - last;

      const cwd = sessionCwds.get(session.id);
      const signal: ProbeSignal = !probe.available
        ? "unknown"
        : cwd && (probe.counts.get(cwd) ?? 0) > 0 ? "alive" : "absent";
      const next = deriveState(ageMs, signal);

      if (next !== session.state) {
        this.deps.sessionStore.updateSessionState(session.id, next, session.last_event_at);
        this.deps.emitSessionChanged?.(session.id);
      }
    }
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  private resolveSpaceId(cwd: string | null): string | null {
    if (!cwd) return null;
    const source = this.deps.spaceStore.getActiveSourceByPath(cwd);
    return source?.space_id ?? null;
  }

  private logError = (err: unknown) => {
    // Watcher errors are non-fatal; log and continue. Silence in tests by
    // overriding via deps.now isn't enough — we just don't throw.
    // eslint-disable-next-line no-console
    console.warn("[claude-code-watcher]", err instanceof Error ? err.message : err);
  };
}

// ── Pure helpers (exported for tests) ─────────────────────────────────────

export function deriveState(ageMs: number, signal: ProbeSignal): SessionState {
  if (ageMs < ACTIVE_WINDOW_MS) return "active";
  if (ageMs > DONE_THRESHOLD_MS) return "done";
  if (ageMs < WAITING_WINDOW_MS) {
    return signal === "absent" ? "disconnected" : "waiting";
  }
  return "disconnected";
}

// Pull a usable title out of a `type:"user"` event's content, or return null.
// claude-code wraps slash-command machinery (/compact, /clear, etc.) in
// pseudo-user messages prefixed with <local-command-caveat>, <command-name>,
// or <command-message>. Those are noise — keep scanning until we find a
// real prompt the user actually typed.
export function userMessageTitleCandidate(ev: Record<string, any>): string | null {
  if (ev?.type !== "user") return null;
  const content = ev.message?.content;
  if (typeof content !== "string") return null;
  const trimmed = content.trim();
  if (!trimmed) return null;
  // Slash-command machinery shows up under several tag prefixes — current
  // ones are <local-command-caveat>, <local-command-stdout>, and the older
  // <command-name>/<command-message>. Catch the family with a single check
  // so future variants don't slip through.
  if (trimmed.startsWith("<local-command-") || trimmed.startsWith("<command-")) {
    return null;
  }
  return trimmed;
}

export function filenameToSessionId(filePath: string): string {
  // Filename is `<uuid>.jsonl`. The UUID is the session id.
  const base = basename(filePath);
  return base.endsWith(".jsonl") ? base.slice(0, -".jsonl".length) : base;
}

function safeParse(line: string): Record<string, any> | null {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

interface RenderedEvent {
  role: SessionEventRole;
  text: string;
}

// Map a raw JSONL event to a (role, text) pair the home feed can render.
// Returns null for events we deliberately skip (file-history-snapshot,
// last-prompt, attachment metadata, etc — useful in `raw` only).
export function renderEvent(ev: Record<string, any>): RenderedEvent | null {
  switch (ev.type) {
    case "user": {
      const content = ev.message?.content;
      if (typeof content === "string") {
        return { role: "user", text: content };
      }
      if (Array.isArray(content)) {
        // user-typed array events are tool_result wrappers
        const first = content.find((b) => b?.type === "tool_result");
        if (first) {
          const inner = typeof first.content === "string"
            ? first.content
            : Array.isArray(first.content)
              ? first.content
                  .map((c: any) => (typeof c?.text === "string" ? c.text : ""))
                  .join("")
              : "";
          return { role: "tool_result", text: inner || "(tool result)" };
        }
      }
      return null;
    }
    case "assistant": {
      const blocks = ev.message?.content;
      if (!Array.isArray(blocks)) return null;
      const hasText = blocks.some(
        (b: any) => b?.type === "text" && typeof b.text === "string" && b.text.trim() !== "",
      );
      const toolNames = blocks
        .filter((b: any) => b?.type === "tool_use" && typeof b.name === "string")
        .map((b: any) => b.name as string);
      // Pure tool-call turns (no text blocks, only tool_use) are tool calls
      // semantically — the "ASSISTANT [Bash]" rendering was misleading. Mark
      // them as `tool` so the inspector renders them as collapsible tool
      // turns, matching tool_result on the other side.
      if (!hasText && toolNames.length > 0) {
        return { role: "tool", text: toolNames.map((n) => `[${n}]`).join(" ") };
      }
      const text = blocks
        .map((b: any) => {
          if (b?.type === "text" && typeof b.text === "string") return b.text;
          if (b?.type === "tool_use" && typeof b.name === "string") return `[${b.name}]`;
          return "";
        })
        .filter(Boolean)
        .join(" ");
      // Pure-thinking turns produce empty text — store the marker so timeline
      // doesn't silently lose them.
      return { role: "assistant", text: text || "(thinking)" };
    }
    case "system": {
      const subtype = typeof ev.subtype === "string" ? ev.subtype : "system";
      const content = typeof ev.content === "string" ? ev.content : "";
      return { role: "system", text: content ? `${subtype}: ${content}` : subtype };
    }
    default:
      return null;
  }
}

// Recognise tool_use blocks that touch a tracked file path. Read=>read,
// Write=>create, Edit=>modify. We don't try to detect existence of the file
// pre-call — Write on an existing file is "create" in our taxonomy (it
// replaces). Bash output isn't parsed; future ticket if needed.
export function artifactTouchFromToolUse(
  block: any,
): { path: string; role: SessionArtifactRole } | null {
  if (!block || block.type !== "tool_use") return null;
  const name = typeof block.name === "string" ? block.name : null;
  const filePath = typeof block.input?.file_path === "string" ? block.input.file_path : null;
  if (!name || !filePath) return null;
  switch (name) {
    case "Read":
      return { path: filePath, role: "read" };
    case "Write":
      return { path: filePath, role: "create" };
    case "Edit":
      return { path: filePath, role: "modify" };
    default:
      return null;
  }
}

