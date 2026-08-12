// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import {
  corroborate,
  corroborationForAxis,
  hasExecutionEvidence,
  localPinningObservation,
  LOCAL_AXIS_STRENGTH,
  pinningObservationForCell,
  pinningStatusForAxis,
  requirementsDigest,
  type LocalCellPinningEvidence,
  type LocalPinningVenue,
} from "./pinning-bridge.js";

const HARNESS = { id: "claude-code", version: "2.1.34" };
const MODEL = { id: "anthropic/claude-haiku-4-5" };
const LOADOUT = { kind: "jinn.skill.v1", name: "repo-work", digest: `sha256:${"a".repeat(64)}` };
// The harness-state loadout kind (policy identity design §4.2, task-execution program §1 C5):
// the bridge never inspects `kind` — it compares the whole pinning value structurally, exactly
// as it does for jinn.skill.v1 above — so a second kind flows through with no bridge change.
const HARNESS_STATE_LOADOUT = { kind: "jinn.harness-state.v1", name: "learner-state", digest: `sha256:${"d".repeat(64)}` };

const PINNING = {
  harness: HARNESS,
  model: MODEL,
  loadout: LOADOUT,
  isolationPolicy: "unrestricted",
};

/** The inventory every launcher declares today. */
const VENUE: LocalPinningVenue = { isolationInventory: ["unrestricted"] };

function admittedFor(pinning: Readonly<Record<string, unknown>>): LocalCellPinningEvidence {
  return { admission: { ready: true, checkedRequirementsDigest: requirementsDigest(pinning) } };
}

const ADMITTED: LocalCellPinningEvidence = admittedFor(PINNING);

describe("corroborate", () => {
  test("an exact object observation corroborates an exact pin", () => {
    expect(corroborate(HARNESS, { id: "claude-code", version: "2.1.34" })).toBe("corroborates");
  });

  test("a declared field observed with a different value disagrees", () => {
    expect(corroborate(HARNESS, { id: "claude-code", version: "2.0.0" })).toBe("disagrees");
  });

  test("an observation silent about a declared field is inconclusive, never a match", () => {
    expect(corroborate(HARNESS, { id: "claude-code" })).toBe("inconclusive");
  });

  test("a constraint-shaped pin corroborates by satisfaction, not by equality", () => {
    // `{provider}`-only pins name a family; a richer observation inside the family satisfies it.
    expect(corroborate({ provider: "anthropic" }, { provider: "anthropic", id: "haiku" }))
      .toBe("corroborates");
    expect(corroborate({ provider: "anthropic" }, { provider: "openai", id: "gpt" }))
      .toBe("disagrees");
  });

  test("enrichment beyond the pin never disagrees on its own", () => {
    // A venue that knows the harness binary digest must not turn that knowledge into a
    // contradiction of a pin that only carried `{id, version}`.
    expect(corroborate(HARNESS, { ...HARNESS, digest: `sha256:${"b".repeat(64)}` }))
      .toBe("corroborates");
  });

  test("scalar pins compare by equality", () => {
    expect(corroborate("unrestricted", "unrestricted")).toBe("corroborates");
    expect(corroborate("unrestricted", "sandboxed")).toBe("disagrees");
  });

  test("a shape change between pin and observation is an affirmative disagreement", () => {
    expect(corroborate(HARNESS, "claude-code")).toBe("disagrees");
    expect(corroborate("unrestricted", { id: "unrestricted" })).toBe("disagrees");
  });

  test("array-valued pins compare element-wise", () => {
    expect(corroborate({ tags: ["a", "b"] }, { tags: ["a", "b"] })).toBe("corroborates");
    expect(corroborate({ tags: ["a", "b"] }, { tags: ["b", "a"] })).toBe("disagrees");
  });
});

describe("corroborationForAxis", () => {
  test("ignores observations for other axes", () => {
    expect(corroborationForAxis(MODEL, [
      { axis: "harness", value: { id: "other" }, source: "runtime-observation" },
    ], "model")).toBe("inconclusive");
  });

  test("one disagreeing observation is terminal even beside corroborating ones", () => {
    expect(corroborationForAxis(MODEL, [
      { axis: "model", value: MODEL, source: "admission-probe" },
      { axis: "model", value: { id: "anthropic/claude-opus-4" }, source: "runtime-observation" },
    ], "model")).toBe("disagrees");
  });

  test("corroboration survives a later inconclusive observation", () => {
    expect(corroborationForAxis(HARNESS, [
      { axis: "harness", value: HARNESS, source: "materialization" },
      { axis: "harness", value: { id: "claude-code" }, source: "runtime-observation" },
    ], "harness")).toBe("corroborates");
  });
});

