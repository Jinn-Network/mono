/**
 * Acceptance test for issue #4098 (DR-2026-09-05, spec
 * `docs/superpowers/specs/2026-09-02-prediction-forecast-paired-scoreability.md` §7 S3).
 *
 * Five registry methods declare `clusteringRule: "task-provenance-source"`, and all five resolve
 * provenance through `resolveBenchmarkTaskProvenance`. Before this packet that resolver looked in
 * exactly one place — `task.data.payload["provenance"]` — and the bundled sample's profile
 * (`prediction-forecast/1.0`) closes its payload to exactly `{forecast}`, so every clustered
 * paired method over the sample died on a typed `task-provenance-source-missing` refusal that read
 * as a bug rather than a boundary.
 *
 * The honest state for a three-task, one-cluster sample is a *withheld* interval with a stated
 * reason, not a refusal. That is exactly what this asserts, over the real bundled sample bytes.
 */

import { createMethodRegistry } from "@jinn-network/benchmarking-aggregate";
import {
  BENCHMARKING_METHOD_IDS,
  BENCHMARKING_METHOD_VERSION,
  BENCHMARKING_PROTOCOL,
  cellKey,
  parseMatrix,
  sealMatrix,
  sealRun,
} from "@jinn-network/benchmarking-records";
import { canonicalJsonBytes, recordDigest, sealDsseEnvelope } from "@jinn-network/trust-core";
import { describe, expect, test } from "vitest";
import { buildSampleBenchmark, SAMPLE_PROVENANCE_SOURCE } from "./sample.js";

/** `paired-delta@1`'s frozen v1 floor. Spelled out, not imported: this test asserts the exact
 * withholding sentence a reader sees, and #4098 puts the floor itself out of scope. */
const MIN_PAIRED_DELTA_TASKS = 5;

const BASELINE = "armBaseline";
const CANDIDATE = "armCandidate";
const MATCH_ALL = { harness: "match", model: "match", loadout: "match", isolation: "match", checksFailed: [] } as const;

/** One sealed result-evaluation attestation, the exact shape `resolveVerdictOutcome` admits. */
function verdictEnvelope(taskDigestHex: string, armId: string, verdict: "pass" | "fail"): Uint8Array {
  return sealDsseEnvelope({
    payloadBytes: canonicalJsonBytes({
      _type: "https://in-toto.io/Statement/v1",
      subject: [{ name: `${armId}/${taskDigestHex}`, digest: { sha256: taskDigestHex } }],
      predicateType: "https://spec.jinn.network/attestations/result-evaluation/v1",
      predicate: {
        evaluatedAt: "2026-07-29T00:00:00Z",
        evaluator: { id: "urn:uuid:77777777-7777-5777-8777-777777777777" },
        taskSubject: "execution/task/task.json",
        resultSubjects: ["execution/result/result.json"],
        verdict,
      },
    }),
    payloadType: "application/vnd.in-toto+json",
    signatures: [{ keyid: "did:key:zSampleFixture", signature: Uint8Array.of(1) }],
  });
}

/**
 * A two-arm Matrix over the real bundled sample's Task digests, every cell judged. Judged in BOTH
 * arms is load-bearing: `paired-delta@1` only resolves provenance for tasks paired across arms, so
 * an unjudged arm would let this test pass without ever exercising the resolver.
 */
