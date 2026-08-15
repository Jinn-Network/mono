// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import { lendingLifecycleTemplate } from "./families/lending-lifecycle.js";
import { assertTemplateHardened } from "./hardening.js";

describe("a template whose predicates do not honor its own checklist is refused", () => {
  it("refuses a checklist requiring a protocol event the predicates never require", () => {
    const template = {
      ...lendingLifecycleTemplate,
      hardening: {
        ...lendingLifecycleTemplate.hardening,
        requiredProtocolEvents: [
          ...lendingLifecycleTemplate.hardening.requiredProtocolEvents,
          {
            predicateId: "phantom-event",
            contractRole: "pool",
            signature: "Repay(address,address,uint256)",
            why: "a checklist entry with no matching predicate",
          },
        ],
      },
    };
    expect(() => assertTemplateHardened(template)).toThrow(/phantom-event/);
  });

  it("refuses a checklist naming a forbidden route the predicates do not forbid", () => {
    const template = {
      ...lendingLifecycleTemplate,
      hardening: {
        ...lendingLifecycleTemplate.hardening,
        forbiddenRoutes: [
          ...lendingLifecycleTemplate.hardening.forbiddenRoutes,
          { predicateId: "no-otc", addressRoles: ["otc-desk"], why: "not actually forbidden" },
        ],
      },
    };
    expect(() => assertTemplateHardened(template)).toThrow(/no-otc/);
  });

  it("refuses an envelope that grants a signer role the checklist excludes", () => {
    const template = {
      ...lendingLifecycleTemplate,
      hardening: {
        ...lendingLifecycleTemplate.hardening,
        excludedAccountRoles: [
          ...lendingLifecycleTemplate.hardening.excludedAccountRoles,
          { role: "borrower", why: "excluded and granted at the same time — a contradiction" },
        ],
      },
    };
    expect(() => assertTemplateHardened(template)).toThrow(/borrower/);
  });

  it("refuses a time bound the generated predicates do not enforce", () => {
    const template = {
      ...lendingLifecycleTemplate,
      hardening: {
        ...lendingLifecycleTemplate.hardening,
        timeAdvancementBound: { maxChainSeconds: 1, why: "tighter than the emitted timeBound" },
      },
    };
    expect(() => assertTemplateHardened(template)).toThrow(/time advancement/i);
  });

  it("refuses a template with no residual-risk acknowledgement", () => {
    const template = {
      ...lendingLifecycleTemplate,
      hardening: { ...lendingLifecycleTemplate.hardening, acknowledgedResidualRisk: "" },
    };
    expect(() => assertTemplateHardened(template)).toThrow(/residual risk/i);
  });

  it("admits the shipped template unchanged", () => {
    expect(() => assertTemplateHardened(lendingLifecycleTemplate)).not.toThrow();
  });
});

describe("the checklist is a mitigation with acknowledged residual risk", () => {
  it("says so in its own residual-risk field, which every shipped template must fill", () => {
    expect(lendingLifecycleTemplate.hardening.acknowledgedResidualRisk)
      .toMatch(/does not guarantee|proves nothing about non-gameability/i);
  });
});
