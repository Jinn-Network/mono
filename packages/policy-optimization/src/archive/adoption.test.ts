// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { expressAsRunPinning } from "@jinn-network/policy-identity";
import { manifestFor } from "../testing/archive-fixtures.js";
import { tupleFor } from "../testing/wave-fixtures.js";
import type { RecommendationDecision } from "../recommendation.js";
import {
  adopt,
  adoptionConfigFragment,
  currentAdoption,
  declaredAdoptionComponentClasses,
  emptyAdoptionLog,
  isAdoptionComponentClass,
  prepareAdoption,
  rollback,
  sortAdoptionComponentClasses,
} from "./adoption.js";
import { ADOPTION_RECORD_FORMAT_TOKEN } from "./tokens.js";
import type { AdoptionLog, AdoptionScope } from "./types.js";

const SCOPE: AdoptionScope = { taskProfile: "https://profiles.jinn.network/repository-work/1.0" };
const FIRST = `sha256:${"1".repeat(64)}`;
const SECOND = `sha256:${"2".repeat(64)}`;
const THIRD = `sha256:${"3".repeat(64)}`;

function logWith(...records: ReturnType<typeof adopt>[]): AdoptionLog {
  return { ...emptyAdoptionLog(), records };
}

describe("declaredAdoptionComponentClasses", () => {
  it("places learner-public.v1 roots on the §7.4 gradient", () => {
    expect(declaredAdoptionComponentClasses(manifestFor({
      name: "x", fill: "1", touchedComponents: ["notes/a.md", "skills/b", "hooks/c.sh"],
    }).manifest)).toEqual(["prompt", "skill", "hook"]);
  });

  it("classifies an unrecognized component as `unclassified` rather than the cheapest class", () => {
    expect(declaredAdoptionComponentClasses(manifestFor({
      name: "x", fill: "1", touchedComponents: ["something-new/thing"],
    }).manifest)).toEqual(["unclassified"]);
  });

  it("implies nothing when the candidate declares nothing", () => {
    expect(declaredAdoptionComponentClasses(manifestFor({
      name: "x", fill: "1", touchedComponents: [],
    }).manifest)).toEqual([]);
  });

  it("reads the first path segment, case-insensitively, and deduplicates", () => {
    expect(declaredAdoptionComponentClasses(manifestFor({
      name: "x", fill: "1", touchedComponents: ["./Hooks/one.sh", "hooks/two.sh"],
    }).manifest)).toEqual(["hook"]);
  });

  it("sorts along the gradient, cheapest first", () => {
    expect(sortAdoptionComponentClasses(["harness-fork", "prompt", "hook", "skill"]))
      .toEqual(["prompt", "skill", "hook", "harness-fork"]);
    expect(isAdoptionComponentClass("hook")).toBe(true);
    expect(isAdoptionComponentClass("hooks")).toBe(false);
  });
});

