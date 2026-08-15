// SPDX-License-Identifier: MIT

import { parseExactCandidateManifest } from "@jinn-network/policy-identity";
import { admitCandidate } from "../admission/admit.js";
import type {
  AdmissionConsent,
  AdmissionRequest,
  AdmissionResult,
} from "../admission/types.js";
import type { PayloadClass } from "../admission/payload-class.js";
import { refuse } from "../errors.js";

export interface LiveLocalCandidateBoundary {
  readonly source: "locally-proposed" | "imported";
  readonly localOperatorId: string;
  readonly manifestBytes: Uint8Array;
  readonly approvedExecutableClasses: readonly PayloadClass[];
}

/**
 * v0's disclosed-independence boundary is intentionally narrow: a manifest must have been
 * produced inside this operator's campaign and must name this operator as proposer. Signatures do
 * not widen that boundary. Executable payload classes still require positive, admission-time
 * consent even though the proposer and operator are the same person.
 */
export function assertLiveLocalCandidateBoundary(
  input: LiveLocalCandidateBoundary,
): AdmissionConsent {
  if (input.source !== "locally-proposed") {
    refuse("manifest-invalid", "candidate.source", "v0 hard-refuses imported candidates");
  }
  if (input.localOperatorId.length === 0) {
    refuse("manifest-invalid", "candidate.operator", "the local operator identity is required");
  }
  const manifest = parseExactCandidateManifest(input.manifestBytes);
  if (manifest.proposer !== input.localOperatorId) {
    refuse(
      "manifest-invalid",
      "candidate.proposer",
      "v0 hard-refuses cross-operator candidates even when they carry a valid signature",
    );
  }
  return {
    crossOperator: false,
    requireExecutableChangeConsent: true,
    approvedPayloadClasses: [...new Set(input.approvedExecutableClasses)].sort(),
  };
}

/** The only live-host entry point into the neutral candidate admission engine. */
export async function admitLiveLocalCandidate(input: {
  readonly boundary: LiveLocalCandidateBoundary;
  readonly request: Omit<AdmissionRequest, "manifestBytes" | "consent" | "signature">;
}): Promise<AdmissionResult> {
  const consent = assertLiveLocalCandidateBoundary(input.boundary);
  return admitCandidate({
    ...input.request,
    manifestBytes: input.boundary.manifestBytes,
    consent,
  });
}
