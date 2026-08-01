// SPDX-License-Identifier: Apache-2.0

import { canonicalJsonBytes, recordDigest } from "@jinn-network/trust-core";
import {
  ChainObservationPort,
  type ChainObservation,
  type ChainObservationRequest,
} from "./chain-observations.js";
import { readStatePredicateSpec } from "./chain-spec-reader.js";
import {
  ChainAdmissionRefusalError,
  refuseChain,
  type ChainAdmissionRefusal,
} from "./chain-refusals.js";
import { CHAIN_ADMISSION_POLICY_V1, CHAIN_ADMISSION_RECEIPT_SCHEMA_VERSION } from "./identifiers.js";
import {
  verifyChainAdmissionReceiptV1,
  type ChainAdmissionReceiptV1,
} from "./chain-receipt.js";

export interface ChainAdmissionCandidate {
  readonly taskDocumentDigest: `sha256:${string}`;
  readonly statementDigest: `sha256:${string}`;
  /** A digest, always. The reference script itself never enters this package. */
  readonly referenceScriptDigest: `sha256:${string}`;
  /** The exact sealed EvaluationSpec bytes; their digest is the receipt's spec subject. */
  readonly evaluationSpecBytes: Uint8Array;
  readonly evalSemanticsVersion: string;
}

export interface ChainAdmissionDeps {
  readonly observeChain: ChainObservationPort;
  readonly issuer: string;
  readonly signal?: AbortSignal;
}

export type ChainAdmissionResult =
  | { readonly receipt: ChainAdmissionReceiptV1 }
  | { readonly refusal: ChainAdmissionRefusal };

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

/**
 * The receipt's EvaluationSpec subject is `recordDigest(evaluationSpecBytes)`, so bytes that are
 * not the document's canonical sealing mint a receipt no consumer can ever match against the
 * sealed spec.
 */
export function assertCanonicalChainSpecBytes(bytes: Uint8Array, parsed: unknown): void {
  let canonical: Uint8Array;
  try {
    canonical = canonicalJsonBytes(parsed);
  } catch (cause) {
    refuseChain(
      "invalid-candidate",
      `the candidate EvaluationSpec is not canonicalizable JSON: ${String(cause)}`,
    );
  }
  if (!bytesEqual(bytes, canonical)) {
    refuseChain(
      "invalid-candidate",
      "the candidate EvaluationSpec bytes are not the document's canonical sealing, so the "
        + "receipt's evaluation-spec subject would name bytes no sealed spec has",
    );
  }
}

function parseSpec(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch (cause) {
    throw new ChainAdmissionRefusalError(
      "invalid-candidate",
      `the candidate EvaluationSpec bytes are not UTF-8 JSON: ${String(cause)}`,
    );
  }
}

async function observeSide(
  deps: ChainAdmissionDeps,
  request: Omit<ChainObservationRequest, "attempt">,
): Promise<ChainObservation[]> {
  const observations: ChainObservation[] = [];
  for (let attempt = 1; attempt <= CHAIN_ADMISSION_POLICY_V1.observationsPerSide; attempt += 1) {
    deps.signal?.throwIfAborted();
    let observation: ChainObservation;
    try {
      observation = await deps.observeChain({ ...request, attempt: attempt as 1 | 2 });
    } catch (cause) {
      throw new ChainAdmissionRefusalError(
        "execution-failed",
        `run ${attempt} of ${request.script.kind} failed: ${String(cause)}`,
      );
    }
    const expected = request.script.kind === "reference" ? request.script.digest : null;
    if (observation.appliedScriptDigest !== expected) {
      throw new ChainAdmissionRefusalError(
        "execution-failed",
        `run ${attempt} of ${request.script.kind} applied `
          + `${String(observation.appliedScriptDigest)}, not ${String(expected)}`,
      );
    }
    observations.push(observation);
  }
  return observations;
}

/**
 * Candidate + composite record digest -> receipt, or a refusal from the closed chain
 * taxonomy. Source-agnostic by construction, exactly as the SWE entry point is: nothing
 * here knows whether the candidate came from a template, an import, or a hand-authored
 * drill. Chain-agnostic too — no chain type crosses this boundary.
 */
export async function admitChainCandidate(
  deps: ChainAdmissionDeps,
  candidate: ChainAdmissionCandidate,
  environmentCompositeDigest: `sha256:${string}`,
): Promise<ChainAdmissionResult> {
  try {
    const evaluationSpecDigest = recordDigest(candidate.evaluationSpecBytes);
    const evaluationSpec = parseSpec(candidate.evaluationSpecBytes);
    assertCanonicalChainSpecBytes(candidate.evaluationSpecBytes, evaluationSpec);
    const view = readStatePredicateSpec(evaluationSpec);
    if (view.environmentRecordDigest !== environmentCompositeDigest) {
      refuseChain(
        "env-record-mismatch",
        `the spec references ${view.environmentRecordDigest}, not ${environmentCompositeDigest}`,
      );
    }
    if (view.semanticsVersion !== candidate.evalSemanticsVersion) {
      refuseChain(
        "invalid-candidate",
        `the spec declares predicate semantics ${view.semanticsVersion}, `
          + `not ${candidate.evalSemanticsVersion}`,
      );
    }

    const base = {
      environmentCompositeDigest,
      evaluationSpecDigest,
      ...(deps.signal === undefined ? {} : { signal: deps.signal }),
    };
    const doNothing = await observeSide(deps, { ...base, script: { kind: "do-nothing" } });
    const reference = await observeSide(deps, {
      ...base,
      script: { kind: "reference", digest: candidate.referenceScriptDigest },
    });

    return {
      receipt: verifyChainAdmissionReceiptV1({
        schemaVersion: CHAIN_ADMISSION_RECEIPT_SCHEMA_VERSION,
        admissionPolicyVersion: CHAIN_ADMISSION_POLICY_V1.admissionPolicyVersion,
        family: "state-predicate",
        issuer: deps.issuer,
        task: {
          documentDigest: candidate.taskDocumentDigest,
          evaluationSpecDigest,
          statementDigest: candidate.statementDigest,
        },
        referenceScriptDigest: candidate.referenceScriptDigest,
        observations: { doNothing, reference },
        environment: { compositeRecordDigest: environmentCompositeDigest },
        sliceSufficiency: { referenceOutOfSliceReads: 0 },
        evalSemanticsVersion: candidate.evalSemanticsVersion,
      }),
    };
  } catch (error) {
    if (error instanceof ChainAdmissionRefusalError) return { refusal: error.refusal };
    throw error;
  }
}
