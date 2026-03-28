import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { extname, dirname, join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ArtifactStore } from "./artifact-store.js";
import type { ArtifactService } from "./artifact-service.js";
import type { IconGenerator } from "./icon-generator.js";
import type { SpaceService } from "./space-service.js";

const ARTIFACT_KINDS = [
  "app", "deck", "diagram", "map", "notes", "table", "wireframe",
] as const;

const TEXT_EXTS = new Set([".md", ".mmd", ".mermaid", ".html", ".htm", ".txt", ".json", ".csv"]);

interface McpDeps {
  store: ArtifactStore;
  service: ArtifactService;
  userlandDir: string;
  iconGenerator: IconGenerator;
  spaceService: SpaceService;
}

function buildContext(userlandDir: string): string {
  return `
# Oyster OS

Oyster is a personal AI-native desktop OS that runs in the browser (localhost:4200).
It is NOT a chat interface or a file browser — it is a spatial desktop surface where
artifacts (interactive documents, apps, diagrams, etc.) live as launchable icons.

## Core concepts

**Artifacts** — the items on the desktop. Each artifact has:
- \`id\`: unique identifier (opaque for new artifacts, semantic for legacy ones)
- \`label\`: display name shown under the icon on the desktop
- \`kind\`: one of app | deck | diagram | map | notes | table | wireframe
- \`space\`: which workspace it belongs to (e.g. "home", "tokinvest")
- \`status\`: ready | online | offline | starting | generating
- \`url\`: how to open it (relative path for static files, localhost:PORT for running apps)
- \`group\`: optional visual group on the desktop surface

**Spaces** — named workspaces (tabs) the user switches between. Spaces are emergent:
they exist because artifacts reference them. There is no separate spaces table.
Common spaces: "home" (default), plus one per project (e.g. "tokinvest", "research").

**Artifact kinds**:
- \`app\` — a local web app (React, Vite, etc.) that runs as a process on a port
- \`deck\` — a slide presentation (HTML/reveal.js)
- \`diagram\` — a visual diagram (Mermaid .mmd, draw.io, etc.)
- \`map\` — a mind map or spatial layout
- \`notes\` — markdown notes or README
- \`table\` — a spreadsheet or data table (HTML)
- \`wireframe\` — a UI wireframe or mockup

**Runtime kinds**:
- \`static_file\` — served directly from disk (most documents, HTML, MD, Mermaid)
- \`local_process\` — spawned as a child process; status tracks whether the port is open
- \`redirect\` — an external URL

## What agents should do

Use \`create_artifact\` to write a new file and register it in one step.
Use \`read_artifact\` to read the content of an existing static file artifact.
Use \`list_spaces\` and \`list_artifacts\` to understand what already exists.
Use \`update_artifact\` to rename, reassign to a different space, or change the group.

Do NOT read or write the SQLite database (userland/oyster.db) directly.
Files you create must live under: ${userlandDir}/
`.trim();
}

