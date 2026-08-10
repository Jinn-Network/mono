// SPDX-License-Identifier: MIT

import type { TaskExecutionBackend } from "@jinn-network/task-execution-backend";
import type { AttemptWaitPort } from "@jinn-network/benchmarking-run";
import type { LiveHostJournalTransaction, LiveHostPayload } from "./journal.js";
import { HostStateError } from "./state.js";

export interface CancellationBackends {
  readonly solver: TaskExecutionBackend;
  readonly evaluator: TaskExecutionBackend;
}

export interface FreshWaitContextFactory {
  /** A new context for every drain; it must not inherit the campaign's aborted signal. */
  create(): AttemptWaitPort;
}

export interface CancellationRequest {
  readonly transaction: LiveHostJournalTransaction;
  readonly backends: CancellationBackends;
  readonly waitContexts: FreshWaitContextFactory;
  readonly recordedAt: string;
  readonly reasonCode: string;
  readonly closeAt: string;
  terminalEvidenceDigest(input: {
    readonly attempt: string;
    readonly role: "solver" | "evaluator";
  }): string | Promise<string>;
}

const DIGEST = /^sha256:[a-f0-9]{64}$/u;

/**
 * Persists cancellation first, forbids further dispatch through journal phase, then cancels and
 * drains every role-scoped attempt with a fresh wait context. A partial failure deliberately leaves
 * the campaign in CANCELLING so restart repeats reconciliation instead of pretending it closed.
 */
export async function requestCancellationAndDrain(input: CancellationRequest): Promise<void> {
  if (input.transaction.state.phase === "ACTIVE") {
    input.transaction.append({
      type: "cancellation-requested",
      recordedAt: input.recordedAt,
      payload: { reasonCode: input.reasonCode },
    });
  } else if (input.transaction.state.phase !== "CANCELLING") {
    throw new HostStateError("state-io", "cancellation requires an active or already-cancelling campaign");
  }

  const attempts = [...input.transaction.state.activeAttempts.entries()];
  const cancellationResults = await Promise.allSettled(attempts.map(async ([attempt, active]) => {
    const backend = input.backends[active.role];
    const reconciled = await backend.recover(attempt as never);
    if (reconciled.classification !== "matching") {
      throw new HostStateError("state-io", "active attempt recovery was absent or contradictory while cancelling");
    }
    const initial = await backend.observe(attempt as never);
    if (!initial.descriptor.derived.terminal) {
      await backend.cancel?.(attempt as never, input.reasonCode);
    }
  }));
  const cancellationFailure = cancellationResults.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (cancellationFailure !== undefined) throw cancellationFailure.reason;

  const results = await Promise.allSettled(attempts.map(async ([attempt, active]) => {
    const backend = input.backends[active.role];
    const initial = await backend.observe(attempt as never);
    const terminal = initial.descriptor.derived.terminal
      ? initial
      : await input.waitContexts.create().waitUntilTerminal({
        backend,
        attempt,
        closeAt: input.closeAt,
        // Intentionally no signal: cancellation drain cannot inherit the aborted run context.
      });
    if (!terminal.descriptor.derived.terminal) {
      throw new HostStateError("state-io", "cancellation drain returned before an attempt was terminal");
    }
    const digest = await input.terminalEvidenceDigest({ attempt, role: active.role });
    if (!DIGEST.test(digest)) throw new HostStateError("state-io", "terminal evidence digest is malformed");
    const terminalState = terminal.descriptor.derived.state;
    const supported = ["delivered", "failed", "cancelled", "expired", "lost", "rejected"] as const;
    if (!(supported as readonly string[]).includes(terminalState)) {
      throw new HostStateError("state-io", "attempt terminal state is not journalable");
    }
    const payload: LiveHostPayload<"attempt-terminal-recorded"> = {
      runDigest: active.runDigest,
      cellKey: active.cellKey,
      armId: active.armId,
      dispatch: active.dispatch,
      role: active.role,
      attempt,
      state: terminalState as LiveHostPayload<"attempt-terminal-recorded">["state"],
      evidenceDigest: digest,
    };
    input.transaction.append({ type: "attempt-terminal-recorded", recordedAt: input.recordedAt, payload });
  }));
  const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (rejected !== undefined) throw rejected.reason;
}

/**
 * Waits for one role backend without losing an operator interrupt. The first interrupt persists
 * CANCELLING before cancellation side effects, drains with fresh non-aborted wait contexts, and
 * then lets the caller close the journal without assembling late evidence into a Matrix.
 */
export async function drainOrCancel(input: {
  readonly signal?: AbortSignal;
  drain(): Promise<void>;
  readonly cancellation: CancellationRequest;
}): Promise<"drained" | "cancelled"> {
  if (input.signal?.aborted === true) {
    await requestCancellationAndDrain(input.cancellation);
    await input.drain();
    return "cancelled";
  }
  const drain = input.drain().then(() => "drained" as const);
  if (input.signal === undefined) return drain;

  let onAbort: (() => void) | undefined;
  const aborted = new Promise<"cancelled">((resolve) => {
    if (input.signal!.aborted) {
      resolve("cancelled");
      return;
    }
    onAbort = () => resolve("cancelled");
    input.signal!.addEventListener("abort", onAbort, { once: true });
  });
  const outcome = await Promise.race([drain, aborted]);
  if (onAbort !== undefined) input.signal.removeEventListener("abort", onAbort);
  if (outcome === "drained" && !input.signal.aborted) return outcome;

  await requestCancellationAndDrain(input.cancellation);
  await drain;
  return "cancelled";
}
