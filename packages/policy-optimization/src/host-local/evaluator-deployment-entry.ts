// SPDX-License-Identifier: MIT

import { join } from "node:path";
import { createEvaluatorDeployment } from "@jinn-network/task-execution-evaluator-adapters";
import { prefixedDigest } from "@jinn-network/policy-identity";
import { secureAtomicWrite } from "./state.js";
import {
  LOCAL_SWE_REBENCH_EVALUATION_METHOD,
  liveSweRebenchGraderReportSource,
} from "./swe-rebench-grader-source.js";

export const LIVE_EVALUATOR_ID =
  "urn:jinn:policy-optimization:local-evaluator-role" as const;
export const LIVE_EVALUATOR_REGISTRATION_ID = "swe-rebench-v2" as const;

function evidenceOutputRoot(): string {
  const root = process.env["JINN_ATTEMPT_OUT"];
  if (root === undefined || root.length === 0) {
    throw new TypeError("live evaluator deployment requires JINN_ATTEMPT_OUT");
  }
  return join(root, "claim-evidence");
}

/**
 * Spawned by the evaluator-only backend. It owns no signer and receives no credential material:
 * its single authority is to run the pinned, network-disabled grader and emit unsigned canonical
 * bytes. The parent host verifies every binding and signs those bytes afterward.
 */
export const evaluationHarnessDeployment = createEvaluatorDeployment({
  evaluatorId: LIVE_EVALUATOR_ID,
  signerHandle: "host-signs-after-exact-verification",
  evaluationMethod: LOCAL_SWE_REBENCH_EVALUATION_METHOD,
  maxClaimEvidenceBytes: 1024 * 1024,
  sweRebenchGraderReportSource: liveSweRebenchGraderReportSource(),
  evidenceWriter: {
    async putClaimEvidence(input) {
      const digest = prefixedDigest(input.bytes);
      const path = join(evidenceOutputRoot(), digest.slice("sha256:".length));
      secureAtomicWrite(path, input.bytes, true);
      return {
        name: input.name,
        uri: `urn:jinn:policy-optimization:claim-evidence:${digest}`,
        digest: { sha256: digest.slice("sha256:".length) },
        ...(input.mediaType === undefined ? {} : { mediaType: input.mediaType }),
      };
    },
  },
});
