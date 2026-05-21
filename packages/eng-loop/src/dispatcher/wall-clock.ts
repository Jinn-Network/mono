import type { InFlightSession } from './types.js';

/**
 * Per-session wall-clock circuit-breaker. A generous ceiling — sessions
 * legitimately run for hours. On expiry the dispatcher PAUSES the session
 * (sets the issue Blocked on: Human, leaves the worktree + transcript intact
 * and resumable) — it never kills it. The breaker is a runaway guard for the
 * rare doom-loop, not a retry cap; because escalation is a pause, the exact
 * value needs no precise tuning.
 */
export class WallClock {
  constructor(
    private readonly wallClockMs: number,
    private readonly nowFn: () => number = Date.now,
  ) {}

  private elapsed(session: InFlightSession): number {
    return this.nowFn() - session.startedAt;
  }

  /**
   * True once the session has run past its wall-clock ceiling.
   *
   * Guards against re-derived sessions where `startedAt` is unknown (≤ 0):
   * an unknown-age session is never force-paused — the wall-clock is a runaway
   * guard, not a guess.
   */
  expired(session: InFlightSession): boolean {
    if (session.startedAt <= 0) return false;
    return this.elapsed(session) >= this.wallClockMs;
  }

  /**
   * True in the final 10% of the window — a soft warning before the hard
   * stop, so the session can write its "where I am" note (spec §4).
   *
   * Also returns false when `startedAt` is unknown (≤ 0).
   */
  softWarningDue(session: InFlightSession): boolean {
    if (session.startedAt <= 0) return false;
    return this.elapsed(session) >= this.wallClockMs * 0.9;
  }
}
