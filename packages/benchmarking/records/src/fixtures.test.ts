import { describe, expect, test } from "vitest";
import { BenchmarkRecordSchema, parseBenchmark, sealBenchmark } from "./benchmark/schema.js";
import { checkRevealConsistency } from "./benchmark/reveal.js";
import {
  loadEquivalenceExpectedDigest,
  loadEquivalenceInput,
  loadGoldenBytes,
  loadGoldenDigest,
  loadGoldenJson,
  loadRevealCommitted,
  loadRevealedMap,
  loadRevealExpectedCoverage,
  type RecordKind,
} from "./fixtures.js";
import { documentDigest } from "./hashing.js";
import { parseRun, sealRun } from "./run/schema.js";
import { parseMatrix, sealMatrix } from "./matrix/schema.js";
import { parseReport, sealReport } from "./report/schema.js";
import {
  parseBenchmarkAccounting,
  parseObservationArchive,
  sealBenchmarkAccounting,
  sealObservationArchive,
} from "./accounting/schema.js";
import { sealRecord } from "./sealing.js";

const FAMILIES: Array<{
  kind: RecordKind;
  parse: (bytes: Uint8Array) => unknown;
  seal: (document: unknown) => { bytes: Uint8Array; digest: `sha256:${string}` };
}> = [
  { kind: "benchmark", parse: parseBenchmark, seal: sealBenchmark },
  { kind: "run", parse: parseRun, seal: sealRun },
  { kind: "matrix", parse: parseMatrix, seal: sealMatrix },
  { kind: "report", parse: parseReport, seal: sealReport },
  { kind: "benchmark-accounting", parse: parseBenchmarkAccounting, seal: sealBenchmarkAccounting },
  { kind: "observation-archive", parse: parseObservationArchive, seal: sealObservationArchive },
];

describe("golden fixture loaders", () => {
  for (const { kind, parse, seal } of FAMILIES) {
    test(`${kind}/valid: schema-valid, producer re-seal reproduces the pinned digest`, async () => {
      const bytes = await loadGoldenBytes(kind, "valid");
      const pinnedDigest = await loadGoldenDigest(kind, "valid");
      // consumer check (§6.1): documentDigest over the stored exact bytes equals the pinned
      // digest WITHOUT re-canonicalizing -- the stored bytes are already the canonical form.
      expect(documentDigest(bytes)).toBe(pinnedDigest);

      // parsing the stored bytes must not throw (schema-valid).
      expect(() => parse(bytes)).not.toThrow();

      // producer check: re-sealing the logical JSON document reproduces the pinned bytes/digest.
      const json = await loadGoldenJson(kind, "valid");
      const resealed = seal(json);
      expect(resealed.digest).toBe(pinnedDigest);
      expect(resealed.bytes).toEqual(bytes);
    });
  }
});

describe("reveal fixtures (§6.4/§16)", () => {
  test("committed.json is a schema-valid, scheduled-reveal Benchmark", async () => {
    const committed = BenchmarkRecordSchema.parse(await loadRevealCommitted());
    expect(committed.reveal.policy).toBe("scheduled");
  });

  test("revealed-full matches the expected full coverage", async () => {
    const committed = BenchmarkRecordSchema.parse(await loadRevealCommitted());
    const revealed = await loadRevealedMap("revealed-full");
    const expectedCoverage = (await loadRevealExpectedCoverage()) as {
      scenarios: Record<string, { revealed: number; committed: number; ok: boolean }>;
    };
    const result = checkRevealConsistency(committed, revealed);
    expect(result.ok).toBe(expectedCoverage.scenarios["revealed-full"].ok);
    expect(result.coverage).toEqual({
      revealed: expectedCoverage.scenarios["revealed-full"].revealed,
      committed: expectedCoverage.scenarios["revealed-full"].committed,
    });
  });

  test("revealed-partial matches the expected partial coverage (flagged via numbers, not a failure)", async () => {
    const committed = BenchmarkRecordSchema.parse(await loadRevealCommitted());
    const revealed = await loadRevealedMap("revealed-partial");
    const expectedCoverage = (await loadRevealExpectedCoverage()) as {
      scenarios: Record<string, { revealed: number; committed: number; ok: boolean }>;
    };
    const result = checkRevealConsistency(committed, revealed);
    expect(result.ok).toBe(true);
    expect(result.coverage).toEqual({
      revealed: expectedCoverage.scenarios["revealed-partial"].revealed,
      committed: expectedCoverage.scenarios["revealed-partial"].committed,
    });
  });

  test("tampered-item is flagged ok:false, naming the mismatched digest", async () => {
    const committed = BenchmarkRecordSchema.parse(await loadRevealCommitted());
    const revealed = await loadRevealedMap("tampered-item");
    const expectedCoverage = (await loadRevealExpectedCoverage()) as {
      scenarios: Record<string, { mismatched: string[] }>;
    };
    const result = checkRevealConsistency(committed, revealed);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.mismatched).toEqual(expectedCoverage.scenarios["tampered-item"].mismatched);
    }
  });
});

describe("equivalence fixtures (program §7.1/§7.14, key-order-sensitive)", () => {
  test("both key-permuted inputs seal to the pinned expected digest", async () => {
    const [a, b, expectedDigest] = await Promise.all([
      loadEquivalenceInput("a"),
      loadEquivalenceInput("b"),
      loadEquivalenceExpectedDigest(),
    ]);
    const digestA = sealRecord(a as never).digest;
    const digestB = sealRecord(b as never).digest;
    expect(digestA).toBe(expectedDigest);
    expect(digestB).toBe(expectedDigest);
  });
});
