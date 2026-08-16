// SPDX-License-Identifier: Apache-2.0

import {
  MATRIX_V2_ASSEMBLY_PROCEDURE,
  MATRIX_V2_ASSEMBLY_VERSION,
  documentDigest,
  parseMatrixV2,
  sealMatrixV2,
  type EvidenceCohortMember,
  type EvidenceRecordReference,
  type MatrixV2,
} from "@jinn-network/benchmarking-protocol";

import type {
  AssembleEvidenceMatrixInput,
  AssembledEvidenceMatrix,
  CohortDiagnostic,
  VerifyEvidenceMatrixInput,
  DerivedMatrixCell,
  MatrixCellDerivationContext,
} from "./types.js";
import { verifyEvidenceCohort } from "./verify.js";

function selected(selection: EvidenceCohortMember["evaluations"]): EvidenceRecordReference[] {
  return [...selection.admitted];
}

/** Registered assembly-3.0 default: claims select outcomes; trust remains orthogonal. */
export function deriveDefaultEvidenceCell(
  context: MatrixCellDerivationContext,
): DerivedMatrixCell {
  const { member } = context;
  const resolutions = member.member.labelResolutions.admitted.flatMap((reference) => {
    const value = member.labelResolutions.get(`${reference.family}\u0000${reference.record.digest.sha256}`);
    return value === undefined ? [] : [value];
  });
  let outcome: DerivedMatrixCell["outcome"];
  if (resolutions.length === 1 && resolutions[0]!.resolution.status === "admitted") {
    outcome = resolutions[0]!.resolution.label === "ACCEPT" ? "accepted" : "rejected";
  } else {
    const verdicts = member.member.evaluations.admitted.flatMap((reference) => {
      const value = member.evaluations.get(`${reference.family}\u0000${reference.record.digest.sha256}`);
      return value === undefined ? [] : [value.statement.predicate.verdict];
    });
    const decisive = new Set(verdicts.filter((value) => value !== "inconclusive"));
    outcome = decisive.size > 1 ? "inconclusive"
      : decisive.has("pass") ? "accepted"
        : decisive.has("fail") ? "rejected"
          : verdicts.length > 0 ? "inconclusive" : "unjudged";
  }
  return {
    outcome,
    integrity: member.member.assurance.availability === "public-exact"
      ? "re-derivable"
      : member.member.assurance.availability === "digest-only"
        ? "attested-only"
        : member.member.assurance.closure === "partial" ? "partial" : "indeterminate",
    measurements: [],
    trust: {
      signatureValid: "unknown",
      identityBound: "unknown",
      purposeAuthorized: "unknown",
      policyTrusted: "unknown",
      partyIndependenceEstablished: "unknown",
    },
    disclosures: [...member.member.assurance.limitations].sort(),
  };
}

function matrixDocument(input: AssembleEvidenceMatrixInput): {
  matrix: MatrixV2;
  verification: ReturnType<typeof verifyEvidenceCohort>;
} {
  const verification = verifyEvidenceCohort(input);
  if (!verification.conforms) {
    throw new EvidenceMatrixAssemblyError(verification.diagnostics);
  }
  const cells = verification.members.map((verified) => {
    const { member } = verified;
    return {
      memberKey: member.memberKey,
      groupId: member.groupId,
      slotId: member.slotId,
      replicate: member.replicate,
      execution: member.execution,
      taskDigest: member.taskDigest,
      resultDigests: [...member.resultDigests],
      consideredEvaluations: [...member.evaluations.considered],
      admittedEvaluations: selected(member.evaluations),
      consideredVerifications: [...member.verifications.considered],
      admittedVerifications: selected(member.verifications),
      admittedLabelResolutions: selected(member.labelResolutions),
      ...input.deriveCell({
        manifest: verification.manifest,
        cohort: verification.cohort,
        member: verified,
      }),
    };
  });
  return {
    matrix: {
      protocol: verification.cohort.protocol,
      manifest: verification.cohort.manifest,
      cohort: {
        name: "Evidence Cohort",
        digest: { sha256: documentDigest(input.cohortBytes).slice(7) },
      },
      cells,
      completeness: {
        expected: verification.cohort.closure.candidateCount,
        admitted: verification.cohort.closure.admittedCount,
        excluded: verification.cohort.closure.excludedCount,
        unavailable: verification.cohort.closure.unavailableCount,
        status: verification.cohort.closure.status === "complete-relative-to-sealed-source"
          ? "complete"
          : verification.cohort.closure.status,
      },
      assembly: {
        procedure: MATRIX_V2_ASSEMBLY_PROCEDURE,
        version: MATRIX_V2_ASSEMBLY_VERSION,
        implementation: input.implementation,
      },
    },
    verification,
  };
}

export class EvidenceMatrixAssemblyError extends Error {
  constructor(readonly diagnostics: readonly CohortDiagnostic[]) {
    super("evidence cohort cannot be assembled");
    this.name = "EvidenceMatrixAssemblyError";
  }
}

export function assembleEvidenceMatrix(
  input: AssembleEvidenceMatrixInput,
): AssembledEvidenceMatrix {
  const { matrix, verification } = matrixDocument(input);
  return { record: sealMatrixV2(matrix), verification } as AssembledEvidenceMatrix;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function verifyEvidenceMatrix(
  input: VerifyEvidenceMatrixInput,
): { readonly conforms: true; readonly matrix: MatrixV2 } |
  { readonly conforms: false; readonly diagnostics: readonly CohortDiagnostic[] } {
  let parsed: MatrixV2;
  try {
    parsed = parseMatrixV2(input.matrixBytes);
  } catch (error) {
    return {
      conforms: false,
      diagnostics: [{
        code: "MATRIX_REPLAY_MISMATCH",
        path: "",
        message: error instanceof Error ? error.message : "invalid Matrix v2",
      }],
    };
  }
  let replayed: AssembledEvidenceMatrix;
  try {
    replayed = assembleEvidenceMatrix(input);
  } catch (error) {
    return {
      conforms: false,
      diagnostics: error instanceof EvidenceMatrixAssemblyError
        ? error.diagnostics
        : [{ code: "MATRIX_REPLAY_MISMATCH", path: "", message: "matrix replay failed" }],
    };
  }
  if (!equalBytes(input.matrixBytes, replayed.record.bytes)) {
    return {
      conforms: false,
      diagnostics: [{
        code: "MATRIX_REPLAY_MISMATCH",
        path: "",
        message: "Matrix bytes differ from deterministic assembly procedure 3.0 replay",
      }],
    };
  }
  return { conforms: true, matrix: parsed };
}