describe("adopt", () => {
  it("records the first adoption for a scope with a null prior", () => {
    const record = adopt({
      log: emptyAdoptionLog(), scope: SCOPE, tupleDigest: FIRST,
      requires: [], approved: [], adoptedAt: "2026-08-04T00:00:00Z",
    });
    expect(record).toEqual({
      formatToken: ADOPTION_RECORD_FORMAT_TOKEN,
      tupleDigest: FIRST,
      adoptedAt: "2026-08-04T00:00:00Z",
      scope: { taskProfile: SCOPE.taskProfile },
      priorTuple: null,
      payloadClassesApproved: [],
    });
  });

  it("reads priorTuple from the log rather than from the caller", () => {
    const first = adopt({ log: emptyAdoptionLog(), scope: SCOPE, tupleDigest: FIRST, requires: [], approved: [] });
    const second = adopt({ log: logWith(first), scope: SCOPE, tupleDigest: SECOND, requires: [], approved: [] });
    expect(second.priorTuple).toBe(FIRST);
  });

  it("scopes by task profile and route together", () => {
    const routed: AdoptionScope = { ...SCOPE, route: "nightly" };
    const first = adopt({ log: emptyAdoptionLog(), scope: SCOPE, tupleDigest: FIRST, requires: [], approved: [] });
    const other = adopt({ log: logWith(first), scope: routed, tupleDigest: SECOND, requires: [], approved: [] });
    expect(other.priorTuple).toBeNull();
    expect(other.scope.route).toBe("nightly");
    expect(currentAdoption(logWith(first, other), SCOPE)!.tupleDigest).toBe(FIRST);
    expect(currentAdoption(logWith(first, other), routed)!.tupleDigest).toBe(SECOND);
  });

  // §7.4: the classes are not interchangeable — consenting to a prompt is not consenting to code.
  it("refuses a class the operator did not approve by name", () => {
    let thrown: unknown;
    try {
      adopt({
        log: emptyAdoptionLog(), scope: SCOPE, tupleDigest: FIRST,
        requires: ["prompt", "hook"], approved: ["prompt"],
      });
    } catch (cause) {
      thrown = cause;
    }
    expect(thrown).toMatchObject({ category: "adoption-gate" });
    expect((thrown as Error).message).toContain("hook");
  });

  it("refuses `unclassified` unless it is approved by that name", () => {
    expect(() => adopt({
      log: emptyAdoptionLog(), scope: SCOPE, tupleDigest: FIRST,
      requires: ["unclassified"], approved: ["prompt", "skill", "hook", "harness-fork"],
    })).toThrow(expect.objectContaining({ category: "adoption-gate" }));
    expect(adopt({
      log: emptyAdoptionLog(), scope: SCOPE, tupleDigest: FIRST,
      requires: ["unclassified"], approved: ["unclassified"],
    }).payloadClassesApproved).toEqual(["unclassified"]);
  });

  it("admits a candidate whose classes are all approved and records the approvals", () => {
    expect(adopt({
      log: emptyAdoptionLog(), scope: SCOPE, tupleDigest: FIRST,
      requires: ["hook", "prompt"], approved: ["hook", "prompt", "skill"],
    }).payloadClassesApproved).toEqual(["prompt", "skill", "hook"]);
  });

  it("refuses re-adopting the tuple already in force", () => {
    const first = adopt({ log: emptyAdoptionLog(), scope: SCOPE, tupleDigest: FIRST, requires: [], approved: [] });
    expect(() => adopt({ log: logWith(first), scope: SCOPE, tupleDigest: FIRST, requires: [], approved: [] }))
      .toThrow(expect.objectContaining({ category: "adoption-gate" }));
  });
});

describe("prepareAdoption", () => {
  const decision: RecommendationDecision = {
    projection: "RecommendationDecision" as const,
    status: "inconclusive" as const,
    recommendedTupleDigest: FIRST,
    currentTupleDigest: FIRST,
    challengerTupleDigest: SECOND,
    reasonCodes: ["mcnemar-not-significant" as const],
    basis: { runDigest: FIRST, matrixDigest: SECOND, reportDigests: [], methodRefs: [] },
    limitations: [
      "independence: disclosed — solver and evaluator roles use separate identities and keys, but the same operator, host, OS user, and administrative domain control both" as const,
    ],
  };

  it("keeps inconclusive adoption behind the explicit advanced override and records its label", () => {
    expect(() => prepareAdoption({
      log: emptyAdoptionLog(), scope: SCOPE, tupleDigest: SECOND, requires: [], approved: [],
      recommendation: decision, baseConfigurationRevision: "r1", currentConfigurationRevision: "r1",
      routePayloadConsent: true, explicitConfirmation: true,
    })).toThrow(/advanced override/u);
    const record = prepareAdoption({
      log: emptyAdoptionLog(), scope: SCOPE, tupleDigest: SECOND, requires: ["hook"], approved: ["hook"],
      recommendation: decision, baseConfigurationRevision: "r1", currentConfigurationRevision: "r1",
      routePayloadConsent: true, explicitConfirmation: true,
      overrideInconclusive: { warningAcknowledged: true, reason: "operator accepts local risk" },
    });
    expect(record).toMatchObject({
      tupleDigest: SECOND,
      recommendationStatus: "inconclusive",
      overrideReason: "operator accepts local risk",
      baseConfigurationRevision: "r1",
      payloadClassesApproved: ["hook"],
    });
  });

  it("preserves the promising label on an advanced operator override", () => {
    const promising = { ...decision, status: "promising" as const };
    const record = prepareAdoption({
      log: emptyAdoptionLog(), scope: SCOPE, tupleDigest: SECOND, requires: [], approved: [],
      recommendation: promising, baseConfigurationRevision: "r1", currentConfigurationRevision: "r1",
      routePayloadConsent: true, explicitConfirmation: true,
      overrideInconclusive: { warningAcknowledged: true, reason: "continue learning in production" },
    });
    expect(record.recommendationStatus).toBe("promising");
  });

  it("refuses an override when configuration moved after the campaign snapshot", () => {
    expect(() => prepareAdoption({
      log: emptyAdoptionLog(), scope: SCOPE, tupleDigest: SECOND, requires: [], approved: [],
      recommendation: decision, baseConfigurationRevision: "r1", currentConfigurationRevision: "r2",
      routePayloadConsent: true, explicitConfirmation: true,
      overrideInconclusive: { warningAcknowledged: true, reason: "risk accepted" },
    })).toThrow(/declared baseline moved/u);
  });
});

