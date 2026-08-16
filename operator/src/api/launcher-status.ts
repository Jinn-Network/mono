/**
 * Launcher mode status assembler.
 *
 * Composes per-SolverNet generator state, open-Task counts, and Safe budget
 * runway into the canonical `LauncherStatusResponse`. Surfaces every
 * SolverNet entry the daemon has loaded — launcher ownership is no longer
 * expressed via an operator-config `'launching'` role (Task 22 of
 * spec/2026-05-05-solvernet-creation-and-launch.md dropped that enum value);
 * the launched-record subsystem owns that signal now.
 *
 * Stale-poll detection is computed here when a generator reports a cadence:
 * a poll is stale when the wall clock has advanced past `lastPollAt + 2 *
 * cadenceMs`. Fill-the-pool generators may omit cadence and are never marked
 * stale by this generic status surface.
 *
 * The deps shape is intentionally narrow — every external surface is a
 * function so tests can inject deterministic state without standing up the
 * full daemon. Subdeps that require deeper integration (open-Task counts,
 * reserved-budget math, Safe-balance reads) are abstract here; v1 wires them
 * to placeholder accessors with TODO pointers at Task 7.
 */
import type { JinnConfig } from '../config.js';

export interface LauncherStatusGeneratorView {
  state: 'active' | 'paused' | 'errored';
  lastPollAt?: string;
  lastPollSummary?: LauncherGeneratorPollSummary;
  lastError?: { message: string; at: string };
  cadenceMs?: number;
  stale: boolean;
}

export type LauncherGeneratorPollSummary =
  | {
    evaluated: number;
    posted: number;
    skipped: number;
  }
  | {
    poolSize: number;
    posted: number;
    unposted: number;
    live: number;
    repostable: number;
    saturated: number;
  };

export interface LauncherStatusBudgetView {
  safeAddress: string;
  safeBalanceWei: string;
  reservedBudgetWei: string;
  runwayDays?: number;
}

export interface LauncherStatusNetEntry {
  name: string;
  solverType?: string;
  generator: LauncherStatusGeneratorView;
  openTasks: number;
  budget: LauncherStatusBudgetView;
}

export interface LauncherStatusResponse {
  schemaVersion: 1;
  generatedAt: string;
  nets: LauncherStatusNetEntry[];
}

/**
 * Generator state snapshot the gather function consumes. Matches
 * `PredictionV1GeneratorStateSnapshot` in shape but is declared here so the
 * gather function does not depend on a specific SolverType module.
 */
export interface LauncherGeneratorStateSnapshot {
  lastPollAt?: string;
  lastPollSummary?: LauncherGeneratorPollSummary;
  lastError?: { message: string; at: string };
  cadenceMs?: number;
  poolPublicationUpdatedAt?: string;
  poolPublicationPriorSize?: number;
  poolPublicationCurrentSize?: number;
  poolPublicationStale?: boolean;
  totalPosted?: number;
  lastPostedInstanceId?: string;
}

export interface GatherLauncherStatusDeps {
  config: Pick<JinnConfig, 'posting'>;
  /** Returns the generator's live state, or `undefined` if the SolverNet has no generator. */
  getGeneratorState: (netName: string) => LauncherGeneratorStateSnapshot | undefined;
  /** Count of Tasks created by the operator that are still in flight for the named SolverNet. */
  getOpenTaskCount: (netName: string) => Promise<number> | number;
  /** Sum of unconsumed claim payments across open Tasks (wei string). */
  getReservedBudgetWei: (netName: string) => Promise<string> | string;
  /** Safe ETH balance in wei (string) for the operator's funding wallet. */
  getSafeBalanceWei: () => Promise<string> | string;
  /**
   * Operator Safe address used for budget views. Either a literal string (when
   * known at construction time, e.g. tests) or a getter (when the address only
   * resolves after bootstrap completes — see main.ts wiring).
   */
  safeAddress: string | (() => string);
  /** Now-source override for deterministic tests. */
  now?: () => number;
}

/**
 * Derive the high-level generator state. `errored` wins over `active`/`paused`
 * because the operator wants to see the failure first; `paused` only fires
 * when no generator state is exposed at all (closed role gate before the very
 * first tick, or a SolverNet without a launcher implementation).
 *
 * NOTE (v1 edge case, jinn-mono-l2zl carry-over from Task 6 review): a
 * generator with a `cadenceMs > 0` and no `lastError` reports `active` even
 * before its first poll has completed. If the daemon has been running long
 * enough that the first poll *should* have completed but `lastPollAt` is
 * still undefined, the operator UI will show "active, not stale" — which is
 * misleading. The fix requires tracking a `genStartedAt` timestamp on the
 * generator so the gather function can compare `now - genStartedAt`
 * against `2 * cadenceMs`. Deferred to a follow-up: in v1 the prediction.v1
 * cadence is 6h, so the window between "started" and "first tick" is short
 * enough that the misclassification is rare in practice. Tracked under
 * the launcher-mode plan (spec/2026-05-05-launcher-role-and-mode.md §5.3).
 */
function deriveGeneratorState(
  snapshot: LauncherGeneratorStateSnapshot | undefined,
): 'active' | 'paused' | 'errored' {
  if (!snapshot) return 'paused';
  if (snapshot.lastError) return 'errored';
  return 'active';
}

function isStalePoll(
  snapshot: LauncherGeneratorStateSnapshot | undefined,
  now: number,
): boolean {
  if (!snapshot || !snapshot.lastPollAt) return false;
  const lastPollMs = Date.parse(snapshot.lastPollAt);
  if (!Number.isFinite(lastPollMs)) return false;
  const cadenceMs = snapshot.cadenceMs ?? 0;
  if (cadenceMs <= 0) return false;
  return now - lastPollMs > 2 * cadenceMs;
}

export async function gatherLauncherStatus(
  deps: GatherLauncherStatusDeps,
): Promise<LauncherStatusResponse> {
  const now = deps.now?.() ?? Date.now();
  const nets: LauncherStatusNetEntry[] = [];

  for (const entry of deps.config.posting ?? []) {
    const displayName = entry.workKind;
    const solverType = entry.workKind;
    const snapshot = deps.getGeneratorState(displayName);
    const generatorState = deriveGeneratorState(snapshot);
    const stale = isStalePoll(snapshot, now);

    const [openTasks, reservedBudgetWei, safeBalanceWei] = await Promise.all([
      Promise.resolve(deps.getOpenTaskCount(displayName)),
      Promise.resolve(deps.getReservedBudgetWei(displayName)),
      Promise.resolve(deps.getSafeBalanceWei()),
    ]);

    const generator: LauncherStatusGeneratorView = {
      state: generatorState,
      stale,
    };
    if (snapshot?.cadenceMs !== undefined) generator.cadenceMs = snapshot.cadenceMs;
    if (snapshot?.lastPollAt) generator.lastPollAt = snapshot.lastPollAt;
    if (snapshot?.lastPollSummary) generator.lastPollSummary = { ...snapshot.lastPollSummary };
    if (snapshot?.lastError) generator.lastError = { ...snapshot.lastError };

    const safeAddress = typeof deps.safeAddress === 'function' ? deps.safeAddress() : deps.safeAddress;
    nets.push({
      name: displayName,
      ...(typeof solverType === 'string' && solverType.length > 0 ? { solverType } : {}),
      generator,
      openTasks,
      budget: {
        safeAddress,
        safeBalanceWei,
        reservedBudgetWei,
      },
    });
  }

  return {
    schemaVersion: 1,
    generatedAt: new Date(now).toISOString(),
    nets,
  };
}
