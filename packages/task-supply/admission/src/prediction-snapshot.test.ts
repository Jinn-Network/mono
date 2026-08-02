import { describe, expect, it } from "vitest";
import { canonicalJsonBytes } from "@jinn-network/trust-core";
import {
  PREDICTION_SNAPSHOT_ADMISSION_POLICY_V1,
  admitPredictionSnapshot,
} from "./prediction-snapshot.js";

const seal = (value: unknown) => canonicalJsonBytes(value);
const task = seal({
  protocol: "https://jinn.network/profiles/task-execution/1.0",
  profile: {
    uri: "https://jinn.network/task-profiles/prediction-forecast/1.0",
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
  outputs: [{ name: "prediction", mediaType: "application/json", required: true }],
});

const evaluationSpec = seal({
  protocol: "https://jinn.network/profiles/evaluation-spec/1.0",
  semanticsVersion: "4",
  family: "deterministic-process",
  grader: { name: "public-grader", digest: { sha256: "b".repeat(64) } },
  familyBlock: {
    image: { name: "prediction-image", digest: { sha256: "c".repeat(64) } },
    platform: "linux/amd64",
    workspace: {},
    testMaterial: [],
    parser: { id: "network.jinn.parser.prediction-market", version: "1", digest: `sha256:${"d".repeat(64)}` },
    transitions: { failToPass: ["prediction-valid"], passToPass: [] },
    timeout: 60,
  },
  measurements: [],
  verdictRule: { all: [] },
  unscorable: [],
  evidenceConventions: { requiredRefs: [] },
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
      profile: { ...original.profile, uri: "https://jinn.network/task-profiles/repository-work/1.0" },
    });
    expect(() => admitPredictionSnapshot({ taskBytes: legacyTask, evaluationSpecBytes: evaluationSpec, issuer: "did:jinn:admitter" }))
      .toThrow("prediction-forecast/1.0");
  });
});
