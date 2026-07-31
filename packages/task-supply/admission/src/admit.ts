// SPDX-License-Identifier: Apache-2.0

import {
  environmentRecordDigest,
  parseEnvironmentRecord,
  type EnvironmentRecord,
} from "@jinn-network/environment-record";
import { canonicalJsonBytes, recordDigest } from "@jinn-network/trust-core";
import { ADMISSION_RECEIPT_SCHEMA_VERSION, DIFFERENTIAL_ADMISSION_POLICY_V3 } from "./identifiers.js";
import { checkInlineEnvironmentMatch } from "./inline-match.js";
import { deriveTransitions, stableObservation } from "./observations.js";
import {
  verifyDifferentialAdmissionReceiptV3,
  type DifferentialAdmissionReceiptV3,
} from "./receipt.js";
import { AdmissionRefusalError, type AdmissionRefusal } from "./refusals.js";
import { normalizeRepositoryPath, targetTestCommandForPath, type CommandSpec } from "./test-paths.js";

/** Which material a run applies. A selector, never content: admission holds no patch bytes. */
export type PatchSelector =
  | { readonly kind: "none" }
  | { readonly kind: "gold"; readonly digest: `sha256:${string}` };

export interface EnvironmentRunRequest {
  readonly environmentRecordDigest: `sha256:${string}`;
  readonly command: CommandSpec;
  readonly patch: PatchSelector;
  readonly testMaterialDigests: readonly `sha256:${string}`[];
  readonly testPath: string;
  /** 1 or 2 — the repeat index within a side, so a runner can start a fresh container. */
  readonly attempt: 1 | 2;
  readonly signal?: AbortSignal;
}

export interface EnvironmentRunObservation {
  readonly passed: readonly string[];
  readonly failed: readonly string[];
  readonly passedMatch: boolean;
  /** The digest of the material the runner actually applied; `null` for the empty side. */
  readonly appliedPatchDigest: `sha256:${string}` | null;
}

/**
 * The one port admission needs. Admission does not own Docker, a workspace, or a parser — a host
 * supplies this, and everything else here is pure orchestration over what it returns.
 */
export type RunInEnvironmentPort = (
  request: EnvironmentRunRequest,
) => Promise<EnvironmentRunObservation>;

export interface AdmissionDeps {
  readonly runInEnvironment: RunInEnvironmentPort;
  /** The admitting agent IRI written into the receipt (and the signed statement's issuer). */
  readonly issuer: string;
  readonly signal?: AbortSignal;
}

export interface AdmissionCandidate {
  /** Digest of the sealed Task document. */
  readonly taskDocumentDigest: `sha256:${string}`;
  /** Digest of the task's statement material. */
  readonly statementDigest: `sha256:${string}`;
  readonly testMaterialDigests: readonly `sha256:${string}`[];
  readonly transitions: {
    readonly failToPass: readonly string[];
    readonly passToPass: readonly string[];
  };
  /** A digest, always. The gold patch itself never enters this package. */
  readonly goldPatchHash: `sha256:${string}`;
  /** The exact sealed EvaluationSpec bytes; their digest is the receipt's spec subject. */
  readonly evaluationSpecBytes: Uint8Array;
  readonly testPaths: readonly string[];
  readonly evalSemanticsVersion: string;
}

export type AdmissionResult =
  | { readonly receipt: DifferentialAdmissionReceiptV3 }
  | { readonly refusal: AdmissionRefusal };

function parseRecord(bytes: Uint8Array): EnvironmentRecord {
  try {
    return parseEnvironmentRecord(bytes);
  } catch (cause) {
    throw new AdmissionRefusalError(
      "invalid-environment-record",
      `the supplied environment record does not parse: ${String(cause)}`,
    );
  }
}

function parseSpec(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch (cause) {
    throw new AdmissionRefusalError(
      "invalid-candidate",
      `the candidate EvaluationSpec bytes are not UTF-8 JSON: ${String(cause)}`,
    );
  }
}

