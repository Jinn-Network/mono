import { describe, expect, test } from "vitest";
import {
  INSPECT_SELECTION_SCHEMA,
  INSPECT_SANDBOX_SELECTION_SCHEMA,
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

  test("pins one exact sample separately from maxSamples concurrency", () => {
    expect(InspectSelectionManifestSchema.parse({
      ...manifest,
      task: {
        ...manifest.task,
        dataset: {
          ...manifest.task.dataset,
          selectedSampleId: "Mercury_417466",
          orderedSampleSha256: "1".repeat(64),
        },
      },
      runOptions: { sampleId: "Mercury_417466", maxSamples: 1 },
    }).runOptions).toEqual({ sampleId: "Mercury_417466", maxSamples: 1 });
  });

  test("pins the complete OCI worker and isolation identity", () => {
    const result = InspectSelectionManifestSchema.safeParse({
      ...manifest,
      runtime: {
        ...manifest.runtime,
        pythonVersion: "3.11.9",
        execution: {
          kind: "oci",
          imageDigest: `sha256:${"2".repeat(64)}`,
          platform: "linux/amd64",
          inspectEvalsVersion: "0.16.0",
          openaiSdkVersion: "2.53.0",
          workerSourceSha256: manifest.runtime.workerSha256,
          runtimeHostSourceSha256: "6".repeat(64),
          brokerSourceSha256: "7".repeat(64),
          modelProviderSourceSha256: "8".repeat(64),
          dockerExecutableSha256: "5".repeat(64),
          dockerEngineVersion: "28.5.1",
          dockerApiVersion: "1.51",
          datasetCacheSha256: "3".repeat(64),
          isolation: {
            readOnlyRoot: true,
            network: "none",
            capabilities: [],
            noNewPrivileges: true,
            cpuCount: 1,
            memoryBytes: 1_073_741_824,
            pidsLimit: 64,
            scratchBytes: 536_870_912,
            user: "501:20",
            mounts: ["project:ro", "dataset-cache:ro", "attempt-input:ro", "attempt-output:rw"],
          },
        },
      },
      task: {
        ...manifest.task,
        dataset: {
          ...manifest.task.dataset,
          selectedSampleId: "Mercury_417466",
          orderedSampleSha256: "4".repeat(64),
        },
      },
      runOptions: { sampleId: "Mercury_417466", maxSamples: 1 },
    });
    expect(result.success).toBe(true);
  });

  test("versions and binds the declared and effective hosted sandbox", () => {
    const policy = {
      provider: "jinn-oci",
      platform: "linux/amd64",
      user: "65532:65532",
      readOnlyRoot: true,
      network: "none",
      capabilities: [],
      noNewPrivileges: true,
      cpuCount: 1,
      memoryBytes: 536_870_912,
      pidsLimit: 32,
      scratchBytes: 268_435_456,
      maxEnvironments: 1,
      maxOperations: 64,
      commandTimeoutSeconds: 30,
      totalTimeoutSeconds: 120,
      maxInputBytes: 16 * 1024 * 1024,
      maxOutputBytes: 20 * 1024 * 1024,
      maxReadFileBytes: 100 * 1024 * 1024,
    } as const;
    const sandbox = {
      protocol: "jinn.network/inspect-sandbox-host/1",
      provider: "jinn-oci",
      packageVersion: "0.1.0",
      providerSourceSha256: "8".repeat(64),
      controllerSourceSha256: "9".repeat(64),
      imageDigest: `sha256:${"a".repeat(64)}`,
      platform: "linux/amd64",
      policySha256: "b".repeat(64),
      policy,
    } as const;
    const runtimeExecution = {
      kind: "oci",
      imageDigest: `sha256:${"2".repeat(64)}`,
      platform: "linux/amd64",
      inspectEvalsVersion: "0.16.0",
      openaiSdkVersion: "2.53.0",
      workerSourceSha256: manifest.runtime.workerSha256,
      runtimeHostSourceSha256: "6".repeat(64),
      brokerSourceSha256: "7".repeat(64),
      modelProviderSourceSha256: "8".repeat(64),
      dockerExecutableSha256: "5".repeat(64),
      dockerEngineVersion: "28.5.1",
      dockerApiVersion: "1.51",
      datasetCacheSha256: "3".repeat(64),
      isolation: {
        readOnlyRoot: true,
        network: "none",
        capabilities: [],
        noNewPrivileges: true,
        cpuCount: 1,
        memoryBytes: 1_073_741_824,
        pidsLimit: 64,
        scratchBytes: 536_870_912,
        user: "501:20",
        mounts: ["project:ro", "dataset-cache:ro", "attempt-input:ro", "attempt-output:rw"],
      },
      sandbox,
    } as const;
    const sandboxManifest = {
      ...manifest,
      schema: INSPECT_SANDBOX_SELECTION_SCHEMA,
      runtime: { ...manifest.runtime, pythonVersion: "3.11.9", execution: runtimeExecution },
      task: {
        ...manifest.task,
        declaredSandbox: { type: "docker", config: null },
        resolvedSandbox: {
          type: "jinn-oci",
          config: {
            schema: "jinn.network/benchmark-product/inspect-sandbox/1",
            imageDigest: sandbox.imageDigest,
            platform: sandbox.platform,
            policySha256: sandbox.policySha256,
          },
        },
        dataset: {
          ...manifest.task.dataset,
          selectedSampleId: "alpha",
          orderedSampleSha256: "4".repeat(64),
        },
      },
      runOptions: { sampleId: "alpha", maxSamples: 1 },
    };
    expect(InspectSelectionManifestSchema.safeParse(sandboxManifest).success).toBe(true);
    expect(InspectSelectionManifestSchema.safeParse({ ...sandboxManifest, schema: INSPECT_SELECTION_SCHEMA }).success).toBe(false);
    expect(InspectSelectionManifestSchema.safeParse({
      ...sandboxManifest,
      task: { ...sandboxManifest.task, resolvedSandbox: null },
    }).success).toBe(false);
  });

  test("accepts only the sealed Luna Responses profile on a broker-only OCI runtime", () => {
    const provider = {
      surface: "openai-responses",
      upstreamModel: "gpt-5.6-luna",
      reasoningEffort: "none",
      maxOutputTokens: 128,
      store: false,
      background: false,
      stream: false,
      serviceTier: "default",
      tools: [],
      fallbackModels: [],
      retries: 0,
      persistedConversation: false,
      metadata: null,
      promptCacheIdentifier: null,
    } as const;
    const providerManifest = {
      ...manifest,
      runtime: {
        ...manifest.runtime,
        execution: {
          kind: "oci",
          imageDigest: `sha256:${"2".repeat(64)}`,
          platform: "linux/amd64",
          inspectEvalsVersion: "0.16.0",
          openaiSdkVersion: "2.53.0",
          workerSourceSha256: manifest.runtime.workerSha256,
          runtimeHostSourceSha256: "6".repeat(64),
          brokerSourceSha256: "7".repeat(64),
          modelProviderSourceSha256: "8".repeat(64),
          dockerExecutableSha256: "5".repeat(64),
          dockerEngineVersion: "28.5.1",
          dockerApiVersion: "1.51",
          datasetCacheSha256: "3".repeat(64),
          isolation: {
            readOnlyRoot: true,
            network: "broker-only",
            capabilities: [],
            noNewPrivileges: true,
            cpuCount: 1,
            memoryBytes: 1_073_741_824,
            pidsLimit: 64,
            scratchBytes: 536_870_912,
            user: "501:20",
            mounts: ["project:ro", "dataset-cache:ro", "attempt-input:ro", "attempt-output:rw", "broker-capability:ro"],
          },
          broker: {
            protocol: "jinn.network/model-broker/1",
            requestEndpoint: "https://api.openai.com/v1/responses",
            network: "bridge-plus-private-internal",
            secretMount: "credential-volume:/run/secrets:ro",
            capabilityMount: "capability-volume:/run/jinn:ro",
            readOnlyRoot: true,
            capabilities: [],
            noNewPrivileges: true,
            cpuCount: 1,
            memoryBytes: 268_435_456,
            pidsLimit: 32,
            scratchBytes: 67_108_864,
          },
        },
      },
      task: {
        ...manifest.task,
        dataset: { ...manifest.task.dataset, selectedSampleId: "alpha", orderedSampleSha256: "4".repeat(64) },
      },
      arms: [
        { armId: "luna-none", model: "jinn-openai/gpt-5.6-luna", provider },
        { armId: "luna-low", model: "jinn-openai/gpt-5.6-luna", provider: { ...provider, reasoningEffort: "low" } },
      ],
      runOptions: { sampleId: "alpha", maxSamples: 1, retryOnError: 0 },
    };
    expect(InspectSelectionManifestSchema.safeParse(providerManifest).success).toBe(true);
    expect(InspectSelectionManifestSchema.safeParse({
      ...providerManifest,
      runtime: manifest.runtime,
    }).success).toBe(false);
    expect(InspectSelectionManifestSchema.safeParse({
      ...providerManifest,
      arms: [
        ...providerManifest.arms.slice(0, 1),
        { ...providerManifest.arms[1], provider: { ...providerManifest.arms[1]!.provider, maxOutputTokens: 256 } },
      ],
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
