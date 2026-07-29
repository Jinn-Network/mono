import { describe, expect, test } from "vitest";
import { BENCHMARKING_METHOD_REGISTRY } from "./index.js";
import { createMethodRegistry } from "./registry.js";
import type { MethodComputeInput } from "./method.js";

function baseInput(overrides: Partial<MethodComputeInput> = {}): MethodComputeInput {
  return {
    matrices: [],
    parameters: {},
    verdictRule: "unanimous",
    resolveVerdictBytes: () => undefined,
    resolveRunBytes: () => undefined,
    resolveTaskBytes: () => undefined,
    ...overrides,
  };
}

describe("createMethodRegistry", () => {
  test("exports the default registry through the package barrel", () => {
    expect(BENCHMARKING_METHOD_REGISTRY.get("jinn.benchmarking.method/wilson", "1")).toBeDefined();
  });
  test("declares only the task-paired method version-robust for cross-Benchmark comparisons", () => {
    const registry = createMethodRegistry();
    expect(registry.get("jinn.benchmarking.method/paired-mcnemar", "1")?.versionRobust).toBe(true);
    expect(registry.get("jinn.benchmarking.method/wilson", "1")?.versionRobust).toBe(false);
  });
  test("returns undefined for an unregistered id/version", () => {
    const registry = createMethodRegistry();
    expect(registry.get("jinn.benchmarking.method/wilson", "2")).toBeUndefined();
    expect(registry.get("jinn.benchmarking.method/does-not-exist", "1")).toBeUndefined();
  });

  test("registers all seven design §9.2 methods", () => {
    const registry = createMethodRegistry();
    for (const [id, version] of [
      ["jinn.benchmarking.method/wilson", "1"],
      ["jinn.benchmarking.method/avg-at-k", "1"],
      ["jinn.benchmarking.method/pass-at-k", "1"],
      ["jinn.benchmarking.method/paired-mcnemar", "1"],
      ["jinn.benchmarking.method/noninferiority-iut", "1"],
      ["jinn.benchmarking.method/clean-subset", "1"],
      ["jinn.benchmarking.method/bradley-terry", "1"],
    ] as const) {
      expect(registry.get(id, version), `${id}@${version}`).toBeDefined();
    }
  });
});

describe("bradley-terry@1", () => {
  test("is registered as non-reference and unavailable until a pairwise input record is frozen", () => {
    const registry = createMethodRegistry();
    const method = registry.get("jinn.benchmarking.method/bradley-terry", "1")!;
    expect(method).toMatchObject({
      referenceSet: "registered-non-reference",
      computeAvailability: "unavailable",
    });
    expect(method.compute).toBeUndefined();
  });
});

describe("clean-subset@1: error handling", () => {
  test("throws when MethodComputeInput.registry is not supplied", () => {
    const registry = createMethodRegistry();
    const method = registry.get("jinn.benchmarking.method/clean-subset", "1")!;
    expect(() => method.compute!(baseInput({
      parameters: { cutoff: "2026-01-01T00:00:00Z", basis: "self-declared", delegate: { id: "x", version: "1" } },
    }))).toThrow(/registry/);
  });

  test("throws when the declared delegate is not registered", () => {
    const registry = createMethodRegistry();
    const method = registry.get("jinn.benchmarking.method/clean-subset", "1")!;
    expect(() => method.compute!(baseInput({
      registry,
      parameters: { cutoff: "2026-01-01T00:00:00Z", basis: "self-declared", delegate: { id: "not-registered", version: "1" } },
    }))).toThrow(/not registered/);
  });
});
