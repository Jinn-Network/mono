import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskExecutionBackend } from "@jinn-network/task-execution-backend";
import { describe, expect, test, vi } from "vitest";
import { drainOrCancel, requestCancellationAndDrain } from "./cancellation.js";
import { LiveHostJournal } from "./journal.js";

const CAMPAIGN = `sha256:${"1".repeat(64)}`;
const PLAN = `sha256:${"2".repeat(64)}`;
const SPLIT = `sha256:${"3".repeat(64)}`;
const RUN = `sha256:${"4".repeat(64)}`;
const TUPLE = `sha256:${"5".repeat(64)}`;
const AT = "2026-08-05T12:00:00Z";

function snapshot(attempt: string, state: "running" | "cancelled") {
  return {
    descriptor: {
      attempt,
      derived: { terminal: state === "cancelled", state, contradictory: false },
    },
  };
}

function backend(attempt: string): TaskExecutionBackend {
  return {
    recover: vi.fn(async () => ({ classification: "matching" })),
    observe: vi.fn(async () => snapshot(attempt, "running")),
  } as unknown as TaskExecutionBackend;
}

describe("live host cancellation", () => {
  test("persists CANCELLING, forbids dispatch, and drains every role with a fresh wait context", async () => {
    const root = mkdtempSync(join(tmpdir(), "jinn-cancellation-"));
    const journal = new LiveHostJournal(root, CAMPAIGN, "urn:jinn:journal-author");
    const solverAttempt = "urn:uuid:11111111-1111-5111-8111-111111111111";
    const evaluatorAttempt = "urn:uuid:22222222-2222-5222-8222-222222222222";
    const solver = backend(solverAttempt);
    const evaluator = backend(evaluatorAttempt);
    let waitContexts = 0;
    await journal.transact(async (transaction) => {
      transaction.append({
        type: "plan-recorded", recordedAt: AT,
        payload: { planDigest: PLAN, splitManifestDigest: SPLIT },
      });
      transaction.append({
        type: "run-recorded", recordedAt: AT,
        payload: {
          runDigest: RUN, kind: "development",
          arms: [{ armId: "current", tupleDigest: TUPLE }],
        },
      });
      for (const [index, role, attempt] of [
        [1, "solver", solverAttempt],
        [2, "evaluator", evaluatorAttempt],
      ] as const) {
        const cellKey = `${"a".repeat(64)}/current/${index}`;
        const bindingDigest = `sha256:${String(index).repeat(64)}`;
        transaction.append({
          type: "submission-prepared", recordedAt: AT,
          payload: { runDigest: RUN, cellKey, armId: "current", dispatch: 1, role, bindingDigest },
        });
        transaction.append({
          type: "submission-accepted", recordedAt: AT,
          payload: {
            runDigest: RUN, cellKey, armId: "current", dispatch: 1, role, bindingDigest,
            submission: `urn:uuid:33333333-3333-5333-8333-33333333333${index}`,
            attempt,
          },
        });
      }

      await requestCancellationAndDrain({
        transaction,
        backends: { solver, evaluator },
        waitContexts: {
          create: () => {
            waitContexts += 1;
            return {
              waitUntilTerminal: vi.fn(async ({ attempt }) => snapshot(attempt, "cancelled")),
            } as never;
          },
        },
        recordedAt: AT,
        reasonCode: "operator-request",
        closeAt: "2026-08-05T13:00:00Z",
        terminalEvidenceDigest: ({ role }) =>
          `sha256:${role === "solver" ? "6".repeat(64) : "7".repeat(64)}`,
      });
      expect(transaction.state.phase).toBe("CANCELLING");
      expect(transaction.state.activeAttempts.size).toBe(0);
      expect(waitContexts).toBe(2);
      expect(() => transaction.append({
        type: "submission-prepared", recordedAt: AT,
        payload: {
          runDigest: RUN,
          cellKey: `${"b".repeat(64)}/current/3`,
          armId: "current",
          dispatch: 1,
          role: "solver",
          bindingDigest: `sha256:${"8".repeat(64)}`,
        },
      })).toThrow(/new dispatch/u);
    });
  });

  test("an abort persists cancellation and drains with a context that does not inherit it", async () => {
    const root = mkdtempSync(join(tmpdir(), "jinn-cancellation-signal-"));
    const journal = new LiveHostJournal(root, CAMPAIGN, "urn:jinn:journal-author");
    const attempt = "urn:uuid:11111111-1111-5111-8111-111111111111";
    const controller = new AbortController();
    let releaseDrain!: () => void;
    const drained = new Promise<void>((resolve) => { releaseDrain = resolve; });
    const solver = backend(attempt);
    solver.cancel = vi.fn(async () => {
      releaseDrain();
      return { attempt, state: "cancelled" } as never;
    });

    await journal.transact(async (transaction) => {
      transaction.append({
        type: "plan-recorded", recordedAt: AT,
        payload: { planDigest: PLAN, splitManifestDigest: SPLIT },
      });
      transaction.append({
        type: "run-recorded", recordedAt: AT,
        payload: { runDigest: RUN, kind: "development", arms: [{ armId: "current", tupleDigest: TUPLE }] },
      });
      const cellKey = `${"a".repeat(64)}/current/1`;
      const bindingDigest = `sha256:${"8".repeat(64)}`;
      transaction.append({
        type: "submission-prepared", recordedAt: AT,
        payload: { runDigest: RUN, cellKey, armId: "current", dispatch: 1, role: "solver", bindingDigest },
      });
      transaction.append({
        type: "submission-accepted", recordedAt: AT,
        payload: {
          runDigest: RUN, cellKey, armId: "current", dispatch: 1, role: "solver", bindingDigest,
          submission: "urn:uuid:33333333-3333-5333-8333-333333333333", attempt,
        },
      });

      const result = drainOrCancel({
        signal: controller.signal,
        drain: () => drained,
        cancellation: {
          transaction,
          backends: { solver, evaluator: backend("urn:uuid:22222222-2222-5222-8222-222222222222") },
          waitContexts: {
            create: () => ({
              waitUntilTerminal: vi.fn(async (input) => {
                expect(input.signal).toBeUndefined();
                return snapshot(input.attempt, "cancelled") as never;
              }),
            }),
          },
          recordedAt: AT,
          reasonCode: "operator-interrupt",
          closeAt: "2026-08-05T13:00:00Z",
          terminalEvidenceDigest: () => `sha256:${"9".repeat(64)}`,
        },
      });
      controller.abort();
      await expect(result).resolves.toBe("cancelled");
      expect(transaction.state.phase).toBe("CANCELLING");
      expect(transaction.state.activeAttempts.size).toBe(0);
      expect(solver.cancel).toHaveBeenCalledWith(attempt, "operator-interrupt");
    });
  });
});
