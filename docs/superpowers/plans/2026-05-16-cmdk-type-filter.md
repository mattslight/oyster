# cmd+K type filter — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let cmd+K narrow results by entity type (`@session`, `@artefact`, `@memory`) and optionally by space (`#space-id`), via an inline autocomplete dropdown triggered by `@` or `#`. Memory is added as a third searchable source.

**Architecture:** Filter state (`{ type, spaceId, query }`) lives separately from the raw input string. Tokens render as removable chips inside the existing `.spotlight-input-row`. Typing `@` or `#` opens a popover anchored to the caret; selecting an option consumes the prefix text and sets the filter. Sources fan out in parallel from the same `(filter, query)` tuple. Backend gains a memory search HTTP endpoint and space scoping on the existing session search.

**Tech Stack:** TypeScript, React (web), Node http (server), better-sqlite3 + FTS5 (storage), vitest (server tests). Web has no unit tests — UI work is verified manually via `npm run dev` + browser.

**Spec:** `docs/superpowers/specs/2026-05-16-cmdk-type-filter-design.md`

---

## File Map

| Path | Action | Responsibility |
|---|---|---|
| `server/src/memory-store.ts` | modify | Add `search()` — pure FTS, no recall logging |
| `server/test/memory-store.test.ts` | modify | Tests for `search()` |
| `server/src/routes/memories.ts` | modify | Add `GET /api/memories/search` |
| `server/test/memories-search-route.test.ts` | create | Route tests |
| `server/src/session-store.ts` | modify | Accept `spaceId` in `searchEvents()` |
| `server/src/routes/sessions.ts` | modify | Pass `space_id` through to `searchEvents` |
| `server/test/sessions-search-space.test.ts` | create | Space-scoping test |
| `web/src/data/memories-api.ts` | modify | Add `searchMemories()` |
| `web/src/data/sessions-api.ts` | modify | Extend `searchTranscripts` with `spaceId` |
| `web/src/components/SpotlightSearch.tsx` | modify | All UI changes |
| `web/src/App.css` | modify | Chip + popover styles (~80 lines near existing `.spotlight-*`) |

---

## Task 1: Pure memory search method

Adds a side-effect-free FTS search to `MemoryProvider`. The existing `recall()` bumps access counts and writes to `memory_recalls`, which is wrong for cmd+K — searching shouldn't pollute "what this session recalled" stats.

**Files:**
- Modify: `server/src/memory-store.ts:50-71` (`MemoryProvider` interface) and the `recall` implementation around line 598
- Modify: `server/test/memory-store.test.ts`

- [ ] **Step 1: Write the failing test**

In `server/test/memory-store.test.ts`, inside the top-level `describe("SqliteFtsMemoryProvider", …)` block, add a new `describe`:

```ts
describe("search", () => {
  it("returns FTS-ranked rows without bumping recall stats", async () => {
    const a = await provider.remember({ content: "auth middleware notes", space_id: "tokinvest" });
    await provider.remember({ content: "completely unrelated note about cooking", space_id: "tokinvest" });

    const beforeRow = (provider as unknown as { db: { prepare: (s: string) => { get: (...args: unknown[]) => { access_count: number } } } })
      .db.prepare("SELECT access_count FROM memories WHERE id = ?").get(a.id);

    const hits = await provider.search({ query: "auth" });

    expect(hits.map(h => h.id)).toContain(a.id);
    expect(hits.length).toBe(1);

    const afterRow = (provider as unknown as { db: { prepare: (s: string) => { get: (...args: unknown[]) => { access_count: number } } } })
      .db.prepare("SELECT access_count FROM memories WHERE id = ?").get(a.id);
    expect(afterRow.access_count).toBe(beforeRow.access_count);
  });

  it("scopes to a space when space_id is set, plus globals", async () => {
    const inSpace = await provider.remember({ content: "scoped finding", space_id: "tokinvest" });
    const global = await provider.remember({ content: "global finding" });
    await provider.remember({ content: "other space finding", space_id: "other" });

    const hits = await provider.search({ query: "finding", space_id: "tokinvest" });
    const ids = hits.map(h => h.id);
    expect(ids).toContain(inSpace.id);
    expect(ids).toContain(global.id);
    expect(ids.length).toBe(2);
  });

  it("returns empty array when query has no usable terms", async () => {
    await provider.remember({ content: "anything" });
    expect(await provider.search({ query: "" })).toEqual([]);
    expect(await provider.search({ query: "?!" })).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run test/memory-store.test.ts -t "search"`
Expected: FAIL with "provider.search is not a function" or similar.

- [ ] **Step 3: Add `search` to the `MemoryProvider` interface**

In `server/src/memory-store.ts`, locate the `MemoryProvider` interface (around line 50). After the `recall(...)` declaration, add:

```ts
  /** Side-effect-free FTS search. Like recall() but does NOT bump
   *  access_count or write memory_recalls rows. Used by the cmd+K
   *  spotlight where "searching" is not the same as "the agent
   *  recalled it for use". */
  search(input: { query: string; space_id?: string | null; limit?: number }): Promise<Memory[]>;
```

- [ ] **Step 4: Implement `search` on `SqliteFtsMemoryProvider`**

In `server/src/memory-store.ts`, immediately after the existing `recall(...)` method (which ends around line 639), add:

