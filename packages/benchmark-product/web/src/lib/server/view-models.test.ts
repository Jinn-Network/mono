import { describe, expect, test } from "vitest";
import type { ProductErrorCode, RunStatusResult } from "@jinn-network/benchmark-product-core";
import { projectRunStatusForGui } from "./view-models";

function failedStatus(code: ProductErrorCode, detail: string): RunStatusResult {
  return {
    state: "running",
    cancelRequested: false,
    driver: {
      operation: "launch",
      generation: "generation-1",
      startedAt: "2026-08-07T00:00:00.000Z",
      completedAt: "2026-08-07T00:00:01.000Z",
      status: "failed",
      error: { code, detail },
    },
    cells: [],
    counts: { expected: 0, dispatched: 0, delivered: 0, judged: 0, failed: 0 },
  };
}

describe("run monitor GUI trust boundary", () => {
  test.each(["execution", "venue-unavailable"] as const)(
    "redacts a durable %s detail while retaining its typed code",
    (code) => {
      const sentinel = "/private/workspace/report-signing-key-VERY_SECRET.pem";
      const projected = projectRunStatusForGui(failedStatus(code, sentinel));
      expect(projected.driver?.error?.code).toBe(code);
      expect(projected.driver?.error?.detail).toContain("server logs");
      expect(JSON.stringify(projected)).not.toContain(sentinel);
      expect(JSON.stringify(projected)).not.toContain("VERY_SECRET");
    },
  );
});
