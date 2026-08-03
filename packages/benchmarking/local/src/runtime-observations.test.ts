// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import {
  axisObservationsFromRuntimeObservations,
  runPinningPropertyId,
} from "./runtime-observations.js";

describe("axisObservationsFromRuntimeObservations", () => {
  test("decodes a JSON-text object value into requirements shape", () => {
    expect(axisObservationsFromRuntimeObservations([{
      kind: "resource",
      propertyId: runPinningPropertyId("model"),
      name: "Model that ran",
      value: '{"id":"anthropic/claude-haiku-4-5"}',
    }])).toEqual([{
      axis: "model",
      value: { id: "anthropic/claude-haiku-4-5" },
      source: "runtime-observation",
    }]);
  });

  test("keeps a scalar string value literal", () => {
    expect(axisObservationsFromRuntimeObservations([{
      kind: "resource",
      propertyId: runPinningPropertyId("isolation"),
      value: "unrestricted",
    }])).toEqual([{ axis: "isolation", value: "unrestricted", source: "runtime-observation" }]);
  });

  test("keeps malformed JSON text literal rather than throwing", () => {
    expect(axisObservationsFromRuntimeObservations([{
      kind: "resource",
      propertyId: runPinningPropertyId("harness"),
      value: '{"id":',
    }])).toEqual([{ axis: "harness", value: '{"id":', source: "runtime-observation" }]);
  });

  test("skips captures that establish nothing", () => {
    expect(axisObservationsFromRuntimeObservations([
      { kind: "environment", propertyId: runPinningPropertyId("harness"), value: "x" },
      { kind: "resource", propertyId: "https://jinn.network/properties/process-exit", value: 0 },
      { kind: "resource", value: "no property id" },
      { kind: "resource", propertyId: runPinningPropertyId("loadout") },
    ])).toEqual([]);
  });

  test("projects every axis in capture order", () => {
    const captures = (["harness", "model", "loadout", "isolation"] as const).map((axis) => ({
      kind: "resource",
      propertyId: runPinningPropertyId(axis),
      value: axis,
    }));
    expect(axisObservationsFromRuntimeObservations(captures).map((entry) => entry.axis))
      .toEqual(["harness", "model", "loadout", "isolation"]);
  });
});
