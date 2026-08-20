import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import type { AttemptIdentity } from "@jinn-network/task-execution-supervisor";
import type { TaskView, WorkspacePaths } from "@jinn-network/task-execution-workspace";
import {
  BINARY_JUDGMENT_INSPECT_LOG_MEDIA_TYPE,
  BINARY_JUDGMENT_INSTRUMENT_REQUIREMENT_KEY,
  BINARY_JUDGMENT_OBSERVATION_MEDIA_TYPE,
  BINARY_JUDGMENT_PROFILE_DIGEST,
  BINARY_JUDGMENT_PROFILE_URI,
  BINARY_JUDGMENT_RESPONSE_MEDIA_TYPE,
  buildBinaryJudgmentProfile,
  sealBinaryJudgmentInstrument,
  type BinaryJudgmentInstrument,
  type BinaryJudgmentPayload,
  type BinaryJudgmentReasoningGeneration,
  type BinaryJudgmentSamplingGeneration,
} from "@jinn-network/task-execution-profiles";
import { sealTask, TaskSpecificationSchema } from "@jinn-network/task-execution-protocol";
import { canonicalJsonBytes, recordDigest } from "@jinn-network/trust-core";
import { describe, expect, test } from "vitest";
import {
  INSPECT_BINARY_JUDGE_LAUNCHER_ID,
  INSPECT_BINARY_JUDGE_LAUNCHER_VERSION,
  INSPECT_BINARY_JUDGE_SELECTION_SCHEMA,
  InspectBinaryJudgeSelectionManifestSchema,
  type InspectBinaryJudgeHostBinding,
  type InspectBinaryJudgeSelectionManifest,
} from "./binary-judge-manifest.js";
import {
  INSPECT_BINARY_JUDGE_CONFIG_FILENAME,
  INSPECT_BINARY_JUDGE_OCI_CONFIG_PATH,
  INSPECT_BINARY_JUDGE_OCI_OUTPUT_DIR,
  INSPECT_BINARY_JUDGE_OUTPUT_FILES,
  buildInspectBinaryJudgeOciRunArgs,
  buildInspectBinaryJudgeWorkerInput,
  inspectBinaryJudgeWorkerPath,
  inspectBinaryJudgeWorkerSha256,
  makeInspectBinaryJudgeLauncher,
  validateInspectBinaryJudgePinning,
} from "./binary-judge.js";
import { inspectOciRunnerPath } from "./oci.js";
import { inspectOciRunnerSha256 } from "./oci.js";

const fixture = JSON.parse(readFileSync(new URL(
  "../../../../../task-execution/profiles/fixtures/binary-judgment-request/golden/unicode-line-endings.json",
  import.meta.url,
), "utf8")) as {
  input: { payload: BinaryJudgmentPayload; instrument: BinaryJudgmentInstrument };
  expect: { semanticRequest: unknown; semanticRequestSha256: `sha256:${string}` };
};

// This F0 golden fixture is a reasoning-model instrument (spec §1.1), but its
// `model.generation` is now typed as the profile union (reasoning | dated-snapshot-sampling).
// Narrow it once, here, rather than casting at each use site: the runtime check makes the
// narrowing sound, and `generation.reasoningEffort` below is then a compile-time fact, not an
// assumption.
const rawGeneration = fixture.input.instrument.model.generation;
if (!("reasoningEffort" in rawGeneration)) {
  throw new Error("binary-judge.test fixture must use the reasoning-2026-08 generation variant");
}
const generation: BinaryJudgmentReasoningGeneration = rawGeneration;
const alphaInstrument = { ...fixture.input.instrument, instrumentId: "alpha" };
const betaInstrument = { ...fixture.input.instrument, instrumentId: "beta" };
const sealedAlpha = sealBinaryJudgmentInstrument(alphaInstrument);
const sealedBeta = sealBinaryJudgmentInstrument(betaInstrument);

