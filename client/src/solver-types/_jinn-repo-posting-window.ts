/** Default solve / posting window for jinn-repo.v1 tasks (exactly six hours). */
export const DEFAULT_POSTING_WINDOW_MS = 6 * 60 * 60 * 1000;

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
    Number.isFinite(raw) &&
    Number.isInteger(raw) &&
    raw > 0
  ) {
    return raw;
  }
  throw new Error(
    `jinn-repo postingWindowMs must be a positive integer (ms), got ${String(raw)}`,
  );
}
