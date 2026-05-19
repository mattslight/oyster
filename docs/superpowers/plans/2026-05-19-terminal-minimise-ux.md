# Terminal minimise UX implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Click × on the embedded Claude Code terminal panel minimises (keeps the PTY alive) and surfaces it via a new topbar **Running N** pill + popover plus *Open* / *Minimised* states in the Sessions list.

**Architecture:** PTY lifecycle stays in `ClaudePtyManager` (in-memory). Two denormalised columns on the `sessions` table (`terminal_id`, `terminal_attached_clients`) project that state for fast Sessions-list reads. SSE pushes `terminal:attached` / `terminal:detached` / `terminal:exited` events. A new `useTerminalPresence` hook fuses the windows store + sessions feed into one source of truth, consumed by the new `RunningTerminalsPill` + the existing Sessions list rows.

**Tech Stack:** TypeScript everywhere. Server: Node + better-sqlite3 + node-pty + ws + vitest. Web: React 19 + vite + xterm.js. No test framework in `web/` — client-side tasks use `tsc --noEmit` + browser smoke.

**Spec:** [`docs/superpowers/specs/2026-05-19-terminal-minimise-ux-design.md`](../specs/2026-05-19-terminal-minimise-ux-design.md)

---

## File structure

### Server — created

- `server/test/sessions-table-terminal-columns.test.ts` — migration + boot reset
- `server/test/session-store-terminal-link.test.ts` — link / clear / attached-clients store methods
- `server/test/claude-pty-manager-link.test.ts` — manager writes / clears the columns through link / exit / attach / detach
- `server/test/pty-retention-cap.test.ts` — POST_EXIT_RETENTION_MS bump + 50-retained cap

### Server — modified

- `server/src/db.ts` — two additive ALTERs + boot-reset query
- `server/src/session-store.ts` — `SessionRow` adds two fields; add `linkTerminal` / `clearTerminal` / `setAttachedClients` methods
- `server/src/claude-pty-manager.ts` — accept `sessionStore` + `broadcastUiEvent` deps; call store methods on link / attach / detach / exit; emit SSE; bump retention; add eviction cap
- `server/src/index.ts` — wire the new deps when constructing `ClaudePtyManager`
- `server/src/routes/sessions.ts` — include `terminalId` / `terminalAttachedClients` in `GET /api/sessions` payload
- `shared/types.ts` — `Session` interface gains the two fields; new `UiCommand` shapes for terminal events documented inline

### Web — created

- `web/src/hooks/useTerminalPresence.ts` — fuses `windows` store + sessions feed
- `web/src/components/Topbar/RunningTerminalsPill.tsx` — pill + popover
- `web/src/components/Topbar/RunningTerminalsPill.css` *(or extend `App.css`)* — pill + popover styles

### Web — modified

- `web/src/data/sessions-api.ts` — re-exported `Session` type picks up new fields automatically once shared types update
- `web/src/stores/windows.ts` — new `MINIMISE` action; reducer case
- `web/src/components/TerminalWindow.tsx` — × dispatches `MINIMISE`; tooltip *"Minimise terminal"*
- `web/src/components/Topbar.tsx` *(or wherever the topbar is composed)* — mount `RunningTerminalsPill`
- `web/src/components/Home/index.tsx` — new **Live** filter pill; row-level Open/Minimised state; live-rows pin-to-top sort
- `web/src/App.css` — `.row-dot--attached`, `.row-dot--running`, `.sr--attached`, `.sr--running`, `.sl-chip--restore`

---

## Task 1: Schema migration + boot reset

**Files:**
- Create: `server/test/sessions-table-terminal-columns.test.ts`
- Modify: `server/src/db.ts`

- [ ] **Step 1: Write the failing test**

```ts
// server/test/sessions-table-terminal-columns.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb } from "../src/db.js";

function makeEnv() {
  const dir = mkdtempSync(join(tmpdir(), "oyster-term-cols-"));
  return {
    dir,
    dispose: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe("sessions table — terminal columns", () => {
  let env: ReturnType<typeof makeEnv>;
  beforeEach(() => { env = makeEnv(); });
  afterEach(() => { env.dispose(); });

  it("adds terminal_id and terminal_attached_clients columns idempotently", () => {
    const db1 = initDb(env.dir);
    const cols = db1.prepare("PRAGMA table_info(sessions)").all() as { name: string }[];
    const names = cols.map(c => c.name);
    expect(names).toContain("terminal_id");
    expect(names).toContain("terminal_attached_clients");
    db1.close();

    // Re-init — must not throw on duplicate-column ALTER.
    const db2 = initDb(env.dir);
    db2.close();
  });

  it("boot reset clears stale terminal_id and zeros attached clients", () => {
    const db1 = initDb(env.dir);
    db1.prepare(
      `INSERT INTO spaces (id, display_name, color, scan_status) VALUES ('s','s','#000','none')`,
    ).run();
    db1.prepare(
      `INSERT INTO sessions
         (id, space_id, cwd, agent, title, state, started_at, last_event_at,
          terminal_id, terminal_attached_clients)
       VALUES
         ('a', 's', NULL, 'claude-code', 't', 'done',
          '2026-05-19T10:00:00Z', '2026-05-19T10:30:00Z',
          'stale-term-id', 3)`,
    ).run();
    db1.close();

    // Re-init — boot reset should fire.
    const db2 = initDb(env.dir);
    const row = db2.prepare(
      "SELECT terminal_id, terminal_attached_clients FROM sessions WHERE id = 'a'",
    ).get() as { terminal_id: string | null; terminal_attached_clients: number };
    expect(row.terminal_id).toBeNull();
    expect(row.terminal_attached_clients).toBe(0);
    db2.close();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/Matthew.Slight/Dev/oyster.worktrees/terminal-minimise-ux/server && npx vitest run test/sessions-table-terminal-columns.test.ts`
Expected: FAIL — columns don't exist yet.

- [ ] **Step 3: Add the migrations and boot reset**

Edit `server/src/db.ts`. Find the `initDb` function and locate the existing migration list (around line 47). Append the two ALTERs to the existing pattern:

```ts
// Existing migrations block (around line 47-56):
const additiveMigrations = [
  // … existing ALTERs …
  "ALTER TABLE sessions ADD COLUMN terminal_id TEXT",
  "ALTER TABLE sessions ADD COLUMN terminal_attached_clients INTEGER NOT NULL DEFAULT 0",
];
```