describe("rollback", () => {
  it("restores the prior tuple as a new appended record", () => {
    const first = adopt({ log: emptyAdoptionLog(), scope: SCOPE, tupleDigest: FIRST, requires: ["hook"], approved: ["hook"] });
    const second = adopt({ log: logWith(first), scope: SCOPE, tupleDigest: SECOND, requires: [], approved: [] });
    const undone = rollback(logWith(first, second), SCOPE, "2026-08-04T01:00:00Z");

    expect(undone.tupleDigest).toBe(FIRST);
    expect(undone.priorTuple).toBe(SECOND);
    expect(undone.adoptedAt).toBe("2026-08-04T01:00:00Z");
    // The approvals come from the record being restored, not from a fresh consent.
    expect(undone.payloadClassesApproved).toEqual(["hook"]);
  });

  it("round-trips: adopt -> adopt -> rollback puts the first tuple back in force", () => {
    const first = adopt({ log: emptyAdoptionLog(), scope: SCOPE, tupleDigest: FIRST, requires: [], approved: [] });
    const second = adopt({ log: logWith(first), scope: SCOPE, tupleDigest: SECOND, requires: [], approved: [] });
    const undone = rollback(logWith(first, second), SCOPE);
    const log = logWith(first, second, undone);

    expect(currentAdoption(log, SCOPE)!.tupleDigest).toBe(FIRST);
    // Append-only: nothing was removed, so the whole history is still auditable.
    expect(log.records.map((record) => record.tupleDigest)).toEqual([FIRST, SECOND, FIRST]);
  });

  it("rolls back twice, walking the chain backwards", () => {
    const first = adopt({ log: emptyAdoptionLog(), scope: SCOPE, tupleDigest: FIRST, requires: [], approved: [] });
    const second = adopt({ log: logWith(first), scope: SCOPE, tupleDigest: SECOND, requires: [], approved: [] });
    const third = adopt({ log: logWith(first, second), scope: SCOPE, tupleDigest: THIRD, requires: [], approved: [] });
    const back = rollback(logWith(first, second, third), SCOPE);
    expect(back.tupleDigest).toBe(SECOND);
    const further = rollback(logWith(first, second, third, back), SCOPE);
    expect(further.tupleDigest).toBe(THIRD);
  });

  it("refuses when nothing is adopted for the scope", () => {
    expect(() => rollback(emptyAdoptionLog(), SCOPE))
      .toThrow(expect.objectContaining({ category: "adoption-gate" }));
  });

  it("refuses rolling back the first adoption — the log has no policy to restore", () => {
    const first = adopt({ log: emptyAdoptionLog(), scope: SCOPE, tupleDigest: FIRST, requires: [], approved: [] });
    let thrown: unknown;
    try {
      rollback(logWith(first), SCOPE);
    } catch (cause) {
      thrown = cause;
    }
    expect(thrown).toMatchObject({ category: "adoption-gate" });
    expect((thrown as Error).message).toContain("unpin the route");
  });
});

describe("adoptionConfigFragment", () => {
  // §9 is an operator-local decision; the product emits the fragment and never edits a daemon.
  it("expresses the adopted tuple as run pinning, byte-identical to a wave arm's", () => {
    const tuple = tupleFor("adopted", "5");
    const record = adopt({
      log: emptyAdoptionLog(), scope: { ...SCOPE, route: "nightly" },
      tupleDigest: FIRST, requires: [], approved: [],
    });
    expect(adoptionConfigFragment(record, tuple)).toEqual({
      taskProfile: SCOPE.taskProfile,
      route: "nightly",
      tupleDigest: FIRST,
      requirements: expressAsRunPinning(tuple),
    });
  });
});

describe("emptyAdoptionLog", () => {
  it("carries the §8.3 non-derivability label in the document itself", () => {
    const log = emptyAdoptionLog();
    expect(log.nonDerivable).toBe(true);
    expect(log.note).toContain("NOT re-derivable");
    expect(log.formatToken).toBe(ADOPTION_RECORD_FORMAT_TOKEN);
    expect(log.records).toEqual([]);
  });
});
