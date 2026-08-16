// SPDX-License-Identifier: Apache-2.0

import type {
  BenchmarkAnalysisManifest,
  DigestBearingResourceDescriptor,
  EvidenceCohort,
  EvidenceCohortMember,
  EvidenceRecordReference,
  MatrixV2Cell,
  SealedRecord,
  HumanLabelResolution,
} from "@jinn-network/benchmarking-protocol";
import type {
  ExecutionEvidenceDocument,
  ExecutionVerificationEvidence,
  ResultEvaluationEvidence,
} from "@jinn-network/evidence-protocol";

export interface ExactRecordResolver {
  resolve(reference: EvidenceRecordReference): Uint8Array;
}

export interface AdditionalEvidenceFamilyValidator {
  readonly family: "human-label-resolution";
  validate(bytes: Uint8Array): readonly CohortDiagnostic[];
}

export type CohortDiagnosticCode =
  | "COHORT_INVALID"
  | "MANIFEST_INVALID"
  | "RECORD_UNAVAILABLE"
  | "RECORD_DIGEST_MISMATCH"
  | "RECORD_NONCONFORMING"
  | "EXECUTION_SUBJECT_MISMATCH"
  | "EVALUATION_SUBJECT_MISMATCH"
  | "VERIFICATION_SUBJECT_MISMATCH"
  | "LABEL_RESOLUTION_INVALID"
  | "LABEL_RESOLUTION_SUBJECT_MISMATCH"
  | "LABEL_RESOLUTION_BASIS_MISMATCH"
  | "ADDITIONAL_VALIDATOR_REQUIRED"
  | "MATRIX_REPLAY_MISMATCH";

export interface CohortDiagnostic {
  readonly code: CohortDiagnosticCode;
  readonly path: string;
  readonly message: string;
}

export interface VerifiedExecution {
  readonly document: ExecutionEvidenceDocument;
  readonly bytes: Uint8Array;
  readonly taskDigest: `sha256:${string}`;
  readonly resultDigests: readonly `sha256:${string}`[];
  readonly executionId: string;
}

export interface VerifiedCohortMember {
  readonly member: EvidenceCohortMember;
  readonly execution: VerifiedExecution;
  readonly evaluations: ReadonlyMap<string, ResultEvaluationEvidence>;
  readonly verifications: ReadonlyMap<string, ExecutionVerificationEvidence>;
  readonly labelResolutions: ReadonlyMap<string, HumanLabelResolution>;
}

export interface VerifiedEvidenceCohort {
  readonly conforms: true;
  readonly cohort: EvidenceCohort;
  readonly manifest: BenchmarkAnalysisManifest;
  readonly members: readonly VerifiedCohortMember[];
  readonly diagnostics: readonly [];
}

export interface InvalidEvidenceCohort {
  readonly conforms: false;
  readonly diagnostics: readonly CohortDiagnostic[];
}

export type EvidenceCohortVerification =
  | VerifiedEvidenceCohort
  | InvalidEvidenceCohort;

export interface VerifyEvidenceCohortInput {
  readonly cohortBytes: Uint8Array;
  readonly manifestBytes: Uint8Array;
  readonly records: ExactRecordResolver;
  readonly additionalValidators?: readonly AdditionalEvidenceFamilyValidator[];
}

export interface MatrixCellDerivationContext {
  readonly manifest: BenchmarkAnalysisManifest;
  readonly cohort: EvidenceCohort;
  readonly member: VerifiedCohortMember;
}

export type DerivedMatrixCell = Omit<
  MatrixV2Cell,
  | "memberKey"
  | "groupId"
  | "slotId"
  | "replicate"
  | "execution"
  | "taskDigest"
  | "resultDigests"
  | "consideredEvaluations"
  | "admittedEvaluations"
  | "consideredVerifications"
  | "admittedVerifications"
  | "admittedLabelResolutions"
>;

export interface AssembleEvidenceMatrixInput extends VerifyEvidenceCohortInput {
  readonly implementation: DigestBearingResourceDescriptor;
  deriveCell(context: MatrixCellDerivationContext): DerivedMatrixCell;
}

export interface AssembledEvidenceMatrix {
  readonly record: SealedRecord;
  readonly verification: VerifiedEvidenceCohort;
}

export interface VerifyEvidenceMatrixInput extends AssembleEvidenceMatrixInput {
  readonly matrixBytes: Uint8Array;
}
