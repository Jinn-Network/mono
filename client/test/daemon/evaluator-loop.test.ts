import { describe, expect, it, vi } from "vitest";
import { EvaluatorLoop } from "../../src/daemon/evaluator-loop.js";

describe("EvaluatorLoop", () => {
  it("logs every terminal coordinator failure with its reason (#33)", async () => {
    const warn = vi.fn();
    const info = vi.fn();
    const composition = {
      tick: async () => ({
        sourceEvents: 0,
        coordinator: [
          { kind: "complete" as const },
          {
            kind: "failed" as const,
            reason:
              "native-subject-authority-refused: executor-settlement-binding-failed: Safe does not own ceremony signer",
          },
          { kind: "paused" as const, reason: "evaluation-evidence-not-indexed" },
        ],
      }),
    };
    const loop = new EvaluatorLoop({
      composition: composition as never,
      store: {} as never,
      pollIntervalMs: 1_000,
      logger: { info, warn },
    });

    await loop.tick();

    // The terminal failure reason is surfaced to the process log — not buried in a bare count.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain("executor-settlement-binding-failed");
    // Paused (transient) outcomes are not logged as failures.
    expect(warn.mock.calls[0]![0]).not.toContain("evidence-not-indexed");
  });
});
