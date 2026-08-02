// SPDX-License-Identifier: Apache-2.0

import type { Sha256Digest } from "@jinn-network/trust-core";

import { toDigestSet, type ResourceDescriptor } from "./digests.js";

export interface ChainEnvironmentSubjectInput {
  /** Identity of the sealed chain environment record (`sha256:`-prefixed). */
  readonly recordDigest: Sha256Digest;
  /**
   * The committed state artifact. Mandatory for `closed-state` records and absent for
   * archive-dependent ones, which commit no artifact to invert on.
   */
  readonly stateArtifactDigest?: Sha256Digest;
}

/**
 * The component attestation's subjects, in fixed order: the record first, the state artifact
 * second where one exists. Values are bare hex per in-toto -- `toDigestSet` refuses a
 * prefixed value, which is the contract-6 confusion fixture.
 *
 * The artifact subject exists for discovery inversion only ("find attestations about state
 * artifact X"). Claims about an environment match the record subject; see
 * `attestationMatchesRecord`. Two records can share one artifact, so any-subject matching
 * would extend a narrow claim to a record this attestation never covered.
 */
export function buildChainEnvironmentVerificationSubjects(
  input: ChainEnvironmentSubjectInput,
): readonly [ResourceDescriptor, ...ResourceDescriptor[]] {
  const environment: ResourceDescriptor = {
    name: "environment",
    digest: toDigestSet(input.recordDigest),
  };
  return input.stateArtifactDigest === undefined
    ? [environment]
    : [environment, { name: "state-artifact", digest: toDigestSet(input.stateArtifactDigest) }];
}

export interface CryptoEnvironmentSubjectInput {
  readonly compositeDigest: Sha256Digest;
  readonly chainWorldDigest: Sha256Digest;
}

/**
 * The composite attestation's subjects. Distinct names on purpose: a consumer evaluating a
 * *component* claim matches `environment`, which a composite statement never carries, so a
 * composite can never be read as covering the chain world on its own (design §5.1 step 6).
 */
export function buildCryptoEnvironmentVerificationSubjects(
  input: CryptoEnvironmentSubjectInput,
): readonly [ResourceDescriptor, ResourceDescriptor] {
  return [
    { name: "crypto-environment", digest: toDigestSet(input.compositeDigest) },
    { name: "chain-world", digest: toDigestSet(input.chainWorldDigest) },
  ];
}
