# Session Status Palette Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the time-based `done` state with evidence-based clean-exit detection, add `dormant` for 8h+ idle sessions, and split the managed-vs-unmanaged dot palette so colour reflects what we actually know.

**Architecture:** Evidence-first storage with derived display state. New nullable fact columns (`exit_code`, `exit_signal`, `explicit_exit_seen`, `clean_process_exit`, `last_assistant_stop_reason`) capture what we observe; `deriveState()` becomes a pure function over those facts plus age + probe. The two clean-exit signals are kept separate so the decision rule is auditable: `done = explicit_exit_seen || clean_process_exit`, and bad exit evidence (non-zero exit code or a signal) beats either of them.

**`dormant` is a display-only state, never persisted.** The DB `state` enum stays as `active | waiting | disconnected | done` (no schema CHECK change, no risky table rebuild). The wire format gains a second field, `displayState`, computed server-side as `state === 'disconnected' && now - lastEventAt > 8h ? 'dormant' : state`. The UI consumes `displayState` for the dot. This keeps the persisted state honest about what we actually know and avoids the migration footgun where widening the `state` CHECK triggers a table rebuild that silently drops every later-ALTER'd column.

UI splits dot colour by managed presence (purple-themed for Oyster-owned PTYs, green-themed for externally observed JSONL sessions). Single composite glyph (amber fill + purple ring) for the only state that needs two facts at once: managed + waiting.

**Tech Stack:** TypeScript (server + web), better-sqlite3, React, Vitest.

---

## Pre-work: confirm we're in the right worktree

- [ ] **Step 0.1: Verify worktree**

Run: `pwd && git branch --show-current`
Expected: `/Users/Matthew.Slight/Dev/oyster.worktrees/session-status-investigation` on branch `session-status-investigation`.

If not, see `docs/plans/roadmap.md` and re-create the worktree per the project convention (`~/Dev/oyster.worktrees/<branch>`).

---

## Task 1: Schema — add fact columns via additive ALTER (no CHECK change, no rebuild)

Goal: persist the new facts the watcher and PTY manager will write. **`dormant` is NOT added to the persisted enum** — it's purely a display-time concept (see Task 6). This task only adds nullable fact columns via the well-trodden additive-ALTER path.

