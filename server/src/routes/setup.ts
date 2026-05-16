// /api/setup/apply — applies a SetupProposal the user has confirmed in the
// SetupProposalPanel.
//
// The agent emits a proposal via the `propose_setup` MCP tool; the panel
// renders, the user toggles/renames/drag-drops; on Apply the panel POSTs
// the user's confirmed plan here. This route fans the writes out to
// `space-service.onboard_space` (one call per space, with all paths in
// the array — same convention the agent used to follow for direct calls).
//
// We intentionally skip a server-side proposal-id guard: the panel sends
// the user's edited plan, not a confirmation of the original proposal.
// Each path is validated by `addSource` (must exist on disk; not
// already claimed by another space). Partial failures are surfaced
// per-space so the UI can show what landed and what didn't.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { SpaceService } from "../space-service.js";
import type { ProjectService } from "../project-service.js";
import type { UiCommand, SetupApplyResult } from "../../../shared/types.js";
import type { RouteCtx } from "../http-utils.js";
import { slugify } from "../utils.js";

export interface SetupRouteDeps {
  spaceService: SpaceService;
  projectService: ProjectService;
  /** Broadcasts SSE so connected clients refetch the spaces / artefacts
   *  surface after batch-create. The panel itself also closes locally
   *  when apply succeeds; the broadcast is for any other open tabs. */
  broadcastUiEvent: (event: UiCommand) => void;
}

interface ApplyBodySpace {
  name: string;
  paths: string[];
}

interface ApplyBody {
  /** Optional — included for telemetry / log correlation only; we don't
   *  enforce it (the panel may have edited the proposal before applying). */
  proposalId?: string;
  spaces: ApplyBodySpace[];
}

function parseBody(body: unknown): ApplyBody | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (!Array.isArray(b.spaces)) return null;
  const spaces: ApplyBodySpace[] = [];
  for (const raw of b.spaces) {
    if (!raw || typeof raw !== "object") return null;
    const s = raw as Record<string, unknown>;
    const name = typeof s.name === "string" ? s.name.trim() : "";
    if (!name) return null;
    if (!Array.isArray(s.paths)) return null;
    const paths: string[] = [];
    for (const p of s.paths) {
      if (typeof p !== "string" || !p.trim()) return null;
      paths.push(p);
    }
    spaces.push({ name, paths });
  }
  return {
    proposalId: typeof b.proposalId === "string" ? b.proposalId : undefined,
    spaces,
  };
}

export async function tryHandleSetupRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: string,
  ctx: RouteCtx,
  deps: SetupRouteDeps,
): Promise<boolean> {
  const { sendJson, readJsonBody, rejectIfNonLocalOrigin } = ctx;
  const { spaceService, projectService, broadcastUiEvent } = deps;

  if (url !== "/api/setup/apply" || req.method !== "POST") return false;
  if (rejectIfNonLocalOrigin()) return true;

  let body: ApplyBody | null;
  try {
    body = parseBody(await readJsonBody());
  } catch {
    sendJson({ error: "invalid JSON body" }, 400);
    return true;
  }
  if (!body) {
    sendJson({ error: "invalid setup proposal: expected { spaces: [{ name, paths: [...] }] }" }, 400);
    return true;
  }
  if (body.spaces.length === 0) {
    sendJson({ error: "no spaces to create" }, 400);
    return true;
  }

  // Reject slug-collisions in the same payload up-front. Two rows named
  // "foo" and "Foo" both slugify to "foo"; without this check they'd merge
  // into a single space silently while the panel showed them as separate.
  // Surface as a single error so the user can rename one.
  const seenSlugs = new Map<string, string>(); // slug -> first display name
  for (const wanted of body.spaces) {
    const id = slugify(wanted.name);
    const prev = seenSlugs.get(id);
    if (prev) {
      sendJson({
        error: `Two spaces would collapse to the same id "${id}" (from "${prev}" and "${wanted.name}"). Rename one before applying.`,
      }, 400);
      return true;
    }
    seenSlugs.set(id, wanted.name);
  }

  const results: SetupApplyResult[] = [];
  for (const wanted of body.spaces) {
    const id = slugify(wanted.name);
    let space = spaceService.getSpace(id);
    let created = false;
    if (!space) {
      try {
        space = spaceService.createSpace({ name: wanted.name });
        created = true;
      } catch (err) {
        // Distinguish concurrent-create races (existing space appears on
        // re-lookup) from genuine creation failures (slug invalid, storage
        // error). The old over-broad catch reported every failure as a
        // generic per-path issue, hiding real bugs.
        const existing = spaceService.getSpace(id);
        if (existing) {
          space = existing;
        } else {
          const msg = (err as Error).message || "space create failed";
          results.push({
            spaceId: id,
            name: wanted.name,
            created: false,
            paths: wanted.paths.map((path) => ({ path, status: "failed", error: msg })),
          });
          continue;
        }
      }
    }

    const pathReports: SetupApplyResult["paths"] = [];
    let anyAttached = false;
    for (const p of wanted.paths) {
      try {
        projectService.attachFolder({ spaceId: space.id, path: p });
        pathReports.push({ path: p, status: "attached" });
        anyAttached = true;
      } catch (err) {
        pathReports.push({ path: p, status: "failed", error: (err as Error).message });
      }
    }

    if (anyAttached) {
      // attachFolder claims orphan sessions whose cwd matches. Broadcast
      // so other open tabs re-attribute those sessions immediately rather
      // than waiting for the next watcher tick.
      broadcastUiEvent({
        version: 1,
        command: "session_changed",
        payload: { id: null, reason: "setup_apply" },
      });
    }

    results.push({ spaceId: space.id, name: wanted.name, created, paths: pathReports });
  }

  // Notify any other connected tab (the panel itself closes locally on its
  // own apply success).
  broadcastUiEvent({
    version: 1,
    command: "setup_applied",
    payload: {
      proposal_id: body.proposalId ?? null,
      space_count: results.length,
    },
  });

  sendJson({ results });
  return true;
}
