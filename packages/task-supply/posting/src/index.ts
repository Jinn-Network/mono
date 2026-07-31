// @jinn-network/task-posting -- public surface.
//
// Policy in, posts out. The mechanics behind `PostingDeps.postTask` are the marketplace binding's
// today; they are the work client's at its mint (README, finding F7). Nothing else here changes
// when that swap happens.
export { planPosting } from "./plan.js";
export type {
  PostingPlan,
  PostingPlanEntry,
  PostingPolicy,
  PostingPoolEntry,
  PostingSkip,
  PostingSkipReason,
} from "./types.js";
export { POSTING_SUBMISSION_NAMESPACE, buildDispatchSubmission } from "./dispatch-submission.js";
// The pool-shape reconciliation the program still has to rule on (README, F-C5-8): one named
// adapter from what the supply pool stores to what this application posts, with D5's publicness
// read off the sealed specification bytes instead of taken as a caller's claim.
export { evaluationSpecIsPublic, postingPoolEntry } from "./pool-entry.js";
export type { PostingPoolEntryOptions, SuppliedPoolEntry } from "./pool-entry.js";
export { PostingRefusedError, executePosting } from "./execute.js";
export type {
  PostingApproval,
  PostingApprovalPort,
  PostingDeps,
  PostingLogLine,
  PostingLogPort,
  PostingRenderPort,
  PostingRunSummary,
  PostTaskFn,
} from "./execute.js";
