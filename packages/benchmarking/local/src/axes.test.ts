// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import {
  effectiveRunPinning,
  PINNING_AXES,
  pinnedValueForAxis,
  REQUIREMENT_KEY_FOR_AXIS,
} from "./axes.js";

describe("axis vocabulary", () => {
  test("maps the Matrix isolation axis onto the requirements isolationPolicy key", () => {
    expect(REQUIREMENT_KEY_FOR_AXIS.isolation).toBe("isolationPolicy");
    expect(REQUIREMENT_KEY_FOR_AXIS.harness).toBe("harness");
    expect(REQUIREMENT_KEY_FOR_AXIS.model).toBe("model");
    expect(REQUIREMENT_KEY_FOR_AXIS.loadout).toBe("loadout");
  });

  test("enumerates exactly the four core axes", () => {
    expect([...PINNING_AXES]).toEqual(["harness", "model", "loadout", "isolation"]);
  });
});

describe("effectiveRunPinning", () => {
  test("overlays arm pinning on the submission baseline", () => {
    expect(
      effectiveRunPinning(
        { isolationPolicy: "unrestricted", model: { id: "base" } },
        { model: { id: "arm" } },
      ),
    ).toEqual({ isolationPolicy: "unrestricted", model: { id: "arm" } });
  });

  test("tolerates an absent baseline and an absent arm map", () => {
    expect(effectiveRunPinning(undefined, { harness: { id: "claude-code" } }))
      .toEqual({ harness: { id: "claude-code" } });
    expect(effectiveRunPinning({ isolationPolicy: "unrestricted" }, undefined))
      .toEqual({ isolationPolicy: "unrestricted" });
    expect(effectiveRunPinning(undefined, undefined)).toEqual({});
  });
});

describe("pinnedValueForAxis", () => {
  test("reads each axis through its requirements key", () => {
    const pinning = {
      harness: { id: "claude-code", version: "2.1.34" },
      isolationPolicy: "unrestricted",
    };
    expect(pinnedValueForAxis(pinning, "harness")).toEqual({
      id: "claude-code",
      version: "2.1.34",
    });
    expect(pinnedValueForAxis(pinning, "isolation")).toBe("unrestricted");
    expect(pinnedValueForAxis(pinning, "model")).toBeUndefined();
  });

  test("treats an explicitly null pin as present, not as unpinned", () => {
    expect(pinnedValueForAxis({ model: null }, "model")).toBeNull();
  });

  test("does not read axis values off the prototype chain", () => {
    const pinning = Object.create({ harness: { id: "inherited" } }) as Record<string, unknown>;
    expect(pinnedValueForAxis(pinning, "harness")).toBeUndefined();
  });
});
