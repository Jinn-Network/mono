/** Default solve / posting window for jinn-repo.v1 tasks (exactly six hours). */
export const DEFAULT_POSTING_WINDOW_MS = 6 * 60 * 60 * 1000;

/**
 * Largest duration Node can schedule without a TimeoutOverflowWarning and
 * clamping the timer to 1 ms (the maximum signed 32-bit integer).
 */
export const MAX_POSTING_WINDOW_MS = 2_147_483_647;

/**
 * Resolve an operator-supplied posting window in milliseconds.
 * Omitted / null → default. Present but invalid → throw (never clamp / fall back).
 */
export function resolvePostingWindowMs(raw: unknown): number {
  if (raw === undefined || raw === null) {
    return DEFAULT_POSTING_WINDOW_MS;
  }
  if (
    typeof raw === 'number' &&
    Number.isSafeInteger(raw) &&
    raw >= DEFAULT_POSTING_WINDOW_MS &&
    raw <= MAX_POSTING_WINDOW_MS
  ) {
    return raw;
  }
  throw new Error(
    `jinn-repo postingWindowMs must be a safe integer between six hours (${DEFAULT_POSTING_WINDOW_MS} ms) and ${MAX_POSTING_WINDOW_MS} ms, got ${String(raw)}`,
  );
}
