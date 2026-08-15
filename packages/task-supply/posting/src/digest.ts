// SPDX-License-Identifier: MIT

/**
 * The one shape a record-body digest may take in this package: `sha256:` plus 64 lower-case hex
 * characters (program §5 contract 6). Bare hex is the in-toto DigestSet form and the on-chain
 * `bytes32` anchor form; the two are not interchangeable, and every conversion between them is
 * explicit and checked at the point of conversion.
 */
export const PREFIXED_SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;

/**
 * Fails closed on any digest that is not in the canonical prefixed form. Callers pass the field
 * name so the refusal names the input the operator has to fix, not just its value.
 */
export function assertPrefixedSha256(
  digest: string,
  field: string,
): asserts digest is `sha256:${string}` {
  if (!PREFIXED_SHA256_PATTERN.test(digest)) {
    throw new Error(
      `${field} ${JSON.stringify(digest)} is not a sha256:-prefixed lower-case 64-hex digest`,
    );
  }
}