describe("hasExecutionEvidence", () => {
  test("an unknown or empty cell has none", () => {
    expect(hasExecutionEvidence(undefined)).toBe(false);
    expect(hasExecutionEvidence({})).toBe(false);
  });

  test("an explicit dispatch count is authoritative in both directions", () => {
    expect(hasExecutionEvidence({ dispatches: 0 })).toBe(false);
    expect(hasExecutionEvidence({ dispatches: 1 })).toBe(true);
    // A declared zero-dispatch cell is not outvoted by a stray admission record.
    expect(hasExecutionEvidence({
      dispatches: 0,
      admission: { ready: true, checkedRequirementsDigest: requirementsDigest({}) },
    })).toBe(false);
  });

  test("an admission attempt or a recorded observation counts", () => {
    expect(hasExecutionEvidence({
      admission: { ready: false, checkedRequirementsDigest: requirementsDigest({}) },
    })).toBe(true);
    expect(hasExecutionEvidence({
      observations: [{ axis: "model", value: MODEL, source: "runtime-observation" }],
    })).toBe(true);
  });
});

describe("pinningStatusForAxis (identity design §7)", () => {
  test("an unpinned axis is unverifiable", () => {
    expect(pinningStatusForAxis({ axis: "model", pinning: {}, evidence: ADMITTED, venue: VENUE }))
      .toBe("unverifiable");
  });

  test("a null-filled core axis is unverifiable, not a vacuous match", () => {
    expect(pinningStatusForAxis({
      axis: "model",
      pinning: { model: null },
      evidence: ADMITTED,
      venue: VENUE,
    })).toBe("unverifiable");
  });

  test("an enforced axis matches on an accepted admission with no observation", () => {
    // The gate is the enforcement; the bridge must not fabricate an observation to reach it.
    expect(pinningStatusForAxis({
      axis: "harness",
      pinning: PINNING,
      evidence: ADMITTED,
      venue: VENUE,
    })).toBe("match");
  });

  test("an enforced axis matches when the observation also corroborates", () => {
    expect(pinningStatusForAxis({
      axis: "loadout",
      pinning: PINNING,
      venue: VENUE,
      evidence: {
        ...ADMITTED,
        observations: [{ axis: "loadout", value: LOADOUT, source: "materialization" }],
      },
    })).toBe("match");
  });

  test("a disagreeing observation is a mismatch even on an accepted admission", () => {
    expect(pinningStatusForAxis({
      axis: "loadout",
      pinning: PINNING,
      venue: VENUE,
      evidence: {
        ...ADMITTED,
        observations: [{
          axis: "loadout",
          value: { ...LOADOUT, digest: `sha256:${"c".repeat(64)}` },
          source: "materialization",
        }],
      },
    })).toBe("mismatch");
  });

  test("a jinn.harness-state.v1 loadout pin flows through exactly like jinn.skill.v1 (task-execution program §1 C5)", () => {
    const harnessStatePinning = { ...PINNING, loadout: HARNESS_STATE_LOADOUT };
    expect(pinningStatusForAxis({
      axis: "loadout",
      pinning: harnessStatePinning,
      venue: VENUE,
      evidence: {
        ...admittedFor(harnessStatePinning),
        observations: [{ axis: "loadout", value: HARNESS_STATE_LOADOUT, source: "materialization" }],
      },
    })).toBe("match");
    // A disagreeing observation (a different tree digest) is still a mismatch, kind-independent.
    expect(pinningStatusForAxis({
      axis: "loadout",
      pinning: harnessStatePinning,
      venue: VENUE,
      evidence: {
        ...admittedFor(harnessStatePinning),
        observations: [{
          axis: "loadout",
          value: { ...HARNESS_STATE_LOADOUT, digest: `sha256:${"e".repeat(64)}` },
          source: "materialization",
        }],
      },
    })).toBe("mismatch");
    // No observation, admission alone: still enforced, still matches — same as jinn.skill.v1.
    expect(pinningStatusForAxis({
      axis: "loadout",
      pinning: harnessStatePinning,
      evidence: admittedFor(harnessStatePinning),
      venue: VENUE,
    })).toBe("match");
  });

  test("absent admission evidence stays unverifiable", () => {
    expect(pinningStatusForAxis({ axis: "harness", pinning: PINNING, venue: VENUE }))
      .toBe("unverifiable");
    expect(pinningStatusForAxis({
      axis: "harness",
      pinning: PINNING,
      evidence: {},
      venue: VENUE,
    })).toBe("unverifiable");
  });

  test("a rejected admission is unverifiable, not a mismatch", () => {
    // A rejection means nothing ran. That is not evidence that a different value ran.
    expect(pinningStatusForAxis({
      axis: "harness",
      pinning: PINNING,
      venue: VENUE,
      evidence: {
        admission: {
          ready: false,
          detail: "harness digest mismatch",
          checkedRequirementsDigest: requirementsDigest(PINNING),
        },
      },
    })).toBe("unverifiable");
  });

  test("a rejected admission still yields mismatch when an observation disagrees", () => {
    expect(pinningStatusForAxis({
      axis: "model",
      pinning: PINNING,
      venue: VENUE,
      evidence: {
        admission: {
          ready: false,
          detail: "model pin mismatch",
          checkedRequirementsDigest: requirementsDigest(PINNING),
        },
        observations: [{ axis: "model", value: { id: "other" }, source: "admission-probe" }],
      },
    })).toBe("mismatch");
  });

  test("an attested axis reaches match only through a corroborating observation", () => {
    expect(pinningStatusForAxis({
      axis: "harness",
      pinning: PINNING,
      evidence: ADMITTED,
      venue: VENUE,
      strength: "attested",
    })).toBe("unverifiable");
    expect(pinningStatusForAxis({
      axis: "harness",
      pinning: PINNING,
      venue: VENUE,
      strength: "attested",
      evidence: {
        ...ADMITTED,
        observations: [{ axis: "harness", value: HARNESS, source: "runtime-observation" }],
      },
    })).toBe("match");
  });
});

