// @jinn-network/task-posting -- public surface.
//
// Policy in, posts out. `PostingDeps.backend` is the sole requester posting/recovery authority;
// this package does not accept raw chain or binding ports.
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
} from "./execute.js";
