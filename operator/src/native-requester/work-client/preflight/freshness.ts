import { RequesterError } from '../errors.js';

/** Execution reserve: a deadline that lands inside this window is treated as already gone. */
export const POSTING_FRESHNESS_RESERVE_MS = 60_000;

export interface PostingFreshnessInput {
  readonly claimWindowEndMs: number;
  readonly submissionDeadlineMs: number;
  readonly sessionDeadlineMs: number;
}

export class RequestExpiredError extends RequesterError {
  constructor(
    readonly expired: readonly string[],
    minimumLiveDeadlineMs: number,
    reserveMs: number,
  ) {
    super(
      'freshness',
      'request-expired',
      `posting freshness check failed: ${expired.join(', ')} must remain live beyond `
      + `${new Date(minimumLiveDeadlineMs).toISOString()} (${reserveMs} ms execution reserve)`,
    );
  }
}

/**
 * The requester freshness rule: every deadline must remain live beyond now + reserve, or the
 * posting would be dead on arrival. Mirrors the legacy
 * `assertMarketplaceTaskRequestFreshness` behavior (operator/src/tasks/submit-preflight.ts:25-61),
 * pinned by the golden fixture. A non-finite deadline is treated as expired.
 */
export function assertPostingFreshness(
  input: PostingFreshnessInput,
  options: { nowMs?: number; reserveMs?: number } = {},
): void {
  const nowMs = options.nowMs ?? Date.now();
  const reserveMs = options.reserveMs ?? POSTING_FRESHNESS_RESERVE_MS;
  const minimumLiveDeadline = nowMs + reserveMs;
  const deadlines: readonly (readonly [string, number])[] = [
    ['claim window end', input.claimWindowEndMs],
    ['submission deadline', input.submissionDeadlineMs],
    ['session/adoption deadline', input.sessionDeadlineMs],
  ];
  const expired = deadlines
    .filter(([, deadline]) => !Number.isFinite(deadline) || deadline <= minimumLiveDeadline)
    .map(([label]) => label);
  if (expired.length > 0) {
    throw new RequestExpiredError(expired, minimumLiveDeadline, reserveMs);
  }
}
