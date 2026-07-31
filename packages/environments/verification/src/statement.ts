// SPDX-License-Identifier: Apache-2.0

import { IN_TOTO_STATEMENT_TYPE, recordDigest, type Sha256Digest } from "@jinn-network/trust-core";
import { z } from "zod";

import { DigestSetSchema, fromDigestSet } from "./digests.js";
import { invalidInput } from "./errors.js";
import { ENVIRONMENT_VERIFICATION_PREDICATE_TYPE } from "./identifiers.js";
import {
  EnvironmentVerificationPredicateSchema,
  type EnvironmentVerificationPredicate,
} from "./predicate.js";
import { canonicalOutcomeSetBytes, tallyOutcomeSet, OutcomeSetSchema } from "./outcome-set.js";
import {
  buildEnvironmentVerificationSubjects,
  type EnvironmentVerificationSubjectInput,
} from "./subject.js";

export const EnvironmentVerificationStatementSchema = z.strictObject({
  _type: z.literal(IN_TOTO_STATEMENT_TYPE),
  subject: z.tuple([
    z.strictObject({ name: z.literal("environment"), digest: DigestSetSchema }),
    z.strictObject({ name: z.literal("image"), digest: DigestSetSchema }),
  ]),
  predicateType: z.literal(ENVIRONMENT_VERIFICATION_PREDICATE_TYPE),
  predicate: EnvironmentVerificationPredicateSchema,
});
export type EnvironmentVerificationStatement = z.infer<
  typeof EnvironmentVerificationStatementSchema
>;

export interface BuildEnvironmentVerificationStatementInput
  extends EnvironmentVerificationSubjectInput {
  readonly predicate: EnvironmentVerificationPredicate;
}

/**
 * Assembles and validates the in-toto Statement. Follows the
 * `attestation-issuer` pattern (`packages/evidence/attestation-issuer/src/
 * statement.ts`): assemble, `safeParse` against a closed schema, throw with the
 * first issue's JSON path. That package is a pattern source, not a dependency --
 * it exports no statement builder, and design §3.3 gives verification only two
 * package edges.
 */
export function buildEnvironmentVerificationStatement(
  input: BuildEnvironmentVerificationStatementInput,
): EnvironmentVerificationStatement {
  const statement = {
    _type: IN_TOTO_STATEMENT_TYPE,
    subject: buildEnvironmentVerificationSubjects(input),
    predicateType: ENVIRONMENT_VERIFICATION_PREDICATE_TYPE,
    predicate: input.predicate,
  };
  return parseEnvironmentVerificationStatement(statement);
}

export function parseEnvironmentVerificationStatement(
  value: unknown,
): EnvironmentVerificationStatement {
  const result = EnvironmentVerificationStatementSchema.safeParse(value);
  if (!result.success) {
    const first = result.error.issues[0];
    invalidInput(
      first
        ? `Invalid verification statement at /${first.path.join("/")}: ${first.message}`
        : "Invalid verification statement.",
    );
  }
  return result.data;
}

/**
 * The normative subject-match rule (design §5.1). A consumer evaluating a claim
 * about an *environment* MUST match the environment-record subject. Any-subject
 * matching would silently extend a narrow-scope attestation to a broad-scope
 * record, since two records may share one image.
 */
export function attestationMatchesRecord(
  statement: EnvironmentVerificationStatement,
  recordDigestValue: Sha256Digest,
): boolean {
  return fromDigestSet(statement.subject[0].digest) === recordDigestValue;
}

/**
 * Re-derives the baseline counts from the retrieved outcome-map artifact and
 * checks both the digest binding and the tally. This is what catches a re-signed
 * payload whose baseline counts were altered (design §5.5) -- the counts are
 * inline in the predicate, so only the artifact settles them.
 */
export function verifyBaselineCounts(
  predicate: EnvironmentVerificationPredicate,
  outcomesBytes: Uint8Array,
): boolean {
  if (predicate.baseline === undefined) return false;
  const expectedDigest = recordDigest(outcomesBytes);
  if (fromDigestSet(predicate.baseline.outcomes.digest) !== expectedDigest) return false;

  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(outcomesBytes));
  } catch {
    return false;
  }
  const parsed = OutcomeSetSchema.safeParse(decoded);
  if (!parsed.success) return false;
  // Canonical-bytes check: the stored artifact must be the canonical encoding,
  // not a re-spelled equivalent.
  const canonical = canonicalOutcomeSetBytes(parsed.data);
  if (canonical.length !== outcomesBytes.length
    || !canonical.every((byte, index) => byte === outcomesBytes[index])) {
    return false;
  }
  const tally = tallyOutcomeSet(parsed.data);
  return tally.passing === predicate.baseline.passing
    && tally.failing === predicate.baseline.failing
    && tally.skipped === predicate.baseline.skipped;
}