async function sampleTwoArmMatrix() {
  const sample = await buildSampleBenchmark();
  const verdicts = new Map<string, Uint8Array>();
  const cells = [];
  for (const [index, task] of sample.tasks.entries()) {
    for (const [armIndex, [armId, verdict]] of ([[BASELINE, "fail"], [CANDIDATE, index === 0 ? "fail" : "pass"]] as const).entries()) {
      const envelope = verdictEnvelope(task.sha256, armId, verdict);
      const digest = recordDigest(envelope);
      verdicts.set(digest, envelope);
      // Synthetic but distinct submission/delivery digests: the Matrix schema requires a judged
      // cell to name an accounted dispatch, Submission and Delivery (§8.1/§8.2). Their contents
      // are irrelevant here — no method under test resolves them.
      const nonce = `${index}${armIndex}`.padStart(2, "0");
      cells.push({
        cellKey: cellKey(task.sha256, armId, 1),
        taskDigest: task.sha256,
        armId,
        replicate: 1,
        dispatches: 1,
        accounted: 1,
        submission: `sha256:${`5${nonce}`.padEnd(64, "0")}` as const,
        delivery: `sha256:${`6${nonce}`.padEnd(64, "0")}` as const,
        verdicts: [digest],
        validVerdicts: [digest],
        outcome: "judged" as const,
        verification: MATCH_ALL,
        integrityTier: "attested-only" as const,
      });
    }
  }
  cells.sort((left, right) => left.cellKey < right.cellKey ? -1 : left.cellKey > right.cellKey ? 1 : 0);

  // `paired-mcnemar@1` and `provenance-cluster-sign@1` resolve the Run record before they cluster,
  // so the fixture carries a real one rather than a placeholder digest.
  const run = sealRun({
    protocol: BENCHMARKING_PROTOCOL,
    benchmark: { digest: { sha256: sample.benchmark.sha256 } },
    owner: "urn:uuid:22222222-2222-5222-8222-222222222222",
    // Arms must be pairwise DISTINCT in their pinning (§7.1), so the two carry different model
    // pins. Nothing under test reads them; they exist to make the Run record well-formed.
    arms: [{ armId: BASELINE, pinning: { model: "baseline-model" } }, { armId: CANDIDATE, pinning: { model: "candidate-model" } }],
    replicates: 1,
    policy: {
      completenessFloor: "1",
      cellWindow: 60_000,
      replacement: { allowed: false },
      independence: "disclosed",
      evaluation: { minVerdicts: 1, distinctEvaluator: false },
      submissionBaseline: {},
    },
    analysisPlan: [{
      method: BENCHMARKING_METHOD_IDS.pairedDelta,
      version: BENCHMARKING_METHOD_VERSION,
      parameters: {
        verdictRule: "sole", baseline: BASELINE, candidate: CANDIDATE,
        seed: 123456789, resamples: 128, alpha: "0.05",
      },
    }],
    closeAt: "2026-08-04T00:00:00Z",
  });

  const perArm = {
    expected: sample.tasks.length, judged: sample.tasks.length, unjudged: 0, unscorable: 0,
    expired: 0, invalidated: 0, excluded: 0, replacements: 0,
  };
  const sealed = sealMatrix({
    protocol: BENCHMARKING_PROTOCOL,
    run: { digest: { sha256: run.digest.slice("sha256:".length) } },
    closeBoundary: { at: "2026-08-04T00:00:00Z" },
    cells,
    exclusions: [],
    attrition: { perArm: { [BASELINE]: perArm, [CANDIDATE]: perArm }, asymmetryFlags: [] },
    completeness: { expected: cells.length, judged: cells.length, floor: "1", runOutcome: "complete" },
    assembly: { procedure: "jinn.benchmarking.assembly", version: "1.0" },
  });

  const taskBytes = new Map(sample.tasks.map((task) => [`sha256:${task.sha256}`, task.bytes]));
  return {
    sample,
    input: {
      subjects: [{ subjectSha256: sealed.digest.slice("sha256:".length), matrix: parseMatrix(sealed.bytes) }],
      parameters: {
        verdictRule: "sole", baseline: BASELINE, candidate: CANDIDATE,
        seed: 123456789, resamples: 128, alpha: "0.05",
      },
      verdictRule: "sole" as const,
      resolveVerdictBytes: (digest: string) => verdicts.get(digest),
      resolveRunBytes: (digest: string) => digest === run.digest ? run.bytes : undefined,
      resolveTaskBytes: (digest: string) => taskBytes.get(digest),
    },
  };
}

describe("paired-delta@1 over the bundled sample (#4098 acceptance)", () => {
  test("withholds the interval with a stated reason, rather than refusing the whole computation", async () => {
    const { sample, input } = await sampleTwoArmMatrix();
    const method = createMethodRegistry().get(BENCHMARKING_METHOD_IDS.pairedDelta, BENCHMARKING_METHOD_VERSION)!;

    const { perSubject } = method.compute!(input);
    const results = perSubject[0]!.results as {
      pairs: number;
      delta: string | null;
      interval: unknown;
      reasons: readonly string[];
      clustering: { basis: string; clusters: number };
      bootstrap: { clusters: readonly { key: readonly [string, string]; members: readonly string[] }[]; draws: number };
    };

    // The packet's whole point: the resolver ran on every sample task. Before it, this threw
    // MethodInputError("task-provenance-source-missing") before producing any result at all.
    expect(results.pairs).toBe(sample.tasks.length);
    expect(results.delta).not.toBeNull();

    // Withheld, with the two honest reasons — not computed, and not refused.
    expect(results.interval).toBeNull();
    expect(results.reasons).toEqual([
      `fewer than minN=${MIN_PAIRED_DELTA_TASKS} paired tasks (got ${sample.tasks.length})`,
      "fewer than two source clusters (got 1)",
    ]);
    expect(results.bootstrap.draws).toBe(0);

    // One synthetic venue origin for the whole sample, deliberately (spec §6).
    expect(results.clustering).toEqual({ basis: "task-provenance-source", clusters: 1 });
    expect(results.bootstrap.clusters).toEqual([{
      key: ["source", SAMPLE_PROVENANCE_SOURCE],
      members: sample.tasks.map((task) => task.sha256).sort(),
    }]);
  });

  test("the other clustered paired methods compute over the sample too", async () => {
    const { sample, input } = await sampleTwoArmMatrix();
    const registry = createMethodRegistry();
    for (const id of [BENCHMARKING_METHOD_IDS.pairedMcnemar, BENCHMARKING_METHOD_IDS.provenanceClusterSign]) {
      const method = registry.get(id, BENCHMARKING_METHOD_VERSION)!;
      const results = method.compute!(input).perSubject[0]!.results as {
        clustering: { basis: string; clusters: number };
      };
      // The issue's stated impact is that ALL FIVE `task-provenance-source` methods were unusable
      // against a closed-payload profile, not just the one S3 names. Two more, computing over the
      // same real sample bytes, is the cheapest honest evidence that the resolver — not each
      // method — was the single blocker.
      expect(results.clustering, id).toEqual({ basis: "task-provenance-source", clusters: 1 });
      expect(sample.tasks.length, id).toBe(3);
    }
  });
});