const manifest: InspectBinaryJudgeSelectionManifest = {
  schema: INSPECT_BINARY_JUDGE_SELECTION_SCHEMA,
  runtime: {
    imageDigest: `sha256:${"a".repeat(64)}`,
    platform: "linux/amd64",
    pythonVersion: "3.11.9",
    inspectVersion: "0.3.255",
    inspectEvalsVersion: "0.16.0",
    openaiSdkVersion: "2.53.0",
    runtimeHostSourceSha256: inspectOciRunnerSha256(),
    workerSourceSha256: inspectBinaryJudgeWorkerSha256(),
    brokerSourceSha256: "b".repeat(64),
    modelProviderSourceSha256: "c".repeat(64),
  },
  execution: {
    callsPerCell: 1,
    epochs: 1,
    inspectScorer: false,
    retries: 0,
    fallbacks: 0,
    tools: [],
    storage: false,
  },
  requirement: {
    key: BINARY_JUDGMENT_INSTRUMENT_REQUIREMENT_KEY,
    valueShape: "sha256:<64-lowercase-hex>",
    comparison: "exact",
    location: "submission-effective-requirements",
  },
  arms: [
    { armId: "alpha", instrumentSha256: sealedAlpha.digest, model: "gpt-5.6-luna", generation },
    { armId: "beta", instrumentSha256: sealedBeta.digest, model: "gpt-5.6-luna", generation },
  ],
};

const host: InspectBinaryJudgeHostBinding = {
  kind: "oci",
  dockerPath: "/usr/local/bin/docker",
  imageDigest: manifest.runtime.imageDigest,
  platform: "linux/amd64",
  user: "65532:65532",
};

const taskBytes = sealTask({
  protocol: "https://spec.jinn.network/profiles/task-execution/v1",
  profile: {
    uri: BINARY_JUDGMENT_PROFILE_URI,
    digest: { sha256: BINARY_JUDGMENT_PROFILE_DIGEST.slice("sha256:".length) },
  },
  instructions: "Return one binary judgment.",
  payload: fixture.input.payload,
  outputs: [
    { name: "judge-response", mediaType: BINARY_JUDGMENT_RESPONSE_MEDIA_TYPE, required: true },
    { name: "judge-observation", mediaType: BINARY_JUDGMENT_OBSERVATION_MEDIA_TYPE, required: true },
    { name: "inspect-log", mediaType: BINARY_JUDGMENT_INSPECT_LOG_MEDIA_TYPE, required: false },
  ],
});
const task = TaskSpecificationSchema.parse(JSON.parse(new TextDecoder().decode(taskBytes)));

function taskView(overrides: Record<string, unknown> = {}): TaskView {
  return {
    task,
    profile: buildBinaryJudgmentProfile(),
    effectiveRequirements: {
      harness: { id: INSPECT_BINARY_JUDGE_LAUNCHER_ID, version: INSPECT_BINARY_JUDGE_LAUNCHER_VERSION },
      model: { id: "gpt-5.6-luna" },
      isolationPolicy: "oci-container",
      [BINARY_JUDGMENT_INSTRUMENT_REQUIREMENT_KEY]: sealedAlpha.digest,
      ...overrides,
    },
  };
}

