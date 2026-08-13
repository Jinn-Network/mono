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
    const failures = warn.mock.calls.map(([line]) => line as string)
      .filter((line) => line.includes("evaluation failed"));
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("executor-settlement-binding-failed");
    // A pause is reported as a pause, never as a terminal failure.
    expect(failures[0]).not.toContain("evidence-not-indexed");
  });

  it("logs a pause with its reason so a durable stall is readable in the daemon log (#46)", async () => {
    const warn = vi.fn();
    const composition = {
      tick: async () => ({
        sourceEvents: 0,
        coordinator: [
          // Defect #46's live shape: the verdict graph's records collided on the signed source head
          // and the evaluation paused every tick, yet `SourceWriterIntegrityError` appeared ZERO
          // times in the daemon log — the reason lived only in `native_evaluation_audit`.
          {
            kind: "paused" as const,
            reason: "evaluator-dependency-failed: SourceWriterIntegrityError: announcement timestamp must strictly advance the signed source head",
          },
          // The quiescent "backoff has not elapsed" answer names no cause and fires every tick of a
          // scheduled retry, so it stays out of the log.
          { kind: "paused" as const, reason: "retry-not-due" },
        ],
      }),
    };
    const loop = new EvaluatorLoop({
      composition: composition as never,
      store: {} as never,
      pollIntervalMs: 1_000,
      logger: { info: vi.fn(), warn },
    });

    await loop.tick();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain("evaluation paused");
    expect(warn.mock.calls[0]![0]).toContain("SourceWriterIntegrityError");
    expect(warn.mock.calls[0]![0]).toContain("strictly advance the signed source head");
  });
});
