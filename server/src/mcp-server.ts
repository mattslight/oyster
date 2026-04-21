import { existsSync, readFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { extname, dirname, join, resolve, basename } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ArtifactStore } from "./artifact-store.js";
import type { ArtifactService } from "./artifact-service.js";
import type { IconGenerator } from "./icon-generator.js";
import type { SpaceService } from "./space-service.js";
import type { MemoryProvider } from "./memory-store.js";
import { registerMemoryTools } from "./memory-store.js";
import type { ArtifactKind } from "../../shared/types.js";
import { debug } from "./debug.js";
import { isContainer, discoverCandidates, groupWithLLM } from "./discovery.js";
import { homedir } from "node:os";

// Kept local — value imports from shared/ don't transpile in tsx (include: ["src"] only).
// `satisfies` ensures this stays in sync with the ArtifactKind union at compile time.
const ARTIFACT_KINDS = [
  "app", "deck", "diagram", "map", "notes", "table", "wireframe",
] as const satisfies readonly ArtifactKind[];

const TEXT_EXTS = new Set([".md", ".mmd", ".mermaid", ".html", ".htm", ".txt", ".json", ".csv"]);

const CONTEXT_PRIORITY_FILES = [
  "README.md", "CLAUDE.md", "AGENTS.md", "package.json", "tsconfig.json",
  "pyproject.toml", "Cargo.toml", "go.mod", ".opencode/agents",
];
const CONTEXT_SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "out", "coverage", ".cache"]);
const CONTEXT_MAX_TOKENS = 30_000;
const CHARS_PER_TOKEN = 4;

interface RepoFile { path: string; relPath: string; size: number }

function walkRepoFiles(dir: string, root: string, depth = 0, acc: RepoFile[] = []): RepoFile[] {
  if (depth > 5) return acc;
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return acc; }
  for (const entry of entries) {
    const abs = join(dir, entry);
    let st: ReturnType<typeof statSync>;
    try { st = statSync(abs); } catch { continue; }
    if (st.isDirectory()) {
      if (!CONTEXT_SKIP_DIRS.has(entry)) walkRepoFiles(abs, root, depth + 1, acc);
    } else if (TEXT_EXTS.has(extname(entry).toLowerCase())) {
      acc.push({ path: abs, relPath: abs.slice(root.length + 1).replace(/\\/g, "/"), size: st.size });
    }
  }
  return acc;
}

function gatherRepoContext(repoPath: string): { content: string; suggestions: Array<{ label: string; kind: string; evidence_paths: string[] }> } {
  const root = resolve(repoPath);
  if (!existsSync(root)) return { content: `Repo path not found: ${root}`, suggestions: [] };

  const allFiles = walkRepoFiles(root, root);

  // Sort: priority files first, then by path
  allFiles.sort((a, b) => {
    const aPri = CONTEXT_PRIORITY_FILES.findIndex(p => a.relPath === p || a.relPath.startsWith(p + "/")) >= 0 ? 0 : 1;
    const bPri = CONTEXT_PRIORITY_FILES.findIndex(p => b.relPath === p || b.relPath.startsWith(p + "/")) >= 0 ? 0 : 1;
    if (aPri !== bPri) return aPri - bPri;
    return a.relPath.localeCompare(b.relPath);
  });

  const sections: string[] = [];
  let tokenBudget = CONTEXT_MAX_TOKENS;
  const includedPaths: string[] = [];

  for (const file of allFiles) {
    if (tokenBudget <= 0) break;
    try {
      const raw = readFileSync(file.path, "utf8");
      const tokens = Math.ceil(raw.length / CHARS_PER_TOKEN);
      if (tokens > tokenBudget) continue;
      sections.push(`### ${file.relPath}\n\`\`\`\n${raw}\n\`\`\``);
      includedPaths.push(file.relPath);
      tokenBudget -= tokens;
    } catch { /* unreadable */ }
  }

  // Derive suggestions from what we found
  const suggestions: Array<{ label: string; kind: string; evidence_paths: string[] }> = [];

  // README → notes
  const readmePaths = includedPaths.filter(p => basename(p).toLowerCase() === "readme.md");
  for (const p of readmePaths) suggestions.push({ label: basename(p, ".md"), kind: "notes", evidence_paths: [p] });

  // .mmd / .mermaid → diagram
  const diagramPaths = includedPaths.filter(p => p.endsWith(".mmd") || p.endsWith(".mermaid"));
  for (const p of diagramPaths) suggestions.push({ label: basename(p).replace(/\.[^.]+$/, ""), kind: "diagram", evidence_paths: [p] });

  // Directories with package.json + dev/start script → app
  const pkgPaths = allFiles.filter(f => basename(f.path) === "package.json");
  for (const pkg of pkgPaths) {
    try {
      const parsed = JSON.parse(readFileSync(pkg.path, "utf8"));
      if (parsed.scripts?.dev || parsed.scripts?.start) {
        const dir = pkg.path.slice(root.length + 1).replace(/\/package\.json$/, "") || ".";
        suggestions.push({ label: parsed.name ?? basename(dir), kind: "app", evidence_paths: [pkg.relPath] });
      }
    } catch { /* bad json */ }
  }

  const skippedCount = allFiles.length - includedPaths.length;
  const header = `# Repo context: ${root}\nFiles included: ${includedPaths.length} / ${allFiles.length} (${skippedCount} skipped — over budget or unreadable)\n\n`;

  return { content: header + sections.join("\n\n"), suggestions };
}

