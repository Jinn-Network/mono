import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  BINARY_JUDGMENT_ANALYSIS_CONTEXT_FORMAT_URI,
  BINARY_JUDGMENT_ANALYSIS_CONTEXT_MEDIA_TYPE,
  BINARY_JUDGMENT_EVALUATION_PARSER_IDENTITY,
  BINARY_JUDGMENT_INSTRUMENT_REQUIREMENT_KEY,
  BINARY_JUDGMENT_INSPECT_LOG_MEDIA_TYPE,
  BINARY_JUDGMENT_LABEL_RESOLUTION_FORMAT_URI,
  BINARY_JUDGMENT_OBSERVATION_MEDIA_TYPE,
  BINARY_JUDGMENT_PROFILE_DIGEST,
  BINARY_JUDGMENT_PROFILE_URI,
  BINARY_JUDGMENT_RESPONSE_MEDIA_TYPE,
  EVALUATION_SPEC_FORMAT_URI,
  EVAL_SEMANTICS_VERSION,
  binaryJudgmentPromptTemplateDigest,
  sealBinaryJudgmentAnalysisContext,
  sealBinaryJudgmentInstrument,
  sealBinaryJudgmentLabelResolution,
  sealEvaluationSpec,
  type BinaryJudgmentInstrument,
  type BinaryJudgmentPayload,
  type EvaluationSpec,
} from "@jinn-network/task-execution-profiles";
import {
  BINARY_JUDGMENT_ANALYSIS_CONTEXT_NAME,
  BINARY_JUDGMENT_LABEL_RESOLUTION_NAME,
  BINARY_JUDGMENT_MEASUREMENTS,
  binaryJudgmentEvaluationSpecMeasurements,
  binaryJudgmentEvaluationSpecVerdictRule,
} from "@jinn-network/task-execution-evaluator-adapters";
import {
  documentDigest,
  sealSubmission,
  sealTask,
  TASK_EXECUTION_PROTOCOL_URI,
} from "@jinn-network/task-execution-protocol";
import { canonicalJsonBytes, recordDigest } from "@jinn-network/trust-core";
import { initWorkspace } from "../../operations/init.js";
import { runtimeHostPath } from "../../workspace/layout.js";
import { putSealedBytes, sha256Hex } from "../../workspace/sealed-store.js";
import {
  createLocalVenue,
  EVALUATION_HARNESS_PIN,
  EVALUATOR_REQUIREMENT_KEY,
  type LocalVenue,
} from "../../venue/venue.js";
import { readVerdictEnvelope } from "../../venue/signing.js";
import {
  INSPECT_BINARY_JUDGE_ADAPTER_ID,
  INSPECT_BINARY_JUDGE_LAUNCHER_ID,
  INSPECT_BINARY_JUDGE_LAUNCHER_VERSION,
  INSPECT_BINARY_JUDGE_SELECTION_SCHEMA,
  type InspectBinaryJudgeSelectionManifest,
} from "./binary-judge-manifest.js";
import {
  inspectBinaryJudgeWorkerSha256,
} from "./binary-judge.js";
import { inspectOciRunnerSha256 } from "./oci.js";

const NOW = () => "2026-08-15T12:00:00.000Z";
const DEADLINE = "2099-01-01T00:00:00.000Z";
const roots: string[] = [];
const venues: LocalVenue[] = [];

