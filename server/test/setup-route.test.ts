import { describe, it, expect, vi } from "vitest";
import { tryHandleSetupRoute } from "../src/routes/setup.js";

function fakeReqRes(method: "POST" | "GET", body: unknown = {}) {
  const captured: { status?: number; json?: unknown } = {};
  const ctx = {
    sendJson: (j: unknown, s = 200) => {
      captured.json = j;
      captured.status = s;
    },
    sendError: (s: number, msg: string) => {
      captured.status = s;
      captured.json = { error: msg };
    },
    rejectIfNonLocalOrigin: () => false,
    readJsonBody: async () => body,
  };
  const req = { method } as { method: string };
  const res = {};
  return { req, res, ctx, captured };
}

function makeSpaceService() {
  const created: Record<string, { id: string; name: string }> = {};
  return {
    getSpace: vi.fn((id: string) => created[id]),
    createSpace: vi.fn(({ name }: { name: string }) => {
      const id = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
      const space = { id, name };
      created[id] = space;
      return space;
    }),
    addSource: vi.fn(),
    scanSpace: vi.fn().mockResolvedValue({}),
    _created: created,
  };
}

describe("routes/setup — apply", () => {
  it("returns 404-shaped false when method/url doesn't match", async () => {
    const broadcast = vi.fn();
    const service = makeSpaceService();
    const { req, res, ctx } = fakeReqRes("GET");
    const handled = await tryHandleSetupRoute(
      req as never, res as never,
      "/api/setup/apply", ctx as never,
      { spaceService: service as never, broadcastUiEvent: broadcast },
    );
    expect(handled).toBe(false);
  });

  it("rejects an empty plan with 400", async () => {
    const broadcast = vi.fn();
    const service = makeSpaceService();
    const { req, res, ctx, captured } = fakeReqRes("POST", { spaces: [] });
    const handled = await tryHandleSetupRoute(
      req as never, res as never,
      "/api/setup/apply", ctx as never,
      { spaceService: service as never, broadcastUiEvent: broadcast },
    );
    expect(handled).toBe(true);
    expect(captured.status).toBe(400);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("rejects malformed body (non-string path)", async () => {
    const broadcast = vi.fn();
    const service = makeSpaceService();
    const { req, res, ctx, captured } = fakeReqRes("POST", {
      spaces: [{ name: "ok", paths: [42] }],
    });
    const handled = await tryHandleSetupRoute(
      req as never, res as never,
      "/api/setup/apply", ctx as never,
      { spaceService: service as never, broadcastUiEvent: broadcast },
    );
    expect(handled).toBe(true);
    expect(captured.status).toBe(400);
  });

  it("creates spaces and attaches paths on the happy path", async () => {
    const broadcast = vi.fn();
    const service = makeSpaceService();
    const { req, res, ctx, captured } = fakeReqRes("POST", {
      proposalId: "p123",
      spaces: [
        { name: "oyster", paths: ["/abs/oyster", "/abs/oyster-os"] },
        { name: "tokinvest", paths: ["/abs/tokinvest"] },
      ],
    });
    const handled = await tryHandleSetupRoute(
      req as never, res as never,
      "/api/setup/apply", ctx as never,
      { spaceService: service as never, broadcastUiEvent: broadcast },
    );
    expect(handled).toBe(true);
    expect(captured.status).toBe(200);
    const body = captured.json as { results: Array<{ created: boolean; paths: Array<{ status: string }> }> };
    expect(body.results).toHaveLength(2);
    expect(body.results[0].created).toBe(true);
    expect(body.results[0].paths.every((p) => p.status === "attached")).toBe(true);
    expect(service.createSpace).toHaveBeenCalledTimes(2);
    expect(service.addSource).toHaveBeenCalledTimes(3);
    expect(service.scanSpace).toHaveBeenCalledTimes(2);
    expect(broadcast).toHaveBeenCalledWith({
      version: 1,
      command: "setup_applied",
      payload: { proposal_id: "p123", space_count: 2 },
    });
  });

  it("surfaces per-path failures without aborting the whole apply", async () => {
    const broadcast = vi.fn();
    const service = makeSpaceService();
    service.addSource.mockImplementation((_id: string, p: string) => {
      if (p === "/abs/missing") throw new Error("path does not exist");
    });
    const { req, res, ctx, captured } = fakeReqRes("POST", {
      spaces: [
        { name: "oyster", paths: ["/abs/oyster", "/abs/missing"] },
      ],
    });
    await tryHandleSetupRoute(
      req as never, res as never,
      "/api/setup/apply", ctx as never,
      { spaceService: service as never, broadcastUiEvent: broadcast },
    );
    const body = captured.json as { results: Array<{ paths: Array<{ status: string; error?: string }> }> };
    expect(body.results[0].paths[0].status).toBe("attached");
    expect(body.results[0].paths[1].status).toBe("failed");
    expect(body.results[0].paths[1].error).toMatch(/does not exist/);
    // Scan still runs because at least one path attached.
    expect(service.scanSpace).toHaveBeenCalledTimes(1);
  });

  it("classifies path-already-attached as owned-by-other-space", async () => {
    const broadcast = vi.fn();
    const service = makeSpaceService();
    service.addSource.mockImplementation(() => {
      throw new Error("path already attached to another space");
    });
    const { req, res, ctx, captured } = fakeReqRes("POST", {
      spaces: [{ name: "oyster", paths: ["/abs/p"] }],
    });
    await tryHandleSetupRoute(
      req as never, res as never,
      "/api/setup/apply", ctx as never,
      { spaceService: service as never, broadcastUiEvent: broadcast },
    );
    const body = captured.json as { results: Array<{ paths: Array<{ status: string }> }> };
    expect(body.results[0].paths[0].status).toBe("owned-by-other-space");
    // No paths attached → no scan.
    expect(service.scanSpace).not.toHaveBeenCalled();
  });

  it("reuses an existing space on race / extend instead of duplicating", async () => {
    const broadcast = vi.fn();
    const service = makeSpaceService();
    service.getSpace.mockReturnValueOnce({ id: "oyster", name: "oyster" });
    const { req, res, ctx, captured } = fakeReqRes("POST", {
      spaces: [{ name: "oyster", paths: ["/abs/p"] }],
    });
    await tryHandleSetupRoute(
      req as never, res as never,
      "/api/setup/apply", ctx as never,
      { spaceService: service as never, broadcastUiEvent: broadcast },
    );
    const body = captured.json as { results: Array<{ created: boolean }> };
    expect(body.results[0].created).toBe(false);
    expect(service.createSpace).not.toHaveBeenCalled();
  });
});
