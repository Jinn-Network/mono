import { describe, expect, it } from "vitest";
import { canonicalJsonBytes, recordDigest } from "@jinn-network/trust-core";
import {
  PREDICTION_SNAPSHOT_ADMISSION_POLICY_V1,
  admitPredictionSnapshot,
} from "./prediction-snapshot.js";

const seal = (value: unknown) => canonicalJsonBytes(value);
const taskDocument = {
  protocol: "https://spec.jinn.network/profiles/task-execution/v1",
  profile: {
    uri: "https://spec.jinn.network/task-profiles/prediction-forecast/1.0",
    digest: { sha256: "e61dc765d1a93b71639cb566d6bd3ca1335cfd53cb415e904ff840670d212937" },
  },
  instructions: "Forecast the named market.",
  payload: {
    forecast: {
      marketId: "will-jinn-ship",
      question: "Will Jinn ship?",
      consensusProbabilityYes: "0.750000",
      observedAt: "2026-08-02T00:00:00Z",
      resolvesAt: "2026-08-03T00:00:00Z",
    },
  },
  outputs: [{ name: "prediction", mediaType: "application/json", required: true, schema: {
    type: "object", additionalProperties: false,
    properties: { probabilityYes: { type: "string", pattern: "^(0(\\.\\d+)?|1(\\.0+)?)$" }, submittedAt: { type: "string", format: "date-time" } },
    required: ["probabilityYes", "submittedAt"],
  } }],
};

const evaluationSpec = seal({
  protocol: "https://spec.jinn.network/profiles/evaluation-spec/v1",
  semanticsVersion: "4",
  family: "deterministic-process",
  grader: { name: "public-grader", digest: { sha256: "b".repeat(64) }, accessClass: "public" },
  familyBlock: {
    image: { name: "prediction-image", digest: { sha256: "c".repeat(64) }, accessClass: "public" },
    platform: "linux/amd64",
    workspace: {},
    testMaterial: [],
    parser: { id: "network.jinn.parser.prediction-market", version: "1.0.0", digest: "sha256:fdf33b359e1d142a372b374abddab4e582fd4cbff5a32e53de9333a5515c2d1a" },
    transitions: { failToPass: ["prediction-valid"], passToPass: [] },
    timeout: 60,
  },
  measurements: [
    { name: "integrity", type: "boolean", required: true },
    { name: "resolved", type: "boolean", required: true },
    { name: "outcomeYes", type: "boolean", required: false },
    { name: "solverBrier", type: "string", direction: "lower-better", required: false },
    { name: "consensusBrier", type: "string", required: false },
    { name: "brierSpread", type: "string", direction: "lower-better", required: false },
  ],
  verdictRule: { all: [{ threshold: { measurement: "integrity", op: "eq", value: true } }, { inconclusiveWhen: { threshold: { measurement: "resolved", op: "eq", value: false } }, class: "market-unresolved" }] },
  unscorable: [{ name: "market-unresolved", disposition: "recorded-inconclusive" }],
  evidenceConventions: { requiredRefs: [] },
});

const task = seal({
  ...taskDocument,
  evaluation: { name: "evaluation-spec.json", digest: { sha256: recordDigest(evaluationSpec).slice("sha256:".length) } },
});

describe("prediction-snapshot-admission/1", () => {
  it("admits the exact native profile/spec pair into a deterministic receipt body", () => {
    const first = admitPredictionSnapshot({ taskBytes: task, evaluationSpecBytes: evaluationSpec, issuer: "did:jinn:admitter" });
    const second = admitPredictionSnapshot({ taskBytes: task, evaluationSpecBytes: evaluationSpec, issuer: "did:jinn:admitter" });

    expect(first.admissionPolicyVersion).toBe(PREDICTION_SNAPSHOT_ADMISSION_POLICY_V1.admissionPolicyVersion);
    expect(first.task.documentDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(first.task.evaluationSpecDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(second).toStrictEqual(first);
  });

  it("rejects a forecast outside the closed probability range", () => {
    const invalidTask = seal({
      ...JSON.parse(new TextDecoder().decode(task)),
      payload: {
        forecast: {
          ...JSON.parse(new TextDecoder().decode(task)).payload.forecast,
          consensusProbabilityYes: "1.000001",
        },
      },
    });
    expect(() => admitPredictionSnapshot({ taskBytes: invalidTask, evaluationSpecBytes: evaluationSpec, issuer: "did:jinn:admitter" }))
      .toThrow("consensusProbabilityYes");
  });

  it("rejects a Task whose native profile does not declare exactly one prediction output", () => {
    const original = JSON.parse(new TextDecoder().decode(task));
    const invalidTask = seal({
      ...original,
      outputs: [...original.outputs, { name: "summary", mediaType: "text/plain", required: false }],
    });
    expect(() => admitPredictionSnapshot({ taskBytes: invalidTask, evaluationSpecBytes: evaluationSpec, issuer: "did:jinn:admitter" }))
      .toThrow("exactly one prediction output");
  });

  it("rejects the legacy repository-work profile even when its forecast payload is valid", () => {
    const original = JSON.parse(new TextDecoder().decode(task));
    const legacyTask = seal({
      ...original,
      profile: { ...original.profile, uri: "https://spec.jinn.network/task-profiles/repository-work/1.0" },
    });
    expect(() => admitPredictionSnapshot({ taskBytes: legacyTask, evaluationSpecBytes: evaluationSpec, issuer: "did:jinn:admitter" }))
      .toThrow("prediction-forecast/1.0");
  });

  it("rejects a Task that does not bind the supplied exact EvaluationSpec", () => {
    const original = JSON.parse(new TextDecoder().decode(task));
    const mismatched = seal({
      ...original,
      evaluation: { name: "evaluation-spec.json", digest: { sha256: "e".repeat(64) } },
    });
    expect(() => admitPredictionSnapshot({ taskBytes: mismatched, evaluationSpecBytes: evaluationSpec, issuer: "did:jinn:admitter" }))
      .toThrow("exact supplied EvaluationSpec");
  });

  it("rejects an under-specified deterministic evaluator contract", () => {
    const weakSpec = seal({ ...JSON.parse(new TextDecoder().decode(evaluationSpec)), familyBlock: {} });
    expect(() => admitPredictionSnapshot({ taskBytes: task, evaluationSpecBytes: weakSpec, issuer: "did:jinn:admitter" }))
      .toThrow("compatible prediction evaluator");
  });

  it("rejects a payload with any root property other than forecast", () => {
    const original = JSON.parse(new TextDecoder().decode(task));
    const invalidTask = seal({ ...original, payload: { ...original.payload, injected: true } });
    expect(() => admitPredictionSnapshot({ taskBytes: invalidTask, evaluationSpecBytes: evaluationSpec, issuer: "did:jinn:admitter" }))
      .toThrow("payload must have only forecast");
  });

  it("rejects a private or semantically altered deterministic evaluator", () => {
    const original = JSON.parse(new TextDecoder().decode(evaluationSpec));
    const privateSpec = seal({ ...original, grader: { ...original.grader, accessClass: "private" } });
    const alteredRule = seal({ ...original, verdictRule: { threshold: { measurement: "integrity", op: "eq", value: true } } });
    for (const candidate of [privateSpec, alteredRule]) {
      expect(() => admitPredictionSnapshot({ taskBytes: task, evaluationSpecBytes: candidate, issuer: "did:jinn:admitter" }))
        .toThrow("compatible prediction evaluator");
    }
  });
});
