import { chmodSync, cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { parseMatrix, parseReport, sealMatrix } from "@jinn-network/benchmarking-records";
import { createDraft } from "../../operations/drafts.js";
import { initWorkspace } from "../../operations/init.js";
import { selectInspectEvaluation } from "../../operations/inspect-runtime.js";
import { runCollect } from "../../operations/run-collect.js";
import { runCancel } from "../../operations/run-cancel.js";
import { runLaunch } from "../../operations/run-launch.js";
import { runLock } from "../../operations/run-lock.js";
import { runPreview } from "../../operations/preview.js";
import { runQuote } from "../../operations/run-quote.js";
import { runReport } from "../../operations/report.js";
import { runResults } from "../../operations/run-results.js";
import { runPublish } from "../../operations/publish.js";
import { runVerify } from "../../operations/verify.js";
import type { OperationContext } from "../../operations/context.js";
import { verifyPublicBundle } from "../../bundle/verify.js";
import { createDefaultBenchmarkRuntimeHost } from "../host-port.js";
import { readRunJournalEntries } from "../../run/journal.js";
import { readRunState, writeRunState } from "../../run/state.js";
import { getSealedBytes, putSealedBytes } from "../../workspace/sealed-store.js";
import { createRuntimeVenue } from "../adapter.js";

const imageDigest = process.env.JINN_INSPECT_OCI_IMAGE;
const datasetCacheDir = process.env.JINN_INSPECT_OCI_DATASET_CACHE;
const humanEvalCacheDir = process.env.JINN_INSPECT_HUMANEVAL_CACHE;
const dockerPath = process.env.JINN_DOCKER_PATH ?? "/usr/local/bin/docker";
const fixtureDir = dirname(fileURLToPath(new URL("../../../test/fixtures/inspect-project/hermetic_eval.py", import.meta.url)));
const workspaces: string[] = [];

function retainedBytes(root: string): Buffer[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? retainedBytes(path) : [readFileSync(path)];
  });
}

afterEach(() => {
  if (process.env.JINN_KEEP_INSPECT_WORKSPACE === "1") return;
  for (const workspace of workspaces.splice(0)) rmSync(workspace, { recursive: true, force: true });
});

