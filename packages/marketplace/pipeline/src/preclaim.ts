// SPDX-License-Identifier: MIT

import {
  validateRequirementsAgainstRunPinning as validateBackendRequirementsAgainstRunPinning,
  verifyPreclaim as verifyBackendPreclaim,
  type BackendCapabilities,
  type PreclaimNotClaimedReason,
  type PreclaimResult,
  type TaskExecutionBackend,
} from "@jinn-network/task-execution-backend";
import type { SubmissionFacts } from "./types.js";

export type { PreclaimNotClaimedReason, PreclaimResult };

/**
 * Validates declared requirements against the backend's `runPinning` inventory (profiles §5.2).
 * Returns the first unsupported key, if any.
 * @deprecated Import this neutral helper from `@jinn-network/task-execution-backend`.
 */
export function validateRequirementsAgainstRunPinning(
  requirements: Readonly<Record<string, unknown>>,
  runPinning: BackendCapabilities["runPinning"],
): string | undefined {
  return validateBackendRequirementsAgainstRunPinning(requirements, runPinning);
}

/**
 * Fail-closed backend capability + preflight gate (design §7). Runs after operator policy
 * gates and before any venue claim.
 * @deprecated Import `verifyPreclaim` from `@jinn-network/task-execution-backend` and pass a
 * `BackendPreclaimRequest`.
 */
export async function verifyPreclaim(
  facts: Pick<SubmissionFacts, "profileUri" | "requirements" | "runPinning">,
  backend: TaskExecutionBackend,
  capabilities: BackendCapabilities,
): Promise<PreclaimResult> {
  return verifyBackendPreclaim({
    taskProfile: facts.profileUri,
    requirements: facts.requirements,
    ...(facts.runPinning?.isolationPolicy === undefined
      ? {}
      : { requestedIsolationPolicy: facts.runPinning.isolationPolicy }),
  }, backend, capabilities);
}
