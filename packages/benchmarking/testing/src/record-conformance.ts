import {
  checkItemDistinctness,
  checkJudgeability,
  checkRevealConsistency,
  documentDigest,
  InvalidDocumentError,
  loadGoldenBytes,
  loadGoldenDigest,
  loadGoldenJson,
  loadRevealCommitted,
  loadRevealedMap,
  loadRevealExpectedCoverage,
  parseBenchmark,
  parseBenchmarkAccounting,
  parseMatrix,
  parseObservationArchive,
  parseReport,
  parseRun,
  sealBenchmark,
  sealBenchmarkAccounting,
  sealMatrix,
  sealObservationArchive,
  sealReport,
  sealRun,
  type BenchmarkRecord,
  type RecordKind,
} from "@jinn-network/benchmarking-records";
import { describe, expect, test } from "vitest";

const KINDS = [
  { kind: "benchmark", parse: parseBenchmark, seal: sealBenchmark, minimal: true },
  { kind: "run", parse: parseRun, seal: sealRun, minimal: true },
  { kind: "matrix", parse: parseMatrix, seal: sealMatrix, minimal: true },
  { kind: "report", parse: parseReport, seal: sealReport, minimal: true },
  { kind: "benchmark-accounting", parse: parseBenchmarkAccounting, seal: sealBenchmarkAccounting, minimal: false },
  { kind: "observation-archive", parse: parseObservationArchive, seal: sealObservationArchive, minimal: false },
] as const satisfies readonly {
  readonly kind: RecordKind;
  readonly parse: (bytes: Uint8Array) => unknown;
  readonly seal: (document: unknown) => { bytes: Uint8Array; digest: `sha256:${string}` };
  readonly minimal: boolean;
}[];

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

/**
 * §16 Layer-1 record conformance: schema validation, producer-side re-seal, consumer-side
 * digest verification, and the named benchmark checks, run over the golden fixtures shipped by
 * `@jinn-network/benchmarking-records`. Any product embedding a `benchmarking-records`-compatible
 * pipeline runs this driver to prove it reproduces the frozen §6-§9 record surface.
 */
