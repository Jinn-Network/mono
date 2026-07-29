import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  OUTCOME_VOCABULARY,
  documentDigest,
  parseBenchmark,
  parseMatrix,
  parseRun,
} from "@jinn-network/benchmarking-records";
import { describe, expect, test } from "vitest";
import { listBenchmarkingFixtures, loadBenchmarkingFixtureJson } from "./fixtures.js";

async function fixtureBytes(relative: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(fileURLToPath(new URL(`../fixtures/${relative}`, import.meta.url))));
}

async function fixtureJson(relative: string): Promise<any> {
  return JSON.parse(new TextDecoder().decode(await fixtureBytes(relative)));
}

describe("miniature-run fixture contract", () => {
  test("public fixture loaders enumerate and read the shipped corpus", async () => {
    expect(await listBenchmarkingFixtures("miniature-run")).toContain("miniature-run/expected-matrix.json");
    await expect(loadBenchmarkingFixtureJson("ordering/transcripts.json")).resolves.toMatchObject({
      localAppendOrder: { decisionGrade: false },
    });
  });

  test("is a complete 3-item × 2-arm × 2-replicate corpus with a byte-pinned Matrix oracle", async () => {
    const benchmark = parseBenchmark(await fixtureBytes("miniature-run/benchmark.json"));
    const run = parseRun(await fixtureBytes("miniature-run/run.json"));
    const matrixBytes = await fixtureBytes("miniature-run/expected-matrix.json");
    const matrix = parseMatrix(matrixBytes);
    const pinnedDigest = new TextDecoder().decode(await fixtureBytes("miniature-run/expected-matrix.sha256")).trim();

    expect(benchmark.items).toHaveLength(3);
    expect(run.arms).toHaveLength(2);
    expect(run.replicates).toBe(2);
    expect(matrix.cells).toHaveLength(12);
    expect(matrix.cells.map((cell) => cell.cellKey)).toEqual(
      [...matrix.cells.map((cell) => cell.cellKey)].sort(),
    );
    expect(new Set(matrix.cells.map((cell) => cell.outcome))).toEqual(new Set(OUTCOME_VOCABULARY));
    expect(matrix.cells.some((cell) => cell.dispatches > 1)).toBe(true);
    expect(matrix.cells.some((cell) => cell.verdicts.length > 1)).toBe(true);
    expect(matrix.attrition.asymmetryFlags.length).toBeGreaterThan(0);
    expect(documentDigest(matrixBytes)).toBe(pinnedDigest);
  });

  test("materializes submissions, deliveries, verdicts, evidence, and injected assembly scope", async () => {
    const [submissions, deliveries, verdicts, evidence, scope] = await Promise.all([
      fixtureJson("miniature-run/submissions.json"),
      fixtureJson("miniature-run/deliveries.json"),
      fixtureJson("miniature-run/verdicts.json"),
      fixtureJson("miniature-run/evidence.json"),
      fixtureJson("miniature-run/injected-scope.json"),
    ]);
    expect(submissions).toHaveLength(13);
    expect(deliveries.length).toBeGreaterThan(0);
    expect(verdicts.length).toBeGreaterThan(0);
    expect(evidence.length).toBeGreaterThan(0);
    expect(scope.replacementLineage).toHaveLength(1);
  });
});

describe("ordering and export fixture oracles", () => {
  test("pins anchored-positive, anchored-violation, and local append-order transcripts", async () => {
    const ordering = await fixtureJson("ordering/transcripts.json");
    expect(ordering.anchoredPositive.violatesOrder).toBe(false);
    expect(ordering.anchoredViolation.violatesOrder).toBe(true);
    expect(ordering.localAppendOrder).toMatchObject({
      runAppendedBeforeCells: true,
      decisionGrade: false,
    });
  });

  test.each(["eval-log.json", "croissant.json", "static-bundle.json"])(
    "materializes the byte-exact %s export oracle",
    async (name) => {
      const bytes = await fixtureBytes(`exports/${name}`);
      expect(bytes.length).toBeGreaterThan(10);
      expect(() => JSON.parse(new TextDecoder().decode(bytes))).not.toThrow();
    },
  );
});

describe("method fixture/spec completeness", () => {
  test("declares every reference method and Bradley–Terry's registered/unavailable status", async () => {
    const specs = await fixtureJson("methods/method-specs.json");
    const byId = new Map(specs.map((spec: any) => [spec.id, spec]));
    expect([...byId.keys()].sort()).toEqual([
      "jinn.benchmarking.method/avg-at-k",
      "jinn.benchmarking.method/bradley-terry",
      "jinn.benchmarking.method/clean-subset",
      "jinn.benchmarking.method/noninferiority-iut",
      "jinn.benchmarking.method/paired-mcnemar",
      "jinn.benchmarking.method/pass-at-k",
      "jinn.benchmarking.method/wilson",
    ]);
    for (const spec of specs) {
      expect(spec.requiredInputs.length).toBeGreaterThan(0);
      expect(spec.parameterSchema).toMatchObject({ type: "object" });
      expect(spec.outputShape).toBeTypeOf("string");
      expect(spec.exclusionRule).toBeTypeOf("string");
      expect(spec.clusteringRule).toBeTypeOf("string");
      expect(spec.deterministic).toBe(true);
    }
    expect(byId.get("jinn.benchmarking.method/bradley-terry")).toMatchObject({
      referenceSet: "registered-non-reference",
      computeAvailability: "unavailable",
    });
  });

  test("pins conflicts for every reference method plus pairing, clustering, and comparability cases", async () => {
    const cases = await fixtureJson("methods/conformance-cases.json");
    expect(new Set(cases.conflicts)).toEqual(new Set([
      "jinn.benchmarking.method/wilson",
      "jinn.benchmarking.method/avg-at-k",
      "jinn.benchmarking.method/pass-at-k",
      "jinn.benchmarking.method/paired-mcnemar",
      "jinn.benchmarking.method/noninferiority-iut",
      "jinn.benchmarking.method/clean-subset",
    ]));
    expect(cases.pairedExclusions).toBe(true);
    expect(cases.pinnedClustering).toBe("task-provenance-source");
    expect(cases.comparability).toMatchObject({ marginalCrossVersion: "reject" });
  });

  test("includes an exact deterministic noninferiority fixture and Bradley–Terry metadata fixture", async () => {
    const noninferiority = await fixtureJson("methods/noninferiority-iut.json");
    const bradleyTerry = await fixtureJson("methods/bradley-terry.json");
    expect(noninferiority.parameters).toMatchObject({
      seed: expect.any(Number),
      resamples: expect.any(Number),
    });
    expect(noninferiority.expectedResults.verdict).toMatch(/^(pass|fail|inconclusive)$/);
    expect(noninferiority.expectedResults.excluded.count)
      .toBe(noninferiority.expectedResults.excluded.cellKeys.length);
    expect(bradleyTerry).toMatchObject({
      computeAvailability: "unavailable",
      expectedCompute: "reject",
    });
  });
});