(If the existing list isn't named `additiveMigrations`, mirror the local convention — the file has a clear pattern of try/catch around each ALTER for idempotency.)

Then add the boot reset *after* all migrations run but *before* `initDb` returns:

```ts
// Stale-indicator reset. PTYs live in-memory only — they don't survive a
// server restart, so any non-null terminal_id or non-zero attached count
// from the previous boot is meaningless.
db.prepare(
  `UPDATE sessions
     SET terminal_id = NULL, terminal_attached_clients = 0
   WHERE terminal_id IS NOT NULL OR terminal_attached_clients > 0`,
).run();
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /Users/Matthew.Slight/Dev/oyster.worktrees/terminal-minimise-ux/server && npx vitest run test/sessions-table-terminal-columns.test.ts`
Expected: PASS — 2 tests.

- [ ] **Step 5: Commit**

```bash
cd /Users/Matthew.Slight/Dev/oyster.worktrees/terminal-minimise-ux
git add server/src/db.ts server/test/sessions-table-terminal-columns.test.ts
git commit -m "feat(sessions): add terminal_id + attached_clients columns with boot reset"
```

---

## Task 2: SessionStore terminal-link methods

**Files:**
- Create: `server/test/session-store-terminal-link.test.ts`
- Modify: `server/src/session-store.ts`

- [ ] **Step 1: Write the failing test**

```ts
// server/test/session-store-terminal-link.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb } from "../src/db.js";
import { SqliteSessionStore } from "../src/session-store.js";

function seed(store: SqliteSessionStore, id: string) {
  // Use the existing seedSpace pattern from other tests if needed.
  store.insertSession({
    id, space_id: null, agent: "claude-code", state: "done",
  });
}

function makeEnv() {
  const dir = mkdtempSync(join(tmpdir(), "oyster-term-link-"));
  const db = initDb(dir);
  const store = new SqliteSessionStore(db);
  return {
    db, store,
    dispose: () => { db.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

describe("SqliteSessionStore terminal link", () => {
  let env: ReturnType<typeof makeEnv>;
  beforeEach(() => { env = makeEnv(); });
  afterEach(() => { env.dispose(); });

  it("linkTerminal writes terminal_id, clearTerminal nulls it and resets clients", () => {
    seed(env.store, "s1");
    env.store.linkTerminal("s1", "term-1");
    env.store.setAttachedClients("s1", 2);
    const row = env.store.getById("s1")!;
    expect(row.terminal_id).toBe("term-1");
    expect(row.terminal_attached_clients).toBe(2);

    env.store.clearTerminal("s1");
    const cleared = env.store.getById("s1")!;
    expect(cleared.terminal_id).toBeNull();
    expect(cleared.terminal_attached_clients).toBe(0);
  });

  it("setAttachedClients on an unknown session is a no-op (does not throw)", () => {
    expect(() => env.store.setAttachedClients("missing", 1)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/session-store-terminal-link.test.ts` (from `server/`)
Expected: FAIL — methods don't exist.

- [ ] **Step 3: Extend SessionRow and add the methods**

Edit `server/src/session-store.ts`:

1. Add the two fields to `SessionRow` (next to the other columns, around line 43):

```ts
export interface SessionRow {
  // … existing fields …
  assignment_mode: AssignmentMode;
  /** ClaudePtyManager terminal id this session is linked to, or null. */
  terminal_id: string | null;
  /** Count of currently-attached WS clients on the linked terminal. 0 + non-null terminal_id = Minimised. */
  terminal_attached_clients: number;
}
```

2. Add the methods to the `SessionStore` interface (after `searchEvents`):

```ts
  /** Mark a session as linked to a running PTY. Idempotent. */
  linkTerminal(sessionId: string, terminalId: string): void;
  /** Clear the link and zero the attached-clients counter. Idempotent. */
  clearTerminal(sessionId: string): void;
  /** Update the attached-clients counter on the linked session. No-op if the session row is missing. */
  setAttachedClients(sessionId: string, count: number): void;
```

3. Implement on `SqliteSessionStore` (after `searchEvents`):

```ts
  linkTerminal(sessionId: string, terminalId: string): void {
    this.db.prepare(
      "UPDATE sessions SET terminal_id = ? WHERE id = ?",
    ).run(terminalId, sessionId);
  }

  clearTerminal(sessionId: string): void {
    this.db.prepare(
      "UPDATE sessions SET terminal_id = NULL, terminal_attached_clients = 0 WHERE id = ?",
    ).run(sessionId);
  }

  setAttachedClients(sessionId: string, count: number): void {
    this.db.prepare(
      "UPDATE sessions SET terminal_attached_clients = ? WHERE id = ?",
    ).run(Math.max(0, count | 0), sessionId);
  }
```

4. Update `getAll`, `getById` and any other SELECT in the file that materialises a `SessionRow` to include the two new columns — better-sqlite3 returns `null` for absent columns but the type guard will fail. Easiest path: change `SELECT *` queries (they pick up new columns automatically) — confirm via `git grep "SELECT.*FROM sessions" server/src` and adjust any column-listed SELECTs to add `terminal_id, terminal_attached_clients`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/session-store-terminal-link.test.ts`
Expected: PASS — 2 tests.

- [ ] **Step 5: Run the full server suite to catch regressions**

Run: `npx vitest run` (from `server/`)
Expected: all existing tests still pass.

- [ ] **Step 6: Commit**

```bash
git add server/src/session-store.ts server/test/session-store-terminal-link.test.ts
git commit -m "feat(sessions): add linkTerminal/clearTerminal/setAttachedClients store methods"
```

---

## Task 3: ClaudePtyManager writes terminal_id on link / exit

**Files:**
- Create: `server/test/claude-pty-manager-link.test.ts`
- Modify: `server/src/claude-pty-manager.ts`, `server/src/index.ts`

- [ ] **Step 1: Write the failing test**

```ts
// server/test/claude-pty-manager-link.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb } from "../src/db.js";
import { SqliteSessionStore } from "../src/session-store.js";
import { ClaudePtyManager } from "../src/claude-pty-manager.js";

function makeEnv() {
  const dir = mkdtempSync(join(tmpdir(), "oyster-pty-link-"));
  const db = initDb(dir);
  const store = new SqliteSessionStore(db);
  const events: { command: string; payload: unknown }[] = [];
  const broadcast = (cmd: { command: string; payload: unknown }) => { events.push(cmd); };
  const mgr = new ClaudePtyManager({ sessionStore: store, broadcastUiEvent: broadcast });
  store.insertSession({ id: "s1", space_id: null, agent: "claude-code", state: "done" });
  return {
    db, store, mgr, events,
    dispose: () => { mgr.disposeAll(); db.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

describe("ClaudePtyManager DB link", () => {
  let env: ReturnType<typeof makeEnv>;
  beforeEach(() => { env = makeEnv(); });
  afterEach(() => { env.dispose(); });

  it("setLinkedSession writes terminal_id to the linked session row", () => {
    // Fake spawn — bypass node-pty by injecting an entry directly via test seam.
    // Add a test-only `_seedEntry` method on the manager (or accept a stub
    // proc) — see step 3 below for the helper.
    env.mgr._seedEntryForTest({ terminalId: "t1", linkedSessionId: null });

    env.mgr.setLinkedSession("t1", "s1");
    const row = env.store.getById("s1")!;
    expect(row.terminal_id).toBe("t1");
  });

  it("calling kill() clears terminal_id on the linked session row", () => {
    env.mgr._seedEntryForTest({ terminalId: "t2", linkedSessionId: null });
    env.mgr.setLinkedSession("t2", "s1");
    env.mgr.kill("t2");
    // proc.onExit is what actually clears the row; the test seed wires a
    // synchronous fake proc that fires onExit during kill().
    const row = env.store.getById("s1")!;
    expect(row.terminal_id).toBeNull();
    expect(row.terminal_attached_clients).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/claude-pty-manager-link.test.ts`
Expected: FAIL — `_seedEntryForTest` doesn't exist; constructor doesn't accept deps.

- [ ] **Step 3: Refactor ClaudePtyManager to accept dependencies**

Edit `server/src/claude-pty-manager.ts`:

1. Add dependency types at top (after existing imports):

```ts
import type { SessionStore } from "./session-store.js";
import type { UiCommand } from "../../shared/types.js";

export interface ClaudePtyManagerDeps {
  sessionStore: SessionStore;
  broadcastUiEvent: (cmd: UiCommand) => void;
}
```

2. Change the constructor signature:

```ts
export class ClaudePtyManager {
  private terminals = new Map<string, ClaudePtyEntry>();
  private wss = new WebSocketServer({ noServer: true });
  private sessionStore: SessionStore;
  private broadcastUiEvent: (cmd: UiCommand) => void;

  constructor(deps: ClaudePtyManagerDeps) {
    this.sessionStore = deps.sessionStore;
    this.broadcastUiEvent = deps.broadcastUiEvent;
  }
  // …
}
```

3. In `setLinkedSession`, call the store:

```ts
  setLinkedSession(terminalId: string, sessionId: string): boolean {
    const entry = this.terminals.get(terminalId);
    if (!entry) return false;
    entry.linkedSessionId = sessionId;
    this.sessionStore.linkTerminal(sessionId, terminalId);
    return true;
  }
```

4. In `proc.onExit` (around line 175), after the existing `closeNote` / eviction-timer block, add:

```ts
      if (entry.linkedSessionId) {
        this.sessionStore.clearTerminal(entry.linkedSessionId);
      }
```

5. Add a test-only seam at the bottom of the class (guarded so we don't ship a foot-gun):

```ts
  /** Test-only: inject a fake entry with a stub proc whose onExit fires
   *  immediately on kill(). Production code never calls this. */
  _seedEntryForTest(input: { terminalId: string; linkedSessionId: string | null }): void {
    let exitCb: (e: { exitCode: number }) => void = () => {};
    const fakeProc: any = {
      pid: -1,
      onData: () => {},
      onExit: (cb: typeof exitCb) => { exitCb = cb; },
      write: () => {},
      resize: () => {},
      kill: () => { /* fire onExit synchronously like a real signal would */ exitCb({ exitCode: 0 }); },
    };
    const entry: ClaudePtyEntry = {
      terminalId: input.terminalId,
      kind: "claude_new",
      proc: fakeProc,
      scrollback: "",
      clients: new Set(),
      cwd: "/tmp",
      command: "/bin/echo",
      args: [],
      startedAt: Date.now(),
      exitedAt: null,
      linkedSessionId: input.linkedSessionId,
      evictTimer: null,
    };
    // Wire the onExit listener the same way spawn() does.
    fakeProc.onExit((event: { exitCode: number }) => {
      entry.exitedAt = Date.now();
      if (entry.linkedSessionId) {
        this.sessionStore.clearTerminal(entry.linkedSessionId);
      }
      // Emit terminal:exited; production code does the same in Task 5.
    });
    this.terminals.set(input.terminalId, entry);
  }
```

- [ ] **Step 4: Wire the new deps in `server/src/index.ts`**

Find where `ClaudePtyManager` is constructed (grep for `new ClaudePtyManager`) and pass the deps:

```ts
const claudePtyManager = new ClaudePtyManager({
  sessionStore,
  broadcastUiEvent,
});
```

`broadcastUiEvent` is already in scope at that point in `index.ts` (line 307 shows existing use).

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run test/claude-pty-manager-link.test.ts`
Expected: PASS — 2 tests.

- [ ] **Step 6: Run the full server suite**

Run: `npx vitest run`
Expected: all pass; the constructor-signature change may break call sites — fix any that surface.

- [ ] **Step 7: Commit**

```bash
git add server/src/claude-pty-manager.ts server/src/index.ts server/test/claude-pty-manager-link.test.ts
git commit -m "feat(pty): persist terminal link on session row via store"
```

---

## Task 4: ClaudePtyManager tracks attached clients

**Files:**
- Modify: `server/src/claude-pty-manager.ts`, `server/test/claude-pty-manager-link.test.ts`

- [ ] **Step 1: Extend the test with attached-clients cases**

Append to `server/test/claude-pty-manager-link.test.ts`:

```ts
import { WebSocket } from "ws";

describe("ClaudePtyManager attached clients", () => {
  let env: ReturnType<typeof makeEnv>;
  beforeEach(() => { env = makeEnv(); });
  afterEach(() => { env.dispose(); });

  it("attach/detach updates terminal_attached_clients on the linked row", () => {
    env.mgr._seedEntryForTest({ terminalId: "t1", linkedSessionId: "s1" });
    env.mgr.linkTerminalForTest("t1", "s1");

    const fakeWs1 = makeFakeWs();
    const fakeWs2 = makeFakeWs();

    env.mgr.attachClient("t1", fakeWs1 as unknown as WebSocket);
    expect(env.store.getById("s1")!.terminal_attached_clients).toBe(1);

    env.mgr.attachClient("t1", fakeWs2 as unknown as WebSocket);
    expect(env.store.getById("s1")!.terminal_attached_clients).toBe(2);

    fakeWs1.fireClose();
    expect(env.store.getById("s1")!.terminal_attached_clients).toBe(1);

    fakeWs2.fireClose();
    expect(env.store.getById("s1")!.terminal_attached_clients).toBe(0);
  });
});

function makeFakeWs() {
  const handlers: Record<string, ((arg?: unknown) => void)[]> = { message: [], close: [] };
  return {
    readyState: 1, // OPEN
    send: () => {},
    on(event: string, cb: (arg?: unknown) => void) { handlers[event] ??= []; handlers[event].push(cb); },
    fireClose() { handlers.close?.forEach(cb => cb()); },
  };
}
```

Also add a tiny test-only helper on the manager since the WS-attach path needs the entry to already know its linked session:

```ts
  /** Test-only: pair `_seedEntryForTest` with a link write in one step. */
  linkTerminalForTest(terminalId: string, sessionId: string): void { this.setLinkedSession(terminalId, sessionId); }
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/claude-pty-manager-link.test.ts -t "attached clients"`
Expected: FAIL — counter not updated by attach/detach.

- [ ] **Step 3: Update `attachClient` and the WS close handler**

In `server/src/claude-pty-manager.ts`, inside `attachClient`, after `entry.clients.add(ws)`:

```ts
    entry.clients.add(ws);
    if (entry.linkedSessionId) {
      this.sessionStore.setAttachedClients(entry.linkedSessionId, entry.clients.size);
    }
```

And inside the existing `ws.on("close", …)` handler:

```ts
    ws.on("close", () => {
      entry.clients.delete(ws);
      if (entry.linkedSessionId) {
        this.sessionStore.setAttachedClients(entry.linkedSessionId, entry.clients.size);
      }
    });
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/claude-pty-manager-link.test.ts -t "attached clients"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/claude-pty-manager.ts server/test/claude-pty-manager-link.test.ts
git commit -m "feat(pty): track attached WS clients on linked session row"
```

---

## Task 5: SSE events on attach / detach / exit

**Files:**
- Modify: `server/src/claude-pty-manager.ts`, `server/test/claude-pty-manager-link.test.ts`, `shared/types.ts`

- [ ] **Step 1: Document the three new SSE commands in `shared/types.ts`**

Find the `UiCommand` interface (around line 208). Add a JSDoc note above it listing the new commands, and define the three payload shapes:

```ts
/** Payload for the `terminal:attached` / `terminal:detached` / `terminal:exited`
 *  UiCommand variants. SessionId is null when the PTY was not yet linked. */
export interface TerminalPresenceEventPayload {
  terminalId: string;
  sessionId: string | null;
  attachedClients: number;
}
```

- [ ] **Step 2: Extend the test with an SSE assertion**

In `server/test/claude-pty-manager-link.test.ts`, add:

```ts
  it("emits terminal:attached / terminal:detached / terminal:exited", () => {
    env.mgr._seedEntryForTest({ terminalId: "t1", linkedSessionId: null });
    env.mgr.linkTerminalForTest("t1", "s1");
    env.events.length = 0;

    const ws = makeFakeWs();
    env.mgr.attachClient("t1", ws as unknown as WebSocket);
    ws.fireClose();
    env.mgr.kill("t1");

    const commands = env.events.map(e => e.command);
    expect(commands).toContain("terminal:attached");
    expect(commands).toContain("terminal:detached");
    expect(commands).toContain("terminal:exited");

    const attachedEvent = env.events.find(e => e.command === "terminal:attached")!;
    const payload = attachedEvent.payload as { terminalId: string; sessionId: string | null; attachedClients: number };
    expect(payload.terminalId).toBe("t1");
    expect(payload.sessionId).toBe("s1");
    expect(payload.attachedClients).toBe(1);
  });
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run test/claude-pty-manager-link.test.ts -t "emits terminal"`
Expected: FAIL.

- [ ] **Step 4: Emit the events from the manager**

In `attachClient`, after the `setAttachedClients` call:

```ts
    this.broadcastUiEvent({
      version: 1,
      command: "terminal:attached",
      payload: { terminalId, sessionId: entry.linkedSessionId, attachedClients: entry.clients.size },
    });
```

In the WS `close` handler, after `setAttachedClients`:

```ts
      this.broadcastUiEvent({
        version: 1,
        command: "terminal:detached",
        payload: { terminalId, sessionId: entry.linkedSessionId, attachedClients: entry.clients.size },
      });
```

In `proc.onExit` (and inside `_seedEntryForTest`'s onExit), after the `clearTerminal` call:

```ts
      this.broadcastUiEvent({
        version: 1,
        command: "terminal:exited",
        payload: { terminalId, sessionId: entry.linkedSessionId, attachedClients: 0 },
      });
```

**Then piggy-back a `session_changed` emission after each of the three terminal events.** The web's `useSessions` hook (`web/src/hooks/useSessions.ts:21`) already refetches on `session_changed`, so this avoids any changes to `web/src/data/ui-events.ts` — the topbar pill + Sessions list pick up the new state via the normal refresh. Add this once at the end of each terminal-event emission (attach, detach, exit):

```ts
      if (entry.linkedSessionId) {
        this.broadcastUiEvent({
          version: 1,
          command: "session_changed",
          payload: { id: entry.linkedSessionId },
        });
      }
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run test/claude-pty-manager-link.test.ts -t "emits terminal"`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src/claude-pty-manager.ts server/test/claude-pty-manager-link.test.ts shared/types.ts
git commit -m "feat(pty): emit terminal:attached/detached/exited SSE events"
```

---

## Task 6: Extend `GET /api/sessions` payload + shared types

**Files:**
- Modify: `server/src/routes/sessions.ts`, `shared/types.ts`

- [ ] **Step 1: Extend the existing route test (or add one) for the new fields**

Find a sessions-route test (likely `server/test/sessions-resume-route.test.ts` or similar). If there isn't a direct "GET /api/sessions" test, add one as `server/test/sessions-route-terminal-fields.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb } from "../src/db.js";
import { SqliteSessionStore } from "../src/session-store.js";

function makeEnv() {
  const dir = mkdtempSync(join(tmpdir(), "oyster-sess-route-term-"));
  const db = initDb(dir);
  const store = new SqliteSessionStore(db);
  return { db, store, dispose: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

describe("GET /api/sessions payload — terminal fields", () => {
  let env: ReturnType<typeof makeEnv>;
  beforeEach(() => { env = makeEnv(); });
  afterEach(() => { env.dispose(); });

  it("payload mapping projects terminal_id and terminal_attached_clients", () => {
    // Direct unit test the mapping function rather than spinning up a server.
    // Find the local helper in routes/sessions.ts (the `MergedSessionPayload`
    // mapper) and export it (or extract it) so this test can import it.
    // Then:
    env.store.insertSession({ id: "s1", space_id: null, agent: "claude-code", state: "done" });
    env.store.linkTerminal("s1", "term-1");
    env.store.setAttachedClients("s1", 2);

    const row = env.store.getById("s1")!;
    // mapSessionRow is the extracted mapper.
    const payload = mapSessionRow(row, /* myDeviceId */ null, /* myDeviceLabel */ null);
    expect(payload.terminalId).toBe("term-1");
    expect(payload.terminalAttachedClients).toBe(2);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Expected: FAIL — `mapSessionRow` is not exported / fields not on payload.

- [ ] **Step 3: Extend the payload + map**

In `server/src/routes/sessions.ts`, locate `interface MergedSessionPayload` (around line 133). Add:

```ts
interface MergedSessionPayload {
  // … existing fields …
  assignmentMode?: "auto" | "manual";
  /** Linked PTY terminal id, or null when no live terminal. */
  terminalId: string | null;
  /** Count of currently-attached WS clients on the linked terminal. */
  terminalAttachedClients: number;
}
```

In the row-to-payload mapping (around line 164), add the two fields:

```ts
const localPayload: MergedSessionPayload[] = rows.map((row) => {
  return {
    // … existing fields …
    activeDeviceLabel: resolveActiveLabel(/* … */),
    terminalId: row.terminal_id,
    terminalAttachedClients: row.terminal_attached_clients,
  };
});
```

Extract the per-row mapping into a top-level `mapSessionRow(row, myDeviceId, myDeviceLabel)` helper and export it so the unit test in step 1 can import it. This keeps the route handler thin and the mapper independently testable.

In `shared/types.ts`, extend the `Session` interface (find it via `git grep "interface Session\b"`):

```ts
export interface Session {
  // … existing fields …
  /** Linked PTY terminal id, or null when no live terminal. */
  terminalId: string | null;
  /** Count of currently-attached WS clients on the linked terminal. */
  terminalAttachedClients: number;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/sessions-route-terminal-fields.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full server suite + typecheck**

```bash
npx vitest run
npx tsc --noEmit
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/sessions.ts shared/types.ts server/test/sessions-route-terminal-fields.test.ts
git commit -m "feat(sessions): expose terminalId + terminalAttachedClients on GET /api/sessions"
```

---

## Task 7: Retention bump + 50-retained eviction cap

**Files:**
- Create: `server/test/pty-retention-cap.test.ts`
- Modify: `server/src/claude-pty-manager.ts`

- [ ] **Step 1: Write the failing test**

```ts
// server/test/pty-retention-cap.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb } from "../src/db.js";
import { SqliteSessionStore } from "../src/session-store.js";
import { ClaudePtyManager, POST_EXIT_RETENTION_MS, MAX_RETAINED_EXITED } from "../src/claude-pty-manager.js";

function makeEnv() {
  const dir = mkdtempSync(join(tmpdir(), "oyster-pty-cap-"));
  const db = initDb(dir);
  const store = new SqliteSessionStore(db);
  const mgr = new ClaudePtyManager({ sessionStore: store, broadcastUiEvent: () => {} });
  return { db, store, mgr, dispose: () => { mgr.disposeAll(); db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

describe("ClaudePtyManager retention", () => {
  let env: ReturnType<typeof makeEnv>;
  beforeEach(() => { env = makeEnv(); });
  afterEach(() => { env.dispose(); });

  it("POST_EXIT_RETENTION_MS is 15 minutes", () => {
    expect(POST_EXIT_RETENTION_MS).toBe(15 * 60 * 1000);
  });

  it("MAX_RETAINED_EXITED is 50", () => {
    expect(MAX_RETAINED_EXITED).toBe(50);
  });

  it("evicts the oldest exited entry when the cap is exceeded", () => {
    // Seed MAX_RETAINED_EXITED + 1 exited entries, oldest first.
    for (let i = 0; i < MAX_RETAINED_EXITED + 1; i++) {
      env.mgr._seedEntryForTest({ terminalId: `t${i}`, linkedSessionId: null });
      env.mgr.kill(`t${i}`); // marks exited via the fake proc's onExit
    }
    expect(env.mgr.list().length).toBe(MAX_RETAINED_EXITED);
    expect(env.mgr.getEntry("t0")).toBeUndefined(); // oldest evicted
    expect(env.mgr.getEntry(`t${MAX_RETAINED_EXITED}`)).toBeDefined(); // newest kept
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/pty-retention-cap.test.ts`
Expected: FAIL — `MAX_RETAINED_EXITED` not exported; retention is 30_000.

- [ ] **Step 3: Bump retention + add the cap**

In `server/src/claude-pty-manager.ts`:

```ts
export const POST_EXIT_RETENTION_MS = 15 * 60 * 1000;  // was 30_000
export const MAX_RETAINED_EXITED = 50;
```

Add a private helper that enforces the cap by evicting oldest-exited-first:

```ts
  private enforceRetentionCap(): void {
    const exited = Array.from(this.terminals.values())
      .filter(e => e.exitedAt !== null)
      .sort((a, b) => (a.exitedAt ?? 0) - (b.exitedAt ?? 0));
    while (exited.length > MAX_RETAINED_EXITED) {
      const victim = exited.shift()!;
      if (victim.evictTimer) { clearTimeout(victim.evictTimer); victim.evictTimer = null; }
      this.terminals.delete(victim.terminalId);
    }
  }
```

Call it inside `proc.onExit` (after the `setTimeout` line) and inside the fake `_seedEntryForTest` onExit handler.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/pty-retention-cap.test.ts`
Expected: PASS — 3 tests.

- [ ] **Step 5: Commit**

```bash
git add server/src/claude-pty-manager.ts server/test/pty-retention-cap.test.ts
git commit -m "feat(pty): bump retention to 15min, cap at 50 exited entries"
```

---

## Task 8: Client `useTerminalPresence` hook

**Files:**
- Create: `web/src/hooks/useTerminalPresence.ts`
- Modify: `web/src/data/sessions-api.ts` (no edits required — types regen from shared)

- [ ] **Step 1: Verify the shared type already exposes the fields**

Run: `cd /Users/Matthew.Slight/Dev/oyster.worktrees/terminal-minimise-ux/web && npx tsc --noEmit 2>&1 | grep -i "terminalId\|terminalAttachedClients" | head -5`
Expected: silent (no errors), meaning Session already has the fields from Task 6.

- [ ] **Step 2: Write the hook**

```ts
// web/src/hooks/useTerminalPresence.ts
import { useMemo } from "react";
import type { Session } from "../data/sessions-api";
import type { WindowState } from "../stores/windows";

export type PresenceState = "attached" | "running";

export interface PresenceInfo {
  sessionId: string;
  terminalId: string;
  state: PresenceState;
  attachedClients: number;
}

export interface TerminalPresence {
  /** Sessions whose linked PTY currently has at least one attached window. */
  attached: PresenceInfo[];
  /** Sessions whose linked PTY is alive but no window is attached. */
  running: PresenceInfo[];
  byId: Record<string, PresenceInfo>;
  /** Convenience: attached.length + running.length. */
  totalLive: number;
}

/** Fuses two sources of truth:
 *
 *  - `sessions` carries `terminalId` + `terminalAttachedClients` from the
 *    server (DB-projected, SSE-refreshed by the parent's subscriber).
 *  - `windows` is the client-side list of open panels. A terminal id is
 *    "attached" iff a window in the store references that terminalId.
 *
 *  The DB column tells us if a PTY *exists*; the windows store tells us
 *  whether *this client* is currently looking at it. They are NOT
 *  redundant — the server counts every WS connection (including other
 *  tabs); the local store reflects only this tab's panels. */
export function useTerminalPresence(
  sessions: Session[],
  windows: WindowState[],
): TerminalPresence {
  return useMemo(() => {
    const localTerminalIds = new Set(
      windows.filter(w => w.type === "claude_terminal" && w.terminalId).map(w => w.terminalId!),
    );
    const attached: PresenceInfo[] = [];
    const running: PresenceInfo[] = [];
    const byId: Record<string, PresenceInfo> = {};
    for (const s of sessions) {
      if (!s.terminalId) continue;
      const isAttached = localTerminalIds.has(s.terminalId);
      const info: PresenceInfo = {
        sessionId: s.id,
        terminalId: s.terminalId,
        state: isAttached ? "attached" : "running",
        attachedClients: s.terminalAttachedClients,
      };
      byId[s.id] = info;
      (isAttached ? attached : running).push(info);
    }
    return { attached, running, byId, totalLive: attached.length + running.length };
  }, [sessions, windows]);
}
```

- [ ] **Step 3: Run typecheck**

Run: `cd /Users/Matthew.Slight/Dev/oyster.worktrees/terminal-minimise-ux/web && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add web/src/hooks/useTerminalPresence.ts
git commit -m "feat(web): add useTerminalPresence hook fusing sessions + windows"
```

---

## Task 9: `MINIMISE` action in windows store

**Files:**
- Modify: `web/src/stores/windows.ts`

- [ ] **Step 1: Add the action variant and reducer case**

Edit `web/src/stores/windows.ts`. In the `WindowAction` union:

```ts
export type WindowAction =
  // … existing variants …
  | { type: "CLOSE"; id: string }
  | { type: "MINIMISE"; id: string }
  // … rest …
```

In `windowsReducer`, add a case directly after `CLOSE`:

```ts
    case "MINIMISE":
      // Same state change as CLOSE for the windows array (drop the window).
      // Behavioural difference lives at the call site: terminal panels do
      // NOT call DELETE /api/terminals/:id — the PTY survives.
      return state.filter((w) => w.id !== action.id);
```

- [ ] **Step 2: Typecheck**

Run: `cd web && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add web/src/stores/windows.ts
git commit -m "feat(web): add MINIMISE window action (behavioural distinct from CLOSE)"
```

---

## Task 10: TerminalWindow × dispatches MINIMISE

**Files:**
- Modify: `web/src/components/TerminalWindow.tsx`, `web/src/App.tsx`

- [ ] **Step 1: Change the close handler**

In `web/src/App.tsx`, find the `<TerminalWindow … onClose={…} />` invocation (around line 602 per the spec's `Current state` citation). Change the dispatched action:

```tsx
onClose={() => dispatch({ type: "MINIMISE", id: w.id })}
```

In `web/src/components/TerminalWindow.tsx`, update the tooltip on the × button (find the `onClose` button — should be passed to `WindowChrome` at line ~169). Pass a new prop or set the `title` attribute directly:

```tsx
<WindowChrome
  /* … existing props … */
  onClose={onClose}
  closeButtonTooltip="Minimise terminal"
/>
```

If `WindowChrome` doesn't accept a tooltip prop, add it (single line change there):

```tsx
// In WindowChrome.tsx
interface WindowChromeProps {
  // …
  onClose: () => void;
  closeButtonTooltip?: string;
}
// In the JSX:
<button onClick={onClose} title={closeButtonTooltip ?? "Close"}>×</button>
```

- [ ] **Step 2: Typecheck**

Run: `cd web && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add web/src/components/TerminalWindow.tsx web/src/components/WindowChrome.tsx web/src/App.tsx
git commit -m "feat(web): terminal × minimises (keeps PTY alive); tooltip 'Minimise terminal'"
```

---

## Task 11: `RunningTerminalsPill` component (pill + popover)

**Files:**
- Create: `web/src/components/Topbar/RunningTerminalsPill.tsx`
- Modify: `web/src/App.css`

- [ ] **Step 1: Write the component**

```tsx
// web/src/components/Topbar/RunningTerminalsPill.tsx
import { useState, useRef, useEffect } from "react";
import type { TerminalPresence, PresenceInfo } from "../../hooks/useTerminalPresence";
import type { Session } from "../../data/sessions-api";

interface Props {
  presence: TerminalPresence;
  sessions: Session[];
  onFocus: (terminalId: string) => void;
  onRestore: (sessionId: string, terminalId: string) => void;
  onStop: (terminalId: string) => Promise<void>;
}

export function RunningTerminalsPill({ presence, sessions, onFocus, onRestore, onStop }: Props) {
  const [open, setOpen] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);

  // Close popover when count drops to 0 — the pill disappears too.
  useEffect(() => {
    if (presence.totalLive === 0) setOpen(false);
  }, [presence.totalLive]);

  // Click-outside closes the popover.
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  if (presence.totalLive === 0) return null;

  const rows: { info: PresenceInfo; session: Session | undefined }[] =
    [...presence.attached, ...presence.running].map(info => ({
      info,
      session: sessions.find(s => s.id === info.sessionId),
    }));

  return (
    <div className="rtp-wrap">
      <button
        className={`rtp-pill${open ? " rtp-pill--open" : ""}`}
        onClick={() => setOpen(o => !o)}
        title={`${presence.totalLive} running terminal${presence.totalLive === 1 ? "" : "s"}`}
      >
        <span className="rtp-pulse" />
        Running {presence.totalLive} ▾
      </button>
      {open && (
        <div className="rtp-popover" ref={popoverRef}>
          <div className="rtp-popover-arrow" />
          <div className="rtp-popover-head">
            <span>Running terminals</span>
            <span>{presence.totalLive}</span>
          </div>
          {rows.map(({ info, session }) => {
            const title = session?.title ?? info.sessionId.slice(0, 8);
            const space = session?.spaceId ?? "—";
            const isAttached = info.state === "attached";
            return (
              <div
                key={info.terminalId}
                className="rtp-row"
                onClick={() => isAttached ? onFocus(info.terminalId) : onRestore(info.sessionId, info.terminalId)}
              >
                <span className={isAttached ? "rtp-dot rtp-dot--attached" : "rtp-dot rtp-dot--running"} />
                <div className="rtp-body">
                  <span className="rtp-title">{title}</span>
                  <span className="rtp-meta">
                    <span className="rtp-space">{space}</span> · claude-code · {isAttached ? "open" : "minimised"}
                  </span>
                </div>
                {!isAttached && <span className="rtp-chip rtp-chip--restore">Restore</span>}
                <button
                  className="rtp-stop"
                  title="Stop terminal"
                  onClick={(e) => { e.stopPropagation(); void onStop(info.terminalId); }}
                >■</button>
              </div>
            );
          })}
          <div className="rtp-popover-foot">Click row to focus · Stop ends the session</div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Add the CSS**

Append to `web/src/App.css`:

```css
/* ── Topbar Running terminals pill + popover ─────────────────────── */
.rtp-wrap { position: relative; display: inline-flex; }
.rtp-pill {
  padding: 4px 10px; border-radius: 14px;
  background: rgba(255,255,255,0.05);
  border: 1px solid transparent;
  color: rgba(232,233,240,0.75);
  font-size: 12px;
  display: inline-flex; align-items: center; gap: 6px;
  cursor: pointer;
}
.rtp-pill--open { background: rgba(94,234,212,0.12); border-color: rgba(94,234,212,0.35); color: #5eead4; }
.rtp-pulse {
  width: 6px; height: 6px; border-radius: 50%;
  background: #5eead4; box-shadow: 0 0 8px rgba(94,234,212,0.7);
  animation: rtp-pulse 1.6s infinite;
}
@keyframes rtp-pulse { 0%,100% { opacity: 1 } 50% { opacity: 0.45 } }

.rtp-popover {
  position: absolute; top: calc(100% + 8px); right: 0; z-index: 60;
  background: #1d1f29; border: 1px solid rgba(94,234,212,0.3);
  border-radius: 10px; padding: 6px; min-width: 340px;
  box-shadow: 0 16px 40px rgba(0,0,0,0.6);
}
.rtp-popover-arrow {
  position: absolute; top: -6px; right: 24px; width: 12px; height: 12px;
  background: #1d1f29;
  border-left: 1px solid rgba(94,234,212,0.3);
  border-top: 1px solid rgba(94,234,212,0.3);
  transform: rotate(45deg);
}
.rtp-popover-head {
  padding: 8px 10px 6px; font-size: 10px; text-transform: uppercase; letter-spacing: 0.1em;
  color: rgba(232,233,240,0.4); display: flex; justify-content: space-between;
}
.rtp-row {
  display: grid; grid-template-columns: 14px 1fr auto auto;
  gap: 10px; align-items: center; padding: 8px 10px; border-radius: 6px; cursor: pointer;
}
.rtp-row + .rtp-row { margin-top: 2px; }
.rtp-row:hover { background: rgba(255,255,255,0.04); }
.rtp-dot { width: 9px; height: 9px; border-radius: 50%; }
.rtp-dot--attached { background: #5eead4; box-shadow: 0 0 6px rgba(94,234,212,0.6); }
.rtp-dot--running { background: transparent; border: 2px solid #a78bfa; box-shadow: 0 0 6px rgba(167,139,250,0.4); }
.rtp-body { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.rtp-title { font-size: 12px; color: #e8e9f0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.rtp-meta { font-size: 10px; color: rgba(232,233,240,0.45); }
.rtp-meta .rtp-space { color: #b39dff; }
.rtp-chip {
  font-size: 9px; padding: 2px 7px; border-radius: 4px;
  letter-spacing: 0.05em; text-transform: uppercase; font-weight: 600;
}
.rtp-chip--restore { background: rgba(167,139,250,0.18); color: #a78bfa; }
.rtp-stop {
  background: transparent; border: none; cursor: pointer;
  color: rgba(232,233,240,0.4); font-size: 12px; padding: 4px 6px;
  border-radius: 4px;
}
.rtp-stop:hover { color: #ff7777; background: rgba(255,119,119,0.08); }
.rtp-popover-foot {
  padding: 8px 10px 6px; font-size: 10px;
  color: rgba(232,233,240,0.35);
  border-top: 1px solid rgba(255,255,255,0.05); margin-top: 4px;
}
```

- [ ] **Step 3: Typecheck**

Run: `cd web && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add web/src/components/Topbar/RunningTerminalsPill.tsx web/src/App.css
git commit -m "feat(web): add RunningTerminalsPill component (pill + popover)"
```

---

## Task 12: Mount the pill in the topbar

**Files:**
- Modify: `web/src/App.tsx`

No SSE wiring needed — Task 5 piggy-backs `session_changed` on each terminal event, and `useSessions` (`web/src/hooks/useSessions.ts:21`) already refetches on it. The pill receives fresh presence via the sessions feed.

- [ ] **Step 1: Mount `RunningTerminalsPill` in the topbar**

In `App.tsx`, import the pill and the presence hook and wire it inside the topbar JSX (alongside the existing avatar / space switcher — grep for `<AuthBadge` or similar to find the topbar region):

```tsx
import { useTerminalPresence } from "./hooks/useTerminalPresence";
import { RunningTerminalsPill } from "./components/Topbar/RunningTerminalsPill";

// In the component render, alongside the existing topbar elements:
const presence = useTerminalPresence(sessions, windows);

<RunningTerminalsPill
  presence={presence}
  sessions={sessions}
  onFocus={(terminalId) => {
    const w = windows.find(w => w.terminalId === terminalId);
    if (w) dispatch({ type: "FOCUS", id: w.id });
  }}
  onRestore={(sessionId, terminalId) => {
    const session = sessions.find(s => s.id === sessionId);
    dispatch({
      type: "OPEN_CLAUDE_TERMINAL",
      terminalId,
      title: session?.title ?? "Claude",
      cwd: session?.cwd ?? "/",
      kind: "claude_resume",
      linkedSessionId: sessionId,
    });
  }}
  onStop={async (terminalId) => {
    await fetch(`/api/terminals/${encodeURIComponent(terminalId)}`, { method: "DELETE" });
    // SSE event will trigger refetch.
  }}
/>
```

- [ ] **Step 2: Typecheck + dev server smoke**

```bash
cd web && npx tsc --noEmit
```

Then start the dev server and verify the pill appears when you launch a Claude terminal, the popover opens, click row focuses or restores, and Stop ends the session.

- [ ] **Step 3: Commit**

```bash
git add web/src/App.tsx
git commit -m "feat(web): mount RunningTerminalsPill in topbar"
```

---

## Task 13: Sessions list — `Live` filter + row treatment

**Files:**
- Modify: `web/src/components/Home/index.tsx`, `web/src/App.css`

- [ ] **Step 1: Extend the filter pills list**

In `web/src/components/Home/index.tsx`, find `LIVE_STATES` and the filter-pill render block (around lines 107-135 per spec citation). Add a new "Live" filter that derives from `useTerminalPresence`:

```tsx
const presence = useTerminalPresence(sessions, windows);
const liveCount = presence.totalLive;
// In the pills render, insert before the existing "waiting" pill:
{liveCount > 0 && (
  <button
    className={`hp-pill hp-pill--live${filter === "live-terminals" ? " is-active" : ""}`}
    onClick={() => setFilter("live-terminals")}
  >
    {liveCount} Live
  </button>
)}
```

Extend the existing filter switch / `useMemo` that produces `visibleSessions` to handle `"live-terminals"` by filtering to sessions where `presence.byId[s.id]` exists.

- [ ] **Step 2: Add per-row Open/Minimised treatment**

In the row render, derive the class:

```tsx
const live = presence.byId[s.id];
const rowClass = live
  ? (live.state === "attached" ? "sr--attached" : "sr--running")
  : "";
// …
<div className={`sr ${rowClass}`}>
  <span className="sr-space">{s.spaceId}</span>
  <span className="sr-title">
    {live
      ? <span className={live.state === "attached" ? "rd rd--attached" : "rd rd--running"} />
      : <span className={`rd rd--${s.state}`} />}
    {s.title ?? "(no title)"}
  </span>
  {live?.state === "running" && (
    <button
      className="sl-chip sl-chip--restore"
      onClick={() => onRestore(s.id, live.terminalId)}
    >Restore</button>
  )}
  {/* … existing right-side meta … */}
</div>
```

- [ ] **Step 3: Pin live rows to the top in the sort**

Where `visibleSessions` is sorted (look for the existing `.sort(...)` on the rows array), wrap the comparator:

```tsx
const sorted = visibleSessions.slice().sort((a, b) => {
  const aLive = presence.byId[a.id] ? 0 : 1;
  const bLive = presence.byId[b.id] ? 0 : 1;
  if (aLive !== bLive) return aLive - bLive; // live first
  // Fall through to existing comparison (last_event_at desc, etc.)
  return (b.lastEventAt ?? "").localeCompare(a.lastEventAt ?? "");
});
```

- [ ] **Step 4: Add the row CSS**

Append to `web/src/App.css`:

```css
.sr--attached {
  background: linear-gradient(90deg, rgba(94,234,212,0.06), transparent 70%);
  border-left: 2px solid #5eead4;
  padding-left: 12px;
}
.sr--running {
  background: linear-gradient(90deg, rgba(167,139,250,0.05), transparent 70%);
  border-left: 2px solid #a78bfa;
  padding-left: 12px;
}
.rd--attached { background: #5eead4; box-shadow: 0 0 6px rgba(94,234,212,0.5); }
.rd--running { background: transparent; border: 2px solid #a78bfa; }
.sl-chip--restore {
  background: rgba(167,139,250,0.18); color: #a78bfa;
  font-size: 9px; padding: 2px 7px; border-radius: 4px;
  letter-spacing: 0.04em; text-transform: uppercase; font-weight: 600;
  border: none; cursor: pointer;
}
.hp-pill--live { background: rgba(94,234,212,0.18); color: #5eead4; }
```

- [ ] **Step 5: Typecheck + dev server smoke**

```bash
cd web && npx tsc --noEmit
```

Run the dev server. Launch a Claude terminal, click ×; confirm the Sessions list row shows the purple outlined dot, the Restore chip, and pinned to top.

- [ ] **Step 6: Commit**

```bash
git add web/src/components/Home/index.tsx web/src/App.css
git commit -m "feat(web): Sessions list shows Open/Minimised state and Live filter pill"
```

---

## Task 14: Manual acceptance smoke test

Spec acceptance tests, walked through in a real browser against a real PTY.

- [ ] **Step 1: Start dev server in the worktree**

```bash
cd /Users/Matthew.Slight/Dev/oyster.worktrees/terminal-minimise-ux
# If the production Oyster on 4444 is running, kill it first (single-instance lock).
# Then:
npm run dev
```

Open `http://localhost:7337`.

- [ ] **Step 2: Walk the acceptance tests**

Verify each item from `docs/superpowers/specs/2026-05-19-terminal-minimise-ux-design.md#acceptance-tests`:

- **Minimise keeps PTY alive.** Open a Claude terminal in any space. Send a `pwd` keystroke; see output. Click × on the panel. Confirm: panel gone, topbar pill shows `Running 1 ▾`.
- **Running pill appears after minimise.** Confirmed in the step above. Also confirm: pill disappears entirely if you Stop the only terminal.
- **Restore re-attaches the same PTY.** Click the pill → popover → click the row. Panel re-opens. Type `echo OK` — output goes through the same shell history (you should see the earlier `pwd` output in scrollback).
- **Stop kills the PTY.** Click the Stop button (■) in the popover. The row disappears from the popover. In the Sessions list the row reverts to its underlying state (no dot/stripe).
- **Boot reset clears stale indicators.** Stop the dev server. Open `~/Oyster/db/oyster.db` (`sqlite3 ~/Oyster/db/oyster.db`) and run `UPDATE sessions SET terminal_id = 'fake', terminal_attached_clients = 3 WHERE id = (SELECT id FROM sessions LIMIT 1);`. Restart the dev server. Refresh the page. Confirm the Sessions list shows no Live / Open / Minimised indicators (the boot reset zeroed them).
- **Live rows pin to top.** With one Live row in the Sessions list, scroll to the bottom of "done" rows; confirm the Live row is still at the top regardless of last activity.

- [ ] **Step 3: If anything fails, file specific follow-up commits**

Each follow-up gets its own commit so the failure → fix is reviewable in isolation.

---

## Wrap-up

After all tasks pass, push the branch and open the PR.

```bash
git push -u origin terminal-minimise-ux
gh pr create --title "Terminal × minimises (keeps PTY alive); Running pill + Sessions list states" --body "$(cat <<'EOF'
## Summary

Click × on the embedded Claude Code terminal panel now means *minimise* — the PTY stays alive on the server. A new topbar **Running N** pill (with a popover listing every live terminal) gives one-click restore from anywhere. The Sessions list grows an **Open** / **Minimised** state visualisation and a single **Live** filter pill.

Design: [docs/superpowers/specs/2026-05-19-terminal-minimise-ux-design.md](docs/superpowers/specs/2026-05-19-terminal-minimise-ux-design.md)
Plan: [docs/superpowers/plans/2026-05-19-terminal-minimise-ux.md](docs/superpowers/plans/2026-05-19-terminal-minimise-ux.md)

## Test plan

- [x] Server: vitest covers schema migration + boot reset, store link/clear/attached-clients methods, manager link/exit/attach/detach DB writes, SSE event emission, retention bump + 50-retained cap.
- [x] Web: tsc --noEmit clean.
- [ ] Manual smoke checklist from the spec's Acceptance Tests (see plan Task 14).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```
