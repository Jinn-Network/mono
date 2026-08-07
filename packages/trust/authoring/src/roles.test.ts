// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { TrustAuthoringError } from "./errors.js";
import { isSettlementRole, NATIVE_ROLE_IDENTITY_ROLES, orderedNativeRoles } from "./roles.js";

describe("orderedNativeRoles", () => {
  it("canonicalizes to NATIVE_ROLE_IDENTITY_ROLES order regardless of request order", () => {
    expect(orderedNativeRoles(["solver-discovery", "admission", "requester-submission"])).toEqual([
      "requester-submission",
      "admission",
      "solver-discovery",
    ]);
  });

  it("passes the full vocabulary through unchanged", () => {
    expect(orderedNativeRoles(NATIVE_ROLE_IDENTITY_ROLES)).toEqual([...NATIVE_ROLE_IDENTITY_ROLES]);
  });

  /**
   * Symmetry with the verification side: `RoleIdentitySet.open` refuses a role requested twice
   * ("native role X is requested more than once"). Silently deduping here made the two sides
   * disagree about the same input — and this function is what a `--role-sets requester,requester`
   * CLI invocation lands on, so the refusal has to be the authoring side's answer too.
   */
  it("refuses a duplicated role rather than silently deduping it", () => {
    expect(() => orderedNativeRoles(["admission", "admission"])).toThrow(TrustAuthoringError);
    expect(() => orderedNativeRoles(["solver-delivery", "admission", "solver-delivery"]))
      .toThrow(/requested more than once/u);
  });

  it("accepts an empty request (the caller's own minimum-role rule owns that refusal)", () => {
    expect(orderedNativeRoles([])).toEqual([]);
  });
});

describe("isSettlementRole", () => {
  it("names exactly the two settlement-scoped roles (the §2.3b three-resource family)", () => {
    expect(NATIVE_ROLE_IDENTITY_ROLES.filter(isSettlementRole)).toEqual([
      "solver-settlement",
      "evaluator-settlement",
    ]);
  });
});
