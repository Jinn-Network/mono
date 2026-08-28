import {
  loadGoldenBytes,
  parseBenchmark,
  parseMatrix,
  sealMatrix,
  sealReport,
  sealRun,
} from "@jinn-network/benchmarking-records";
import { recordDigest } from "@jinn-network/record-discovery-protocol";
import type { ReferencedBytes } from "@jinn-network/record-discovery-protocol";
import { describe, expect, it } from "vitest";

import {
  BENCHMARK_ACCOUNTING_RECORD_KIND,
  BENCHMARK_RECORD_KIND,
  MATRIX_RECORD_KIND,
  REPORT_RECORD_KIND,
  REPORT_V2_RECORD_KIND,
  RUN_RECORD_KIND,
} from "./identifiers.js";
import {
  BENCHMARKING_FACTS_RECOMPUTE,
  BENCHMARKING_FACTS_RECOMPUTE_V2,
  benchmarkAccountingRecompute,
  benchmarkRecompute,
  benchmarkRecomputeV2,
  matrixRecompute,
  matrixRecomputeV2,
  reportRecompute,
  signedReportRecompute,
  runRecompute,
} from "./recompute.js";

const noReferencedBytes: ReferencedBytes = {
  async "fetch"() {
    return undefined;
  },
};

function refsFrom(map: Map<string, Uint8Array>): ReferencedBytes {
  return {
    async "fetch"(digest) {
      return map.get(digest);
    },
  };
}

async function fixtureBytes(kind: "benchmark" | "run" | "matrix" | "report", name: string): Promise<Uint8Array> {
  return loadGoldenBytes(kind, name);
}

