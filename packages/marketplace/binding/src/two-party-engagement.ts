// SPDX-License-Identifier: MIT

// This module is the binding-side, TYPE-ONLY declaration of the two-party engagement entry --
// the exact named surface the marketplace pipeline (Milestone M6) will hand to
// `@jinn-network/task-execution-backend-local`'s assembly `submit`. It is NOT a
// re-implementation: the CONCRETE entry lives on the assembly's `submit` third parameter
// (local-execution-backend plan, Milestone C, per the dated companion amendment
// 2026-07-28-b). This module only pins the shape both sides agree on, ahead of that package
// existing in this worktree.
//
// Finding F1 (surfaced to the coordinator, recorded in
// docs/superpowers/plans/2026-07-28-marketplace-binding.md "Findings"): the two-party entry
// touches the already-implemented, frozen `TaskExecutionBackend` interface
// (`packages/task-execution/backend/src/backend.ts:37`,
// `submit(taskBytes: Uint8Array, submissionBytes: Uint8Array): Promise<SubmissionAck>`,
// Phase 2, merged) by adding an optional third `engagement` parameter:
// `submit(taskBytes, submissionBytes, engagement?: TwoPartyEngagement): Promise<SubmissionAck>`.
// A Submission-document-field realization is impossible (the deterministic URI depends on
// `attemptIndex`, known only at claim time, but the requester seals the Submission at posting
// time); a separate `engage()` method is disallowed by ruling §7.18 (the binding consumes ONLY
// through the standard interface and hands sealed bytes to `submit`). Widening `submit` is
// therefore the only faithful realization, and it MUST be dispositioned by the coordinator as a
// dated addendum to the TEP plan/design and built into the local-backend assembly's Milestone C
// from day one -- never silently widened. This plan does not edit `backend/src/backend.ts`.
import type { AttemptUri } from "@jinn-network/task-execution-backend";
import type { DispatchContext } from "@jinn-network/task-execution-protocol";

/**
 * The two-party engagement the marketplace binding hands to the embedded local backend's
 * assembly: `attemptUri` is the caller-minted deterministic URI (M1.1's
 * `deriveMarketplaceAttemptUri`); `dispatchContext` is the caller-built dispatch-context
 * artifact (TEP §9.3). When present on `submit`'s optional third parameter, the assembly adopts
 * `attemptUri` (validating format via `isValidUrnUuid`) and records `dispatchContext` verbatim
 * instead of minting a random `urn:uuid` -- the two-party binding described in design §6.2.
 */
export interface TwoPartyEngagement {
  readonly attemptUri: AttemptUri;
  readonly dispatchContext: DispatchContext;
}
