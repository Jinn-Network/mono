// SPDX-License-Identifier: MIT

import type { AttemptUri, TwoPartyEngagement } from "@jinn-network/task-execution-backend";
import type { DispatchContext } from "@jinn-network/task-execution-protocol";

export interface EngagementClaim {
  readonly attemptUri: AttemptUri;
  readonly dispatchContext: DispatchContext;
}

/**
 * The pipeline mints the deterministic Attempt URI and builds the dispatch-context itself
 * (§6.2), then hands them to the assembly's two-party `submit` entry.
 */
export function buildEngagement(claim: EngagementClaim): TwoPartyEngagement {
  return {
    attemptUri: claim.attemptUri,
    dispatchContext: claim.dispatchContext,
  };
}