export function createMcpServer(deps: McpDeps): McpServer {
  const server = new McpServer({ name: "oyster", version: "1.0.0" });

  // ── get_context ──

  server.tool(
    "get_context",
    "Get a description of Oyster OS — what it is, how it works, and how to use these tools effectively. Call this first if you are unfamiliar with Oyster.",
    {},
    async () => ({
      content: [{ type: "text" as const, text: buildContext(deps.userlandDir) }],
    }),
  );

  // ── list_spaces ──

  server.tool(
    "list_spaces",
    "List all spaces (named workspaces) on the Oyster desktop. A space is a tab the user switches between — e.g. 'home', 'tokinvest'.",
    {},
    async () => {
      const spaces = deps.spaceService.listSpaces();
      return {
        content: [{ type: "text" as const, text: JSON.stringify(spaces, null, 2) }],
      };
    },
  );

  // ── onboard_space ──

  server.tool(
    "onboard_space",
    "Create a space, attach it to a local repo, and scan for apps, docs, and diagrams. All discovered assets register as desktop artifacts immediately.",
    {
      name: z.string().describe("Display name for the space (slugified to ID)"),
      repo_path: z.string().describe("Absolute local path to the repository root"),
      skip_ai: z.boolean().optional().describe("Reserved for Phase 2 — no-op currently"),
    },
    async ({ name, repo_path }) => {
      try {
        const space = deps.spaceService.createSpace({ name, repoPath: repo_path });
        const scanResult = await deps.spaceService.scanSpace(space.id);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ space_id: space.id, scan_summary: scanResult }, null, 2),
          }],
        };
      } catch (err) {
        return { content: [{ type: "text" as const, text: (err as Error).message }], isError: true };
      }
    },
  );

  // ── list_artifacts ──

  server.tool(
    "list_artifacts",
    "List artifacts (desktop icons) on the Oyster surface, optionally filtered by space or kind. Returns id, label, kind, space, status, url, group, and source_path for each artifact.",
    {
      space_id: z.string().optional().describe("Filter by space"),
      artifact_kind: z
        .enum(ARTIFACT_KINDS)
        .optional()
        .describe("Filter by artifact kind"),
    },
    async ({ space_id, artifact_kind }) => {
      let artifacts = await deps.service.getAllArtifacts();
      if (space_id) artifacts = artifacts.filter((a) => a.spaceId === space_id);
      if (artifact_kind) artifacts = artifacts.filter((a) => a.artifactKind === artifact_kind);

      const summary = artifacts.map((a) => ({
        id: a.id,
        label: a.label,
        kind: a.artifactKind,
        space: a.spaceId,
        status: a.status,
        url: a.url,
        group: a.groupName,
        source_path: deps.service.getDocFile(a.id) ?? null,
      }));

      return {
        content: [{ type: "text" as const, text: JSON.stringify(summary, null, 2) }],
      };
    },
  );

  // ── register_artifact ──

  server.tool(
    "register_artifact",
    "Register a file that already exists on disk as a desktop artifact. Use this only when the file already exists. To create new content and register it in one step, use create_artifact instead. The file must be inside userland/. Kind and ID are inferred from the filename if not provided.",
    {
      path: z.string().describe("Absolute path to the file"),
      space_id: z.string().describe("Space to place the artifact in (e.g. 'home', 'tokinvest')"),
      label: z.string().describe("Display name on the desktop"),
      id: z.string().optional().describe("Kebab-case ID (inferred from filename if omitted)"),
      artifact_kind: z
        .enum(ARTIFACT_KINDS)
        .optional()
        .describe("Artifact kind (inferred from file extension if omitted)"),
      group_name: z.string().optional().describe("Group name for visual grouping on the surface"),
    },
    async ({ path, space_id, label, id, artifact_kind, group_name }) => {
      try {
        const artifact = deps.service.registerArtifact(
          { path, space_id, label, id, artifact_kind, group_name },
          [deps.userlandDir],
        );
        return {
          content: [{ type: "text" as const, text: JSON.stringify(artifact, null, 2) }],
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: (err as Error).message }],
          isError: true,
        };
      }
    },
  );

  // ── read_artifact ──

  server.tool(
    "read_artifact",
    "Read the raw text content of a static text-backed artifact. Redirect and non-file artifacts are not supported.",
    { id: z.string().describe("Artifact ID") },
    async ({ id }) => {
      const filePath = deps.service.getDocFile(id);
      if (!filePath) {
        return {
          content: [{ type: "text" as const, text: `Artifact "${id}" not found or is not a static file. Use list_artifacts to find the artifact URL.` }],
          isError: true,
        };
      }
      if (!existsSync(filePath)) {
        return {
          content: [{ type: "text" as const, text: `File not found on disk: ${filePath}` }],
          isError: true,
        };
      }
      const ext = extname(filePath).toLowerCase();
      if (!TEXT_EXTS.has(ext)) {
        return {
          content: [{ type: "text" as const, text: `Cannot read "${ext}" files as text` }],
          isError: true,
        };
      }
      return { content: [{ type: "text" as const, text: readFileSync(filePath, "utf8") }] };
    },
  );

  // ── create_artifact ──

  server.tool(
    "create_artifact",
    "Create a new file inside userland and register it as a desktop artifact in one step. The server computes the file path from space_id and label — you provide the content. Appears immediately on the user's desktop.",
    {
      space_id: z.string().describe("Space to place the artifact in"),
      label: z.string().describe("Display name on the desktop. Also determines the filename (slugified)."),
      artifact_kind: z.enum(ARTIFACT_KINDS).describe("Kind determines file extension: notes→.md, diagram→.mmd, others→.html"),
      content: z.string().describe("File content to write"),
      subdir: z.string().optional().describe("Subdirectory within the space (e.g. 'invoices'). Must be a relative path."),
      group_name: z.string().optional().describe("Visual group on the surface"),
    },
    async ({ space_id, label, artifact_kind, content, subdir, group_name }) => {
      try {
        const artifact = deps.service.createArtifact(
          { space_id, label, artifact_kind, content, subdir, group_name },
          deps.userlandDir,
        );
        return {
          content: [{ type: "text" as const, text: JSON.stringify(artifact, null, 2) }],
          structuredContent: artifact as Record<string, unknown>,
        };
      } catch (err) {
        return { content: [{ type: "text" as const, text: (err as Error).message }], isError: true };
      }
    },
  );

  // ── update_artifact ──

  server.tool(
    "update_artifact",
    "Update display metadata only: label, space assignment, or group name. Does not rename or move the file on disk.",
    {
      id: z.string().describe("Artifact ID to update"),
      label: z.string().optional().describe("New display name"),
      space_id: z.string().optional().describe("Reassign to a different space (tab). Does not move the file."),
      group_name: z.string().optional().describe("Change visual group. Pass empty string to remove grouping."),
    },
    async ({ id, label, space_id, group_name }) => {
      try {
        const updated = await deps.service.updateArtifact(id, {
          label,
          space_id,
          ...(group_name !== undefined ? { group_name: group_name || null } : {}),
        });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(updated, null, 2) }],
          structuredContent: updated as Record<string, unknown>,
        };
      } catch (err) {
        return { content: [{ type: "text" as const, text: (err as Error).message }], isError: true };
      }
    },
  );

  // ── remove_artifact ──

  server.tool(
    "remove_artifact",
    "Remove an artifact from the desktop surface. The file and record are preserved — the artifact simply stops appearing on the surface. This is reversible.",
    { id: z.string().describe("Artifact ID to remove") },
    async ({ id }) => {
      try {
        deps.service.removeArtifact(id);
        return { content: [{ type: "text" as const, text: `Artifact "${id}" removed from surface` }] };
      } catch (err) {
        return { content: [{ type: "text" as const, text: (err as Error).message }], isError: true };
      }
    },
  );

  // ── regenerate_icon ──

  server.tool(
    "regenerate_icon",
    "Regenerate the AI-generated icon for an artifact. Uses the same geometric low-poly style as all Oyster icons. Optionally accepts a composition hint to guide what is depicted — the style (colours, geometry, palette) is always preserved.",
    {
      id: z.string().describe("Artifact ID"),
      hint: z.string().optional().describe("Optional composition hint — describe what to depict (e.g. 'a chess knight piece', 'a rising bar chart'). Style is fixed; this only guides the subject matter."),
    },
    async ({ id, hint }) => {
      const artifact = await deps.service.getArtifactById(id);
      if (!artifact) {
        return { content: [{ type: "text" as const, text: `Artifact "${id}" not found` }], isError: true };
      }

      const sourcePath = deps.service.getDocFile(id);
      if (!sourcePath) {
        return { content: [{ type: "text" as const, text: `Artifact "${id}" has no file source — icon regeneration is only supported for static file artifacts` }], isError: true };
      }

      // Derive artifact directory: if source is inside a src/ subdir, go up one level
      const srcIdx = sourcePath.lastIndexOf("/src/");
      const naturalDir = srcIdx !== -1 ? sourcePath.slice(0, srcIdx) : dirname(sourcePath);

      // For artifacts outside userland (e.g. external repos), store the icon in userland/icons/<id>
      const artifactDir = naturalDir.startsWith(deps.userlandDir)
        ? naturalDir
        : join(deps.userlandDir, "icons", id);

      if (!artifactDir.startsWith(deps.userlandDir)) {
        return { content: [{ type: "text" as const, text: "Artifact is outside userland — cannot regenerate icon" }], isError: true };
      }

      mkdirSync(artifactDir, { recursive: true });
      const queued = deps.iconGenerator.forceEnqueue(id, artifact.label, artifact.artifactKind, artifactDir, hint);
      if (!queued) {
        return { content: [{ type: "text" as const, text: "Icon generation is disabled (FAL_KEY not configured)" }], isError: true };
      }

      return {
        content: [{ type: "text" as const, text: JSON.stringify({ status: "queued", id, label: artifact.label, hint: hint ?? null }) }],
      };
    },
  );

  return server;
}
