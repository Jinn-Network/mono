import assert from "node:assert/strict";
import test from "node:test";
import { VERDICT_DSSE_PAYLOAD_TYPE } from "@jinn-network/task-execution-profiles";
import {
  InspectCellSummaryV2Schema,
  projectInspectCellVerdict,
} from "../dist/profile/artifacts.js";
import { describeInspectRuntimeMethod } from "../dist/profile/inspect-disclosure.js";
import {
  INSPECT_MULTI_SCORER_SELECTION_SCHEMA,
  InspectSelectionManifestSchema,
} from "../dist/profile/inspect-manifest.js";
import { readOrderedVerdictMeasurements } from "../dist/profile/verdict.js";

const projections = [
  { measurementName: "correct", scorerName: "correctness", passValue: "C" },
  { measurementName: "safe", scorerName: "policy", subScoreKey: "safe", passValue: true },
];

function manifest() {
  return InspectSelectionManifestSchema.parse({
    schema: INSPECT_MULTI_SCORER_SELECTION_SCHEMA,
    runtime: {
      adapterVersion: "1",
      workerSha256: "c".repeat(64),
      inspectVersion: "0.3.255",
      inspectWheelSha256: "958e773a8d0cc8873314e3f96d1143cbb4e0b9e4bacc2cbec6b4d5576ceecf2c",
      pythonVersion: "3.11.9",
      pythonExecutableSha256: "a".repeat(64),
      pythonEnvironmentSha256: "d".repeat(64),
      inspectDistributionSha256: "e".repeat(64),
    },
    task: {
      reference: "eval.py@hermetic",
      args: {},
      resolvedName: "hermetic",
      resolvedVersion: "1.0",
      resolvedSandbox: null,
      source: {
        kind: "project-file",
        path: "eval.py",
        sha256: "b".repeat(64),
        projectTreeSha256: "f".repeat(64),
      },
      dataset: { name: "hermetic", location: null, samples: 1 },
    },
    arms: [
      { armId: "control", model: "mockllm/control" },
      { armId: "candidate", model: "mockllm/candidate" },
    ],
    scorers: [
      { name: "correctness", definition: {} },
      { name: "policy", definition: {} },
    ],
    scoring: {
      projections,
      verdictRule: {
        all: projections.map(({ measurementName }) => ({
          threshold: { measurement: measurementName, op: "eq", value: true },
        })),
      },
      inspectMetrics: [{ name: "accuracy", options: null }],
      inspectEpochReducers: ["mean"],
    },
    runOptions: { maxSamples: 1 },
  });
}

function summary(correct = true, safe = true) {
  return InspectCellSummaryV2Schema.parse({
    schema: "jinn.network/benchmark-product/inspect-cell-summary/2",
    terminal: "scored",
    inspectStatus: "success",
    expectedSamples: 1,
    observedSamples: 1,
    erroredSamples: 0,
    invalidated: false,
    scorers: [
      { name: "correctness", presentSamples: 1, missingSamples: 0, valueShapes: ["string"] },
      { name: "policy", presentSamples: 1, missingSamples: 0, valueShapes: ["object"] },
    ],
    measurements: [
      { measurementName: "correct", scorerName: "correctness", missingSamples: 0, invalidValueSamples: 0, value: correct },
      { measurementName: "safe", scorerName: "policy", subScoreKey: "safe", missingSamples: 0, invalidValueSamples: 0, value: safe },
    ],
    verdict: correct && safe ? "pass" : "fail",
    evaluatedAt: "2026-08-13T12:00:00.000Z",
    nativeLogSha256: "a".repeat(64),
    nativeLogBytes: 1,
  });
}

function envelope(measurements) {
  const payload = {
    predicate: {
      evaluator: { id: "urn:test:evaluator" },
      verdict: "pass",
      evaluationSpecification: { digest: { sha256: "1".repeat(64) } },
      measurements,
      evaluatedAt: "2026-08-13T12:00:00.000Z",
    },
  };
  return new TextEncoder().encode(JSON.stringify({
    payloadType: VERDICT_DSSE_PAYLOAD_TYPE,
    payload: Buffer.from(JSON.stringify(payload)).toString("base64"),
    signatures: [{ keyid: "test", sig: Buffer.from([1]).toString("base64") }],
  }));
}

test("reader validates ordered multi-scorer projections and derives the sealed verdict", () => {
  const sealed = manifest();
  assert.equal(projectInspectCellVerdict(summary(true, true), sealed), "pass");
  assert.equal(projectInspectCellVerdict(summary(true, false), sealed), "fail");

  const reordered = summary();
  reordered.measurements.reverse();
  assert.throws(() => projectInspectCellVerdict(reordered, sealed), /sealed projection/u);

  const disclosure = describeInspectRuntimeMethod(sealed, "9".repeat(64));
  assert.deepEqual(disclosure.scorerNames, ["correctness", "policy"]);
  assert.deepEqual(disclosure.projections, projections);
  assert.equal(disclosure.verdictRuleText, "all(correct eq true, safe eq true)");
  assert.deepEqual(disclosure.nativeAnalysis, {
    metrics: [{ name: "accuracy", options: null }],
    epochReducers: ["mean"],
  });
});
test("reader preserves verdict measurement order and refuses duplicate names", () => {
  assert.deepEqual(readOrderedVerdictMeasurements(envelope([
    { name: "correct", value: true },
    { name: "safe", value: false },
  ])), [
    { name: "correct", value: true },
    { name: "safe", value: false },
  ]);
  assert.throws(() => readOrderedVerdictMeasurements(envelope([
    { name: "correct", value: true },
    { name: "correct", value: false },
  ])), /duplicate measurement names/u);
});

test("summary v2 accepts every provider terminal variant as evidence, including no-call", () => {
  const statuses = [
    "completed",
    "authentication-failure",
    "rate-limited",
    "timeout",
    "broker-loss",
    "provider-5xx",
    "provider-failure",
    "budget-rejected",
    "method-conflict",
    "capability-rejected",
    "malformed-request",
    "no-call",
  ];
  for (const terminalStatus of statuses) {
    assert.equal(InspectCellSummaryV2Schema.safeParse({
      ...summary(),
      provider: {
        surface: "openai-responses",
        resolvedModel: terminalStatus === "completed" ? "gpt-5.6-luna" : null,
        callCount: terminalStatus === "no-call" ? 0 : 1,
        usage: null,
        terminalStatus,
        eventDigest: null,
        brokerProtocol: "jinn.network/model-broker/1",
        brokerSourceSha256: "2".repeat(64),
      },
    }).success, true, terminalStatus);
  }
});
