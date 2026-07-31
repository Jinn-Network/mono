// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";

/**
 * The closed admission refusal taxonomy. Small on purpose: a consumer routes on these codes, so
 * every addition is a contract change. Sorted by code so the tuple reads as the closed set it is.
 *
 * - `duplicate-assertion-id`  a raw assertion identifier was observed under more than one test
 *   path, so per-path evidence cannot be attributed.
 * - `env-record-mismatch`     the candidate's inline environment fields, or its
 *   environment-record reference, do not equal the record admission was given (design §7.1,
 *   normative rule 1).
 * - `execution-failed`        the injected runner did not produce a usable observation for a
 *   required cell: it threw, or it reported applying material other than the candidate's
 *   declared gold patch.
 * - `invalid-candidate`       the candidate is structurally unusable: wrong grader family, a
 *   malformed inline block, a digest in the wrong spelling, an unsafe test path, a repeated test
 *   path, EvaluationSpec bytes that are not the document's canonical sealing, or inline test
 *   material that is not the material the candidate declares.
 * - `invalid-environment-record`  the supplied record bytes do not parse, or the record does not
 *   support per-path targeted admission (no single targetable test command).
 * - `no-discrimination`       a test path produced no fail-to-pass assertion, or the candidate
 *   declares none: the suite does not discriminate, so there is nothing to admit.
 * - `transitions-mismatch`    the candidate's declared transitions are not the ones its
 *   EvaluationSpec grades against, or are not the ones its observations prove (design §7.1,
 *   first bullet — the proof is scoped to *the candidate's* fail-to-pass and pass-to-pass tests).
 * - `unstable-observations`   the two repeats on a side were not canonical-JSON identical.
 */
export const ADMISSION_REFUSAL_CODES = [
  "duplicate-assertion-id",
  "env-record-mismatch",
  "execution-failed",
  "invalid-candidate",
  "invalid-environment-record",
  "no-discrimination",
  "transitions-mismatch",
  "unstable-observations",
] as const;

export type AdmissionRefusalCode = (typeof ADMISSION_REFUSAL_CODES)[number];

export const AdmissionRefusalCodeSchema = z.enum(ADMISSION_REFUSAL_CODES);

export interface AdmissionRefusal {
  readonly code: AdmissionRefusalCode;
  readonly detail: string;
}

/**
 * Internal control-flow carrier. Refusals are *returned* at the `admitCandidate` boundary; this
 * error exists so deep checks can fail closed without threading result types through every call.
 */
export class AdmissionRefusalError extends Error {
  readonly refusal: AdmissionRefusal;

  constructor(code: AdmissionRefusalCode, detail: string) {
    super(`${code}: ${detail}`);
    this.name = "AdmissionRefusalError";
    this.refusal = { code, detail };
  }
}

export function refuse(code: AdmissionRefusalCode, detail: string): never {
  throw new AdmissionRefusalError(code, detail);
}
