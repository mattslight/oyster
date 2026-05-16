// Drives space-scoping on SqliteSessionStore.searchEvents (cmd+K type
// filter). Without scoping, an "@space alpha" filter in the spotlight
// would still surface session-event hits from other spaces. Pin the
// SQL contract here so the route can pass `space_id` through with
// confidence.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb } from "../src/db.js";
import { SqliteSessionStore } from "../src/session-store.js";

describe("SqliteSessionStore.searchEvents (space_id scoping)", () => {
  let dir: string;

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "oyster-ss-search-space-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  function setupTwoSpaces() {
    const db = initDb(dir);
    db.exec(`INSERT INTO spaces (id, display_name, color, scan_status) VALUES ('alpha', 'Alpha', '#000', 'none')`);
    db.exec(`INSERT INTO spaces (id, display_name, color, scan_status) VALUES ('beta',  'Beta',  '#111', 'none')`);

    const store = new SqliteSessionStore(db);
    store.upsertSession({
      id: "sess-alpha",
      space_id: "alpha",
      agent: "claude-code",
      state: "active",
      title: "Alpha session",
    });
    store.upsertSession({
      id: "sess-beta",
      space_id: "beta",
      agent: "claude-code",
      state: "active",
      title: "Beta session",
    });

    store.insertEvent({ session_id: "sess-alpha", role: "user", text: "please fix the auth bug" });
    store.insertEvent({ session_id: "sess-beta",  role: "user", text: "auth flow needs review" });

    return store;
  }

  it("returns only the alpha session's hit when spaceId='alpha'", () => {
    const store = setupTwoSpaces();
    const hits = store.searchEvents("auth", { spaceId: "alpha" });
    expect(hits).toHaveLength(1);
    expect(hits[0].session_id).toBe("sess-alpha");
  });

  it("returns hits from both spaces when no spaceId is given", () => {
    const store = setupTwoSpaces();
    const hits = store.searchEvents("auth");
    const sessionIds = hits.map((h) => h.session_id).sort();
    expect(sessionIds).toEqual(["sess-alpha", "sess-beta"]);
  });

  it("returns an empty array when spaceId is a nonexistent space", () => {
    const store = setupTwoSpaces();
    const hits = store.searchEvents("auth", { spaceId: "nonexistent" });
    expect(hits).toEqual([]);
  });
});
