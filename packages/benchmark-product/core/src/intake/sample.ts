/**
 * The bundled sample benchmark (BP-11, docs/superpowers/plans/2026-08-05-benchmark-product-issue-drafts.md
 * Draft 4): "from an empty workspace, a bundled sample produces a draft with
 * a sealed Benchmark (>= 2 items)" without network access.
 *
 * Every sample Task is a variation of the platform's own golden
 * prediction-forecast fixture (`@jinn-network/task-admission`'s
 * `loadPredictionSnapshotFixture` / `verifyPredictionSnapshotFixture`) — the
 * fixture is verified offline first so the sample never derives from a
 * drifted copy, then each variation's `payload.forecast` replaces the
 * fixture's wholesale, is re-sealed via `@jinn-network/task-execution-protocol`'s
 * `sealTask`, and is admitted via `@jinn-network/task-admission`'s
 * `admitPredictionSnapshot` as a construction-time sanity check: admission's
 * own exactness checks are what prove the re-sealed bytes still satisfy the
 * frozen native prediction-forecast contract.
 *
 * Every sample task binds the SAME EvaluationSpec — the fixture's own
 * evaluation-spec bytes, reused verbatim, never re-derived. The admission
 * policy pins the EvaluationSpec's grader, familyBlock, measurements, and
 * verdictRule byte-exactly (see `admitPredictionSnapshot`'s
 * `exactEvaluationSpec`); varying it would make admission refuse.
 *
 * This module does no workspace I/O of its own — it is a pure (modulo the
 * fixture-file read and the deterministic signer) builder. `../operations/sample.ts`
 * is the operation that stores its output in a workspace and attaches it to a draft.
 */

import { createPrivateKey, sign } from "node:crypto";
import {
  admitPredictionSnapshot,
  loadPredictionSnapshotFixture,
  sealPredictionSnapshotAdmissionReceipt,
  verifyPredictionSnapshotFixture,
} from "@jinn-network/task-admission";
import type { BenchmarkRecord } from "@jinn-network/benchmarking-records";
import { defineBenchmark } from "@jinn-network/benchmarking-interop";
import { sealTask } from "@jinn-network/task-execution-protocol";
import { sha256Hex } from "../workspace/sealed-store.js";

/** The issuer identity the sample's admission receipts are stamped with. */
export const SAMPLE_ISSUER = "benchmark-product-sample-admitter";

interface SampleForecastVariation {
  readonly marketId: string;
  readonly question: string;
  readonly consensusProbabilityYes: string;
  readonly observedAt: string;
  readonly resolvesAt: string;
}

/**
 * Three fixed forecast variations of the golden fixture's `payload.forecast`
 * (spec: `consensusProbabilityYes` matches `^(0(\.\d+)?|1(\.0+)?)$`,
 * `observedAt`/`resolvesAt` are UTC RFC3339 with `resolvesAt` strictly after
 * `observedAt`, market ids distinct). No wall clock — every value is a fixed
 * string literal, which is what makes the whole sample byte-reproducible.
 */
const SAMPLE_FORECAST_VARIATIONS: readonly SampleForecastVariation[] = [
  {
    marketId: "sample-market-alpha",
    question: "Will the alpha proposal pass its scheduled vote?",
    consensusProbabilityYes: "0.640000",
    observedAt: "2026-01-01T00:00:00Z",
    resolvesAt: "2026-01-08T00:00:00Z",
  },
  {
    marketId: "sample-market-bravo",
    question: "Will the bravo shipment arrive before its deadline?",
    consensusProbabilityYes: "0.320000",
    observedAt: "2026-02-01T00:00:00Z",
    resolvesAt: "2026-02-15T00:00:00Z",
  },
  {
    marketId: "sample-market-charlie",
    question: "Will the charlie contract renew for another term?",
    consensusProbabilityYes: "1.000000",
    observedAt: "2026-03-01T00:00:00Z",
    resolvesAt: "2026-03-10T00:00:00Z",
  },
];

const SAMPLE_SIGNING_KEY_ID = "benchmark-product-sample-key-1";

/**
 * A bundled sample-only Ed25519 key pair. Ed25519 signatures are
 * deterministic (RFC 8032), which is what makes the whole sample build
 * byte-reproducible across machines and runs. This key protects nothing —
 * it exists solely so the bundled sample's sealed bytes are identical every
 * time — and must never be used for anything but the bundled sample.
 *
 * Public JWK (for anyone verifying the sample's admission receipts
 * independently): { "crv": "Ed25519", "x": "_9RF2b7_Lh8Lf9Apg514N-G0f0NSRFri7n-hT63h3Ps", "kty": "OKP" }
 */
