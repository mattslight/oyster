import { promises as fs, statSync } from "node:fs";
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

// Heartbeat: how long without a new event before we call a running session
// "disconnected". Heuristic — claude-code emits no explicit done marker, so
// we fall back to file mtime / event freshness. Generous enough to ride out
// long Anthropic-side stalls (multi-minute extended thinking turns).
const DISCONNECT_THRESHOLD_MS = 90_000;

// How often the heartbeat sweep runs. Cheap query; this can be aggressive.
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
  title: string | null;
  // Carry-over for partial trailing lines between change events.
  partial: string;
}

export class ClaudeCodeWatcher {
  private watcher: FSWatcher | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  private trackers = new Map<string, FileTracker>();
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

    this.watcher = chokidar.watch(this.root, {
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

    this.watcher.on("add", (path) => this.onFileAppeared(path).catch(this.logError));
    this.watcher.on("change", (path) => this.onFileChanged(path).catch(this.logError));
    this.watcher.on("error", (err) => this.logError(err));

    this.heartbeat = setInterval(() => this.heartbeatSweep(), HEARTBEAT_INTERVAL_MS);
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
  }

  // ── Boot reconciliation ─────────────────────────────────────────────────
  // Walk every .jsonl already on disk, upsert a session row for it, and seed
  // the offset tracker with the current file size so we don't replay history
  // into session_events on every restart. State is set conservatively:
  // - file modified within DISCONNECT_THRESHOLD_MS → 'running' (will get
  //   bumped to 'disconnected' by the heartbeat if no events arrive)
  // - older → 'disconnected'
  // We never set 'done' on boot because claude-code emits no end marker.
  private async bootScan(): Promise<void> {
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
        await this.reconcileExistingFile(filePath).catch(this.logError);
      }
    }
  }

  private async reconcileExistingFile(filePath: string): Promise<void> {
    let stat;
    try {
      stat = await fs.stat(filePath);
    } catch {
      return;
    }

    const meta = await this.readSessionMetadata(filePath);
    if (!meta) return;

    const ageMs = this.now().getTime() - stat.mtime.getTime();
    const state: SessionState = ageMs > DISCONNECT_THRESHOLD_MS ? "disconnected" : "running";

    this.deps.sessionStore.upsertSession({
      id: meta.sessionId,
      space_id: this.resolveSpaceId(meta.cwd),
      agent: "claude-code",
      title: meta.title,
      state,
      started_at: meta.startedAt ?? undefined,
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
      title: meta.title,
      partial: "",
    });
  }

  // Read just enough of a file to populate the session row. We scan up to
  // ~32KB looking for the first user message (title) and first assistant
  // message (model). Anything past that is irrelevant to the session row.
  private async readSessionMetadata(
    filePath: string,
  ): Promise<{
    sessionId: string;
    cwd: string | null;
    startedAt: string | null;
    model: string | null;
    title: string | null;
  } | null> {
    let buf: Buffer;
    try {
      const fh = await fs.open(filePath, "r");
      try {
        const stat = await fh.stat();
        const len = Math.min(stat.size, 32_768);
        buf = Buffer.alloc(len);
        await fh.read(buf, 0, len, 0);
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
    let title: string | null = null;

    for (const line of buf.toString("utf8").split("\n")) {
      if (!line) continue;
      const ev = safeParse(line);
      if (!ev) continue;

      if (cwd === null && typeof ev.cwd === "string") cwd = ev.cwd;
      if (startedAt === null && typeof ev.timestamp === "string") startedAt = ev.timestamp;
      if (model === null && ev.type === "assistant" && ev.message?.model) {
        model = String(ev.message.model);
      }
      if (title === null && ev.type === "user" && typeof ev.message?.content === "string") {
        title = ev.message.content.trim().slice(0, TITLE_MAX) || null;
      }
      if (cwd && startedAt && model && title) break;
    }

    return { sessionId: sessionIdFromName, cwd, startedAt, model, title };
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
      title: null,
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

    for (const line of lines) {
      if (!line) continue;
      const ev = safeParse(line);
      if (!ev) continue;

      // First event from a brand-new file: derive session metadata and
      // upsert the row before any events are inserted (FK constraint).
      if (!sessionEnsured && tracker.sessionId) {
        if (!tracker.cwd && typeof ev.cwd === "string") tracker.cwd = ev.cwd;
        if (!tracker.startedAt && typeof ev.timestamp === "string") {
          tracker.startedAt = ev.timestamp;
        }
        if (!tracker.title && ev.type === "user" && typeof ev.message?.content === "string") {
          tracker.title = ev.message.content.trim().slice(0, TITLE_MAX) || null;
        }
        if (!tracker.model && ev.type === "assistant" && ev.message?.model) {
          tracker.model = String(ev.message.model);
        }
        this.deps.sessionStore.upsertSession({
          id: tracker.sessionId,
          space_id: this.resolveSpaceId(tracker.cwd),
          agent: "claude-code",
          title: tracker.title,
          state: "running",
          started_at: tracker.startedAt ?? undefined,
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
        for (const block of ev.message.content) {
          const touch = artifactTouchFromToolUse(block);
          if (!touch) continue;
          const artifact = this.deps.artifactStore.getByPath(touch.path);
          if (!artifact) continue;
          // Only attribute touches to artifacts in the same space the session
          // is registered to — guards against accidentally tagging artifacts
          // from a different space if a tool happens to read across.
          if (spaceId && artifact.space_id !== spaceId) continue;
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
      // Bump the session's last_event_at + state to running. If the session
      // was previously 'disconnected' (heartbeat fired during a quiet turn),
      // this brings it back to 'running'.
      const ts = latestTimestamp ?? this.now().toISOString();
      this.deps.sessionStore.updateSessionState(tracker.sessionId, "running", ts);
      this.deps.emitSessionChanged?.(tracker.sessionId);
    }
  }

  // ── Heartbeat ───────────────────────────────────────────────────────────
  // Sessions that are 'running' but haven't seen an event in
  // DISCONNECT_THRESHOLD_MS get demoted to 'disconnected'. Any new file event
  // promotes them back to 'running' inside consumeAppended above.
  private heartbeatSweep(): void {
    const now = this.now().getTime();
    for (const session of this.deps.sessionStore.getAll()) {
      if (session.state !== "running") continue;
      if (session.agent !== "claude-code") continue;
      const last = Date.parse(session.last_event_at);
      if (!Number.isFinite(last)) continue;
      if (now - last > DISCONNECT_THRESHOLD_MS) {
        this.deps.sessionStore.updateSessionState(
          session.id,
          "disconnected",
          session.last_event_at,
        );
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
      const text = blocks
        .map((b: any) => {
          if (b?.type === "text" && typeof b.text === "string") return b.text;
          if (b?.type === "tool_use" && typeof b.name === "string") {
            return `[${b.name}]`;
          }
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

// Convenience for code that doesn't want to import statSync from node:fs.
// Kept for symmetry with chokidar's add/change which give us paths only.
export function isJsonlFile(path: string): boolean {
  if (!path.endsWith(".jsonl")) return false;
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
