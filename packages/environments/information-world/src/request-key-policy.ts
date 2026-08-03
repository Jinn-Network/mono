import { z } from "zod";

import { isHttpToken } from "./ascii.js";
import { compareCodeUnitStrings } from "./order.js";
import { InvalidDocumentError, type ValidationIssue } from "./sealing.js";

/** The key algorithm's identifier. It is part of the key material. */
export const REQUEST_KEY_VERSION = "irk1" as const;

/**
 * Header names that must never key a sealed corpus (finding CF6-1). A sealed record is a
 * portable public document, so a credential must not reach it; and a key that varied with a
 * credential would make the corpus resolvable only by whoever holds one.
 */
export const CREDENTIAL_HEADER_NAMES: readonly string[] = Object.freeze([
  "authorization",
  "cookie",
  "proxy-authorization",
]);

export const RequestKeyPolicySchema = z.strictObject({
  version: z.literal(REQUEST_KEY_VERSION),
  /** The header names the key is allowed to see. Never all headers: user agents vary. */
  headerSubset: z.array(z.string()),
  pathTrailingSlash: z.enum(["preserve", "strip"]),
  /** Whether query `+` is interpreted as literal `+` or U+0020. */
  plusInQuery: z.enum(["literal", "space"]),
  /** The declared request-body canonicalization algorithm. */
  bodyCanonicalization: z.enum(["opaque-bytes", "json-jcs", "utf8-trim"]),
});

export type RequestKeyPolicy = z.infer<typeof RequestKeyPolicySchema>;

/**
 * Structural validation the schema cannot express: the declared subset is lowercase, strictly
 * ascending (so it is both sorted and duplicate-free), and free of credential names.
 */
export function assertRequestKeyPolicy(policy: RequestKeyPolicy): void {
  const errors: ValidationIssue[] = [];
  const names = policy.headerSubset;

  names.forEach((name, index) => {
    if (!isHttpToken(name)) {
      errors.push({
        path: `headerSubset.${index}`,
        message: `declared header name "${name}" must be a lowercase RFC 9110 token`,
      });
      return;
    }
    if (CREDENTIAL_HEADER_NAMES.includes(name)) {
      errors.push({
        path: `headerSubset.${index}`,
        message: `credential-bearing header "${name}" must not appear in a sealed request-key policy`,
      });
    }
  });

  for (let index = 1; index < names.length; index += 1) {
    if (compareCodeUnitStrings(names[index - 1] as string, names[index] as string) >= 0) {
      errors.push({
        path: `headerSubset.${index}`,
        message: "declared header subset must be strictly ascending by code unit",
      });
    }
  }

  if (errors.length > 0) throw new InvalidDocumentError(errors);
}
