// SPDX-License-Identifier: Apache-2.0

import { evaluatePredicates, type PredicateOutcome } from "@jinn-network/task-execution-profiles";
import { describe, expect, it } from "vitest";

import { assertTemplateHardened } from "../hardening.js";
import {
  APPROVAL_HYGIENE_PARAMS,
  approvalBaselineObservation,
  approvalHygieneFixtureEnvironment,
  approvalOverRevokedObservation,
  approvalReferenceObservation,
  predicateBlockFromTemplate,
} from "../testing.js";
import { approvalHygieneTemplate } from "./approval-hygiene.js";

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

describe("the approval-hygiene template is hardened before it parameterizes", () => {
  it("passes its own checklist", () => {
    expect(() => assertTemplateHardened(approvalHygieneTemplate)).not.toThrow();
  });
});

describe("the baseline conjunction", () => {
  const env = approvalHygieneFixtureEnvironment();
  const block = predicateBlockFromTemplate(approvalHygieneTemplate, env, APPROVAL_HYGIENE_PARAMS);

  it("keeps the do-not-touch allowance predicate TRUE at baseline", () => {
    const outcome = evaluateAdmission(approvalBaselineObservation(), block);
    expect(outcome.successPredicates.find((p) => p.id === "retained-allowance")?.satisfied).toBe(true);
  });

  it("has a FALSE conjunction at baseline: the unsafe allowances are still live", () => {
    expect(evaluateAdmission(approvalBaselineObservation(), block).conjunction).toBe(false);
  });

  it("has a TRUE conjunction after the reference revokes exactly the unsafe spenders", () => {
    expect(evaluateAdmission(approvalReferenceObservation(), block).conjunction).toBe(true);
  });

  it("is FALSE when the agent revokes everything, including what it was told to keep", () => {
    expect(evaluateAdmission(approvalOverRevokedObservation(), block).conjunction).toBe(false);
  });
});

describe("the hardening checklist forecloses this family's shortcuts", () => {
  const env = approvalHygieneFixtureEnvironment();
  const draft = approvalHygieneTemplate.predicateTemplate(APPROVAL_HYGIENE_PARAMS, env);

  it("requires the token's own Approval(owner, spender, 0) event per revoked spender", () => {
    for (const spenderRole of APPROVAL_HYGIENE_PARAMS.unsafeSpenderRoles) {
      const predicateId = `revoke-event-${spenderRole.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "")}`;
      const predicate = draft.successPredicates.find((entry) => entry.label === predicateId);
      expect(predicate?.kind).toBe("eventEmitted");
      expect(approvalHygieneTemplate.hardening.requiredProtocolEvents.some(
        (entry) => entry.predicateId === predicateId && entry.contractRole === "token",
      )).toBe(true);
    }
  });

  it("holds the owner's token balance constant as a success predicate", () => {
    expect(draft.successPredicates.some((p) => p.label === "no-drain")).toBe(true);
  });

  it("excludes every unsafe-spender role from the tightened signer set", () => {
    for (const excluded of approvalHygieneTemplate.hardening.excludedAccountRoles) {
      if (APPROVAL_HYGIENE_PARAMS.unsafeSpenderRoles.includes(excluded.role)) {
        expect(draft.envelopeTightenings?.signerRoles).not.toContain(excluded.role);
      }
    }
  });

  it("bounds time advancement so a permit expiry cannot zero an allowance by waiting", () => {
    expect(draft.successPredicates.some((p) => p.kind === "timeBound")).toBe(true);
    expect(Number(draft.envelopeTightenings?.maxChainSecondsAdvanced))
      .toBeLessThanOrEqual(approvalHygieneTemplate.hardening.timeAdvancementBound.maxChainSeconds);
  });
});
