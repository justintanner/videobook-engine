import { describe, it, expect } from "vitest";

import { buildLockData, isExpired } from "../src/lock/data.js";

describe("buildLockData", () => {
  it("sets created_at, timeout_at, pid, and merges custom data", () => {
    const now = 1700000000;
    const result = buildLockData(now, 42, {
      durationMs: 60_000,
      data: { task_id: "abc" },
    });

    expect(result.created_at).toBe(1700000000);
    expect(result.timeout_at).toBe(1700000060);
    expect(result.pid).toBe(42);
    expect(result.task_id).toBe("abc");
  });

  it("works without custom data", () => {
    const result = buildLockData(100, 1, { durationMs: 5000 });
    expect(result.created_at).toBe(100);
    expect(result.timeout_at).toBe(105);
    expect(result.pid).toBe(1);
  });
});

describe("isExpired", () => {
  it("returns false before timeout", () => {
    const lock = { created_at: 100, timeout_at: 200 };
    expect(isExpired(lock, 150)).toBe(false);
  });

  it("returns true at exact timeout", () => {
    const lock = { created_at: 100, timeout_at: 200 };
    expect(isExpired(lock, 200)).toBe(true);
  });

  it("returns true after timeout", () => {
    const lock = { created_at: 100, timeout_at: 200 };
    expect(isExpired(lock, 300)).toBe(true);
  });

  it("returns true for legacy locks with timeout_at: 0", () => {
    const lock = { created_at: 100, timeout_at: 0 };
    expect(isExpired(lock, 1)).toBe(true);
  });
});