```ts
  async search(input: { query: string; space_id?: string | null; limit?: number }): Promise<Memory[]> {
    const limit = input.limit ?? 10;
    const spaceId = input.space_id ?? null;

    const terms = input.query
      .replace(/[^\w\s]/g, "")
      .split(/\s+/)
      .filter((t) => t.length > 1);
    if (terms.length === 0) return [];
    const ftsQuery = terms.join(" OR ");

    let sql: string;
    let params: unknown[];

    if (spaceId) {
      sql = `SELECT m.* FROM memories m
             JOIN memories_fts fts ON m.rowid = fts.rowid
             WHERE memories_fts MATCH ? AND m.superseded_by IS NULL
               AND (m.space_id = ? OR m.space_id IS NULL)
             ORDER BY fts.rank
             LIMIT ?`;
      params = [ftsQuery, spaceId, limit];
    } else {
      sql = `SELECT m.* FROM memories m
             JOIN memories_fts fts ON m.rowid = fts.rowid
             WHERE memories_fts MATCH ? AND m.superseded_by IS NULL
             ORDER BY fts.rank
             LIMIT ?`;
      params = [ftsQuery, limit];
    }

    const rows = this.db.prepare(sql).all(...params) as MemoryRow[];
    return rows.map(rowToMemory);
  }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd server && npx vitest run test/memory-store.test.ts -t "search"`
Expected: PASS, three tests.

- [ ] **Step 6: Commit**

```bash
git add server/src/memory-store.ts server/test/memory-store.test.ts
git commit -m "feat(memory): add side-effect-free search() to MemoryProvider"
```

---

## Task 2: HTTP route `GET /api/memories/search`

Exposes Task 1's method over HTTP. Local-origin only, matching the rest of the memory route surface.

**Files:**
- Modify: `server/src/routes/memories.ts` (around line 82, before the `GET /api/memories` block)
- Create: `server/test/memories-search-route.test.ts`

- [ ] **Step 1: Write the failing test**

