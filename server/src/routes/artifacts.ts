// /api/artifacts/*, /api/groups/*, /api/plugins/*/uninstall — extracted
// from index.ts. Returns true when matched; falls through otherwise.
//
// Out of scope for this bucket (will move with their own siblings):
//   - /api/resolve-path  — URL→filesystem resolver
//   - /api/apps/:name/*  — app runtime control
//   - /docs/:name, /artifacts/*  — static file serving

import type { IncomingMessage, ServerResponse } from "node:http";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { SessionStore } from "../session-store.js";
import type { ArtifactService } from "../artifact-service.js";
import type { RouteCtx } from "../http-utils.js";
import { safeDecode } from "../http-utils.js";
import { mapSessionRow } from "./sessions.js";

export interface ArtifactRouteDeps {
  artifactService: ArtifactService;
  sessionStore: SessionStore;
  /** Mutable Set populated by reveal_artifact (MCP). Drained by
   *  GET /api/artifacts so the surface highlights the artefact once
   *  and then forgets. */
  pendingReveals: Set<string>;
  /** Clear the artifact-detector's "seen" cache when the service drops
   *  a row whose backing file is gone. Without this, the watcher would
   *  re-add the missing artefact on its next tick. */
  clearSeenArtifact: (id: string) => void;
  /** Layout constants — passed in rather than re-derived so the route
   *  module stays decoupled from index.ts's userland resolution. */
  OYSTER_HOME: string;
  APPS_DIR: string;
  SPACES_DIR: string;
  /** Optional publish service. When the renamed artefact is currently
   *  published, the new label is mirrored to D1 so other devices catch
   *  up without needing the artefact to be re-published. */
  publishService?: import("../publish-service.js").PublishService;
}

