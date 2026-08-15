import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { itemTaskDigest, parseBenchmark, serializeCanonicalJson } from "@jinn-network/benchmarking-records";
import { describe, expect, test } from "vitest";
import { exportCroissant } from "./croissant.js";

describe("exportCroissant (§6.5)", () => {
  test("projects the miniature Benchmark + revealed Tasks to the kit Croissant oracle", async () => {
    const fixtures = fileURLToPath(
      new URL("../../../testing/fixtures/", import.meta.url),
    );
    const bench = parseBenchmark(await readFile(`${fixtures}miniature-run/benchmark.json`));
    const revealed = new Map<string, Uint8Array>();
    for (const item of bench.items) {
      const digest = itemTaskDigest(item);
      revealed.set(digest, new TextEncoder().encode(digest));
    }
    const actual = exportCroissant(bench, revealed);
    const expectedBytes = new Uint8Array(await readFile(`${fixtures}exports/croissant.json`));
    expect(serializeCanonicalJson(actual)).toEqual(expectedBytes);
  });
});
