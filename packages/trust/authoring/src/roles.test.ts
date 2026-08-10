// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { TrustAuthoringError } from "./errors.js";
import {
  isSettlementRole,
  NATIVE_ROLE_IDENTITY_REQUIREMENTS,
  NATIVE_ROLE_IDENTITY_ROLES,
  orderedNativeRoles,
} from "./roles.js";

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

describe("NATIVE_ROLE_IDENTITY_REQUIREMENTS", () => {
  /**
   * The trust-tree half of the announce-plane pin (issue #2525). The value has to equal Record
   * Discovery's `DISCOVERY_SIGNING_SCOPE`, but this package cannot import the discovery tree
   * without inverting the dependency direction, so the literal is asserted here and the two
   * constants are compared against each other in `client/test/daemon/trust-authoring-round-trip.ts`
   * (which imports both). A typo in this tree reddens here; a divergence reddens there.
   */
  it("carries the announce-plane scope on exactly the discovery roles", () => {
    for (const role of NATIVE_ROLE_IDENTITY_ROLES) {
      expect(NATIVE_ROLE_IDENTITY_REQUIREMENTS[role].includes("jinn:discovery-announcements"))
        .toBe(role.endsWith("-discovery"));
    }
  });

  it("keeps the trust-core record family alongside it on every discovery role", () => {
    // The native stack resolves discovery envelopes under `observations`; dropping it in favour of
    // the announce scope alone would pass the client's filter and fail §7.5 step 4.
    for (const role of NATIVE_ROLE_IDENTITY_ROLES.filter((name) => name.endsWith("-discovery"))) {
      expect(NATIVE_ROLE_IDENTITY_REQUIREMENTS[role]).toContain("observations");
    }
  });

  it("leaves every non-discovery role's scope untouched", () => {
    expect(NATIVE_ROLE_IDENTITY_REQUIREMENTS["requester-submission"]).toEqual(["authorizations"]);
    expect(NATIVE_ROLE_IDENTITY_REQUIREMENTS.admission).toEqual(["authorizations"]);
    expect(NATIVE_ROLE_IDENTITY_REQUIREMENTS["solver-delivery"]).toEqual(["deliveries"]);
    expect(NATIVE_ROLE_IDENTITY_REQUIREMENTS["solver-settlement"]).toEqual(["settlements"]);
    expect(NATIVE_ROLE_IDENTITY_REQUIREMENTS["evaluator-verdict"]).toEqual(["verdicts", "deliveries"]);
    expect(NATIVE_ROLE_IDENTITY_REQUIREMENTS["evaluator-settlement"]).toEqual(["settlements"]);
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
