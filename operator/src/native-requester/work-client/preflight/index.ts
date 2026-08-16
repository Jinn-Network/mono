// The preflight core's own public surface. The marketplace-surfaces hand-off authors golden
// fixtures against exactly these exports and later converges the `jinn` CLI onto them.
export { assertPostingFunds, postingBudgetWei } from './funds.js';
export type { PostingFundsInput } from './funds.js';
export {
  POSTING_FRESHNESS_RESERVE_MS,
  RequestExpiredError,
  assertPostingFreshness,
} from './freshness.js';
export type { PostingFreshnessInput } from './freshness.js';
export { selectLiveTarget } from './target.js';
export type { PostingTargetCandidate, SelectLiveTargetInput } from './target.js';
export {
  POSTING_PREFLIGHT_CATEGORIES,
  PostingPreflightFailure,
  runPostingPreflight,
} from './run.js';
export type {
  PostingPreflightCategory,
  PostingPreflightChecks,
  PostingPreflightEntry,
} from './run.js';