> **Why no CHECK widening.** Widening the `state` CHECK requires a SQLite table rebuild (CHECK can't be ALTERed in place). The existing rebuild block in `db.ts` was written long ago when the `sessions` table had ~10 columns; since then many `ALTER TABLE sessions ADD COLUMN ...` statements have been appended below it (`cwd`, `assignment_mode`, `project_id`, terminal columns, all the cloud-sync columns). The rebuild's `INSERT INTO _sessions_new ... SELECT` projection only knows about its original column list. Widening the rebuild trigger to fire on every upgrade would silently drop every later-ALTER'd column's data. The right move is to skip the rebuild entirely.

**Files:**
- Modify: `server/src/db.ts` — CREATE TABLE (around `:255-298`) and the post-rebuild additive ALTER section.
- Test: new `server/test/sessions-table-status-columns.test.ts` and new `server/test/sessions-migration-regression.test.ts` (the guardrail).

- [ ] **Step 1.1: Write the status-columns test (failing)**

```ts
// server/test/sessions-table-status-columns.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb } from "../src/db.js";

describe("sessions table — status-evidence columns", () => {
  it("has exit_code, exit_signal, explicit_exit_seen, clean_process_exit, last_assistant_stop_reason", () => {
    const dir = mkdtempSync(join(tmpdir(), "oyster-test-"));
    const db = initDb(dir);
    const cols = db.prepare("PRAGMA table_info(sessions)").all() as Array<{
      name: string; notnull: number; dflt_value: unknown;
    }>;
    const byName = new Map(cols.map((c) => [c.name, c]));
    expect(byName.has("exit_code")).toBe(true);
    expect(byName.has("exit_signal")).toBe(true);
    expect(byName.has("explicit_exit_seen")).toBe(true);
    expect(byName.has("clean_process_exit")).toBe(true);
    expect(byName.has("last_assistant_stop_reason")).toBe(true);

    // Lock in the structural shape — typos like DEAFULT or NULL slip through column-name-only checks.
    expect(byName.get("explicit_exit_seen")).toMatchObject({ notnull: 1, dflt_value: "0" });
    expect(byName.get("clean_process_exit")).toMatchObject({ notnull: 1, dflt_value: "0" });
  });

  it("still rejects 'dormant' as a stored state value (dormant is display-only)", () => {
    const dir = mkdtempSync(join(tmpdir(), "oyster-test-"));
    const db = initDb(dir);
    expect(() =>
      db.prepare(`
        INSERT INTO sessions (id, agent, title, state)
        VALUES ('s1', 'claude-code', 't', 'dormant')
      `).run(),
    ).toThrow(/CHECK constraint/);
  });
});
```

Confirm the actual exported function name from `server/src/db.ts` — it may be `initDb`, `initSchema`, or similar. Adjust the import if needed.

- [ ] **Step 1.2: Write the migration regression test (failing initially because columns don't exist yet)**

This is the guardrail that would have caught the data-loss bug. It seeds a sessions row using the *current legacy schema shape* (CHECK with four states, columns that have been added by `ALTER` over time), runs `initDb`, and asserts that NO data is lost.

```ts
// server/test/sessions-migration-regression.test.ts
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb } from "../src/db.js";

// Guard against the migration ever silently dropping ALTER-added columns
// from existing-install rows. Seed a sessions row with values in every
// column that's been added via ALTER in the project history, run initDb,
// and assert the values survive.
describe("sessions migration — ALTER-added column preservation", () => {
  it("preserves cwd/assignment_mode/project_id and other ALTER-added column values", () => {
    const dir = mkdtempSync(join(tmpdir(), "oyster-test-"));
    mkdirSync(join(dir, "db"), { recursive: true });
    const dbPath = join(dir, "db", "oyster.db");

    // Hand-build a sessions table matching what an existing install looks
    // like RIGHT BEFORE the migration runs (post-rename, pre-this-change):
    //   - state CHECK has four values (no 'dormant')
    //   - all the ALTER-added columns exist with their declared types
    {
      const raw = new Database(dbPath);
      raw.exec(`
        CREATE TABLE sessions (
          id            TEXT PRIMARY KEY,
          space_id      TEXT,
          agent         TEXT NOT NULL CHECK (agent IN ('claude-code','opencode','codex')),
          title         TEXT,
          state         TEXT NOT NULL CHECK (state IN ('active','waiting','disconnected','done')),
          started_at    TEXT NOT NULL DEFAULT (datetime('now')),
          ended_at      TEXT,
          model         TEXT,
          last_event_at TEXT NOT NULL DEFAULT (datetime('now')),
          last_offset   INTEGER NOT NULL DEFAULT 0
        );
      `);
      // Replay every ALTER currently in db.ts that adds a column to sessions.
      // If db.ts grows more ALTERs in future, add them here too.
      const alters = [
        "ALTER TABLE sessions ADD COLUMN cwd TEXT",
        "ALTER TABLE sessions ADD COLUMN assignment_mode TEXT NOT NULL DEFAULT 'auto'",
        "ALTER TABLE sessions ADD COLUMN project_id TEXT",
        "ALTER TABLE sessions ADD COLUMN jsonl_path TEXT",
        "ALTER TABLE sessions ADD COLUMN terminal_id TEXT",
        "ALTER TABLE sessions ADD COLUMN terminal_attached_clients INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE sessions ADD COLUMN sync_dirty_at TEXT",
        "ALTER TABLE sessions ADD COLUMN cloud_synced_at TEXT",
        "ALTER TABLE sessions ADD COLUMN cloud_owner_id TEXT",
        "ALTER TABLE sessions ADD COLUMN jsonl_synced_at TEXT",
        "ALTER TABLE sessions ADD COLUMN jsonl_snapshot_offset INTEGER",
        "ALTER TABLE sessions ADD COLUMN jsonl_chunk_count INTEGER",
        "ALTER TABLE sessions ADD COLUMN bytes_generation INTEGER",
      ];
      for (const sql of alters) {
        try { raw.exec(sql); } catch { /* column already exists or table didn't need it */ }
      }
      raw.prepare(`
        INSERT INTO sessions (
          id, agent, title, state, last_event_at,
          cwd, assignment_mode, project_id, jsonl_path, terminal_id
        ) VALUES (
          's1', 'claude-code', 'test', 'active', datetime('now'),
          '/some/cwd', 'manual', 'proj-abc', '/tmp/abc.jsonl', 'term-xyz'
        )
      `).run();
      raw.close();
    }

    // Run real init.
    const db = initDb(dir);
    const row = db.prepare("SELECT * FROM sessions WHERE id = 's1'").get() as Record<string, unknown>;

    expect(row).toBeDefined();
    expect(row.cwd).toBe("/some/cwd");
    expect(row.assignment_mode).toBe("manual");
    expect(row.project_id).toBe("proj-abc");
    expect(row.jsonl_path).toBe("/tmp/abc.jsonl");
    expect(row.terminal_id).toBe("term-xyz");
  });
});
```

(The point of this test isn't to pass on day one — once the new fact columns are added below, it will pass because nothing rebuilds the table. Its real job is to fail loudly the next time someone tries to widen a CHECK or rebuild the sessions table without preserving every ALTER-added column.)

- [ ] **Step 1.3: Run both tests — verify they fail**

Run: `cd server && npx vitest run test/sessions-table-status-columns.test.ts test/sessions-migration-regression.test.ts`
Expected: status-columns test FAILS (columns missing). Migration regression test may pass or fail depending on whether the current db.ts already preserves these columns — record the result. Either way it becomes a permanent guardrail.

- [ ] **Step 1.4: Add the 5 columns to the CREATE TABLE in `server/src/db.ts` (around line 260)**

**Do NOT change the `state` CHECK.** It stays as:
```sql
state         TEXT NOT NULL CHECK (state IN ('active','waiting','disconnected','done')),
```

Add 5 columns inside the CREATE TABLE block, after `last_offset INTEGER NOT NULL DEFAULT 0`:
```sql
exit_code                  INTEGER,
exit_signal                TEXT,
explicit_exit_seen         INTEGER NOT NULL DEFAULT 0,
clean_process_exit         INTEGER NOT NULL DEFAULT 0,
last_assistant_stop_reason TEXT,
```

- [ ] **Step 1.5: Add additive ALTERs (idempotent) for existing installs**

Below the existing `try { db.exec("ALTER TABLE sessions ADD COLUMN last_offset ..."); } catch {}` block (around `:312`), add five more in the same try/catch style:
```ts
try { db.exec("ALTER TABLE sessions ADD COLUMN exit_code INTEGER"); } catch {}
try { db.exec("ALTER TABLE sessions ADD COLUMN exit_signal TEXT"); } catch {}
try { db.exec("ALTER TABLE sessions ADD COLUMN explicit_exit_seen INTEGER NOT NULL DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE sessions ADD COLUMN clean_process_exit INTEGER NOT NULL DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE sessions ADD COLUMN last_assistant_stop_reason TEXT"); } catch {}
```

**Do NOT touch the existing `needsMigrate` block or `_sessions_new` rebuild.** Leave it exactly as-is.

- [ ] **Step 1.6: Run both tests — verify they pass**

Run: `cd server && npx vitest run test/sessions-table-status-columns.test.ts test/sessions-migration-regression.test.ts`
Expected: PASS for both.

Also run the full suite to confirm no regressions:
Run: `cd server && npx vitest run`
Expected: all pre-existing tests still pass.

- [ ] **Step 1.7: Commit**

```bash
git add server/src/db.ts server/test/sessions-table-status-columns.test.ts server/test/sessions-migration-regression.test.ts
git commit -m "feat(sessions): add fact columns (exit_code, exit_signal, explicit_exit_seen, clean_process_exit, last_assistant_stop_reason) via additive ALTER + migration regression guard"
```

---

## Task 2: SessionStore — methods to write the new facts

Goal: typed write paths for the columns added in Task 1, so the watcher and PTY manager don't poke the DB directly. Keep the two clean-exit signals on separate methods so each callsite states exactly which evidence it has.

**Files:**
- Modify: `server/src/session-store.ts` (interface around `:159`, prepared statements around `:204` and `:299`, implementation around `:395`).
- Test: `server/test/session-store-exit-info.test.ts` (new).

- [ ] **Step 2.1: Write failing test**

```ts
// server/test/session-store-exit-info.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { initSchema } from "../src/db.js";
import { SessionStore } from "../src/session-store.js";

describe("SessionStore — exit info + last_assistant_stop_reason", () => {
  let db: Database.Database;
  let store: SessionStore;
  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db);
    store = new SessionStore(db);
    store.insertSession({
      id: "s1", space_id: null, project_id: null, cwd: null, jsonl_path: null,
      agent: "claude-code", title: "t", state: "active",
      started_at: null, model: null, last_event_at: null, assignment_mode: "auto",
    } as any);
  });

  it("recordExit writes exit_code, exit_signal, clean_process_exit", () => {
    store.recordExit("s1", { exitCode: 0, exitSignal: null, cleanProcessExit: true });
    const row = db.prepare("SELECT exit_code, exit_signal, clean_process_exit FROM sessions WHERE id=?").get("s1");
    expect(row).toEqual({ exit_code: 0, exit_signal: null, clean_process_exit: 1 });
  });

  it("recordExit on bad exit does not set clean_process_exit", () => {
    store.recordExit("s1", { exitCode: 137, exitSignal: "SIGKILL", cleanProcessExit: false });
    const row = db.prepare("SELECT exit_code, exit_signal, clean_process_exit FROM sessions WHERE id=?").get("s1");
    expect(row).toEqual({ exit_code: 137, exit_signal: "SIGKILL", clean_process_exit: 0 });
  });

  it("setLastAssistantStopReason updates only that column", () => {
    store.setLastAssistantStopReason("s1", "end_turn");
    const row = db.prepare("SELECT last_assistant_stop_reason FROM sessions WHERE id=?").get("s1");
    expect(row).toEqual({ last_assistant_stop_reason: "end_turn" });
  });

  it("markExplicitExitSeen flips the flag without touching process-exit fields", () => {
    store.markExplicitExitSeen("s1");
    const row = db.prepare("SELECT explicit_exit_seen, exit_code, exit_signal, clean_process_exit FROM sessions WHERE id=?").get("s1");
    expect(row).toEqual({ explicit_exit_seen: 1, exit_code: null, exit_signal: null, clean_process_exit: 0 });
  });
});
```

- [ ] **Step 2.2: Run test to verify it fails**

Run: `cd server && npx vitest run test/session-store-exit-info.test.ts`
Expected: FAIL — `recordExit`, `setLastAssistantStopReason`, `markExplicitExitSeen` undefined.

- [ ] **Step 2.3: Extend the SessionStore interface**

In `server/src/session-store.ts` near `:159`, add three method signatures:
```ts
recordExit(id: string, info: { exitCode: number | null; exitSignal: string | null; cleanProcessExit: boolean }): void;
setLastAssistantStopReason(id: string, reason: string | null): void;
markExplicitExitSeen(id: string): void;
```

Also extend the `SessionRow` / `Session` types (search file for `SessionRow`) with the five new optional fields:
```ts
exit_code: number | null;
exit_signal: string | null;
explicit_exit_seen: number; // 0 | 1, sqlite-style
clean_process_exit: number; // 0 | 1, sqlite-style
last_assistant_stop_reason: string | null;
```

- [ ] **Step 2.4: Add prepared statements and implementations**

In the constructor's `this.stmts = { ... }` (around `:204` and `:299`):
```ts
recordExit: db.prepare(`
  UPDATE sessions
  SET exit_code = @exit_code,
      exit_signal = @exit_signal,
      clean_process_exit = @clean_process_exit
  WHERE id = @id
`),
setLastAssistantStopReason: db.prepare(`
  UPDATE sessions SET last_assistant_stop_reason = ? WHERE id = ?
`),
markExplicitExitSeen: db.prepare(`
  UPDATE sessions SET explicit_exit_seen = 1 WHERE id = ?
`),
```

And in the methods section near `:395`:
```ts
recordExit(id: string, info: { exitCode: number | null; exitSignal: string | null; cleanProcessExit: boolean }): void {
  this.stmts.recordExit.run({
    id,
    exit_code: info.exitCode,
    exit_signal: info.exitSignal,
    clean_process_exit: info.cleanProcessExit ? 1 : 0,
  });
}
setLastAssistantStopReason(id: string, reason: string | null): void {
  this.stmts.setLastAssistantStopReason.run(reason, id);
}
markExplicitExitSeen(id: string): void {
  this.stmts.markExplicitExitSeen.run(id);
}
```

- [ ] **Step 2.5: Run test to verify it passes**

Run: `cd server && npx vitest run test/session-store-exit-info.test.ts`
Expected: PASS.

- [ ] **Step 2.6: Commit**

```bash
git add server/src/session-store.ts server/test/session-store-exit-info.test.ts
git commit -m "feat(session-store): add recordExit/setLastAssistantStopReason/markExplicitExitSeen"
```

---

## Task 3: PTY exit handler — capture exit code/signal as evidence

Goal: when a managed PTY ends, record the exit code/signal as facts. Clean process exit (`exit=0` and no signal) sets `clean_process_exit = 1`; that's an independent signal from `explicit_exit_seen` (which only the watcher sets when it sees a `/exit` event in the JSONL). The handler stops hard-coding `"disconnected"`.

**Files:**
- Modify: `server/src/claude-pty-manager.ts:_handleExit` (around `:328-360`) — and the upstream `pty.onExit` wiring so we receive the signal too. Search for `_handleExit(entry, exitCode` and the `pty.onExit(` call that invokes it.
- Test: `server/test/claude-pty-manager.test.ts` (extend).

- [ ] **Step 3.1: Write failing test**

Open `server/test/claude-pty-manager.test.ts` and add:
```ts
it("records exit code/signal and marks clean_process_exit on exit=0", async () => {
  const { manager, store, sessionId } = setupManagedSession(); // existing test helper pattern
  manager._handleExit(entryForSession(sessionId), { exitCode: 0, signal: null });
  const row = store.getById(sessionId)!;
  expect(row.exit_code).toBe(0);
  expect(row.exit_signal).toBeNull();
  expect(row.clean_process_exit).toBe(1);
});

it("records non-zero exit without setting clean_process_exit", async () => {
  const { manager, store, sessionId } = setupManagedSession();
  manager._handleExit(entryForSession(sessionId), { exitCode: 137, signal: "SIGKILL" });
  const row = store.getById(sessionId)!;
  expect(row.exit_code).toBe(137);
  expect(row.exit_signal).toBe("SIGKILL");
  expect(row.clean_process_exit).toBe(0);
});
```

(Use existing fixture helpers in the test file — match the existing style.)

- [ ] **Step 3.2: Run test to verify it fails**

Run: `cd server && npx vitest run test/claude-pty-manager.test.ts`
Expected: FAIL — `_handleExit` signature doesn't accept `{ exitCode, signal }`; `exit_code` column not populated.

- [ ] **Step 3.3: Update `_handleExit` signature and body**

In `server/src/claude-pty-manager.ts:_handleExit`:

Change the signature from:
```ts
private _handleExit(entry: ClaudePtyEntry, exitCode: number): void {
```
to:
```ts
private _handleExit(entry: ClaudePtyEntry, exit: { exitCode: number; signal: string | null }): void {
```

Update the body so:
1. The existing `closeNote` keeps using `exit.exitCode` for the visible message.
2. Replace the hard-coded `updateSessionState(..., "disconnected", ...)` call with:
   ```ts
   const cleanProcessExit = exit.exitCode === 0 && !exit.signal;
   this.sessionStore.recordExit(exitedSessionId, {
     exitCode: exit.exitCode,
     exitSignal: exit.signal ?? null,
     cleanProcessExit,
   });
   // Derived state: the next heartbeat sweep will pick the right label
   // from the new facts, but write an immediate value so SSE clients
   // don't flicker through "active".
   this.sessionStore.updateSessionState(
     exitedSessionId,
     cleanProcessExit ? "done" : "disconnected",
     new Date().toISOString(),
   );
   ```

- [ ] **Step 3.4: Update the `pty.onExit` callsite**

Search for the place that wires up `pty.onExit(...)` in this file. node-pty's `onExit` callback receives `{ exitCode, signal }`. Update the callback to pass that object straight through to `_handleExit`. Example:
```ts
pty.onExit(({ exitCode, signal }) => {
  this._handleExit(entry, { exitCode, signal: signal ? String(signal) : null });
});
```

- [ ] **Step 3.5: Run tests to verify they pass**

Run: `cd server && npx vitest run test/claude-pty-manager.test.ts test/claude-pty-manager-link.test.ts`
Expected: PASS for the new tests; existing link/exit tests still pass.

- [ ] **Step 3.6: Commit**

```bash
git add server/src/claude-pty-manager.ts server/test/claude-pty-manager.test.ts
git commit -m "feat(pty): record exit_code/exit_signal and clean_process_exit on PTY exit"
```

---

## Task 4: Watcher — detect `/exit` event and track `last_assistant_stop_reason`

Goal: for unmanaged sessions, scan incoming events for the slash-command that closes the session (sets `explicit_exit_seen = 1`), and persist the `stop_reason` of the most recent assistant message so the UI can distinguish "agent is thinking" from "agent is awaiting input".

**Files:**
- Modify: `server/src/watchers/claude-code.ts` event-ingest path (search for where assistant events get written and where slash-command-style user events are filtered, around the `userMessageTitleCandidate` / `isClaudeProtocolArtifact` helpers).
- Test: `server/test/claude-code-once-new-jsonl.test.ts` (extend) or new `server/test/claude-code-watcher-evidence.test.ts`.

> **Wire format note:** Claude Code templates slash commands into a `<command-name>/exit</command-name>` wrapper inside the user message `content` before persisting — the wrapper IS the invocation event, not a follow-up render artefact. Match the wrapper; don't expect a raw `/exit`. (Verified empirically against `~/.claude/projects/*/*.jsonl`: 0 raw `/exit` user events vs 73 wrapped ones in the local corpus.)

- [ ] **Step 4.1: Write failing test**

```ts
// server/test/claude-code-watcher-evidence.test.ts
import { describe, it, expect } from "vitest";
// Set up the watcher with a temp dir and a hand-rolled JSONL file.
// See claude-code-once-new-jsonl.test.ts for the existing fixture style — match it.

const EXIT_WRAPPED =
  "<command-name>/exit</command-name>\n            <command-message>exit</command-message>\n            <command-args></command-args>";

describe("claude-code watcher — evidence capture", () => {
  it("sets explicit_exit_seen when the JSONL tail has a wrapped /exit user event", async () => {
    const { sessionId, store } = await runWatcherOnce([
      { type: "user", message: { content: "first" } },
      { type: "assistant", message: { stop_reason: "end_turn" } },
      { type: "user", message: { role: "user", content: EXIT_WRAPPED } },
    ]);
    expect(store.getById(sessionId)!.explicit_exit_seen).toBe(1);
  });

  it("stores last assistant stop_reason in last_assistant_stop_reason", async () => {
    const { sessionId, store } = await runWatcherOnce([
      { type: "user", message: { content: "do it" } },
      { type: "assistant", message: { stop_reason: "tool_use" } },
    ]);
    expect(store.getById(sessionId)!.last_assistant_stop_reason).toBe("tool_use");
  });

  it("end_turn updates last_assistant_stop_reason from a prior tool_use", async () => {
    const { sessionId, store } = await runWatcherOnce([
      { type: "assistant", message: { stop_reason: "tool_use" } },
      { type: "tool_result", message: {} },
      { type: "assistant", message: { stop_reason: "end_turn" } },
    ]);
    expect(store.getById(sessionId)!.last_assistant_stop_reason).toBe("end_turn");
  });
});
```

- [ ] **Step 4.2: Run test to verify it fails**

Run: `cd server && npx vitest run test/claude-code-watcher-evidence.test.ts`
Expected: FAIL — neither `explicit_exit_seen` nor `last_assistant_stop_reason` are written by the watcher today.

- [ ] **Step 4.3: Hook the event handler to update `last_assistant_stop_reason`**

Locate the function in `claude-code.ts` that processes each parsed event and writes session_events / updates session state (search for `updateSessionState(tracker.sessionId, "active", ts)` near `:854`). At the point where an event is committed, add:

```ts
if (ev.type === "assistant") {
  const stopReason = ev?.message?.stop_reason;
  if (typeof stopReason === "string") {
    this.deps.sessionStore.setLastAssistantStopReason(tracker.sessionId, stopReason);
  }
}
```

- [ ] **Step 4.4: Hook the event handler to detect `/exit`**

In the same loop, when processing a `type: "user"` event:
```ts
if (ev.type === "user") {
  const content = ev?.message?.content;
  if (typeof content === "string") {
    // Claude Code templates slash commands into a wrapper *before* writing to
    // JSONL — the wrapper IS the invocation event, not a follow-up render
    // artefact. Match the wrapper; don't expect a raw `/exit`.
    if (content.trimStart().startsWith("<command-name>/exit</command-name>")) {
      this.deps.sessionStore.markExplicitExitSeen(tracker.sessionId);
    }
  }
}
```

Place this BEFORE the existing `isClaudeProtocolArtifact` filter so `/exit` is recognised even though it's a protocol artifact for title purposes.

- [ ] **Step 4.5: Run tests to verify they pass**

Run: `cd server && npx vitest run test/claude-code-watcher-evidence.test.ts`
Expected: PASS.

Also re-run: `cd server && npx vitest run test/claude-code-once-new-jsonl.test.ts`
Expected: still passes (no regression).

- [ ] **Step 4.6: Commit**

```bash
git add server/src/watchers/claude-code.ts server/test/claude-code-watcher-evidence.test.ts
git commit -m "feat(watcher): set explicit_exit_seen on /exit and persist last_assistant_stop_reason"
```

---

## Task 5: Rewrite `deriveState()` as a pure evidence-first function

Goal: collapse the rules from the proposed table into one pure function. Replace the existing time-only `deriveState(ageMs, signal)` with a richer input. The heartbeat sweep calls it; tests live alongside it.

**Files:**
- Modify: `server/src/watchers/claude-code.ts:921` (`deriveState`) and the heartbeat sweep around `:877` (`runHeartbeatSweep`) which currently calls it.
- Test: new `server/test/derive-state.test.ts`.

- [ ] **Step 5.1: Write failing test**

```ts
// server/test/derive-state.test.ts
import { describe, it, expect } from "vitest";
import { deriveState } from "../src/watchers/claude-code.js";

const MIN = 60_000;
const HOUR = 60 * MIN;

const base = {
  terminalId: null as string | null,
  ageMs: 0,
  probeSignal: "unknown" as const,
  exitCode: null as number | null,
  exitSignal: null as string | null,
  explicitExitSeen: false,
  cleanProcessExit: false,
  lastAssistantStopReason: null as string | null,
};

describe("deriveState — evidence-first", () => {
  it("managed + recent activity → active", () => {
    expect(deriveState({ ...base, terminalId: "t1", ageMs: 5_000 })).toBe("active");
  });

  it("managed + last stop_reason end_turn → waiting", () => {
    expect(deriveState({ ...base, terminalId: "t1", ageMs: 5_000, lastAssistantStopReason: "end_turn" })).toBe("waiting");
  });

  it("managed + last stop_reason tool_use → active (still thinking)", () => {
    expect(deriveState({ ...base, terminalId: "t1", ageMs: 90_000, lastAssistantStopReason: "tool_use" })).toBe("active");
  });

  it("explicit /exit observed → done regardless of age", () => {
    expect(deriveState({ ...base, explicitExitSeen: true, ageMs: 10 * HOUR })).toBe("done");
  });

  it("clean PTY exit observed → done regardless of age", () => {
    expect(deriveState({ ...base, cleanProcessExit: true, ageMs: 10 * HOUR })).toBe("done");
  });

  // Precedence: bad exit evidence beats clean exit evidence. A session that
  // ran /exit but then got SIGKILLed mid-shutdown should read as disconnected.
  it("bad exit beats explicit /exit", () => {
    expect(deriveState({ ...base, explicitExitSeen: true, exitSignal: "SIGKILL" })).toBe("disconnected");
  });

  it("bad exit beats clean process exit", () => {
    expect(deriveState({ ...base, cleanProcessExit: true, exitCode: 1 })).toBe("disconnected");
  });

  it("PTY exit with non-zero code → disconnected", () => {
    expect(deriveState({ ...base, exitCode: 1, ageMs: 1 * MIN })).toBe("disconnected");
  });

  it("PTY exit with signal → disconnected", () => {
    expect(deriveState({ ...base, exitSignal: "SIGKILL", ageMs: 1 * MIN })).toBe("disconnected");
  });

  it("unmanaged, <60s → active", () => {
    expect(deriveState({ ...base, ageMs: 30_000 })).toBe("active");
  });

  it("unmanaged, 60s–30min, probe alive → waiting", () => {
    expect(deriveState({ ...base, ageMs: 5 * MIN, probeSignal: "alive" })).toBe("waiting");
  });

  it("unmanaged, 60s–30min, probe absent → disconnected", () => {
    expect(deriveState({ ...base, ageMs: 5 * MIN, probeSignal: "absent" })).toBe("disconnected");
  });

  it("unmanaged, 30min–8h → disconnected", () => {
    expect(deriveState({ ...base, ageMs: 4 * HOUR })).toBe("disconnected");
  });

  // 8h+ idle still returns 'disconnected' from deriveState; 'dormant' is
  // computed at the presentation layer (see Task 6) and never persisted.
  it("unmanaged, >8h, no exit evidence → disconnected (dormant happens at display time)", () => {
    expect(deriveState({ ...base, ageMs: 12 * HOUR })).toBe("disconnected");
  });
});
```

- [ ] **Step 5.2: Run test to verify it fails**

Run: `cd server && npx vitest run test/derive-state.test.ts`
Expected: FAIL — current `deriveState` signature is `(ageMs, signal)` and lacks the new branches.

- [ ] **Step 5.3: Rewrite `deriveState` and update callers**

Replace the existing `deriveState` in `server/src/watchers/claude-code.ts:921`:

```ts
export interface DeriveStateInput {
  terminalId: string | null;
  ageMs: number;
  probeSignal: ProbeSignal;
  exitCode: number | null;
  exitSignal: string | null;
  explicitExitSeen: boolean;
  cleanProcessExit: boolean;
  lastAssistantStopReason: string | null;
}

const ACTIVE_WINDOW_MS = 60_000;
const WAITING_WINDOW_MS = 30 * 60 * 1000;
const DORMANT_THRESHOLD_MS = 8 * 60 * 60 * 1000;

export function deriveState(input: DeriveStateInput): SessionState {
  // Precedence: bad exit evidence beats any "clean" claim. A session that
  // typed /exit and then got SIGKILLed mid-shutdown should read disconnected,
  // not done.
  if (input.exitSignal || (input.exitCode != null && input.exitCode !== 0)) {
    return "disconnected";
  }
  if (input.explicitExitSeen || input.cleanProcessExit) return "done";
  if (input.terminalId) {
    return input.lastAssistantStopReason === "end_turn" ? "waiting" : "active";
  }
  if (input.ageMs < ACTIVE_WINDOW_MS) return "active";
  if (input.ageMs < WAITING_WINDOW_MS) {
    return input.probeSignal === "absent" ? "disconnected" : "waiting";
  }
  // 8h+ idle is still 'disconnected' in the persisted enum. The presentation
  // layer (sessions API) maps disconnected + age > 8h into 'dormant' for the
  // wire-format displayState field. See Task 6.
  return "disconnected";
}
```

The old `DONE_THRESHOLD_MS = 24 * 60 * 60 * 1000` constant goes away. Delete it. The `DORMANT_THRESHOLD_MS` constant is no longer needed inside `deriveState` either (it moves to the presentation layer in Task 6) — but if you keep the time-bucket constants near `deriveState` for documentation, leave it as an export.

- [ ] **Step 5.4: Update `runHeartbeatSweep` to pass the new shape**

In `runHeartbeatSweep` around `:877`, replace:
```ts
const next = deriveState(ageMs, signal);
```
with:
```ts
const next = deriveState({
  terminalId: session.terminal_id ?? null,
  ageMs,
  probeSignal: signal,
  exitCode: session.exit_code ?? null,
  exitSignal: session.exit_signal ?? null,
  explicitExitSeen: !!session.explicit_exit_seen,
  cleanProcessExit: !!session.clean_process_exit,
  lastAssistantStopReason: session.last_assistant_stop_reason ?? null,
});
```

- [ ] **Step 5.5: Run tests**

Run: `cd server && npx vitest run test/derive-state.test.ts`
Expected: PASS.

Run the broader suite to catch any caller breakage:
Run: `cd server && npx vitest run`
Expected: all green.

- [ ] **Step 5.6: Commit**

```bash
git add server/src/watchers/claude-code.ts server/test/derive-state.test.ts
git commit -m "feat(watcher): evidence-first deriveState with dormant + done-on-evidence"
```

---

## Task 6: Wire format — add `displayState` field with server-side derivation

Goal: expose a second state field on `Session` that the UI can consume for the dot. The DB-backed `state` stays as the 4-state enum (and matches what's persisted). `displayState` is computed server-side from `state + last_event_at` and adds the `'dormant'` value.

**Why two fields:** keeps the persisted state honest about what we know, and keeps the UI dumb (no client-side age math). Either field can be inspected when debugging.

**Files:**
- Modify: `shared/types.ts` — add `displayState` to the `Session` interface; introduce a `DisplayState` union including `'dormant'`.
- Modify: the server-side place where `SessionRow` → `Session` (wire) conversion happens. Most likely an exported function in `server/src/session-store.ts` (search for `rowToSession`, `toWire`, or similar). If conversion is inline in route handlers, add a centralised converter. Routes touched: list (`/api/sessions`), single (`/api/sessions/:id`), and SSE session-changed events.
- Test: new `server/test/display-state.test.ts` covering the derivation rule.

- [ ] **Step 6.1: Write failing test**

```ts
// server/test/display-state.test.ts
import { describe, it, expect } from "vitest";
import { computeDisplayState } from "../src/session-display-state.js";

const HOUR = 60 * 60 * 1000;

describe("computeDisplayState", () => {
  const now = new Date("2026-05-21T12:00:00Z").getTime();

  it("active stays active", () => {
    expect(computeDisplayState("active", new Date(now - 30_000).toISOString(), now)).toBe("active");
  });

  it("disconnected within 8h stays disconnected", () => {
    expect(computeDisplayState("disconnected", new Date(now - 4 * HOUR).toISOString(), now)).toBe("disconnected");
  });

  it("disconnected past 8h becomes dormant", () => {
    expect(computeDisplayState("disconnected", new Date(now - 9 * HOUR).toISOString(), now)).toBe("dormant");
  });

  it("done past 8h stays done (not dormant — dormant only widens disconnected)", () => {
    expect(computeDisplayState("done", new Date(now - 100 * HOUR).toISOString(), now)).toBe("done");
  });

  it("waiting past 8h stays waiting (heartbeat would have flipped it to disconnected first if process is gone)", () => {
    expect(computeDisplayState("waiting", new Date(now - 9 * HOUR).toISOString(), now)).toBe("waiting");
  });
});
```

- [ ] **Step 6.2: Run test to verify it fails**

Run: `cd server && npx vitest run test/display-state.test.ts`
Expected: FAIL — `computeDisplayState` and the module don't exist yet.

- [ ] **Step 6.3: Add the `DisplayState` union and `Session` field in `shared/types.ts`**

In `shared/types.ts`:
```ts
export type SessionState = "active" | "waiting" | "disconnected" | "done";
export type DisplayState = SessionState | "dormant";
```

Add `displayState: DisplayState;` to the `Session` interface (the wire-format type, not `SessionRow`).

Keep `server/src/session-store.ts:11` `SessionState` aligned with `shared/types.ts`. **Do NOT add `'dormant'` to the persisted/DB union.**

- [ ] **Step 6.4: Create `server/src/session-display-state.ts`**

```ts
// server/src/session-display-state.ts
import type { SessionState, DisplayState } from "@oyster/shared/types.js"; // use whatever the project's import path for shared types is

const DORMANT_THRESHOLD_MS = 8 * 60 * 60 * 1000;

/**
 * Maps the persisted state to the wire-format displayState. The only
 * difference is that 'disconnected' rows older than 8h are presented as
 * 'dormant' to dim the urgency. Other states pass through unchanged.
 */
export function computeDisplayState(
  state: SessionState,
  lastEventAt: string,
  now: number = Date.now(),
): DisplayState {
  if (state !== "disconnected") return state;
  const ts = Date.parse(lastEventAt);
  if (!Number.isFinite(ts)) return "disconnected";
  return now - ts > DORMANT_THRESHOLD_MS ? "dormant" : "disconnected";
}
```

Adjust the shared-types import path to match the project's actual layout (e.g. `../../shared/types.js`).

- [ ] **Step 6.5: Apply `displayState` in the row→wire conversion**

Find the function that builds a wire-format `Session` from a `SessionRow`. Common spots:
- `server/src/session-store.ts` — if there's a `rowToSession` helper, use it.
- Route handlers in `server/src/index.ts` or `server/src/routes/*.ts` — if they map rows inline, factor out a helper or inline the `computeDisplayState` call.
- SSE broadcast paths — wherever a `session-changed` payload gets serialised.

Add `displayState: computeDisplayState(row.state, row.last_event_at)` to the wire object. Make sure every route that returns Session objects gets it (list, get, search, SSE).

- [ ] **Step 6.6: Run the new test + full suite**

Run: `cd server && npx vitest run test/display-state.test.ts`
Expected: PASS.

Run: `cd server && npx vitest run`
Expected: all pre-existing tests still pass.

Run: `cd server && npx tsc --noEmit && cd ../web && npx tsc --noEmit`
Expected: type-clean. The web side will get errors only after Task 7 starts consuming `displayState` — pure type errors here mean the union was wired wrong.

- [ ] **Step 6.7: Commit**

```bash
git add shared/types.ts server/src/session-display-state.ts server/test/display-state.test.ts server/src/session-store.ts server/src/index.ts
git commit -m "feat(api): expose displayState (state + 'dormant') derived from state + last_event_at"
```
(Adjust the file list to match what you actually touched in 6.5.)

---

## Task 7: Web UI — dot palette per session type + dormant state

Goal: match the agreed palette.

| Session type   | State             | Dot                             |
| -------------- | ----------------- | ------------------------------- |
| Oyster-managed | active            | solid purple                    |
| Oyster-managed | waiting           | amber fill with purple ring     |
| Unmanaged      | active            | solid green                     |
| Unmanaged      | waiting           | solid amber                     |
| Either         | disconnected      | solid red                       |
| Either         | done              | solid grey                      |
| Either         | dormant           | solid grey                      |

**Files:**
- Modify: `web/src/components/Home/utils.tsx:54` (`stateColor`).
- Modify: `web/src/components/Home/SessionRow.tsx:42-44` (the `statusDotClass` selection).
- Modify: `web/src/components/Home/index.tsx:311-339` (chip counts).
- Modify: the stylesheet defining `.rd--*` classes (search `rd--running` to find the file). Add `.rd--managed-waiting`.

- [ ] **Step 7.1: Update `stateColor` to accept `DisplayState`**

In `web/src/components/Home/utils.tsx:54`, extend the function (importing `DisplayState` from shared types):
```ts
export function stateColor(state: DisplayState): "green" | "amber" | "red" | "dim" {
  switch (state) {
    case "active": return "green";
    case "waiting": return "amber";
    case "disconnected": return "red";
    case "done":
    case "dormant":
      return "dim";
  }
}
```

(`dormant` shares the dim/grey colour with `done`.)

- [ ] **Step 7.2: Update `SessionRow` to drive the dot from `displayState`**

In `web/src/components/Home/SessionRow.tsx:42-44`, replace:
```ts
const statusDotClass = livePresence
  ? (livePresence.state === "attached" ? "rd--attached" : "rd--running")
  : session.state;
```
with:
```ts
const statusDotClass = livePresence
  ? (session.displayState === "waiting"
      ? "rd--managed-waiting"
      : (livePresence.state === "attached" ? "rd--attached" : "rd--running"))
  : session.displayState;
```

This keeps the existing purple-when-managed behaviour, except when `displayState === "waiting"` we use the new composite class. Falling back to `displayState` (which can be `dormant`) gives us the dimmed dot for stale rows automatically.

- [ ] **Step 7.3: Add `.rd--managed-waiting` styles**

Find the stylesheet that defines `.rd--running` (likely `web/src/components/Home/SessionRow.module.css` or a global CSS file — `grep -r "rd--running" web/src`). Add a sibling rule:
```css
.rd--managed-waiting {
  /* amber fill, purple ring */
  background: var(--rd-waiting-fill, #f59e0b);
  box-shadow: 0 0 0 2px var(--rd-managed-ring, #a78bfa);
}
```

Use the same CSS variables the existing dots use — `grep` for the existing fill/ring tokens to match the project's design tokens.

- [ ] **Step 7.4: Add `dormant` to chip counts (counting `displayState`, not `state`)**

In `web/src/components/Home/index.tsx:311-317`, update the `counts` initialisation:
```ts
const counts = { live: 0, active: 0, waiting: 0, disconnected: 0, done: 0, dormant: 0, all: 0 };
```

Change the iteration to bucket by `s.displayState` (not `s.state`). Remove the `counts.done += counts.disconnected` folding line — `disconnected` is now a first-class state we want to surface.

If the existing UI renders a "done" chip, render it as `done + dormant` (since both are grey and "nothing to do"). Decide based on the existing chip layout — most likely a single grey chip labelled "done" that totals both. Leave the underlying counts separate so we can split later.

- [ ] **Step 7.5: Visual smoke test**

Run the dev server (`npm run dev`), open `http://localhost:7337`, and confirm:
- A live Oyster-managed session shows a solid purple dot.
- A live Oyster-managed session whose last event was `end_turn` shows the amber-fill + purple-ring composite dot.
- An unmanaged session with recent JSONL activity shows a solid green dot.
- An old session (>8h idle, no clean exit) shows a solid grey dot.
- A session that exited via `/exit` shows a solid grey dot.
- A session whose PTY exited non-zero shows a solid red dot.

If you can't surface all six states naturally (some need time to ripen), temporarily UPDATE rows in `~/Oyster/db/oyster.db` to force-set states and reload. Revert manual edits afterwards.

- [ ] **Step 7.6: Commit**

```bash
git add web/src
git commit -m "feat(web): managed vs unmanaged dot palette + dormant state"
```

---

## Task 8: Changelog

**Files:**
- Modify: `CHANGELOG.md` (Unreleased section).

- [ ] **Step 8.1: Add Changelog entry**

Under `## [Unreleased]` → `### Changed`, add:
```markdown
- **Clearer session status dots.** Oyster-owned sessions stay purple when active; the dot picks up an amber centre when the agent is awaiting your input. Externally observed sessions show green when active and amber when idle. Red means the session appears disconnected or ended badly; grey "dormant" means it has been quiet long enough that the urgency has decayed. A session is only marked truly "done" when a clean `/exit` (or a clean PTY shutdown) is observed.
```

Refresh the docs page:
Run: `npm run build:changelog`
Expected: regenerates `docs/changelog.html` with the new entry.

- [ ] **Step 8.2: Commit**

```bash
git add CHANGELOG.md docs/changelog.html
git commit -m "docs(changelog): session status palette + dormant state"
```

---

## Verification gate (before merging)

- [ ] `cd server && npx vitest run` — all green.
- [ ] `cd web && npx tsc --noEmit` — no type errors.
- [ ] `npm run build` — completes cleanly.
- [ ] Manual visual check in the dev server confirms all six dot states.
- [ ] CHANGELOG.md Unreleased entry present; `docs/changelog.html` regenerated.

---

## What we intentionally did NOT do

- **No PTY-tee tool-permission prompt detection.** `end_turn` is the only "waiting on user" signal for v1. Tool-permission dialogs (Allow Bash? y/n) will still show as `active` while the agent is technically blocked. Acceptable for v1; revisit if it becomes confusing.
- **No backfill of `exit_code` for historical sessions.** Old rows keep `NULL`; `deriveState` falls through to the time-based path for them, which is the same behaviour they had before.
- **No new chip layout.** `dormant` counts toward the existing "done" chip for now (both grey). A separate dormant chip is a UX call to make later, not part of this change.
- **No cross-device fixes.** Cross-device session metadata still depends on whatever the origin device's watcher wrote — unchanged here.
