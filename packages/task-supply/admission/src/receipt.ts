// SPDX-License-Identifier: Apache-2.0

import { canonicalJsonBytes, recordDigest } from "@jinn-network/trust-core";
import { z } from "zod";
import { ADMISSION_RECEIPT_SCHEMA_VERSION, DIFFERENTIAL_ADMISSION_POLICY_V3 } from "./identifiers.js";
import { ObservationSchema, deriveTransitions, stableObservation, type Observation } from "./observations.js";
import { refuse } from "./refusals.js";
import { normalizeRepositoryPath } from "./test-paths.js";

/** Receipt-body digests are `sha256:`-prefixed; in-toto DigestSet values (seal.ts) are bare hex. */
const PrefixedDigest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const NonEmpty = z.string().min(1);
const PER_SIDE = DIFFERENTIAL_ADMISSION_POLICY_V3.observationsPerSide;

const PathReceiptSchema = z.strictObject({
  testPath: NonEmpty,
  commandHash: PrefixedDigest,
  broken: z.array(ObservationSchema).length(PER_SIDE),
  fixed: z.array(ObservationSchema).length(PER_SIDE),
  failToPass: z.array(NonEmpty),
  passToPass: z.array(NonEmpty),
});
export type DifferentialAdmissionPathReceiptV3 = z.infer<typeof PathReceiptSchema>;

export const DifferentialAdmissionReceiptV3Schema = z.strictObject({
  schemaVersion: z.literal(ADMISSION_RECEIPT_SCHEMA_VERSION),
  admissionPolicyVersion: z.literal(DIFFERENTIAL_ADMISSION_POLICY_V3.admissionPolicyVersion),
  /** The admitting agent IRI. Required by the in-toto predicate shape the evaluation leg parses. */
  issuer: NonEmpty,
  task: z.strictObject({
    documentDigest: PrefixedDigest,
    evaluationSpecDigest: PrefixedDigest,
    statementDigest: PrefixedDigest,
    testMaterialDigests: z.array(PrefixedDigest).min(1),
    transitions: z.strictObject({
      failToPass: z.array(NonEmpty),
      passToPass: z.array(NonEmpty),
    }),
  }),
  /** Deliberately a digest only: gold-patch contents are never receipt data. */
  goldPatchHash: PrefixedDigest,
  testPaths: z.array(PathReceiptSchema).min(1),
  environment: z.strictObject({
    recordDigest: PrefixedDigest,
    inlineMatch: z.strictObject({
      fields: z.tuple([z.literal("image"), z.literal("parser"), z.literal("platform")]),
      specKeyPresent: z.boolean(),
    }),
  }),
  evalSemanticsVersion: NonEmpty,
});
export type DifferentialAdmissionReceiptV3 = z.infer<typeof DifferentialAdmissionReceiptV3Schema>;

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => right[index] === value);
}

function assertionIds(broken: Observation, fixed: Observation): Set<string> {
  return new Set([...broken.passed, ...broken.failed, ...fixed.passed, ...fixed.failed]);
}

function validatePolicy(receipt: DifferentialAdmissionReceiptV3): void {
  const seenPaths = new Set<string>();
  const owners = new Map<string, string>();
  for (const pathReceipt of receipt.testPaths) {
    const normalized = normalizeRepositoryPath(pathReceipt.testPath, "receipt test path");
    if (normalized !== pathReceipt.testPath) {
      refuse("invalid-candidate", `receipt test path ${pathReceipt.testPath} is not normalized`);
    }
    if (seenPaths.has(pathReceipt.testPath)) {
      refuse("invalid-candidate", `receipt repeats test path ${pathReceipt.testPath}`);
    }
    seenPaths.add(pathReceipt.testPath);

    const broken = stableObservation(pathReceipt.broken, "broken", pathReceipt.testPath);
    const fixed = stableObservation(pathReceipt.fixed, "fixed", pathReceipt.testPath);
    const derived = deriveTransitions(broken, fixed);
    if (
      !sameStrings(derived.failToPass, pathReceipt.failToPass)
      || !sameStrings(derived.passToPass, pathReceipt.passToPass)
    ) {
      refuse(
        "no-discrimination",
        `the transitions recorded for ${pathReceipt.testPath} do not match its observations`,
      );
    }
    if (pathReceipt.failToPass.length === 0) {
      refuse("no-discrimination", `test path ${pathReceipt.testPath} has no fail-to-pass assertion`);
    }

    for (const identifier of assertionIds(broken, fixed)) {
      const owner = owners.get(identifier);
      if (owner !== undefined && owner !== pathReceipt.testPath) {
        refuse(
          "duplicate-assertion-id",
          `raw assertion identifier ${identifier} appears under both ${owner} and ${pathReceipt.testPath}`,
        );
      }
      owners.set(identifier, pathReceipt.testPath);
    }
  }
  validateDeclaredTransitions(receipt);
}

/**
 * Design §7.1's first bullet is scoped to *the candidate's* fail-to-pass and pass-to-pass tests:
 * gold applied → the candidate's fail-to-pass tests pass and its pass-to-pass tests still pass.
 * The receipt therefore may not carry declared transitions its own observations do not prove —
 * otherwise an unsolvable pair (gold flips something else, or regresses a declared pass-to-pass)
 * earns a signed receipt asserting the opposite.
 */
function validateDeclaredTransitions(receipt: DifferentialAdmissionReceiptV3): void {
  const declared = receipt.task.transitions;
  if (declared.failToPass.length === 0) {
    refuse("no-discrimination", "the candidate declares no fail-to-pass assertion");
  }
  const provenFailToPass = new Set(receipt.testPaths.flatMap((path) => path.failToPass));
  const provenPassToPass = new Set(receipt.testPaths.flatMap((path) => path.passToPass));
  for (const identifier of declared.failToPass) {
    if (!provenFailToPass.has(identifier)) {
      refuse(
        "transitions-mismatch",
        `declared fail-to-pass ${identifier} is not proven by any test path's observations`,
      );
    }
  }
  for (const identifier of declared.passToPass) {
    if (!provenPassToPass.has(identifier)) {
      refuse(
        "transitions-mismatch",
        `declared pass-to-pass ${identifier} is not proven by any test path's observations`,
      );
    }
  }
}

/**
 * Parse, re-derive, and validate a receipt. Every consumer — including this package's own
 * producer path — goes through here, so a stored receipt is held to exactly the policy that
 * minted it.
 */
export function verifyDifferentialAdmissionReceiptV3(raw: unknown): DifferentialAdmissionReceiptV3 {
  const parsed = DifferentialAdmissionReceiptV3Schema.safeParse(raw);
  if (!parsed.success) {
    refuse("invalid-candidate", `the receipt failed schema validation: ${parsed.error.message}`);
  }
  validatePolicy(parsed.data);
  return parsed.data;
}

/** Canonical content digest of a receipt body. Not the sealed identity — see seal.ts. */
export function receiptDigest(receipt: DifferentialAdmissionReceiptV3): `sha256:${string}` {
  return recordDigest(canonicalJsonBytes(verifyDifferentialAdmissionReceiptV3(receipt)));
}
