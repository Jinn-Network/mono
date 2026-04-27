/**
 * Deterministic clock for tests that touch time.
 * Production code that needs "now" should accept a `() => number` so tests can inject `clock.now`.
 */
export class FakeClock {
  private ms: number;

  constructor(initialMs: number = Date.now()) {
    this.ms = initialMs;
  }

  now(): number {
    return this.ms;
  }

  advance(ms: number): void {
    this.ms += ms;
  }
}
