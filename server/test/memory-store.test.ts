import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteFtsMemoryProvider } from "../src/memory-store.js";

// SqliteFtsMemoryProvider does its own schema/migrations on init().
// We just hand it a fresh tmp dir per test.
async function makeProvider() {
  const dir = mkdtempSync(join(tmpdir(), "oyster-memory-test-"));
  const provider = new SqliteFtsMemoryProvider(dir);
  await provider.init();
  return { provider, dir };
}

describe("SqliteFtsMemoryProvider", () => {
  let provider: SqliteFtsMemoryProvider;
  let dir: string;

  beforeEach(async () => {
    ({ provider, dir } = await makeProvider());
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe("remember", () => {
    it("returns the existing row when same content + same space is remembered twice", async () => {
      const a = await provider.remember({ content: "matt likes coffee", space_id: "home" });
      const b = await provider.remember({ content: "matt likes coffee", space_id: "home" });
      expect(b.id).toBe(a.id);
    });

    it("returns the existing row when content matches and both are global (NULL space)", async () => {
      const a = await provider.remember({ content: "global fact" });
      const b = await provider.remember({ content: "global fact" });
      expect(b.id).toBe(a.id);
    });

    it("creates a new row when same content lands in different spaces", async () => {
      const a = await provider.remember({ content: "duplicate", space_id: "home" });
      const b = await provider.remember({ content: "duplicate", space_id: "work" });
      expect(b.id).not.toBe(a.id);
    });

    it("persists tags as an array", async () => {
      const m = await provider.remember({ content: "tagged", tags: ["preference", "work"] });
      expect(m.tags).toEqual(["preference", "work"]);
    });

    it("persists source_session_id when provided", async () => {
      const m = await provider.remember({ content: "from-session", source_session_id: "sess_abc" });
      const written = await provider.getBySourceSession("sess_abc");
      expect(written).toHaveLength(1);
      expect(written[0].id).toBe(m.id);
    });
  });

  describe("recall query parsing", () => {
    beforeEach(async () => {
      await provider.remember({ content: "matt likes coffee in the morning" });
      await provider.remember({ content: "the cat sat on the mat" });
      await provider.remember({ content: "secrets and passwords" });
    });

    it("returns nothing for an empty query", async () => {
      expect(await provider.recall({ query: "" })).toEqual([]);
    });

    it("returns nothing for a whitespace-only query", async () => {
      expect(await provider.recall({ query: "   " })).toEqual([]);
    });

    it("returns nothing for a single-character query (filtered as too short)", async () => {
      // tokens of length 1 are filtered in tokenisation
      expect(await provider.recall({ query: "a" })).toEqual([]);
    });

    it("matches a single multi-character token", async () => {
      const hits = await provider.recall({ query: "coffee" });
      expect(hits.map((h) => h.content)).toContain("matt likes coffee in the morning");
    });

    it("OR-joins multi-word queries — any matching token is enough", async () => {
      const hits = await provider.recall({ query: "coffee passwords" });
      const contents = hits.map((h) => h.content);
      expect(contents).toContain("matt likes coffee in the morning");
      expect(contents).toContain("secrets and passwords");
    });

    it("strips punctuation when tokenising", async () => {
      const hits = await provider.recall({ query: "coffee?!" });
      expect(hits.map((h) => h.content)).toContain("matt likes coffee in the morning");
    });

    it("respects the limit parameter", async () => {
      const hits = await provider.recall({ query: "the", limit: 1 });
      expect(hits.length).toBeLessThanOrEqual(1);
    });
  });

  describe("recall scoping and soft-delete", () => {
    it("surfaces global memories in any space-scoped query", async () => {
      await provider.remember({ content: "global rule" });
      const hits = await provider.recall({ query: "global", space_id: "home" });
      expect(hits.map((h) => h.content)).toContain("global rule");
    });

    it("excludes other-space memories from a space-scoped query", async () => {
      await provider.remember({ content: "work-only secret", space_id: "work" });
      const hits = await provider.recall({ query: "secret", space_id: "home" });
      expect(hits.map((h) => h.content)).not.toContain("work-only secret");
    });

    it("forgotten memories do not surface in subsequent recall", async () => {
      const m = await provider.remember({ content: "forget me" });
      await provider.forget(m.id);
      const hits = await provider.recall({ query: "forget" });
      expect(hits.map((h) => h.id)).not.toContain(m.id);
    });
  });

  describe("forget", () => {
    it("is a no-op for an unknown id (does not throw)", async () => {
      await expect(provider.forget("does-not-exist")).resolves.toBeUndefined();
    });
  });

  describe("R6 recall provenance", () => {
    it("getRecalledBySession returns each memory once even after multiple recalls", async () => {
      const m = await provider.remember({ content: "recall me twice" });
      await provider.recall({ query: "recall", recalling_session_id: "sess_x" });
      await provider.recall({ query: "recall", recalling_session_id: "sess_x" });
      const recalled = await provider.getRecalledBySession("sess_x");
      const ids = recalled.map((r) => r.id);
      expect(ids.filter((id) => id === m.id)).toHaveLength(1);
    });

    it("getRecalledBySession does not record recalls without a session id", async () => {
      await provider.remember({ content: "anonymous recall" });
      await provider.recall({ query: "anonymous" });
      const recalled = await provider.getRecalledBySession("sess_y");
      expect(recalled).toHaveLength(0);
    });
  });
});
