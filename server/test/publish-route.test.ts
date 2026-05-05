import { describe, it, expect, vi } from "vitest";
import { tryHandlePublishRoute } from "../src/routes/publish.js";

function fakeReqRes(method: "POST" | "DELETE", body: any = {}) {
  const captured: { status?: number; json?: any } = {};
  const ctx = {
    sendJson: (j: any, s = 200) => { captured.json = j; captured.status = s; },
    rejectIfNonLocalOrigin: () => false,
    readJsonBody: async () => body,
  };
  const req = { method } as any;
  const res = {} as any;
  return { req, res, ctx, captured };
}

describe("routes/publish — SSE broadcast", () => {
  it("broadcasts artifact_changed after a successful POST", async () => {
    const broadcast = vi.fn();
    const publishService = {
      publishArtifact: vi.fn().mockResolvedValue({
        share_token: "tok", share_url: "https://share.oyster.to/p/tok",
        mode: "open", published_at: 1, updated_at: 1,
      }),
      unpublishArtifact: vi.fn(),
    };
    const { req, res, ctx } = fakeReqRes("POST", { mode: "open" });
    const handled = await tryHandlePublishRoute(req, res,
      "/api/artifacts/art_1/publish", ctx as any, {
        publishService: publishService as any,
        broadcastUiEvent: broadcast,
      });
    expect(handled).toBe(true);
    expect(broadcast).toHaveBeenCalledWith({
      version: 1, command: "artifact_changed", payload: { id: "art_1" },
    });
  });

  it("broadcasts artifact_changed after a successful DELETE", async () => {
    const broadcast = vi.fn();
    const publishService = {
      publishArtifact: vi.fn(),
      unpublishArtifact: vi.fn().mockResolvedValue({
        ok: true, share_token: "tok", unpublished_at: 99,
      }),
    };
    const { req, res, ctx } = fakeReqRes("DELETE");
    await tryHandlePublishRoute(req, res,
      "/api/artifacts/art_1/publish", ctx as any, {
        publishService: publishService as any,
        broadcastUiEvent: broadcast,
      });
    expect(broadcast).toHaveBeenCalledWith({
      version: 1, command: "artifact_changed", payload: { id: "art_1" },
    });
  });

  it("does NOT broadcast on a failed publish", async () => {
    const broadcast = vi.fn();
    const publishService = {
      publishArtifact: vi.fn().mockRejectedValue(
        Object.assign(new Error("nope"), { status: 401, code: "sign_in_required", details: {} })
      ),
      unpublishArtifact: vi.fn(),
    };
    const { req, res, ctx } = fakeReqRes("POST", { mode: "open" });
    await tryHandlePublishRoute(req, res,
      "/api/artifacts/art_1/publish", ctx as any, {
        publishService: publishService as any,
        broadcastUiEvent: broadcast,
      });
    expect(broadcast).not.toHaveBeenCalled();
  });
});
