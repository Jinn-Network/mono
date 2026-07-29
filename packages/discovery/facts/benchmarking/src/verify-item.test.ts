import { loadGoldenBytes } from "@jinn-network/benchmarking-records";
import {
  GENESIS_SEQUENCE,
  RECORD_DISCOVERY_VERSION,
  recordDigest,
  sealJson,
  verifyItem,
} from "@jinn-network/record-discovery-protocol";
import type {
  AnnouncedItem,
  AnnouncementEntry,
  EntryFetcher,
  KeyResolver,
  RecordFetcher,
  SignatureVerifier,
} from "@jinn-network/record-discovery-protocol";
import { describe, expect, it } from "vitest";

import { BENCHMARK_RECORD_KIND } from "./identifiers.js";
import { benchmarkProfile } from "./profiles.js";
import { BENCHMARKING_FACTS_RECOMPUTE } from "./recompute.js";

function entryFetcherFor(params: {
  source: { agent: string; name: string };
  announcementId: string;
  record: { kind: string; digest: `sha256:${string}` };
}): { entryFetcher: EntryFetcher; entryDigest: `sha256:${string}` } {
  const entry: AnnouncementEntry = {
    protocol: RECORD_DISCOVERY_VERSION,
    source: params.source,
    sequence: GENESIS_SEQUENCE,
    previous: null,
    timestamp: "2026-07-28T12:00:00Z",
    announcements: [
      { announcementId: params.announcementId, action: "available", record: params.record },
    ],
  };
  const { bytes, digest } = sealJson(entry);
  return {
    entryDigest: digest,
    entryFetcher: {
      async "fetch"(requested) {
        if (requested !== digest) throw new Error(`no entry seeded for ${requested}`);
        return bytes;
      },
    },
  };
}

const unusedKeyResolver: KeyResolver = {
  async resolve() {
    throw new Error("keys port must not be called for this item verification");
  },
  async everBound() {
    throw new Error("keys port must not be called for this item verification");
  },
};
const unusedSignatureVerifier: SignatureVerifier = {
  async verify() {
    throw new Error("sigs port must not be called for this item verification");
  },
};

describe("facts/benchmarking verifyItem integration", () => {
  it("verifies a Benchmark announcement as facts-consistent via leaf recompute", async () => {
    const bytes = await loadGoldenBytes("benchmark", "valid");
    const digest = recordDigest(bytes);
    const facts = await BENCHMARKING_FACTS_RECOMPUTE.get(BENCHMARK_RECORD_KIND)!(bytes, {
      async "fetch"() {
        return undefined;
      },
    });
    const source = { agent: "did:key:zBenchmarkAuthor", name: "bench" };
    const announcementId = "ann-benchmark-1";
    const { entryFetcher, entryDigest } = entryFetcherFor({
      source,
      announcementId,
      record: { kind: BENCHMARK_RECORD_KIND, digest },
    });
    const item: AnnouncedItem = {
      record: { kind: BENCHMARK_RECORD_KIND, digest },
      facts,
      provenance: { source, entry: entryDigest, announcementId },
    };
    const records: RecordFetcher = {
      async "fetch"(requested) {
        if (requested !== digest) throw new Error(`unexpected record fetch ${requested}`);
        return bytes;
      },
    };
    const outcome = await verifyItem({
      item,
      profile: benchmarkProfile,
      decisionGrade: false,
      ports: {
        records,
        entries: entryFetcher,
        keys: unusedKeyResolver,
        sigs: unusedSignatureVerifier,
        factsRecompute: BENCHMARKING_FACTS_RECOMPUTE,
        verifiedChain: async () => true,
      },
    });
    expect(outcome).toEqual({ status: "verified", facts: "consistent" });
  });

  it("returns indeterminate when a reference-bearing Run fact cannot be resolved", async () => {
    const { sealRun } = await import("@jinn-network/benchmarking-records");
    const { runProfile } = await import("./profiles.js");
    const { RUN_RECORD_KIND } = await import("./identifiers.js");
    const sealed = sealRun({
      protocol: "https://jinn.network/protocols/benchmarking/1.0",
      owner: "urn:uuid:22222222-2222-5222-8222-222222222222",
      benchmark: { digest: { sha256: "c".repeat(64) } },
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
    const digest = recordDigest(sealed.bytes);
    const source = { agent: "did:key:zRunOwner", name: "runs" };
    const announcementId = "ann-run-1";
    const { entryFetcher, entryDigest } = entryFetcherFor({
      source,
      announcementId,
      record: { kind: RUN_RECORD_KIND, digest },
    });
    const item: AnnouncedItem = {
      record: { kind: RUN_RECORD_KIND, digest },
      facts: {
        runDigest: digest,
        owner: "urn:uuid:22222222-2222-5222-8222-222222222222",
        benchmarkDigest: `sha256:${"c".repeat(64)}`,
      },
      provenance: { source, entry: entryDigest, announcementId },
    };
    const outcome = await verifyItem({
      item,
      profile: runProfile,
      decisionGrade: false,
      ports: {
        records: {
          async "fetch"(requested) {
            if (requested !== digest) throw new Error(`unexpected record fetch ${requested}`);
            return sealed.bytes;
          },
        },
        entries: entryFetcher,
        keys: unusedKeyResolver,
        sigs: unusedSignatureVerifier,
        factsRecompute: BENCHMARKING_FACTS_RECOMPUTE,
        verifiedChain: async () => true,
      },
    });
    expect(outcome).toEqual({ status: "verified", facts: "indeterminate" });
  });
});