// Dated-snapshot-sampling fixtures (spec §1.1/§1.3), for the P1 tests below proving arm
// resolution and the run-pinning inventory are derived from the sealed selection rather than
// hardcoded to the reasoning model.
function datedSnapshotGeneration(): BinaryJudgmentSamplingGeneration {
  return {
    temperature: 0,
    maxOutputTokens: 512,
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
  };
}
const datedAlphaInstrument: BinaryJudgmentInstrument = {
  ...fixture.input.instrument,
  instrumentId: "dated-alpha",
  model: { adapter: "jinn-openai", requested: "gpt-4o-mini-2024-07-18", generation: datedSnapshotGeneration() },
};
const datedBetaInstrument: BinaryJudgmentInstrument = {
  ...fixture.input.instrument,
  instrumentId: "dated-beta",
  model: { adapter: "jinn-openai", requested: "gpt-4o-mini-2024-07-18", generation: datedSnapshotGeneration() },
};
const sealedDatedAlpha = sealBinaryJudgmentInstrument(datedAlphaInstrument);
const sealedDatedBeta = sealBinaryJudgmentInstrument(datedBetaInstrument);
const datedManifest: InspectBinaryJudgeSelectionManifest = {
  ...manifest,
  arms: [
    {
      armId: "dated-alpha",
      instrumentSha256: sealedDatedAlpha.digest,
      model: "gpt-4o-mini-2024-07-18",
      generation: datedSnapshotGeneration(),
    },
    {
      armId: "dated-beta",
      instrumentSha256: sealedDatedBeta.digest,
      model: "gpt-4o-mini-2024-07-18",
      generation: datedSnapshotGeneration(),
    },
  ],
  // Required by the sealed selection schema whenever a bound arm's model is a dated snapshot
  // (spec §1.5 rule 2). Nothing exercised below dereferences the digest.
  snapshotProbeSha256: `sha256:${"9".repeat(64)}`,
};

function datedTaskView(overrides: Record<string, unknown> = {}): TaskView {
  return {
    task,
    profile: buildBinaryJudgmentProfile(),
    effectiveRequirements: {
      harness: { id: INSPECT_BINARY_JUDGE_LAUNCHER_ID, version: INSPECT_BINARY_JUDGE_LAUNCHER_VERSION },
      model: { id: "gpt-4o-mini-2024-07-18" },
      isolationPolicy: "oci-container",
      [BINARY_JUDGMENT_INSTRUMENT_REQUIREMENT_KEY]: sealedDatedAlpha.digest,
      ...overrides,
    },
  };
}

const paths: WorkspacePaths = {
  root: "/attempt/root",
  input: "/attempt/input",
  work: "/attempt/work",
  out: "/attempt/output",
  logs: "/attempt/logs",
  harnessState: "/attempt/harness-state",
  secrets: "/attempt/secrets",
  tmp: "/attempt/tmp",
  meta: "/attempt/meta",
};
const attempt: AttemptIdentity = {
  attemptUri: "urn:uuid:00000000-0000-4000-8000-000000000001",
  nonce: "binary-cell:1",
  attemptNumber: 1,
};

