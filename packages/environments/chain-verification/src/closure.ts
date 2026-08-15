// SPDX-License-Identifier: Apache-2.0

import type { ChainVerificationFailureReason } from "./outcomes.js";

export type ClosureEvidenceMode = "fork-backend-refusal" | "sealed-boundary";

export interface ClosureAssessmentInput {
  readonly networkPolicy: {
    readonly egress: "denied";
    readonly dns: "absent";
    readonly archiveRpc: "unreachable";
    readonly forkBackend: "absent" | "present";
  };
  readonly egressAttempts: readonly {
    readonly target: string;
    readonly outcome: "refused" | "succeeded";
  }[];
  /** Present only for sealed instances: §4.2's boundary rule, observed. */
  readonly boundaryProbe?: {
    readonly probeId: string;
    readonly readsEmptyOutsideSlice: boolean;
  } | undefined;
  /** Digests of everything step 1 resolved. */
  readonly resolvedDigests: readonly string[];
  /** Digests of everything the instances actually loaded. */
  readonly loadedResources: readonly string[];
  /** Step 9's equality result. A sealed instance's closure evidence includes it. */
  readonly observationsEqual: boolean;
}

export interface ClosureAssessment {
  readonly mode: ClosureEvidenceMode;
  readonly closed: boolean;
  readonly reason?: ChainVerificationFailureReason;
  readonly detail?: string;
  /** Plain-language list of what the assessment rests on, for the attestation's reader. */
  readonly evidence: readonly string[];
}

/**
 * Design §5.1 step 2, both modes.
 *
 * A sealed instance has no fork backend at all, so no fetch can be attempted and the absence
 * of egress errors evidences nothing. Its closure rests on three positive facts: out-of-slice
 * reads are empty (§4.2's boundary rule), nothing outside the resolution log was loaded, and
 * the K observations agree.
 *
 * A fork-backed instance can attempt an upstream read, so the protocol provokes one and the
 * evidence is the recorded refusal. An attempt that succeeded is `offline-dependency-detected`
 * in either mode; so is a resource the resolution log never named.
 */
export function assessClosure(input: ClosureAssessmentInput): ClosureAssessment {
  const mode: ClosureEvidenceMode = input.networkPolicy.forkBackend === "present"
    ? "fork-backend-refusal"
    : "sealed-boundary";

  const succeeded = input.egressAttempts.find((attempt) => attempt.outcome === "succeeded");
  if (succeeded !== undefined) {
    return {
      mode,
      closed: false,
      reason: "egress-succeeded",
      detail: `egress to ${succeeded.target} succeeded`,
      evidence: [],
    };
  }

  const resolved = new Set(input.resolvedDigests);
  const stray = input.loadedResources.filter((digest) => !resolved.has(digest));
  if (stray.length > 0) {
    return {
      mode,
      closed: false,
      reason: "uncommitted-resource-loaded",
      detail: `loaded ${stray.length} resource(s) outside the resolution log: ${stray.join(", ")}`,
      evidence: [],
    };
  }

  if (mode === "fork-backend-refusal") {
    if (input.egressAttempts.length === 0) {
      return {
        mode,
        closed: false,
        reason: "fork-backend-fetch-unrefused",
        detail: "a fork-backed instance was not made to attempt an upstream read",
        evidence: [],
      };
    }
    return {
      mode,
      closed: true,
      evidence: [
        `${input.egressAttempts.length} upstream fetch attempt(s) refused`,
        "no resource outside the resolution log was loaded",
      ],
    };
  }

  // Sealed: three positive facts, none of which is "nothing went wrong".
  if (input.boundaryProbe === undefined || !input.boundaryProbe.readsEmptyOutsideSlice) {
    return {
      mode,
      closed: false,
      reason: "out-of-slice-read-not-empty",
      detail: input.boundaryProbe === undefined
        ? "a sealed instance was not probed for the boundary rule"
        : `probe ${input.boundaryProbe.probeId} did not read empty outside the slice`,
      evidence: [],
    };
  }
  if (!input.observationsEqual) {
    return {
      mode,
      closed: false,
      reason: "probe-observation-divergence",
      detail: "a sealed instance's closure rests on cross-run equality, which did not hold",
      evidence: [],
    };
  }
  return {
    mode,
    closed: true,
    evidence: [
      "out-of-slice reads are empty",
      "no resource outside the resolution log was loaded",
      "cross-run observation equality",
    ],
  };
}
