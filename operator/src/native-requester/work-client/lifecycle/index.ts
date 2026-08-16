// The lifecycle exits' public surface — the requester's `close` / `cancel` / `release` intent
// modules (cutover stage-3 posting-flow plan; DR-2026-08-05 decision 1). Each is a pure
// config-and-ports-in, result-out function; the `jinn tasks {close,cancel,release}` CLI verbs are
// separate front-ends that resolve the venue lifecycle/release ports and call these.
export { closePosting } from './close.js';
export type { ClosePostingInput, ClosePostingResult, PostingClosePort } from './close.js';
export { cancelAttempt } from './cancel.js';
export type { CancelAttemptInput, CancelAttemptResult, AttemptCancelPort } from './cancel.js';
export { releasePostedAttempt } from './release.js';
export type {
  ReleasePostedAttemptInput,
  ReleasePostedAttemptResult,
} from './release.js';
