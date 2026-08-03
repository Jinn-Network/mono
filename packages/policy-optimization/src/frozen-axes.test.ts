import { describe, expect, it } from "vitest";
import { CONSTRAINT_MEMBERSHIP_KEYS, CORE_AXES as IDENTITY_CORE_AXES } from "@jinn-network/policy-identity";
import { PolicyOptimizationError } from "./errors.js";
import { axisValuesByteShare, assertExactPin, isExactPin } from "./frozen-axes.js";
import { CORE_AXES } from "./tokens.js";

describe("the mirrored core-axis list", () => {
  it("still matches @jinn-network/policy-identity's", () => {
    expect([...CORE_AXES]).toEqual([...IDENTITY_CORE_AXES]);
  });
});

describe("exact pins versus constraint-shaped values (product §5.1, substrate §4.1 rule 4)", () => {
  it("accepts a point-valued model", () => {
    expect(isExactPin("model", { id: "anthropic/claude-haiku-4-5" })).toBe(true);
  });

  it("refuses a provider-only model — that names a configuration family, not a point", () => {
    expect(isExactPin("model", { provider: "anthropic" })).toBe(false);
  });

  it("refuses null: an unconstrained axis is not a pin", () => {
    for (const axis of CORE_AXES) expect(isExactPin(axis, null)).toBe(false);
  });

  it("accepts byte-equality axes with any non-null value", () => {
    expect(isExactPin("harness", { id: "claude-code", version: "2.1.34" })).toBe(true);
    expect(isExactPin("isolationPolicy", "unrestricted")).toBe(true);
    expect(isExactPin("loadout", { kind: "jinn.skill.v1", name: "a", digest: `sha256:${"0".repeat(64)}` })).toBe(true);
  });

  it("throws a typed constraint-shaped-pin refusal", () => {
    try {
      assertExactPin("model", { provider: "anthropic" }, "frozenAxes.model");
      throw new Error("expected a refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(PolicyOptimizationError);
      expect((error as PolicyOptimizationError).category).toBe("constraint-shaped-pin");
      expect((error as PolicyOptimizationError).errors[0]?.path).toBe("frozenAxes.model");
    }
  });

  it("tripwire: the point-versus-family rule covers every constraint-membership key there is", () => {
    // FINDING F-C7a-2. The stack registers a membership test for `model` and nothing else, so
    // `model` is the only axis on which a *legal* requirement value can name a family rather than a
    // point. The day another key gains membership, this fails and the rule above must grow with it
    // rather than silently admitting a constraint-shaped pin on the new axis.
    expect([...CONSTRAINT_MEMBERSHIP_KEYS]).toEqual(["model"]);
  });
});

describe("byte-sharing (product §5.1)", () => {
  it("compares canonical bytes, not JavaScript key order", () => {
    expect(axisValuesByteShare({ id: "claude-code", version: "2" }, { version: "2", id: "claude-code" })).toBe(true);
  });

  it("separates values that differ anywhere", () => {
    expect(axisValuesByteShare({ id: "claude-code", version: "2" }, { id: "claude-code" })).toBe(false);
    expect(axisValuesByteShare("unrestricted", "Unrestricted")).toBe(false);
  });

  it("does not treat null and absent as the same value", () => {
    expect(axisValuesByteShare(null, undefined)).toBe(false);
  });
});
