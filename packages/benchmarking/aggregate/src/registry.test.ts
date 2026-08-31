import { describe, expect, test } from "vitest";
import { parseMatrix, sealMatrix, serializeCanonicalJson } from "@jinn-network/benchmarking-records";
import { canonicalJsonBytes, recordDigest, sealDsseEnvelope } from "@jinn-network/trust-core";
import { BENCHMARKING_METHOD_REGISTRY } from "./index.js";
import { createMethodRegistry } from "./registry.js";
import { MethodInputError } from "./resolved-inputs.js";
import { MAX_NONINFERIORITY_RESAMPLES_V1 } from "./stats/noninferiority.js";
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

/** One Task judged pass on both arms, whose two passing cells declare different cost units --
 * the exact shape noninferiority-iut@1's cost leg must keep reporting as a cost-unit failure. */
function mismatchedCostUnitInput(): MethodComputeInput {
  const passBytes = sealDsseEnvelope({
    payloadBytes: canonicalJsonBytes({
      _type: "https://in-toto.io/Statement/v1",
      subject: [{ name: "fixture/cost-unit", digest: { sha256: "d".repeat(64) } }],
      predicateType: "https://spec.jinn.network/attestations/result-evaluation/v1",
      predicate: {
        evaluatedAt: "2026-07-29T00:00:00Z",
        evaluator: { id: "urn:uuid:77777777-7777-5777-8777-777777777777" },
        taskSubject: "execution/task/task.json",
        resultSubjects: ["execution/result/result.json"],
        verdict: "pass",
      },
    }),
    payloadType: "application/vnd.in-toto+json",
    signatures: [{ keyid: "did:key:zVerdict", signature: Uint8Array.of(1) }],
  });
  const passDigest = recordDigest(passBytes);
  const taskDigest = "c".repeat(64);
  const verification = {
    harness: "match" as const, model: "match" as const,
    loadout: "match" as const, isolation: "match" as const, checksFailed: [],
  };
  const cell = (armId: string, unit: string) => ({
    cellKey: `${taskDigest}/${armId}/1`,
    taskDigest,
    armId,
    replicate: 1,
    dispatches: 1,
    accounted: 1,
    submission: `sha256:${"3".repeat(64)}`,
    delivery: `sha256:${"4".repeat(64)}`,
    verdicts: [passDigest],
    validVerdicts: [passDigest],
    outcome: "judged" as const,
    cost: { value: "1", unit, source: "reported" as const },
    verification,
    integrityTier: "attested-only" as const,
  });
  const sealed = sealMatrix({
    protocol: "https://spec.jinn.network/protocols/benchmarking/v1",
    run: { digest: { sha256: "a".repeat(64) } },
    closeBoundary: { at: "2026-08-04T00:00:00Z" },
    cells: [cell("armA", "usd"), cell("armB", "token")],
    exclusions: [],
    attrition: {
      perArm: Object.fromEntries(["armA", "armB"].map((armId) => [armId, {
        expected: 1, judged: 1, unjudged: 0, unscorable: 0,
        expired: 0, invalidated: 0, excluded: 0, replacements: 0,
      }])),
      asymmetryFlags: [],
    },
    completeness: { expected: 2, judged: 2, floor: "1", runOutcome: "complete" },
    assembly: { procedure: "jinn.benchmarking.assembly", version: "1.0" },
  });
  return baseInput({
    subjects: [{ subjectSha256: sealed.digest.slice("sha256:".length), matrix: parseMatrix(sealed.bytes) }],
    parameters: { baseline: "armA", candidate: "armB", seed: 123456789, resamples: 10 },
    resolveVerdictBytes: (digest: string) => digest === passDigest ? passBytes : undefined,
  });
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

  test("registers all twelve methods", () => {
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
      ["jinn.benchmarking.method/binary-instrument", "1"],
      ["jinn.benchmarking.method/pairwise-disagreement", "1"],
      ["jinn.benchmarking.method/paired-majority-delta", "1"],
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

describe("resamples range guard (#2583)", () => {
  const IUT_PARAMS = { baseline: "armA", candidate: "armB", seed: 123456789 };
  const DELTA_PARAMS = { ...IUT_PARAMS, alpha: "0.05" };

  function expectRangeViolation(id: string, parameters: Record<string, unknown>): void {
    const method = createMethodRegistry().get(id, "1")!;
    let thrown: unknown;
    try {
      method.compute!(baseInput({ parameters }));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(MethodInputError);
    const error = thrown as MethodInputError;
    expect(error.code).toBe("method-parameter-out-of-range");
    expect(error.digest).toBe("resamples");
    expect(error.message).toContain(`resamples must be in 1..${MAX_NONINFERIORITY_RESAMPLES_V1}`);
  }

  test.each([
    ["jinn.benchmarking.method/noninferiority-iut", IUT_PARAMS],
    ["jinn.benchmarking.method/paired-delta", DELTA_PARAMS],
  ])("%s reports an out-of-range resamples as a parameter-range failure", (id, params) => {
    expectRangeViolation(id, { ...params, resamples: 0 });
    expectRangeViolation(id, { ...params, resamples: MAX_NONINFERIORITY_RESAMPLES_V1 + 1 });
  });

  test("noninferiority-iut@1 still reports mismatched cost units as method-incompatible-cost-unit", () => {
    const method = createMethodRegistry().get("jinn.benchmarking.method/noninferiority-iut", "1")!;
    let thrown: unknown;
    try {
      method.compute!(mismatchedCostUnitInput());
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(MethodInputError);
    expect((thrown as MethodInputError).code).toBe("method-incompatible-cost-unit");
  });
});
