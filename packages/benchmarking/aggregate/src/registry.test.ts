import { describe, expect, test } from "vitest";
import { parseMatrix, sealMatrix, serializeCanonicalJson } from "@jinn-network/benchmarking-records";
import { BENCHMARKING_METHOD_REGISTRY } from "./index.js";
import { createMethodRegistry } from "./registry.js";
import type { MethodComputeInput } from "./method.js";

function baseInput(overrides: Partial<MethodComputeInput> = {}): MethodComputeInput {
  const sealed = sealMatrix({
    protocol: "https://spec.jinn.network/protocols/benchmarking/v1",
    run: { digest: { sha256: "a".repeat(64) } },
    closeBoundary: { at: "2026-08-04T00:00:00Z" },
    cells: [],
    exclusions: [],
    attrition: { perArm: {}, asymmetryFlags: [] },
    completeness: { expected: 0, judged: 0, floor: "1", runOutcome: "partial" },
    assembly: { procedure: "jinn.benchmarking.assembly", version: "1.0" },
  });
  return {
    subjects: [{
      subjectSha256: sealed.digest.slice("sha256:".length),
      matrix: parseMatrix(sealed.bytes),
    }],
    parameters: {},
    verdictRule: "unanimous",
    resolveVerdictBytes: () => undefined,
    resolveRunBytes: () => undefined,
    resolveTaskBytes: () => undefined,
    ...overrides,
  };
}

function hostileArmSubject(): MethodComputeInput["subjects"][number] {
  const taskDigest = "b".repeat(64);
  const armIds = ["__proto__", "constructor", "prototype"];
  const sealed = sealMatrix({
    protocol: "https://spec.jinn.network/protocols/benchmarking/v1",
    run: { digest: { sha256: "a".repeat(64) } },
    closeBoundary: { at: "2026-08-04T00:00:00Z" },
    cells: armIds.map((armId) => ({
      cellKey: `${taskDigest}/${armId}/1`, taskDigest, armId, replicate: 1,
      dispatches: 0, verdicts: [], validVerdicts: [], outcome: "expired" as const,
      verification: { harness: "match" as const, model: "match" as const, loadout: "match" as const, isolation: "match" as const, checksFailed: [] },
      integrityTier: "attested-only" as const,
    })).sort((left, right) => left.cellKey < right.cellKey ? -1 : left.cellKey > right.cellKey ? 1 : 0),
    exclusions: [],
    attrition: { perArm: Object.fromEntries(armIds.map((armId) => [armId, {
      expected: 1, judged: 0, unjudged: 0, unscorable: 0, expired: 1,
      invalidated: 0, excluded: 0, replacements: 0,
    }])), asymmetryFlags: [] },
    completeness: { expected: 3, judged: 0, floor: "1", runOutcome: "partial" as const },
    assembly: { procedure: "jinn.benchmarking.assembly", version: "1.0" },
  });
  return { subjectSha256: sealed.digest.slice("sha256:".length), matrix: parseMatrix(sealed.bytes) };
}

