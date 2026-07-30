// SPDX-License-Identifier: Apache-2.0

export interface DeadlineClock {
  readonly execStartedAtMonotonicMs: number;
  readonly maxAttemptDurationMs: number;
  readonly nowMonotonicMs: () => number;
  readonly setTimer: (callback: () => void, delayMs: number) => unknown;
}
export interface ArmedDeadline { readonly remainingMs: number }

/** Arms exclusively from monotonic elapsed execution time; preparation and wall time are excluded. */
export function armDeadline(clock: DeadlineClock, onExpire: () => void): ArmedDeadline {
  const elapsed = Math.max(0, clock.nowMonotonicMs() - clock.execStartedAtMonotonicMs);
  const remainingMs = Math.max(0, clock.maxAttemptDurationMs - elapsed);
  if (remainingMs === 0) onExpire(); else clock.setTimer(onExpire, remainingMs);
  return { remainingMs };
}

/** v1 heartbeat staleness is an observation/degradation signal, never an automatic kill. */
export function heartbeatIsStale(input: { readonly lastMonotonicMs: number; readonly nowMonotonicMs: number; readonly intervalMs?: number }): boolean {
  return input.nowMonotonicMs - input.lastMonotonicMs >= (input.intervalMs ?? 15_000) * 3;
}
