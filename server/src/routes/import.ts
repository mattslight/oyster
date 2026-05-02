// /api/import/* — extracted from index.ts. Three endpoints powering
// the "import context from another AI" flow:
//   GET  /api/import/prompt   — generate the prompt the user pastes to ChatGPT/etc.
//   POST /api/import/preview  — convert pasted output into a plan + preview it
//   POST /api/import/execute  — apply an approved plan
//
// The preview endpoint accepts pasted AI output (large) and runs it
// through OpenCode for JSON normalisation — see convertFn below.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { ArtifactStore } from "../artifact-store.js";
import type { ArtifactService } from "../artifact-service.js";
import type { SqliteSpaceStore } from "../space-store.js";
import type { SpaceService } from "../space-service.js";
import type { MemoryProvider } from "../memory-store.js";
import type { RouteCtx } from "../http-utils.js";
import {
  generatePrompt,
  parseImportPayload,
  buildImportPlan,
  executeImportPlan,
  getPlan,
  type PreviewDeps,
  type ExecuteDeps,
} from "../import.js";
import { slugify } from "../utils.js";

export interface ImportRouteDeps {
  store: ArtifactStore;
  spaceStore: SqliteSpaceStore;
  spaceService: SpaceService;
  artifactService: ArtifactService;
  memoryProvider: MemoryProvider;
  /** Native filesystem path for a space (writes go under here). */
  getNativeSourcePath: (spaceId: string) => string;
  /** OpenCode HTTP port — null when the subprocess hasn't bound yet.
   *  Preview uses it to ask OpenCode to JSON-normalise pasted text. */
  getOpenCodePort: () => number | null;
}

