import { describe, expect, test } from "vitest";
import {
  INSPECT_SELECTION_SCHEMA,
  InspectSelectionManifestSchema,
  SUPPORTED_INSPECT_VERSION,
  SUPPORTED_INSPECT_WHEEL_SHA256,
  assertNoSecretLikeConfiguration,
} from "./manifest.js";

const manifest = {
  schema: INSPECT_SELECTION_SCHEMA,
  runtime: {
    adapterVersion: "1",
    workerSha256: "c".repeat(64),
    inspectVersion: SUPPORTED_INSPECT_VERSION,
    inspectWheelSha256: SUPPORTED_INSPECT_WHEEL_SHA256,
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
    dataset: { name: "hermetic", location: null, samples: 2 },
  },
  arms: [
    { armId: "control", model: "mockllm/control" },
    { armId: "candidate", model: "mockllm/candidate" },
  ],
  scorer: { name: "match", passValue: "C", definition: { name: "match", options: {}, metrics: [] } },
  runOptions: { maxSamples: 1 },
};

describe("InspectSelectionManifestSchema", () => {
  test("pins runtime, source, task, arms, scorer, and material options", () => {
    expect(InspectSelectionManifestSchema.parse(manifest)).toEqual(manifest);
  });

  test("epochs cannot be configured because benchmark repetitions own that axis", () => {
    expect(InspectSelectionManifestSchema.safeParse({
      ...manifest,
      runOptions: { epochs: 2 },
    }).success).toBe(false);
  });

  test("sandbox configuration cannot be silently accepted before it can be pinned", () => {
    expect(InspectSelectionManifestSchema.safeParse({
      ...manifest,
      runOptions: { sandbox: "docker" },
    }).success).toBe(false);
  });

  test("secret-like configuration is refused before sealing", () => {
    expect(() => assertNoSecretLikeConfiguration({ modelArgs: { api_key: "never-seal-me" } }))
      .toThrow(/credential-bearing/u);
    expect(() => assertNoSecretLikeConfiguration({ modelArgs: { opaque: `sk-${"a".repeat(24)}` } }))
      .toThrow(/credential-shaped/u);
    expect(() => assertNoSecretLikeConfiguration({ taskArgs: { material: `-----BEGIN ${"PRIVATE KEY"}-----` } }))
      .toThrow(/credential-shaped/u);
  });
});