export function describeRecordConformance(): void {
  describe("benchmarking record conformance (design §16 Layer 1)", () => {
    for (const { kind, parse, seal, minimal } of KINDS) {
      describe(`${kind} record`, () => {
        test("valid golden fixture parses under its schema", async () => {
          const bytes = await loadGoldenBytes(kind, "valid");
          expect(() => parse(bytes)).not.toThrow();
        });

        test("producer-side re-seal reproduces the pinned bytes and digest", async () => {
          const json = await loadGoldenJson(kind, "valid");
          const pinnedBytes = await loadGoldenBytes(kind, "valid");
          const pinnedDigest = await loadGoldenDigest(kind, "valid");
          const resealed = seal(json);
          expect(bytesEqual(resealed.bytes, pinnedBytes)).toBe(true);
          expect(resealed.digest).toBe(pinnedDigest);
        });

        test("consumer-side documentDigest over stored bytes equals the pinned digest (no re-canonicalization)", async () => {
          const pinnedBytes = await loadGoldenBytes(kind, "valid");
          const pinnedDigest = await loadGoldenDigest(kind, "valid");
          expect(documentDigest(pinnedBytes)).toBe(pinnedDigest);
        });

        test.skipIf(!minimal)("minimal golden fixture parses under its schema", async () => {
          const bytes = await loadGoldenBytes(kind, "minimal");
          expect(() => parse(bytes)).not.toThrow();
        });
      });
    }

    describe("benchmark-item-distinctness", () => {
      test("the valid golden fixture has distinct item digests", async () => {
        const benchmark = await loadGoldenJson("benchmark", "valid");
        const result = checkItemDistinctness(benchmark as never);
        expect(result.ok).toBe(true);
      });

      test("the invalid-duplicate-item fixture reports the duplicate digest", async () => {
        const benchmark = await loadGoldenJson("benchmark", "invalid-duplicate-item");
        const result = checkItemDistinctness(benchmark as never);
        expect(result.ok).toBe(false);
      });
    });

    describe("benchmark-judgeability (committed-not-revealed)", () => {
      test("a committed benchmark with no Task bytes fails closed without trusted pre-reveal context", async () => {
        const committed = await loadRevealCommitted();
        const benchmark = committed as BenchmarkRecord;
        const result = checkJudgeability(benchmark);
        expect(result).toEqual({
          ok: false,
          invalid: [],
          unresolved: benchmark.items.map((item) => item.task.digest.sha256),
        });
      });
    });

    describe("reveal-consistency", () => {
      test("full reveal is byte-consistent and reports full coverage", async () => {
        const committed = await loadRevealCommitted();
        const revealed = await loadRevealedMap("revealed-full");
        const expectedCoverage = (await loadRevealExpectedCoverage()) as {
          scenarios: { "revealed-full": { revealed: number; committed: number } };
        };
        const result = checkRevealConsistency(committed as never, revealed);
        expect(result.ok).toBe(true);
        if (result.ok) {
          const { revealed: revealedCount, committed: committedCount } = expectedCoverage.scenarios["revealed-full"];
          expect(result.coverage).toEqual({ revealed: revealedCount, committed: committedCount });
        }
      });

      test("a tampered revealed item is reported as mismatched", async () => {
        const committed = await loadRevealCommitted();
        const revealed = await loadRevealedMap("tampered-item");
        const expectedCoverage = (await loadRevealExpectedCoverage()) as {
          scenarios: { "tampered-item": { mismatched: string[] } };
        };
        const result = checkRevealConsistency(committed as never, revealed);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.mismatched).toEqual(expectedCoverage.scenarios["tampered-item"].mismatched);
        }
      });

      test("a partial reveal is flagged, never silently accepted as full", async () => {
        const committed = await loadRevealCommitted();
        const revealed = await loadRevealedMap("revealed-partial");
        const expectedCoverage = (await loadRevealExpectedCoverage()) as {
          scenarios: { "revealed-partial": { revealed: number; committed: number } };
        };
        const result = checkRevealConsistency(committed as never, revealed);
        expect(result.ok).toBe(true);
        if (result.ok) {
          const { revealed: revealedCount, committed: committedCount } = expectedCoverage.scenarios["revealed-partial"];
          expect(result.coverage).toEqual({ revealed: revealedCount, committed: committedCount });
          expect(result.coverage.revealed).toBeLessThan(result.coverage.committed);
        }
      });
    });

    describe("structural rejections", () => {
      test("a Run record missing closeAt is rejected (§7.1/§16)", async () => {
        const bytes = await loadGoldenBytes("run", "invalid-missing-closeAt");
        expect(() => parseRun(bytes)).toThrow(InvalidDocumentError);
      });

      test("a Run record with two byte-identical-pinning arms is rejected (§7.1)", async () => {
        const bytes = await loadGoldenBytes("run", "invalid-dup-arm");
        expect(() => parseRun(bytes)).toThrow(InvalidDocumentError);
      });

      test("a Matrix record smuggling an unnamespaced top-level field is rejected (tenet 3)", async () => {
        const bytes = await loadGoldenBytes("matrix", "invalid-aggregate-field");
        expect(() => parseMatrix(bytes)).toThrow(InvalidDocumentError);
      });

      test("a Matrix cell outcome outside the frozen six-value vocabulary is rejected (§8.2/§14.1)", async () => {
        const bytes = await loadGoldenBytes("matrix", "invalid-bad-outcome");
        expect(() => parseMatrix(bytes)).toThrow(InvalidDocumentError);
      });

      test("a Matrix whose cells[] omits an expected cell is rejected structurally (§8.1)", async () => {
        const bytes = await loadGoldenBytes("matrix", "invalid-missing-cells");
        expect(() => parseMatrix(bytes)).toThrow(InvalidDocumentError);
      });

      test("a Report record missing disclosures is rejected (§9.1)", async () => {
        const bytes = await loadGoldenBytes("report", "invalid-missing-disclosures");
        expect(() => parseReport(bytes)).toThrow(InvalidDocumentError);
      });

      test("a Benchmark record with a malformed version is rejected (§6.2)", async () => {
        const bytes = await loadGoldenBytes("benchmark", "invalid-bad-version");
        expect(() => parseBenchmark(bytes)).toThrow(InvalidDocumentError);
      });
    });
  });
}