export async function tryHandleImportRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: string,
  ctx: RouteCtx,
  deps: ImportRouteDeps,
): Promise<boolean> {
  const { sendJson, sendError, readJsonBody } = ctx;
  const {
    store, spaceStore, spaceService, artifactService, memoryProvider,
    getNativeSourcePath, getOpenCodePort,
  } = deps;

  // Try raw id, then slugified id, then case-insensitive display_name.
  // Used by preview + execute so an agent-emitted space name (possibly
  // whitespace-padded or referring to a renamed space) resolves
  // consistently.
  const resolveSpaceRow = (name: string) => {
    const trimmed = name.trim();
    return (
      spaceStore.getById(trimmed) ??
      spaceStore.getById(slugify(trimmed)) ??
      spaceStore.getByDisplayName(trimmed)
    );
  };

  if (url.startsWith("/api/import/prompt") && req.method === "GET") {
    const params = new URL(url, "http://localhost").searchParams;
    const provider = params.get("provider") || "chatgpt";
    const spaceId = params.get("spaceId");

    const allSpaces = spaceStore.getAll()
      .filter((s) => s.id !== "home" && s.id !== "__all__")
      .map((s) => ({ id: s.id, displayName: s.display_name }));

    const knownProjects = new Map<string, string[]>();
    for (const s of allSpaces) {
      const artifacts = store.getBySpaceId(s.id)
        .filter((a) => a.source_ref?.startsWith("import:") && !a.removed_at);
      if (artifacts.length > 0) {
        knownProjects.set(s.id, artifacts.map((a) => a.label));
      }
    }

    const targetSpace = spaceId
      ? allSpaces.find((s) => s.id === spaceId) ?? undefined
      : undefined;

    const prompt = generatePrompt({ provider, spaces: allSpaces, knownProjects, targetSpace });
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end(prompt);
    return true;
  }

  if (url === "/api/import/preview" && req.method === "POST") {
    try {
      const body = await readJsonBody({ maxBytes: 500_000 });
      const raw = typeof body.raw === "string" ? body.raw : "";
      const provider = typeof body.provider === "string" ? body.provider : "";
      const targetSpaceId = typeof body.targetSpaceId === "string" ? body.targetSpaceId : undefined;

      const convertFn = async (text: string): Promise<string | null> => {
        try {
          const port = getOpenCodePort();
          if (!port) {
            console.log("[import] OpenCode not ready yet");
            return null;
          }

          const sessRes = await fetch(`http://localhost:${port}/session`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{}",
          });
          const sess = await sessRes.json() as { id: string };
          console.log("[import] OpenCode session:", sess.id);

          const prompt = `Convert this text into valid JSON. Output ONLY the raw JSON object, nothing else. No markdown fences. No explanation.\n\nRequired schema:\n{\n  "schema_version": 1,\n  "mode": "fresh" | "augment",\n  "source": { "provider": "string", "generated_at": "ISO string" },\n  "spaces": [{ "name": "string", "projects": [{ "name": "string", "summary": "string" }] }],\n  "summaries": [{ "space": "string", "title": "string", "content": "string" }],\n  "memories": [{ "content": "string", "tags": ["string"], "space": "string" }]\n}\n\nText to convert:\n${text.slice(0, 12000)}`;

          const msgRes = await fetch(`http://localhost:${port}/session/${sess.id}/message`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ parts: [{ type: "text", text: prompt }], agent: "oyster" }),
          });

          const resBody = await msgRes.json() as {
            info?: { error?: unknown };
            parts?: Array<{ type: string; text?: string }>;
          };

          if (resBody.info?.error) {
            console.error("[import] OpenCode error:", JSON.stringify(resBody.info.error).slice(0, 300));
            return null;
          }

          for (const part of resBody.parts ?? []) {
            if (part.type === "text" && part.text?.includes("{")) {
              console.log("[import] AI conversion succeeded, length:", part.text.length);
              return part.text;
            }
          }
          console.log("[import] OpenCode returned", resBody.parts?.length ?? 0, "parts, none with JSON");
        } catch (err) {
          console.error("[import] AI conversion failed:", err);
        }
        return null;
      };

      const parseResult = await parseImportPayload(raw, convertFn);
      if (!parseResult.success || !parseResult.payload) {
        sendJson({ error: parseResult.error }, 400);
        return true;
      }

      const generatedAt = parseResult.payload.source?.generated_at || new Date().toISOString();

      const previewDeps: PreviewDeps = {
        resolveSpaceByName: (name) => {
          const row = resolveSpaceRow(name);
          return row ? { id: row.id, displayName: row.display_name } : null;
        },
        getArtifactsBySpace: (spaceId) => {
          return store.getBySpaceId(spaceId)
            .filter((a) => !a.removed_at)
            .map((a) => ({ source_ref: a.source_ref, label: a.label }));
        },
        findMemory: (content, spaceId) => {
          return memoryProvider.findExact(content, spaceId ?? undefined);
        },
      };

      const plan = buildImportPlan(parseResult.payload, provider, generatedAt, previewDeps, targetSpaceId);
      if (plan.actions.length === 0) {
        sendJson({ error: "Nothing found to import. Make sure you pasted the AI's response, not the prompt you sent it." }, 400);
        return true;
      }
      sendJson(plan);
    } catch (err) {
      sendError(err, 500);
    }
    return true;
  }

  if (url === "/api/import/execute" && req.method === "POST") {
    try {
      const body = await readJsonBody({ maxBytes: 100_000 });
      const plan_id = typeof body.plan_id === "string" ? body.plan_id : "";
      const approved_action_ids = Array.isArray(body.approved_action_ids)
        ? body.approved_action_ids.filter((s): s is string => typeof s === "string")
        : [];

      if (!getPlan(plan_id)) {
        sendJson({ error: "Plan not found or expired" }, 404);
        return true;
      }

      const executeDeps: ExecuteDeps = {
        createSpace: (name) => spaceService.createSpace({ name }),
        createArtifact: (params) => artifactService.createArtifact(params, getNativeSourcePath(params.space_id)),
        remember: (input) => memoryProvider.remember(input),
        findMemory: (content, spaceId) => memoryProvider.findExact(content, spaceId ?? undefined),
        resolveSpaceByName: (name) => {
          const row = resolveSpaceRow(name);
          return row ? { id: row.id } : null;
        },
      };

      const result = await executeImportPlan(plan_id, approved_action_ids, executeDeps);
      sendJson(result);
    } catch (err) {
      sendError(err, 500);
    }
    return true;
  }

  return false;
}
