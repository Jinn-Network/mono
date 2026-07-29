import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseMatrix, serializeCanonicalJson, type MatrixRecord, type ReportRecord } from "@jinn-network/benchmarking-records";
import { describe, expect, test } from "vitest";

/** The kit's injected shape (design §10.1 op 5, §10.2): `benchmarking/interop` (wave 2, M5)
 * implements these three fixture-pinned projections of a Matrix (+ optional Reports). */
export interface Exporters {
  evalLog(matrix: MatrixRecord): unknown | Promise<unknown>;
  croissant(matrix: MatrixRecord): unknown | Promise<unknown>;
  staticBundle(matrix: MatrixRecord, reports?: readonly ReportRecord[]): unknown | Promise<unknown>;
}

/**
 * §16 export conformance: the future M5 exporters are injected, while M2 owns exact fixture
 * bytes for all three projections.
 */
export function describeExportConformance(exporters: Exporters): void {
  describe("benchmarking export conformance (design §10.2/§14.9/§16)", () => {
    const load = async (relative: string): Promise<Uint8Array> => new Uint8Array(await readFile(
      fileURLToPath(new URL(`../fixtures/${relative}`, import.meta.url)),
    ));
    test.each([
      ["evalLog", "eval-log.json"],
      ["croissant", "croissant.json"],
      ["staticBundle", "static-bundle.json"],
    ] as const)("%s matches its byte-exact M2 oracle", async (method, fixture) => {
      const matrix = parseMatrix(await load("miniature-run/expected-matrix.json"));
      const actual = await exporters[method](matrix);
      const actualBytes = actual instanceof Uint8Array
        ? actual
        : serializeCanonicalJson(actual as never);
      expect(actualBytes).toEqual(await load(`exports/${fixture}`));
    });
  });
}
