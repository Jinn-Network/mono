import { createHash } from "node:crypto";
import { parseMatrix, sealMatrix, type MatrixRecord } from "@jinn-network/benchmarking-records";
import { describe, expect, test } from "vitest";
import { createMethodRegistry } from "./registry.js";
import type { MethodComputeInput, VerdictOutcome } from "./method.js";

const RUN_DESCRIPTOR = { digest: { sha256: "a".repeat(64) } };
const CLOSE_BOUNDARY = { at: "2026-08-04T00:00:00Z" };
const ASSEMBLY = { procedure: "jinn.benchmarking.assembly", version: "1.0" };
const MATCH_ALL = { harness: "match", model: "match", loadout: "match", isolation: "match", checksFailed: [] };

function sha256Hex(label: string): string {
  return createHash("sha256").update(label, "utf8").digest("hex");
}
function taskDigest(label: string): string {
  return sha256Hex(`task/${label}`);
}
function cellKey(task: string, armId: string, replicate: number): string {
  return `${task}/${armId}/${replicate}`;
}
function digest(label: string): string {
  return `sha256:${sha256Hex(`verdict/${label}`)}`;
}

function cell(
  taskLabel: string,
  armId: string,
  outcome: string,
  verdicts: string[] = [],
): Record<string, unknown> {
  const task = taskDigest(taskLabel);
  return {
    cellKey: cellKey(task, armId, 1),
    taskDigest: task,
    armId,
    replicate: 1,
    dispatches: 1,
    accounted: 1,
    verdicts,
    validVerdicts: verdicts,
    outcome,
    verification: MATCH_ALL,
    integrityTier: "re-derivable",
  };
}

function buildMatrix(cells: Record<string, unknown>[]): MatrixRecord {
  const perArm: Record<string, Record<string, number>> = {};
  for (const c of cells) {
    const armId = c["armId"] as string;
    const outcome = c["outcome"] as string;
    perArm[armId] ??= { expected: 0, judged: 0, unjudged: 0, unscorable: 0, expired: 0, invalidated: 0, excluded: 0, replacements: 0 };
    perArm[armId]!["expected"] += 1;
    perArm[armId]![outcome] += 1;
  }
  const document = {
    protocol: "https://jinn.network/protocols/benchmarking/1.0",
    run: RUN_DESCRIPTOR,
    closeBoundary: CLOSE_BOUNDARY,
    cells,
    exclusions: [],
    attrition: { perArm, asymmetryFlags: [] },
    completeness: { expected: cells.length, judged: cells.filter((c) => c["outcome"] === "judged").length, floor: "0.5", runOutcome: "complete" },
    assembly: ASSEMBLY,
  };
  return parseMatrix(sealMatrix(document).bytes);
}

function baseInput(overrides: Partial<MethodComputeInput> = {}): MethodComputeInput {
  return {
    matrices: [],
    parameters: {},
    verdictRule: "unanimous",
    resolveVerdict: () => undefined,
    ...overrides,
  };
}

