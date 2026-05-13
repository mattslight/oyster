// Unit tests for the offline-log helpers. The user dogfooding behaviour:
// "[memory] pull failed: TypeError: fetch failed ... ENOTFOUND cloud.oyster.to"
// repeated every ~30s for hours after wifi disconnected.
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  createOfflineLogger,
  formatSyncError,
  isOfflineLikeError,
} from "../src/sync-log.js";

describe("formatSyncError edge cases", () => {
  it("treats only null/undefined as 'unknown error'; falsy primitives stringify normally", () => {
    expect(formatSyncError(null)).toBe("unknown error");
    expect(formatSyncError(undefined)).toBe("unknown error");
    // throw 0 / throw false / throw "" are unusual but legal — preserve them.
    expect(formatSyncError(0)).toBe("0");
    expect(formatSyncError(false)).toBe("false");
    expect(formatSyncError("")).toBe("");
  });
});

describe("formatSyncError", () => {
  it("recognises ENOTFOUND (wifi off → DNS failure)", () => {
    const err = new TypeError("fetch failed");
    (err as { cause?: unknown }).cause = { code: "ENOTFOUND" };
    expect(formatSyncError(err)).toBe("cloud unreachable (ENOTFOUND)");
  });

  it("recognises undici connect-timeout (intermittent wifi)", () => {
    const err = new TypeError("fetch failed");
    (err as { cause?: unknown }).cause = { code: "UND_ERR_CONNECT_TIMEOUT" };
    expect(formatSyncError(err)).toBe("cloud unreachable (UND_ERR_CONNECT_TIMEOUT)");
  });

  it("falls through to the err.message + cause.message for non-network errors", () => {
    const err = new Error("worker barfed");
    (err as { cause?: unknown }).cause = { code: "SOMETHING_ELSE", message: "details" };
    expect(formatSyncError(err)).toBe("worker barfed: details");
  });

  it("falls through to err.message when no cause", () => {
    expect(formatSyncError(new Error("plain"))).toBe("plain");
  });

  it("handles non-Error throwables", () => {
    expect(formatSyncError("just a string")).toBe("just a string");
    expect(formatSyncError(null)).toBe("unknown error");
  });

  it("respects top-level code (no cause)", () => {
    const err = new Error("connect timeout");
    (err as { code?: unknown }).code = "UND_ERR_CONNECT_TIMEOUT";
    expect(formatSyncError(err)).toBe("cloud unreachable (UND_ERR_CONNECT_TIMEOUT)");
  });
});

describe("isOfflineLikeError", () => {
  it("true for ENOTFOUND nested in cause", () => {
    const err = new TypeError("fetch failed");
    (err as { cause?: unknown }).cause = { code: "ENOTFOUND" };
    expect(isOfflineLikeError(err)).toBe(true);
  });
  it("false for other error codes", () => {
    const err = new Error("oops");
    (err as { code?: unknown }).code = "SOMETHING_ELSE";
    expect(isOfflineLikeError(err)).toBe(false);
  });
  it("false on bare Error with no code", () => {
    expect(isOfflineLikeError(new Error("nope"))).toBe(false);
  });
});

