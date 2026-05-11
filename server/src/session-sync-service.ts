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
import { join } from "node:path";
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

export interface SessionSyncService {
  reconcile(): Promise<{ pulled: number; pushed: number }>;
  pushPending(): Promise<number>;
  /** Push new jsonl bytes for a session up to cloud as chunked deltas.
   *  Reads from `~/.claude/projects/<encodeCwd(session.cwd)>/<id>.jsonl`
   *  starting at `sessions.jsonl_snapshot_offset`. Handles file truncation
   *  via a generation bump. No-ops cleanly when the file hasn't grown,
   *  when the session row is missing cwd, or when the gate fails. */
  pushBytes(sessionId: string): Promise<PushBytesResult>;
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

    for (let i = 0; i < MAX_BATCHES; i++) {
      const pending = scanDirty.all(session.user.id, BATCH_SIZE) as OutgoingSession[];
      if (pending.length === 0) break;

      let res: Response;
      try {
        res = await deps.fetch(`${deps.workerBase}/api/sessions/metadata`, {
          method: "POST",
          headers: { Cookie: `oyster_session=${session.token}`, "content-type": "application/json" },
          body: JSON.stringify({ sessions: pending }),
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
    `SELECT cwd, jsonl_snapshot_offset, jsonl_chunk_count, bytes_generation, cloud_owner_id
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
      jsonl_snapshot_offset: number;
      jsonl_chunk_count: number;
      bytes_generation: number;
      cloud_owner_id: string | null;
    } | undefined;
    if (!state) {
      console.warn(`[sessions] pushBytes: no session row for ${sessionId}`);
      return empty;
    }
    if (!state.cwd) {
      // Orphan session from before sessions.cwd was added, or a session
      // whose watcher never captured cwd. Nothing to read from disk.
      console.warn(`[sessions] pushBytes: session ${sessionId} has no cwd, skipping`);
      return empty;
    }
    // Owner check: the watcher hook only marks dirty when canRunCloudSync()
    // is true, but pushBytes can also be invoked directly. Guard the same
    // way as markDirty.
    if (state.cloud_owner_id !== session.user.id) {
      console.warn(`[sessions] pushBytes: session ${sessionId} owner mismatch, skipping`);
      return empty;
    }

    const jsonlPath = join(projectsRoot(), encodeCwd(state.cwd), `${sessionId}.jsonl`);
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
          res = await deps.fetch(
            `${deps.workerBase}/api/sessions/bytes/${encodeURIComponent(sessionId)}/chunk/${nextChunkNumber}`,
            {
              method: "PUT",
              headers: {
                Cookie: `oyster_session=${session.token}`,
                "content-type": "application/octet-stream",
                "x-chunk-start-offset": String(startOffset),
                "x-chunk-end-offset": String(endOffset),
                "x-plaintext-sha256": hash,
                "x-bytes-generation": String(generation),
              },
              body: chunkBody,
            },
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
        // problem (conflict, stale gen, non-contiguous) — log and abort.
        // The next reconcile cycle re-derives state from the server's
        // manifest and recovers.
        console.warn(`[sessions] pushBytes chunk ${nextChunkNumber} rejected (${res.status}) for ${sessionId}`);
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

  // Capture the service object so methods don't depend on `this` binding —
  // safe to pass `service.reconcile` directly into a setInterval / event
  // emitter callback. Mirrors the memory-sync-service shape.
  const service: SessionSyncService = {
    async reconcile() {
      const session = isProSession(deps);
      if (!session) return { pulled: 0, pushed: 0 };
      // Pull is PR 2 territory; for now reconcile = pushPending.
      const pushed = await service.pushPending();
      return { pulled: 0, pushed };
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

    markDirty,
  };
  return service;
}
