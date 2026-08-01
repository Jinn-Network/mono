// SPDX-License-Identifier: Apache-2.0

import type { Sha256Digest } from "@jinn-network/trust-core";

import { toDigestSet, type ResourceDescriptor } from "./digests.js";

export interface EnvironmentVerificationSubjectInput {
  /** Identity of the sealed environment record (`sha256:`-prefixed). */
  readonly recordDigest: Sha256Digest;
  /** Platform-specific OCI *manifest* digest (`sha256:`-prefixed). */
  readonly imageManifestDigest: Sha256Digest;
}

/**
 * The attestation's two subjects, in fixed order: the environment record first,
 * the image second. Values are bare hex, per in-toto -- `toDigestSet` refuses a
 * prefixed value, which is the adversarial fixture of design §5.1.
 *
 * The image subject exists for discovery inversion only ("find attestations
 * about image sha256:X"). Claims about an *environment* match the environment
 * subject; see `attestationMatchesRecord`.
 */
export function buildEnvironmentVerificationSubjects(
  input: EnvironmentVerificationSubjectInput,
): readonly [ResourceDescriptor, ResourceDescriptor] {
  return [
    { name: "environment", digest: toDigestSet(input.recordDigest) },
    { name: "image", digest: toDigestSet(input.imageManifestDigest) },
  ];
}