describe("facts/benchmarking recompute (program §7.128–§7.130)", () => {
  it("recomputes Benchmark own digest + version (+ optional author) from sealed bytes", async () => {
    const bytes = await fixtureBytes("benchmark", "valid");
    const record = parseBenchmark(bytes);
    const facts = await benchmarkRecompute(bytes, noReferencedBytes);
    expect(facts).toEqual({
      benchmarkDigest: recordDigest(bytes),
      author: record.author,
      version: record.version,
    });
  });

  it("omits absent Benchmark author rather than reporting undefined", async () => {
    const bytes = await fixtureBytes("benchmark", "minimal");
    const facts = await benchmarkRecompute(bytes, noReferencedBytes);
    expect(facts).toEqual({
      benchmarkDigest: recordDigest(bytes),
      version: "0.1.0",
    });
    expect(facts).not.toHaveProperty("author");
  });

  it("emits Run benchmarkDigest only after fetch/rehash/parse as Benchmark", async () => {
    const runBytes = await fixtureBytes("run", "minimal");
    const run = JSON.parse(new TextDecoder().decode(runBytes)) as {
      owner: string;
    };

    const missing = await runRecompute(runBytes, noReferencedBytes);
    expect(missing.runDigest).toBe(recordDigest(runBytes));
    expect(missing.owner).toBe(run.owner);
    expect(missing).not.toHaveProperty("benchmarkDigest");

    // Parse-after-rehash wrong-kind: map key is the digest of the hostile
    // bytes themselves so the digest check passes, then Benchmark parse fails.
    const hostileWrongKind = await fixtureBytes("run", "minimal");
    const hostileWrongKindDigest = recordDigest(hostileWrongKind);
    const wrongKindRun = sealRun({
      protocol: "https://spec.jinn.network/protocols/benchmarking/v1",
      owner: "urn:uuid:22222222-2222-5222-8222-222222222222",
      benchmark: { digest: { sha256: hostileWrongKindDigest.slice("sha256:".length) } },
      closeAt: "2026-08-04T00:00:00Z",
      replicates: 1,
      arms: [{ armId: "solo", pinning: {} }],
      policy: {
        cellWindow: 60000,
        completenessFloor: "1",
        evaluation: {},
        independence: "disclosed",
        replacement: { allowed: false },
        submissionBaseline: {},
      },
    });
    const wrongKindFacts = await runRecompute(
      wrongKindRun.bytes,
      refsFrom(new Map([[hostileWrongKindDigest, hostileWrongKind]])),
    );
    expect(wrongKindFacts.runDigest).toBe(recordDigest(wrongKindRun.bytes));
    expect(wrongKindFacts.owner).toBe(run.owner);
    expect(wrongKindFacts).not.toHaveProperty("benchmarkDigest");

    const corrupt = new TextEncoder().encode('{"not":"a-benchmark"}');
    const corruptHex = recordDigest(corrupt);
    const hostileRun = sealRun({
      protocol: "https://spec.jinn.network/protocols/benchmarking/v1",
      owner: "urn:uuid:22222222-2222-5222-8222-222222222222",
      benchmark: { digest: { sha256: corruptHex.slice("sha256:".length) } },
      closeAt: "2026-08-04T00:00:00Z",
      replicates: 1,
      arms: [{ armId: "solo", pinning: {} }],
      policy: {
        cellWindow: 60000,
        completenessFloor: "1",
        evaluation: {},
        independence: "disclosed",
        replacement: { allowed: false },
        submissionBaseline: {},
      },
    });
    const hostileFacts = await runRecompute(
      hostileRun.bytes,
      refsFrom(new Map([[corruptHex, corrupt]])),
    );
    expect(hostileFacts).not.toHaveProperty("benchmarkDigest");

    const realBenchmark = await fixtureBytes("benchmark", "valid");
    const realDigest = recordDigest(realBenchmark);
    const linkedRun = sealRun({
      protocol: "https://spec.jinn.network/protocols/benchmarking/v1",
      owner: "urn:uuid:22222222-2222-5222-8222-222222222222",
      benchmark: { digest: { sha256: realDigest.slice("sha256:".length) } },
      closeAt: "2026-08-04T00:00:00Z",
      replicates: 1,
      arms: [{ armId: "solo", pinning: {} }],
      policy: {
        cellWindow: 60000,
        completenessFloor: "1",
        evaluation: {},
        independence: "disclosed",
        replacement: { allowed: false },
        submissionBaseline: {},
      },
    });
    const ok = await runRecompute(
      linkedRun.bytes,
      refsFrom(new Map([[realDigest, realBenchmark]])),
    );
    expect(ok).toEqual({
      runDigest: recordDigest(linkedRun.bytes),
      owner: "urn:uuid:22222222-2222-5222-8222-222222222222",
      benchmarkDigest: realDigest,
    });
  });

  it("emits Matrix runDigest only after fetch/rehash/parse as Run; keeps runOutcome native", async () => {
    const matrixBytes = await fixtureBytes("matrix", "minimal");
    const matrix = parseMatrix(matrixBytes);
    const missing = await matrixRecompute(matrixBytes, noReferencedBytes);
    expect(missing).toEqual({
      matrixDigest: recordDigest(matrixBytes),
      runOutcome: matrix.completeness.runOutcome,
    });
    expect(missing).not.toHaveProperty("runDigest");

    // Parse-after-rehash wrong-kind: key = digest(hostile Benchmark bytes).
    const hostileBenchmark = await fixtureBytes("benchmark", "valid");
    const hostileDigest = recordDigest(hostileBenchmark);
    const wrongKindMatrix = sealMatrix({
      protocol: "https://spec.jinn.network/protocols/benchmarking/v1",
      run: { digest: { sha256: hostileDigest.slice("sha256:".length) } },
      assembly: { procedure: "jinn.benchmarking.assembly", version: "1.0" },
      closeBoundary: { at: "2026-08-04T00:00:00Z" },
      cells: [],
      exclusions: [],
      attrition: { asymmetryFlags: [], perArm: {} },
      completeness: { expected: 0, judged: 0, floor: "1", runOutcome: "partial" },
    });
    const wrongKind = await matrixRecompute(
      wrongKindMatrix.bytes,
      refsFrom(new Map([[hostileDigest, hostileBenchmark]])),
    );
    expect(wrongKind).toEqual({
      matrixDigest: recordDigest(wrongKindMatrix.bytes),
      runOutcome: "partial",
    });
    expect(wrongKind).not.toHaveProperty("runDigest");

    const realRun = await fixtureBytes("run", "minimal");
    const runDigest = recordDigest(realRun);
    const linked = sealMatrix({
      protocol: "https://spec.jinn.network/protocols/benchmarking/v1",
      run: { digest: { sha256: runDigest.slice("sha256:".length) } },
      assembly: { procedure: "jinn.benchmarking.assembly", version: "1.0" },
      closeBoundary: { at: "2026-08-04T00:00:00Z" },
      cells: [],
      exclusions: [],
      attrition: { asymmetryFlags: [], perArm: {} },
      completeness: { expected: 0, judged: 0, floor: "1", runOutcome: "partial" },
    });
    const ok = await matrixRecompute(
      linked.bytes,
      refsFrom(new Map([[runDigest, realRun]])),
    );
    expect(ok).toEqual({
      matrixDigest: recordDigest(linked.bytes),
      runDigest,
      runOutcome: "partial",
    });
  });

  it("emits plural Report matrixDigests in subjects order only when every ref validates", async () => {
    const matrixA = await fixtureBytes("matrix", "minimal");
    const matrixB = await fixtureBytes("matrix", "valid");
    const digestA = recordDigest(matrixA);
    const digestB = recordDigest(matrixB);
    const disclosure = (subjectSha256: string) => ({
      subjectSha256,
      integrityTiers: { "re-derivable": 0, "attested-only": 0 },
      pinning: {
        harness: { match: 0, mismatch: 0, unverifiable: 0 },
        model: { match: 0, mismatch: 0, unverifiable: 0 },
        loadout: { match: 0, mismatch: 0, unverifiable: 0 },
        isolation: { match: 0, mismatch: 0, unverifiable: 0 },
      },
      independence: 0,
      completeness: { expected: 0, judged: 0, floor: "1", runOutcome: "partial" as const },
      attrition: { asymmetryFlags: [], perArm: {} },
    });
    const report = sealReport({
      protocol: "https://spec.jinn.network/protocols/benchmarking/v1",
      subjects: [
        { digest: { sha256: digestA.slice("sha256:".length) } },
        { digest: { sha256: digestB.slice("sha256:".length) } },
      ],
      method: {
        id: "jinn.benchmarking.method/wilson",
        version: "1",
        parameters: {},
      },
      preregistered: true,
      results: {},
      disclosures: {
        perSubject: [
          disclosure(digestA.slice("sha256:".length)),
          disclosure(digestB.slice("sha256:".length)),
        ],
      },
      author: "urn:uuid:66666666-6666-5666-8666-666666666666",
    });

    const missing = await reportRecompute(report.bytes, noReferencedBytes);
    expect(missing).toEqual({
      methodId: "jinn.benchmarking.method/wilson",
      methodVersion: "1",
      author: "urn:uuid:66666666-6666-5666-8666-666666666666",
      preregistered: true,
    });
    expect(missing).not.toHaveProperty("matrixDigests");

    const partial = await reportRecompute(
      report.bytes,
      refsFrom(new Map([[digestA, matrixA]])),
    );
    expect(partial).toEqual({
      methodId: "jinn.benchmarking.method/wilson",
      methodVersion: "1",
      author: "urn:uuid:66666666-6666-5666-8666-666666666666",
      preregistered: true,
    });
    expect(partial).not.toHaveProperty("matrixDigests");

    // Parse-after-rehash wrong-kind: second subject key = digest(hostile Run
    // bytes) so rehash passes, Matrix parse fails, whole field omitted.
    const hostileRun = await fixtureBytes("run", "minimal");
    const hostileDigest = recordDigest(hostileRun);
    const wrongKindReport = sealReport({
      protocol: "https://spec.jinn.network/protocols/benchmarking/v1",
      subjects: [
        { digest: { sha256: digestA.slice("sha256:".length) } },
        { digest: { sha256: hostileDigest.slice("sha256:".length) } },
      ],
      method: {
        id: "jinn.benchmarking.method/wilson",
        version: "1",
        parameters: {},
      },
      preregistered: true,
      results: {},
      disclosures: {
        perSubject: [
          disclosure(digestA.slice("sha256:".length)),
          disclosure(hostileDigest.slice("sha256:".length)),
        ],
      },
      author: "urn:uuid:66666666-6666-5666-8666-666666666666",
    });
    const wrongKind = await reportRecompute(
      wrongKindReport.bytes,
      refsFrom(new Map([
        [digestA, matrixA],
        [hostileDigest, hostileRun],
      ])),
    );
    expect(wrongKind).toEqual({
      methodId: "jinn.benchmarking.method/wilson",
      methodVersion: "1",
      author: "urn:uuid:66666666-6666-5666-8666-666666666666",
      preregistered: true,
    });
    expect(wrongKind).not.toHaveProperty("matrixDigests");

    const ok = await reportRecompute(
      report.bytes,
      refsFrom(new Map([
        [digestA, matrixA],
        [digestB, matrixB],
      ])),
    );
    expect(ok.matrixDigests).toEqual([digestA, digestB]);
  });

  it("returns no facts for malformed bytes", async () => {
    const junk = new TextEncoder().encode("{not-json");
    expect(await benchmarkRecompute(junk, noReferencedBytes)).toEqual({});
    expect(await runRecompute(junk, noReferencedBytes)).toEqual({});
    expect(await matrixRecompute(junk, noReferencedBytes)).toEqual({});
    expect(await reportRecompute(junk, noReferencedBytes)).toEqual({});
  });

  it("registry resolves legacy, signed Report, and Accounting kinds and returns undefined for unknown kinds", () => {
    expect(BENCHMARKING_FACTS_RECOMPUTE.get(BENCHMARK_RECORD_KIND)).toBe(benchmarkRecompute);
    expect(BENCHMARKING_FACTS_RECOMPUTE.get(RUN_RECORD_KIND)).toBe(runRecompute);
    expect(BENCHMARKING_FACTS_RECOMPUTE.get(MATRIX_RECORD_KIND)).toBe(matrixRecompute);
    expect(BENCHMARKING_FACTS_RECOMPUTE.get(REPORT_RECORD_KIND)).toBe(reportRecompute);
    expect(BENCHMARKING_FACTS_RECOMPUTE.get(REPORT_V2_RECORD_KIND)).toBe(signedReportRecompute);
    expect(BENCHMARKING_FACTS_RECOMPUTE.get(BENCHMARK_ACCOUNTING_RECORD_KIND)).toBe(benchmarkAccountingRecompute);
    expect(BENCHMARKING_FACTS_RECOMPUTE.get("https://spec.jinn.network/records/unknown/v1")).toBeUndefined();
  });
});

