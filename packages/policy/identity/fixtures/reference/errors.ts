// SPDX-License-Identifier: MIT

import type { PolicyIdentityErrorCategory, ValidationIssue } from "../../src/types.js";

/**
 * The reference implementation's typed rejection. Conformance tests assert on `category` (and,
 * where the fixture pins them, on `errors[].code`/`errors[].path`) — never on `message`. Any
 * conforming implementation may throw its own class as long as it carries the same `category`.
 */
export class ReferencePolicyIdentityError extends Error {
  constructor(
    readonly category: PolicyIdentityErrorCategory,
    message: string,
    readonly errors: readonly ValidationIssue[] = [],
  ) {
    super(message);
    this.name = "ReferencePolicyIdentityError";
  }
}

export function fail(
  category: PolicyIdentityErrorCategory,
  path: string,
  message: string,
): never {
  throw new ReferencePolicyIdentityError(category, `${path}: ${message}`, [
    { path, code: category, message },
  ]);
}
