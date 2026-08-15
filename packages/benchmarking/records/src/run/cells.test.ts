import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { BenchmarkRecordSchema } from "../benchmark/schema.js";
import {
  cellIdempotencyKey,
  cellKey,
  expectedCellCount,
  expectedCellSet,
  MAX_MATERIALIZED_CELLS,
  parseCellKey,
  submissionExtensionBlock,
} from "./cells.js";
import { RunRecordSchema } from "./schema.js";

function loadJson(relativePath: string): unknown {
  const url = new URL(relativePath, import.meta.url);
  return JSON.parse(readFileSync(url, "utf8"));
}

const DIGEST = "7afaa346b4bf92bf9dc21e9ae809887412a86beb766842e99df7fee6573a4781";
const RUN_DIGEST = `sha256:${"r".replace("r", "a").repeat(64)}`;

describe("cellKey / parseCellKey", () => {
  test("shape: <taskDigest>/<armId>/<replicate>, 1-based minimal decimal", () => {
    expect(cellKey(DIGEST, "armA", 1)).toBe(`${DIGEST}/armA/1`);
    expect(cellKey(DIGEST, "armA", 10)).toBe(`${DIGEST}/armA/10`);
  });

  test.each([
    ["uppercase digest", DIGEST.toUpperCase(), "armA", 1],
    ["non-hex digest", `${"a".repeat(63)}g`, "armA", 1],
    ["short digest", "a".repeat(63), "armA", 1],
    ["empty arm", DIGEST, "", 1],
    ["arm with slash", DIGEST, "arm/A", 1],
    ["arm with space", DIGEST, "arm A", 1],
    ["arm over 64 characters", DIGEST, "a".repeat(65), 1],
    ["zero replicate", DIGEST, "armA", 0],
    ["fractional replicate", DIGEST, "armA", 1.5],
    ["unsafe replicate", DIGEST, "armA", Number.MAX_SAFE_INTEGER + 1],
  ])("cellKey rejects %s without normalization", (_label, digest, armId, replicate) => {
    expect(() => cellKey(digest, armId, replicate)).toThrow();
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

  test.each([
    ["uppercase digest", `${DIGEST.toUpperCase()}/armA/1`],
    ["non-hex digest", `${"a".repeat(63)}g/armA/1`],
    ["short digest", `${"a".repeat(63)}/armA/1`],
    ["empty arm", `${DIGEST}//1`],
    ["arm with space", `${DIGEST}/arm A/1`],
    ["arm over 64 characters", `${DIGEST}/${"a".repeat(65)}/1`],
    ["zero replicate", `${DIGEST}/armA/0`],
    ["padded replicate", `${DIGEST}/armA/01`],
    ["negative replicate", `${DIGEST}/armA/-1`],
    ["fractional replicate", `${DIGEST}/armA/1.5`],
    ["unsafe replicate", `${DIGEST}/armA/${Number.MAX_SAFE_INTEGER + 1}`],
  ])("parseCellKey rejects %s", (_label, key) => {
    expect(() => parseCellKey(key)).toThrow();
  });

  test("accepts the largest safe minimal-decimal replicate exactly", () => {
    const key = cellKey(DIGEST, "armA", Number.MAX_SAFE_INTEGER);
    expect(parseCellKey(key).replicate).toBe(Number.MAX_SAFE_INTEGER);
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
      protocol: "https://spec.jinn.network/protocols/benchmarking/v1",
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

  test("rejects an unsafe exact Cartesian cardinality before converting or enumerating", () => {
    const threeItemBench = BenchmarkRecordSchema.parse({
      protocol: "https://spec.jinn.network/protocols/benchmarking/v1",
      name: "three-position-overflow",
      description: "d",
      version: "1.0.0",
      items: [
        { task: { digest: { sha256: "1".repeat(64) } } },
        { task: { digest: { sha256: "2".repeat(64) } } },
        { task: { digest: { sha256: "3".repeat(64) } } },
      ],
      reveal: { policy: "immediate" },
    });
    const oneArmRun = RunRecordSchema.parse({
      ...RunRecordSchema.parse(loadJson("../../fixtures/run/minimal.json")),
      arms: [{ armId: "armA", pinning: { model: { id: "m1" } } }],
      replicates: Number.MAX_SAFE_INTEGER,
    });

    expect(() => expectedCellCount(threeItemBench, oneArmRun)).toThrow(
      "expected cell cardinality exceeds Number.MAX_SAFE_INTEGER: 27021597764222973",
    );
    expect(() => expectedCellSet(threeItemBench, oneArmRun)).toThrow(
      "expected cell cardinality exceeds Number.MAX_SAFE_INTEGER: 27021597764222973",
    );
  });

  test("reports a safe million-plus count but refuses materialization before iteration", () => {
    const oneItemBench = BenchmarkRecordSchema.parse({
      protocol: "https://spec.jinn.network/protocols/benchmarking/v1",
      name: "materialization-bound",
      description: "d",
      version: "1.0.0",
      items: [{ task: { digest: { sha256: "1".repeat(64) } } }],
      reveal: { policy: "immediate" },
    });
    const oneArmRun = RunRecordSchema.parse({
      ...RunRecordSchema.parse(loadJson("../../fixtures/run/minimal.json")),
      arms: [{ armId: "armA", pinning: { model: { id: "m1" } } }],
      replicates: 1_000_001,
    });

    expect(MAX_MATERIALIZED_CELLS).toBe(1_000_000);
    expect(expectedCellCount(oneItemBench, oneArmRun)).toBe(1_000_001);
    expect(() => expectedCellSet(oneItemBench, oneArmRun)).toThrow(
      "expected cell set exceeds MAX_MATERIALIZED_CELLS (1000000): 1000001",
    );
  });
});

describe("submissionExtensionBlock", () => {
  test("emits exactly {run, cellKey, armId} (Addendum 2026-07-28-b, mandatory)", () => {
    const key = cellKey(DIGEST, "armA", 1);
    const block = submissionExtensionBlock(RUN_DIGEST, key, "armA");
    expect(block).toEqual({ run: RUN_DIGEST, cellKey: key, armId: "armA" });
    expect(Object.keys(block).sort()).toEqual(["armId", "cellKey", "run"]);
  });

  test("rejects a malformed cellKey or an armId that contradicts the key", () => {
    expect(() => submissionExtensionBlock("sha256:r", `${DIGEST}/arm A/1`, "arm A")).toThrow();
    expect(() => submissionExtensionBlock("sha256:r", `${DIGEST}/armA/1`, "armB")).toThrow();
  });

  test.each(["a".repeat(64), `sha256:${"a".repeat(63)}`, `sha256:${"A".repeat(64)}`, "sha256:not-hex"])
  ("rejects malformed run identity before producing annotations: %s", (runDigest) => {
    expect(() => submissionExtensionBlock(runDigest, cellKey(DIGEST, "armA", 1), "armA")).toThrow();
  });
});

describe("cellIdempotencyKey", () => {
  test("is distinct across dispatch indices for the same (run, cell)", () => {
    const key = cellKey(DIGEST, "armA", 1);
    const first = cellIdempotencyKey(RUN_DIGEST, key, 1);
    const second = cellIdempotencyKey(RUN_DIGEST, key, 2);
    expect(first).not.toBe(second);
  });

  test("is stable for the same (run, cell, dispatch) tuple", () => {
    const key = cellKey(DIGEST, "armA", 1);
    expect(cellIdempotencyKey(RUN_DIGEST, key, 1)).toBe(cellIdempotencyKey(RUN_DIGEST, key, 1));
  });

  test("rejects a non-positive dispatch index", () => {
    const key = cellKey(DIGEST, "armA", 1);
    expect(() => cellIdempotencyKey(RUN_DIGEST, key, 0)).toThrow();
  });

  test("rejects an unsafe dispatch index or malformed cellKey", () => {
    const key = cellKey(DIGEST, "armA", 1);
    expect(() => cellIdempotencyKey(RUN_DIGEST, key, Number.MAX_SAFE_INTEGER + 1)).toThrow();
    expect(() => cellIdempotencyKey(RUN_DIGEST, `${DIGEST.toUpperCase()}/armA/1`, 1)).toThrow();
  });

  test.each(["a".repeat(64), `sha256:${"a".repeat(63)}`, `sha256:${"A".repeat(64)}`, "sha256:not-hex"])
  ("rejects malformed run identity before deriving an idempotency key: %s", (runDigest) => {
    expect(() => cellIdempotencyKey(runDigest, cellKey(DIGEST, "armA", 1), 1)).toThrow();
  });
});