async function observeSide(
  deps: AdmissionDeps,
  request: Omit<EnvironmentRunRequest, "attempt">,
): Promise<EnvironmentRunObservation[]> {
  const observations: EnvironmentRunObservation[] = [];
  for (let attempt = 1; attempt <= DIFFERENTIAL_ADMISSION_POLICY_V3.observationsPerSide; attempt += 1) {
    let observation: EnvironmentRunObservation;
    try {
      observation = await deps.runInEnvironment({ ...request, attempt: attempt as 1 | 2 });
    } catch (cause) {
      throw new AdmissionRefusalError(
        "execution-failed",
        `run ${attempt} of ${request.patch.kind} for ${request.testPath} failed: ${String(cause)}`,
      );
    }
    const expected = request.patch.kind === "gold" ? request.patch.digest : null;
    if (observation.appliedPatchDigest !== expected) {
      throw new AdmissionRefusalError(
        "execution-failed",
        `run ${attempt} of ${request.patch.kind} for ${request.testPath} applied `
          + `${String(observation.appliedPatchDigest)}, not ${String(expected)}`,
      );
    }
    observations.push(observation);
  }
  return observations;
}

function observationBody(observation: EnvironmentRunObservation): unknown {
  return {
    passed: [...observation.passed],
    failed: [...observation.failed],
    passedMatch: observation.passedMatch,
  };
}

/**
 * Candidate + environment record -> receipt, or a refusal from the closed taxonomy. Source-agnostic
 * by construction: nothing here knows whether the candidate was imported, injected, or mined.
 */
export async function admitCandidate(
  deps: AdmissionDeps,
  candidate: AdmissionCandidate,
  environmentRecordBytes: Uint8Array,
): Promise<AdmissionResult> {
  try {
    const record = parseRecord(environmentRecordBytes);
    const environmentDigest = environmentRecordDigest(environmentRecordBytes) as `sha256:${string}`;
    const evaluationSpecDigest = recordDigest(candidate.evaluationSpecBytes);
    const inlineMatch = checkInlineEnvironmentMatch(
      record,
      parseSpec(candidate.evaluationSpecBytes),
      environmentDigest,
    );

    const testPaths = [];
    for (const rawPath of candidate.testPaths) {
      const command = targetTestCommandForPath(record, rawPath);
      const testPath = normalizeRepositoryPath(rawPath, "test path");
      const base = {
        environmentRecordDigest: environmentDigest,
        command,
        testMaterialDigests: candidate.testMaterialDigests,
        testPath,
        ...(deps.signal === undefined ? {} : { signal: deps.signal }),
      };
      const brokenRuns = await observeSide(deps, { ...base, patch: { kind: "none" } });
      const fixedRuns = await observeSide(deps, {
        ...base,
        patch: { kind: "gold", digest: candidate.goldPatchHash },
      });
      const broken = stableObservation(brokenRuns.map(observationBody), "broken", testPath);
      const fixed = stableObservation(fixedRuns.map(observationBody), "fixed", testPath);
      testPaths.push({
        testPath,
        commandHash: recordDigest(canonicalJsonBytes(command)),
        broken: [broken, broken],
        fixed: [fixed, fixed],
        ...deriveTransitions(broken, fixed),
      });
    }

    return {
      receipt: verifyDifferentialAdmissionReceiptV3({
        schemaVersion: ADMISSION_RECEIPT_SCHEMA_VERSION,
        admissionPolicyVersion: DIFFERENTIAL_ADMISSION_POLICY_V3.admissionPolicyVersion,
        issuer: deps.issuer,
        task: {
          documentDigest: candidate.taskDocumentDigest,
          evaluationSpecDigest,
          statementDigest: candidate.statementDigest,
          testMaterialDigests: [...candidate.testMaterialDigests],
          transitions: {
            failToPass: [...candidate.transitions.failToPass],
            passToPass: [...candidate.transitions.passToPass],
          },
        },
        goldPatchHash: candidate.goldPatchHash,
        testPaths,
        environment: { recordDigest: environmentDigest, inlineMatch },
        evalSemanticsVersion: candidate.evalSemanticsVersion,
      }),
    };
  } catch (error) {
    if (error instanceof AdmissionRefusalError) return { refusal: error.refusal };
    throw error;
  }
}
