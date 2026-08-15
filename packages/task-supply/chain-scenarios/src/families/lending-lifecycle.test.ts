// SPDX-License-Identifier: Apache-2.0

import { evaluatePredicates, type PredicateOutcome } from "@jinn-network/task-execution-profiles";
import { describe, expect, it } from "vitest";

import { assertTemplateHardened } from "../hardening.js";
import {
  baselineObservation,
  fixtureEnvironment,
  LENDING_PARAMS,
  predicateBlockFromTemplate,
  referenceObservation,
} from "../testing.js";
import { lendingLifecycleTemplate } from "./lending-lifecycle.js";

interface AdmissionOutcome {
  readonly conjunction: boolean;
  readonly successPredicates: ReadonlyArray<{ readonly id: string; readonly satisfied: boolean }>;
}

function evaluateAdmission(
  observation: Parameters<typeof evaluatePredicates>[0],
  block: Parameters<typeof evaluatePredicates>[1],
): AdmissionOutcome {
  const outcome: PredicateOutcome = evaluatePredicates(observation, block);
  return {
    conjunction: outcome.successPredicatesSatisfied,
    successPredicates: outcome.evaluations
      .filter((entry) => entry.slot === "success")
      .map((entry) => ({
        id: entry.label ?? `success-${entry.index}`,
        satisfied: entry.state === "satisfied",
      })),
  };
}

describe("the lending-lifecycle template is hardened before it parameterizes", () => {
  it("passes its own checklist", () => {
    expect(() => assertTemplateHardened(lendingLifecycleTemplate)).not.toThrow();
  });
});

describe("the baseline conjunction, which is the whole admission argument", () => {
  const env = fixtureEnvironment();
  const block = predicateBlockFromTemplate(lendingLifecycleTemplate, env, LENDING_PARAMS);

  it("has at least one success predicate that is TRUE at baseline", () => {
    const outcome = evaluateAdmission(baselineObservation(), block);
    const healthFactor = outcome.successPredicates.find((p) => p.id === "health-factor-floor");
    expect(healthFactor?.satisfied).toBe(true);
  });

  it("has a FALSE conjunction at baseline, which is what proves the task demands action", () => {
    expect(evaluateAdmission(baselineObservation(), block).conjunction).toBe(false);
  });

  it("has a TRUE conjunction after the reference path", () => {
    expect(evaluateAdmission(referenceObservation(), block).conjunction).toBe(true);
  });

  it("names the false-at-baseline predicates explicitly, so a future edit cannot quietly "
    + "make every predicate baseline-true", () => {
    const outcome = evaluateAdmission(baselineObservation(), block);
    const falseIds = outcome.successPredicates.filter((p) => !p.satisfied).map((p) => p.id).sort();
    expect(falseIds).toStrictEqual(["borrow-event", "debt-token-received"]);
  });
});

describe("the hardening checklist forecloses the shortcuts this family actually has", () => {
  const env = fixtureEnvironment();
  const draft = lendingLifecycleTemplate.predicateTemplate(LENDING_PARAMS, env);

  it("requires the pool's own Borrow event, so a transfer from another fixture account fails", () => {
    const block = predicateBlockFromTemplate(lendingLifecycleTemplate, env, LENDING_PARAMS);
    const transferred = {
      ...baselineObservation(),
      stateReads: baselineObservation().stateReads.map((read) => {
        if (read.key.includes("erc20-balance")) {
          return {
            ...read,
            value: `0x${BigInt(LENDING_PARAMS.borrowAmount).toString(16).padStart(64, "0")}`,
          };
        }
        return read;
      }),
    };
    expect(evaluateAdmission(transferred, block).conjunction).toBe(false);
  });

  it("forbids the funded-whale route in safetyConstraints", () => {
    expect(draft.safetyConstraints.some((p) => p.kind === "addressForbidden")).toBe(true);
  });

  it("bounds time advancement so accrual cannot substitute for action", () => {
    expect(draft.successPredicates.some((p) => p.kind === "timeBound")).toBe(true);
    expect(Number(draft.envelopeTightenings?.maxChainSecondsAdvanced))
      .toBeLessThanOrEqual(lendingLifecycleTemplate.hardening.timeAdvancementBound.maxChainSeconds);
  });

  it("excludes the treasury and whale roles from the tightened signer set", () => {
    for (const excluded of lendingLifecycleTemplate.hardening.excludedAccountRoles) {
      expect(draft.envelopeTightenings?.signerRoles).not.toContain(excluded.role);
    }
  });
});
