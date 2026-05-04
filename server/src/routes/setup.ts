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
import type { UiCommand, SetupApplyResult } from "../../../shared/types.js";
import type { RouteCtx } from "../http-utils.js";
import { slugify } from "../utils.js";

export interface SetupRouteDeps {
  spaceService: SpaceService;
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
  const { spaceService, broadcastUiEvent } = deps;

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

  const results: SetupApplyResult[] = [];
  for (const wanted of body.spaces) {
    const id = slugify(wanted.name);
    let space = spaceService.getSpace(id);
    let created = false;
    if (!space) {
      try {
        space = spaceService.createSpace({ name: wanted.name });
        created = true;
      } catch {
        // Race: a concurrent caller created it first; reuse the winner.
        const existing = spaceService.getSpace(id);
        if (!existing) {
          results.push({ spaceId: id, name: wanted.name, created: false, paths: wanted.paths.map((path) => ({ path, status: "failed", error: "space create failed" })) });
          continue;
        }
        space = existing;
      }
    }

    const pathReports: SetupApplyResult["paths"] = [];
    for (const p of wanted.paths) {
      try {
        spaceService.addSource(space.id, p);
        pathReports.push({ path: p, status: "attached" });
      } catch (err) {
        const msg = (err as Error).message;
        const ownedElsewhere = /already attached/i.test(msg);
        pathReports.push({ path: p, status: ownedElsewhere ? "owned-by-other-space" : "failed", error: msg });
      }
    }

    // Scan only when something actually attached — otherwise scanSpace would
    // throw "no folders" on top of the per-path errors already in `paths`.
    const anyAttached = pathReports.some((r) => r.status === "attached");
    if (anyAttached) {
      try {
        await spaceService.scanSpace(space.id);
      } catch {
        // Scan failure isn't fatal — the space + sources exist; the user can
        // re-trigger a scan later. Per-path attach status is the source of truth.
      }
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
