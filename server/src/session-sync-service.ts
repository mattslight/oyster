// session-sync-service.ts — cross-device sync of agent sessions (#322).
//
// Two flows on top of the same Pro-tier + profile-binding gate:
//
// 1) metadata — row-level dirty tracking on `sessions`. markDirty() flags
//    a row; pushPending() drains dirty rows for the current owner to D1.
//
// 2) bytes — chunked-delta uploads of the jsonl file. pushBytes(sessionId)
//    reads the new bytes since `jsonl_snapshot_offset`, splits into ≤
//    MAX_CHUNK_BYTES chunks (advisory newline-boundary), hashes each, PUTs
//    each as the next chunk in the current generation. Truncation (file
//    shrank) calls /reset and starts over in the next generation.
//
// Mirrors memory-sync-service.ts for the gate / in-flight guard / fetch shape,
// and spaces' sync_dirty_at + cloud_synced_at columns for the dirty predicate.
//
// Sibling pieces (separate PRs):
//   PR 2 will add `pull()` + remote_sessions + lazy bytes pull.
//   PR 3 will add the UI surface (cross-device cards + Resume on this device).

import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { promises as fs } from "node:fs";
import type Database from "better-sqlite3";
import type { ProfileBindingService } from "./profile-binding-service.js";

interface SyncUser { id: string; email: string; tier: string }

export interface SessionSyncDeps {
  db: Database.Database;
  /** Required: gates pull AND push on profile ownership so a second Pro
   *  account signing into the same local profile cannot pollute the local
   *  SQLite with their cloud sessions. Mirrors memory sync. */
  profileBinding: ProfileBindingService;
  currentUser: () => SyncUser | null;
  sessionToken: () => string | null;
  workerBase: string;
  fetch: typeof fetch;
}

export interface PushBytesResult {
  /** Number of chunks pushed in this invocation (0 if nothing new). */
  uploaded: number;
  /** Final plaintext byte offset (== file size at the moment of upload). */
  offsetAfter: number;
  /** Generation chunks were uploaded under. */
  generation: number;
  /** Whether a reset happened (file shrank). */
  resetFired: boolean;
}

export interface ReassembleResult {
  /** Number of chunks fetched and concatenated in this call. 0 on the no-op
   *  branch (local already in sync), partial count on catch-up. */
  chunkCount: number;
  /** Total plaintext bytes written to disk (== manifest's final end_offset). */
  totalBytes: number;
  /** Generation that was reassembled. */
  generation: number;
  /** Absolute path the jsonl was written to. */
  targetPath: string;
}

/** Thrown by reassembleSessionJsonl when the local jsonl can't be reconciled
 *  with the cloud chunk chain (extra bytes past the chain, or mid-chunk
 *  position from a prior crash). Callers should surface this as a 409 with a
 *  structured `local_diverged` status so the UI can offer fork/discard.
 *  Dedicated class so callers branch on `instanceof` instead of string-
 *  matching the message. */
export class LocalDivergedError extends Error {
  readonly name = "LocalDivergedError";
  constructor(message: string) {
    super(message);
  }
}

export interface SessionSyncService {
  reconcile(): Promise<{ pulled: number; pushed: number }>;
  pushPending(): Promise<number>;
  /** Pull session metadata from cloud into `remote_sessions`. Idempotent —
   *  cloud rows are upserted by (owner_id, session_id). Pro-only;
   *  no-op for free users and when profile-bound to a different account.
   *  Returns the count of rows newly inserted or whose cloud_updated_at
   *  advanced. */
  pull(): Promise<number>;
  /** Push new jsonl bytes for a session up to cloud as chunked deltas.
   *  Reads from `~/.claude/projects/<encodeCwd(session.cwd)>/<id>.jsonl`
   *  starting at `sessions.jsonl_snapshot_offset`. Handles file truncation
   *  via a generation bump. No-ops cleanly when the file hasn't grown,
   *  when the session row is missing cwd, or when the gate fails. */
  pushBytes(sessionId: string): Promise<PushBytesResult>;
  /** Pull a session's encrypted chunks down from cloud, decrypt (in the
   *  worker, returned plaintext over TLS), verify each chunk's
   *  plaintext_sha256 against the manifest, and write the assembled
   *  jsonl to targetPath atomically (writes to .partial then renames).
   *  Throws on auth failure, manifest GET error, hash mismatch, partial
   *  fetch, or final-size mismatch. */
  reassembleSessionJsonl(sessionId: string, targetPath: string): Promise<ReassembleResult>;
  /** Mark a session row dirty so the next pushPending() picks it up. The
   *  watcher should call this on every material session change. */
  markDirty(sessionId: string, ownerId: string, at?: number): void;
}

const BATCH_SIZE = 100;

/** Per-chunk cap on the wire. Workers' body limit is 100 MB; staying at
 *  25 MB leaves headroom for encryption overhead. Top-level session size
 *  is unbounded — chunks accumulate as the file grows. */
const MAX_CHUNK_BYTES = 25 * 1024 * 1024;

/** Claude Code's projects root. Read fresh each call so tests can swap the
 *  env var per case without re-importing the module. Exported so the
 *  snapshot timer in index.ts uses the same resolution. */
