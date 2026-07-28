import {
  recordDigest,
  validateExecutionEvidence,
  validateExecutionVerification,
  validateResultEvaluation,
  type ConformanceDiagnostic,
} from "@jinn-network/evidence-protocol";
import {
  parseEvidenceRecordReference,
  type EvidenceRecordReference,
} from "@jinn-network/evidence-repository";

import type {
  EvidenceRetrievalFailure,
  ValidatedRecord,
} from "./contracts.js";
import { createEvidenceRetrievalFailure } from "./errors.js";

export type CanonicalRecordValidation =
  | {
      readonly ok: true;
      readonly canonicalBytes: Uint8Array;
      readonly validatedRecord: ValidatedRecord;
    }
  | {
      readonly ok: false;
      readonly failure: EvidenceRetrievalFailure;
    };

function nonconforming(
  reference: EvidenceRecordReference,
  report: { readonly diagnostics: readonly ConformanceDiagnostic[] },
): CanonicalRecordValidation {
  return {
    ok: false,
    failure: createEvidenceRetrievalFailure({
      code: "PROTOCOL_NONCONFORMING",
      stage: "validation",
      message: "Record bytes do not conform to the declared Evidence family.",
      reference,
      conformanceDiagnostics: report.diagnostics,
    }),
  };
}

export function validateCanonicalRecord(
  untrustedReference: EvidenceRecordReference,
  bytes: Uint8Array,
  maxRecordBytes: number,
): CanonicalRecordValidation {
  const reference = parseEvidenceRecordReference(untrustedReference);
  if (bytes.byteLength > maxRecordBytes) {
    return {
      ok: false,
      failure: createEvidenceRetrievalFailure({
        code: "RECORD_TOO_LARGE",
        stage: "record",
        message: `Record exceeds the ${maxRecordBytes}-byte operation limit.`,
        reference,
      }),
    };
  }
  if (recordDigest(bytes) !== reference.digest) {
    return {
      ok: false,
      failure: createEvidenceRetrievalFailure({
        code: "RECORD_DIGEST_MISMATCH",
        stage: "record",
        message: "Record bytes do not match the canonical reference digest.",
        reference,
      }),
    };
  }

  if (reference.family === "execution-evidence") {
    const report = validateExecutionEvidence(bytes);
    return report.conforms && report.value
      ? {
          ok: true,
          canonicalBytes: Uint8Array.from(bytes),
          validatedRecord: { family: reference.family, value: report.value },
        }
      : nonconforming(reference, report);
  }
  if (reference.family === "result-evaluation") {
    const report = validateResultEvaluation(bytes);
    return report.conforms && report.value
      ? {
          ok: true,
          canonicalBytes: Uint8Array.from(bytes),
          validatedRecord: { family: reference.family, value: report.value },
        }
      : nonconforming(reference, report);
  }
  const report = validateExecutionVerification(bytes);
  return report.conforms && report.value
    ? {
        ok: true,
        canonicalBytes: Uint8Array.from(bytes),
        validatedRecord: { family: reference.family, value: report.value },
      }
    : nonconforming(reference, report);
}