describe("Inspect binary-judge selection", () => {
  test("is a strict sibling contract with sorted arms and one common generation policy", () => {
    expect(InspectBinaryJudgeSelectionManifestSchema.parse(manifest)).toStrictEqual(manifest);
    expect(InspectBinaryJudgeSelectionManifestSchema.safeParse({
      ...manifest,
      arms: [...manifest.arms].reverse(),
    }).success).toBe(false);
    expect(InspectBinaryJudgeSelectionManifestSchema.safeParse({
      ...manifest,
      arms: [manifest.arms[0]!, {
        ...manifest.arms[1]!,
        generation: { ...generation, reasoningEffort: generation.reasoningEffort === "low" ? "none" : "low" },
      }],
    }).success).toBe(false);
    expect(InspectBinaryJudgeSelectionManifestSchema.safeParse({
      ...manifest,
      arms: [manifest.arms[0]!, { ...manifest.arms[1]!, instrumentSha256: sealedAlpha.digest }],
    }).success).toBe(false);
  });

  test("advertises exact string-valued instrument inventory and preserves broker-only OCI staging", () => {
    const launcher = makeInspectBinaryJudgeLauncher({ host, manifest, hostConnectionDescriptor: "/private/connection.json" });
    expect(launcher.capabilities().runPinning.keys).toContainEqual({
      key: BINARY_JUDGMENT_INSTRUMENT_REQUIREMENT_KEY,
      inventory: [sealedAlpha.digest, sealedBeta.digest],
      posture: "enforced",
    });
    const plan = launcher.plan(taskView(), paths, attempt);
    expect(plan.argv[0]).toBe(process.execPath);
    expect(plan.argv[1]).toBe(inspectOciRunnerPath());
    expect(plan.argv).toContain("--network=none");
    expect(plan.argv).toContain("type=bind,src=/attempt/input,dst=/jinn/input,readonly");
    expect(plan.argv).toContain("type=bind,src=/attempt/output,dst=/jinn/output");
    expect(plan.argv).toContain("/opt/jinn/binary_judge_worker.py");
    expect(plan.argv.at(-1)).toBe(INSPECT_BINARY_JUDGE_OCI_CONFIG_PATH);
    expect(plan.env).toEqual({
      LANG: "C.UTF-8",
      JINN_INSPECT_HOST_CONNECTION_DESCRIPTOR: "/private/connection.json",
    });
    expect(plan.argv.join("\n")).not.toMatch(/OPENAI_API_KEY|credential-volume|openai-api-key/u);
    expect({
      config: INSPECT_BINARY_JUDGE_CONFIG_FILENAME,
      outputDir: INSPECT_BINARY_JUDGE_OCI_OUTPUT_DIR,
      files: INSPECT_BINARY_JUDGE_OUTPUT_FILES,
    }).toStrictEqual({
      config: "inspect-run.json",
      outputDir: "/jinn/output",
      files: { response: "judge-response", observation: "judge-observation", inspectLog: "inspect-log" },
    });
    expect(() => makeInspectBinaryJudgeLauncher({
      host: { ...host, imageDigest: `sha256:${"d".repeat(64)}` },
      manifest,
    })).toThrow(/host image or platform differs/u);
  });

  test("reconstructs the F0 Unicode/CRLF oracle and checks every staged binding edge", () => {
    const selectionManifestSha256 = recordDigest(canonicalJsonBytes(manifest)).slice("sha256:".length);
    const workerInput = buildInspectBinaryJudgeWorkerInput({
      view: taskView(),
      sealedTaskBytes: taskBytes,
      manifest,
      selectionManifestSha256,
      instrumentBytes: sealedAlpha.bytes,
      cellKey: `${recordDigest(taskBytes).slice("sha256:".length)}/alpha/1`,
      armId: "alpha",
      replicate: 1,
      outputDir: INSPECT_BINARY_JUDGE_OCI_OUTPUT_DIR,
    });
    expect(workerInput.semanticRequest).toStrictEqual(fixture.expect.semanticRequest);
    expect(workerInput.requestSha256).toBe(fixture.expect.semanticRequestSha256);
    expect(workerInput.taskDigest).toBe(recordDigest(taskBytes));
    expect(workerInput.instrumentSha256).toBe(sealedAlpha.digest);
    expect(workerInput.arm.provider).toEqual({ surface: "openai-responses" });

    const common = {
      view: taskView(), sealedTaskBytes: taskBytes, manifest,
      selectionManifestSha256, instrumentBytes: sealedAlpha.bytes,
      cellKey: `${recordDigest(taskBytes).slice("sha256:".length)}/alpha/1`, armId: "alpha", replicate: 1,
      outputDir: INSPECT_BINARY_JUDGE_OCI_OUTPUT_DIR,
    } as const;
    expect(() => buildInspectBinaryJudgeWorkerInput({
      ...common,
      selectionManifestSha256: "0".repeat(64),
    })).toThrow(/selection manifest digest/u);
    const unsortedManifest = { ...manifest, arms: [...manifest.arms].reverse() };
    expect(() => buildInspectBinaryJudgeWorkerInput({
      ...common,
      manifest: unsortedManifest,
      selectionManifestSha256: recordDigest(canonicalJsonBytes(unsortedManifest)).slice("sha256:".length),
    })).toThrow(/code-unit sorted/u);
    const driftReasoningEffort: "none" | "low" = generation.reasoningEffort === "low" ? "none" : "low";
    const generationDriftManifest: InspectBinaryJudgeSelectionManifest = {
      ...manifest,
      arms: [manifest.arms[0]!, {
        ...manifest.arms[1]!,
        generation: { ...generation, reasoningEffort: driftReasoningEffort },
      }],
    };
    expect(() => buildInspectBinaryJudgeWorkerInput({
      ...common,
      manifest: generationDriftManifest,
      selectionManifestSha256: recordDigest(canonicalJsonBytes(generationDriftManifest)).slice("sha256:".length),
    })).toThrow(/identical generation/u);
    expect(() => buildInspectBinaryJudgeWorkerInput({ ...common, armId: "beta" }))
      .toThrow(/coordinate arm/u);
    expect(() => buildInspectBinaryJudgeWorkerInput({
      ...common,
      cellKey: `${recordDigest(taskBytes).slice("sha256:".length)}/alpha/2`,
    })).toThrow(/exact Task\/arm\/replicate coordinate/u);
    expect(() => buildInspectBinaryJudgeWorkerInput({ ...common, outputDir: "/tmp/out" }))
      .toThrow(/exact staged output mount/u);
    expect(() => buildInspectBinaryJudgeWorkerInput({
      ...common,
      instrumentBytes: sealBinaryJudgmentInstrument({ ...alphaInstrument, instrumentId: "not-alpha" }).bytes,
    })).toThrow(/instrument bytes differ/u);
    expect(() => buildInspectBinaryJudgeWorkerInput({
      ...common,
      view: taskView({ [BINARY_JUDGMENT_INSTRUMENT_REQUIREMENT_KEY]: { digest: sealedAlpha.digest } }),
    })).toThrow(/exact scalar instrument digest/u);
    expect(() => buildInspectBinaryJudgeWorkerInput({
      ...common,
      view: { ...taskView(), task: { ...task, outputs: task.outputs.slice(0, 2) } },
    })).toThrow(/outputs drifted/u);
  });

  test("builds an immutable, pull-free OCI command without a project, dataset, scorer, retry, or fallback", () => {
    const args = buildInspectBinaryJudgeOciRunArgs(host, {
      name: "jinn-inspect-judge-test",
      inputDir: "/attempt/input",
      outputDir: "/attempt/output",
    });
    const serialized = args.join("\n");
    expect(serialized).toContain("--pull=never");
    expect(serialized).toContain("--read-only");
    expect(serialized).toContain("--cap-drop=ALL");
    expect(serialized).toContain("--network=none");
    expect(serialized).not.toMatch(/dataset-cache|\/jinn\/project|scorer|retry|fallback/u);
  });
});

