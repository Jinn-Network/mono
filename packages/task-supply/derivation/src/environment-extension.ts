// SPDX-License-Identifier: Apache-2.0

import { assertBareHex, toBareHex, type Sha256Digest } from "./digest.js";
import { DerivationError } from "./errors.js";

/**
 * The namespaced EvaluationSpec extension key that references the environment record
 * (design §7.2, exact string). Reverse-DNS by construction, so the family block's
 * `withNamespacedExtras` rule (TEP §21.3) admits it; a first-class field is proposed as
 * F1 and would supersede this carrier.
 *
 * Dual-defined with C3's `ENVIRONMENT_RECORD_SPEC_KEY` per program ruling R1 — each side
 * pins the literal with its own test; changing the string is a program-plan amendment
 * touching both.
 */
export const ENVIRONMENT_RECORD_EXTENSION_KEY = "network.jinn.environment.record" as const;

/**
 * DigestSet-shaped, so `sha256` carries BARE lowercase hex like every other `digest.sha256`
 * in the stack — planning Finding (f) records that §7.2 leaves the encoding unstated and
 * pins it here.
 */
export interface EnvironmentRecordExtension {
  readonly digest: { readonly sha256: string };
}

export function buildEnvironmentRecordExtension(
  environmentRecordDigest: string,
): EnvironmentRecordExtension {
  return {
    digest: {
      sha256: toBareHex(environmentRecordDigest, `${ENVIRONMENT_RECORD_EXTENSION_KEY} source digest`),
    },
  };
}

/** Reads the extension back out of a family block, in the record-body prefixed form. */
export function readEnvironmentRecordExtension(
  familyBlock: Record<string, unknown>,
): Sha256Digest {
  const raw = familyBlock[ENVIRONMENT_RECORD_EXTENSION_KEY];
  if (raw === undefined) {
    throw new DerivationError(
      "invalid-extension",
      `family block carries no "${ENVIRONMENT_RECORD_EXTENSION_KEY}".`,
    );
  }
  const sha256 = (raw as { digest?: { sha256?: unknown } } | null)?.digest?.sha256;
  if (typeof sha256 !== "string") {
    throw new DerivationError(
      "invalid-extension",
      `"${ENVIRONMENT_RECORD_EXTENSION_KEY}" must carry {digest: {sha256: string}}.`,
    );
  }
  return `sha256:${assertBareHex(sha256, `${ENVIRONMENT_RECORD_EXTENSION_KEY}.digest.sha256`)}`;
}
