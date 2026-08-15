import { BENCHMARKING_PROTOCOL, parseRun, sealBenchmark, sealRun, type RunRecord } from "@jinn-network/benchmarking-records";
import { describe, expect, test } from "vitest";
import {
  CloseAuthorityMismatchError,
  assertCoherentCloseAnchor,
  cachedCloseBoundaryResolver,
  resolveCoherentCloseAuthority,
} from "./close-authority.js";
import { marketplaceAssemblyPorts } from "./assembly-ports.js";
import { freezeAuthorityProjection } from "./projection-resolver.js";
import { deriveAuthorityProjection } from "./authority-projection.js";

const BENCH_DIGEST = "b".repeat(64);

function marketplaceRun(closeAt = "2026-08-04T00:00:00Z"): RunRecord {
  const sealedBench = sealBenchmark({
    protocol: BENCHMARKING_PROTOCOL,
    name: "coherent-close probe",
    description: "coherent close authority fixture",
    author: "urn:uuid:10000000-0000-5000-8000-000000000001",
    version: "1.0.0",
    items: [{ task: { digest: { sha256: BENCH_DIGEST } } }],
    reveal: { policy: "immediate" },
  });
  return parseRun(sealRun({
    protocol: BENCHMARKING_PROTOCOL,
    benchmark: { digest: { sha256: sealedBench.digest.slice("sha256:".length) } },
    owner: "urn:uuid:20000000-0000-5000-8000-000000000002",
    arms: [{
      armId: "armA",
      pinning: { model: { id: "model-a" }, harness: { id: "kit", version: "1" } },
    }],
    replicates: 1,
    policy: {
      completenessFloor: "1",
      cellWindow: 3_600_000,
      replacement: { allowed: false },
      independence: "gating",
      evaluation: { minVerdicts: 1, distinctEvaluator: true },
      submissionBaseline: { isolationPolicy: "fixture" },
    },
    venue: { kind: "open-competition" },
    budget: {
      perCell: { solve: "1", evaluate: "1" },
      hardCap: "10",
      unit: "wei",
    },
    closeAt,
  }).bytes);
}

describe("resolveCoherentCloseAuthority", () => {
  test("returns boundary.at equal to sealed Run.closeAt and a shared anchor", async () => {
    const run = marketplaceRun("2026-08-04T00:00:00Z");
    const coherent = await resolveCoherentCloseAuthority(run, {
      blocks: {
        async firstFinalizedAtOrAfter(closeAt) {
          expect(closeAt).toBe("2026-08-04T00:00:00Z");
          return {
            chain: "eip155:84532",
            blockNumber: 42,
            blockHash: "0xabc",
            timestamp: "2026-08-04T00:00:05Z",
          };
        },
      },
    });
    expect(coherent.boundary.at).toBe("2026-08-04T00:00:00Z");
    expect(coherent.anchor).toEqual({
      chain: "eip155:84532",
      blockNumber: 42,
      blockHash: "0xabc",
    });
  });

  test("cached resolver returns the same boundary on repeat resolve", async () => {
    const run = marketplaceRun();
    const coherent = await resolveCoherentCloseAuthority(run, {
      blocks: {
        async firstFinalizedAtOrAfter() {
          return {
            chain: "eip155:84532",
            blockNumber: 1,
            blockHash: "0x1111111111111111111111111111111111111111111111111111111111111111",
            timestamp: "2026-08-04T00:00:01Z",
          };
        },
      },
    });
    const cached = cachedCloseBoundaryResolver(coherent.boundary);
    await expect(cached.resolve(run)).resolves.toEqual(coherent.boundary);
  });
});

describe("assertCoherentCloseAnchor", () => {
  test("rejects mismatched anchors between assembly legs", () => {
    const expected = {
      chain: "eip155:84532",
      blockNumber: 10,
      blockHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    };
    const supplied = {
      chain: "eip155:84532",
      blockNumber: 11,
      blockHash: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    };
    expect(() => assertCoherentCloseAnchor(expected, supplied)).toThrow(CloseAuthorityMismatchError);
  });
});

describe("marketplaceAssemblyPorts coherent close", () => {
  test("rejects mismatched inputScope.closeAnchor when coherentClose is supplied", () => {
    expect(() => marketplaceAssemblyPorts({
      closeBoundary: {
        blocks: {
          async firstFinalizedAtOrAfter() {
            return {
              chain: "eip155:84532",
              blockNumber: 10,
              blockHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              timestamp: "2026-08-04T00:00:01Z",
            };
          },
        },
      },
      coherentClose: {
        boundary: {
          at: "2026-08-04T00:00:00Z",
          anchor: {
            chain: "eip155:84532",
            blockNumber: 10,
            blockHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          },
        },
        anchor: {
          chain: "eip155:84532",
          blockNumber: 10,
          blockHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        },
      },
      authorityProjection: freezeAuthorityProjection(deriveAuthorityProjection([], {
        chain: "eip155:84532",
        blockNumber: 10,
        blockHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      })),
      inputScope: {
        closeAnchor: {
          chain: "eip155:84532",
          blockNumber: 99,
          blockHash: "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
        },
        join: { cellsFromObservations: () => [] },
      },
      cost: { generation: "revised", budgetUnit: "wei" },
      trust: { async resolveAgent() { return "unresolved"; } },
    })).toThrow(CloseAuthorityMismatchError);
  });
});
