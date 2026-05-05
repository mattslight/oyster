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
import type { IconGenerator } from "../icon-generator.js";
import type { RouteCtx } from "../http-utils.js";
import { safeDecode } from "../http-utils.js";

export interface ArtifactRouteDeps {
  artifactService: ArtifactService;
  sessionStore: SessionStore;
  iconGenerator: IconGenerator;
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
    artifactService, sessionStore, iconGenerator, pendingReveals,
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
          session: {
            id: s.id,
            spaceId: s.space_id,
            sourceId: s.source_id ?? null,
            sourceLabel: null,
            cwd: s.cwd,
            agent: s.agent,
            title: s.title,
            state: s.state,
            startedAt: s.started_at,
            endedAt: s.ended_at,
            model: s.model,
            lastEventAt: s.last_event_at,
          },
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
      // Mirror label changes onto the cloud publication if one is live —
      // keeps the chip + ghost rendering consistent across devices without
      // forcing a re-publish (R5 hardening).
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

  // POST /api/artifacts/:id/icon/regenerate — trigger a fresh AI icon for
  // an artifact. Mirrors the MCP `regenerate_icon` tool so the UI can offer
  // a right-click "Regenerate icon" action without going through chat.
  //
  // Builtins: their id is `gen:<folder>` and they have no DB row. The
  // service-layer lookup would miss them; handle directly from APPS_DIR.
  // Overwriting the icon.png there persists across restarts (bootstrap is
  // add-only) — next `npm install -g oyster-os` upgrade would reset it,
  // which is acceptable.
  const iconRegenMatch = url.match(/^\/api\/artifacts\/([^/]+)\/icon\/regenerate$/);
  if (iconRegenMatch && req.method === "POST") {
    if (rejectIfNonLocalOrigin()) return true;
    const id = safeDecode(iconRegenMatch[1]);
    if (id === null) { sendJson({ error: "Invalid URL encoding" }, 400); return true; }

    let label: string | undefined;
    let artifactKind: string | undefined;
    let artifactDir: string | undefined;

    if (id.startsWith("gen:")) {
      // Builtin or unreconciled generated artifact — look up by walking the
      // same candidate roots the scanner walks: APPS_DIR for installed /
      // builtin bundles, plus each SPACES_DIR/<space>/ for space-scoped
      // generated ones (matches scanExistingArtifacts' coverage).
      const folderId = id.slice("gen:".length);
      // Strict whitelist — stops traversal via URL-encoded "../", backslashes,
      // etc. before it hits the filesystem. Mirrors the validation on
      // /api/plugins/:id/uninstall; keep the two in sync.
      if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(folderId)) {
        sendJson({ error: `Invalid artifact id '${id}'` }, 400); return true;
      }
      const candidateDirs: string[] = [join(APPS_DIR, folderId)];
      try {
        for (const spaceName of readdirSync(SPACES_DIR)) {
          const spaceDir = join(SPACES_DIR, spaceName);
          try {
            if (!statSync(spaceDir).isDirectory()) continue;
          } catch { continue; }
          candidateDirs.push(join(spaceDir, folderId));
        }
      } catch { /* SPACES_DIR missing on a fresh install */ }

      // Defence in depth: even with the whitelist above, verify every
      // candidate is actually inside OYSTER_HOME via resolve()+sep before
      // reading it. Normalises path segments (handles any accidental `..`
      // that slipped past the allowlist, double slashes, etc.) — does NOT
      // follow symlinks; realpathSync would be needed for that, and is
      // filed as future hardening since the allowlist already bars the
      // usual traversal vectors.
      const rootPath = resolve(OYSTER_HOME);
      const resolvedDir = candidateDirs.find((d) => {
        const r = resolve(d);
        if (r !== rootPath && !r.startsWith(rootPath + sep)) return false;
        return existsSync(join(d, "manifest.json"));
      });
      if (!resolvedDir) {
        sendJson({ error: `Artifact "${id}" not found` }, 404); return true;
      }
      try {
        const manifest = JSON.parse(readFileSync(join(resolvedDir, "manifest.json"), "utf8"));
        label = manifest.name;
        artifactKind = manifest.type;
        artifactDir = resolvedDir;
      } catch (err) {
        sendJson({ error: `Failed to read manifest for "${id}": ${(err as Error).message}` }, 500); return true;
      }
    } else {
      const artifact = await artifactService.getArtifactById(id);
      if (!artifact) { sendJson({ error: `Artifact "${id}" not found` }, 404); return true; }
      const sourcePath = artifactService.getDocFile(id);
      if (!sourcePath) { sendJson({ error: "Icon regeneration is only supported for static file artifacts" }, 400); return true; }
      // Only write the icon into a bundle root when the source is laid out
      // as a manifest-based bundle (source file lives under a `src/` dir).
      // For single-file artifacts (a loose .md / .html) the "natural dir" is
      // the containing folder — which might hold many artifacts — so the
      // regenerated icon would overwrite a shared icon.png. Route those to
      // the per-artifact dedicated dir at OYSTER_HOME/icons/<id>/ instead;
      // ArtifactService.resolveIcon checks that path first.
      //
      // Containment must use resolve() + sep-terminated prefix — a raw
      // startsWith(OYSTER_HOME) would match "/.../OysterX/..." too.
      const srcIdx = sourcePath.lastIndexOf(`${sep}src${sep}`);
      const bundleRoot = srcIdx !== -1 ? resolve(sourcePath.slice(0, srcIdx)) : null;
      const rootPath = resolve(OYSTER_HOME);
      const isManifestBundle = bundleRoot !== null
        && (bundleRoot === rootPath || bundleRoot.startsWith(rootPath + sep));
      artifactDir = isManifestBundle ? sourcePath.slice(0, srcIdx) : join(OYSTER_HOME, "icons", id);
      label = artifact.label;
      artifactKind = artifact.artifactKind;
    }

    mkdirSync(artifactDir!, { recursive: true });
    const queued = iconGenerator.forceEnqueue(id, label!, artifactKind!, artifactDir!);
    if (!queued) {
      sendJson({ error: "Icon generation is disabled on this install (FAL_KEY not configured)" }, 503);
      return true;
    }
    sendJson({ status: "queued", id, label });
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