describe("createOfflineLogger", () => {
  const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  afterEach(() => {
    warnSpy.mockClear();
  });
  // Restore so a global spy doesn't leak into other test files and silently
  // suppress their logs.
  afterAll(() => {
    warnSpy.mockRestore();
  });

  function offlineErr(code = "ENOTFOUND"): unknown {
    const err = new TypeError("fetch failed");
    (err as { cause?: unknown }).cause = { code };
    return err;
  }

  it("logs once on first failure, suppresses identical follow-ups", () => {
    const log = createOfflineLogger("[test]", { heartbeatEvery: 30 });
    log.failure(offlineErr());
    log.failure(offlineErr());
    log.failure(offlineErr());
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]![0]).toContain("cloud unreachable (ENOTFOUND)");
    expect(warnSpy.mock.calls[0]![0]).toContain("further offline retries suppressed");
  });

  it("logs a heartbeat every Nth failure", () => {
    const log = createOfflineLogger("[test]", { heartbeatEvery: 5 });
    for (let i = 0; i < 12; i++) log.failure(offlineErr());
    // Calls: #1 (first), #5 (heartbeat), #10 (heartbeat) = 3 total.
    expect(warnSpy).toHaveBeenCalledTimes(3);
    expect(warnSpy.mock.calls[1]![0]).toContain("still offline (5 attempts)");
    expect(warnSpy.mock.calls[2]![0]).toContain("still offline (10 attempts)");
  });

  it("logs 'back online' on first success after failures, then no-ops", () => {
    const log = createOfflineLogger("[test]", { heartbeatEvery: 30 });
    log.failure(offlineErr());
    log.failure(offlineErr());
    warnSpy.mockClear();
    log.success();
    log.success(); // second success: no extra log
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]![0]).toContain("back online (after 2 failed attempts)");
  });

  it("singular 'attempt' wording when streak is exactly 1", () => {
    const log = createOfflineLogger("[test]");
    log.failure(offlineErr());
    warnSpy.mockClear();
    log.success();
    expect(warnSpy.mock.calls[0]![0]).toContain("back online (after 1 failed attempt)");
  });

  it("non-offline errors are logged in full and don't perturb the counter", () => {
    const log = createOfflineLogger("[test]", { heartbeatEvery: 5 });
    log.failure(offlineErr());      // streak=1, logged
    log.failure(new Error("real bug")); // not offline → logged in full
    log.failure(offlineErr());      // streak=2, suppressed
    log.failure(offlineErr());      // streak=3, suppressed
    log.failure(offlineErr());      // streak=4, suppressed
    log.failure(offlineErr());      // streak=5, heartbeat
    // first offline + non-offline + heartbeat = 3 lines
    expect(warnSpy).toHaveBeenCalledTimes(3);
    expect(warnSpy.mock.calls[0]![0]).toContain("cloud unreachable");
    expect(warnSpy.mock.calls[1]![0]).toBe("[test] failed:");
    expect(warnSpy.mock.calls[2]![0]).toContain("still offline (5 attempts)");
  });

  it("context arg disambiguates the first-occurrence line and non-offline errors", () => {
    const log = createOfflineLogger("[test]");
    log.failure(offlineErr(), "session=abc12345 chunk=2");
    log.failure(new Error("real bug"), "session=abc12345 chunk=3");
    // First occurrence includes context.
    expect(warnSpy.mock.calls[0]![0]).toContain("session=abc12345 chunk=2");
    expect(warnSpy.mock.calls[0]![0]).toContain("cloud unreachable");
    // Non-offline error log also includes context.
    expect(warnSpy.mock.calls[1]![0]).toContain("session=abc12345 chunk=3");
    expect(warnSpy.mock.calls[1]![0]).toContain("failed:");
  });

  it("context is omitted from the heartbeat line (would be misleading across multiple resources)", () => {
    const log = createOfflineLogger("[test]", { heartbeatEvery: 3 });
    log.failure(offlineErr(), "session=aaa");
    log.failure(offlineErr(), "session=bbb");
    log.failure(offlineErr(), "session=ccc"); // heartbeat
    expect(warnSpy.mock.calls[1]![0]).toContain("still offline (3 attempts)");
    expect(warnSpy.mock.calls[1]![0]).not.toContain("session=");
  });

  it("invalid heartbeatEvery values (0, negative, NaN, Infinity) fall back to the default", () => {
    // Without the clamp, modulo 0 is NaN (never true) → heartbeats silenced
    // forever. Each of these should still produce a heartbeat at default 30.
    for (const bad of [0, -5, NaN, Infinity]) {
      warnSpy.mockClear();
      const log = createOfflineLogger("[test]", { heartbeatEvery: bad });
      for (let i = 0; i < 30; i++) log.failure(offlineErr());
      // 1 first-failure log + 1 heartbeat at 30 = 2 calls
      expect(warnSpy).toHaveBeenCalledTimes(2);
      expect(warnSpy.mock.calls[1]![0]).toContain("still offline (30 attempts)");
    }
  });
});
