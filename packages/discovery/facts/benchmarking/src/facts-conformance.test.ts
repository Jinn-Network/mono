import {
  loadGoldenBytes,
  parseBenchmark,
  sealMatrix,
  sealReport,
  sealRun,
} from "@jinn-network/benchmarking-records";
import {
  GENESIS_SEQUENCE,
  RECORD_DISCOVERY_VERSION,
  recordDigest,
  verifyItem,
} from "@jinn-network/record-discovery-protocol";
import type {
  AnnouncedItem,
  AnnouncementEntry,
  FactsProfileDocument,
  ItemOutcome,
  RecordFetcher,
} from "@jinn-network/record-discovery-protocol";
import { digestOf, makeInMemoryPorts } from "@jinn-network/record-discovery-testing";
import { describe, expect, it } from "vitest";

import {
  BENCHMARK_RECORD_KIND,
  MATRIX_RECORD_KIND,
  REPORT_RECORD_KIND,
  RUN_RECORD_KIND,
} from "./identifiers.js";
import {
  benchmarkProfile,
  matrixProfile,
  reportProfile,
  runProfile,
} from "./profiles.js";
import { BENCHMARKING_FACTS_RECOMPUTE } from "./recompute.js";

// Leaf facts-conformance at the public verifyItem / facts-consistency boundary
// (program §7.130).
//
// discovery-testing's `makeInMemoryPorts` always installs the kit's fake
// FactsRecompute and re-seals `records` through protocol `sealJson`, so it
// cannot accept `BENCHMARKING_FACTS_RECOMPUTE` or serve exact
// `@jinn-network/benchmarking-records` sealed bytes. This suite therefore:
//   - uses kit `digestOf` + `makeInMemoryPorts` only for AnnouncementEntry
//     sealing / EntryFetcher and unused keys+sigs stubs
//   - injects `BENCHMARKING_FACTS_RECOMPUTE` and a byte-exact RecordFetcher
//     (own record + referenced records) at verifyItem
// It does NOT call `runItemConformance` or replay unrelated generic vectors.

const SOURCE = { agent: "did:key:zBenchmarkingFactsConformance", name: "facts" };

function hexOf(digest: `sha256:${string}`): string {
  return digest.slice("sha256:".length);
}

function disclosure(subjectSha256: string) {
  return {
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
  };
}