describe("v2 recompute: the join edges v1 left out", () => {
  it("names the Tasks a Benchmark is made of", async () => {
    const bytes = await fixtureBytes("benchmark", "valid");
    const record = parseBenchmark(bytes);
    const facts = await benchmarkRecomputeV2(bytes, noReferencedBytes);
    expect(facts.taskDigests).toEqual(record.items.map((item) => `sha256:${item.task.digest.sha256}`));
    expect(facts.benchmarkDigest).toBe(recordDigest(bytes));
  });

  it("keeps every v1 fact and adds nothing else when a Benchmark supersedes nothing", async () => {
    const bytes = await fixtureBytes("benchmark", "minimal");
    const v1 = await benchmarkRecompute(bytes, noReferencedBytes);
    const v2 = await benchmarkRecomputeV2(bytes, noReferencedBytes);
    expect(v2).toMatchObject(v1);
    expect(v2).not.toHaveProperty("supersedesDigest");
  });

  it("names the per-cell Task, Submission, Delivery and verdict records of a Matrix", async () => {
    const bytes = await fixtureBytes("matrix", "valid");
    const record = parseMatrix(bytes);
    const facts = await matrixRecomputeV2(bytes, noReferencedBytes);
    expect(facts.taskDigests).toEqual([`sha256:${record.cells[0].taskDigest}`]);
    expect(facts.submissionDigests).toEqual([record.cells[0].submission]);
    expect(facts.deliveryDigests).toEqual([record.cells[0].delivery]);
    expect(facts.verdictDigests).toEqual(record.cells[0].verdicts);
  });

  it("de-duplicates a Task named by more than one cell, preserving record order", async () => {
    const bytes = await fixtureBytes("matrix", "valid");
    const record = parseMatrix(bytes);
    const document = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
    const first = record.cells[0];
    // A second replicate of the same cell: the same Task, a second Delivery and verdict. The
    // aggregates move with it, because the schema checks that they agree with the cells.
    const twoCells = {
      ...document,
      cells: [
        first,
        {
          ...first,
          replicate: 2,
          cellKey: `${first.taskDigest}/${first.armId}/2`,
          delivery: `sha256:${"a".repeat(64)}`,
          verdicts: [`sha256:${"b".repeat(64)}`],
          validVerdicts: [`sha256:${"b".repeat(64)}`],
        },
      ],
      completeness: { ...(document.completeness as object), expected: 2, judged: 2 },
      attrition: {
        asymmetryFlags: [],
        perArm: { [first.armId]: { excluded: 0, expected: 2, expired: 0, invalidated: 0, judged: 2, replacements: 0, unjudged: 0, unscorable: 0 } },
      },
    };
    const facts = await matrixRecomputeV2(sealMatrix(twoCells).bytes, noReferencedBytes);
    expect(facts.taskDigests).toEqual([`sha256:${first.taskDigest}`]);
    expect(facts.deliveryDigests).toEqual([first.delivery, `sha256:${"a".repeat(64)}`]);
    expect(facts.verdictDigests).toEqual([...first.verdicts, `sha256:${"b".repeat(64)}`]);
  });

  it("emits no facts at all for bytes that are not the record kind", async () => {
    const junk = new TextEncoder().encode('{"a":1}');
    expect(await benchmarkRecomputeV2(junk, noReferencedBytes)).toEqual({});
    expect(await matrixRecomputeV2(junk, noReferencedBytes)).toEqual({});
  });

  it("routes the two revised kinds to v2 and every other kind to its unrevised fn", () => {
    expect(BENCHMARKING_FACTS_RECOMPUTE_V2.get(BENCHMARK_RECORD_KIND)).toBe(benchmarkRecomputeV2);
    expect(BENCHMARKING_FACTS_RECOMPUTE_V2.get(MATRIX_RECORD_KIND)).toBe(matrixRecomputeV2);
    expect(BENCHMARKING_FACTS_RECOMPUTE_V2.get(RUN_RECORD_KIND)).toBe(
      BENCHMARKING_FACTS_RECOMPUTE.get(RUN_RECORD_KIND),
    );
    expect(BENCHMARKING_FACTS_RECOMPUTE_V2.get("https://spec.jinn.network/records/nope/v1")).toBeUndefined();
  });
});