describe("the admission receipt is bound to the pinning it was issued against", () => {
  test("a bare readiness boolean is not identity proof", () => {
    expect(pinningStatusForAxis({
      axis: "model",
      pinning: PINNING,
      venue: VENUE,
      // Runtime compatibility check: legacy/fabricated input can still reach this JS boundary,
      // but the bridge refuses it. The public type now prevents constructing it accidentally.
      evidence: { admission: { ready: true } } as unknown as LocalCellPinningEvidence,
    })).toBe("unverifiable");
  });

  test("a receipt naming this exact pinning keeps its force", () => {
    expect(pinningStatusForAxis({
      axis: "model",
      pinning: PINNING,
      venue: VENUE,
      evidence: {
        admission: { ready: true, checkedRequirementsDigest: requirementsDigest(PINNING) },
      },
    })).toBe("match");
  });

  test("a receipt naming a different map costs every enforced axis its admission leg", () => {
    const evidence: LocalCellPinningEvidence = {
      admission: {
        ready: true,
        checkedRequirementsDigest: requirementsDigest({ model: { id: "someone-else" } }),
      },
    };
    expect(pinningObservationForCell({ pinning: PINNING, evidence, venue: VENUE })).toEqual({
      harness: "unverifiable",
      model: "unverifiable",
      loadout: "unverifiable",
      // Isolation never rested on the run-pinning gate, and the cell has execution evidence.
      isolation: "match",
    });
  });

  test("a mis-bound receipt never suppresses affirmative mismatch evidence", () => {
    // Downgrading an observed mismatch to `unverifiable` would hide a fact about the cell.
    expect(pinningStatusForAxis({
      axis: "model",
      pinning: PINNING,
      venue: VENUE,
      evidence: {
        admission: { ready: true, checkedRequirementsDigest: `sha256:${"9".repeat(64)}` },
        observations: [{ axis: "model", value: { id: "other" }, source: "runtime-observation" }],
      },
    })).toBe("mismatch");
  });

  test("the digest is JCS-stable across key order", () => {
    expect(requirementsDigest({ model: MODEL, harness: HARNESS }))
      .toBe(requirementsDigest({ harness: HARNESS, model: MODEL }));
  });
});

