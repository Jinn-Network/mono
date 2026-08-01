// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";
import { refuseChain } from "./chain-refusals.js";

const BARE_SHA256 = /^[0-9a-f]{64}$/;

const EvaluationSpecShellSchema = z.looseObject({
  family: z.string(),
  familyBlock: z.unknown(),
});

const PredicateEntrySchema = z.looseObject({
  label: z.string().min(1).optional(),
});

const StatePredicateBlockSchema = z.looseObject({
  environmentRecord: z.looseObject({
    digest: z.looseObject({ sha256: z.string() }),
  }),
  predicateSemanticsVersion: z.string().min(1),
  successPredicates: z.array(PredicateEntrySchema),
  safetyConstraints: z.array(PredicateEntrySchema).optional(),
});

export interface StatePredicateSpecView {
  readonly family: "state-predicate";
  /** The composite record digest the spec references, `sha256:`-prefixed. */
  readonly environmentRecordDigest: `sha256:${string}`;
  readonly successPredicateIds: readonly string[];
  readonly safetyConstraintIds: readonly string[];
  readonly semanticsVersion: string;
}

function sha256FromDigestSet(hex: string, label: string): `sha256:${string}` {
  if (!BARE_SHA256.test(hex)) {
    refuseChain(
      "invalid-candidate",
      `${label} DigestSet sha256 must be bare lowercase hex (in-toto DigestSet values are never sha256:-prefixed)`,
    );
  }
  return `sha256:${hex}`;
}

function predicateIds(predicates: readonly z.infer<typeof PredicateEntrySchema>[], field: string): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const [index, predicate] of predicates.entries()) {
    const id = predicate.label;
    if (id === undefined) {
      refuseChain("invalid-candidate", `${field}[${index}] carries no predicate label (the stable predicate id)`);
    }
    if (seen.has(id)) {
      refuseChain("invalid-candidate", `${field} repeats predicate id ${id}`);
    }
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

/**
 * Read the family-discriminating fields out of a sealed EvaluationSpec.
 *
 * Structural, not imported: admission's approved Jinn dependency set is two packages
 * (design §3.3, enforced by `attestation-agnostic.test.ts`), and neither is the profiles
 * package that owns this block. `chain-testing.ts` ships the compatibility fixture that
 * pins this reader against the family block the profiles package actually emits.
 */
export function readStatePredicateSpec(evaluationSpec: unknown): StatePredicateSpecView {
  const shell = EvaluationSpecShellSchema.safeParse(evaluationSpec);
  if (!shell.success) {
    refuseChain("invalid-candidate", "the candidate EvaluationSpec is not a { family, familyBlock } document");
  }
  if (shell.data.family !== "state-predicate") {
    refuseChain(
      "invalid-candidate",
      `chain admission grades the state-predicate family only, not "${shell.data.family}"`,
    );
  }
  const block = StatePredicateBlockSchema.safeParse(shell.data.familyBlock);
  if (!block.success) {
    refuseChain("invalid-candidate", `the state-predicate family block is malformed: ${block.error.message}`);
  }
  if (block.data.successPredicates.length === 0) {
    refuseChain("invalid-candidate", "the state-predicate block declares no success predicates");
  }
  const environmentHex = block.data.environmentRecord.digest.sha256;
  const environmentRecordDigest = sha256FromDigestSet(environmentHex, "environmentRecord");
  return {
    family: "state-predicate",
    environmentRecordDigest,
    successPredicateIds: predicateIds(block.data.successPredicates, "successPredicates"),
    safetyConstraintIds: predicateIds(block.data.safetyConstraints ?? [], "safetyConstraints"),
    semanticsVersion: block.data.predicateSemanticsVersion,
  };
}
