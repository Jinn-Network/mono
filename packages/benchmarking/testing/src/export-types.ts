import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  itemTaskDigest,
  parseBenchmark,
  parseMatrix,
  serializeCanonicalJson,
  type BenchmarkRecord,
  type MatrixRecord,
  type ReportRecord,
} from "@jinn-network/benchmarking-records";
import { describe, expect, test } from "vitest";

/** Injected evidence port — contracts only (design §10.2 seam 3). */
export type EvidenceResolver = {
  transcriptFor?(cellKey: string): Promise<unknown> | unknown;
  evidenceRefFor?(cellKey: string): Promise<unknown> | unknown;
};

/**
 * Kit-owned richer exporter contracts (plan M5 + coordinator ruling):
 * - Croissant: Benchmark + revealed Task bytes
 * - EvalLog: Matrix + evidence resolver
 * - static bundle: Matrix + optional Reports
 */
export interface Exporters {
  evalLog(
    matrix: MatrixRecord,
    evidence: EvidenceResolver,
  ): unknown | Promise<unknown>;
  croissant(
    bench: BenchmarkRecord,
    revealed: ReadonlyMap<string, Uint8Array>,
  ): unknown | Promise<unknown>;
  staticBundle(
    matrix: MatrixRecord,
    reports?: readonly ReportRecord[],
  ): unknown | Promise<unknown>;
}

async function loadFixtureBytes(relative: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(
    fileURLToPath(new URL(`../fixtures/${relative}`, import.meta.url)),
  ));
}

/** Build real exporter inputs from kit fixtures — no adapter closures over fixture bytes. */
export async function buildMiniatureExportInputs(): Promise<{
  bench: BenchmarkRecord;
  matrix: MatrixRecord;
  revealed: Map<string, Uint8Array>;
  evidence: EvidenceResolver;
  expected: {
    evalLog: Uint8Array;
    croissant: Uint8Array;
    staticBundle: Uint8Array;
  };
}> {
  const [benchmarkBytes, matrixBytes, tasksBytes, evalLog, croissant, staticBundle] = await Promise.all([
    loadFixtureBytes("miniature-run/benchmark.json"),
    loadFixtureBytes("miniature-run/expected-matrix.json"),
    loadFixtureBytes("miniature-run/tasks.json"),
    loadFixtureBytes("exports/eval-log.json"),
    loadFixtureBytes("exports/croissant.json"),
    loadFixtureBytes("exports/static-bundle.json"),
  ]);
  const bench = parseBenchmark(benchmarkBytes);
  const matrix = parseMatrix(matrixBytes);
  const tasks = JSON.parse(new TextDecoder().decode(tasksBytes)) as {
    digest: string;
    bytes?: number[];
  }[];
  const revealed = new Map<string, Uint8Array>();
  for (const task of tasks) {
    const digest = task.digest.replace(/^sha256:/, "");
    // tasks.json may not embed sealed bytes; presence stubs keyed by digest still satisfy
    // exportCroissant's revealed-map contract when the oracle only needs digests.
    revealed.set(digest, task.bytes !== undefined
      ? Uint8Array.from(task.bytes)
      : new TextEncoder().encode(digest));
  }
  for (const item of bench.items) {
    const digest = itemTaskDigest(item);
    if (!revealed.has(digest)) revealed.set(digest, new TextEncoder().encode(digest));
  }
  return {
    bench,
    matrix,
    revealed,
    // Distinctive non-empty EvidenceResolver — empty `{}` must not falsely prove port use.
    evidence: {
      transcriptFor(cellKey) {
        return `transcript:miniature:${cellKey}`;
      },
      evidenceRefFor(cellKey) {
        return `evidence:miniature:${cellKey}`;
      },
    },
    expected: { evalLog, croissant, staticBundle },
  };
}

/**
 * §16 export conformance: M5 exporters are injected with the richer plan APIs; exact oracle
 * bytes remain kit-owned. Inputs are built from fixtures — not closed over inside wrappers.
 */
export function describeExportConformance(exporters: Exporters): void {
  describe("benchmarking export conformance (design §10.2/§14.9/§16)", () => {
    test("evalLog matches its byte-exact M2 oracle via injected Matrix + evidence", async () => {
      const { matrix, evidence, expected } = await buildMiniatureExportInputs();
      const actual = await exporters.evalLog(matrix, evidence);
      const actualBytes = actual instanceof Uint8Array
        ? actual
        : serializeCanonicalJson(actual as never);
      expect(actualBytes).toEqual(expected.evalLog);
    });

    test("croissant matches its byte-exact M2 oracle via injected Benchmark + revealed", async () => {
      const { bench, revealed, expected } = await buildMiniatureExportInputs();
      const actual = await exporters.croissant(bench, revealed);
      const actualBytes = actual instanceof Uint8Array
        ? actual
        : serializeCanonicalJson(actual as never);
      expect(actualBytes).toEqual(expected.croissant);
    });

    test("staticBundle matches its byte-exact M2 oracle via injected Matrix", async () => {
      const { matrix, expected } = await buildMiniatureExportInputs();
      const actual = await exporters.staticBundle(matrix);
      const actualBytes = actual instanceof Uint8Array
        ? actual
        : serializeCanonicalJson(actual as never);
      expect(actualBytes).toEqual(expected.staticBundle);
    });
  });
}