describe("an id-only harness pin is one the gate never inspects", () => {
  test("it cannot reach match on an accepted admission", () => {
    expect(pinningStatusForAxis({
      axis: "harness",
      pinning: { harness: { id: "codex" } },
      venue: VENUE,
      evidence: ADMITTED,
    })).toBe("unverifiable");
  });

  test("adding a version or a digest restores the enforced leg", () => {
    const versionPinning = { harness: { id: "codex", version: "1.0.0" } };
    expect(pinningStatusForAxis({
      axis: "harness",
      pinning: versionPinning,
      venue: VENUE,
      evidence: admittedFor(versionPinning),
    })).toBe("match");
    const digestPinning = { harness: { id: "codex", digest: `sha256:${"f".repeat(64)}` } };
    expect(pinningStatusForAxis({
      axis: "harness",
      pinning: digestPinning,
      venue: VENUE,
      evidence: admittedFor(digestPinning),
    })).toBe("match");
  });

  test("it still reports mismatch when an observation disagrees", () => {
    expect(pinningStatusForAxis({
      axis: "harness",
      pinning: { harness: { id: "codex" } },
      venue: VENUE,
      evidence: {
        admission: {
          ready: true,
          checkedRequirementsDigest: requirementsDigest({ harness: { id: "codex" } }),
        },
        observations: [{
          axis: "harness",
          value: { id: "claude-code" },
          source: "runtime-observation",
        }],
      },
    })).toBe("mismatch");
  });

  test("the rule is specific to harness; other axes are unaffected", () => {
    const modelPinning = { model: { id: "anthropic/claude-haiku-4-5" } };
    expect(pinningStatusForAxis({
      axis: "model",
      pinning: modelPinning,
      venue: VENUE,
      evidence: admittedFor(modelPinning),
    })).toBe("match");
  });
});

describe("the vacuous isolation axis", () => {
  test("is declared vacuous, not enforced", () => {
    expect(LOCAL_AXIS_STRENGTH.isolation).toBe("vacuous");
    expect(LOCAL_AXIS_STRENGTH.harness).toBe("enforced");
  });

  test("matches when the pin equals the sole inventory value and something ran", () => {
    // A vacuous match is still a match: the venue structurally could not have run anything
    // else. The vacuity is disclosed by the axis's strength, not by hiding the status.
    expect(pinningStatusForAxis({
      axis: "isolation",
      pinning: PINNING,
      venue: VENUE,
      evidence: ADMITTED,
    })).toBe("match");
  });

  test("needs no admission-gate verdict, because the gate never inspects it", () => {
    expect(pinningStatusForAxis({
      axis: "isolation",
      pinning: PINNING,
      venue: VENUE,
      evidence: {
        admission: {
          ready: false,
          detail: "loadout digest mismatch",
          checkedRequirementsDigest: requirementsDigest(PINNING),
        },
      },
    })).toBe("match");
  });

  test("requires execution evidence: a cell with nothing recorded is unverifiable", () => {
    // "The venue could not have run anything else" presupposes that the venue ran something.
    expect(pinningStatusForAxis({ axis: "isolation", pinning: PINNING, venue: VENUE }))
      .toBe("unverifiable");
    expect(pinningStatusForAxis({
      axis: "isolation",
      pinning: PINNING,
      venue: VENUE,
      evidence: {},
    })).toBe("unverifiable");
  });

  test("an expired, never-dispatched cell is unverifiable", () => {
    expect(pinningStatusForAxis({
      axis: "isolation",
      pinning: PINNING,
      venue: VENUE,
      evidence: { dispatches: 0 },
    })).toBe("unverifiable");
  });

  test("a recorded observation alone is enough execution evidence", () => {
    expect(pinningStatusForAxis({
      axis: "isolation",
      pinning: PINNING,
      venue: VENUE,
      evidence: {
        observations: [{
          axis: "isolation",
          value: "unrestricted",
          source: "runtime-observation",
        }],
      },
    })).toBe("match");
  });

  test("is unverifiable when the venue offers more than one isolation value", () => {
    expect(pinningStatusForAxis({
      axis: "isolation",
      pinning: PINNING,
      evidence: ADMITTED,
      venue: { isolationInventory: ["unrestricted", "sandboxed"] },
    })).toBe("unverifiable");
  });

  test("is unverifiable when the pin is outside the inventory", () => {
    expect(pinningStatusForAxis({
      axis: "isolation",
      pinning: { isolationPolicy: "sandboxed" },
      evidence: ADMITTED,
      venue: VENUE,
    })).toBe("unverifiable");
  });

  test("is a mismatch when an observation says another policy ran", () => {
    expect(pinningStatusForAxis({
      axis: "isolation",
      pinning: PINNING,
      venue: VENUE,
      evidence: {
        observations: [{ axis: "isolation", value: "sandboxed", source: "runtime-observation" }],
      },
    })).toBe("mismatch");
  });
});