describe("createMethodRegistry", () => {
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

describe("paired-mcnemar@1: the excluded remainder (§9.3)", () => {
  test("a task judged in only one arm is excluded, its cellKey reported, and it never enters the pair count", () => {
    const registry = createMethodRegistry();
    const method = registry.get("jinn.benchmarking.method/paired-mcnemar", "1")!;
    const matrix = buildMatrix([
      cell("t1", "armA", "judged", [digest("t1a")]),
      cell("t1", "armB", "judged", [digest("t1b")]),
      cell("t2", "armA", "judged", [digest("t2a")]), // no armB counterpart -- unpaired
    ]);
    const outcomes = new Map<string, VerdictOutcome>([
      [digest("t1a"), { verdict: "pass" }],
      [digest("t1b"), { verdict: "fail" }],
      [digest("t2a"), { verdict: "pass" }],
    ]);
    const results = method.compute(baseInput({
      matrices: [matrix],
      parameters: { baseline: "armA", candidate: "armB" },
      resolveVerdict: (d) => outcomes.get(d),
    })) as { pairs: number; excluded: { count: number; cellKeys: string[] } };
    expect(results.pairs).toBe(1);
    expect(results.excluded.count).toBe(1);
    expect(results.excluded.cellKeys).toEqual([cellKey(taskDigest("t2"), "armA", 1)]);
  });
});

describe("noninferiority-iut@1", () => {
  function mulberry32(seed: number): () => number {
    let state = seed;
    return () => {
      state |= 0;
      state = (state + 0x6d2b79f5) | 0;
      let t = Math.imul(state ^ (state >>> 15), 1 | state);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  test("PASS: candidate strictly better and strictly cheaper on every paired task", () => {
    const registry = createMethodRegistry();
    const method = registry.get("jinn.benchmarking.method/noninferiority-iut", "1")!;
    const cells = Array.from({ length: 6 }, (_, i) => [
      cell(`t${i}`, "armA", "judged", [digest(`t${i}a`)]),
      cell(`t${i}`, "armB", "judged", [digest(`t${i}b`)]),
    ]).flat();
    const outcomes = new Map<string, VerdictOutcome>();
    for (let i = 0; i < 6; i += 1) {
      outcomes.set(digest(`t${i}a`), { verdict: "fail" });
      outcomes.set(digest(`t${i}b`), { verdict: "pass" });
    }
    const matrix = buildMatrix(cells);
    const results = method.compute(baseInput({
      matrices: [matrix],
      parameters: {
        baseline: "armA",
        candidate: "armB",
        stockBaseRate: 0.5,
        costDiffs: [-10, -9, -8, -7, -6, -5, -4, -3, -2, -1],
      },
      resolveVerdict: (d) => outcomes.get(d),
      rng: mulberry32(1),
    })) as { verdict: string };
    expect(results.verdict).toBe("PASS");
  });

  test("requires MethodComputeInput.rng", () => {
    const registry = createMethodRegistry();
    const method = registry.get("jinn.benchmarking.method/noninferiority-iut", "1")!;
    expect(() => method.compute(baseInput({ parameters: { baseline: "armA", candidate: "armB", stockBaseRate: 0.5 } }))).toThrow();
  });
});

describe("bradley-terry@1", () => {
  test("registered and computes real strengths over a resolved matrix (armA passes both tasks, armB neither)", () => {
    const registry = createMethodRegistry();
    const method = registry.get("jinn.benchmarking.method/bradley-terry", "1")!;
    const matrix = buildMatrix([
      cell("t1", "armA", "judged", [digest("t1a")]),
      cell("t1", "armB", "judged", [digest("t1b")]),
      cell("t2", "armA", "judged", [digest("t2a")]),
      cell("t2", "armB", "judged", [digest("t2b")]),
    ]);
    const outcomes = new Map<string, VerdictOutcome>([
      [digest("t1a"), { verdict: "pass" }],
      [digest("t1b"), { verdict: "fail" }],
      [digest("t2a"), { verdict: "pass" }],
      [digest("t2b"), { verdict: "fail" }],
    ]);
    const results = method.compute(baseInput({
      matrices: [matrix],
      resolveVerdict: (d) => outcomes.get(d),
    })) as { strengths: Record<string, string>; converged: boolean };
    expect(results.converged).toBe(true);
    // armB never wins (both its cells fail), so it never appears as a winner or loser -- only
    // armA (which won both its cells) and the synthetic "baseline" node are present.
    expect(Object.keys(results.strengths).sort()).toEqual(["armA", "baseline"]);
    expect(Number(results.strengths["armA"])).toBeGreaterThan(Number(results.strengths["baseline"]));
  });
});

describe("clean-subset@1: error handling", () => {
  test("throws when MethodComputeInput.registry is not supplied", () => {
    const registry = createMethodRegistry();
    const method = registry.get("jinn.benchmarking.method/clean-subset", "1")!;
    expect(() => method.compute(baseInput({
      parameters: { cutoff: "2026-01-01T00:00:00Z", basis: "self-declared", delegate: { id: "x", version: "1" } },
    }))).toThrow(/registry/);
  });

  test("throws when the declared delegate is not registered", () => {
    const registry = createMethodRegistry();
    const method = registry.get("jinn.benchmarking.method/clean-subset", "1")!;
    expect(() => method.compute(baseInput({
      registry,
      parameters: { cutoff: "2026-01-01T00:00:00Z", basis: "self-declared", delegate: { id: "not-registered", version: "1" } },
    }))).toThrow(/not registered/);
  });
});
