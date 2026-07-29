import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  documentDigest,
  parseBenchmark,
  parseMatrix,
  parseRun,
  type BenchmarkRecord,
  type MatrixRecord,
  type RunRecord,
} from "@jinn-network/benchmarking-records";
import { describe, expect, test } from "vitest";

/**
 * The injected shape `benchmarking/run`'s `assembleMatrix` implements (design §8.3, program
 * §7.22: reads cell `attempt` fields from in-scope Submission/observation records, never
 * regenerates them). Frozen here so `run` (wave 2, M4) implements against a kit-owned type
 * rather than inventing its own; `describeAssemblyConformance` (below) is the driver that
 * exercises it against the kit-owned miniature-run fixture.
 */
export type AssembleMatrixFn = (
  bench: BenchmarkRecord,
  run: RunRecord,
  injectedScope: unknown,
) => Promise<{ record: MatrixRecord; bytes: Uint8Array; digest: `sha256:${string}` }>;

/**
 * §16 assembly conformance: the future M4 implementation is injected, but the corpus and exact
 * Matrix oracle are already owned and frozen by M2.
 */
export function describeAssemblyConformance(assemble: AssembleMatrixFn): void {
  describe("benchmarking assembly conformance (design §8.3/§16)", () => {
    test("reproduces the kit-owned miniature Matrix byte-for-byte", async () => {
      const load = async (name: string): Promise<Uint8Array> => new Uint8Array(await readFile(
        fileURLToPath(new URL(`../fixtures/miniature-run/${name}`, import.meta.url)),
      ));
      const [benchmarkBytes, runBytes, scopeBytes, expectedBytes] = await Promise.all([
        load("benchmark.json"),
        load("run.json"),
        load("injected-scope.json"),
        load("expected-matrix.json"),
      ]);
      const result = await assemble(
        parseBenchmark(benchmarkBytes),
        parseRun(runBytes),
        JSON.parse(new TextDecoder().decode(scopeBytes)),
      );
      expect(result.bytes).toEqual(expectedBytes);
      expect(result.digest).toBe(documentDigest(expectedBytes));
      expect(result.record).toEqual(parseMatrix(expectedBytes));
    });
  });
}
