/**
 * Harness engine — state machine definitions.
 *
 * §6.3 of spec/2026-04-17-portfolio-v0-design.md
 *
 * Pure logic; no I/O, no persistence.
 */

// ── State enum ────────────────────────────────────────────────────────────────

export const TaskRunState = {
  DISCOVERED: 'DISCOVERED',
  CLAIMED: 'CLAIMED',
  WAITING: 'WAITING',
  PRE_SNAPSHOT: 'PRE_SNAPSHOT',
  RUNNING: 'RUNNING',
  POST_SNAPSHOT: 'POST_SNAPSHOT',
  PACKAGING: 'PACKAGING',
  DELIVERING: 'DELIVERING',
  AWAITING_ADOPTION: 'AWAITING_ADOPTION',
  CLAIMING_DELIVERY: 'CLAIMING_DELIVERY',
  COMPLETE: 'COMPLETE',
  FAILED: 'FAILED',
  /**
   * Terminal: the on-chain task slot was already claimed/finalised by another
   * operator (or otherwise pruned at engine time) — we did not run anything,
   * we just observed a non-recoverable inner revert at the contract boundary
   * (TCMaxVerdictsReached, TCAttemptAlreadyFinalized, …). Kept distinct from
   * FAILED so the dashboard's failure counter only reflects runs the
   * operator actually attempted and lost. See issue #896.
   */
  RACE_LOST: 'RACE_LOST',
} as const;

export type TaskRunState = (typeof TaskRunState)[keyof typeof TaskRunState];

export const TERMINAL_STATES: ReadonlySet<TaskRunState> = new Set([
  TaskRunState.COMPLETE,
  TaskRunState.FAILED,
  TaskRunState.RACE_LOST,
]);

export const IN_FLIGHT_STATES: ReadonlySet<TaskRunState> = new Set([
  TaskRunState.DISCOVERED,
  TaskRunState.CLAIMED,
  TaskRunState.WAITING,
  TaskRunState.PRE_SNAPSHOT,
  TaskRunState.RUNNING,
  TaskRunState.POST_SNAPSHOT,
  TaskRunState.PACKAGING,
  TaskRunState.DELIVERING,
  TaskRunState.AWAITING_ADOPTION,
  TaskRunState.CLAIMING_DELIVERY,
]);

// ── Transition table ──────────────────────────────────────────────────────────

/**
 * Allowed transitions. Any non-terminal state can transition to FAILED
 * (terminal error path) or RACE_LOST (terminal "another operator pruned us"
 * path; see issue #896). The table lists non-FAILED, non-RACE_LOST successors
 * inline; FAILED + RACE_LOST are added uniformly to every in-flight state.
 */
const TRANSITIONS: ReadonlyMap<TaskRunState, ReadonlySet<TaskRunState>> = new Map([
  [TaskRunState.DISCOVERED,    new Set([TaskRunState.CLAIMED,       TaskRunState.FAILED, TaskRunState.RACE_LOST])],
  [TaskRunState.CLAIMED,       new Set([TaskRunState.WAITING,       TaskRunState.FAILED, TaskRunState.RACE_LOST])],
  [TaskRunState.WAITING,       new Set([TaskRunState.PRE_SNAPSHOT,  TaskRunState.FAILED, TaskRunState.RACE_LOST])],
  [TaskRunState.PRE_SNAPSHOT,  new Set([TaskRunState.RUNNING,       TaskRunState.FAILED, TaskRunState.RACE_LOST])],
  [TaskRunState.RUNNING,       new Set([TaskRunState.POST_SNAPSHOT, TaskRunState.FAILED, TaskRunState.RACE_LOST])],
  [TaskRunState.POST_SNAPSHOT, new Set([TaskRunState.PACKAGING,     TaskRunState.FAILED, TaskRunState.RACE_LOST])],
  [TaskRunState.PACKAGING,     new Set([TaskRunState.DELIVERING,    TaskRunState.FAILED, TaskRunState.RACE_LOST])],
  [TaskRunState.DELIVERING,    new Set([TaskRunState.AWAITING_ADOPTION, TaskRunState.COMPLETE, TaskRunState.FAILED, TaskRunState.RACE_LOST])],
  [TaskRunState.AWAITING_ADOPTION, new Set([TaskRunState.CLAIMING_DELIVERY, TaskRunState.FAILED, TaskRunState.RACE_LOST])],
  [TaskRunState.CLAIMING_DELIVERY, new Set([TaskRunState.COMPLETE, TaskRunState.FAILED, TaskRunState.RACE_LOST])],
  [TaskRunState.COMPLETE,      new Set()],
  [TaskRunState.FAILED,        new Set()],
  [TaskRunState.RACE_LOST,     new Set()],
]);

/**
 * Returns true if the transition from → to is permitted by the state machine.
 */
export function isValidTransition(from: TaskRunState, to: TaskRunState): boolean {
  const allowed = TRANSITIONS.get(from);
  if (!allowed) return false;
  return allowed.has(to);
}

/**
 * Asserts that a transition is valid; throws if not.
 */
export function assertValidTransition(from: TaskRunState, to: TaskRunState): void {
  if (!isValidTransition(from, to)) {
    throw new Error(
      `Invalid state transition: ${from} → ${to}. ` +
      `Allowed from ${from}: [${[...(TRANSITIONS.get(from) ?? [])].join(', ')}]`,
    );
  }
}

/**
 * All state values as an array, useful for exhaustive checks.
 */
export const ALL_STATES: readonly TaskRunState[] = Object.values(TaskRunState);

// ── Delivery errors ───────────────────────────────────────────────────────────

/**
 * Thrown by deliver() when claimDeliveryVariant is 'v2' but evidenceHash is
 * null/undefined. A zero fallback would silently submit bytes32(0) on-chain
 * and brick staking rewards; we prefer a loud FAILED transition instead.
 */
export class MissingEvidenceHashError extends Error {
  constructor(requestId: string) {
    super(
      `deliver: evidenceHash is required for v2 claimDelivery but is missing ` +
      `(requestId=${requestId}). Ensure pack() completed successfully before deliver().`,
    );
    this.name = 'MissingEvidenceHashError';
  }
}