interface UiCommand {
  version: 1;
  command: string;
  payload: unknown;
  correlationId?: string;
}

interface McpDeps {
  store: ArtifactStore;
  service: ArtifactService;
  userlandDir: string;
  iconGenerator: IconGenerator;
  spaceService: SpaceService;
  memoryProvider: MemoryProvider;
  pendingReveals: Set<string>;
  broadcastUiEvent: (event: UiCommand) => void;
  /**
   * Identifies the caller so we can push tool-call SSE events for external
   * agents only (Oyster's own OpenCode subprocess would otherwise spam the
   * action log with its own calls).
   */
  clientContext: { isInternal: true } | { isInternal: false; userAgent: string };
}

function buildContext(userlandDir: string): string {
  return `
# Oyster OS

Oyster is a personal AI-native desktop OS that runs in your browser.
It is NOT a chat interface or a file browser — it is a spatial desktop surface where
artifacts (interactive documents, apps, diagrams, etc.) live as launchable icons.

## "Set up Oyster for me" — first-run playbook

Oyster is for anyone whose work is organised as projects — developers, designers,
writers, PMs, researchers, hackers. Don't assume the user is a dev.

If the user has asked you to set up Oyster (or connect them, or get them started)
and has NOT given you an explicit projects folder path, follow this flow:

1. **Find their projects folder** — do not ask them yet. Probe the obvious
   candidates with local tooling (file listing / shell), in roughly this order,
   and pick the first one that exists and looks populated:

   Dev-flavoured: \`~/Dev\`, \`~/dev\`, \`~/Development\`, \`~/code\`, \`~/repos\`, \`~/src\`.
   Generic: \`~/Projects\`, \`~/projects\`, \`~/Work\`, \`~/work\`, \`~/workspace\`.
   Document-flavoured (designers/PMs/writers): \`~/Documents/Projects\`,
   \`~/Documents/Work\`, \`~/Documents\`.
   Creator-flavoured: \`~/Design\`, \`~/Figma\`, \`~/Writing\`, \`~/Notes\`.
   Windows: same substituted under \`%USERPROFILE%\\\` and on other drives
   (\`C:\\Development\`, \`E:\\Development\`, \`D:\\Work\`, etc.).

   If none of those match, ask the user once, concisely:
   *"Where do you keep your projects?"* — don't say "dev folder".

2. **Call \`onboard_container\` with that path.** This one call does the whole job:
   discovers candidate projects, LLM-groups them (shared prefix, monorepo hints, etc.),
   creates one space per group, attaches folders, and scans each for artifacts.
   DO NOT loop \`onboard_space\` per folder — that produces naive one-space-per-repo
   output and is the wrong tool for a multi-project container.

3. **Confirm with the user** — list the spaces created and roughly how many artifacts
   each picked up. Offer to fix up any grouping they disagree with.

**Honest limitation:** the container discovery currently recognises subfolders with
code-project markers (\`.git\`, \`package.json\`, \`go.mod\`, \`Cargo.toml\`, etc.). A Figma
dump or a writing folder won't be auto-detected as containing "projects" today. If
the user's work is non-code, you may need to call \`onboard_space\` per project folder
(which doesn't need markers), or ask them to point you at individual project folders
rather than a container. This will improve.

If the user gave you an explicit path (\`set up Oyster with my projects at ~/foo\`),
skip step 1 and go straight to \`onboard_container\`.

## Core concepts

**Artifacts** — the items on the desktop. Each artifact has:
- \`id\`: unique identifier (opaque for new artifacts, semantic for legacy ones)
- \`label\`: display name shown under the icon on the desktop
- \`kind\`: one of app | deck | diagram | map | notes | table | wireframe
- \`space\`: which workspace it belongs to (e.g. "home", "tokinvest")
- \`status\`: ready | online | offline | starting | generating
- \`url\`: how to open it (relative path for static files, localhost:PORT for running apps)
- \`group\`: optional visual group on the desktop surface

**Spaces** — named workspaces (tabs) the user switches between. Each space has an ID,
display name, optional repo path, and scan status. Use \`list_spaces\` to enumerate them.
Common spaces: "home" (default), plus one per project (e.g. "tokinvest", "research").
Spaces can be onboarded from a local repo — use \`onboard_space\` to create a space and
scan it for artifacts in one step, or \`scan_space\` to rescan an existing space.

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

**Onboarding a single project:**
1. Call \`list_spaces\` — check if the space already exists (avoid duplicates).
2. Call \`onboard_space\` with the project name and repo path — creates the space and scans for apps, docs, and diagrams in one step.
3. Call \`list_artifacts\` with the new space_id to see what was discovered.
4. To rescan later (e.g. after new files are added), call \`scan_space\`.
5. Call \`gather_repo_context\` to read the repo's key files and get deterministic artifact suggestions — useful before generating summaries or creating new artifacts from repo content.

**Onboarding a developer container (e.g. \`~/Dev\` with many repos):**

DO NOT loop \`onboard_space\` per folder — that produces naive one-space-per-repo output (e.g. separate spaces for \`oyster\`, \`oyster-crm\`, \`oyster-technology\` when they should share one \`oyster\` space).

Instead, use the smart grouping pipeline:

1. Call \`discover_container\` with the container path — returns LLM-grouped suggestions based on shared prefixes, monorepo hints, and framework signals. Dry run, no writes.
2. (Optional) Present the suggestions to the user for confirmation if the grouping looks questionable.
3. Call \`onboard_container\` with the same path to execute: creates one space per group, attaches all folders in that group, scans each. Same logic as the drag-a-folder UX.

Shortcut: call \`onboard_container\` directly if you're confident in the grouping — it internally runs the discover step and returns the full result.

**Working with artifacts:**
- Use \`create_artifact\` to write a new file and register it in one step.
- After \`create_artifact\`, always call \`reveal_artifact\` with the new artifact's id — this switches the user's desktop to the right space and highlights the icon so they know where it landed.
- Use \`read_artifact\` to read the content of an existing static file artifact.
- Use \`update_artifact\` to rename, reassign to a different space, or change the group.
- Use \`remove_artifact\` to hide an artifact from the surface (reversible).

Do NOT read or write the SQLite database (userland/oyster.db) directly.
Files you create must live under: ${userlandDir}/
`.trim();
}

