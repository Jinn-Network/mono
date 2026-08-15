import { describe, expect, test, vi } from "vitest";

import {
  DEFAULT_RETRIEVAL_HARD_LIMITS,
  assertBoundedJson,
  createOperationContext,
  mapBounded,
  validateQueryBounds,
} from "./operation.js";

describe("retrieval operation bounds", () => {
  test("clamps caller limits to host hard ceilings", () => {
    const context = createOperationContext(
      { ...DEFAULT_RETRIEVAL_HARD_LIMITS, maxRecordBytes: 10 },
      { timeoutMs: 60_000, maxRecordBytes: 100 },
    );
    expect(context.timeoutMs).toBe(DEFAULT_RETRIEVAL_HARD_LIMITS.timeoutMs);
    expect(context.maxRecordBytes).toBe(10);
    context.dispose();
  });

  test("rejects invalid query work before calling a provider", () => {
    expect(() => validateQueryBounds(0, 10, DEFAULT_RETRIEVAL_HARD_LIMITS))
      .toThrowError(/resultLimit/);
    expect(() => validateQueryBounds(2, 1, DEFAULT_RETRIEVAL_HARD_LIMITS))
      .toThrowError(/candidateBudget/);
  });

  test("aborts work at the deadline", async () => {
    vi.useFakeTimers();
    const context = createOperationContext(
      DEFAULT_RETRIEVAL_HARD_LIMITS,
      { timeoutMs: 25 },
    );
    const observed = new Promise<void>((resolve) => {
      context.signal.addEventListener("abort", () => resolve(), { once: true });
    });
    await vi.advanceTimersByTimeAsync(25);
    await observed;
    expect(context.timedOut()).toBe(true);
    context.dispose();
    vi.useRealTimers();
  });

  test("never exceeds the requested concurrency", async () => {
    let active = 0;
    let maximum = 0;
    const values = await mapBounded([1, 2, 3, 4], 2, async (value) => {
      active += 1;
      maximum = Math.max(maximum, active);
      await Promise.resolve();
      active -= 1;
      return value * 2;
    });
    expect(maximum).toBe(2);
    expect(values).toEqual([2, 4, 6, 8]);
  });

  test("bounds provider-owned JSON by encoded bytes", () => {
    expect(() => assertBoundedJson({ snippet: "1234" }, 4, "provider metadata"))
      .toThrowError(/provider metadata/);
  });

  test("accounts for record and artifact bytes across the whole operation", () => {
    const context = createOperationContext({
      ...DEFAULT_RETRIEVAL_HARD_LIMITS,
      maxTotalRecordBytes: 10,
      maxTotalArtifactBytes: 10,
    });
    expect(context.consumeRecordBytes(6)).toBe(true);
    expect(context.consumeRecordBytes(5)).toBe(false);
    expect(context.recordBytesConsumed()).toBe(6);
    expect(context.consumeArtifactBytes(10)).toBe(true);
    expect(context.consumeArtifactBytes(1)).toBe(false);
    context.dispose();
  });
});