describe("pinningObservationForCell", () => {
  test("reports every axis", () => {
    expect(pinningObservationForCell({ pinning: PINNING, evidence: ADMITTED, venue: VENUE }))
      .toEqual({
        harness: "match",
        model: "match",
        loadout: "match",
        isolation: "match",
      });
  });

  test("degrades axis by axis rather than as a block", () => {
    expect(pinningObservationForCell({
      pinning: { harness: HARNESS, isolationPolicy: "unrestricted" },
      venue: VENUE,
      evidence: {
        ...admittedFor({ harness: HARNESS, isolationPolicy: "unrestricted" }),
        observations: [{ axis: "harness", value: { id: "codex" }, source: "runtime-observation" }],
      },
    })).toEqual({
      harness: "mismatch",
      model: "unverifiable",
      loadout: "unverifiable",
      isolation: "match",
    });
  });
});

describe("localPinningObservation port", () => {
  const port = (evidence: Record<string, LocalCellPinningEvidence>) =>
    localPinningObservation({
      isolationInventory: ["unrestricted"],
      submissionBaseline: { isolationPolicy: "unrestricted", harness: HARNESS },
      evidenceFor: (cellKey) => evidence[cellKey],
    });

  test("merges the submission baseline under the arm pinning", async () => {
    const observed = await port({ "task/arm/1": ADMITTED }).observe(null, {
      cellKey: "task/arm/1",
      arm: { armId: "arm", pinning: { model: MODEL, loadout: LOADOUT } },
    });
    // `harness` and `isolationPolicy` came from the baseline; both are still graded.
    expect(observed).toEqual({
      harness: "match",
      model: "match",
      loadout: "match",
      isolation: "match",
    });
  });

  test("lets an arm pin override the baseline for grading", async () => {
    const observed = await port({
      "task/arm/1": {
        ...admittedFor({
          isolationPolicy: "unrestricted",
          harness: { id: "codex", version: "1.0.0" },
        }),
        observations: [{ axis: "harness", value: HARNESS, source: "runtime-observation" }],
      },
    }).observe(null, {
      cellKey: "task/arm/1",
      arm: { armId: "arm", pinning: { harness: { id: "codex", version: "1.0.0" } } },
    });
    // The observation matches the *baseline* harness, which the arm overrode — so the value
    // that ran contradicts the value this cell pinned.
    expect(observed.harness).toBe("mismatch");
  });

  test("reports unverifiable on every axis for a cell with no evidence", async () => {
    const observed = await port({}).observe(null, {
      cellKey: "unknown/arm/1",
      arm: { armId: "arm", pinning: { model: MODEL } },
    });
    // Including isolation: an unknown cell has no execution to characterize.
    expect(observed).toEqual({
      harness: "unverifiable",
      model: "unverifiable",
      loadout: "unverifiable",
      isolation: "unverifiable",
    });
  });

  test("reports unverifiable everywhere for an unrecognized call shape", async () => {
    const bag = port({});
    expect(await bag.observe(null, undefined)).toEqual({
      harness: "unverifiable",
      model: "unverifiable",
      loadout: "unverifiable",
      isolation: "unverifiable",
    });
    expect(await bag.observe(null, { arm: { pinning: {} } })).toEqual({
      harness: "unverifiable",
      model: "unverifiable",
      loadout: "unverifiable",
      isolation: "unverifiable",
    });
  });

  test("accepts an async evidence lookup", async () => {
    const bag = localPinningObservation({
      isolationInventory: ["unrestricted"],
      evidenceFor: async () => ADMITTED,
    });
    expect(await bag.observe(null, {
      cellKey: "task/arm/1",
      arm: { armId: "arm", pinning: PINNING },
    })).toEqual({
      harness: "match",
      model: "match",
      loadout: "match",
      isolation: "match",
    });
  });
});
