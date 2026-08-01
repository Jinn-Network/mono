// SPDX-License-Identifier: Apache-2.0

import {
  EvaluationOperationalError,
  type ExactEvaluationMaterial,
} from "@jinn-network/task-execution-evaluation-harness";
import {
  checkMeasurementCoverage,
  checkVerdictConsistency,
  EVALUATION_SPEC_FORMAT_URI,
  EVAL_SEMANTICS_VERSION,
  type EvaluationSpec,
  type MeasurementMap,
} from "@jinn-network/task-execution-profiles";
import type { AttemptIdentity } from "@jinn-network/task-execution-supervisor";
import { describe, expect, test } from "vitest";
import { PREDICTION_PARSER } from "../parser-identity.js";
import { PREDICTION_FIXTURES } from "./fixtures.js";
import {
  contextResolutionSnapshotSource,
  createPredictionEvaluatorAdapter,
  predictionEvaluationSpecMeasurements,
  predictionEvaluationSpecVerdictRule,
  type PredictionEvaluationInputs,
  type ResolutionSnapshotSource,
} from "./adapter.js";

const encoder = new TextEncoder();

const ATTEMPT: AttemptIdentity = {
  attemptUri: "urn:uuid:22222222-2222-4222-8222-222222222222" as AttemptIdentity["attemptUri"],
  nonce: "evaluation-nonce",
  attemptNumber: 1,
};

function material(name: string, bytes: Uint8Array): ExactEvaluationMaterial {
  return { descriptor: { name, digest: { sha256: "1".repeat(64) } }, bytes };
}

function specification(): EvaluationSpec {
  return {
    protocol: EVALUATION_SPEC_FORMAT_URI,
    semanticsVersion: EVAL_SEMANTICS_VERSION,
    family: "deterministic-process",
    grader: {
      name: PREDICTION_PARSER.id,
      digest: { sha256: PREDICTION_PARSER.digest.slice("sha256:".length) },
      accessClass: "public",
    },
    familyBlock: {
      image: { name: "scorer-image", digest: { sha256: "3".repeat(64) } },
      platform: "linux/amd64",
      workspace: {},
      testMaterial: [],
      parser: PREDICTION_PARSER,
      transitions: { failToPass: [], passToPass: [] },
      timeout: 300,
    },
    measurements: predictionEvaluationSpecMeasurements(),
    verdictRule: predictionEvaluationSpecVerdictRule(),
    unscorable: [
      { name: "market-unresolved", disposition: "recorded-inconclusive" },
      { name: "venue-unavailable", disposition: "retryable-infrastructure" },
    ],
    evidenceConventions: { requiredRefs: [] },
  } as EvaluationSpec;
}

function source(inputs: PredictionEvaluationInputs): ResolutionSnapshotSource {
  return { async read() { return inputs; } };
}

describe("createPredictionEvaluatorAdapter", () => {
  test.each(PREDICTION_FIXTURES.map((fixture) => [fixture.name, fixture] as const))(
    "%s maps to the harness verdict shape and stays verdict-consistent",
    async (_name, fixture) => {
      const adapter = createPredictionEvaluatorAdapter({
        resolutionSnapshotSource: source({
          snapshot: fixture.snapshot,
          market: fixture.market,
          window: fixture.window,
          consensusProbabilityYes: fixture.consensusProbabilityYes,
        }),
        now: () => new Date("2026-07-30T09:00:00.000Z"),
      });
      const spec = specification();
      const completed = await adapter.evaluate(
        material("subject-task.json", encoder.encode("{}")),
        [material("result.json", fixture.resultBytes)],
        spec,
        {},
        ATTEMPT,
        new AbortController().signal,
      );

      expect(completed.verdict).toBe(fixture.expect.verdict);
      expect(completed.evaluatedAt).toBe("2026-07-30T09:00:00.000Z");

      const measurements: MeasurementMap = {};
      for (const measurement of completed.measurements ?? []) {
        measurements[measurement.name] = measurement.value as string | number | boolean;
      }
      expect(checkMeasurementCoverage(spec, measurements).ok).toBe(true);
      expect(checkVerdictConsistency({
        spec,
        delivered: { verdict: completed.verdict },
        measurements,
      })).toEqual({ ok: true });
    },
  );

  test("every delivered measurement is declared by the specification", async () => {
    const spec = specification();
    const declared = new Set(spec.measurements.map((entry) => entry.name));
    for (const fixture of PREDICTION_FIXTURES) {
      const adapter = createPredictionEvaluatorAdapter({
        resolutionSnapshotSource: source({
          snapshot: fixture.snapshot,
          market: fixture.market,
          window: fixture.window,
          consensusProbabilityYes: fixture.consensusProbabilityYes,
        }),
      });
      const completed = await adapter.evaluate(
        material("subject-task.json", encoder.encode("{}")),
        [material("result.json", fixture.resultBytes)],
        spec,
        {},
        ATTEMPT,
        new AbortController().signal,
      );
      for (const measurement of completed.measurements ?? []) {
        expect(declared).toContain(measurement.name);
      }
    }
  });

  test("exactly one Result subject is required", async () => {
    const adapter = createPredictionEvaluatorAdapter({
      resolutionSnapshotSource: source({
        snapshot: PREDICTION_FIXTURES[0]!.snapshot,
        market: PREDICTION_FIXTURES[0]!.market,
        window: PREDICTION_FIXTURES[0]!.window,
        consensusProbabilityYes: "0.500000",
      }),
    });
    const error = await adapter.evaluate(
      material("subject-task.json", encoder.encode("{}")),
      [],
      specification(),
      {},
      ATTEMPT,
      new AbortController().signal,
    ).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(EvaluationOperationalError);
    expect((error as EvaluationOperationalError).reason).toBe("subject-not-found");
  });
});

describe("contextResolutionSnapshotSource", () => {
  test("reads the snapshot and market frame from the evaluation context", async () => {
    const inputs = await contextResolutionSnapshotSource().read({
      specification: specification(),
      task: material("subject-task.json", encoder.encode("{}")),
      results: [],
      context: {
        resolutionSnapshot: { status: "unresolved", marketId: "m", conditionId: "c" },
        market: { marketId: "m", conditionId: "c" },
        window: { startTs: 1, endTs: 2 },
        consensusProbabilityYes: "0.500000",
      },
      attempt: ATTEMPT,
      deadlineSignal: new AbortController().signal,
    });
    expect(inputs.consensusProbabilityYes).toBe("0.500000");
    expect(inputs.window).toEqual({ startTs: 1, endTs: 2 });
  });

  test("a context missing the snapshot is an operational failure, not a fail verdict", async () => {
    const error = await contextResolutionSnapshotSource().read({
      specification: specification(),
      task: material("subject-task.json", encoder.encode("{}")),
      results: [],
      context: {},
      attempt: ATTEMPT,
      deadlineSignal: new AbortController().signal,
    }).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(EvaluationOperationalError);
    expect((error as EvaluationOperationalError).reason).toBe("provider-unavailable");
  });
});
