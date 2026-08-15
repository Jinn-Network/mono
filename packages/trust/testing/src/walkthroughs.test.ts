// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, test } from "vitest";

import { createFakeResolvers } from "./fakes.js";
import type { FakeTrustResolvers } from "./fakes.js";
import {
  runConfidentialLeakedDocumentsWalkthrough,
  runOldVerdictAfterKeyRotationWalkthrough,
  runOpenFleetAdoptionSettlementWalkthrough,
  runTwoSafeEvaluatorDistinctnessWalkthrough,
} from "./walkthroughs.js";

// ---------------------------------------------------------------------------
// The four §13 verification walkthroughs (Task T16), driven end-to-end
// through the real trust-core procedures.
// ---------------------------------------------------------------------------

describe("§13 verification walkthroughs", () => {
  let fakes: FakeTrustResolvers;

  beforeEach(() => {
    fakes = createFakeResolvers();
  });

  test("old verdict after key rotation: the 2026 verdict stands, attribution intact", async () => {
    const result = await runOldVerdictAfterKeyRotationWalkthrough(fakes);
    expect(result.verdictOutcome.ok).toBe(true);
    expect(result.settlementJoin.ok).toBe(true);
    expect(result.settlementJoin.agent).toBe(result.verdictOutcome.resolvedBinding?.binding.agent);
  });

  test("open-fleet adoption settlement: the Statement twin resolves to the launcher IRI, no GitHub login, irrevocable-until-expiry", async () => {
    const result = await runOpenFleetAdoptionSettlementWalkthrough(fakes);
    expect(result.statementOutcome.ok).toBe(true);
    expect(result.statement.predicate.revocation).toBeUndefined();
  });

  test("confidential input, leaked documents: authentication fails closed for the attacker", async () => {
    const result = await runConfidentialLeakedDocumentsWalkthrough(fakes);
    expect(result.outcome.ok).toBe(false);
  });

  test("two-Safe evaluator distinctness: both Safes resolve to one Agent IRI; a fresh unbound IRI is rejected", async () => {
    const result = await runTwoSafeEvaluatorDistinctnessWalkthrough(fakes);
    expect(result.fleetOutcome.ok).toBe(true);
    expect(result.stakingOutcome.ok).toBe(true);
    expect(result.distinctEvaluatorSatisfied).toBe(false); // one party, not two
    expect(result.freshIriOutcome.ok).toBe(false);
    expect(result.freshIriOutcome.reason).toBe("binding-not-resolved");
  });
});
