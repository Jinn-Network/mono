// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { armDeadline, heartbeatIsStale } from "./deadline.js";

describe("armDeadline", () => {
  it("re-arms from monotonic execution elapsed time despite a backward wall-clock jump", () => {
    const onExpire = vi.fn();
    const timer = armDeadline({ execStartedAtMonotonicMs: 1_000, maxAttemptDurationMs: 500, nowMonotonicMs: () => 1_300, setTimer: vi.fn() }, onExpire);
    expect(timer.remainingMs).toBe(200);
    expect(onExpire).not.toHaveBeenCalled();
  });

  it("expires immediately once monotonic elapsed time consumes the duration", () => {
    const onExpire = vi.fn();
    const timer = armDeadline({ execStartedAtMonotonicMs: 1_000, maxAttemptDurationMs: 500, nowMonotonicMs: () => 1_500, setTimer: vi.fn() }, onExpire);
    expect(timer.remainingMs).toBe(0);
    expect(onExpire).toHaveBeenCalledOnce();
  });
});

describe("heartbeatIsStale", () => {
  it("is observationally stale after three missed intervals", () => {
    expect(heartbeatIsStale({ lastMonotonicMs: 1_000, nowMonotonicMs: 46_000, intervalMs: 15_000 })).toBe(true);
  });
});
