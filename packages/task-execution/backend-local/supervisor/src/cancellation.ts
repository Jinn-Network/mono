// SPDX-License-Identifier: Apache-2.0

export interface CancellationAttempt {
  readonly terminalState?: string;
  /** A durable cancel-requested event already exists; repeated calls must have no signal effects. */
  readonly cancellationRequested?: boolean;
}
export interface CancellationDriver {
  signalTerm(): void | Promise<void>;
  signalKill(): void | Promise<void>;
  isSubtreeEmpty(): boolean | Promise<boolean>;
  readOutcome(): { readonly exitCode: number | null; readonly termSignal: string | null } | null | Promise<{ readonly exitCode: number | null; readonly termSignal: string | null } | null>;
  harvest(): void | Promise<void>;
  listPids?(): readonly number[] | Promise<readonly number[]>;
  sleep?(ms: number): void | Promise<void>;
}
export interface CancellationOptions { readonly graceMs?: number; readonly killPollCeilingMs?: number; readonly nowMs?: () => number }
export interface CancellationResult {
  readonly requested: boolean; readonly terminalState: string; readonly outcome?: { readonly exitCode: number | null; readonly termSignal: string | null }; readonly blame?: "infrastructure"; readonly residualPids?: readonly number[];
}

/** Signals only the harness subtree through its shim-facing driver; cancellation never authors an outcome. */
export async function runCancellationLadder(attempt: CancellationAttempt, driver: CancellationDriver, options: CancellationOptions = {}): Promise<CancellationResult> {
  if (attempt.terminalState !== undefined) return { requested: false, terminalState: attempt.terminalState };
  if (attempt.cancellationRequested) return { requested: false, terminalState: "cancelling" };
  const graceMs = options.graceMs ?? 10_000;
  const ceilingMs = options.killPollCeilingMs ?? 30_000;
  const now = options.nowMs ?? Date.now;
  await driver.signalTerm();
  if (graceMs > 0) await driver.sleep?.(graceMs);
  if (!await driver.isSubtreeEmpty()) await driver.signalKill();
  const started = now();
  while (!await driver.isSubtreeEmpty() && now() - started < ceilingMs) await driver.sleep?.(Math.min(25, ceilingMs));
  if (!await driver.isSubtreeEmpty()) {
    const residualPids = await driver.listPids?.() ?? [];
    await driver.harvest();
    return { requested: true, terminalState: "failed", blame: "infrastructure", residualPids };
  }
  const outcome = await driver.readOutcome();
  await driver.harvest();
  // A recorded normal exit is authoritative; a signal delivered by this ladder is not a
  // natural failure and therefore resolves to cancelled after harvest.
  if (outcome?.exitCode === 0 && outcome.termSignal === null) return { requested: true, terminalState: "delivered", outcome };
  if (outcome?.termSignal === "SIGTERM" || outcome?.termSignal === "SIGKILL") return { requested: true, terminalState: "cancelled", outcome };
  if (outcome !== null) return { requested: true, terminalState: "failed", outcome };
  return { requested: true, terminalState: "cancelled" };
}
