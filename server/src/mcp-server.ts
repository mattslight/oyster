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
import { slugify } from "./utils.js";
import { recordToolCall } from "./mcp-client-tracker.js";

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

When the user asks you to set up Oyster / discover their projects / get them
started, YOU do the audit. Oyster does NOT have a server-side classifier; it
relies on your intelligence + your own tools (shell, file reads, git log, etc.)
to understand the user's filesystem and propose a set of spaces.

### Step 1 — Audit the filesystem (takes minutes, that's fine)

Probe common places where users keep work. Don't limit yourself to \`~/Dev\`.
Inspect each place with shell / ls / file reads. For each promising subfolder:

- Is there a \`.git\`? Run \`git -C <path> log -1 --format=%cs\` to see last-commit
  date — separates active from dormant.
- Is there a README, \`package.json\`, \`pyproject.toml\`, \`go.mod\`, etc.? Read
  it briefly to understand what the project actually is.
- Are there substantive files without code markers (\`.md\`, \`.docx\`, \`.fig\`,
  \`.key\`)? That's a non-code project — writing, design, PM work — still a
  project worth a space.
- Is it a vendored dependency, a third-party fork, or a library the user is
  tracking rather than actively developing? That's not a user-owned project;
  it belongs in "other" or flagged as an open question, not its own space.
- Is it noise (a cache dump, a worktree scratch dir, OS-default folders,
  app data like \`~/Documents/Zoom\`)? Filter out.

Probe list to start (Mac / Linux; substitute \`%USERPROFILE%\\\` on Windows):
\`~/Dev\`, \`~/dev\`, \`~/Development\`, \`~/code\`, \`~/repos\`, \`~/src\`,
\`~/Projects\`, \`~/projects\`, \`~/Work\`, \`~/work\`, \`~/workspace\`,
\`~/Documents/Projects\`, \`~/Documents/Work\`, \`~/Documents\`, \`~/Desktop\`,
\`~/Design\`, \`~/Figma\`, \`~/Writing\`, \`~/Notes\`.

Windows users: also check other drives — \`C:\\Development\`, \`E:\\Development\`,
\`D:\\Work\`, etc.

Don't exhaustively scan everything. Stop when you have a clear picture of the
user's active projects.

### Step 2 — Group intelligently

- Related things belong together: signals include a shared prefix or suffix
  in folder names, a monorepo structure, or a common theme.
- Unrelated odds and ends (single configs, third-party things the user doesn't
  own) can go in an \`other\` bucket if they matter, or be filtered as noise.
- Space names are short, lowercase, and human — pick whatever the user
  would actually call this part of their work.

### Step 3 — Present the plan to the user in chat BEFORE applying

Show:
- The proposed spaces with the folders in each and a one-sentence reason why.
- What you'd filter as noise (with reasons).
- Any open questions you want them to answer first.

Don't apply silently. Don't dump raw JSON. Format it readably — the user is
reviewing a plan, not consuming an API response.

### Step 4 — Apply once confirmed

For each confirmed space, call \`onboard_space\` with a \`name\` and a \`paths\`
array (absolute paths). One call creates the space, attaches every path, and
scans each. For multi-folder spaces make ONE call with all the paths in the
array — don't loop once per folder.

### Step 5 — Confirm back

Tell the user how many spaces were created and rough artifact counts per space.
Offer to adjust anything that looks off.

### If the user gave you an explicit path

(e.g. *"set up Oyster with my projects at ~/foo"*)

Skip the probe. Start at Step 1 for just that path — walk its subfolders, apply
the same judgement, propose, confirm, apply.

### Don't silently drop anything

If you considered a folder and decided it wasn't a project, say so in the plan
and give a short reason. Never omit folders from the plan without telling the
user. If you're unsure whether something counts, flag it as an open question
and let the user decide.

## "Here's my context from another AI" — import playbook

If the user pastes content that describes their spaces / projects / summaries /
memories — a dump they asked ChatGPT, Claude, or another tool to produce using
Oyster's import prompt — DON'T treat it as opaque text and DON'T ask what to do
with it. Extract the structure and apply.

The paste may be YAML, JSON, paraphrased Markdown, or a mix — don't rely on
strict parsing. Read the content, identify the three categories, and apply via
these tools:

- **Spaces / projects** → call \`onboard_space({ name })\` once per space.
  Paths are NOT required; spaces are logical groupings. Don't invent filesystem
  paths. If the user later points at real folders, attach them then.
- **Summaries** → call \`set_space_summary({ name, title, content })\` once per
  space summary in the paste.
- **Memories** → call \`remember({ content, tags, space })\` once per memory.
  Use the space name from the memory's \`space\` field; apply verbatim tags
  if present.

When done, confirm with a short "applied N spaces, M summaries, K memories" and
offer to attach filesystem paths to any of the spaces if the user wants them
connected to real folders on disk.

## Core concepts

**Artifacts** — the items on the desktop. Each artifact has:
- \`id\`: unique identifier (opaque for new artifacts, semantic for legacy ones)
- \`label\`: display name shown under the icon on the desktop
- \`kind\`: one of app | deck | diagram | map | notes | table | wireframe
- \`space\`: which workspace it belongs to (e.g. "home", or any space name the user set up)
- \`status\`: ready | online | offline | starting | generating
- \`url\`: how to open it (relative path for static files, localhost:PORT for running apps)
- \`group\`: optional visual group on the desktop surface

**Spaces** — named workspaces (tabs) the user switches between. Each space has an ID,
display name, and scan status. Use \`list_spaces\` to enumerate them. Every workspace
has a "home" space by default; the user adds others as they onboard projects. Spaces
are logical groupings — they can optionally have one or more folders attached (scan
sources). Use \`onboard_space\` to create a space (with or without paths), or
\`scan_space\` to rescan folders already attached to a space.

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
2. Call \`onboard_space\` with the project name and path — pass \`paths: ["/abs/path"]\` (array). Creates the space, attaches the path, scans for apps, docs, and diagrams.
3. Call \`list_artifacts\` with the new space_id to see what was discovered.
4. To rescan later (e.g. after new files are added), call \`scan_space\`.
5. Call \`gather_repo_context\` to read the repo's key files and get deterministic artifact suggestions — useful before generating summaries or creating new artifacts from repo content.

**Onboarding a developer container (e.g. \`~/Dev\` with many repos):**

Don't loop \`onboard_space\` once per folder. Group related projects first (shared prefix / suffix / clear theme), then call \`onboard_space({ name: "oyster", paths: [path1, path2, path3] })\` — one call per grouped space, with every related folder in the \`paths\` array.

See the "Set up Oyster for me" playbook above for the full audit + propose + apply flow.

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
          recordToolCall(externalUa);
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
    "List all spaces (named workspaces) on the Oyster desktop. A space is a tab the user switches between — 'home' is always present; others are user-defined.",
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
    "Create a space (or extend one with the same name) as a logical grouping for work. Spaces are named workspaces the user switches between — they don't require filesystem paths. If `paths` are provided, each folder is attached and scanned for apps, docs, and diagrams; if not, the space is created empty as a logical grouping (summaries, memories, and artifacts can attach later). If a space with this name already exists, any given paths are attached to it — NOT duplicated into a new one. Returns `created: true` when a new space was made, `created: false` when an existing one was extended.",
    {
      name: z.string().describe("Display name for the space (slugified to ID). If a space with this name already exists, it's extended — no duplicate."),
      paths: z.array(z.string()).optional().describe("Optional. Absolute local paths to attach and scan. Omit for a logical grouping with no filesystem attachment."),
    },
    async ({ name, paths }) => {
      try {
        const resolvedPaths = paths && paths.length > 0 ? paths : [];

        // Extend-or-create: try to create the space first. If it already
        // exists, look it up by slugified id and attach paths to it. Either
        // way, every resolvedPath gets added via addPath (which is idempotent
        // for paths already attached to THIS space).
        let space;
        let created = false;
        try {
          space = deps.spaceService.createSpace({ name });
          created = true;
        } catch (err) {
          const msg = (err as Error).message;
          if (/already exists/i.test(msg)) {
            // Reuse the canonical slugify so this lookup can never diverge from
            // the slug createSpace actually used when the conflicting row was inserted.
            const existing = deps.spaceService.getSpace(slugify(name));
            if (!existing) throw err;
            space = existing;
          } else {
            throw err;
          }
        }

        const pathReports: Array<{ path: string; status: "attached" | "owned-by-other-space" | "failed"; error?: string }> = [];
        for (const p of resolvedPaths) {
          try {
            deps.spaceService.addPath(space.id, p);
            // `attached` covers both \"newly added\" and \"already attached to
            // THIS space\" — spaceStore.addPath is INSERT OR IGNORE so a
            // duplicate silently no-ops.
            pathReports.push({ path: p, status: "attached" });
          } catch (err) {
            const msg = (err as Error).message;
            // `addPath` only throws for paths that don't exist on disk OR
            // paths already claimed by a DIFFERENT space (addPath's
            // conflict guard). The latter means THIS space still has
            // no folders for that path, so we must not count it as
            // attached for the scan-guard below.
            const ownedElsewhere = /already attached/i.test(msg);
            pathReports.push({ path: p, status: ownedElsewhere ? "owned-by-other-space" : "failed", error: msg });
          }
        }

        // Only scan when at least one path actually attached to THIS space.
        // If every path failed (missing on disk, owned by another space),
        // scanSpace would throw \"no folders\" and the agent would see a
        // confusing scan error on top of per-path errors already in `paths`.
        const anyAttached = pathReports.some((r) => r.status === "attached");
        const scanResult = anyAttached ? await deps.spaceService.scanSpace(space.id) : null;
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ space_id: space.id, created, paths: pathReports, scan_summary: scanResult }, null, 2),
          }],
        };
      } catch (err) {
        return { content: [{ type: "text" as const, text: (err as Error).message }], isError: true };
      }
    },
  );

  // ── set_space_summary ──

  server.tool(
    "set_space_summary",
    "Attach a short summary (title + content) to a space. Use this to capture what a space is about — context, focus, or scope — in the user's own terms. Upserts on the space's slugified name: if the space exists, its summary is updated; if not, a logical space is created with the summary attached. One summary per space.",
    {
      name: z.string().describe("Space name (display name or slug). Looked up by slugified id; created if missing."),
      title: z.string().describe("Short title for the summary (e.g. 'Chess Training Platform')."),
      content: z.string().describe("The summary itself — what this space is about, in a sentence or two."),
    },
    async ({ name, title, content }) => {
      try {
        let space = deps.spaceService.getSpace(slugify(name));
        if (!space) space = deps.spaceService.createSpace({ name });
        const updated = deps.spaceService.setSummary(space.id, title, content);
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ space_id: updated.id, title: updated.summaryTitle, content: updated.summaryContent }, null, 2) }],
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
      space_id: z.string().describe("Space to place the artifact in (use `list_spaces` to see what's available)"),
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
