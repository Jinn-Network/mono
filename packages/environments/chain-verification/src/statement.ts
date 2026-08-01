// SPDX-License-Identifier: Apache-2.0

import { IN_TOTO_STATEMENT_TYPE, type Sha256Digest } from "@jinn-network/trust-core";
import { z } from "zod";

import { DigestSetSchema, fromDigestSet } from "./digests.js";
import { invalidInput } from "./errors.js";
import { CHAIN_ENVIRONMENT_VERIFICATION_PREDICATE_TYPE } from "./identifiers.js";
import {
  ChainEnvironmentVerificationPredicateSchema,
  type ChainEnvironmentVerificationPredicate,
} from "./predicate.js";
import {
  buildChainEnvironmentVerificationSubjects,
  buildCryptoEnvironmentVerificationSubjects,
  type ChainEnvironmentSubjectInput,
  type CryptoEnvironmentSubjectInput,
} from "./subject.js";

const ComponentPredicateSchema = ChainEnvironmentVerificationPredicateSchema.refine(
  (predicate) => predicate.scope === "component",
  { message: "a component statement carries a component-scope predicate", path: ["scope"] },
);
const CompositePredicateSchema = ChainEnvironmentVerificationPredicateSchema.refine(
  (predicate) => predicate.scope === "composite",
  { message: "a composite statement carries a composite-scope predicate", path: ["scope"] },
);

export const ComponentVerificationStatementSchema = z.strictObject({
  _type: z.literal(IN_TOTO_STATEMENT_TYPE),
  subject: z.union([
    z.tuple([z.strictObject({ name: z.literal("environment"), digest: DigestSetSchema })]),
    z.tuple([
      z.strictObject({ name: z.literal("environment"), digest: DigestSetSchema }),
      z.strictObject({ name: z.literal("state-artifact"), digest: DigestSetSchema }),
    ]),
  ]),
  predicateType: z.literal(CHAIN_ENVIRONMENT_VERIFICATION_PREDICATE_TYPE),
  predicate: ComponentPredicateSchema,
});

export const CompositeVerificationStatementSchema = z.strictObject({
  _type: z.literal(IN_TOTO_STATEMENT_TYPE),
  subject: z.tuple([
    z.strictObject({ name: z.literal("crypto-environment"), digest: DigestSetSchema }),
    z.strictObject({ name: z.literal("chain-world"), digest: DigestSetSchema }),
  ]),
  predicateType: z.literal(CHAIN_ENVIRONMENT_VERIFICATION_PREDICATE_TYPE),
  predicate: CompositePredicateSchema,
});

export const ChainEnvironmentVerificationStatementSchema = z.union([
  ComponentVerificationStatementSchema,
  CompositeVerificationStatementSchema,
]);
export type ChainEnvironmentVerificationStatement = z.infer<
  typeof ChainEnvironmentVerificationStatementSchema
>;

/**
 * Assembles and validates the in-toto Statement. Follows the `attestation-issuer` pattern
 * (`packages/evidence/attestation-issuer/src/statement.ts`): assemble, `safeParse` against a
 * closed schema, throw with the first issue's JSON path. That package is a pattern source,
 * not a dependency -- it exports no statement builder, and design §3 gives this package two
 * package edges.
 */
export function buildChainEnvironmentVerificationStatement(
  input: ChainEnvironmentSubjectInput & {
    readonly predicate: ChainEnvironmentVerificationPredicate;
  },
): ChainEnvironmentVerificationStatement {
  return parseChainEnvironmentVerificationStatement({
    _type: IN_TOTO_STATEMENT_TYPE,
    subject: buildChainEnvironmentVerificationSubjects(input),
    predicateType: CHAIN_ENVIRONMENT_VERIFICATION_PREDICATE_TYPE,
    predicate: input.predicate,
  });
}

export function buildCryptoEnvironmentVerificationStatement(
  input: CryptoEnvironmentSubjectInput & {
    readonly predicate: ChainEnvironmentVerificationPredicate;
  },
): ChainEnvironmentVerificationStatement {
  return parseChainEnvironmentVerificationStatement({
    _type: IN_TOTO_STATEMENT_TYPE,
    subject: buildCryptoEnvironmentVerificationSubjects(input),
    predicateType: CHAIN_ENVIRONMENT_VERIFICATION_PREDICATE_TYPE,
    predicate: input.predicate,
  });
}

export function parseChainEnvironmentVerificationStatement(
  value: unknown,
): ChainEnvironmentVerificationStatement {
  const result = ChainEnvironmentVerificationStatementSchema.safeParse(value);
  if (!result.success) {
    const first = result.error.issues[0];
    invalidInput(
      first
        ? `Invalid chain verification statement at /${first.path.join("/")}: ${first.message}`
        : "Invalid chain verification statement.",
    );
  }
  return result.data;
}

/**
 * The normative subject-match rule (design §5.3). A consumer evaluating a claim about a
 * record MUST match subject[0]. Any-subject matching would silently extend a narrow-scope
 * attestation to a broad-scope record, since two records may share one state artifact and a
 * composite always names its chain world.
 */
export function attestationMatchesRecord(
  statement: ChainEnvironmentVerificationStatement,
  recordDigestValue: Sha256Digest,
): boolean {
  return fromDigestSet(statement.subject[0].digest) === recordDigestValue;
}

/**
 * Design §5.1 step 6: "A composite attestation never substitutes for its components'
 * attestations, nor they for it." This returns the component records whose own attestations
 * a consumer must additionally obtain -- empty for a component statement, because it makes
 * no claim that depends on another one.
 */
export function requiresComponentAttestations(
  statement: ChainEnvironmentVerificationStatement,
): readonly Sha256Digest[] {
  const composition = statement.predicate.composition;
  if (statement.predicate.scope !== "composite" || composition === undefined) return [];
  return composition.components.map((component) => component.record as Sha256Digest);
}
