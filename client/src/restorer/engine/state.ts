/**
 * Restorer engine — state machine definitions.
 *
 * §6.3 of spec/2026-04-17-portfolio-v0-design.md
 *
 * Pure logic; no I/O, no persistence.
 */

// ── State enum ────────────────────────────────────────────────────────────────

export const IntentState = {
  DISCOVERED: 'DISCOVERED',
  CLAIMED: 'CLAIMED',
  WAITING: 'WAITING',
  PRE_SNAPSHOT: 'PRE_SNAPSHOT',
  RUNNING: 'RUNNING',
  POST_SNAPSHOT: 'POST_SNAPSHOT',
  PACKAGING: 'PACKAGING',
  DELIVERING: 'DELIVERING',
  COMPLETE: 'COMPLETE',
  FAILED: 'FAILED',
} as const;

export type IntentState = (typeof IntentState)[keyof typeof IntentState];

export const TERMINAL_STATES: ReadonlySet<IntentState> = new Set([
  IntentState.COMPLETE,
  IntentState.FAILED,
]);

export const IN_FLIGHT_STATES: ReadonlySet<IntentState> = new Set([
  IntentState.DISCOVERED,
  IntentState.CLAIMED,
  IntentState.WAITING,
  IntentState.PRE_SNAPSHOT,
  IntentState.RUNNING,
  IntentState.POST_SNAPSHOT,
  IntentState.PACKAGING,
  IntentState.DELIVERING,
]);

// ── Transition table ──────────────────────────────────────────────────────────

/**
 * Allowed transitions. Any state can transition to FAILED (terminal error path).
 * The table below lists non-FAILED successors only.
 */
const TRANSITIONS: ReadonlyMap<IntentState, ReadonlySet<IntentState>> = new Map([
  [IntentState.DISCOVERED,    new Set([IntentState.CLAIMED,       IntentState.FAILED])],
  [IntentState.CLAIMED,       new Set([IntentState.WAITING,       IntentState.FAILED])],
  [IntentState.WAITING,       new Set([IntentState.PRE_SNAPSHOT,  IntentState.FAILED])],
  [IntentState.PRE_SNAPSHOT,  new Set([IntentState.RUNNING,       IntentState.FAILED])],
  [IntentState.RUNNING,       new Set([IntentState.POST_SNAPSHOT, IntentState.FAILED])],
  [IntentState.POST_SNAPSHOT, new Set([IntentState.PACKAGING,     IntentState.FAILED])],
  [IntentState.PACKAGING,     new Set([IntentState.DELIVERING,    IntentState.FAILED])],
  [IntentState.DELIVERING,    new Set([IntentState.COMPLETE,      IntentState.FAILED])],
  [IntentState.COMPLETE,      new Set()],
  [IntentState.FAILED,        new Set()],
]);

/**
 * Returns true if the transition from → to is permitted by the state machine.
 */
export function isValidTransition(from: IntentState, to: IntentState): boolean {
  const allowed = TRANSITIONS.get(from);
  if (!allowed) return false;
  return allowed.has(to);
}

/**
 * Asserts that a transition is valid; throws if not.
 */
export function assertValidTransition(from: IntentState, to: IntentState): void {
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
export const ALL_STATES: readonly IntentState[] = Object.values(IntentState);

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
