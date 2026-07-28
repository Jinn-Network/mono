import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { BenchmarkRecordSchema } from "../benchmark/schema.js";
import {
  cellIdempotencyKey,
  cellKey,
  expectedCellCount,
  expectedCellSet,
  parseCellKey,
  submissionExtensionBlock,
} from "./cells.js";
import { RunRecordSchema } from "./schema.js";

function loadJson(relativePath: string): unknown {
  const url = new URL(relativePath, import.meta.url);
  return JSON.parse(readFileSync(url, "utf8"));
}

const DIGEST = "7afaa346b4bf92bf9dc21e9ae809887412a86beb766842e99df7fee6573a4781";

describe("cellKey / parseCellKey", () => {
  test("shape: <taskDigest>/<armId>/<replicate>, 1-based minimal decimal", () => {
    expect(cellKey(DIGEST, "armA", 1)).toBe(`${DIGEST}/armA/1`);
    expect(cellKey(DIGEST, "armA", 10)).toBe(`${DIGEST}/armA/10`);
  });

  test("lowercases the task digest", () => {
    expect(cellKey(DIGEST.toUpperCase(), "armA", 1)).toBe(`${DIGEST}/armA/1`);
  });

  test("rejects a non-positive or non-integer replicate", () => {
    expect(() => cellKey(DIGEST, "armA", 0)).toThrow();
    expect(() => cellKey(DIGEST, "armA", 1.5)).toThrow();
  });

  test("parseCellKey inverts cellKey", () => {
    const key = cellKey(DIGEST, "arm-B_2", 3);
    expect(parseCellKey(key)).toEqual({ cellKey: key, taskDigest: DIGEST, armId: "arm-B_2", replicate: 3 });
  });

  test("two variable-length parts cannot collide: armId charset excludes '/'", () => {
    // If armId could contain "/", "digest/a/b/1" would be ambiguous between armId="a/b" rep=1
    // and armId="a" rep="b/1" (illegal). The armId grammar (enforced at the Run schema level)
    // excludes '/' entirely, so parseCellKey's 3-part split is always unambiguous.
    expect(() => parseCellKey(`${DIGEST}/a/b/1`)).toThrow();
  });
});

describe("expectedCellSet / expectedCellCount", () => {
  const bench = BenchmarkRecordSchema.parse(loadJson("../../fixtures/benchmark/valid.json"));
  const run = RunRecordSchema.parse(loadJson("../../fixtures/run/valid.json"));

  test("size is |items| x |arms| x replicates", () => {
    expect(expectedCellCount(bench, run)).toBe(bench.items.length * run.arms.length * run.replicates);
    expect(expectedCellSet(bench, run)).toHaveLength(expectedCellCount(bench, run));
  });

  test("is ordered lexicographically by cellKey (UTF-16 code-unit order)", () => {
    const coords = expectedCellSet(bench, run);
    const keys = coords.map((c) => c.cellKey);
    expect(keys).toEqual([...keys].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
  });

  test("every coordinate cellKey round-trips through parseCellKey", () => {
    for (const coord of expectedCellSet(bench, run)) {
      expect(parseCellKey(coord.cellKey)).toEqual(coord);
    }
  });

  test("a 3-item x 2-arm x 2-replicate pair yields 12 lexicographically-ordered coordinates", () => {
    const threeItemBench = BenchmarkRecordSchema.parse({
      protocol: "https://jinn.network/protocols/benchmarking/1.0",
      name: "three",
      description: "d",
      version: "1.0.0",
      items: [
        { task: { digest: { sha256: "1".repeat(64) } } },
        { task: { digest: { sha256: "2".repeat(64) } } },
        { task: { digest: { sha256: "3".repeat(64) } } },
      ],
      reveal: { policy: "immediate" },
    });
    const twoArmRun = RunRecordSchema.parse({
      ...RunRecordSchema.parse(loadJson("../../fixtures/run/minimal.json")),
      arms: [
        { armId: "a1", pinning: { model: { id: "m1" } } },
        { armId: "a2", pinning: { model: { id: "m2" } } },
      ],
      replicates: 2,
    });
    const coords = expectedCellSet(threeItemBench, twoArmRun);
    expect(coords).toHaveLength(12);
    const keys = coords.map((c) => c.cellKey);
    expect(new Set(keys).size).toBe(12);
    expect(keys).toEqual([...keys].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
  });
});

describe("submissionExtensionBlock", () => {
  test("emits exactly {run, cellKey, armId} (Addendum 2026-07-28-b, mandatory)", () => {
    const key = cellKey(DIGEST, "armA", 1);
    const block = submissionExtensionBlock("sha256:runrundigest", key, "armA");
    expect(block).toEqual({ run: "sha256:runrundigest", cellKey: key, armId: "armA" });
    expect(Object.keys(block).sort()).toEqual(["armId", "cellKey", "run"]);
  });
});

describe("cellIdempotencyKey", () => {
  test("is distinct across dispatch indices for the same (run, cell)", () => {
    const key = cellKey(DIGEST, "armA", 1);
    const first = cellIdempotencyKey("sha256:runrundigest", key, 1);
    const second = cellIdempotencyKey("sha256:runrundigest", key, 2);
    expect(first).not.toBe(second);
  });

  test("is stable for the same (run, cell, dispatch) tuple", () => {
    const key = cellKey(DIGEST, "armA", 1);
    expect(cellIdempotencyKey("sha256:r", key, 1)).toBe(cellIdempotencyKey("sha256:r", key, 1));
  });

  test("rejects a non-positive dispatch index", () => {
    const key = cellKey(DIGEST, "armA", 1);
    expect(() => cellIdempotencyKey("sha256:r", key, 0)).toThrow();
  });
});