export function projectsRoot(): string {
  return process.env.OYSTER_CLAUDE_PROJECTS_ROOT ?? join(homedir(), ".claude", "projects");
}

/** Encode an absolute cwd to Claude Code's projects-subdir convention:
 *  every non-alphanumeric character → "-". Verified against real Mac
 *  jsonl paths (e.g. /Users/Matt.Slight/Dev/oyster-os →
 *  -Users-Matt-Slight-Dev-oyster-os). Generic enough to handle Windows
 *  separators too (\, :, etc.) without changes. */
export function encodeCwd(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Find a good split point near the requested size. Prefer the byte just
 *  after the last "\n" within the window so each chunk ends on a complete
 *  jsonl event. Falls back to the raw size when no newline exists (e.g. a
 *  single jsonl line larger than MAX_CHUNK_BYTES). Returned value is in
 *  [1, maxSize]. */
function chooseChunkSize(buf: Uint8Array, maxSize: number): number {
  if (buf.byteLength <= maxSize) return buf.byteLength;
  // Search backwards from maxSize for a "\n" (0x0A). The split is the
  // byte AFTER the newline so the chunk includes it.
  for (let i = maxSize - 1; i >= 0; i--) {
    if (buf[i] === 0x0a) return i + 1;
  }
  // No newline found in the window — split at the cap. Reconstruction is
  // pure byte-order, so this is still correct.
  return maxSize;
}

function isProSession(deps: SessionSyncDeps): { user: SyncUser; token: string } | null {
  const user = deps.currentUser();
  const token = deps.sessionToken();
  if (!user || !token || user.tier !== "pro") return null;
  if (!deps.profileBinding.isOwnedBy(user.id)) {
    console.warn(
      `[sessions] sync blocked — profile is bound to a different account; current=${user.id}, bound=${deps.profileBinding.getBoundOwner()}`,
    );
    return null;
  }
  return { user, token };
}

interface OutgoingSession {
  id: string;
  agent: string;
  title: string | null;
  state: string;
  started_at: string;
  ended_at: string | null;
  model: string | null;
  cwd: string | null;
  last_event_at: string;
  sync_dirty_at: number;
  /** Stable per-device id from the local device_identity singleton.
   *  Attached at push time so cloud knows which device produced each
   *  session — drives the "from MacBook" chip on Device B in PR 3. */
  device_id: string | null;
  /** Human-readable device label from device_identity.label. Sent
   *  alongside device_id so Device B's UI can render "From MacBookPro"
   *  rather than a UUID prefix. Capped at 64 chars worker-side. */
  device_label: string | null;
}

export function createSessionSyncService(deps: SessionSyncDeps): SessionSyncService {
  let inFlightPush: Promise<number> | null = null;

  const markDirtyStmt = deps.db.prepare(
    `UPDATE sessions
        SET sync_dirty_at  = ?,
            cloud_owner_id = ?
      WHERE id = ?`,
  );

  function markDirty(sessionId: string, ownerId: string, at = Date.now()): void {
    markDirtyStmt.run(at, ownerId, sessionId);
  }

  // Dirty predicate mirrors space-sync: a row is pending when sync_dirty_at
  // is set AND cloud_synced_at is either NULL or older than the dirty mark.
  // Restricting to cloud_owner_id = current Pro user is the account-switching
  // guard (don't push another owner's events; same posture as memory sync).
  const scanDirty = deps.db.prepare(
    `SELECT id, agent, title, state, started_at, ended_at, model, cwd,
            last_event_at, sync_dirty_at
       FROM sessions
      WHERE sync_dirty_at IS NOT NULL
        AND cloud_owner_id = ?
        AND (cloud_synced_at IS NULL OR cloud_synced_at < sync_dirty_at)
      ORDER BY sync_dirty_at ASC
      LIMIT ?`,
  );

  // Owner-scoped on the WHERE clause: if the server somehow echoes back an id
  // that belongs to a different cloud_owner_id (account-switch race, server
  // bug), refuse to mark it synced. Defensive — push is already owner-scoped
  // on the scan side, but layered checks are cheap.
  const markSyncedStmt = deps.db.prepare(
    `UPDATE sessions
        SET cloud_synced_at = ?
      WHERE id = ? AND cloud_owner_id = ?`,
  );

  async function doPushPending(): Promise<number> {
    const session = isProSession(deps);
    if (!session) return 0;

    let totalAccepted = 0;
    const MAX_BATCHES = 1000;  // defensive safety cap

    // Cache device id + label once per drain — neither changes during a
    // server lifetime. NULL is tolerated (cloud upsert accepts both) but a
    // missing device_identity seed warns so it's visible.
    const myDeviceId = getMyDeviceId();
    const myDeviceLabel = getMyDeviceLabel();
    if (!myDeviceId) {
      console.warn("[sessions] pushPending: device_identity not seeded; pushing without device_id");
    }

    for (let i = 0; i < MAX_BATCHES; i++) {
      const pending = scanDirty.all(session.user.id, BATCH_SIZE) as OutgoingSession[];
      if (pending.length === 0) break;

      // Stamp every row with this device's id + label at push time. Rows in
      // the local `sessions` table don't carry these columns — they're
      // implicitly produced by this device because the watcher only sees
      // its own filesystem.
      const stamped = pending.map((s) => ({
        ...s,
        device_id: myDeviceId,
        device_label: myDeviceLabel,
      }));

      let res: Response;
      try {
        res = await deps.fetch(`${deps.workerBase}/api/sessions/metadata`, {
          method: "POST",
          headers: { Cookie: `oyster_session=${session.token}`, "content-type": "application/json" },
          body: JSON.stringify({ sessions: stamped }),
        });
      } catch (err) {
        console.warn("[sessions] pushPending failed:", err);
        return totalAccepted;
      }
      if (!res.ok) {
        console.warn(`[sessions] pushPending non-ok ${res.status}`);
        return totalAccepted;
      }
      const body = await res.json().catch(() => null) as { accepted?: string[] } | null;
      const accepted = body?.accepted ?? [];

      // Mark accepted rows synced. Use Date.now() as cloud_synced_at — any
      // sync_dirty_at <= this value is considered cleared. If the row was
      // dirtied AGAIN between scan and ack, the new sync_dirty_at will be
      // > cloud_synced_at and the next scan picks it up.
      const now = Date.now();
      const tx = deps.db.transaction(() => {
        for (const id of accepted) markSyncedStmt.run(now, id, session.user.id);
      });
      tx();
      totalAccepted += accepted.length;

      if (accepted.length > 0) {
        console.log(`[sessions] pushed: accepted=${accepted.length}`);
      }
      // If nothing was accepted, breaking avoids hot-looping on a server
      // that returns empty acks.
      if (accepted.length === 0) break;
    }

    return totalAccepted;
  }

  // pushBytes state. A per-session in-flight guard prevents the snapshot
  // timer firing two parallel pushes for the same session (which would
  // double-PUT and trigger conflict 409s).
  const inFlightBytes = new Map<string, Promise<PushBytesResult>>();

  const getBytesState = deps.db.prepare(
    `SELECT cwd, jsonl_path, jsonl_snapshot_offset, jsonl_chunk_count, bytes_generation, cloud_owner_id
       FROM sessions WHERE id = ? LIMIT 1`,
  );
  const advanceBytesState = deps.db.prepare(
    `UPDATE sessions
        SET jsonl_snapshot_offset = ?,
            jsonl_chunk_count     = ?,
            jsonl_synced_at       = ?
      WHERE id = ?`,
  );
  const bumpGeneration = deps.db.prepare(
    `UPDATE sessions
        SET bytes_generation       = bytes_generation + 1,
            jsonl_snapshot_offset  = 0,
            jsonl_chunk_count      = 0
      WHERE id = ?`,
  );

  async function doPushBytes(sessionId: string): Promise<PushBytesResult> {
    const empty: PushBytesResult = { uploaded: 0, offsetAfter: 0, generation: 0, resetFired: false };

    const session = isProSession(deps);
    if (!session) return empty;

    // Metadata must be in cloud before chunk PUTs — the worker rejects chunks
    // for unknown sessions with 404 session_not_found. Without this await,
    // a boot-scan that fires pushBytes alongside pushPending for many
    // freshly-dirty sessions hits a race: chunk PUT arrives before metadata
    // upsert, gets 404, the chunk is lost until the next reconcile.
    // Drain any pending metadata first. In-flight guard makes concurrent
    // pushBytes calls share the same pushPending promise.
    try {
      await service.pushPending();
    } catch (err) {
      console.warn("[sessions] pushBytes: pre-flight pushPending failed:", err);
      // Continue anyway — pushPending might be transiently failing; the
      // chunk PUT will surface its own error if metadata still isn't there.
    }

    const state = getBytesState.get(sessionId) as {
      cwd: string | null;
      jsonl_path: string | null;
      jsonl_snapshot_offset: number;
      jsonl_chunk_count: number;
      bytes_generation: number;
      cloud_owner_id: string | null;
    } | undefined;
    if (!state) {
      console.warn(`[sessions] pushBytes: no session row for ${sessionId}`);
      return empty;
    }
    // Owner check: the watcher hook only marks dirty when canRunCloudSync()
    // is true, but pushBytes can also be invoked directly. Guard the same
    // way as markDirty.
    if (state.cloud_owner_id !== session.user.id) {
      console.warn(`[sessions] pushBytes: session ${sessionId} owner mismatch, skipping`);
      return empty;
    }

    // Prefer the watcher-recorded path. Cross-device resumed sessions have
    // events that still carry the origin device's cwd (e.g. "C:\\Users\\matth"
    // on a Mac-resumed Windows session), so encoding sessions.cwd back into
    // a local path doesn't work. The watcher stores the real on-disk path
    // on every upsert. Fall back to the encoded-cwd computation for rows
    // that pre-date the jsonl_path column.
    const jsonlPath = state.jsonl_path
      ?? (state.cwd ? join(projectsRoot(), encodeCwd(state.cwd), `${sessionId}.jsonl`) : null);
    if (!jsonlPath) {
      // Orphan session from before sessions.cwd / jsonl_path columns; the
      // watcher never captured a location. Nothing to read.
      console.warn(`[sessions] pushBytes: session ${sessionId} has no jsonl_path or cwd, skipping`);
      return empty;
    }
    let stat: { size: number };
    try {
      const s = await fs.stat(jsonlPath);
      stat = { size: s.size };
    } catch (err) {
      console.warn(`[sessions] pushBytes: cannot stat ${jsonlPath}:`, err);
      return empty;
    }

    let offset = state.jsonl_snapshot_offset;
    let chunkCount = state.jsonl_chunk_count;
    let generation = state.bytes_generation;
    let resetFired = false;

    // Truncation handling: if the local file is now smaller than what we
    // already uploaded, the file was rewritten / rotated. Bump the
    // generation on cloud, reset local counters, restart from offset 0
    // in the new generation. Rare in practice.
    if (stat.size < offset) {
      try {
        const resetRes = await deps.fetch(
          `${deps.workerBase}/api/sessions/bytes/${encodeURIComponent(sessionId)}/reset`,
          {
            method: "POST",
            headers: { Cookie: `oyster_session=${session.token}` },
          },
        );
        if (!resetRes.ok) {
          console.warn(`[sessions] pushBytes reset non-ok ${resetRes.status} for ${sessionId}`);
          return { uploaded: 0, offsetAfter: offset, generation, resetFired: false };
        }
      } catch (err) {
        console.warn(`[sessions] pushBytes reset failed for ${sessionId}:`, err);
        return { uploaded: 0, offsetAfter: offset, generation, resetFired: false };
      }
      bumpGeneration.run(sessionId);
      offset = 0;
      chunkCount = 0;
      generation += 1;
      resetFired = true;
    }

    if (stat.size <= offset) {
      // No new bytes to push (and no truncation either — caught above).
      return { uploaded: 0, offsetAfter: offset, generation, resetFired };
    }

    // Stream pending bytes one chunk at a time, capped at MAX_CHUNK_BYTES.
    // A user offline for a while may have a multi-hundred-MB pending region;
    // we must NOT Buffer.alloc the whole thing or we OOM the server process.
    //
    // The read window starts at PROBE_WINDOW (MAX_CHUNK_BYTES + tail slack)
    // so we can find a newline boundary up to MAX_CHUNK_BYTES back from the
    // top of the window. If no newline exists in that window, we fall back
    // to a hard MAX_CHUNK_BYTES slice (per the byte-order reconstruction
    // contract — JSON-awareness is advisory).
    let fh: import("node:fs/promises").FileHandle | null = null;
    let uploaded = 0;
    let pushedBytes = 0;  // plaintext bytes successfully uploaded this call
    try {
      fh = await fs.open(jsonlPath, "r");

      while (offset + pushedBytes < stat.size) {
        const cursor = offset + pushedBytes;
        const remainingTotal = stat.size - cursor;
        const windowSize = Math.min(remainingTotal, MAX_CHUNK_BYTES);
        const windowBuf = Buffer.alloc(windowSize);
        const { bytesRead } = await fh.read(windowBuf, 0, windowSize, cursor);
        if (bytesRead === 0) break;  // shouldn't happen given the loop guard
        const window = windowBuf.subarray(0, bytesRead);

        // chooseChunkSize keeps us at-or-under MAX_CHUNK_BYTES and prefers a
        // newline boundary. For the final chunk it returns the remaining
        // size (which equals bytesRead, == remainingTotal when ≤ cap).
        const sliceSize = chooseChunkSize(window, MAX_CHUNK_BYTES);
        const chunkBytes = window.subarray(0, sliceSize);

        // Copy into a detached ArrayBuffer so the fetch BodyInit type is
        // happy and the chunk can be released after the PUT regardless of
        // what runtime fetch does internally.
        const chunkBody = new ArrayBuffer(sliceSize);
        new Uint8Array(chunkBody).set(chunkBytes);

        const startOffset = cursor;
        const endOffset = startOffset + sliceSize;
        const hash = sha256Hex(new Uint8Array(chunkBody));
        const nextChunkNumber = chunkCount + 1;

        let res: Response;
        try {
          const headers: Record<string, string> = {
            Cookie: `oyster_session=${session.token}`,
            "content-type": "application/octet-stream",
            "x-chunk-start-offset": String(startOffset),
            "x-chunk-end-offset": String(endOffset),
            "x-plaintext-sha256": hash,
            "x-bytes-generation": String(generation),
          };
          // Stamp the writing device on every chunk so cloud can track who's
          // active. Worker uses this to bump synced_session_metadata.
          // active_device_id, which other devices read to render "Active on
          // <device>" in their session list.
          const myDeviceId = getMyDeviceId();
          if (myDeviceId) headers["x-bytes-device-id"] = myDeviceId;
          res = await deps.fetch(
            `${deps.workerBase}/api/sessions/bytes/${encodeURIComponent(sessionId)}/chunk/${nextChunkNumber}`,
            { method: "PUT", headers, body: chunkBody },
          );
        } catch (err) {
          console.warn(`[sessions] pushBytes chunk ${nextChunkNumber} fetch failed for ${sessionId}:`, err);
          break;
        }

        if (res.status === 200) {
          // Persist after every chunk so a mid-loop crash doesn't re-upload
          // bytes already in cloud. snapshot_offset advances by exactly
          // sliceSize plaintext bytes.
          chunkCount = nextChunkNumber;
          pushedBytes += sliceSize;
          advanceBytesState.run(offset + pushedBytes, chunkCount, Date.now(), sessionId);
          uploaded++;
          continue;
        }

        // Per the worker's idempotency contract, an exact-match retry returns
        // 200 idempotent:true (not 409). So any non-200 here is a real
        // problem — most commonly a 409 because another device is now the
        // active writer (Pattern A hand-off scenario): cloud already has
        // chunk_number N+1 from them with different bytes, so this device's
        // contiguous-offset push fails.
        const body = await res.json().catch(() => null) as { error?: string } | null;
        const reason = body?.error ?? `http_${res.status}`;
        if (reason === "non_contiguous_start" || reason === "chunk_conflict" || reason === "stale_generation") {
          // The user-facing framing for these all collapses to "this session
          // was continued on another device or has divergent local edits."
          // PR 3 surfaces this as a banner; for now a clear log is the only
          // signal.
          console.warn(
            `[sessions] session=${sessionId.slice(0, 8)} chunk ${nextChunkNumber} rejected: ${reason} — session likely continued on another device or local jsonl has divergent edits. Next reconcile will refresh state.`,
          );
        } else {
          console.warn(`[sessions] pushBytes chunk ${nextChunkNumber} rejected (${res.status} ${reason}) for ${sessionId}`);
        }
        break;
      }
    } catch (err) {
      console.warn(`[sessions] pushBytes loop failed for ${jsonlPath}:`, err);
    } finally {
      if (fh) await fh.close().catch(() => { /* ignore */ });
    }

    // Match the [sessions] pushed: accepted=N style from pushPending — only
    // log when something actually moved through this call. sessionId truncated
    // to the first 8 chars to keep lines scannable while preserving the
    // useful "which session" hint.
    if (uploaded > 0) {
      console.log(
        `[sessions] pushed chunks: session=${sessionId.slice(0, 8)} count=${uploaded} gen=${generation} bytes=${pushedBytes}${resetFired ? " (after reset)" : ""}`,
      );
    }

    return { uploaded, offsetAfter: offset + pushedBytes, generation, resetFired };
  }

  // In-flight guard for pull so concurrent reconcile triggers (focus +
  // panel-mount + 30s-poll firing in quick succession) coalesce to one
  // HTTP round-trip. Same shape as pushPending's guard.
  let inFlightPull: Promise<number> | null = null;

  const upsertRemoteSession = deps.db.prepare(
    `INSERT INTO remote_sessions
       (session_id, owner_id, device_id, device_label, agent, title, state, cwd, model,
        started_at, ended_at, last_event_at, bytes_generation, has_bytes, total_bytes,
        active_device_id, cloud_updated_at, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(owner_id, session_id) DO UPDATE SET
       device_id         = excluded.device_id,
       -- Preserve a known label if cloud sends NULL (legacy row, or
       -- transient race where a partial-shape session arrived). Only a
       -- non-null cloud value replaces what we have.
       device_label      = COALESCE(excluded.device_label, remote_sessions.device_label),
       agent             = excluded.agent,
       title             = excluded.title,
       state             = excluded.state,
       cwd               = excluded.cwd,
       model             = excluded.model,
       started_at        = excluded.started_at,
       ended_at          = excluded.ended_at,
       last_event_at     = excluded.last_event_at,
       bytes_generation  = excluded.bytes_generation,
       has_bytes         = excluded.has_bytes,
       -- Preserve a known total_bytes if cloud sends NULL (mid-rollout
       -- where the worker hasn't been updated yet, or a partial-shape
       -- response). Only a non-null cloud value replaces what we have.
       total_bytes       = COALESCE(excluded.total_bytes, remote_sessions.total_bytes),
       active_device_id  = excluded.active_device_id,
       cloud_updated_at  = excluded.cloud_updated_at,
       fetched_at        = excluded.fetched_at
     WHERE excluded.cloud_updated_at > remote_sessions.cloud_updated_at`,
  );

  async function doPull(): Promise<number> {
    const session = isProSession(deps);
    if (!session) return 0;

    let res: Response;
    try {
      res = await deps.fetch(`${deps.workerBase}/api/sessions/metadata`, {
        headers: { Cookie: `oyster_session=${session.token}` },
      });
    } catch (err) {
      console.warn("[sessions] pull failed:", err);
      return 0;
    }
    if (!res.ok) {
      console.warn(`[sessions] pull non-ok ${res.status}`);
      return 0;
    }

    type CloudSession = {
      session_id: string;
      device_id: string | null;
      device_label: string | null;
      agent: string;
      title: string | null;
      state: string;
      cwd: string | null;
      model: string | null;
      started_at: string;
      ended_at: string | null;
      last_event_at: string;
      bytes_generation: number;
      has_bytes: boolean;
      total_bytes: number;
      active_device_id: string | null;
      updated_at: number;
    };
    const body = await res.json().catch(() => null) as { sessions?: CloudSession[] } | null;
    const incoming = body?.sessions ?? [];
    if (incoming.length === 0) return 0;

    // Filter out anything that's really a local session in disguise.
    // Two guards:
    //   1. device_id matches ours (cloud explicitly tagged this row as ours).
    //   2. session_id collides with a row in the local `sessions` table
    //      (the watcher's source-of-truth for sessions produced here —
    //      catches the legacy case where cloud rows have NULL device_id
    //      from before the device_id capture fix).
    // Either guard is sufficient. Without (2), NULL-device_id rows that
    // are actually our own session would have leaked into remote_sessions
    // and then back into Home's merged list as ghost "from another device"
    // entries.
    const myDeviceId = getMyDeviceId();
    const localIds = new Set(
      (deps.db.prepare(`SELECT id FROM sessions`).all() as Array<{ id: string }>).map((r) => r.id),
    );
    const foreignRows = incoming.filter((s) =>
      s.device_id !== myDeviceId && !localIds.has(s.session_id),
    );

    const now = Date.now();
    let applied = 0;
    const tx = deps.db.transaction(() => {
      for (const s of foreignRows) {
        const info = upsertRemoteSession.run(
          s.session_id, session.user.id, s.device_id, s.device_label ?? null,
          s.agent, s.title, s.state, s.cwd, s.model,
          s.started_at, s.ended_at, s.last_event_at,
          // total_bytes is NULL when the cloud worker hasn't been upgraded
          // to the version that returns it. Preserve NULL on the wire so
          // the upsert can decide whether to overwrite an existing known
          // value (see COALESCE in upsertRemoteSession). Coercing to 0
          // would defeat the "NULL = unknown, leave row visible" exemption
          // in the ghost-session filter and could hide real sessions
          // during a server-ahead-of-worker rollout window.
          s.bytes_generation, s.has_bytes ? 1 : 0, s.total_bytes ?? null,
          s.active_device_id ?? null,
          s.updated_at, now,
        );
        if (info.changes > 0) applied++;
      }
    });
    tx();

    if (applied > 0) {
      console.log(`[sessions] pulled: applied=${applied}`);
    }
    return applied;
  }

  /** Stable per-device identity; lazy-initialised on first successful
   *  read. We cache ONLY on success — a missing device_identity row
   *  means the install seed hasn't run yet (test setup, repair flows,
   *  or first-boot ordering), and we want subsequent calls to retry
   *  rather than locking in a null forever. Once seeded, the row never
   *  changes for the process lifetime, so one cache is enough. */
  let cachedDeviceIdentity: { device_id: string; label: string } | null = null;
  function loadDeviceIdentity(): { device_id: string | null; label: string | null } {
    if (cachedDeviceIdentity !== null) return cachedDeviceIdentity;
    const row = deps.db.prepare(
      `SELECT device_id, label FROM device_identity WHERE id = 1 LIMIT 1`,
    ).get() as { device_id: string; label: string } | undefined;
    if (row) {
      cachedDeviceIdentity = row;
      return row;
    }
    // Don't cache the null result — next caller retries.
    return { device_id: null, label: null };
  }
  function getMyDeviceId(): string | null { return loadDeviceIdentity().device_id; }
  function getMyDeviceLabel(): string | null { return loadDeviceIdentity().label; }

  const updateRemoteSessionLocalPath = deps.db.prepare(
    `UPDATE remote_sessions
        SET jsonl_local_path = ?
      WHERE owner_id = ? AND session_id = ?`,
  );

  // Seed the local sessions bookkeeping to match cloud's chain at the
  // moment of reassemble. Without this, the watcher's later upsert
  // creates a row with jsonl_snapshot_offset = 0 and pushBytes tries to
  // re-upload chunk 1 from byte 0 — which the worker rejects as
  // chunk_conflict because cloud already has chunk 1 with different bytes.
  //
  // With the seed, the row tells the truth: "cloud has this much of me
  // already; push only what's past expectedTotal." Subsequent Mac turns
  // become chunk N+1, the chain stays linear (Pattern A).
  //
  // INSERT path covers the case where the file is reassembled before the
  // user runs `claude --resume` (no watcher upsert has fired yet).
  // UPDATE path covers the inverse race + heals existing 0/0/0 rows on
  // re-resume.
  //
  // Carefully chosen columns:
  //  - last_event_at on INSERT comes from remote_sessions (cloud truth).
  //    The watcher's upsert uses MAX(...) so a NOW value would ratchet
  //    last_event_at forward and prevent the watcher from later setting
  //    the real transcript timestamp.
  //  - cloud_synced_at is left alone — it's the *metadata* push-ack
  //    timestamp and is part of the dirty predicate; touching it could
  //    falsely mark a dirty row as synced. Bytes-side ack lives in
  //    jsonl_synced_at instead.
  const getRemoteLastEventAt = deps.db.prepare(
    `SELECT last_event_at FROM remote_sessions
       WHERE owner_id = ? AND session_id = ? LIMIT 1`,
  );
  const seedSessionBytesStateAtReassemble = deps.db.prepare(
    `INSERT INTO sessions
       (id, agent, state, started_at, last_event_at,
        cwd, jsonl_path,
        jsonl_snapshot_offset, jsonl_chunk_count, bytes_generation,
        cloud_owner_id, jsonl_synced_at)
     VALUES
       (@id, 'claude-code', 'waiting', @now_iso,
        COALESCE(@last_event_at_iso, @now_iso),
        NULL, @jsonl_path,
        @offset, @chunk_count, @generation,
        @owner_id, @now_ms)
     ON CONFLICT(id) DO UPDATE SET
       jsonl_path            = excluded.jsonl_path,
       jsonl_snapshot_offset = excluded.jsonl_snapshot_offset,
       jsonl_chunk_count     = excluded.jsonl_chunk_count,
       bytes_generation      = excluded.bytes_generation,
       cloud_owner_id        = excluded.cloud_owner_id,
       jsonl_synced_at       = excluded.jsonl_synced_at`,
  );

  function seedReassembledBookkeeping(
    sessionId: string,
    ownerId: string,
    targetPath: string,
    manifest: { bytes_generation: number; chunks: Array<{ chunk_number: number }> },
    expectedTotal: number,
  ): void {
    const now = Date.now();
    const remoteRow = getRemoteLastEventAt.get(ownerId, sessionId) as
      { last_event_at: string | null } | undefined;
    seedSessionBytesStateAtReassemble.run({
      id: sessionId,
      jsonl_path: targetPath,
      offset: expectedTotal,
      chunk_count: manifest.chunks.length,
      generation: manifest.bytes_generation,
      owner_id: ownerId,
      now_iso: new Date(now).toISOString(),
      now_ms: now,
      last_event_at_iso: remoteRow?.last_event_at ?? null,
    });
  }

  async function doReassemble(
    sessionId: string,
    targetPath: string,
  ): Promise<ReassembleResult> {
    const session = isProSession(deps);
    if (!session) {
      throw new Error("sessions reassemble: pro-only and profile-binding gate failed");
    }

    // Fetch manifest.
    type ManifestChunk = {
      chunk_number: number;
      start_offset: number;
      end_offset: number;
      byte_count: number;
      plaintext_sha256: string;
    };
    type Manifest = {
      bytes_generation: number;
      total_size: number;
      active_device_id: string | null;
      chunks: ManifestChunk[];
    };

    let manifest: Manifest;
    try {
      const res = await deps.fetch(
        `${deps.workerBase}/api/sessions/bytes/${encodeURIComponent(sessionId)}/manifest`,
        { headers: { Cookie: `oyster_session=${session.token}` } },
      );
      if (!res.ok) throw new Error(`manifest non-ok ${res.status}`);
      manifest = await res.json() as Manifest;
    } catch (err) {
      throw new Error(`sessions reassemble: manifest fetch failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (!manifest.chunks || manifest.chunks.length === 0) {
      throw new Error("sessions reassemble: manifest has no chunks (no bytes uploaded yet)");
    }
    // Sanity: chunks must be in chunk_number order. The worker promises this
    // (ORDER BY chunk_number ASC) but verify defensively.
    for (let i = 1; i < manifest.chunks.length; i++) {
      if (manifest.chunks[i]!.chunk_number <= manifest.chunks[i - 1]!.chunk_number) {
        throw new Error("sessions reassemble: manifest chunks not in ascending order");
      }
    }

    const expectedTotal = manifest.chunks[manifest.chunks.length - 1]!.end_offset;

    // Probe the local file. Three states matter (Pattern A from the design):
    //   1. No local file (or empty) → full fresh reassemble.
    //   2. Local size == cloud total → no-op, session is already in sync.
    //   3. Local size < cloud total AND aligns with a chunk boundary → catch up,
    //      append the missing tail chunks.
    //   4. Local size > cloud total → "local_diverged": this device has unsynced
    //      edits past the cloud chunk chain. Block and surface conflict.
    //   5. Local size doesn't match any chunk boundary → also divergent (mid-
    //      chunk position from a prior crash or hand-edit).
    let localSize = 0;
    try {
      localSize = (await fs.stat(targetPath)).size;
    } catch {
      // No local file — fall through to full reassemble (localSize stays 0).
    }

    if (localSize === expectedTotal) {
      // Already up-to-date — nothing to fetch. Just record the path.
      updateRemoteSessionLocalPath.run(targetPath, session.user.id, sessionId);
      seedReassembledBookkeeping(sessionId, session.user.id, targetPath, manifest, expectedTotal);
      console.log(
        `[sessions] reassemble: session=${sessionId.slice(0, 8)} already up-to-date (${localSize} bytes)`,
      );
      return {
        chunkCount: 0,
        totalBytes: localSize,
        generation: manifest.bytes_generation,
        targetPath,
      };
    }

    if (localSize > expectedTotal) {
      throw new LocalDivergedError(
        `local jsonl is ${localSize} bytes but cloud chain is ${expectedTotal}. ` +
        `This device has local-only edits past the cloud chunk chain. ` +
        `Resolve by discarding local or forking to a new session.`,
      );
    }

    // Find the first chunk we still need to fetch.
    let firstIdx = 0;
    if (localSize > 0) {
      firstIdx = manifest.chunks.findIndex((c) => c.start_offset === localSize);
      if (firstIdx < 0) {
        throw new LocalDivergedError(
          `local jsonl is ${localSize} bytes but no manifest chunk starts at that offset. ` +
          `File is mid-chunk or contains bytes not present in any chunk.`,
        );
      }
    }

    // Two write strategies based on whether this is a fresh reassemble or a
    // catch-up append:
    //   - Fresh (firstIdx === 0): write to a .partial sibling then rename on
    //     success, so a mid-fetch crash leaves a discardable artefact rather
    //     than a half-baked jsonl masquerading as complete.
    //   - Catch-up (firstIdx > 0): open the existing file in r+ mode, write
    //     new chunks at their declared offsets. On failure, truncate back to
    //     localSize so the file isn't left in a divergent state.
    const isFresh = firstIdx === 0;
    const writePath = isFresh ? `${targetPath}.partial` : targetPath;
    await fs.mkdir(dirname(targetPath), { recursive: true }).catch(() => { /* exists */ });
    const fh = await fs.open(writePath, isFresh ? "w" : "r+");
    let writtenBytes = isFresh ? 0 : localSize;
    try {
      for (let i = firstIdx; i < manifest.chunks.length; i++) {
        const meta = manifest.chunks[i]!;
        const url = `${deps.workerBase}/api/sessions/bytes/${encodeURIComponent(sessionId)}/chunk/${meta.chunk_number}`;
        const r = await deps.fetch(url, { headers: { Cookie: `oyster_session=${session.token}` } });
        if (!r.ok) {
          throw new Error(`chunk ${meta.chunk_number} fetch non-ok ${r.status}`);
        }
        const buf = new Uint8Array(await r.arrayBuffer());
        if (buf.byteLength !== meta.byte_count) {
          throw new Error(`chunk ${meta.chunk_number} size mismatch: expected ${meta.byte_count}, got ${buf.byteLength}`);
        }
        const hash = sha256Hex(buf);
        if (hash !== meta.plaintext_sha256) {
          throw new Error(`chunk ${meta.chunk_number} hash mismatch: expected ${meta.plaintext_sha256}, got ${hash}`);
        }
        await fh.write(buf, 0, buf.byteLength, meta.start_offset);
        writtenBytes += buf.byteLength;
      }
    } catch (err) {
      await fh.close().catch(() => { /* ignore */ });
      if (isFresh) {
        await fs.unlink(writePath).catch(() => { /* ignore */ });
      } else {
        // Best-effort rollback to the size we trusted at entry. Next call
        // restarts the catch-up cleanly.
        await fs.truncate(targetPath, localSize).catch(() => { /* ignore */ });
      }
      throw err;
    }
    await fh.close();

    if (writtenBytes !== expectedTotal) {
      if (isFresh) {
        await fs.unlink(writePath).catch(() => { /* ignore */ });
      } else {
        await fs.truncate(targetPath, localSize).catch(() => { /* ignore */ });
      }
      throw new Error(`sessions reassemble: total size mismatch (wrote ${writtenBytes}, manifest says ${expectedTotal})`);
    }

    if (isFresh) {
      await fs.rename(writePath, targetPath);
    }

    updateRemoteSessionLocalPath.run(targetPath, session.user.id, sessionId);
    seedReassembledBookkeeping(sessionId, session.user.id, targetPath, manifest, writtenBytes);

    if (isFresh) {
      console.log(
        `[sessions] reassembled: session=${sessionId.slice(0, 8)} chunks=${manifest.chunks.length} bytes=${writtenBytes} → ${targetPath}`,
      );
    } else {
      console.log(
        `[sessions] reassembled (catch-up): session=${sessionId.slice(0, 8)} appended=${manifest.chunks.length - firstIdx} chunks new_bytes=${writtenBytes - localSize} total=${writtenBytes} → ${targetPath}`,
      );
    }

    return {
      chunkCount: manifest.chunks.length - firstIdx,
      totalBytes: writtenBytes,
      generation: manifest.bytes_generation,
      targetPath,
    };
  }

  // Capture the service object so methods don't depend on `this` binding —
  // safe to pass `service.reconcile` directly into a setInterval / event
  // emitter callback. Mirrors the memory-sync-service shape.
  const service: SessionSyncService = {
    async reconcile() {
      const session = isProSession(deps);
      if (!session) return { pulled: 0, pushed: 0 };
      // Mirror memory-sync: pull first so we have the latest cloud state
      // visible locally, then push any local-only changes back up.
      const pulled = await service.pull();
      const pushed = await service.pushPending();
      return { pulled, pushed };
    },

    async pull() {
      if (inFlightPull) return inFlightPull;
      inFlightPull = doPull();
      try {
        return await inFlightPull;
      } finally {
        inFlightPull = null;
      }
    },

    async pushPending() {
      if (inFlightPush) return inFlightPush;
      inFlightPush = doPushPending();
      try {
        return await inFlightPush;
      } finally {
        inFlightPush = null;
      }
    },

    async pushBytes(sessionId: string) {
      const existing = inFlightBytes.get(sessionId);
      if (existing) return existing;
      const promise = doPushBytes(sessionId).finally(() => {
        inFlightBytes.delete(sessionId);
      });
      inFlightBytes.set(sessionId, promise);
      return promise;
    },

    reassembleSessionJsonl: doReassemble,

    markDirty,
  };
  return service;
}
