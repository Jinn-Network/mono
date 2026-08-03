// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import {
  corroborate,
  corroborationForAxis,
  localPinningObservation,
  LOCAL_AXIS_STRENGTH,
  pinningObservationForCell,
  pinningStatusForAxis,
  type LocalCellPinningEvidence,
} from "./pinning-bridge.js";

const HARNESS = { id: "claude-code", version: "2.1.34" };
const MODEL = { id: "anthropic/claude-haiku-4-5" };
const LOADOUT = { kind: "jinn.skill.v1", name: "repo-work", digest: `sha256:${"a".repeat(64)}` };

const PINNING = {
  harness: HARNESS,
  model: MODEL,
  loadout: LOADOUT,
  isolationPolicy: "unrestricted",
};

const ADMITTED: LocalCellPinningEvidence = { admission: { ready: true } };

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

describe("pinningStatusForAxis (identity design §7)", () => {
  test("an unpinned axis is unverifiable", () => {
    expect(pinningStatusForAxis({ axis: "model", pinning: {}, evidence: ADMITTED }))
      .toBe("unverifiable");
  });

  test("a null-filled core axis is unverifiable, not a vacuous match", () => {
    expect(pinningStatusForAxis({ axis: "model", pinning: { model: null }, evidence: ADMITTED }))
      .toBe("unverifiable");
  });

  test("an enforced axis matches on an accepted admission with no observation", () => {
    // The gate is the enforcement; the bridge must not fabricate an observation to reach it.
    expect(pinningStatusForAxis({ axis: "harness", pinning: PINNING, evidence: ADMITTED }))
      .toBe("match");
  });

  test("an enforced axis matches when the observation also corroborates", () => {
    expect(pinningStatusForAxis({
      axis: "loadout",
      pinning: PINNING,
      evidence: {
        admission: { ready: true },
        observations: [{ axis: "loadout", value: LOADOUT, source: "materialization" }],
      },
    })).toBe("match");
  });

  test("a disagreeing observation is a mismatch even on an accepted admission", () => {
    expect(pinningStatusForAxis({
      axis: "loadout",
      pinning: PINNING,
      evidence: {
        admission: { ready: true },
        observations: [{
          axis: "loadout",
          value: { ...LOADOUT, digest: `sha256:${"c".repeat(64)}` },
          source: "materialization",
        }],
      },
    })).toBe("mismatch");
  });

  test("absent admission evidence stays unverifiable", () => {
    expect(pinningStatusForAxis({ axis: "harness", pinning: PINNING })).toBe("unverifiable");
    expect(pinningStatusForAxis({ axis: "harness", pinning: PINNING, evidence: {} }))
      .toBe("unverifiable");
  });

  test("a rejected admission is unverifiable, not a mismatch", () => {
    // A rejection means nothing ran. That is not evidence that a different value ran.
    expect(pinningStatusForAxis({
      axis: "harness",
      pinning: PINNING,
      evidence: { admission: { ready: false, detail: "harness digest mismatch" } },
    })).toBe("unverifiable");
  });

  test("a rejected admission still yields mismatch when an observation disagrees", () => {
    expect(pinningStatusForAxis({
      axis: "model",
      pinning: PINNING,
      evidence: {
        admission: { ready: false, detail: "model pin mismatch" },
        observations: [{ axis: "model", value: { id: "other" }, source: "admission-probe" }],
      },
    })).toBe("mismatch");
  });

  test("an attested axis reaches match only through a corroborating observation", () => {
    expect(pinningStatusForAxis({
      axis: "harness",
      pinning: PINNING,
      evidence: ADMITTED,
      strength: "attested",
    })).toBe("unverifiable");
    expect(pinningStatusForAxis({
      axis: "harness",
      pinning: PINNING,
      evidence: {
        admission: { ready: true },
        observations: [{ axis: "harness", value: HARNESS, source: "runtime-observation" }],
      },
      strength: "attested",
    })).toBe("match");
  });
});

describe("the vacuous isolation axis", () => {
  test("is declared vacuous, not enforced", () => {
    expect(LOCAL_AXIS_STRENGTH.isolation).toBe("vacuous");
    expect(LOCAL_AXIS_STRENGTH.harness).toBe("enforced");
  });

  test("matches when the pin equals the venue's sole inventory value", () => {
    // A vacuous match is still a match: the venue structurally could not have run anything
    // else. The vacuity is disclosed by the axis's strength, not by hiding the status.
    expect(pinningStatusForAxis({ axis: "isolation", pinning: PINNING })).toBe("match");
  });

  test("needs no admission-gate result, because the gate never inspects it", () => {
    expect(pinningStatusForAxis({
      axis: "isolation",
      pinning: PINNING,
      evidence: { admission: { ready: false, detail: "loadout digest mismatch" } },
    })).toBe("match");
  });

  test("is unverifiable when the venue offers more than one isolation value", () => {
    expect(pinningStatusForAxis({
      axis: "isolation",
      pinning: PINNING,
      venue: { isolationInventory: ["unrestricted", "sandboxed"] },
    })).toBe("unverifiable");
  });

  test("is unverifiable when the pin is outside the inventory", () => {
    expect(pinningStatusForAxis({
      axis: "isolation",
      pinning: { isolationPolicy: "sandboxed" },
    })).toBe("unverifiable");
  });

  test("is a mismatch when an observation says another policy ran", () => {
    expect(pinningStatusForAxis({
      axis: "isolation",
      pinning: PINNING,
      evidence: {
        observations: [{ axis: "isolation", value: "sandboxed", source: "runtime-observation" }],
      },
    })).toBe("mismatch");
  });
});

describe("pinningObservationForCell", () => {
  test("reports every axis", () => {
    expect(pinningObservationForCell({ pinning: PINNING, evidence: ADMITTED })).toEqual({
      harness: "match",
      model: "match",
      loadout: "match",
      isolation: "match",
    });
  });

  test("degrades axis by axis rather than as a block", () => {
    expect(pinningObservationForCell({
      pinning: { harness: HARNESS, isolationPolicy: "unrestricted" },
      evidence: {
        admission: { ready: true },
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
        admission: { ready: true },
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

  test("reports unverifiable for a cell with no evidence", async () => {
    const observed = await port({}).observe(null, {
      cellKey: "unknown/arm/1",
      arm: { armId: "arm", pinning: { model: MODEL } },
    });
    expect(observed).toEqual({
      harness: "unverifiable",
      model: "unverifiable",
      loadout: "unverifiable",
      // The baseline still pins isolation, and the venue inventory still admits one value.
      isolation: "match",
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
