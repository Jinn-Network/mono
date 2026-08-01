// SPDX-License-Identifier: Apache-2.0

import {
  validateEvaluatorRegistrationSet,
  type EvaluationHarnessDeployment,
  type EvidenceRepositoryWriter,
} from "@jinn-network/task-execution-evaluation-harness";
import { contextResolutionSnapshotSource } from "./prediction/adapter.js";
import { evaluatorAdaptersParserAllowlist } from "./parser-identity.js";
import {
  createPredictionEvaluatorRegistration,
  createSweRebenchEvaluatorRegistration,
} from "./registrations.js";
import { contextGraderReportSource } from "./swe-rebench/adapter.js";

/** Claim-evidence bound: a capped grader log plus headroom, well under any repository limit. */
export const DEFAULT_MAX_CLAIM_EVIDENCE_BYTES = 4 * 1024 * 1024;

const EVALUATION_METHOD = {
  name: "evaluator-adapters",
  digest: { sha256: "9".repeat(64) },
  uri: "https://jinn.network/software/evaluator-adapters/v1",
} as const;

export interface EvaluatorDeploymentOptions {
  /** Host-owned evidence repository writer; this package never opens a repository itself. */
  readonly evidenceWriter: EvidenceRepositoryWriter;
  readonly maxClaimEvidenceBytes?: number;
  /** Logical grant handle resolved beneath the Attempt's `secrets/` at signing time. */
  readonly signerHandle?: string;
  readonly evaluatorId?: string;
}

/**
 * The host-facing composition surface: every adapter this package ships, plus the parser
 * allowlist the harness enforces for deterministic-process specs.
 */
export function createEvaluatorDeployment(
  options: EvaluatorDeploymentOptions,
): EvaluationHarnessDeployment {
  const signerHandle = options.signerHandle ?? "evaluator-signing-key";
  const evaluatorId =
    options.evaluatorId ??
    "did:key:z6MkhzYwRj8TvZEp41ApnVVDN5a5hBCk8tQYp4w7vGkVn5F8";
  const registrations = validateEvaluatorRegistrationSet([
    createSweRebenchEvaluatorRegistration({
      evaluatorId,
      signerHandle,
      evaluationMethod: EVALUATION_METHOD,
      graderReportSource: contextGraderReportSource(),
    }),
    createPredictionEvaluatorRegistration({
      evaluatorId,
      signerHandle,
      evaluationMethod: EVALUATION_METHOD,
      resolutionSnapshotSource: contextResolutionSnapshotSource(),
    }),
  ]);
  return Object.freeze({
    registrations,
    parserAllowlist: evaluatorAdaptersParserAllowlist(),
    evidenceWriter: options.evidenceWriter,
    maxClaimEvidenceBytes:
      options.maxClaimEvidenceBytes ?? DEFAULT_MAX_CLAIM_EVIDENCE_BYTES,
  });
}