describe.skipIf(imageDigest === undefined || datasetCacheDir === undefined)("real OCI Inspect runtime", () => {
  test("runs multiple Inspect scorers through the runtime-hosted sandbox and preserves native evidence", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "benchmark-product-inspect-sandbox-"));
    const hostDir = mkdtempSync(join(tmpdir(), "benchmark-product-inspect-sandbox-host-"));
    workspaces.push(workspaceDir, hostDir);
    const sentinelPath = join(hostDir, "host-sentinel");
    writeFileSync(sentinelPath, "HOST_SENTINEL_MUST_NOT_BE_READ", { mode: 0o600 });
    const context: OperationContext = {
      workspaceDir,
      principal: "sponsor-1",
      clock: () => new Date().toISOString(),
    };
    expect(initWorkspace(context).ok).toBe(true);
    expect(createDraft(context, { draftId: "inspect-sandbox", name: "OCI Inspect sandbox fixture" }).ok).toBe(true);
    const selected = await selectInspectEvaluation(context, {
      draftId: "inspect-sandbox",
      execution: "oci",
      dockerPath,
      imageDigest: imageDigest!,
      projectDir: fixtureDir,
      datasetCacheDir: datasetCacheDir!,
      sandboxExecution: { provider: "jinn-oci", imageDigest: imageDigest!, platform: "linux/amd64" },
      taskReference: "hermetic_eval.py@hosted_sandbox_multiple_scorer_eval",
      taskArgs: { host_sentinel_path: sentinelPath },
      arms: [
        { armId: "sandbox-a", model: "mockllm/sandbox-a" },
        { armId: "sandbox-b", model: "mockllm/sandbox-b" },
      ],
      scoring: {
        projections: [
          { measurementName: "contained", scorerName: "hosted_sandbox_scorer", passValue: "C" },
          { measurementName: "safe", scorerName: "policy_scorer", subScoreKey: "safe", passValue: true },
        ],
        verdictRule: {
          all: [
            { threshold: { measurement: "contained", op: "eq", value: true } },
            { threshold: { measurement: "safe", op: "eq", value: true } },
          ],
        },
      },
      runOptions: { sampleId: "alpha", maxSamples: 1, maxSandboxes: 1, retryOnError: 0 },
    });
    expect(selected.ok, JSON.stringify(selected)).toBe(true);
    if (!selected.ok) throw new Error("unreachable");
    expect(selected.result.draft.spec.evaluationRuntime?.isolationPolicy).toBe("oci-container");
    expect((await runPreview(context, { draftId: "inspect-sandbox" })).ok).toBe(true);
    expect((await runQuote(context, { draftId: "inspect-sandbox" })).ok).toBe(true);
    expect(runLock(context, { draftId: "inspect-sandbox" }).ok).toBe(true);
    expect((await runLaunch(context, { draftId: "inspect-sandbox" })).ok).toBe(true);
    const collected = await runCollect(context, { draftId: "inspect-sandbox" });
    expect(collected.ok, JSON.stringify(collected)).toBe(true);
    if (!collected.ok) throw new Error("unreachable");
    const matrix = parseMatrix(getSealedBytes(workspaceDir, collected.result.matrixSha256));
    expect(matrix.completeness).toMatchObject({ expected: 2, judged: 2, runOutcome: "complete" });
    expect(matrix.cells.every((cell) => cell.verification.isolation === "unverifiable")).toBe(true);
    const journal = readRunJournalEntries(workspaceDir, "inspect-sandbox");
    const deliveries = journal.filter((entry) => entry.kind === "delivery");
    expect(deliveries).toHaveLength(2);
    for (const delivery of deliveries) {
      const summaryOutput = delivery.outputs.find((output) => output.name === "inspect-summary");
      const summary = JSON.parse(new TextDecoder().decode(getSealedBytes(workspaceDir, summaryOutput!.sha256)));
      expect(summary).toMatchObject({
        schema: "jinn.network/benchmark-product/inspect-cell-summary/2",
        terminal: "scored",
        verdict: "pass",
        scorers: [
          { name: "hosted_sandbox_scorer" },
          { name: "policy_scorer" },
        ],
        measurements: [
          { measurementName: "contained", value: true },
          { measurementName: "safe", value: true },
        ],
        sandbox: {
          provider: "jinn-oci",
          protocol: "jinn.network/inspect-sandbox-host/1",
          imageDigest,
          environmentCount: 1,
        },
      });
      expect(summary.sandbox.operationCount).toBeGreaterThanOrEqual(3);
      expect(summary.sandbox.eventDigest).toMatch(/^[a-f0-9]{64}$/u);
    }
    expect((await runReport(context, { draftId: "inspect-sandbox" })).ok).toBe(true);
    expect((await runVerify(context, { draftId: "inspect-sandbox" })).ok).toBe(true);
    const published = await runPublish(context, { draftId: "inspect-sandbox", includeNativeArtifacts: true });
    expect(published.ok, JSON.stringify(published)).toBe(true);
    if (!published.ok) throw new Error("unreachable");
    const detachedRoot = mkdtempSync(join(tmpdir(), "benchmark-product-inspect-sandbox-bundle-"));
    workspaces.push(detachedRoot);
    const detachedBundle = join(detachedRoot, "bundle");
    cpSync(join(workspaceDir, published.result.bundleRelativePath), detachedBundle, { recursive: true });
    rmSync(workspaceDir, { recursive: true, force: true });
    expect((await verifyPublicBundle(detachedBundle)).checks).toContain("report-verification");
    const nativeDir = join(detachedBundle, "native", "inspect");
    const officialRead = execFileSync(dockerPath, [
      "run", "--rm", "--pull=never", "--platform=linux/amd64", "--network=none",
      "--mount", `type=bind,src=${nativeDir},dst=/logs,readonly`,
      "--entrypoint=python", imageDigest!, "-c",
      "from inspect_ai.log import list_eval_logs,read_eval_log; logs=[read_eval_log(x) for x in list_eval_logs('/logs')]; assert len(logs)==2; assert all(x.status=='success' for x in logs); assert all(set((x.samples or [])[0].scores)=={'hosted_sandbox_scorer','policy_scorer'} for x in logs); events=[e for x in logs for s in (x.samples or []) for e in (s.events or []) if e.event=='sandbox']; assert len(events)>=6; assert all(x.eval.sandbox.type=='jinn-oci' for x in logs)",
    ], { encoding: "utf8" });
    expect(officialRead).toBe("");
    const viewerOutputRoot = join(detachedRoot, "viewer-output");
    mkdirSync(viewerOutputRoot, { mode: 0o777 });
    chmodSync(viewerOutputRoot, 0o777);
    execFileSync(dockerPath, [
      "run", "--rm", "--pull=never", "--platform=linux/amd64", "--network=none",
      "--user", `${String(process.getuid?.())}:${String(process.getgid?.())}`,
      "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges",
      "--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=67108864", "--env=HOME=/tmp/home",
      "--mount", `type=bind,src=${nativeDir},dst=/logs,readonly`,
      "--mount", `type=bind,src=${viewerOutputRoot},dst=/output`,
      "--entrypoint=inspect", imageDigest!, "view", "bundle", "--log-dir=/logs", "--output-dir=/output/inspect-view-bundle",
    ], { encoding: "utf8" });
    expect(readdirSync(join(viewerOutputRoot, "inspect-view-bundle")).length).toBeGreaterThan(0);
    const remaining = execFileSync(dockerPath, ["ps", "-a", "--filter", "name=jinn-inspect-", "--format", "{{.Names}}"], { encoding: "utf8" }).trim();
    expect(remaining).toBe("");
  }, 300_000);

  test.skipIf(humanEvalCacheDir === undefined)("runs one unmodified Inspect Evals HumanEval sample in the hosted sandbox", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "benchmark-product-inspect-humaneval-"));
    workspaces.push(workspaceDir);
    const context: OperationContext = {
      workspaceDir,
      principal: "sponsor-1",
      clock: () => new Date().toISOString(),
    };
    expect(initWorkspace(context).ok).toBe(true);
    expect(createDraft(context, { draftId: "inspect-humaneval", name: "Inspect Evals HumanEval sandbox proof" }).ok).toBe(true);
    const selected = await selectInspectEvaluation(context, {
      draftId: "inspect-humaneval",
      execution: "oci",
      dockerPath,
      imageDigest: imageDigest!,
      projectDir: fixtureDir,
      datasetCacheDir: humanEvalCacheDir!,
      sandboxExecution: { provider: "jinn-oci", imageDigest: imageDigest!, platform: "linux/amd64" },
      taskReference: "inspect_evals/humaneval",
      arms: [
        { armId: "humaneval-a", model: "mockllm/model" },
        { armId: "humaneval-b", model: "mockllm/model" },
      ],
      scorer: { name: "verify", passValue: "C" },
      runOptions: { sampleId: "HumanEval/0", maxSamples: 1, maxSandboxes: 1, retryOnError: 0 },
    });
    expect(selected.ok, JSON.stringify(selected)).toBe(true);
    if (!selected.ok) throw new Error("unreachable");
    expect((await runPreview(context, { draftId: "inspect-humaneval" })).ok).toBe(true);
    expect((await runQuote(context, { draftId: "inspect-humaneval" })).ok).toBe(true);
    expect(runLock(context, { draftId: "inspect-humaneval" }).ok).toBe(true);
    expect((await runLaunch(context, { draftId: "inspect-humaneval" })).ok).toBe(true);
    const collected = await runCollect(context, { draftId: "inspect-humaneval" });
    expect(collected.ok, JSON.stringify(collected)).toBe(true);
    if (!collected.ok) throw new Error("unreachable");
    const matrix = parseMatrix(getSealedBytes(workspaceDir, collected.result.matrixSha256));
    expect(matrix.completeness).toMatchObject({ expected: 2, judged: 2, runOutcome: "complete" });
    expect(matrix.cells.every((cell) => cell.outcome === "judged" && cell.verification.isolation === "unverifiable")).toBe(true);
    expect((await runReport(context, { draftId: "inspect-humaneval" })).ok).toBe(true);
    expect((await runVerify(context, { draftId: "inspect-humaneval" })).ok).toBe(true);
    const published = await runPublish(context, { draftId: "inspect-humaneval", includeNativeArtifacts: true });
    expect(published.ok, JSON.stringify(published)).toBe(true);
    if (!published.ok) throw new Error("unreachable");
    const detachedRoot = mkdtempSync(join(tmpdir(), "benchmark-product-inspect-humaneval-bundle-"));
    workspaces.push(detachedRoot);
    const detachedBundle = join(detachedRoot, "bundle");
    cpSync(join(workspaceDir, published.result.bundleRelativePath), detachedBundle, { recursive: true });
    rmSync(workspaceDir, { recursive: true, force: true });
    expect((await verifyPublicBundle(detachedBundle)).checks).toContain("report-verification");
    const nativeDir = join(detachedBundle, "native", "inspect");
    const officialRead = execFileSync(dockerPath, [
      "run", "--rm", "--pull=never", "--platform=linux/amd64", "--network=none",
      "--mount", `type=bind,src=${nativeDir},dst=/logs,readonly`,
      "--entrypoint=python", imageDigest!, "-c",
      "from inspect_ai.log import list_eval_logs,read_eval_log; logs=[read_eval_log(x) for x in list_eval_logs('/logs')]; assert len(logs)==2; assert all(x.status=='success' and x.eval.task=='inspect_evals/humaneval' and x.eval.sandbox.type=='jinn-oci' for x in logs); assert all(len(x.samples or [])==1 and str(x.samples[0].id)=='HumanEval/0' and x.samples[0].scores.get('verify') is not None for x in logs)",
    ], { encoding: "utf8" });
    expect(officialRead).toBe("");
    const viewerOutputRoot = join(detachedRoot, "viewer-output");
    mkdirSync(viewerOutputRoot, { mode: 0o777 });
    chmodSync(viewerOutputRoot, 0o777);
    execFileSync(dockerPath, [
      "run", "--rm", "--pull=never", "--platform=linux/amd64", "--network=none",
      "--user", `${String(process.getuid?.())}:${String(process.getgid?.())}`,
      "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges",
      "--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=67108864", "--env=HOME=/tmp/home",
      "--mount", `type=bind,src=${nativeDir},dst=/logs,readonly`,
      "--mount", `type=bind,src=${viewerOutputRoot},dst=/output`,
      "--entrypoint=inspect", imageDigest!, "view", "bundle", "--log-dir=/logs", "--output-dir=/output/inspect-view-bundle",
    ], { encoding: "utf8" });
    expect(readdirSync(join(viewerOutputRoot, "inspect-view-bundle")).length).toBeGreaterThan(0);
    const remaining = execFileSync(dockerPath, ["ps", "-a", "--filter", "name=jinn-inspect-", "--format", "{{.Names}}"], { encoding: "utf8" }).trim();
    expect(remaining).toBe("");
  }, 300_000);

  test("runs one exact sample across two arms through preview and the official lifecycle", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "benchmark-product-inspect-oci-"));
    workspaces.push(workspaceDir);
    const context: OperationContext = {
      workspaceDir,
      principal: "sponsor-1",
      clock: () => new Date().toISOString(),
    };
    expect(initWorkspace(context).ok).toBe(true);
    expect(createDraft(context, { draftId: "inspect-oci", name: "OCI Inspect fixture" }).ok).toBe(true);
    const selected = await selectInspectEvaluation(context, {
      draftId: "inspect-oci",
      execution: "oci",
      dockerPath,
      imageDigest: imageDigest!,
      projectDir: fixtureDir,
      datasetCacheDir: datasetCacheDir!,
      taskReference: "hermetic_eval.py@hermetic_eval",
      arms: [
        { armId: "control", model: "mockllm/model" },
        { armId: "candidate", model: "mockllm/model" },
      ],
      scorer: { name: "match", passValue: "C" },
      runOptions: { sampleId: "alpha", maxSamples: 1, retryOnError: 0 },
    });
    expect(selected.ok, JSON.stringify(selected)).toBe(true);
    if (!selected.ok) throw new Error("unreachable");
    const venue = createRuntimeVenue(selected.result.draft.spec.evaluationRuntime, {
      workspaceDir,
      now: context.clock,
    });
    try {
      await expect(venue.backend.capabilities()).resolves.toMatchObject({
        isolation: ["oci-container", "process"],
      });
    } finally {
      await venue.shutdown();
    }
    expect((await runPreview(context, { draftId: "inspect-oci" })).ok).toBe(true);
    expect((await runQuote(context, { draftId: "inspect-oci" })).ok).toBe(true);
    expect(runLock(context, { draftId: "inspect-oci" }).ok).toBe(true);
    expect((await runLaunch(context, { draftId: "inspect-oci" })).ok).toBe(true);
    const collected = await runCollect(context, { draftId: "inspect-oci" });
    expect(collected.ok, JSON.stringify(collected)).toBe(true);
    if (!collected.ok) throw new Error("unreachable");
    const matrix = parseMatrix(getSealedBytes(workspaceDir, collected.result.matrixSha256));
    expect(matrix.completeness).toMatchObject({ expected: 2, judged: 2, runOutcome: "complete" });
    expect(matrix.cells).toHaveLength(2);
    expect(matrix.cells.every((cell) => cell.outcome === "judged")).toBe(true);
    expect(matrix.cells.every((cell) => cell.verification.isolation === "unverifiable")).toBe(true);

    const runState = readRunState(workspaceDir, "inspect-oci");
    expect(runState?.matrixSha256).toBe(collected.result.matrixSha256);
    if (runState?.matrixSha256 === undefined) throw new Error("unreachable");
    const [firstCell, ...remainingCells] = matrix.cells;
    if (firstCell === undefined) throw new Error("unreachable");
    const dishonest = sealMatrix({
      ...matrix,
      cells: [{
        ...firstCell,
        verification: { ...firstCell.verification, isolation: "match" },
      }, ...remainingCells],
    });
    writeRunState(workspaceDir, "inspect-oci", {
      ...runState,
      matrixSha256: putSealedBytes(workspaceDir, dishonest.bytes),
    });
    const rejected = await runVerify(context, { draftId: "inspect-oci" });
    expect(rejected.ok).toBe(false);
    if (rejected.ok) throw new Error("unreachable");
    expect(rejected.error).toMatchObject({ code: "record-integrity" });
    expect(rejected.error.issues?.[0]?.path).toBe("matrix-rederivation");
  }, 180_000);

  test("cancellation reaps the OCI worker without leaving a container", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "benchmark-product-inspect-oci-cancel-"));
    workspaces.push(workspaceDir);
    const context: OperationContext = {
      workspaceDir,
      principal: "sponsor-1",
      clock: () => new Date().toISOString(),
    };
    expect(initWorkspace(context).ok).toBe(true);
    expect(createDraft(context, { draftId: "inspect-oci-cancel", name: "OCI cancellation fixture" }).ok).toBe(true);
    const selected = await selectInspectEvaluation(context, {
      draftId: "inspect-oci-cancel",
      execution: "oci",
      dockerPath,
      imageDigest: imageDigest!,
      projectDir: fixtureDir,
      datasetCacheDir: datasetCacheDir!,
      sandboxExecution: { provider: "jinn-oci", imageDigest: imageDigest!, platform: "linux/amd64" },
      taskReference: "hermetic_eval.py@hosted_sandbox_cancellation_eval",
      arms: [
        { armId: "control", model: "mockllm/model" },
        { armId: "candidate", model: "mockllm/model" },
      ],
      scorer: { name: "match", passValue: "C" },
      runOptions: { sampleId: "alpha", maxSamples: 1, retryOnError: 0 },
    });
    expect(selected.ok, JSON.stringify(selected)).toBe(true);
    expect((await runQuote(context, { draftId: "inspect-oci-cancel" })).ok).toBe(true);
    expect(runLock(context, { draftId: "inspect-oci-cancel" }).ok).toBe(true);
    let cancellation: ReturnType<typeof runCancel> | undefined;
    const launched = await runLaunch(context, { draftId: "inspect-oci-cancel" }, {
      onSolveAttemptNonterminal() {
        cancellation ??= runCancel(context, { draftId: "inspect-oci-cancel" });
      },
    });
    expect(launched.ok, JSON.stringify(launched)).toBe(true);
    expect(cancellation).toBeDefined();
    if (cancellation === undefined) throw new Error("unreachable");
    expect((await cancellation).ok).toBe(true);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
    const remaining = execFileSync(dockerPath, ["ps", "-a", "--filter", "name=jinn-inspect-", "--format", "{{.Names}}"], {
      encoding: "utf8",
    }).trim();
    expect(remaining).toBe("");
  }, 180_000);

  test("preserves a fake Responses call as a genuine Inspect transcript through detached verification", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "benchmark-product-inspect-broker-"));
    const hostDir = mkdtempSync(join(tmpdir(), "benchmark-product-inspect-broker-host-"));
    workspaces.push(workspaceDir, hostDir);
    const keyPath = join(hostDir, "openai-api-key");
    const responsePath = join(hostDir, "response.json");
    const sentinelPath = join(hostDir, "host-sentinel");
    const keySentinel = "sk-test-jinn-broker-sentinel-never-persist";
    writeFileSync(keyPath, keySentinel, { mode: 0o400 });
    chmodSync(keyPath, 0o400);
    writeFileSync(sentinelPath, "HOST_SENTINEL_MUST_NOT_BE_READ", { mode: 0o600 });
    writeFileSync(responsePath, JSON.stringify({
      id: "resp_jinn_fake_luna",
      object: "response",
      created_at: 0,
      status: "completed",
      error: null,
      incomplete_details: null,
      instructions: null,
      max_output_tokens: 128,
      model: "gpt-5.6-luna",
      output: [{
        id: "msg_jinn_fake_luna",
        type: "message",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text: "C", annotations: [], logprobs: [] }],
      }],
      parallel_tool_calls: false,
      previous_response_id: null,
      reasoning: { effort: "__request__", summary: null },
      service_tier: "default",
      store: false,
      temperature: null,
      text: { format: { type: "text" }, verbosity: "medium" },
      tool_choice: "none",
      tools: [],
      top_p: null,
      truncation: "disabled",
      usage: {
        input_tokens: 4,
        input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
        output_tokens: 1,
        output_tokens_details: { reasoning_tokens: 0 },
        total_tokens: 5,
      },
    }), { mode: 0o600 });
    const runtimeHost = createDefaultBenchmarkRuntimeHost({
      openAI: {
        keyFilePath: () => keyPath,
        responseFixturePathForTesting: () => responsePath,
      },
    });
    const context: OperationContext = {
      workspaceDir,
      principal: "sponsor-1",
      clock: () => new Date().toISOString(),
      runtimeHost,
    };
    expect(initWorkspace(context).ok).toBe(true);
    expect(createDraft(context, { draftId: "inspect-broker", name: "OCI Inspect broker fixture" }).ok).toBe(true);
    const provider = {
      surface: "openai-responses" as const,
      upstreamModel: "gpt-5.6-luna" as const,
      maxOutputTokens: 128 as const,
      store: false as const,
      background: false as const,
      stream: false as const,
      serviceTier: "default" as const,
      tools: [] as [],
      fallbackModels: [] as [],
      retries: 0 as const,
      persistedConversation: false as const,
      metadata: null,
      promptCacheIdentifier: null,
    };
    const selected = await selectInspectEvaluation(context, {
      draftId: "inspect-broker",
      execution: "oci",
      dockerPath,
      imageDigest: imageDigest!,
      projectDir: fixtureDir,
      datasetCacheDir: datasetCacheDir!,
      sandboxExecution: { provider: "jinn-oci", imageDigest: imageDigest!, platform: "linux/amd64" },
      taskReference: "hermetic_eval.py@broker_sandbox_isolation_eval",
      taskArgs: { host_sentinel_path: sentinelPath },
      arms: [
        { armId: "luna-none", model: "jinn-openai/gpt-5.6-luna", provider: { ...provider, reasoningEffort: "none" } },
        { armId: "luna-low", model: "jinn-openai/gpt-5.6-luna", provider: { ...provider, reasoningEffort: "low" } },
      ],
      scorer: { name: "hosted_sandbox_scorer", passValue: "C" },
      runOptions: { sampleId: "alpha", maxSamples: 1, retryOnError: 0 },
    });
    expect(selected.ok, JSON.stringify(selected)).toBe(true);
    if (!selected.ok) throw new Error("unreachable");
    const selectionManifestSha256 = selected.result.selectionManifestSha256;
    const preview = await runPreview(context, { draftId: "inspect-broker" });
    expect(preview.ok, JSON.stringify(preview)).toBe(true);
    const quote = await runQuote(context, { draftId: "inspect-broker" });
    expect(quote.ok, JSON.stringify(quote)).toBe(true);
    expect(runLock(context, { draftId: "inspect-broker" }).ok).toBe(true);
    expect((await runLaunch(context, { draftId: "inspect-broker" })).ok).toBe(true);
    const collected = await runCollect(context, { draftId: "inspect-broker" });
    expect(collected.ok, JSON.stringify(collected)).toBe(true);
    if (!collected.ok) throw new Error("unreachable");
    const matrix = parseMatrix(getSealedBytes(workspaceDir, collected.result.matrixSha256));
    const journal = readRunJournalEntries(workspaceDir, "inspect-broker");
    expect(matrix.completeness, JSON.stringify({ matrix, journal })).toMatchObject({ expected: 2, judged: 2, runOutcome: "complete" });
    expect(matrix.cells.every((cell) => cell.verification.isolation === "unverifiable")).toBe(true);
    const results = runResults(context, { draftId: "inspect-broker" });
    expect(results.ok, JSON.stringify(results)).toBe(true);
    if (!results.ok) throw new Error("unreachable");
    expect(results.result.venueHonesty.unverifiableAxisCounts.isolation).toBe(2);
    expect(results.result.venueHonesty.limits).toContainEqual(expect.stringContaining(
      "admits both unrestricted and OCI-container execution",
    ));
    const deliveries = journal.filter((entry) => entry.kind === "delivery");
    expect(deliveries).toHaveLength(2);
    for (const delivery of deliveries) {
      const summaryOutput = delivery.outputs.find((output) => output.name === "inspect-summary");
      expect(summaryOutput).toBeDefined();
      const summary = JSON.parse(new TextDecoder().decode(getSealedBytes(workspaceDir, summaryOutput!.sha256)));
      expect(summary.provider).toMatchObject({
        surface: "openai-responses",
        resolvedModel: "gpt-5.6-luna",
        callCount: 1,
        terminalStatus: "completed",
        brokerProtocol: "jinn.network/model-broker/1",
      });
      expect(summary.provider.eventDigest).toMatch(/^[a-f0-9]{64}$/u);
      expect(summary.sandbox).toMatchObject({
        provider: "jinn-oci",
        protocol: "jinn.network/inspect-sandbox-host/1",
        imageDigest,
        environmentCount: 1,
      });
    }
    const reported = await runReport(context, { draftId: "inspect-broker" });
    expect(reported.ok, JSON.stringify(reported)).toBe(true);
    if (!reported.ok) throw new Error("unreachable");
    const report = parseReport(getSealedBytes(workspaceDir, reported.result.reportSha256));
    expect(report.disclosures.perSubject[0]?.pinning.isolation).toEqual({
      match: 0,
      mismatch: 0,
      unverifiable: 2,
    });
    expect(reported.result.claimPackage.disclosures.pinningUnverifiableCounts.isolation).toBe(2);
    const venueHonesty = reported.result.claimPackage.venueHonesty as {
      unverifiableAxisCounts: { isolation: number };
    };
    expect(venueHonesty.unverifiableAxisCounts.isolation).toBe(2);
    expect(reported.result.claimPackage.limitations).toContainEqual(expect.stringContaining(
      "admits both unrestricted and OCI-container execution",
    ));
    expect((await runVerify(context, { draftId: "inspect-broker" })).ok).toBe(true);
    const published = await runPublish(context, { draftId: "inspect-broker", includeNativeArtifacts: true });
    expect(published.ok, JSON.stringify(published)).toBe(true);
    if (!published.ok) throw new Error("unreachable");
    const detachedRoot = mkdtempSync(join(tmpdir(), "benchmark-product-inspect-broker-bundle-"));
    workspaces.push(detachedRoot);
    const detachedBundle = join(detachedRoot, "bundle");
    cpSync(join(workspaceDir, published.result.bundleRelativePath), detachedBundle, { recursive: true });
    expect(JSON.stringify(readRunJournalEntries(workspaceDir, "inspect-broker"))).not.toContain(keySentinel);
    rmSync(workspaceDir, { recursive: true, force: true });
    expect((await verifyPublicBundle(detachedBundle)).checks).toContain("report-verification");
    const evidenceCatalog = JSON.parse(readFileSync(join(detachedBundle, "evidence.json"), "utf8")) as {
      records: Array<{ sha256: string; roles: string[] }>;
    };
    expect(evidenceCatalog.records).toContainEqual({
      sha256: selectionManifestSha256,
      roles: ["runtime-selection"],
    });
    expect(readFileSync(join(detachedBundle, "records", `${selectionManifestSha256}.bin`))).toBeDefined();
    const nativeDir = join(detachedBundle, "native", "inspect");
    expect(readdirSync(nativeDir)).toHaveLength(2);
    const officialRead = execFileSync(dockerPath, [
      "run", "--rm", "--pull=never", "--platform=linux/amd64", "--network=none",
      "--mount", `type=bind,src=${nativeDir},dst=/logs,readonly`,
      "--entrypoint=python", imageDigest!, "-c",
      "from inspect_ai.log import list_eval_logs,read_eval_log; logs=[read_eval_log(x) for x in list_eval_logs('/logs')]; assert len(logs)==2; assert all(x.status=='success' for x in logs); model_events=[e for x in logs for s in (x.samples or []) for e in (s.events or []) if e.event=='model']; sandbox_events=[e for x in logs for s in (x.samples or []) for e in (s.events or []) if e.event=='sandbox']; assert len(model_events)==2; assert len(sandbox_events)>=6; assert all(x.eval.sandbox.type=='jinn-oci' for x in logs); assert all(e.call and e.call.request['model']=='gpt-5.6-luna' and e.call.response['model']=='gpt-5.6-luna' for e in model_events)",
    ], { encoding: "utf8" });
    expect(officialRead).toBe("");
    const viewerOutputRoot = join(detachedRoot, "viewer-output");
    mkdirSync(viewerOutputRoot, { mode: 0o777 });
    chmodSync(viewerOutputRoot, 0o777);
    const viewerDir = join(viewerOutputRoot, "inspect-view-bundle");
    const viewerUid = process.getuid?.();
    const viewerGid = process.getgid?.();
    if (viewerUid === undefined || viewerGid === undefined) throw new Error("Inspect View OCI validation requires a POSIX host");
    execFileSync(dockerPath, [
      "run", "--rm", "--pull=never", "--platform=linux/amd64", "--network=none",
      "--user", `${viewerUid}:${viewerGid}`,
      "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges",
      "--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=67108864", "--env=HOME=/tmp/home",
      "--mount", `type=bind,src=${nativeDir},dst=/logs,readonly`,
      "--mount", `type=bind,src=${viewerOutputRoot},dst=/output`,
      "--entrypoint=inspect", imageDigest!, "view", "bundle", "--log-dir=/logs", "--output-dir=/output/inspect-view-bundle",
    ], { encoding: "utf8" });
    expect(readdirSync(viewerDir).length).toBeGreaterThan(0);
    for (const bytes of retainedBytes(detachedBundle)) {
      expect(bytes.includes(Buffer.from(keySentinel))).toBe(false);
      expect(bytes.includes(Buffer.from(keyPath))).toBe(false);
    }
    expect(readFileSync(responsePath, "utf8")).not.toContain(keySentinel);
    const remaining = execFileSync(dockerPath, ["ps", "-a", "--filter", "name=jinn-inspect-", "--format", "{{.Names}}"], { encoding: "utf8" }).trim();
    expect(remaining).toBe("");
    const networks = execFileSync(dockerPath, ["network", "ls", "--filter", "name=jinn-inspect-", "--format", "{{.Name}}"], { encoding: "utf8" }).trim();
    const volumes = execFileSync(dockerPath, ["volume", "ls", "--filter", "name=jinn-inspect-", "--format", "{{.Name}}"], { encoding: "utf8" }).trim();
    expect({ networks, volumes }).toEqual({ networks: "", volumes: "" });
  }, 300_000);
});
