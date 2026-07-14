/**
 * Rate-limit error classifier — reactive recovery from a tripped GitHub API
 * rate limit.
 *
 * This is the *reactive* complement to the *proactive* `rate-limit-guard.ts`
 * (jinn-mono#585). The guard prevents a cycle from tripping the limit by
 * skipping when the per-cycle GraphQL budget falls below a floor; this module
 * recovers when a cycle trips the limit *anyway* (e.g. an in-flight session
 * burned the budget, or a REST call the guard does not see). Given the error a
 * cycle threw, it decides whether that error is a rate-limit failure and how
 * long to back off before the next poll.
 *
 * Sleeping happens at the orchestrator (`scripts/run-autopilot.ts` →
 * `runLoop`'s `setTimeout`); this module is pure so it stays unit-testable.
 * The constants below are deliberately local — we do NOT import from the guard,
 * to keep the two recovery paths decoupled even though they mirror each other.
 *
 * Tracking: jinn-mono#539.
 */

/** Hard upper bound on the back-off, in milliseconds. GitHub's rate-limit
 *  window is always ≤1 hour, so a larger value implies a malformed reset. */
const MAX_SLEEP_MS = 60 * 60 * 1000;

/** Fallback back-off when no reset header can be parsed (per the AC). */
const DEFAULT_SLEEP_MS = 5 * 60 * 1000;

/** Headroom added past the parsed reset, mirroring the guard's +5s. */
const RESET_BUFFER_MS = 5_000;

export interface RateLimitClassification {
  isRateLimit: boolean;
  sleepMs: number;
  resetAt?: string;
}

/**
 * Flatten an unknown thrown value into a single lowercased string for pattern
 * matching. Concatenates the `stderr`, `message`, and `stdout` string fields of
 * an object; uses a string err as-is; otherwise yields ''.
 */
function coalesce(err: unknown): string {
  if (typeof err === 'string') return err.toLowerCase();
  if (err !== null && typeof err === 'object') {
    const o = err as Record<string, unknown>;
    const parts: string[] = [];
    for (const key of ['stderr', 'message', 'stdout'] as const) {
      const v = o[key];
      if (typeof v === 'string') parts.push(v);
    }
    return parts.join(' ').toLowerCase();
  }
  return '';
}

/**
 * Parse the `X-RateLimit-Reset` header (Unix epoch SECONDS) out of `text`,
 * returning the reset instant in milliseconds, or undefined if absent/NaN.
 */
function parseResetMs(text: string): number | undefined {
  const m = /x-ratelimit-reset:\s*(\d+)/.exec(text);
  if (!m) return undefined;
  const ms = Number(m[1]) * 1000;
  return Number.isNaN(ms) ? undefined : ms;
}

/**
 * Classify a thrown cycle error as a GitHub rate-limit failure (or not) and
 * compute the back-off duration.
 *
 * @param err The value a cycle threw.
 * @param now Injected clock (default `Date.now`) for deterministic testing.
 */
export function classifyRateLimitError(
  err: unknown,
  now: () => number = () => Date.now(),
): RateLimitClassification {
  const text = coalesce(err);

  const isRateLimit =
    text.includes('rate limit exceeded') ||
    (/\b(403|429)\b/.test(text) && /x-ratelimit-remaining:\s*0\b/.test(text));

  if (!isRateLimit) {
    return { isRateLimit: false, sleepMs: 0 };
  }

  const resetMs = parseResetMs(text);
  if (resetMs !== undefined) {
    const rawSleep = resetMs - now() + RESET_BUFFER_MS;
    const sleepMs = Math.max(0, Math.min(rawSleep, MAX_SLEEP_MS));
    return { isRateLimit: true, sleepMs, resetAt: new Date(resetMs).toISOString() };
  }

  return { isRateLimit: true, sleepMs: DEFAULT_SLEEP_MS };
}
