import { describe, it, expect, vi } from "vitest";
import { tryHandleProjectsRoute } from "../src/routes/projects.js";

function fakeCtx(body: object = {}) {
  const captured: { status?: number; json?: any } = {};
  const ctx = {
    sendJson: (j: any, s = 200) => { captured.json = j; captured.status = s; },
    sendError: (err: unknown, s = 500) => {
      captured.json = { error: (err as Error).message };
      captured.status = s;
    },
    rejectIfNonLocalOrigin: () => false,
    readJsonBody: async () => body,
  };
  return { ctx, captured };
}

describe("routes/projects", () => {
  it("GET /api/projects?space_id=work returns projects for that space", async () => {
    const projectService = {
      listForSpace: vi.fn().mockReturnValue([
        { id: "p1", spaceId: "work", name: "Alpha", createdAt: "2026-01-01" },
      ]),
    };
    const { ctx, captured } = fakeCtx();

    const handled = await tryHandleProjectsRoute(
      { method: "GET" } as any, {} as any,
      "/api/projects?space_id=work",
      ctx as any,
      { projectService: projectService as any, broadcastUiEvent: vi.fn() },
    );

    expect(handled).toBe(true);
    expect(projectService.listForSpace).toHaveBeenCalledWith("work");
    expect(captured.status).toBe(200);
    expect(captured.json).toEqual([{ id: "p1", spaceId: "work", name: "Alpha", createdAt: "2026-01-01" }]);
  });

  it("POST /api/projects creates a project and broadcasts a refresh event", async () => {
    const broadcast = vi.fn();
    const projectService = {
      createProject: vi.fn().mockReturnValue({ id: "p1", spaceId: "work", name: "Proj", createdAt: "2026-01-01" }),
    };
    const { ctx, captured } = fakeCtx({ space_id: "work", name: "Proj" });

    await tryHandleProjectsRoute(
      { method: "POST" } as any, {} as any,
      "/api/projects",
      ctx as any,
      { projectService: projectService as any, broadcastUiEvent: broadcast },
    );

    expect(projectService.createProject).toHaveBeenCalledWith({ spaceId: "work", name: "Proj" });
    expect(captured.status).toBe(201);
    expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({ command: "session_changed" }));
  });

  it("POST /api/projects/:id/claim runs claimOrphan and broadcasts", async () => {
    const broadcast = vi.fn();
    const projectService = {
      claimOrphan: vi.fn().mockReturnValue({ claimed: 3 }),
    };
    const { ctx, captured } = fakeCtx({ cwd: "/foo/bar" });

    await tryHandleProjectsRoute(
      { method: "POST" } as any, {} as any,
      "/api/projects/p1/claim",
      ctx as any,
      { projectService: projectService as any, broadcastUiEvent: broadcast },
    );

    expect(projectService.claimOrphan).toHaveBeenCalledWith({ cwd: "/foo/bar", projectId: "p1" });
    expect(captured.json).toEqual({ claimed: 3 });
    expect(broadcast).toHaveBeenCalled();
  });

  it("rejects POST /api/projects with missing fields", async () => {
    const projectService = { createProject: vi.fn() };
    const { ctx, captured } = fakeCtx({ space_id: "work" }); // missing name

    await tryHandleProjectsRoute(
      { method: "POST" } as any, {} as any,
      "/api/projects",
      ctx as any,
      { projectService: projectService as any, broadcastUiEvent: vi.fn() },
    );

    expect(captured.status).toBe(400);
    expect(projectService.createProject).not.toHaveBeenCalled();
  });

  it("returns false for unmatched URLs (passes through to the next handler)", async () => {
    const { ctx } = fakeCtx();
    const handled = await tryHandleProjectsRoute(
      { method: "GET" } as any, {} as any,
      "/api/something-else",
      ctx as any,
      { projectService: {} as any, broadcastUiEvent: vi.fn() },
    );
    expect(handled).toBe(false);
  });
});