export async function tryHandleArtifactRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: string,
  ctx: RouteCtx,
  deps: ArtifactRouteDeps,
): Promise<boolean> {
  const { sendJson, sendError, readJsonBody, rejectIfNonLocalOrigin } = ctx;
  const {
    artifactService, sessionStore, pendingReveals,
    clearSeenArtifact, OYSTER_HOME, APPS_DIR, SPACES_DIR, publishService,
  } = deps;

  // GET /api/artifacts/:id/sessions — sessions that touched this artefact (M:N reverse).
  // Must come BEFORE the generic /api/artifacts/:id PATCH handler so "/sessions"
  // suffix is never interpreted as an artifact id.
  {
    const m = url.match(/^\/api\/artifacts\/([^/]+)\/sessions$/);
    if (m && req.method === "GET") {
      if (rejectIfNonLocalOrigin()) return true;
      const touches = sessionStore.getSessionsByArtifact(m[1]);
      const allSessions = sessionStore.getAll();
      const byId = new Map(allSessions.map((s) => [s.id, s]));
      sendJson(touches.flatMap((t) => {
        const s = byId.get(t.session_id);
        if (!s) return [];
        return [{
          id: t.id,
          sessionId: t.session_id,
          artifactId: t.artifact_id,
          role: t.role,
          whenAt: t.when_at,
          session: mapSessionRow(s),
        }];
      }));
      return true;
    }
  }

  // GET /api/artifacts — the full live artifact list. Local-origin-only:
  // contains user-private artifact metadata that a malicious cross-origin
  // page could otherwise enumerate against a running local Oyster.
  if (url === "/api/artifacts") {
    if (rejectIfNonLocalOrigin()) return true;
    const artifacts = await artifactService.getAllArtifacts((id) => clearSeenArtifact(id));
    const revealed = new Set(pendingReveals);
    pendingReveals.clear();
    sendJson(artifacts.map((a) => revealed.has(a.id) ? { ...a, pendingReveal: true } : a));
    return true;
  }

  // ── Artifact mutations (context-menu actions on the desktop) ──
  // PATCH /api/artifacts/:id   — rename and/or move to/from a group
  // POST  /api/artifacts/:id/archive — soft-delete (removed_at set)
  // PATCH /api/groups          — rename a group across all artifacts in a space
  // POST  /api/groups/archive  — archive all artifacts in a group

  // GET /api/artifacts/archived — list soft-deleted rows for the Archived view.
  // Must match BEFORE the :id-scoped routes below so "archived" is never
  // interpreted as an artifact id (e.g. PATCH /api/artifacts/archived
  // would otherwise hit the rename handler with id="archived"). Locked to
  // local origins for the same reason the mutation endpoints are — the
  // list contains user-private artifact metadata.
  if (url === "/api/artifacts/archived" && req.method === "GET") {
    if (rejectIfNonLocalOrigin()) return true;
    try {
      const archived = await artifactService.getArchivedArtifacts();
      sendJson(archived);
    } catch (err) {
      sendError(err, 500);
    }
    return true;
  }

  const artifactMatch = url.match(/^\/api\/artifacts\/([^/]+)$/);
  if (artifactMatch && req.method === "PATCH") {
    if (rejectIfNonLocalOrigin()) return true;
    const id = safeDecode(artifactMatch[1]);
    if (id === null) { sendJson({ error: "Invalid URL encoding" }, 400); return true; }
    try {
      const body = await readJsonBody();
      const fields: { label?: string; group_name?: string | null } = {};
      if ("label" in body) {
        if (typeof body.label === "string") {
          fields.label = body.label;
        } else {
          throw new Error("label must be a string");
        }
      }
      if ("group_name" in body) {
        const v = body.group_name;
        if (v === null) {
          fields.group_name = null;
        } else if (typeof v === "string") {
          fields.group_name = v.trim() || null;
        } else {
          throw new Error("group_name must be a string or null");
        }
      }
      const updated = await artifactService.updateArtifact(id, fields);
      sendJson(updated);
      // Mirror label + space_id onto the cloud publication if one is live —
      // keeps the chip, ghost rendering, and (eventually) cross-device space
      // resolution consistent without forcing a re-publish.
      if (
        publishService &&
        fields.label &&
        updated.publication &&
        updated.publication.unpublishedAt === null
      ) {
        publishService.updateShareByToken({
          share_token: updated.publication.shareToken,
          mode: updated.publication.shareMode,
          label: fields.label,
          space_id: updated.spaceId,
        }).catch((err) => {
          console.warn("[publish] label mirror failed:", err);
        });
      }
    } catch (err) {
      sendError(err);
    }
    return true;
  }

  const restoreMatch = url.match(/^\/api\/artifacts\/([^/]+)\/restore$/);
  if (restoreMatch && req.method === "POST") {
    if (rejectIfNonLocalOrigin()) return true;
    const id = safeDecode(restoreMatch[1]);
    if (id === null) { sendJson({ error: "Invalid URL encoding" }, 400); return true; }
    try {
      artifactService.restoreArtifact(id);
      sendJson({ id, restored: true });
    } catch (err) {
      sendError(err);
    }
    return true;
  }

  const archiveMatch = url.match(/^\/api\/artifacts\/([^/]+)\/archive$/);
  if (archiveMatch && req.method === "POST") {
    if (rejectIfNonLocalOrigin()) return true;
    const id = safeDecode(archiveMatch[1]);
    if (id === null) { sendJson({ error: "Invalid URL encoding" }, 400); return true; }
    try {
      artifactService.removeArtifact(id);
      sendJson({ id, archived: true });
    } catch (err) {
      sendError(err);
    }
    return true;
  }

  if (url === "/api/groups" && req.method === "PATCH") {
    if (rejectIfNonLocalOrigin()) return true;
    try {
      const body = await readJsonBody();
      const spaceId = typeof body.space_id === "string" ? body.space_id : null;
      const oldName = typeof body.old_name === "string" ? body.old_name : null;
      const newName = typeof body.new_name === "string" ? body.new_name : null;
      if (!spaceId || !oldName || !newName) {
        sendJson({ error: "space_id, old_name, new_name are required" }, 400);
        return true;
      }
      const updated = artifactService.renameGroup(spaceId, oldName, newName);
      sendJson({ space_id: spaceId, old_name: oldName, new_name: newName.trim(), updated });
    } catch (err) {
      sendError(err);
    }
    return true;
  }

  // POST /api/plugins/:id/uninstall — remove an app bundle from disk.
  // Post-#207 the bundle could live at APPS_DIR/<id>/ (installed) or
  // SPACES_DIR/<space>/<id>/ (AI-generated under a space). Search both,
  // plus legacy OYSTER_HOME/<id>/ for any un-migrated install.
  // The artifact detector + getAllArtifacts self-heal DB entries.
  const pluginUninstallMatch = url.match(/^\/api\/plugins\/([^/]+)\/uninstall$/);
  if (pluginUninstallMatch && req.method === "POST") {
    if (rejectIfNonLocalOrigin()) return true;
    const id = safeDecode(pluginUninstallMatch[1]);
    if (id === null) { sendJson({ error: "Invalid URL encoding" }, 400); return true; }
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) {
      sendJson({ error: `Invalid plugin id '${id}'` }, 400);
      return true;
    }
    const candidates: string[] = [
      join(APPS_DIR, id),
      join(OYSTER_HOME, id),
    ];
    try {
      for (const spaceName of readdirSync(SPACES_DIR)) {
        candidates.push(join(SPACES_DIR, spaceName, id));
      }
    } catch { /* no SPACES_DIR yet on fresh install */ }

    // resolve()+sep-terminated-prefix check — the raw startsWith would let
    // an `OysterX` sibling match `Oyster`. Same hardening pattern used in
    // resolveArtifactsUrl and the icon-regen endpoint.
    const rootPath = resolve(OYSTER_HOME);
    const dir = candidates.find((c) => {
      const r = resolve(c);
      if (r !== rootPath && !r.startsWith(rootPath + sep)) return false;
      return existsSync(c);
    });
    if (!dir) {
      sendJson({ error: `'${id}' is not installed` }, 404);
      return true;
    }
    const manifestPath = join(dir, "manifest.json");
    if (!existsSync(manifestPath)) {
      sendJson({ error: `${dir} has no manifest.json — refusing to remove a non-plugin folder` }, 400);
      return true;
    }
    try {
      rmSync(dir, { recursive: true, force: true });
      sendJson({ id, uninstalled: true, path: dir });
    } catch (err) {
      sendError(err, 500);
    }
    return true;
  }

  if (url === "/api/groups/archive" && req.method === "POST") {
    if (rejectIfNonLocalOrigin()) return true;
    try {
      const body = await readJsonBody();
      const spaceId = typeof body.space_id === "string" ? body.space_id : null;
      const name = typeof body.name === "string" ? body.name : null;
      if (!spaceId || !name) {
        sendJson({ error: "space_id and name are required" }, 400);
        return true;
      }
      const archived = artifactService.archiveGroup(spaceId, name);
      sendJson({ space_id: spaceId, name, archived });
    } catch (err) {
      sendError(err);
    }
    return true;
  }

  return false;
}
