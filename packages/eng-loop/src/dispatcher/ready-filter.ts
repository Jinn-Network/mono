import type { PolledIssue, ReadyIssue, Priority } from './types.js';

const PRIORITY_RANK: Record<Priority, number> = {
  P0: 0, P1: 1, P2: 2, P3: 3, P4: 4,
};

/**
 * An issue is **ready** when it is triage-complete (Issue Type set),
 * `Blocked on: Nothing`, on the board, in `Todo`, and not already in flight.
 * Ready issues are ordered by Priority, then FIFO by issue number.
 */
export function selectReady(
  polled: PolledIssue[],
  inFlight: ReadonlySet<number>,
): ReadyIssue[] {
  const ready = polled.filter(
    (i): i is ReadyIssue =>
      i.shape !== null &&
      i.priority !== null &&
      i.blockedOn === 'Nothing' &&
      i.onBoard &&
      i.status === 'Todo' &&
      !inFlight.has(i.number),
  );
  return ready.sort(
    (a, b) =>
      PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] ||
      a.number - b.number,
  );
}
