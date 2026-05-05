import { describe, it, expect, vi } from "vitest";
import { tryHandlePinRoute } from "../src/routes/pin.js";

function fakeReqRes(method: "POST" | "DELETE") {
  const captured: { status?: number; json?: any } = {};
  const ctx = {
    sendJson: (j: any, s = 200) => { captured.json = j; captured.status = s; },
    sendError: (err: unknown, s = 500) => {
      captured.json = { error: (err as Error).message };
      captured.status = s;
    },
    rejectIfNonLocalOrigin: () => false,
    readJsonBody: async () => ({}),
  };
  const req = { method } as any;
  const res = {} as any;
  return { req, res, ctx, captured };
}

describe("routes/pin — SSE broadcast", () => {
  it("broadcasts artifact_changed after a successful POST", async () => {
    const broadcast = vi.fn();
    const artifactService = {
      pinArtifact: vi.fn().mockReturnValue({ id: "art_1", pinnedAt: 1717000000000 }),
      unpinArtifact: vi.fn(),
    };
    const { req, res, ctx, captured } = fakeReqRes("POST");
    const handled = await tryHandlePinRoute(req, res,
      "/api/artifacts/art_1/pin", ctx as any, {
        artifactService: artifactService as any,
        broadcastUiEvent: broadcast,
      });
    expect(handled).toBe(true);
    expect(captured.json).toEqual({ id: "art_1", pinnedAt: 1717000000000 });
    expect(broadcast).toHaveBeenCalledWith({
      version: 1, command: "artifact_changed", payload: { id: "art_1" },
    });
  });

  it("broadcasts artifact_changed after a successful DELETE", async () => {
    const broadcast = vi.fn();
    const artifactService = {
      pinArtifact: vi.fn(),
      unpinArtifact: vi.fn().mockReturnValue({ id: "art_1", pinnedAt: null }),
    };
    const { req, res, ctx, captured } = fakeReqRes("DELETE");
    await tryHandlePinRoute(req, res,
      "/api/artifacts/art_1/pin", ctx as any, {
        artifactService: artifactService as any,
        broadcastUiEvent: broadcast,
      });
    expect(captured.json).toEqual({ id: "art_1", pinnedAt: null });
    expect(broadcast).toHaveBeenCalledWith({
      version: 1, command: "artifact_changed", payload: { id: "art_1" },
    });
  });

  it("does NOT broadcast when the service throws", async () => {
    const broadcast = vi.fn();
    const artifactService = {
      pinArtifact: vi.fn().mockImplementation(() => {
        throw new Error('Artifact "art_1" is archived; restore it before pinning.');
      }),
      unpinArtifact: vi.fn(),
    };
    const { req, res, ctx, captured } = fakeReqRes("POST");
    await tryHandlePinRoute(req, res,
      "/api/artifacts/art_1/pin", ctx as any, {
        artifactService: artifactService as any,
        broadcastUiEvent: broadcast,
      });
    expect(broadcast).not.toHaveBeenCalled();
    expect(captured.json?.error).toMatch(/archived/);
  });

  it("returns false (does not handle) for non-matching paths", async () => {
    const { req, res, ctx } = fakeReqRes("POST");
    const handled = await tryHandlePinRoute(req, res,
      "/api/artifacts/art_1/publish", ctx as any, {
        artifactService: {} as any,
        broadcastUiEvent: vi.fn(),
      });
    expect(handled).toBe(false);
  });
});