afterEach(async () => {
  for (const venue of venues.splice(0)) await venue.shutdown();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

// binary-judgment task profile 2.0: the 1.0 oracle is superseded (see
// task-execution/profiles/fixtures/manifest.sha256.json errata) because its payload carries the
// 1.0 array-shaped `provenance` and no longer validates against `BinaryJudgmentPayloadSchema`.
const oracle = JSON.parse(await readFile(new URL(
  "../../../../../task-execution/profiles/fixtures/binary-judgment-request/golden/unicode-line-endings-profile-2.json",
  import.meta.url,
), "utf8")) as {
  input: { readonly payload: BinaryJudgmentPayload; readonly instrument: BinaryJudgmentInstrument };
};

function sourceSha256(name: "broker.py" | "model_provider.py"): string {
  return sha256Hex(new Uint8Array(readFileSync(new URL(`./${name}`, import.meta.url))));
}

function submission(input: {
  readonly taskSha256: string;
  readonly requirements: Record<string, unknown>;
  readonly nonce?: string;
}): Uint8Array {
  return sealSubmission({
    protocol: TASK_EXECUTION_PROTOCOL_URI,
    submission: `urn:uuid:${randomUUID()}`,
    task: { digest: { sha256: input.taskSha256 } },
    requester: `urn:uuid:${randomUUID()}`,
    idempotencyKey: randomUUID(),
    nonce: input.nonce ?? randomUUID(),
    deadline: DEADLINE,
    requirements: input.requirements,
  });
}

async function writeFakeDocker(root: string): Promise<{ readonly path: string; readonly calls: string; readonly staged: string }> {
  const path = join(root, "fake-docker.mjs");
  const calls = join(root, "fake-docker-calls.ndjson");
  const staged = join(root, "staged-binary-judge.json");
  await writeFile(path, `#!${process.execPath}
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + "\\n");
const stable = (value) => Array.isArray(value) ? value.map(stable) : value && typeof value === "object"
  ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])])) : value;
const bytes = (value) => Buffer.from(JSON.stringify(stable(value)));
const digest = (value) => createHash("sha256").update(Buffer.isBuffer(value) ? value : bytes(value)).digest("hex");
const mount = (destination) => {
  for (let i = 0; i < args.length - 1; i += 1) {
    if (args[i] !== "--mount") continue;
    const fields = Object.fromEntries(args[i + 1].split(",").map((part) => {
      const at = part.indexOf("=");
      return at < 0 ? [part, ""] : [part.slice(0, at), part.slice(at + 1)];
    }));
    if (fields.dst === destination) return fields.src;
  }
};
if (args[0] === "container" && args[1] === "inspect") process.exit(1);
if (args[0] === "inspect" && args.includes("{{json .NetworkSettings.Networks}}")) {
  const broker = args.at(-1);
  const network = broker.slice(0, -"-broker".length) + "-net";
  process.stdout.write(JSON.stringify({ [network]: { Aliases: ["jinn-model-broker"] } }));
  process.exit(0);
}
if (args[0] === "run" && args.includes("--detach")) {
  process.stdout.write("fake-broker-id\\n");
  process.exit(0);
}
if (args[0] === "run" && args.includes("/opt/jinn/binary_judge_worker.py")) {
  const input = mount("/jinn/input");
  const output = mount("/jinn/output");
  const configBytes = readFileSync(join(input, "inspect-run.json"));
  const config = JSON.parse(configBytes);
  const instrumentBytes = readFileSync(join(input, "judge-instrument.json"));
  const selectionBytes = readFileSync(join(input, "judge-selection.json"));
  const taskBytes = readFileSync(join(input, "task.sealed"));
  const response = Buffer.from("ACCEPT");
  const brokerEvent = {
    responseId: "resp_fake_no_provider",
    responseSha256: "sha256:" + digest(response),
    resolvedModel: "gpt-5.6-luna",
    status: "completed",
    usage: { input_tokens: 11, output_tokens: 1, total_tokens: 12 },
  };
  const eventSha256 = "sha256:" + digest(brokerEvent);
  const observation = {
    armId: config.armId,
    call: { count: 1, fallbacks: 0, retries: 0 },
    instrumentSha256: config.instrumentSha256,
    limitations: ["mutable-model-alias"],
    protocol: "https://spec.jinn.network/binary-judgment/judge-observation/v1",
    provider: {
      eventSha256,
      requestedModel: "gpt-5.6-luna",
      resolvedModel: "gpt-5.6-luna",
      responseId: brokerEvent.responseId,
      usage: { inputTokens: 11, outputTokens: 1, totalTokens: 12 },
    },
    replicate: config.replicate,
    requestSha256: config.requestSha256,
    response: { digest: "sha256:" + digest(response), mediaType: "text/plain; charset=utf-8" },
    taskDigest: config.taskDigest,
  };
  writeFileSync(join(output, "judge-response"), response);
  writeFileSync(join(output, "judge-observation"), bytes(observation));
  writeFileSync(join(output, "inspect-log"), bytes({
    brokerEvent,
    semanticRequest: config.semanticRequest,
    semanticRequestSha256: config.requestSha256,
    responseBase64: response.toString("base64"),
    schema: "jinn.test/fake-inspect-replay/1",
  }));
  writeFileSync(${JSON.stringify(staged)}, bytes({
    config,
    dockerArgs: args,
    instrumentSha256: "sha256:" + digest(instrumentBytes),
    selectionSha256: digest(selectionBytes),
    taskSha256: digest(taskBytes),
  }));
  process.exit(0);
}
process.exit(0);
`, { mode: 0o700 });
  await chmod(path, 0o700);
  return { path, calls, staged };
}

describe("Inspect binary judge on the real local venue", () => {
  test("stages one broker-backed solve and carries it through the frozen evaluator to a signed Result Evaluation", async () => {
    const root = await mkdtemp(join(tmpdir(), "inspect-binary-venue-"));
    roots.push(root);
    const workspaceDir = join(root, "workspace");
    expect(initWorkspace({ workspaceDir, principal: "sponsor-1", clock: NOW }).ok).toBe(true);
    const fakeDocker = await writeFakeDocker(root);

    const alpha = sealBinaryJudgmentInstrument({ ...oracle.input.instrument, instrumentId: "alpha" });
    const betaMessages = oracle.input.instrument.messages.map((message, index) => index === 0
      ? { ...message, segments: [{ literal: "Alternative rubric. " }, ...message.segments] }
      : message);
    const beta = sealBinaryJudgmentInstrument({
      ...oracle.input.instrument,
      instrumentId: "beta",
      messages: betaMessages,
      promptTemplateSha256: binaryJudgmentPromptTemplateDigest(betaMessages),
    });
    putSealedBytes(workspaceDir, alpha.bytes);
    putSealedBytes(workspaceDir, beta.bytes);

    const itemSha256 = recordDigest(canonicalJsonBytes(oracle.input.payload));
    const labelResolution = sealBinaryJudgmentLabelResolution({
      protocol: BINARY_JUDGMENT_LABEL_RESOLUTION_FORMAT_URI,
      itemSha256,
      itemId: oracle.input.payload.itemId,
      humanReviewEvaluationSpecSha256: `sha256:${"5".repeat(64)}`,
      truthLabel: "CORRECT",
      candidateClass: "unicode_crlf",
      stratum: "stress",
      truthAdmission: "two-human-unanimous",
      reviewVerdictSha256s: [`sha256:${"6".repeat(64)}`, `sha256:${"7".repeat(64)}`],
      reviewerRosterSha256: `sha256:${"8".repeat(64)}`,
      visibilityReceiptSha256s: [`sha256:${"9".repeat(64)}`, `sha256:${"a".repeat(64)}`],
      revealReceiptSha256: `sha256:${"b".repeat(64)}`,
      resolvedAt: NOW(),
    });
    const analysisContext = sealBinaryJudgmentAnalysisContext({
      protocol: BINARY_JUDGMENT_ANALYSIS_CONTEXT_FORMAT_URI,
      itemSha256,
      itemId: oracle.input.payload.itemId,
      labelResolutionSha256: labelResolution.digest,
      truthLabel: "CORRECT",
      candidateClass: "unicode_crlf",
      stratum: "stress",
    });
    putSealedBytes(workspaceDir, labelResolution.bytes);
    putSealedBytes(workspaceDir, analysisContext.bytes);
    const evaluationSpec: EvaluationSpec = {
      protocol: EVALUATION_SPEC_FORMAT_URI,
      semanticsVersion: EVAL_SEMANTICS_VERSION,
      family: "deterministic-process",
      grader: {
        name: BINARY_JUDGMENT_EVALUATION_PARSER_IDENTITY.id,
        digest: { sha256: BINARY_JUDGMENT_EVALUATION_PARSER_IDENTITY.digest.slice("sha256:".length) },
        accessClass: "public",
      },
      familyBlock: {
        image: {
          name: "binary-judgment-evaluation-parser-semantics.json",
          digest: { sha256: BINARY_JUDGMENT_EVALUATION_PARSER_IDENTITY.digest.slice("sha256:".length) },
        },
        platform: "linux/amd64",
        workspace: {},
        testMaterial: [{
          name: BINARY_JUDGMENT_ANALYSIS_CONTEXT_NAME,
          digest: { sha256: analysisContext.digest.slice("sha256:".length) },
          mediaType: BINARY_JUDGMENT_ANALYSIS_CONTEXT_MEDIA_TYPE,
          accessClass: "private",
        }],
        parser: BINARY_JUDGMENT_EVALUATION_PARSER_IDENTITY,
        transitions: { failToPass: [], passToPass: [] },
        timeout: 60,
      },
      measurements: binaryJudgmentEvaluationSpecMeasurements(),
      verdictRule: binaryJudgmentEvaluationSpecVerdictRule(),
      unscorable: [],
      evidenceConventions: { requiredRefs: [BINARY_JUDGMENT_LABEL_RESOLUTION_NAME] },
    };
    const sealedEvaluationSpec = sealEvaluationSpec(evaluationSpec);
    putSealedBytes(workspaceDir, sealedEvaluationSpec.bytes);
    const taskBytes = sealTask({
      protocol: TASK_EXECUTION_PROTOCOL_URI,
      profile: {
        uri: BINARY_JUDGMENT_PROFILE_URI,
        digest: { sha256: BINARY_JUDGMENT_PROFILE_DIGEST.slice("sha256:".length) },
      },
      instructions: "Return exactly ACCEPT or REJECT.",
      payload: oracle.input.payload,
      outputs: [
        { name: "judge-response", mediaType: BINARY_JUDGMENT_RESPONSE_MEDIA_TYPE, required: true },
        { name: "judge-observation", mediaType: BINARY_JUDGMENT_OBSERVATION_MEDIA_TYPE, required: true },
        { name: "inspect-log", mediaType: BINARY_JUDGMENT_INSPECT_LOG_MEDIA_TYPE, required: false },
      ],
      evaluation: {
        name: "evaluation-spec.json",
        digest: { sha256: sealedEvaluationSpec.digest.slice("sha256:".length) },
      },
      "network.jinn.binary-judgment.item-sha256": itemSha256,
    });
    const taskSha256 = documentDigest(taskBytes).slice("sha256:".length);

    const imageDigest = `sha256:${"d".repeat(64)}` as const;
    const manifest: InspectBinaryJudgeSelectionManifest = {
      schema: INSPECT_BINARY_JUDGE_SELECTION_SCHEMA,
      runtime: {
        imageDigest,
        platform: "linux/amd64",
        pythonVersion: "3.11.9",
        inspectVersion: "0.3.255",
        inspectEvalsVersion: "0.16.0",
        openaiSdkVersion: "2.53.0",
        runtimeHostSourceSha256: inspectOciRunnerSha256(),
        workerSourceSha256: inspectBinaryJudgeWorkerSha256(),
        brokerSourceSha256: sourceSha256("broker.py"),
        modelProviderSourceSha256: sourceSha256("model_provider.py"),
      },
      execution: { callsPerCell: 1, epochs: 1, inspectScorer: false, retries: 0, fallbacks: 0, tools: [], storage: false },
      requirement: {
        key: BINARY_JUDGMENT_INSTRUMENT_REQUIREMENT_KEY,
        valueShape: "sha256:<64-lowercase-hex>",
        comparison: "exact",
        location: "submission-effective-requirements",
      },
      arms: [
        { armId: "alpha", instrumentSha256: alpha.digest, model: "gpt-5.6-luna", generation: oracle.input.instrument.model.generation },
        { armId: "beta", instrumentSha256: beta.digest, model: "gpt-5.6-luna", generation: oracle.input.instrument.model.generation },
      ],
    };
    const selectionManifestSha256 = putSealedBytes(workspaceDir, canonicalJsonBytes(manifest));
    await mkdir(join(workspaceDir, "runtime-hosts"), { recursive: true });
    await writeFile(runtimeHostPath(workspaceDir, selectionManifestSha256), canonicalJsonBytes({
      kind: "oci",
      dockerPath: fakeDocker.path,
      imageDigest,
      platform: "linux/amd64",
      user: "65532:65532",
    }));
    const keyInputPath = join(root, "fake-openai-key");
    await writeFile(keyInputPath, "test-only-never-forwarded", { mode: 0o600 });
    const keyPath = await realpath(keyInputPath);
    const keyStat = await stat(keyPath);
    const connectionPath = join(root, "host-connection.json");
    await writeFile(connectionPath, JSON.stringify({
      schema: "jinn.network/benchmark-product/host-connection/1",
      openAIKeyFile: keyPath,
      metadata: {
        dev: keyStat.dev,
        ino: keyStat.ino,
        mode: keyStat.mode & 0o777,
        size: keyStat.size,
        uid: keyStat.uid,
      },
    }), { mode: 0o600 });

    const venue = createLocalVenue({
      workspaceDir,
      runtimeBindingWorkspaceDir: workspaceDir,
      inspectHostConnectionDescriptor: connectionPath,
      evaluationRuntime: { adapterId: INSPECT_BINARY_JUDGE_ADAPTER_ID, selectionManifestSha256 },
      now: NOW,
    });
    venues.push(venue);
    await venue.preflightRun?.();
    const cellKey = `${taskSha256}/alpha/1`;
    const solveAck = await venue.backend.submit(taskBytes, submission({
      taskSha256,
      nonce: `${cellKey}:1`,
      requirements: {
        harness: { id: INSPECT_BINARY_JUDGE_LAUNCHER_ID, version: INSPECT_BINARY_JUDGE_LAUNCHER_VERSION },
        model: { id: "gpt-5.6-luna" },
        isolationPolicy: "oci-container",
        [BINARY_JUDGMENT_INSTRUMENT_REQUIREMENT_KEY]: alpha.digest,
      },
    }));
    expect(solveAck.accepted, JSON.stringify(solveAck)).toBe(true);
    if (!solveAck.accepted) throw new Error("unreachable");
    await venue.backend.drain();
    const solveView = await venue.backend.observe(solveAck.submission);
    const solveCalls = await readFile(fakeDocker.calls, "utf8");
    expect(solveView.descriptor.derived, `${JSON.stringify(solveView.observations)}\n${solveCalls}`).toMatchObject({ state: "delivered", terminal: true });
    const solveDeliveries = await venue.backend.deliveries(solveView.descriptor.attempt);
    const deliveryBytes = await venue.backend.fetchDelivery(solveDeliveries[0]!);
    const delivery = JSON.parse(new TextDecoder().decode(deliveryBytes)) as {
      readonly outputs: readonly { readonly name: string; readonly digest: { readonly sha256: string } }[];
    };
    expect(delivery.outputs.map((output) => output.name).sort()).toEqual(["inspect-log", "judge-observation", "judge-response"]);
    const resultArtifacts = await Promise.all(delivery.outputs.map(async (output) => ({
      name: output.name,
      bytes: await venue.backend.fetchArtifact({ digest: output.digest }),
    })));
    const staged = JSON.parse(await readFile(fakeDocker.staged, "utf8")) as {
      readonly config: { readonly cellKey: string; readonly taskDigest: string; readonly instrumentSha256: string };
      readonly dockerArgs: readonly string[];
      readonly instrumentSha256: string;
      readonly selectionSha256: string;
      readonly taskSha256: string;
    };
    expect(staged.config).toMatchObject({ cellKey, taskDigest: `sha256:${taskSha256}`, instrumentSha256: alpha.digest });
    expect(staged.instrumentSha256).toBe(alpha.digest);
    expect(staged.selectionSha256).toBe(selectionManifestSha256);
    expect(staged.taskSha256).toBe(taskSha256);
    expect(staged.dockerArgs).toContainEqual(expect.stringMatching(/^--network=jinn-inspect-judge-.*-net$/u));
    expect(staged.dockerArgs).not.toContain("--network=none");

    const prepared = await venue.prepareEvaluationCell({
      subjectTaskBytes: taskBytes,
      subjectDeliveryBytes: deliveryBytes,
      resultArtifacts,
      evaluationSpecBytes: sealedEvaluationSpec.bytes,
    });
    const evaluationAck = await venue.backend.submit(prepared.taskBytes, submission({
      taskSha256: prepared.taskSha256,
      requirements: {
        harness: EVALUATION_HARNESS_PIN,
        [EVALUATOR_REQUIREMENT_KEY]: venue.evaluators[0]!.id,
      },
    }));
    expect(evaluationAck.accepted, JSON.stringify(evaluationAck)).toBe(true);
    if (!evaluationAck.accepted) throw new Error("unreachable");
    await venue.backend.drain();
    const evaluationView = await venue.backend.observe(evaluationAck.submission);
    expect(evaluationView.descriptor.derived, JSON.stringify(evaluationView.observations)).toMatchObject({ state: "delivered", terminal: true });
    const evaluationDeliveries = await venue.backend.deliveries(evaluationView.descriptor.attempt);
    const evaluationDeliveryBytes = await venue.backend.fetchDelivery(evaluationDeliveries[0]!);
    const evaluationDelivery = JSON.parse(new TextDecoder().decode(evaluationDeliveryBytes)) as {
      readonly outputs: readonly { readonly name: string; readonly digest: { readonly sha256: string } }[];
    };
    const verdictBytes = await venue.backend.fetchArtifact({ digest: evaluationDelivery.outputs[0]!.digest });
    const verdict = readVerdictEnvelope(verdictBytes);
    expect(verdict.verdict).toBe("pass");
    expect(verdict.measurements[BINARY_JUDGMENT_MEASUREMENTS.judgeDecision]).toBe("ACCEPT");
    expect(verdict.measurements[BINARY_JUDGMENT_MEASUREMENTS.truthLabel]).toBe("CORRECT");
    expect(verdict.measurements[BINARY_JUDGMENT_MEASUREMENTS.agreement]).toBe(true);
    expect(verdict.measurements[BINARY_JUDGMENT_MEASUREMENTS.instrumentSha256]).toBe(alpha.digest);

    // Every process in the solve leg was the local fake OCI executable. No provider client or
    // network fixture is started by this test; the staged capture proves the real broker-only
    // oci-runner rewrite and provisioner paths were nevertheless exercised.
    const calls = (await readFile(fakeDocker.calls, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as string[]);
    expect(calls.some((call) => call[0] === "network" && call[1] === "create")).toBe(true);
    expect(calls.some((call) => call.includes("/opt/jinn/binary_judge_worker.py"))).toBe(true);
  }, 60_000);
});
