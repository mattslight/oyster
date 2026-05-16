// registerArtifact backfills session→creation links by scanning recent
// session_events for Write/Edit/Read tool_use blocks at the artefact's
// path. Closes the provenance loop for artefacts that were created via
// the raw `Write` tool (e.g. the yellow-pen-audit report) and registered
// later — the watcher's live touch-detection only fires when the artefact
// already exists in the DB at tool_use time.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { initDb } from "../src/db.js";
import { ArtifactService } from "../src/artifact-service.js";
import { SqliteArtifactStore } from "../src/artifact-store.js";

describe("ArtifactService.registerArtifact — session→creation link backfill", () => {
  let userland: string;
  let folder: string;
  let db: Database.Database;
  let service: ArtifactService;

  beforeEach(() => {
    userland = mkdtempSync(join(tmpdir(), "oyster-csb-userland-"));
    folder = mkdtempSync(join(tmpdir(), "oyster-csb-folder-"));
    db = initDb(userland);
    db.exec(`INSERT INTO spaces (id, display_name, color, scan_status) VALUES ('work', 'Work', '#000', 'none')`);
    db.prepare("INSERT INTO sessions (id, agent, state, space_id) VALUES (?, 'claude-code', 'done', 'work')").run("sess-1");
    service = new ArtifactService(db, new SqliteArtifactStore(db), "https://oyster.to", "https://share.oyster.to", userland);
  });

  afterEach(() => {
    db.close();
    rmSync(userland, { recursive: true, force: true });
    rmSync(folder, { recursive: true, force: true });
  });

  function recordWriteEvent(sessionId: string, filePath: string) {
    const raw = JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "tool_use", name: "Write", input: { file_path: filePath } }],
      },
    });
    db.prepare(
      "INSERT INTO session_events (session_id, role, text, raw) VALUES (?, 'assistant', '', ?)",
    ).run(sessionId, raw);
  }

  it("backfills a `create` link when a session wrote to this file before the artefact was registered", async () => {
    const filePath = join(folder, "report.md");
    writeFileSync(filePath, "ok");
    recordWriteEvent("sess-1", filePath);

    const art = await service.registerArtifact(
      { path: filePath, space_id: "work", label: "report" },
      [folder],
    );

    const link = db.prepare(
      "SELECT session_id, role FROM session_artifacts WHERE artifact_id = ?",
    ).get(art.id) as { session_id: string; role: string };
    expect(link).toEqual({ session_id: "sess-1", role: "create" });
  });

  it("does not duplicate links when register is called a second time (resurrect path skips backfill)", async () => {
    const filePath = join(folder, "x.md");
    writeFileSync(filePath, "ok");
    recordWriteEvent("sess-1", filePath);

    // First call: inserts + backfills → 1 link.
    const art = await service.registerArtifact({ path: filePath, space_id: "work", label: "x", id: "fixed-id" }, [folder]);
    expect((db.prepare("SELECT COUNT(*) AS c FROM session_artifacts WHERE artifact_id = ?").get(art.id) as { c: number }).c).toBe(1);

    // Soft-delete + re-register: hits the resurrect branch (existing
    // row with removed_at set). That branch must NOT re-run the
    // backfill — the original link is still there, so adding another
    // would produce a duplicate touch.
    db.prepare("UPDATE artifacts SET removed_at = datetime('now') WHERE id = ?").run("fixed-id");
    await service.registerArtifact({ path: filePath, space_id: "work", label: "x", id: "fixed-id" }, [folder]);
    expect((db.prepare("SELECT COUNT(*) AS c FROM session_artifacts WHERE artifact_id = ?").get(art.id) as { c: number }).c).toBe(1);
  });

  it("backfills from role='tool' events too (the watcher stores pure tool-call turns as role='tool')", async () => {
    const filePath = join(folder, "tool-only.md");
    writeFileSync(filePath, "ok");
    // No prose text — a pure tool-call assistant turn that the watcher
    // would store as role='tool' rather than 'assistant'.
    db.prepare("INSERT INTO session_events (session_id, role, text, raw) VALUES ('sess-1', 'tool', '[Write]', ?)").run(
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Write", input: { file_path: filePath } }] } }),
    );

    const art = await service.registerArtifact({ path: filePath, space_id: "work", label: "tool" }, [folder]);

    const link = db.prepare("SELECT session_id, role FROM session_artifacts WHERE artifact_id = ?").get(art.id) as { session_id: string; role: string };
    expect(link).toEqual({ session_id: "sess-1", role: "create" });
  });

  it("doesn't false-match when the file path contains LIKE wildcards (`%`, `_`)", async () => {
    // A real folder with an underscore in the name. Without instr-based
    // matching (or escape on LIKE), `_` would wildcard a single char and
    // the backfill could match an unrelated event.
    const wildPath = join(folder, "report_v1.md");
    writeFileSync(wildPath, "ok");
    // Event mentions a DIFFERENT file whose path matches the LIKE
    // pattern `report_v1.md` if `_` is wildcarded: `reportXv1.md`.
    // The raw JSON contains "reportXv1.md" — would match `%report_v1%`
    // under naive LIKE.
    db.prepare("INSERT INTO session_events (session_id, role, text, raw) VALUES ('sess-1', 'assistant', '', ?)").run(
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Write", input: { file_path: join(folder, "reportXv1.md") } }] } }),
    );

    const art = await service.registerArtifact({ path: wildPath, space_id: "work", label: "wild" }, [folder]);

    // No false match — the event mentions reportXv1.md, not report_v1.md.
    const count = db.prepare("SELECT COUNT(*) AS c FROM session_artifacts WHERE artifact_id = ?").get(art.id) as { c: number };
    expect(count.c).toBe(0);
  });

  it("does nothing when no recent session_events mention this path", async () => {
    const filePath = join(folder, "untouched.md");
    writeFileSync(filePath, "ok");
    // No recordWriteEvent — no prior writes for this path.

    const art = await service.registerArtifact(
      { path: filePath, space_id: "work", label: "u" },
      [folder],
    );

    const count = db.prepare("SELECT COUNT(*) AS c FROM session_artifacts WHERE artifact_id = ?").get(art.id) as { c: number };
    expect(count.c).toBe(0);
  });

  it("backfills Edit and Read tool_uses too, with the correct role", async () => {
    const filePath = join(folder, "edited.md");
    writeFileSync(filePath, "ok");
    db.prepare("INSERT INTO sessions (id, agent, state, space_id) VALUES ('sess-2', 'claude-code', 'done', 'work')").run();
    db.prepare("INSERT INTO sessions (id, agent, state, space_id) VALUES ('sess-3', 'claude-code', 'done', 'work')").run();
    // sess-1 Wrote, sess-2 Edited, sess-3 Read
    recordWriteEvent("sess-1", filePath);
    db.prepare("INSERT INTO session_events (session_id, role, text, raw) VALUES ('sess-2', 'assistant', '', ?)").run(
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Edit", input: { file_path: filePath } }] } }),
    );
    db.prepare("INSERT INTO session_events (session_id, role, text, raw) VALUES ('sess-3', 'assistant', '', ?)").run(
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: filePath } }] } }),
    );

    const art = await service.registerArtifact({ path: filePath, space_id: "work", label: "e" }, [folder]);

    const links = db.prepare(
      "SELECT session_id, role FROM session_artifacts WHERE artifact_id = ? ORDER BY session_id",
    ).all(art.id) as Array<{ session_id: string; role: string }>;
    expect(links).toEqual([
      { session_id: "sess-1", role: "create" },
      { session_id: "sess-2", role: "modify" },
      { session_id: "sess-3", role: "read" },
    ]);
  });
});