Create `server/test/memories-search-route.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { SqliteFtsMemoryProvider } from "../src/memory-store.js";
import { tryHandleMemoryRoute } from "../src/routes/memories.js";

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "oyster-mem-route-"));
  const provider = new SqliteFtsMemoryProvider(dir);
  await provider.init();

  const server = createServer(async (req, res) => {
    const url = req.url ?? "/";
    const ctx = {
      sendJson: (body: unknown, status = 200) => {
        res.statusCode = status;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(body));
      },
      sendError: (e: unknown) => {
        res.statusCode = 500;
        res.end(String(e));
      },
      readJsonBody: async () => ({}),
      rejectIfNonLocalOrigin: () => false,
    };
    const handled = await tryHandleMemoryRoute(req, res, url, ctx as never, {
      memoryProvider: provider,
      resolveCurrentOwnerId: () => null,
      memorySync: { reconcile: async () => ({ pulled: 0, pushed: 0 }), pushPending: async () => {}, pull: async () => 0 } as never,
    });
    if (!handled) { res.statusCode = 404; res.end(); }
  });
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as AddressInfo).port;
  return { dir, provider, server, port };
}

async function teardown(s: { dir: string; provider: SqliteFtsMemoryProvider; server: Server }) {
  s.provider.close();
  rmSync(s.dir, { recursive: true, force: true });
  await new Promise<void>((r) => s.server.close(() => r()));
}

describe("GET /api/memories/search", () => {
  let s: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => { s = await setup(); });
  afterEach(async () => { await teardown(s); });

  it("returns matching memories ordered by FTS rank", async () => {
    await s.provider.remember({ content: "auth middleware design", space_id: "tokinvest" });
    await s.provider.remember({ content: "unrelated note", space_id: "tokinvest" });

    const r = await fetch(`http://localhost:${s.port}/api/memories/search?q=auth`);
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.length).toBe(1);
    expect(body[0].content).toContain("auth");
  });

  it("honors space_id", async () => {
    await s.provider.remember({ content: "finding x", space_id: "a" });
    await s.provider.remember({ content: "finding y", space_id: "b" });
    const r = await fetch(`http://localhost:${s.port}/api/memories/search?q=finding&space_id=a`);
    const body = await r.json();
    expect(body.length).toBe(1);
    expect(body[0].space_id).toBe("a");
  });

  it("returns [] for empty query", async () => {
    const r = await fetch(`http://localhost:${s.port}/api/memories/search?q=`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run test/memories-search-route.test.ts`
Expected: FAIL — all three return 404.

- [ ] **Step 3: Wire the route**

In `server/src/routes/memories.ts`, **before** the final block that bails with `if (memoriesPath !== "/api/memories") return false;` (around line 82), insert:

```ts
  // GET /api/memories/search?q=…&space_id=…&limit=…
  // FTS5 search over memories. Side-effect-free (does NOT update
  // access counts or write memory_recalls). Local-origin only.
  if (req.method === "GET" && memoriesPath === "/api/memories/search") {
    if (rejectIfNonLocalOrigin()) return true;
    const parsed = new URL(req.url ?? "/", "http://localhost");
    const q = parsed.searchParams.get("q") ?? "";
    const spaceId = parsed.searchParams.get("space_id");
    const limitRaw = parsed.searchParams.get("limit");
    let limit: number | undefined;
    if (limitRaw !== null) {
      const n = Number(limitRaw);
      if (Number.isFinite(n) && n >= 1) limit = Math.min(50, Math.floor(n));
    }
    try {
      const hits = await memoryProvider.search({
        query: q,
        space_id: spaceId ?? undefined,
        limit,
      });
      sendJson(hits);
    } catch (err) {
      sendError(err);
    }
    return true;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run test/memories-search-route.test.ts`
Expected: PASS, three tests.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/memories.ts server/test/memories-search-route.test.ts
git commit -m "feat(memory): GET /api/memories/search endpoint"
```

---

## Task 3: Space scoping on session search

Adds optional `space_id` to `sessionStore.searchEvents()` and the `/api/sessions/search` route.

**Files:**
- Modify: `server/src/session-store.ts` (interface around line 147, implementation around line 422)
- Modify: `server/src/routes/sessions.ts:269-300`
- Create: `server/test/sessions-search-space.test.ts`

- [ ] **Step 1: Write the failing test**

Create `server/test/sessions-search-space.test.ts`. Mirror the harness used by `server/test/session-store-project-id.test.ts` — open that file first and copy its `setup`/`teardown` shape. The test should:

```ts
// Two sessions in different spaces, both containing the word "auth" in an event.
// search({ query: "auth", spaceId: "alpha" }) must return only the alpha session.
```

Write three assertions:

1. With `spaceId: "alpha"` set, only the alpha session's hit is returned.
2. Without `spaceId`, both hits are returned (regression guard).
3. `spaceId: "nonexistent"` returns an empty array.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run test/sessions-search-space.test.ts`
Expected: FAIL — `opts.spaceId` is ignored, so all three tests fail.

- [ ] **Step 3: Extend the interface signature**

In `server/src/session-store.ts:147`, change:

```ts
  searchEvents(query: string, opts?: { limit?: number; sessionId?: string }): SessionEventSearchHit[];
```

to:

```ts
  searchEvents(query: string, opts?: { limit?: number; sessionId?: string; spaceId?: string }): SessionEventSearchHit[];
```

- [ ] **Step 4: Extend the implementation**

In `server/src/session-store.ts:422-482`, change the method to accept `spaceId` and add a `WHERE s.space_id = ?` clause. Replace the existing method body (keep the FTS-query construction up to and including `const limit = opts.limit ?? 20;`), then replace the SQL/params section with:

```ts
    const cols = `e.id, e.session_id, e.role, e.ts,
                  s.title AS session_title,
                  snippet(session_events_fts, 0, '[', ']', '…', 12) AS snippet`;

    const where: string[] = ["session_events_fts MATCH ?"];
    const params: unknown[] = [ftsQuery];
    if (opts.sessionId) { where.push("e.session_id = ?"); params.push(opts.sessionId); }
    if (opts.spaceId)   { where.push("s.space_id = ?");   params.push(opts.spaceId); }

    const sql = `SELECT ${cols}
                 FROM session_events e
                 JOIN session_events_fts fts ON e.id = fts.rowid
                 JOIN sessions s             ON s.id = e.session_id
                 WHERE ${where.join(" AND ")}
                 ORDER BY fts.rank
                 LIMIT ?`;
    params.push(limit);
    return this.db.prepare(sql).all(...params) as SessionEventSearchHit[];
```

- [ ] **Step 5: Plumb `space_id` through the HTTP route**

In `server/src/routes/sessions.ts:269-300`, after the line that reads `const scopeSession = parsed.searchParams.get("session_id") ?? undefined;`, add:

```ts
      const scopeSpace = parsed.searchParams.get("space_id") ?? undefined;
```

Then change the `sessionStore.searchEvents` call to pass it:

```ts
        const hits = sessionStore.searchEvents(q, { sessionId: scopeSession, spaceId: scopeSpace, limit });
```

Update the route's leading comment from `// GET /api/sessions/search?q=…&session_id=…&limit=…` to `// GET /api/sessions/search?q=…&session_id=…&space_id=…&limit=…`.

- [ ] **Step 6: Run test to verify it passes**

Run: `cd server && npx vitest run test/sessions-search-space.test.ts`
Expected: PASS, three tests.

- [ ] **Step 7: Run the full server test suite**

Run: `cd server && npm test`
Expected: All tests pass — sanity check that the SQL refactor didn't break existing session-search tests.

- [ ] **Step 8: Commit**

```bash
git add server/src/session-store.ts server/src/routes/sessions.ts server/test/sessions-search-space.test.ts
git commit -m "feat(sessions): space_id scoping on /api/sessions/search"
```

---

## Task 4: Web data-layer additions

Adds `searchMemories` and extends `searchTranscripts` with `spaceId`. No tests — web has none.

**Files:**
- Modify: `web/src/data/memories-api.ts`
- Modify: `web/src/data/sessions-api.ts` (around the `searchTranscripts` function)

- [ ] **Step 1: Add `searchMemories` to memories-api.ts**

In `web/src/data/memories-api.ts`, after the existing `fetchMemories` function:

```ts
export async function searchMemories(
  query: string,
  opts: { spaceId?: string | null; limit?: number; signal?: AbortSignal } = {},
): Promise<Memory[]> {
  const params = new URLSearchParams({ q: query });
  if (opts.spaceId) params.set("space_id", opts.spaceId);
  if (opts.limit !== undefined) params.set("limit", String(opts.limit));
  return getJson<Memory[]>(`/api/memories/search?${params.toString()}`, opts.signal);
}
```

- [ ] **Step 2: Extend `searchTranscripts` with `spaceId`**

In `web/src/data/sessions-api.ts`, locate the `searchTranscripts` function. Change its `opts` parameter type and body to:

```ts
export async function searchTranscripts(
  query: string,
  opts: { limit?: number; spaceId?: string | null; signal?: AbortSignal } = {},
): Promise<TranscriptHit[]> {
  const params = new URLSearchParams({ q: query });
  if (opts.limit !== undefined) params.set("limit", String(opts.limit));
  if (opts.spaceId) params.set("space_id", opts.spaceId);
  return getJson<TranscriptHit[]>(`/api/sessions/search?${params.toString()}`, opts.signal);
}
```

- [ ] **Step 3: Type-check**

Run: `cd web && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add web/src/data/memories-api.ts web/src/data/sessions-api.ts
git commit -m "feat(web): searchMemories + space scoping on searchTranscripts"
```

---

## Task 5: SpotlightSearch — filter state + memory source

Refactor the component so filter state is separate from the input string, and memories become a third hit type. **No visible UI changes** in this task beyond the new "Memories" section — the chip/dropdown UI lands in Tasks 6–7. Doing this first lets us verify the data pipeline before adding interaction surface.

**Files:**
- Modify: `web/src/components/SpotlightSearch.tsx`

- [ ] **Step 1: Add memory source + filter state shape**

In `SpotlightSearch.tsx`, replace the imports block (lines 1-6) with:

```ts
import { useState, useEffect, useRef, useMemo } from "react";
import type { Artifact } from "../data/artifacts-api";
import { typeConfig } from "./ArtifactIcon";
import { spaceColor } from "../utils/spaceColor";
import { searchTranscripts } from "../data/sessions-api";
import type { TranscriptHit } from "../data/sessions-api";
import { searchMemories } from "../data/memories-api";
import type { Memory } from "../data/memories-api";
```

After `const TRANSCRIPTS_LIMIT = 8;`, add:

```ts
const MEMORIES_LIMIT = 8;

type FilterType = "session" | "artefact" | "memory" | null;
type SpotlightFilter = { type: FilterType; spaceId: string | null };
```

Extend the `SpotlightHit` union:

```ts
type SpotlightHit =
  | { kind: "artefact"; artifact: Artifact }
  | { kind: "transcript"; hit: TranscriptHit }
  | { kind: "memory"; memory: Memory };
```

- [ ] **Step 2: Add filter state**

Inside the `SpotlightSearch` function, alongside the existing `useState` calls, add:

```ts
  const [filter, setFilter] = useState<SpotlightFilter>({ type: null, spaceId: null });
```

(Leave `filter` and `setFilter` unused for now — they're wired in Tasks 6-7. TypeScript will warn; suppress with a leading underscore if needed, but a temporary `void filter;` keeps the diff small.)

Actually — to avoid lint noise, also use `filter` in the artefact filter immediately. Update the `artefactHits` `useMemo` to gate on filter.type:

```ts
  const artefactHits = useMemo(() => {
    if (!query.trim()) return [];
    if (filter.type !== null && filter.type !== "artefact") return [];
    const q = query.toLowerCase();
    return artifacts
      .filter((a) =>
        (filter.spaceId ? a.spaceId === filter.spaceId : true) &&
        (a.label.toLowerCase().includes(q)
          || a.artifactKind.toLowerCase().includes(q)
          || a.spaceId.toLowerCase().includes(q)),
      )
      .slice(0, ARTEFACTS_LIMIT);
  }, [query, artifacts, filter]);
```

- [ ] **Step 3: Gate transcript search on filter.type**

Wrap the existing transcript-search `useEffect` body so it bails when filtered to a non-session type. Inside the effect, after `const trimmed = query.trim();`, add:

```ts
    if (filter.type !== null && filter.type !== "session") {
      setTranscriptHits([]);
      setTranscriptsLoading(false);
      return;
    }
```

Pass `spaceId` to the search call:

```ts
      searchTranscripts(trimmed, { limit: TRANSCRIPTS_LIMIT, spaceId: filter.spaceId, signal: ac.signal })
```

Add `filter` to the `useEffect` dependency array.

- [ ] **Step 4: Add the memory search effect**

Below the transcript-search `useEffect`, add a parallel memory-search effect:

```ts
  const [memoryHits, setMemoryHits] = useState<Memory[]>([]);
  const [memoriesLoading, setMemoriesLoading] = useState(false);

  const memReqIdRef = useRef(0);
  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      setMemoryHits([]);
      setMemoriesLoading(false);
      return;
    }
    if (filter.type !== null && filter.type !== "memory") {
      setMemoryHits([]);
      setMemoriesLoading(false);
      return;
    }
    setMemoriesLoading(true);
    const reqId = ++memReqIdRef.current;
    const ac = new AbortController();
    const timer = setTimeout(() => {
      searchMemories(trimmed, { limit: MEMORIES_LIMIT, spaceId: filter.spaceId, signal: ac.signal })
        .then((hits) => {
          if (reqId !== memReqIdRef.current) return;
          setMemoryHits(hits);
          setMemoriesLoading(false);
        })
        .catch((err) => {
          if (ac.signal.aborted || reqId !== memReqIdRef.current) return;
          console.warn("[Spotlight] memory search failed:", err);
          setMemoryHits([]);
          setMemoriesLoading(false);
        });
    }, DEBOUNCE_MS);
    return () => { ac.abort(); clearTimeout(timer); };
  }, [query, filter]);
```

- [ ] **Step 5: Add memory hits to the flat list**

Update `flatHits`:

```ts
  const flatHits: SpotlightHit[] = useMemo(() => [
    ...artefactHits.map((a): SpotlightHit => ({ kind: "artefact", artifact: a })),
    ...transcriptHits.map((h): SpotlightHit => ({ kind: "transcript", hit: h })),
    ...memoryHits.map((m): SpotlightHit => ({ kind: "memory", memory: m })),
  ], [artefactHits, transcriptHits, memoryHits]);
```

Update `showResults` and `showEmpty` accordingly:

```ts
  const showResults = artefactHits.length > 0
    || transcriptHits.length > 0 || transcriptsLoading
    || memoryHits.length > 0 || memoriesLoading;
  const showEmpty = !!query.trim() && !transcriptsLoading && !memoriesLoading && flatHits.length === 0;
```

- [ ] **Step 6: Render memory rows**

After the transcripts block in the results JSX (right after the closing of `{transcriptHits.map(...)}`), add:

```tsx
            {(memoryHits.length > 0 || memoriesLoading) && (
              <div className="spotlight-section-label">Memories</div>
            )}
            {memoriesLoading && memoryHits.length === 0 && (
              <div className="spotlight-section-loading">Searching memories…</div>
            )}
            {memoryHits.map((m, k) => {
              const flatIndex = artefactHits.length + transcriptHits.length + k;
              const isSelected = flatIndex === selected;
              return (
                <div
                  key={`m-${m.id}`}
                  className={`spotlight-result spotlight-result--memory${isSelected ? " spotlight-result--selected" : ""}`}
                  onMouseEnter={() => setSelected(flatIndex)}
                  onClick={() => activate({ kind: "memory", memory: m })}
                >
                  <span className="spotlight-result-dot" style={{ background: "#a78bfa" }} />
                  <span className="spotlight-result-label">{m.content.length > 80 ? m.content.slice(0, 80) + "…" : m.content}</span>
                  <span className="spotlight-result-badge">memory</span>
                  {m.space_id && (
                    <span className="spotlight-result-space" style={{ color: spaceColor(m.space_id), background: `${spaceColor(m.space_id)}18` }}>{m.space_id}</span>
                  )}
                </div>
              );
            })}
```

- [ ] **Step 7: Handle memory activation**

Extend the `activate` function:

```ts
  function activate(hit: SpotlightHit) {
    if (hit.kind === "artefact") {
      onOpen(hit.artifact);
    } else if (hit.kind === "transcript") {
      window.dispatchEvent(new CustomEvent("oyster:open-session", {
        detail: { id: hit.hit.session_id, eventId: hit.hit.event_id, query: query.trim() },
      }));
    } else {
      // Memory — for v1, navigate to the originating space's Home (where
      // memories list); flash the memory if possible. Inspector landing
      // for memories doesn't exist yet, so we route to Home for the space.
      const targetSpace = hit.memory.space_id ?? "home";
      window.dispatchEvent(new CustomEvent("oyster:open-memory", {
        detail: { id: hit.memory.id, spaceId: targetSpace },
      }));
    }
    onClose();
  }
```

- [ ] **Step 8: Add a listener in `Home/index.tsx` to handle `oyster:open-memory`**

(This is the smallest landing surface; we route memory activations into the Home view's memory list. Full memory inspector is future work.)

In `web/src/components/Home/index.tsx`, find the `useEffect` that subscribes to `oyster:open-session` (search for the string). Add a sibling listener:

```ts
  useEffect(() => {
    function handler(e: Event) {
      const detail = (e as CustomEvent<{ id: string; spaceId: string }>).detail;
      if (!detail) return;
      console.log("[spotlight] open-memory", detail);
    }
    window.addEventListener("oyster:open-memory", handler);
    return () => window.removeEventListener("oyster:open-memory", handler);
  }, []);
```

This handler is intentionally minimal — it logs the event so the user can confirm activation worked. A dedicated memory inspector is out of scope for this plan; the user can raise a follow-up after the rest of the feature ships.

- [ ] **Step 9: Type-check + manual verify**

Run: `cd web && npx tsc --noEmit`
Expected: no errors.

Then run the dev server: `npm run dev` (from repo root).
- Open `http://localhost:7337`.
- Press cmd+K.
- Type a query that matches an existing memory (e.g. something you've `/remember`ed).
- Expected: a "Memories" section appears in results.

- [ ] **Step 10: Commit**

```bash
git add web/src/components/SpotlightSearch.tsx web/src/components/Home/index.tsx
git commit -m "feat(spotlight): add memory source + filter state scaffold"
```

---

## Task 6: Chip-inside-input rendering

Renders `@type` and `#space` filter chips as siblings of the `<input>` inside `.spotlight-input-row`. Backspace at empty input removes the most-recently-added chip; chip `×` removes that specific chip.

**Files:**
- Modify: `web/src/components/SpotlightSearch.tsx`
- Modify: `web/src/App.css` (in the `.spotlight-*` section, around line 1565)

- [ ] **Step 1: Add chip CSS**

In `web/src/App.css`, find the existing `.spotlight-input-row` rule (around line 1620 — search the file for it). After the existing spotlight styles, append:

```css
.spotlight-token-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 1px 4px 1px 6px;
  border-radius: 4px;
  font-size: 11px;
  border: 1px solid;
  margin-right: 6px;
  user-select: none;
}
.spotlight-token-chip--type   { color: #4d9aff; background: #3a86ff22; border-color: #3a86ff44; }
.spotlight-token-chip--space  { color: #a78bfa; background: #8b5cf622; border-color: #a78bfa44; }
.spotlight-token-chip .x {
  cursor: pointer;
  font-size: 12px;
  line-height: 1;
  color: #6e7280;
  padding: 0 0 0 2px;
}
.spotlight-token-chip .x:hover { color: #d4d6db; }
```

- [ ] **Step 2: Track chip insertion order**

In `SpotlightSearch.tsx`, extend the filter state to include an order array so backspace knows which chip is "most recent":

```ts
  const [filter, setFilter] = useState<SpotlightFilter & { order: ('type' | 'space')[] }>({
    type: null,
    spaceId: null,
    order: [],
  });
```

Update `artefactHits`, the transcript effect, and the memory effect to read `filter.type` / `filter.spaceId` as before (no signature change for them).

- [ ] **Step 3: Render the chips before the input**

In the JSX, change the existing input row from:

```tsx
        <div className="spotlight-input-row">
          <svg className="spotlight-search-icon" …>…</svg>
          <input … />
          {query && (<button …>✕</button>)}
        </div>
```

to:

```tsx
        <div className="spotlight-input-row">
          <svg className="spotlight-search-icon" …>…</svg>
          {filter.type && (
            <span className="spotlight-token-chip spotlight-token-chip--type">
              @{filter.type}
              <span className="x" onClick={() => setFilter(f => ({
                ...f,
                type: null,
                order: f.order.filter(o => o !== 'type'),
              }))}>×</span>
            </span>
          )}
          {filter.spaceId && (
            <span className="spotlight-token-chip spotlight-token-chip--space">
              #{filter.spaceId}
              <span className="x" onClick={() => setFilter(f => ({
                ...f,
                spaceId: null,
                order: f.order.filter(o => o !== 'space'),
              }))}>×</span>
            </span>
          )}
          <input
            ref={inputRef}
            className="spotlight-input"
            placeholder="Search artefacts, sessions, memories — type @ to filter"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
          />
          {query && (
            <button className="spotlight-clear" onClick={() => setQuery("")}>✕</button>
          )}
        </div>
```

- [ ] **Step 4: Implement Backspace-removes-chip**

In `handleKeyDown`, **at the top** (before the `Escape` handler), add:

```tsx
    if (e.key === "Backspace" && query === "" && filter.order.length > 0) {
      const last = filter.order[filter.order.length - 1];
      setFilter(f => ({
        ...f,
        type: last === 'type' ? null : f.type,
        spaceId: last === 'space' ? null : f.spaceId,
        order: f.order.slice(0, -1),
      }));
      e.preventDefault();
      return;
    }
```

- [ ] **Step 5: Manual verify**

Run dev server. Open cmd+K.
- Add a placeholder filter (we'll wire `@`/`#` typing in Task 7, but you can temporarily set state from the React devtools). Or insert a one-line dev-only helper:

```ts
  // DEV: temporary trigger — remove in Task 7. Type `=t` then enter to set type=memory.
  // (Skip if you're confident manipulating state from devtools.)
```

For now, verify by manually setting filter state in React DevTools:
1. Open cmd+K.
2. In React DevTools, find the `SpotlightSearch` component, edit `filter` to `{ type: "memory", spaceId: null, order: ["type"] }`.
3. Expected: an `@memory` chip appears before the input.
4. Click the chip's `×` — chip disappears.
5. Re-set the chip. Click into the input, ensure it's empty, press Backspace — chip disappears.

- [ ] **Step 6: Commit**

```bash
git add web/src/components/SpotlightSearch.tsx web/src/App.css
git commit -m "feat(spotlight): chip-in-input rendering for filter tokens"
```

---

## Task 7: Autocomplete dropdown on `@` / `#`

Typing `@` or `#` opens an inline popover. Fuzzy-matches; `Enter` / `Tab` / click commits, consuming the prefix from the input and setting the filter.

**Files:**
- Modify: `web/src/components/SpotlightSearch.tsx`
- Modify: `web/src/App.css`
- Modify: `web/src/components/SpotlightSearch.tsx` parent — the `Props` interface needs `spaces` for the `#` autocomplete

- [ ] **Step 1: Add `spaces` prop to SpotlightSearch**

In `SpotlightSearch.tsx`, extend the `Props` interface:

```ts
interface Props {
  artifacts: Artifact[];
  spaces: { id: string; name?: string }[];
  onOpen: (artifact: Artifact) => void;
  onClose: () => void;
}
```

Update the function signature: `export function SpotlightSearch({ artifacts, spaces, onOpen, onClose }: Props)`.

In `web/src/App.tsx`, find the `<SpotlightSearch …>` mount (search for `SpotlightSearch`). Pass the existing `spaces` state: `<SpotlightSearch artifacts={…} spaces={spaces} … />`.

- [ ] **Step 2: Detect the active autocomplete prefix**

Inside `SpotlightSearch`, after the existing `useState` calls, derive the active prefix from the query string:

```ts
  type ActiveAc = { prefix: '@' | '#'; fragment: string; start: number } | null;
  const activeAc: ActiveAc = useMemo(() => {
    const at = query.lastIndexOf('@');
    const hash = query.lastIndexOf('#');
    const candidate = at > hash ? '@' : (hash > -1 ? '#' : null);
    if (!candidate) return null;
    const idx = candidate === '@' ? at : hash;
    // Must be at start or preceded by whitespace
    if (idx > 0 && !/\s/.test(query[idx - 1])) return null;
    const fragment = query.slice(idx + 1);
    if (/\s/.test(fragment)) return null; // closed by whitespace
    return { prefix: candidate, fragment, start: idx };
  }, [query]);
```

- [ ] **Step 3: Compute autocomplete options**

```ts
  const TYPE_OPTS: { value: 'session' | 'artefact' | 'memory'; color: string }[] = [
    { value: 'session', color: '#4d9aff' },
    { value: 'artefact', color: '#ff8a5c' },
    { value: 'memory', color: '#a78bfa' },
  ];

  const acOptions = useMemo(() => {
    if (!activeAc) return [];
    const frag = activeAc.fragment.toLowerCase();
    if (activeAc.prefix === '@') {
      return TYPE_OPTS.filter(o => o.value.startsWith(frag));
    }
    return spaces
      .filter(s => s.id.toLowerCase().includes(frag))
      .slice(0, 8)
      .map(s => ({ value: s.id, color: spaceColor(s.id) }));
  }, [activeAc, spaces]);

  const [acSelected, setAcSelected] = useState(0);
  useEffect(() => { setAcSelected(0); }, [activeAc?.prefix, activeAc?.fragment]);
```

- [ ] **Step 4: Commit-on-Enter helper**

```ts
  function commitAcOption(value: string) {
    if (!activeAc) return;
    const isType = activeAc.prefix === '@';
    setFilter(f => ({
      type: isType ? value as FilterType : f.type,
      spaceId: isType ? f.spaceId : value,
      order: [...f.order.filter(o => o !== (isType ? 'type' : 'space')), isType ? 'type' : 'space'],
    }));
    // Consume the `@frag` / `#frag` from the input
    setQuery(q => q.slice(0, activeAc.start) + q.slice(activeAc.start + 1 + activeAc.fragment.length));
  }
```

- [ ] **Step 5: Wire keyboard handling**

Extend `handleKeyDown`, immediately after the Backspace-removes-chip block:

```tsx
    if (activeAc && acOptions.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setAcSelected(s => Math.min(s + 1, acOptions.length - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setAcSelected(s => Math.max(s - 1, 0));
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        commitAcOption(acOptions[acSelected].value);
        return;
      }
    }
```

Important: the existing ArrowDown / ArrowUp / Enter handlers for the results list still run after this block, so the `return;` statements above are essential — they prevent the results list from moving while the autocomplete is open.

- [ ] **Step 6: Render the popover**

After the `.spotlight-input-row` div and before `{showResults && (…)}`, add:

```tsx
        {activeAc && acOptions.length > 0 && (
          <div className="spotlight-ac">
            <div className="spotlight-ac-hint">
              {activeAc.prefix === '@' ? 'Filter by type' : 'Filter by space'}
            </div>
            {acOptions.map((o, i) => (
              <div
                key={o.value}
                className={`spotlight-ac-item${i === acSelected ? ' spotlight-ac-item--sel' : ''}`}
                onMouseEnter={() => setAcSelected(i)}
                onMouseDown={(e) => { e.preventDefault(); commitAcOption(o.value); }}
              >
                <span className="spotlight-ac-prefix">{activeAc.prefix}</span>
                <span className="spotlight-ac-swatch" style={{ background: o.color }} />
                <span className="spotlight-ac-label">{o.value}</span>
              </div>
            ))}
            <div className="spotlight-ac-hint spotlight-ac-hint--bottom">
              also try {activeAc.prefix === '@' ? '#space' : '@type'}
            </div>
          </div>
        )}
```

- [ ] **Step 7: Add popover CSS**

In `web/src/App.css`, append to the spotlight section:

```css
.spotlight-ac {
  position: absolute;
  top: 48px;
  left: 36px;
  z-index: 6000;
  min-width: 220px;
  padding: 4px;
  background: #181a1d;
  border: 1px solid #3a3d44;
  border-radius: 6px;
  box-shadow: 0 6px 18px rgba(0,0,0,0.5);
}
.spotlight-ac-hint {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: #6e7280;
  padding: 4px 8px 6px;
  border-bottom: 1px solid #2a2d33;
  margin-bottom: 4px;
}
.spotlight-ac-hint--bottom { border-bottom: 0; border-top: 1px solid #2a2d33; margin: 4px 0 0; }
.spotlight-ac-item {
  display: flex;
  gap: 8px;
  align-items: center;
  font-size: 12px;
  padding: 6px 8px;
  border-radius: 4px;
  cursor: pointer;
  color: #d4d6db;
}
.spotlight-ac-item--sel { background: #2a2d33; }
.spotlight-ac-prefix { color: #4d9aff; }
.spotlight-ac-swatch { width: 8px; height: 8px; border-radius: 2px; }
```

Anchor the popover relative to `.spotlight-panel`:
```css
.spotlight-panel { position: relative; }
```
(If it's already `position: relative`, skip.)

- [ ] **Step 8: Manual verify**

Run dev server. Press cmd+K.
- Type `@` → popover opens with three type rows.
- Type `m` → narrows to `memory`. Press Enter — `@memory` chip lands in input, `@m` cleared from query.
- Type `#` → popover opens with spaces. Type a partial space id, press Enter — chip lands.
- Type a real query like `auth` after the chips — results filter accordingly.
- Press Backspace on an empty query — most recent chip removed.

- [ ] **Step 9: Commit**

```bash
git add web/src/components/SpotlightSearch.tsx web/src/App.css web/src/App.tsx
git commit -m "feat(spotlight): @/# autocomplete dropdown for type/space filtering"
```

---

## Task 8: Counts in the dropdown

When the dropdown opens with a non-empty query, show per-type result counts inline.

**Files:**
- Modify: `web/src/components/SpotlightSearch.tsx`

- [ ] **Step 1: Compute counts**

When `filter.type === null`, all three searches run and we already have counts via `artefactHits.length`, `transcriptHits.length`, `memoryHits.length`. When the filter is set, only one source has data; the others show "—".

After the `acOptions` `useMemo`, add:

```ts
  const acCounts: Record<string, number | null> = useMemo(() => ({
    session:  filter.type === null || filter.type === "session"  ? transcriptHits.length : null,
    artefact: filter.type === null || filter.type === "artefact" ? artefactHits.length   : null,
    memory:   filter.type === null || filter.type === "memory"   ? memoryHits.length     : null,
  }), [filter.type, transcriptHits.length, artefactHits.length, memoryHits.length]);
```

- [ ] **Step 2: Render counts**

In the popover JSX, inside each `acOptions.map` row, append before the closing `</div>`:

```tsx
                {activeAc.prefix === '@' && (
                  <span className="spotlight-ac-count">
                    {acCounts[o.value] ?? '—'}
                  </span>
                )}
```

- [ ] **Step 3: Add the count CSS**

In `App.css`, append:

```css
.spotlight-ac-item { justify-content: space-between; }
.spotlight-ac-item > .spotlight-ac-prefix,
.spotlight-ac-item > .spotlight-ac-swatch,
.spotlight-ac-item > .spotlight-ac-label { /* keep them grouped on the left */ }
.spotlight-ac-count {
  margin-left: auto;
  font-size: 11px;
  color: #6e7280;
}
```

Wrap the prefix/swatch/label in a left-side flex container inside the JSX — easier than fighting flex:

```tsx
              <div className={`spotlight-ac-item…`} …>
                <span className="spotlight-ac-left">
                  <span className="spotlight-ac-prefix">{activeAc.prefix}</span>
                  <span className="spotlight-ac-swatch" style={{ background: o.color }} />
                  <span className="spotlight-ac-label">{o.value}</span>
                </span>
                {activeAc.prefix === '@' && (
                  <span className="spotlight-ac-count">{acCounts[o.value] ?? '—'}</span>
                )}
              </div>
```

And the CSS:
```css
.spotlight-ac-left { display: flex; gap: 8px; align-items: center; }
```

- [ ] **Step 4: Manual verify**

In dev:
- Open cmd+K, type `auth`, then type `@` → popover shows counts (e.g. `session 3`, `artefact 7`, `memory 2`).
- Pick a type. Open the popover again with `@` — the picked type still shows its count; the others show `—`.

- [ ] **Step 5: Commit**

```bash
git add web/src/components/SpotlightSearch.tsx web/src/App.css
git commit -m "feat(spotlight): live counts in @ autocomplete"
```

---

## Task 9: Empty-query recent feed

When `query === ""` and no filters are set, show a recency-ordered list of recent artefacts + sessions + memories (interleaved, capped at ~15).

**Files:**
- Modify: `web/src/components/SpotlightSearch.tsx`
- Modify: `web/src/data/sessions-api.ts` (if no recent-sessions helper exists yet)

- [ ] **Step 1: Check for a recent-sessions API**

Run: `grep -n "recent\|listSessions\|fetchSessions" /Users/Matthew.Slight/Dev/oyster-dev/web/src/data/sessions-api.ts`

If a "list recent sessions" helper already exists, use it. If not, add (small wrapper around an existing endpoint — check `server/src/routes/sessions.ts` for what's already exposed). **Do not invent a new server endpoint for this task**; if sessions can't be listed recently without one, drop the sessions part of the recent feed (artefacts + memories only) and note it in the commit.

- [ ] **Step 2: Implement the recency feed**

```ts
  const recentFeed: SpotlightHit[] = useMemo(() => {
    if (query.trim() || filter.type || filter.spaceId) return [];
    const artefactRows = artifacts
      .slice() // copy before sort
      .sort((a, b) => (b.lastModified ?? 0) - (a.lastModified ?? 0))
      .slice(0, 5)
      .map((a): SpotlightHit => ({ kind: "artefact", artifact: a }));
    // Memories: use the existing useMemories list if available in parent;
    // pass it down or call fetchMemories() once on open.
    return artefactRows;
  }, [query, filter, artifacts]);
```

(Sessions are intentionally omitted here; documenting as a v1 limitation. Re-introduce when there's a list endpoint to use.)

- [ ] **Step 3: Render the feed**

Add `recentFeed` to the JSX so it shows when `!showResults && !showEmpty && recentFeed.length > 0`. Use the same `spotlight-result` row template.

- [ ] **Step 4: Manual verify**

Open cmd+K with no query — recent artefacts appear under a "Recent" section. Type anything — they hide.

- [ ] **Step 5: Commit**

```bash
git add web/src/components/SpotlightSearch.tsx web/src/data/sessions-api.ts
git commit -m "feat(spotlight): recent feed on empty query"
```

---

## Task 10: End-to-end smoke test

A manual walk-through to confirm the feature works as the spec describes.

- [ ] **Step 1: Run dev server**

```bash
cd /Users/Matthew.Slight/Dev/oyster.worktrees/cmdk-type-filter
npm run dev
```

- [ ] **Step 2: Walk through the spec's driver phrasings**

In the browser at `http://localhost:7337`:

1. **"I just want to find a session."**
   - cmd+K → type `@s` → Enter → type `auth` → only sessions appear in results.

2. **"I just want to find a memory in tokinvest."**
   - cmd+K → type `@m` → Enter → type `#tok` → Enter → type `auth` → only memories from tokinvest.

3. **Backspace removes chips:** with chips in place, clear the query, press Backspace — most recent chip removed.

4. **`×` removes specific chip:** click the `×` on `@memory` — type filter cleared, space filter kept.

5. **Dropdown counts:** type `auth` first (no filter), then `@` — counts show on all three rows. Pick session, reopen `@` — others show `—`.

6. **Empty-query recent feed:** open cmd+K fresh — recent artefacts visible.

- [ ] **Step 3: Confirm no console errors**

DevTools console should be clean across all interactions. Any warnings about missing keys / state-set-during-render are bugs to fix before declaring done.

- [ ] **Step 4: Push branch**

```bash
git push -u origin cmdk-type-filter
```

(Do not open a PR — that's the user's call.)

- [ ] **Step 5: Notify**

Report to the user: feature implemented, all server tests green, manual UI walkthrough complete, branch pushed.

---

## Self-Review

**Coverage of spec sections:**

- ✅ Filter model — Tasks 5, 7 (state shape, mutual-exclusion semantics on radio replace via `commitAcOption`)
- ✅ Input mechanics — Tasks 6, 7 (chips, backspace, ×, autocomplete)
- ✅ Dropdown UI — Task 7, with counts in Task 8
- ✅ Browse-without-typing — Task 9 (with sessions-in-recent-feed caveat documented)
- ✅ Results pipeline — Task 5
- ✅ Backend (memory search) — Tasks 1, 2
- ✅ Backend (session space) — Task 3
- ✅ Files-touched list — matches the spec's

**Open items the executor should know:**

- Memory activation routes to a console.log + custom event in Task 5 — no dedicated memory inspector exists. If the user wants one, that's a follow-up not a blocker.
- Recent-feed sessions: omitted v1, see Task 9.
- The chip styles use hardcoded hex colors (`#4d9aff`, `#a78bfa`) instead of CSS vars. Matches existing spotlight code that does the same; if oyster has a token system worth using, the executor should swap to it without expanding scope.
