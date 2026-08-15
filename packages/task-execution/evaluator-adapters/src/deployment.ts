// SPDX-License-Identifier: Apache-2.0

import {
  validateEvaluatorRegistrationSet,
  type EvaluationHarnessDeployment,
  type EvidenceRepositoryWriter,
  type ResourceDescriptor,
} from "@jinn-network/task-execution-evaluation-harness";
import { contextResolutionSnapshotSource } from "./prediction/adapter.js";
import { evaluatorAdaptersParserAllowlist } from "./parser-identity.js";
import {
  createPredictionEvaluatorRegistration,
  createSweRebenchEvaluatorRegistration,
} from "./registrations.js";
import {
  contextGraderReportSource,
  type GraderReportSource,
} from "./swe-rebench/adapter.js";

export interface EvaluatorDeploymentOptions {
  /** Deployment-owned evaluator identity; it is never inferred from Task material. */
  readonly evaluatorId: string;
  /** Deployment-owned signing handle, resolved by later host-owned composition. */
  readonly signerHandle: string;
  /** Explicit immutable evaluator method descriptor supplied by trusted deployment configuration. */
  readonly evaluationMethod: ResourceDescriptor;
  /** Host-owned evidence writer; adapters never open a repository or manufacture evidence. */
  readonly evidenceWriter: EvidenceRepositoryWriter;
  /** Explicit deployment cap for evidence written for a single evaluator claim. */
  readonly maxClaimEvidenceBytes: number;
  /** Host-owned live grader seam. Omitted deployments retain the context-backed test adapter. */
  readonly sweRebenchGraderReportSource?: GraderReportSource;
}

function requireNonEmpty(value: string, label: string): void {
  if (value.trim().length === 0) throw new Error(`createEvaluatorDeployment requires ${label}`);
}

function requirePositiveSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`createEvaluatorDeployment requires a positive safe integer ${label}`);
  }
}

/**
 * Produces the host-facing evaluator deployment boundary. It selects no configuration from
 * untrusted Task bytes and starts no runtime; all authority comes from the caller's trusted
 * deployment configuration.
 */
export function createEvaluatorDeployment(
  options: EvaluatorDeploymentOptions,
): EvaluationHarnessDeployment {
  requireNonEmpty(options.evaluatorId, "evaluatorId");
  requireNonEmpty(options.signerHandle, "signerHandle");
  requirePositiveSafeInteger(options.maxClaimEvidenceBytes, "maxClaimEvidenceBytes");
  const registrations = validateEvaluatorRegistrationSet([
    createSweRebenchEvaluatorRegistration({
      evaluatorId: options.evaluatorId,
      signerHandle: options.signerHandle,
      evaluationMethod: options.evaluationMethod,
      graderReportSource: options.sweRebenchGraderReportSource ?? contextGraderReportSource(),
    }),
    createPredictionEvaluatorRegistration({
      evaluatorId: options.evaluatorId,
      signerHandle: options.signerHandle,
      evaluationMethod: options.evaluationMethod,
      resolutionSnapshotSource: contextResolutionSnapshotSource(),
    }),
  ]);
  return Object.freeze({
    registrations,
    parserAllowlist: evaluatorAdaptersParserAllowlist(),
    evidenceWriter: options.evidenceWriter,
    maxClaimEvidenceBytes: options.maxClaimEvidenceBytes,
  });
}