describe("createMethodRegistry", () => {
  test("exports the default registry through the package barrel", () => {
    expect(BENCHMARKING_METHOD_REGISTRY.get("jinn.benchmarking.method/wilson", "1")).toBeDefined();
  });
  test("declares every Task-paired method version-robust for cross-Benchmark comparisons", () => {
    const registry = createMethodRegistry();
    expect(registry.get("jinn.benchmarking.method/paired-mcnemar", "1")?.versionRobust).toBe(true);
    expect(registry.get("jinn.benchmarking.method/provenance-cluster-sign", "1")?.versionRobust).toBe(true);
    expect(registry.get("jinn.benchmarking.method/noninferiority-iut", "1")?.versionRobust).toBe(true);
    expect(registry.get("jinn.benchmarking.method/paired-delta", "1")?.versionRobust).toBe(true);
    expect(registry.get("jinn.benchmarking.method/wilson", "1")?.versionRobust).toBe(false);
  });
  test("returns undefined for an unregistered id/version", () => {
    const registry = createMethodRegistry();
    expect(registry.get("jinn.benchmarking.method/wilson", "2")).toBeUndefined();
    expect(registry.get("jinn.benchmarking.method/does-not-exist", "1")).toBeUndefined();
  });

  test("registers all nine methods", () => {
    const registry = createMethodRegistry();
    for (const [id, version] of [
      ["jinn.benchmarking.method/wilson", "1"],
      ["jinn.benchmarking.method/avg-at-k", "1"],
      ["jinn.benchmarking.method/pass-at-k", "1"],
      ["jinn.benchmarking.method/paired-mcnemar", "1"],
      ["jinn.benchmarking.method/provenance-cluster-sign", "1"],
      ["jinn.benchmarking.method/noninferiority-iut", "1"],
      ["jinn.benchmarking.method/paired-delta", "1"],
      ["jinn.benchmarking.method/clean-subset", "1"],
      ["jinn.benchmarking.method/bradley-terry", "1"],
    ] as const) {
      expect(registry.get(id, version), `${id}@${version}`).toBeDefined();
    }
  });

  test("paired-delta@1 parameters survive canonical record sealing", () => {
    const method = createMethodRegistry().get("jinn.benchmarking.method/paired-delta", "1")!;
    const parameters = { verdictRule: "unanimous", baseline: "armA", candidate: "armB", seed: 123456789, resamples: 1000, alpha: "0.05" };
    expect(method.validateParameters(parameters)).toEqual({ ok: true });
    // Sealed records admit only exact I-JSON integers; a fractional number here would throw.
    expect(() => serializeCanonicalJson(parameters as never)).not.toThrow();
    expect(method.validateParameters({ ...parameters, alpha: 0.05 }).ok).toBe(false);
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

describe("subject-scoped method inputs", () => {
  test("bind each declared subject identity to its canonical Matrix digest", () => {
    const method = createMethodRegistry().get("jinn.benchmarking.method/wilson", "1")!;
    const input = baseInput({ parameters: { verdictRule: "unanimous" } });
    expect(() => method.compute!({
      ...input,
      subjects: [{ ...input.subjects[0]!, subjectSha256: "f".repeat(64) }],
    })).toThrow(/does not match canonical Matrix digest/);
  });

  test("reject duplicate subject identities before computing any result", () => {
    const method = createMethodRegistry().get("jinn.benchmarking.method/wilson", "1")!;
    const input = baseInput({ parameters: { verdictRule: "unanimous" } });
    expect(() => method.compute!({
      ...input,
      subjects: [input.subjects[0]!, input.subjects[0]!],
    })).toThrow(/subject identity is duplicated/);
  });
});

describe("opaque Arm IDs", () => {
  test("preserves hostile legal Arm IDs as null-prototype own keys in every Arm-indexed aggregate output", () => {
    const registry = createMethodRegistry();
    const subject = hostileArmSubject();
    const input = baseInput({ subjects: [subject] });
    for (const [methodId, parameters] of [
      ["jinn.benchmarking.method/wilson", { verdictRule: "unanimous" }],
      ["jinn.benchmarking.method/avg-at-k", { verdictRule: "unanimous" }],
      ["jinn.benchmarking.method/pass-at-k", { verdictRule: "unanimous", k: 1 }],
    ] as const) {
      const result = registry.get(methodId, "1")!.compute!({ ...input, parameters }).perSubject[0]!.results as { arms: Record<string, unknown> };
      expect(Object.getPrototypeOf(result.arms)).toBeNull();
      expect(Object.keys(result.arms)).toEqual(["__proto__", "constructor", "prototype"]);
      for (const armId of ["__proto__", "constructor", "prototype"]) {
        expect(Object.hasOwn(result.arms, armId)).toBe(true);
      }
    }
  });
});

describe("clean-subset@1: error handling", () => {
  test("rejects an impossible civil cutoff through the shared method-parameter validator", () => {
    const method = createMethodRegistry().get("jinn.benchmarking.method/clean-subset", "1")!;
    expect(method.validateParameters({
      verdictRule: "unanimous",
      basis: "self-declared",
      cutoff: "2026-02-30T00:00:00Z",
      delegate: {
        id: "jinn.benchmarking.method/wilson",
        version: "1",
        parameters: {},
      },
    })).toEqual({
      ok: false,
      issues: ['parameter "cutoff" must be an RFC 3339 date-time'],
    });
  });

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