export function createMcpServer(deps: McpDeps): McpServer {
  const server = new McpServer({ name: "oyster", version: "1.0.0" });

  // Monkey-patch `server.tool` so every registered tool emits a
  // `mcp_tool_called` SSE event on completion — but only for external
  // agents. Our own OpenCode subprocess makes many calls during normal
  // operation and would otherwise flood the onboarding action log.
  if (!deps.clientContext.isInternal) {
    const externalUa = deps.clientContext.userAgent;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const originalTool = (server.tool as any).bind(server);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (server as any).tool = (name: string, ...rest: any[]) => {
      const handler = rest.pop();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const wrapped = async (...args: any[]) => {
        const result = await handler(...args);
        try {
          deps.broadcastUiEvent({
            version: 1,
            command: "mcp_tool_called",
            payload: {
              tool: name,
              user_agent: externalUa,
              at: new Date().toISOString(),
              is_error: Boolean(result?.isError),
            },
          });
        } catch { /* best effort — never let telemetry break a tool call */ }
        return result;
      };
      return originalTool(name, ...rest, wrapped);
    };
  }

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

  // ── discover_container ──
  //
  // Same logic the drag-a-folder wizard uses: detect container folder,
  // find project-marker dirs, ask an LLM to group them by naming
  // patterns (shared prefix/suffix, monorepo hints). Returns grouped
  // suggestions; does NOT create anything. Use before onboard_container
  // if you want to show the user a preview, or inspect grouping before
  // committing.

  server.tool(
    "discover_container",
    "Scan a developer container folder (e.g. ~/Dev) and return a grouped proposal for spaces: repos sharing a prefix or that are monorepo-related get merged into one space. Returns { container, candidates, suggestions } without creating anything. Use this first when a user points you at a dev directory with many repos — do NOT call onboard_space per folder, that produces naive one-space-per-repo output.",
    {
      path: z.string().describe("Absolute (or ~ prefixed) path to the container folder — typically the user's ~/Dev or similar"),
    },
    async ({ path: rawPath }) => {
      try {
        const folderPath = rawPath.startsWith("~/")
          ? resolve(join(homedir(), rawPath.slice(2)))
          : resolve(rawPath);
        if (!existsSync(folderPath) || !statSync(folderPath).isDirectory()) {
          return { content: [{ type: "text" as const, text: `Path does not exist or is not a directory: ${folderPath}` }], isError: true };
        }
        const container = isContainer(folderPath);
        if (!container) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({ container: false, path: folderPath, hint: "This looks like a single project. Call onboard_space with this path instead." }, null, 2),
            }],
          };
        }
        const candidates = discoverCandidates(folderPath);
        const suggestions = await groupWithLLM(candidates);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ container: true, path: folderPath, candidates, suggestions }, null, 2),
          }],
        };
      } catch (err) {
        return { content: [{ type: "text" as const, text: (err as Error).message }], isError: true };
      }
    },
  );

  // ── onboard_container ──
  //
  // One-shot smart onboarding for a dev directory. Matches what
  // dropping a folder on the desktop does: discover → LLM-group →
  // create N spaces → attach each group's folders → scan each. Use
  // this instead of looping onboard_space for the "set up my projects
  // at ~/Dev" flow.

  server.tool(
    "onboard_container",
    "Smart onboarding for a developer container folder (e.g. ~/Dev). Discovers candidate projects, groups them logically via LLM (related repos share a space — e.g. 'oyster-crm' + 'oyster-technology' land in one 'oyster' space; 'tokinvest-drc' + 'tokinvest-concept' land in 'tokinvest'), creates each space, attaches the folders, and scans them. Use this — NOT onboard_space per folder — when a user points you at a dev directory. Returns a summary of the spaces created and how many artifacts each picked up.",
    {
      path: z.string().describe("Absolute (or ~ prefixed) path to the container folder — typically the user's ~/Dev or similar"),
    },
    async ({ path: rawPath }) => {
      try {
        const folderPath = rawPath.startsWith("~/")
          ? resolve(join(homedir(), rawPath.slice(2)))
          : resolve(rawPath);
        if (!existsSync(folderPath) || !statSync(folderPath).isDirectory()) {
          return { content: [{ type: "text" as const, text: `Path does not exist or is not a directory: ${folderPath}` }], isError: true };
        }
        const container = isContainer(folderPath);
        if (!container) {
          // Treat as a single project — create one space from it.
          const leafName = basename(folderPath);
          const space = deps.spaceService.createSpace({ name: leafName, repoPath: folderPath });
          const scan = await deps.spaceService.scanSpace(space.id);
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                container: false,
                spaces_created: [{ space_id: space.id, name: leafName, folders: [folderPath], scanned: scan.discovered + scan.resurfaced }],
              }, null, 2),
            }],
          };
        }

        const candidates = discoverCandidates(folderPath);
        const suggestions = await groupWithLLM(candidates);

        const results: Array<{ space_id: string; name: string; folders: string[]; scanned: number; error?: string }> = [];
        for (const s of suggestions) {
          try {
            let space;
            try {
              space = deps.spaceService.createSpace({ name: s.name });
            } catch {
              const slug = s.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
              const existing = deps.spaceService.getSpace(slug);
              if (!existing) throw new Error(`Could not create or find space "${s.name}"`);
              space = existing;
            }
            for (const folder of s.folders) {
              try { deps.spaceService.addPath(space.id, folder); } catch { /* path may already be attached */ }
            }
            const scan = await deps.spaceService.scanSpace(space.id);
            results.push({
              space_id: space.id,
              name: s.name,
              folders: s.folders,
              scanned: scan.discovered + scan.resurfaced,
            });
          } catch (err) {
            results.push({ space_id: "", name: s.name, folders: s.folders, scanned: 0, error: (err as Error).message });
          }
        }

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ container: true, path: folderPath, spaces_created: results }, null, 2),
          }],
        };
      } catch (err) {
        return { content: [{ type: "text" as const, text: (err as Error).message }], isError: true };
      }
    },
  );

  // ── scan_space ──

  server.tool(
    "scan_space",
    "Rescan an existing space's repo for new apps, docs, and diagrams. Already-registered artifacts are skipped (idempotent). Use this after adding new files to a repo that was previously onboarded.",
    {
      space_id: z.string().describe("ID of the space to scan"),
    },
    async ({ space_id }) => {
      try {
        const result = await deps.spaceService.scanSpace(space_id);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return { content: [{ type: "text" as const, text: (err as Error).message }], isError: true };
      }
    },
  );

  // ── gather_repo_context ──

  server.tool(
    "gather_repo_context",
    "Read key files from a local repo and return them as a structured context payload, along with deterministic artifact suggestions (READMEs, diagrams, apps detected from package.json). Stays within a ~30k token budget. Does NOT create artifacts — call create_artifact separately if you want to persist any output.",
    {
      repo_path: z.string().describe("Absolute local path to the repository root"),
    },
    async ({ repo_path }) => {
      try {
        const result = gatherRepoContext(repo_path);
        return {
          content: [{ type: "text" as const, text: result.content }],
          structuredContent: { suggestions: result.suggestions },
        };
      } catch (err) {
        return { content: [{ type: "text" as const, text: (err as Error).message }], isError: true };
      }
    },
  );

  // ── list_artifacts ──

  server.tool(
    "list_artifacts",
    "List artifacts (desktop icons) on the Oyster surface, optionally filtered by space, kind, or search term. Returns id, label, kind, space, status, url, group, and source_path for each artifact.",
    {
      space_id: z.string().optional().describe("Filter by space"),
      artifact_kind: z
        .enum(ARTIFACT_KINDS)
        .optional()
        .describe("Filter by artifact kind"),
      search: z.string().optional().describe("Search term — filters artifacts whose label contains this text (case-insensitive)"),
      limit: z.number().int().min(1).max(100).optional().describe("Max results to return (default 20)"),
    },
    async ({ space_id, artifact_kind, search, limit }) => {
      let artifacts = await deps.service.getAllArtifacts();
      if (space_id) artifacts = artifacts.filter((a) => a.spaceId === space_id);
      if (artifact_kind) artifacts = artifacts.filter((a) => a.artifactKind === artifact_kind);
      if (search) {
        const q = search.toLowerCase();
        artifacts = artifacts.filter((a) => a.label.toLowerCase().includes(q));
      }
      artifacts = artifacts.slice(0, limit ?? 20);

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
      debug("mcp", "register_artifact invoked", { path, label, id: id ?? null, space_id, kind: artifact_kind ?? null });
      try {
        const artifact = await deps.service.registerArtifact(
          { path, space_id, label, id, artifact_kind, group_name },
          [], // MCP callers are trusted — no path restriction
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
      source_origin: z.enum(["manual", "ai_generated"]).optional().describe("Provenance of the artifact. Defaults to 'manual'. Use 'ai_generated' when the content was produced by an AI agent."),
    },
    async ({ space_id, label, artifact_kind, content, subdir, group_name, source_origin }) => {
      debug("mcp", "create_artifact invoked", { label, space_id, kind: artifact_kind, subdir: subdir ?? null });
      try {
        const artifact = await deps.service.createArtifact(
          { space_id, label, artifact_kind, content, subdir, group_name, source_origin },
          deps.userlandDir,
        );
        return {
          content: [{ type: "text" as const, text: JSON.stringify(artifact, null, 2) }],
          structuredContent: { ...artifact },
        };
      } catch (err) {
        return { content: [{ type: "text" as const, text: (err as Error).message }], isError: true };
      }
    },
  );

  // ── update_artifact ──

  server.tool(
    "update_artifact",
    "Update display metadata: label, space assignment, group name, or artifact kind. Does not rename or move the file on disk.",
    {
      id: z.string().describe("Artifact ID to update"),
      label: z.string().optional().describe("New display name"),
      space_id: z.string().optional().describe("Reassign to a different space (tab). Does not move the file."),
      group_name: z.string().optional().describe("Change visual group. Pass empty string to remove grouping."),
      artifact_kind: z.enum(["app", "deck", "map", "notes", "diagram", "wireframe", "table"]).optional().describe("Correct the artifact kind if it was inferred incorrectly."),
    },
    async ({ id, label, space_id, group_name, artifact_kind }) => {
      try {
        const updated = await deps.service.updateArtifact(id, {
          label,
          space_id,
          artifact_kind,
          ...(group_name !== undefined ? { group_name: group_name || null } : {}),
        });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(updated, null, 2) }],
          structuredContent: { ...updated },
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

  // ── reveal_artifact ──

  server.tool(
    "reveal_artifact",
    "Flag an artifact to be revealed on the user's desktop — the UI will switch to its space and briefly highlight the icon on the next poll. Call this after create_artifact so the user knows where to find what you just created.",
    { id: z.string().describe("Artifact ID to reveal") },
    async ({ id }) => {
      const artifact = await deps.service.getArtifactById(id);
      if (!artifact) {
        return { content: [{ type: "text" as const, text: `Artifact "${id}" not found` }], isError: true };
      }
      deps.pendingReveals.add(id);
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ revealed: id, space: artifact.spaceId, label: artifact.label }) }],
      };
    },
  );

  // ── open_artifact ──

  server.tool(
    "open_artifact",
    "Open an artifact in the user's viewer window by exact ID. The UI switches to the artifact's space and opens the viewer immediately. Use list_artifacts(search) first to find the right ID.",
    { id: z.string().describe("Artifact ID to open") },
    async ({ id }) => {
      const artifact = await deps.service.getArtifactById(id);
      if (!artifact) {
        return { content: [{ type: "text" as const, text: `Artifact "${id}" not found. Use list_artifacts to find available artifacts.` }], isError: true };
      }
      deps.broadcastUiEvent({
        version: 1,
        command: "open_artifact",
        payload: { id: artifact.id, spaceId: artifact.spaceId, label: artifact.label, url: artifact.url, artifactKind: artifact.artifactKind },
      });
      return { content: [{ type: "text" as const, text: `Opened "${artifact.label}"` }] };
    },
  );

  // ── switch_space ──

  server.tool(
    "switch_space",
    "Switch the user's desktop to a different space by exact ID. The UI navigates immediately. Use list_spaces first to find available space IDs.",
    { id: z.string().describe("Space ID to switch to") },
    async ({ id }) => {
      const spaces = deps.spaceService.listSpaces();
      const space = spaces.find(s => s.id === id);
      if (!space) {
        return { content: [{ type: "text" as const, text: `Space "${id}" not found. Available: ${spaces.map(s => s.id).join(", ")}` }], isError: true };
      }
      deps.broadcastUiEvent({
        version: 1,
        command: "switch_space",
        payload: { spaceId: space.id },
      });
      return { content: [{ type: "text" as const, text: `Switched to "${space.displayName}"` }] };
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

  // ── Memory tools ──
  registerMemoryTools(server, deps.memoryProvider);

  return server;
}
