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

  it("invalid lastEventAt falls back to the raw state", () => {
    expect(computeDisplayState("disconnected", "not-a-date", now)).toBe("disconnected");
  });
});
