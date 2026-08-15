import { describe, expect, test } from "vitest";
import { sha256Hex } from "../hashing.js";
import { BenchmarkRecordSchema } from "./schema.js";
import { checkRevealConsistency } from "./reveal.js";

function benchmarkOverDigests(digests: string[]) {
  return BenchmarkRecordSchema.parse({
    protocol: "https://spec.jinn.network/protocols/benchmarking/v1",
    name: "committed",
    description: "d",
    version: "1.0.0",
    items: digests.map((digest) => ({ task: { digest: { sha256: digest } } })),
    reveal: { policy: "scheduled" },
  });
}

const taskBytes = (label: string) => new TextEncoder().encode(JSON.stringify({ instructions: label }));

describe("checkRevealConsistency", () => {
  test("full reveal: every committed item verified, coverage revealed === committed", () => {
    const a = taskBytes("a");
    const b = taskBytes("b");
    const digestA = sha256Hex(a);
    const digestB = sha256Hex(b);
    const rec = benchmarkOverDigests([digestA, digestB]);
    const revealed = new Map([[digestA, a], [digestB, b]]);
    expect(checkRevealConsistency(rec, revealed)).toEqual({
      ok: true,
      coverage: { revealed: 2, committed: 2 },
    });
  });

  test("partial reveal: unrevealed items are not a failure, coverage flags the gap", () => {
    const a = taskBytes("a");
    const digestA = sha256Hex(a);
    const digestB = sha256Hex(taskBytes("b"));
    const digestC = sha256Hex(taskBytes("c"));
    const rec = benchmarkOverDigests([digestA, digestB, digestC]);
    const revealed = new Map([[digestA, a]]);
    expect(checkRevealConsistency(rec, revealed)).toEqual({
      ok: true,
      coverage: { revealed: 1, committed: 3 },
    });
  });

  test("tampered item: revealed bytes present but hash to a different digest -> ok:false", () => {
    const a = taskBytes("a");
    const digestA = sha256Hex(a);
    const rec = benchmarkOverDigests([digestA]);
    const tampered = taskBytes("tampered");
    const revealed = new Map([[digestA, tampered]]);
    expect(checkRevealConsistency(rec, revealed)).toEqual({
      ok: false,
      mismatched: [digestA],
      coverage: { revealed: 0, committed: 1 },
    });
  });

  test("no reveal at all: coverage 0/N, still ok", () => {
    const digestA = sha256Hex(taskBytes("a"));
    const rec = benchmarkOverDigests([digestA]);
    expect(checkRevealConsistency(rec, new Map())).toEqual({
      ok: true,
      coverage: { revealed: 0, committed: 1 },
    });
  });
});
