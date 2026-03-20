# Move registry.json to Userland — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move `server/registry.json` out of the repo and into `userland/`, so user-specific artifact registrations (apps, docs) are not committed to source control.

**Architecture:** `loadRegistry()` in `process-manager.ts` currently reads from `server/registry.json` via a hardcoded `__dirname`-relative path. We add a configurable registry path, set it to `userland/registry.json` during bootstrap, and seed an empty registry if no file exists. The stale module-level registry in `index.ts` is replaced with per-request reads. `server/registry.json` is deleted from git and gitignored.

**Tech Stack:** Node.js, TypeScript (server-side only — no frontend changes)

---

### Task 1: Make registry path configurable in `process-manager.ts`

**Files:**
- Modify: `server/src/process-manager.ts:35,68-71`

- [ ] **Step 1: Add `setRegistryPath` and update `loadRegistry`**

Replace the hardcoded path with a module-level variable and a setter:

```ts
// ── Registry ──

let registryPath = join(__dirname, "..", "registry.json"); // default fallback

export function setRegistryPath(path: string): void {
  registryPath = path;
}

export function loadRegistry(): Registry {
  if (!existsSync(registryPath)) return { apps: [], docs: [] };
  const raw = readFileSync(registryPath, "utf8");
  return JSON.parse(raw) as Registry;
}
```

Note: the `existsSync` guard means a missing registry file returns an empty registry instead of crashing. This handles first-run before the user has configured anything.

- [ ] **Step 2: Verify the server still compiles**

Run: `cd server && npx tsc --noEmit`
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add server/src/process-manager.ts
git commit -m "feat: make registry path configurable in process-manager"
```

---

### Task 2: Bootstrap registry into userland

**Files:**
- Modify: `server/src/index.ts:1-2,6-7,70-84,94-100`

- [ ] **Step 1: Import `setRegistryPath` and configure during bootstrap**

In `index.ts`, add `setRegistryPath` to the existing import from `./process-manager.js`:

```ts
import {
  loadRegistry,
  setRegistryPath,
  getAllArtifacts,
  startApp,
  stopApp,
  isPortOpen,
  waitForReady,
  updateGeneratedArtifact,
} from "./process-manager.js";
```

Then in `bootstrapUserland()`, add at the end (after the existing `syncIfNewer` calls):

```ts
function bootstrapUserland() {
  mkdirSync(USERLAND_DIR, { recursive: true });
  mkdirSync(`${USERLAND_DIR}/.opencode/agents`, { recursive: true });

  syncIfNewer(
    `${PROJECT_ROOT}/.opencode/agents/oyster.md`,
    `${USERLAND_DIR}/.opencode/agents/oyster.md`,
  );
  syncIfNewer(
    `${PROJECT_ROOT}/.opencode/config.toml`,
    `${USERLAND_DIR}/.opencode/config.toml`,
  );

  // Point registry at userland (user content, not project source)
  setRegistryPath(join(USERLAND_DIR, "registry.json"));
}
```

No seed file is written — `loadRegistry()` already returns `{ apps: [], docs: [] }` when the file is missing. Users create `userland/registry.json` manually when they have apps/docs to register.

- [ ] **Step 2: Remove module-level stale registry and docsMap**

Delete these lines (currently ~94-100):

```ts
// ── Registry ──

const registry = loadRegistry();
const docsMap = new Map<string, string>();
for (const doc of registry.docs) {
  docsMap.set(doc.name, doc.file);
}
```

- [ ] **Step 3: Fix `/api/apps/:name/start` route — use fresh registry read**

Replace the stale `registry.apps.find(...)` with a fresh read (currently ~line 159):

```ts
  // GET /api/apps/:name/start
  const startMatch = url.match(/^\/api\/apps\/([^/]+)\/start$/);
  if (startMatch) {
    const name = startMatch[1];
    const reg = loadRegistry();
    const app = reg.apps.find((a) => a.name === name);
    if (!app) {
      res.writeHead(404);
      res.end("Unknown app");
      return;
    }
    // ... rest unchanged
```

- [ ] **Step 4: Fix `/api/apps/:name/stop` route — use fresh registry read**

Same pattern (currently ~line 187):

```ts
  // GET /api/apps/:name/stop
  const stopMatch = url.match(/^\/api\/apps\/([^/]+)\/stop$/);
  if (stopMatch) {
    const name = stopMatch[1];
    const reg = loadRegistry();
    const app = reg.apps.find((a) => a.name === name);
    // ... rest unchanged
```

- [ ] **Step 5: Fix `/docs/:name` route — read registry per-request instead of stale docsMap**

Replace the `docsMap.get(name)` lookup with a fresh registry read (currently ~line 199):

```ts
  // GET /docs/:name
  const docsMatch = url.split("?")[0].match(/^\/docs\/([^/]+)$/);
  if (docsMatch) {
    const name = docsMatch[1];
    const reg = loadRegistry();
    const doc = reg.docs.find((d) => d.name === name);
    if (!doc || !existsSync(doc.file)) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    const ext = extname(doc.file);
    const mime = MIME[ext] || "application/octet-stream";

    if (ext === ".md") {
      const content = readFileSync(doc.file, "utf8");
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(renderMarkdown(name, content));
    } else {
      res.writeHead(200, { "Content-Type": mime });
      res.end(readFileSync(doc.file));
    }
    return;
  }
```

- [ ] **Step 6: Remove unused `loadRegistry` import if it was only used at module level**

Check: `loadRegistry` is still imported for the route handlers above, so it stays. But confirm the import list is clean (no unused imports).

- [ ] **Step 7: Verify the server still compiles**

Run: `cd server && npx tsc --noEmit`
Expected: no errors

- [ ] **Step 8: Commit**

```bash
git add server/src/index.ts
git commit -m "feat: read registry from userland, remove stale module-level cache"
```

---

### Task 3: Remove `server/registry.json` from repo and gitignore it

**Files:**
- Delete from git: `server/registry.json`
- Modify: `.gitignore`

- [ ] **Step 1: Copy current registry.json to userland for the developer**

```bash
cp server/registry.json userland/registry.json
```

This preserves the existing registrations for the current developer. The file is already gitignored via the `userland/` entry in `.gitignore`.

- [ ] **Step 2: Remove `server/registry.json` from git tracking**

```bash
git rm server/registry.json
```

- [ ] **Step 3: Add `server/registry.json` to `.gitignore`**

Add under the existing entries, in case someone accidentally recreates it:

```
server/registry.json
```

- [ ] **Step 4: Commit**

```bash
git add .gitignore
git commit -m "chore: remove registry.json from repo — now lives in userland"
```

---

### Verification

After all tasks:

1. `cd server && npx tsc --noEmit` — compiles cleanly
2. Start the server (`npm run dev` or equivalent) — no crash
3. `GET /api/artifacts` — returns apps and docs from `userland/registry.json`
4. Click a doc artifact — `/docs/:name` serves it correctly
5. Delete `userland/registry.json` and restart — server starts with empty artifact list (no crash)
6. `git status` — `server/registry.json` is not tracked, `userland/registry.json` is not tracked
7. Clone the repo fresh — no `registry.json` present, server starts cleanly with empty registry
