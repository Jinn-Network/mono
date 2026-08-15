// SPDX-License-Identifier: Apache-2.0

import {
  environmentRecordDigest,
  parseEnvironmentRecord,
  type EnvironmentRecord,
} from "@jinn-network/environment-record";
import type { Candidate } from "./candidate.js";
import type { Sha256Digest } from "./digest.js";

/**
 * A described environment, in the three forms derivation needs, derived from one source of
 * truth (the bytes) so they cannot drift apart. "Described" is the honest word: whether the
 * environment has been *attested*, and under whose trust policy, is the consumer's join
 * (design §7.1) and no concern of this package.
 */
export interface DerivationEnvironment {
  readonly recordBytes: Uint8Array;
  readonly record: EnvironmentRecord;
  readonly recordDigest: Sha256Digest;
}

export function loadDerivationEnvironment(recordBytes: Uint8Array): DerivationEnvironment {
  return {
    recordBytes,
    record: parseEnvironmentRecord(recordBytes),
    recordDigest: environmentRecordDigest(recordBytes) as Sha256Digest,
  };
}

/** Structured observation sink. Injected — this package never writes to a console itself. */
export interface DerivationLogger {
  candidateSkipped(event: { readonly candidateId: string; readonly reason: string }): void;
  candidateRefused(event: { readonly candidateId: string; readonly code: string }): void;
  pairWritten(event: { readonly candidateId: string; readonly taskDigest: Sha256Digest }): void;
}

export interface StrategyDeps {
  readonly logger?: DerivationLogger;
}

/**
 * The strategy seam (design §7.2): *(described environment + strategy inputs) → candidate
 * tasks*. The two trailing type parameters default to this package's SWE shapes, so every
 * existing declaration is unchanged; a sibling family (chain scenarios, CE5) supplies its
 * own candidate and environment types and plugs into the same seam without this package
 * learning anything about it. Injection, statement generation, echo mining and
 * emergent-bug harvesting remain named extensions (§14) and are NOT to be built behind
 * this interface without a design amendment (§12).
 */
export interface DerivationStrategy<
  TInputs,
  TCandidate = Candidate,
  TEnvironment = DerivationEnvironment,
> {
  readonly id: string;
  derive(deps: StrategyDeps, env: TEnvironment, inputs: TInputs): AsyncIterable<TCandidate>;
}
