import { chmodSync, cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { parseMatrix } from "@jinn-network/benchmarking-records";
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
import { runPublish } from "../../operations/publish.js";
import { runVerify } from "../../operations/verify.js";
import type { OperationContext } from "../../operations/context.js";
import { verifyPublicBundle } from "../../bundle/verify.js";
import { createDefaultBenchmarkRuntimeHost } from "../host-port.js";
import { readRunJournalEntries } from "../../run/journal.js";
import { getSealedBytes } from "../../workspace/sealed-store.js";

const imageDigest = process.env.JINN_INSPECT_OCI_IMAGE;
const datasetCacheDir = process.env.JINN_INSPECT_OCI_DATASET_CACHE;
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
      taskReference: "hermetic_eval.py@cancellation_eval",
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
      taskReference: "hermetic_eval.py@broker_isolation_eval",
      taskArgs: { host_sentinel_path: sentinelPath },
      arms: [
        { armId: "luna-none", model: "jinn-openai/gpt-5.6-luna", provider: { ...provider, reasoningEffort: "none" } },
        { armId: "luna-low", model: "jinn-openai/gpt-5.6-luna", provider: { ...provider, reasoningEffort: "low" } },
      ],
      scorer: { name: "match", passValue: "C" },
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
    }
    expect((await runReport(context, { draftId: "inspect-broker" })).ok).toBe(true);
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
      "from inspect_ai.log import list_eval_logs,read_eval_log; logs=[read_eval_log(x) for x in list_eval_logs('/logs')]; assert len(logs)==2; assert all(x.status=='success' for x in logs); events=[e for x in logs for s in (x.samples or []) for e in (s.events or []) if e.event=='model']; assert len(events)==2; assert all(e.call and e.call.request['model']=='gpt-5.6-luna' and e.call.response['model']=='gpt-5.6-luna' for e in events)",
    ], { encoding: "utf8" });
    expect(officialRead).toBe("");
    const viewerOutputRoot = join(detachedRoot, "viewer-output");
    mkdirSync(viewerOutputRoot, { mode: 0o777 });
    chmodSync(viewerOutputRoot, 0o777);
    const viewerDir = join(viewerOutputRoot, "inspect-view-bundle");
    execFileSync(dockerPath, [
      "run", "--rm", "--pull=never", "--platform=linux/amd64", "--network=none",
      "--user", `${process.getuid()}:${process.getgid()}`,
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
