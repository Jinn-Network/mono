// SPDX-License-Identifier: MIT
import {
  validateExecutionEvidence,
  validateExecutionVerification,
  validateResultEvaluation,
  type ConformanceDiagnostic,
  type ExecutionVerificationEvidence,
  type ResultEvaluationEvidence,
  type ValidationReport,
} from "@jinn-network/evidence-protocol";
import type {
  CatalogRecordProjection,
  CatalogResourceSubject,
} from "../catalog/index.js";
import type {
  EvidenceRecordReference,
  Sha256Digest,
} from "@jinn-network/evidence-repository";

import { EvidenceIndexerError } from "./errors.js";
import { projectExecutionEvidence } from "./project-execution.js";
import { projectResultEvaluation } from "./project-evaluation.js";
import { projectExecutionVerification } from "./project-verification.js";

type ResourceDescriptor =
  ResultEvaluationEvidence["statement"]["subject"][number];

export function projectResourceDescriptor(
  descriptor: ResourceDescriptor,
): CatalogResourceSubject {
  return {
    name: descriptor.name,
    digest: `sha256:${descriptor.digest.sha256}`,
    ...(descriptor.uri === undefined ? {} : { uri: descriptor.uri }),
    ...(descriptor.mediaType === undefined
      ? {}
      : { mediaType: descriptor.mediaType }),
  };
}

export type EvidenceProjectionValidationResult =
  | {
      readonly conforms: true;
      readonly projection: CatalogRecordProjection;
    }
  | {
      readonly conforms: false;
      readonly diagnostics: readonly ConformanceDiagnostic[];
    };

function assertMatchingReference(
  report: ValidationReport<unknown>,
  reference: EvidenceRecordReference,
): void {
  if (report.recordDigest !== reference.digest) {
    throw new EvidenceIndexerError(
      "REFERENCE_MISMATCH",
      "The validated record digest does not match the requested reference.",
    );
  }
}

function inconsistent(): never {
  throw new EvidenceIndexerError(
    "VALIDATED_RECORD_INCONSISTENT",
    "A conforming Evidence Protocol report did not contain a validated value.",
  );
}

export function validateAndProjectEvidenceRecord(
  reference: EvidenceRecordReference,
  bytes: Uint8Array,
): EvidenceProjectionValidationResult {
  if (reference.family === "execution-evidence") {
    const report = validateExecutionEvidence(bytes);
    assertMatchingReference(report, reference);
    if (!report.conforms) {
      return { conforms: false, diagnostics: report.diagnostics };
    }
    if (report.value === undefined) inconsistent();
    return {
      conforms: true,
      projection: projectExecutionEvidence(
        {
          family: "execution-evidence",
          digest: reference.digest,
        },
        bytes.byteLength,
        report.value,
      ),
    };
  }

  if (reference.family === "result-evaluation") {
    const report = validateResultEvaluation(bytes);
    assertMatchingReference(report, reference);
    if (!report.conforms) {
      return { conforms: false, diagnostics: report.diagnostics };
    }
    if (report.value === undefined) inconsistent();
    return {
      conforms: true,
      projection: projectResultEvaluation(
        {
          family: "result-evaluation",
          digest: reference.digest,
        },
        bytes.byteLength,
        report.value,
      ),
    };
  }

  if (reference.family === "execution-verification") {
    const report = validateExecutionVerification(bytes);
    assertMatchingReference(report, reference);
    if (!report.conforms) {
      return { conforms: false, diagnostics: report.diagnostics };
    }
    if (report.value === undefined) inconsistent();
    return {
      conforms: true,
      projection: projectExecutionVerification(
        {
          family: "execution-verification",
          digest: reference.digest,
        },
        bytes.byteLength,
        report.value,
      ),
    };
  }

  throw new EvidenceIndexerError(
    "REFERENCE_MISMATCH",
    "The record reference has an unsupported Evidence Protocol family.",
  );
}

export function executionRecordDigest(
  evidence: ExecutionVerificationEvidence,
): Sha256Digest {
  return `sha256:${evidence.statement.subject[0]!.digest.sha256}`;
}