const SAMPLE_SIGNING_PRIVATE_JWK = {
  kty: "OKP",
  crv: "Ed25519",
  x: "_9RF2b7_Lh8Lf9Apg514N-G0f0NSRFri7n-hT63h3Ps",
  d: "0H1lenSw82QD3yZGeVael19qtFwWWWmRsiM1-RvqS-w",
};

/** Structurally matches `@jinn-network/trust-core`'s `DsseSigner` port, without importing it. */
type SampleDsseSigner = (request: {
  readonly preAuthEncoding: Uint8Array;
}) => Promise<readonly [{ readonly keyid: string; readonly signature: Uint8Array }]>;

const sampleSigner: SampleDsseSigner = async ({ preAuthEncoding }) => {
  const privateKey = createPrivateKey({ key: SAMPLE_SIGNING_PRIVATE_JWK, format: "jwk" });
  const signature = sign(null, Buffer.from(preAuthEncoding), privateKey);
  return [{ keyid: SAMPLE_SIGNING_KEY_ID, signature: new Uint8Array(signature) }];
};

/** Issues the bundled sample's deterministic admission receipt for one exact Task spelling. */
export async function sealSamplePredictionAdmissionReceipt(
  taskBytes: Uint8Array,
  evaluationSpecBytes: Uint8Array,
): Promise<{ readonly envelopeBytes: Uint8Array; readonly sha256: string }> {
  const receipt = admitPredictionSnapshot({
    taskBytes,
    evaluationSpecBytes,
    issuer: SAMPLE_ISSUER,
  });
  const sealed = await sealPredictionSnapshotAdmissionReceipt(receipt, sampleSigner);
  return { envelopeBytes: sealed.envelopeBytes, sha256: sha256Hex(sealed.envelopeBytes) };
}

export interface SampleBenchmarkTask {
  readonly marketId: string;
  readonly bytes: Uint8Array;
  readonly sha256: string;
  readonly receipt: {
    readonly envelopeBytes: Uint8Array;
    readonly sha256: string;
  };
}

export interface SampleBenchmark {
  readonly evaluationSpec: {
    readonly bytes: Uint8Array;
    readonly sha256: string;
  };
  readonly tasks: readonly SampleBenchmarkTask[];
  readonly benchmark: {
    readonly bytes: Uint8Array;
    readonly sha256: string;
    readonly record: BenchmarkRecord;
  };
}

/**
 * Builds the bundled sample benchmark deterministically: one sealed Task per
 * fixed forecast variation, all binding the fixture's own EvaluationSpec,
 * plus the Benchmark record naming their digests. Every byte is a pure
 * function of the fixture and the fixed variations/signing key above — no
 * wall clock, no randomness (beyond Ed25519's own deterministic signing).
 */
export async function buildSampleBenchmark(): Promise<SampleBenchmark> {
  // Guards against fixture drift before deriving the sample from it.
  await verifyPredictionSnapshotFixture();
  const fixture = await loadPredictionSnapshotFixture();

  const goldenTask = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(fixture.task),
  ) as Record<string, unknown>;

  const tasks: SampleBenchmarkTask[] = [];
  for (const variation of SAMPLE_FORECAST_VARIATIONS) {
    const candidateTask = structuredClone(goldenTask);
    candidateTask.payload = { forecast: { ...variation } };
    const taskBytes = sealTask(candidateTask);

    // Assert-by-construction sanity: admitPredictionSnapshot's own exactness
    // checks prove the re-sealed bytes satisfy the frozen native prediction
    // contract and still bind this exact EvaluationSpec — admitPredictionSnapshot
    // throws (refusing the whole build) if either is not the case.
    const sealedReceipt = await sealSamplePredictionAdmissionReceipt(taskBytes, fixture.evaluationSpec);

    tasks.push({
      marketId: variation.marketId,
      bytes: taskBytes,
      sha256: sha256Hex(taskBytes),
      receipt: {
        envelopeBytes: sealedReceipt.envelopeBytes,
        sha256: sealedReceipt.sha256,
      },
    });
  }

  const benchmark = defineBenchmark(
    tasks.map((task) => ({ bytes: task.bytes, digest: `sha256:${task.sha256}` as const })),
    {
      name: "bundled-prediction-sample",
      description: "Bundled sample benchmark of prediction-forecast tasks derived from the platform's golden fixture.",
      version: "1.0.0",
    },
  );

  return {
    evaluationSpec: { bytes: fixture.evaluationSpec, sha256: sha256Hex(fixture.evaluationSpec) },
    tasks,
    benchmark: { bytes: benchmark.bytes, sha256: sha256Hex(benchmark.bytes), record: benchmark.record },
  };
}
