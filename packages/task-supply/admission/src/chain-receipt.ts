// SPDX-License-Identifier: Apache-2.0

import { canonicalJsonBytes, recordDigest } from "@jinn-network/trust-core";
import { z } from "zod";
import {
  ChainObservationSchema,
  deriveConjunction,
  stableChainObservation,
  type ChainObservation,
} from "./chain-observations.js";
import { refuseChain } from "./chain-refusals.js";
import {
  CHAIN_ADMISSION_POLICY_V1,
  CHAIN_ADMISSION_RECEIPT_SCHEMA_VERSION,
} from "./identifiers.js";

/** Receipt-body digests are `sha256:`-prefixed; in-toto DigestSet values (chain-seal.ts) are bare hex. */
const PrefixedDigest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const NonEmpty = z.string().min(1);
const PER_SIDE = CHAIN_ADMISSION_POLICY_V1.observationsPerSide;

export const ChainAdmissionReceiptV1Schema = z.strictObject({
  schemaVersion: z.literal(CHAIN_ADMISSION_RECEIPT_SCHEMA_VERSION),
  admissionPolicyVersion: z.literal(CHAIN_ADMISSION_POLICY_V1.admissionPolicyVersion),
  /** The discriminator a consumer routes on before reading anything else. */
  family: z.literal("state-predicate"),
  issuer: NonEmpty,
  task: z.strictObject({
    documentDigest: PrefixedDigest,
    evaluationSpecDigest: PrefixedDigest,
    statementDigest: PrefixedDigest,
  }),
  /** Deliberately a digest only: reference-script contents are never receipt data
   *  (chain design §6.3 — the gold-patch rule's analog). */
  referenceScriptDigest: PrefixedDigest,
  observations: z.strictObject({
    doNothing: z.array(ChainObservationSchema).length(PER_SIDE),
    reference: z.array(ChainObservationSchema).length(PER_SIDE),
  }),
  environment: z.strictObject({ compositeRecordDigest: PrefixedDigest }),
  sliceSufficiency: z.strictObject({ referenceOutOfSliceReads: z.literal(0) }),
  evalSemanticsVersion: NonEmpty,
});
export type ChainAdmissionReceiptV1 = z.infer<typeof ChainAdmissionReceiptV1Schema>;

function predicateIds(observation: ChainObservation): Set<string> {
  return new Set([
    ...observation.successPredicates.map((outcome) => outcome.id),
    ...observation.safetyConstraints.map((outcome) => outcome.id),
  ]);
}

function validatePolicy(receipt: ChainAdmissionReceiptV1): void {
  const doNothing = stableChainObservation(receipt.observations.doNothing, "do-nothing");
  const reference = stableChainObservation(receipt.observations.reference, "reference");

  if (deriveConjunction(doNothing)) {
    const satisfied = doNothing.successPredicates
      .filter((outcome) => outcome.satisfied)
      .map((outcome) => outcome.id);
    refuseChain(
      "do-nothing-satisfies",
      `the do-nothing conjunction is true because predicates [${satisfied.join(", ")}] already hold`,
    );
  }
  if (!deriveConjunction(reference)) {
    refuseChain("reference-unsatisfied", "the reference script's success conjunction is false");
  }
  for (const constraint of reference.safetyConstraints) {
    if (!constraint.satisfied) {
      refuseChain(
        "safety-violated",
        `reference run violated safety constraint ${constraint.id}`,
      );
    }
  }
  if (reference.outOfSliceReads !== 0 || reference.outOfSliceReads !== receipt.sliceSufficiency.referenceOutOfSliceReads) {
    refuseChain(
      "slice-insufficient",
      `reference run reported ${reference.outOfSliceReads} out-of-slice reads`,
    );
  }
  if (doNothing.envelopeExceeded || reference.envelopeExceeded) {
    refuseChain("safety-violated", "a side reported an envelope breach during admission");
  }

  const doNothingIds = predicateIds(doNothing);
  const referenceIds = predicateIds(reference);
  if (doNothingIds.size !== referenceIds.size || [...doNothingIds].some((id) => !referenceIds.has(id))) {
    refuseChain(
      "inconsistent-observation",
      "the do-nothing and reference sides observe different predicate id sets",
    );
  }

  for (const observation of receipt.observations.doNothing) {
    if (observation.appliedScriptDigest !== null) {
      refuseChain("execution-failed", "the do-nothing side must not apply a script");
    }
  }
  for (const observation of receipt.observations.reference) {
    if (observation.appliedScriptDigest !== receipt.referenceScriptDigest) {
      refuseChain(
        "execution-failed",
        `the reference side applied ${String(observation.appliedScriptDigest)}, `
          + `not ${receipt.referenceScriptDigest}`,
      );
    }
  }
}

/**
 * Parse, re-derive, and validate a chain admission receipt. Every consumer — including this
 * package's own producer path — goes through here.
 */
export function verifyChainAdmissionReceiptV1(raw: unknown): ChainAdmissionReceiptV1 {
  const parsed = ChainAdmissionReceiptV1Schema.safeParse(raw);
  if (!parsed.success) {
    refuseChain("invalid-candidate", `the receipt failed schema validation: ${parsed.error.message}`);
  }
  validatePolicy(parsed.data);
  return parsed.data;
}

/** Canonical content digest of a chain admission receipt body. Not the sealed identity — see chain-seal.ts. */
export function chainReceiptDigest(receipt: ChainAdmissionReceiptV1): `sha256:${string}` {
  return recordDigest(canonicalJsonBytes(verifyChainAdmissionReceiptV1(receipt)));
}