describe("Inspect binary-judge dated-snapshot arms (spec §1.6 / P1 changes 3a-3b)", () => {
  test("resolves and validates a dated-snapshot cell against its own selected arm", () => {
    const arm = validateInspectBinaryJudgePinning(datedTaskView(), datedManifest);
    expect(arm.armId).toBe("dated-alpha");
    expect(arm.model).toBe("gpt-4o-mini-2024-07-18");
  });

  test("refuses a cell whose model.id differs from its selected arm's own model", () => {
    expect(() => validateInspectBinaryJudgePinning(
      datedTaskView({ model: { id: "gpt-5.6-luna" } }),
      datedManifest,
    )).toThrow(/exact selected arm's model/u);
  });

  // Today's closed model set couples model to generation profile 1:1, and the sealed selection
  // schema requires every arm in one manifest to share one identical generation block (spec
  // §1.3: "this run isolates the prompt, not the model"). A single manifest naming two different
  // models is therefore not schema-constructible today — `makeInspectBinaryJudgeLauncher` would
  // refuse it at `InspectBinaryJudgeSelectionManifestSchema.parse`, before the run-pinning
  // inventory is ever built. What IS provable, and what this test proves, is that the inventory
  // is derived from whichever model(s) the sealed selection actually names rather than hardcoded
  // to the reasoning model: it reports exactly `["gpt-5.6-luna"]` for today's all-reasoning
  // manifest (the compatibility proof) and exactly `["gpt-4o-mini-2024-07-18"]` once the sealed
  // selection is a dated-snapshot one.
  test("the enforced run-pinning model inventory reflects the sealed selection's own arm models", () => {
    const reasoningLauncher = makeInspectBinaryJudgeLauncher({ host, manifest });
    expect(reasoningLauncher.capabilities().runPinning.keys).toContainEqual({
      key: "model",
      inventory: ["gpt-5.6-luna"],
      posture: "enforced",
    });

    const datedLauncher = makeInspectBinaryJudgeLauncher({ host, manifest: datedManifest });
    expect(datedLauncher.capabilities().runPinning.keys).toContainEqual({
      key: "model",
      inventory: ["gpt-4o-mini-2024-07-18"],
      posture: "enforced",
    });
  });
});

describe("Inspect binary-judge Python worker contract", () => {
  test("validates the cross-runtime request and builds a closed observation without any provider call", () => {
    const script = String.raw`
import importlib.util,json,sys
spec=importlib.util.spec_from_file_location("binary_judge_worker",sys.argv[1])
worker=importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)
fixture=json.load(open(sys.argv[2],encoding="utf-8"))
request=worker.validate_semantic_request(fixture["expect"]["semanticRequest"])
assert "sha256:"+worker.sha256_bytes(worker.canonical_bytes(request)) == fixture["expect"]["semanticRequestSha256"]
config={"taskDigest":"sha256:"+"1"*64,"armId":"alpha","replicate":1,"instrumentSha256":"sha256:"+"2"*64,"requestSha256":fixture["expect"]["semanticRequestSha256"]}
record={"status":"completed","resolvedModel":"gpt-5.6-luna","responseId":"resp_fixture","eventDigest":"3"*64,"usage":{"input_tokens":11,"output_tokens":2,"total_tokens":13}}
observation=worker.build_observation(config,b" ACCEPT\r\n",record)
assert observation["call"] == {"count":1,"retries":0,"fallbacks":0}
assert observation["provider"]["usage"] == {"inputTokens":11,"outputTokens":2,"totalTokens":13}
assert "verdict" not in observation and "decision" not in observation and "brokerProtocol" not in observation
try:
  worker.normalized_usage({"input_tokens":11,"output_tokens":2,"total_tokens":14})
  raise AssertionError("accepted inconsistent usage")
except ValueError: pass
try:
  worker.build_observation(config,b"ACCEPT",{**record,"status":"budget-rejected"})
  raise AssertionError("accepted non-completed broker event")
except ValueError: pass
print(json.dumps(observation,sort_keys=True,separators=(",",":")))
`;
    const fixturePath = new URL(
      "../../../../../task-execution/profiles/fixtures/binary-judgment-request/golden/unicode-line-endings.json",
      import.meta.url,
    );
    const result = spawnSync("python3", [
      "-c", script, inspectBinaryJudgeWorkerPath(), fixturePath.pathname,
    ], {
      encoding: "utf8",
      env: { PATH: "/usr/bin:/bin:/usr/local/bin", PYTHONDONTWRITEBYTECODE: "1" },
    });
    expect(result.status, result.stderr).toBe(0);
    const observation = JSON.parse(result.stdout);
    expect(observation).toMatchObject({
      protocol: "https://spec.jinn.network/binary-judgment/judge-observation/v1",
      taskDigest: `sha256:${"1".repeat(64)}`,
      armId: "alpha",
      replicate: 1,
      provider: { requestedModel: "gpt-5.6-luna", resolvedModel: "gpt-5.6-luna" },
      call: { count: 1, retries: 0, fallbacks: 0 },
    });
    const workerSource = readFileSync(inspectBinaryJudgeWorkerPath(), "utf8");
    for (const output of Object.values(INSPECT_BINARY_JUDGE_OUTPUT_FILES)) {
      expect(workerSource).toContain(`output_dir / "${output}"`);
    }
    expect(workerSource).toContain("scorer=None");
  });
});
