// SPDX-License-Identifier: MIT

/**
 * The one rejection type this package throws, and the one issue shape it reports.
 *
 * Every refusal in `@jinn-network/policy-identity` is fail-closed and typed: callers branch on
 * `category` (and, where they care, on `errors[].path`), never on `message`. Messages are prose
 * and are free to change; categories and paths are the contract.
 */

import type { PolicyIdentityErrorCategory, ValidationIssue } from "./types.js";

export class PolicyIdentityError extends Error {
  readonly category: PolicyIdentityErrorCategory;
  readonly errors: readonly ValidationIssue[];

  constructor(category: PolicyIdentityErrorCategory, errors: readonly ValidationIssue[]) {
    const [first] = errors;
    super(first === undefined ? category : `${first.path}: ${first.message}`);
    this.name = "PolicyIdentityError";
    this.category = category;
    this.errors = errors;
  }
}

/** Builds one issue. `path` is dotted and rooted at the document (`""` is the document itself). */
export function issue(
  code: PolicyIdentityErrorCategory,
  path: string,
  message: string,
): ValidationIssue {
  return { path, code, message };
}

/** Refuses with a single issue. The category of the throw is that issue's code. */
export function refuse(
  code: PolicyIdentityErrorCategory,
  path: string,
  message: string,
): never {
  throw new PolicyIdentityError(code, [issue(code, path, message)]);
}

/** Refuses with an already-collected issue list; the first issue's code sets the category. */
export function refuseAll(errors: readonly ValidationIssue[]): never {
  const [first] = errors;
  if (first === undefined) throw new PolicyIdentityError("invalid-document", []);
  throw new PolicyIdentityError(first.code, errors);
}

/** Joins a parent path and a member name into the dotted path the fixtures pin. */
export function childPath(parent: string, member: string | number): string {
  return parent === "" ? String(member) : `${parent}.${member}`;
}