function sealLinkedRun(benchmarkDigest: `sha256:${string}`) {
  return sealRun({
    protocol: "https://jinn.network/protocols/benchmarking/1.0",
    owner: "urn:uuid:22222222-2222-5222-8222-222222222222",
    benchmark: { digest: { sha256: hexOf(benchmarkDigest) } },
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
}

function sealLinkedMatrix(runDigest: `sha256:${string}`) {
  return sealMatrix({
    protocol: "https://jinn.network/protocols/benchmarking/1.0",
    run: { digest: { sha256: hexOf(runDigest) } },
    assembly: { procedure: "jinn.benchmarking.assembly", version: "1.0" },
    closeBoundary: { at: "2026-08-04T00:00:00Z" },
    cells: [],
    exclusions: [],
    attrition: { asymmetryFlags: [], perArm: {} },
    completeness: { expected: 0, judged: 0, floor: "1", runOutcome: "partial" },
  });
}

function sealLinkedReport(subjectDigests: readonly `sha256:${string}`[]) {
  return sealReport({
    protocol: "https://jinn.network/protocols/benchmarking/1.0",
    subjects: subjectDigests.map((digest) => ({ digest: { sha256: hexOf(digest) } })),
    method: {
      id: "jinn.benchmarking.method/wilson",
      version: "1",
      parameters: {},
    },
    preregistered: true,
    results: {},
    disclosures: {
      perSubject: subjectDigests.map((digest) => disclosure(hexOf(digest))),
    },
    author: "urn:uuid:66666666-6666-5666-8666-666666666666",
  });
}

async function verifyBenchmarkingItem(params: {
  kind: string;
  profile: FactsProfileDocument;
  bytes: Uint8Array;
  facts: Record<string, unknown>;
  /** Extra digests served by RecordFetcher (referenced records). */
  referenced?: ReadonlyMap<string, Uint8Array>;
}): Promise<ItemOutcome> {
  const digest = recordDigest(params.bytes);
  const announcementId = `ann-${params.kind.split("/").at(-2) ?? "record"}`;
  const entry: AnnouncementEntry = {
    protocol: RECORD_DISCOVERY_VERSION,
    source: SOURCE,
    sequence: GENESIS_SEQUENCE,
    previous: null,
    timestamp: "2026-07-28T12:00:00Z",
    announcements: [
      {
        announcementId,
        action: "available",
        record: { kind: params.kind, digest },
      },
    ],
  };
  const entryDigest = digestOf(entry);
  const kitPorts = makeInMemoryPorts({
    entries: { [entryDigest]: entry },
  });

  const records: RecordFetcher = {
    async "fetch"(requested) {
      if (requested === digest) return params.bytes;
      const referenced = params.referenced?.get(requested);
      if (referenced !== undefined) return referenced;
      throw new Error(`no record seeded for ${requested}`);
    },
  };

  const item: AnnouncedItem = {
    record: { kind: params.kind, digest },
    facts: params.facts,
    provenance: { source: SOURCE, entry: entryDigest, announcementId },
  };

  return verifyItem({
    item,
    profile: params.profile,
    decisionGrade: false,
    ports: {
      records,
      entries: kitPorts.entries,
      keys: kitPorts.keys,
      sigs: kitPorts.sigs,
      factsRecompute: BENCHMARKING_FACTS_RECOMPUTE,
      verifiedChain: async () => true,
    },
  });
}

describe("facts/benchmarking leaf conformance via verifyItem (program §7.128–§7.130)", () => {
  describe("Benchmark", () => {
    it("consistent: truthful card matches recomputed native facts", async () => {
      const bytes = await loadGoldenBytes("benchmark", "valid");
      const record = parseBenchmark(bytes);
      const outcome = await verifyBenchmarkingItem({
        kind: BENCHMARK_RECORD_KIND,
        profile: benchmarkProfile,
        bytes,
        facts: {
          benchmarkDigest: recordDigest(bytes),
          author: record.author,
          version: record.version,
        },
      });
      expect(outcome).toEqual({ status: "verified", facts: "consistent" });
    });

    it("inconsistent: lying version card", async () => {
      const bytes = await loadGoldenBytes("benchmark", "valid");
      const record = parseBenchmark(bytes);
      const outcome = await verifyBenchmarkingItem({
        kind: BENCHMARK_RECORD_KIND,
        profile: benchmarkProfile,
        bytes,
        facts: {
          benchmarkDigest: recordDigest(bytes),
          author: record.author,
          version: "9.9.9",
        },
      });
      expect(outcome).toEqual({ status: "verified", facts: "inconsistent" });
    });
  });

  describe("Run", () => {
    it("consistent: truthful card with validated benchmark reference", async () => {
      const benchmark = await loadGoldenBytes("benchmark", "valid");
      const benchmarkDigest = recordDigest(benchmark);
      const sealed = sealLinkedRun(benchmarkDigest);
      const outcome = await verifyBenchmarkingItem({
        kind: RUN_RECORD_KIND,
        profile: runProfile,
        bytes: sealed.bytes,
        facts: {
          runDigest: recordDigest(sealed.bytes),
          owner: "urn:uuid:22222222-2222-5222-8222-222222222222",
          benchmarkDigest,
        },
        referenced: new Map([[benchmarkDigest, benchmark]]),
      });
      expect(outcome).toEqual({ status: "verified", facts: "consistent" });
    });

    it("inconsistent: lying owner card", async () => {
      const benchmark = await loadGoldenBytes("benchmark", "valid");
      const benchmarkDigest = recordDigest(benchmark);
      const sealed = sealLinkedRun(benchmarkDigest);
      const outcome = await verifyBenchmarkingItem({
        kind: RUN_RECORD_KIND,
        profile: runProfile,
        bytes: sealed.bytes,
        facts: {
          runDigest: recordDigest(sealed.bytes),
          owner: "urn:uuid:99999999-9999-5999-8999-999999999999",
          benchmarkDigest,
        },
        referenced: new Map([[benchmarkDigest, benchmark]]),
      });
      expect(outcome).toEqual({ status: "verified", facts: "inconsistent" });
    });

    it("indeterminate: missing referenced Benchmark bytes", async () => {
      const benchmark = await loadGoldenBytes("benchmark", "valid");
      const benchmarkDigest = recordDigest(benchmark);
      const sealed = sealLinkedRun(benchmarkDigest);
      const outcome = await verifyBenchmarkingItem({
        kind: RUN_RECORD_KIND,
        profile: runProfile,
        bytes: sealed.bytes,
        facts: {
          runDigest: recordDigest(sealed.bytes),
          owner: "urn:uuid:22222222-2222-5222-8222-222222222222",
          benchmarkDigest,
        },
      });
      expect(outcome).toEqual({ status: "verified", facts: "indeterminate" });
    });

    it("indeterminate: parse-after-rehash wrong-kind Benchmark reference", async () => {
      const hostile = await loadGoldenBytes("run", "minimal");
      const hostileDigest = recordDigest(hostile);
      const sealed = sealLinkedRun(hostileDigest);
      const outcome = await verifyBenchmarkingItem({
        kind: RUN_RECORD_KIND,
        profile: runProfile,
        bytes: sealed.bytes,
        facts: {
          runDigest: recordDigest(sealed.bytes),
          owner: "urn:uuid:22222222-2222-5222-8222-222222222222",
          benchmarkDigest: hostileDigest,
        },
        referenced: new Map([[hostileDigest, hostile]]),
      });
      expect(outcome).toEqual({ status: "verified", facts: "indeterminate" });
    });
  });

  describe("Matrix", () => {
    it("consistent: truthful card with validated Run reference", async () => {
      const run = await loadGoldenBytes("run", "minimal");
      const runDigest = recordDigest(run);
      const sealed = sealLinkedMatrix(runDigest);
      const outcome = await verifyBenchmarkingItem({
        kind: MATRIX_RECORD_KIND,
        profile: matrixProfile,
        bytes: sealed.bytes,
        facts: {
          matrixDigest: recordDigest(sealed.bytes),
          runDigest,
          runOutcome: "partial",
        },
        referenced: new Map([[runDigest, run]]),
      });
      expect(outcome).toEqual({ status: "verified", facts: "consistent" });
    });

    it("inconsistent: lying runOutcome card", async () => {
      const run = await loadGoldenBytes("run", "minimal");
      const runDigest = recordDigest(run);
      const sealed = sealLinkedMatrix(runDigest);
      const outcome = await verifyBenchmarkingItem({
        kind: MATRIX_RECORD_KIND,
        profile: matrixProfile,
        bytes: sealed.bytes,
        facts: {
          matrixDigest: recordDigest(sealed.bytes),
          runDigest,
          runOutcome: "complete",
        },
        referenced: new Map([[runDigest, run]]),
      });
      expect(outcome).toEqual({ status: "verified", facts: "inconsistent" });
    });

    it("indeterminate: missing referenced Run bytes", async () => {
      const run = await loadGoldenBytes("run", "minimal");
      const runDigest = recordDigest(run);
      const sealed = sealLinkedMatrix(runDigest);
      const outcome = await verifyBenchmarkingItem({
        kind: MATRIX_RECORD_KIND,
        profile: matrixProfile,
        bytes: sealed.bytes,
        facts: {
          matrixDigest: recordDigest(sealed.bytes),
          runDigest,
          runOutcome: "partial",
        },
      });
      expect(outcome).toEqual({ status: "verified", facts: "indeterminate" });
    });

    it("indeterminate: parse-after-rehash wrong-kind Run reference", async () => {
      const hostile = await loadGoldenBytes("benchmark", "valid");
      const hostileDigest = recordDigest(hostile);
      const sealed = sealLinkedMatrix(hostileDigest);
      const outcome = await verifyBenchmarkingItem({
        kind: MATRIX_RECORD_KIND,
        profile: matrixProfile,
        bytes: sealed.bytes,
        facts: {
          matrixDigest: recordDigest(sealed.bytes),
          runDigest: hostileDigest,
          runOutcome: "partial",
        },
        referenced: new Map([[hostileDigest, hostile]]),
      });
      expect(outcome).toEqual({ status: "verified", facts: "indeterminate" });
    });
  });

  describe("Report", () => {
    it("consistent: truthful plural matrixDigests card", async () => {
      const matrixA = await loadGoldenBytes("matrix", "minimal");
      const matrixB = await loadGoldenBytes("matrix", "valid");
      const digestA = recordDigest(matrixA);
      const digestB = recordDigest(matrixB);
      const sealed = sealLinkedReport([digestA, digestB]);
      const outcome = await verifyBenchmarkingItem({
        kind: REPORT_RECORD_KIND,
        profile: reportProfile,
        bytes: sealed.bytes,
        facts: {
          matrixDigests: [digestA, digestB],
          methodId: "jinn.benchmarking.method/wilson",
          methodVersion: "1",
          author: "urn:uuid:66666666-6666-5666-8666-666666666666",
          preregistered: true,
        },
        referenced: new Map([
          [digestA, matrixA],
          [digestB, matrixB],
        ]),
      });
      expect(outcome).toEqual({ status: "verified", facts: "consistent" });
    });

    it("inconsistent: lying methodId card", async () => {
      const matrixA = await loadGoldenBytes("matrix", "minimal");
      const digestA = recordDigest(matrixA);
      const sealed = sealLinkedReport([digestA]);
      const outcome = await verifyBenchmarkingItem({
        kind: REPORT_RECORD_KIND,
        profile: reportProfile,
        bytes: sealed.bytes,
        facts: {
          matrixDigests: [digestA],
          methodId: "jinn.benchmarking.method/pass-at-k",
          methodVersion: "1",
          author: "urn:uuid:66666666-6666-5666-8666-666666666666",
          preregistered: true,
        },
        referenced: new Map([[digestA, matrixA]]),
      });
      expect(outcome).toEqual({ status: "verified", facts: "inconsistent" });
    });

    it("indeterminate: partial missing Matrix reference fails closed for whole matrixDigests", async () => {
      const matrixA = await loadGoldenBytes("matrix", "minimal");
      const matrixB = await loadGoldenBytes("matrix", "valid");
      const digestA = recordDigest(matrixA);
      const digestB = recordDigest(matrixB);
      const sealed = sealLinkedReport([digestA, digestB]);
      const outcome = await verifyBenchmarkingItem({
        kind: REPORT_RECORD_KIND,
        profile: reportProfile,
        bytes: sealed.bytes,
        facts: {
          matrixDigests: [digestA, digestB],
          methodId: "jinn.benchmarking.method/wilson",
          methodVersion: "1",
          author: "urn:uuid:66666666-6666-5666-8666-666666666666",
          preregistered: true,
        },
        referenced: new Map([[digestA, matrixA]]),
      });
      expect(outcome).toEqual({ status: "verified", facts: "indeterminate" });
    });

    it("indeterminate: parse-after-rehash wrong-kind Matrix reference fails closed for whole field", async () => {
      const matrixA = await loadGoldenBytes("matrix", "minimal");
      const hostile = await loadGoldenBytes("run", "minimal");
      const digestA = recordDigest(matrixA);
      const hostileDigest = recordDigest(hostile);
      const sealed = sealLinkedReport([digestA, hostileDigest]);
      const outcome = await verifyBenchmarkingItem({
        kind: REPORT_RECORD_KIND,
        profile: reportProfile,
        bytes: sealed.bytes,
        facts: {
          matrixDigests: [digestA, hostileDigest],
          methodId: "jinn.benchmarking.method/wilson",
          methodVersion: "1",
          author: "urn:uuid:66666666-6666-5666-8666-666666666666",
          preregistered: true,
        },
        referenced: new Map([
          [digestA, matrixA],
          [hostileDigest, hostile],
        ]),
      });
      expect(outcome).toEqual({ status: "verified", facts: "indeterminate" });
    });
  });
});
