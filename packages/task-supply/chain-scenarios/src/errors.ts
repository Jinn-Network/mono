// SPDX-License-Identifier: Apache-2.0

/**
 * Categories a caller routes on. Closed: every addition is a contract change.
 *
 * - `invalid-input`         a template, parameter set or record is structurally unusable.
 * - `incompatible-environment` the record does not satisfy the template's declared
 *   compatibility constraints, so parameterizing against it would produce a task the
 *   world cannot host.
 * - `unhardened-template`   the template's generated predicates do not contain what its
 *   own hardening checklist declares (design §7).
 * - `unsafe-fixture-address` an address is a well-known dev address, or was already used
 *   for another record (design §8, program contract 8).
 * - `envelope-violation`    a script exceeds the record's (possibly tightened) capability
 *   envelope; refused, never graded (design §6.4).
 * - `receipt-mismatch`      an admission receipt is not about the pair that earned it.
 * - `pool-conflict`         a pool entry's address does not address its bytes.
 */
export type ScenarioErrorCategory =
  | "envelope-violation"
  | "incompatible-environment"
  | "invalid-input"
  | "pool-conflict"
  | "receipt-mismatch"
  | "unhardened-template"
  | "unsafe-fixture-address";

export class ScenarioError extends Error {
  readonly category: ScenarioErrorCategory;

  constructor(category: ScenarioErrorCategory, message: string) {
    super(message);
    this.name = "ScenarioError";
    this.category = category;
  }
}
