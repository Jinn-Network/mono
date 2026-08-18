import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { readAuditEntries } from "../audit/journal.js";
import type { HarborSelectionManifest } from "../runtime/harbor/manifest.js";
import { computeHarbor021TaskContentHash } from "../runtime/terminal-bench-2/host.js";
import { TERMINAL_BENCH_2_1_DATASET_ID, TERMINAL_BENCH_2_1_DATASET_REF } from "../runtime/terminal-bench-2-1/manifest.js";
import { getSealedBytes } from "../workspace/sealed-store.js";
import { armAdd } from "./arms.js";
import type { OperationContext } from "./context.js";
import { createDraft } from "./drafts.js";
import { initWorkspace } from "./init.js";
import { createDefaultBenchmarkRuntimeHost } from "../runtime/host-port.js";
import { InspectSelectionManifestSchema, SUPPORTED_INSPECT_VERSION, SUPPORTED_INSPECT_WHEEL_SHA256 } from "../runtime/inspect/manifest.js";
import { exportDerivedBundle, selectMethod } from "./method.js";
import { INSPECT_SELECTION_SCHEMA } from "./method-catalog.js";

const names = ["t00", "t01", "t02", "t03", "t04", "t05", "t06", "t07", "t08", "t09", "t10", "t11"] as const;
const image = `registry.example/tb21@sha256:${"c".repeat(64)}`;
const arms: HarborSelectionManifest["arms"] = [
  { armId: "one", agent: { id: "terminus", configuration: {} }, model: { id: "openai/model-one", configuration: {} }, jobAgent: { name: "terminus", model_name: "openai/model-one" } },
  { armId: "two", agent: { id: "terminus", configuration: {} }, model: { id: "openai/model-two", configuration: {} }, jobAgent: { name: "terminus", model_name: "openai/model-two" } },
];
const outputs: HarborSelectionManifest["outputs"] = [{
  name: "prediction",
  mediaType: "application/json",
  artifact: { source: "/logs/artifacts/prediction.json", destination: "prediction.json" },
  nativePath: "artifacts/prediction.json",
}];

let root: string;
let workspaceDir: string;

function clock(): () => string {
  let tick = 0;
  const epoch = Date.now();
  return () => new Date(epoch + tick++ * 1_000).toISOString();
}

async function prepareDraft(draftId: string): Promise<OperationContext> {
  const context = { workspaceDir, principal: "sponsor-1", clock: clock() };
  expect(initWorkspace(context).ok).toBe(true);
  expect(createDraft(context, { draftId, name: draftId }).ok).toBe(true);
  expect(armAdd(context, { draftId, armId: "one", pinning: { harness: { id: "placeholder", version: "1" } } }).ok).toBe(true);
  expect(armAdd(context, { draftId, armId: "two", pinning: { harness: { id: "placeholder", version: "1" } } }).ok).toBe(true);
  return context;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "method-bind-"));
  workspaceDir = join(root, "workspace");
  mkdirSync(workspaceDir);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("selectMethod", () => {
  test("catalog terminal-bench-2.1 with --slice 1 seals the same protocol id as today's select", async () => {
    const executable = join(root, "harbor");
    writeFileSync(executable, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "--version" && args.length === 1) { process.stdout.write("harbor 0.21.4\\n"); process.exit(0); }
process.exit(64);
`, { mode: 0o700 });
    chmodSync(executable, 0o700);
    const materialPath = join(root, "selected-dataset");
    mkdirSync(materialPath, { recursive: true });
    for (const name of names) {
      mkdirSync(join(materialPath, name), { recursive: true });
      writeFileSync(join(materialPath, name, "task.toml"), `[task]\nname = "${name}"\n[environment]\ndocker_image = "${image}"\n`);
      writeFileSync(join(materialPath, name, "instruction.md"), `solve ${name}\n`);
    }
    const metadataPath = join(root, "dataset-metadata.json");
    writeFileSync(metadataPath, JSON.stringify({
      name: TERMINAL_BENCH_2_1_DATASET_ID,
      dataset_version_content_hash: TERMINAL_BENCH_2_1_DATASET_REF,
      task_ids: names.map((name) => ({
        org: "terminal-bench",
        name,
        ref: `sha256:${computeHarbor021TaskContentHash(join(materialPath, name)).contentHash}`,
      })),
    }));
    const hostPath = join(root, "host.json");
    writeFileSync(hostPath, JSON.stringify({
      executable,
      registryMetadataPath: metadataPath,
      datasetRevision: TERMINAL_BENCH_2_1_DATASET_REF,
      taskMaterialPath: materialPath,
      nConcurrent: 1,
      arms,
      environment: { type: "docker", image, configuration: {} },
      outputs,
    }));
    const context = await prepareDraft("one");
    const selected = await selectMethod(context, {
      draftId: "one",
      ref: "terminal-bench-2.1",
      cwd: root,
      slice: "1",
      hostPath,
    });
    expect(selected.ok, JSON.stringify(selected)).toBe(true);
    if (!selected.ok) return;
    expect(selected.result.catalogId).toBe("terminal-bench-2.1");
    expect(selected.result.official).toBe(true);
    const suite = JSON.parse(new TextDecoder().decode(getSealedBytes(workspaceDir, selected.result.suiteProtocolSha256!))) as { protocol: string; coverage: string };
    expect(suite.protocol).toBe("terminal-bench-2.1");
    expect(suite.coverage).toBe("one_task");
    expect(readAuditEntries(workspaceDir).some((entry) => entry.action === "method.bind")).toBe(true);
  });

  test("custom Inspect file does not wear a suite id; derived export refuses a suite-named bundle", async () => {
    const filePath = join(root, "inspect.json");
    writeFileSync(filePath, JSON.stringify({
      schema: INSPECT_SELECTION_SCHEMA,
      pythonPath: "/not-reached/python",
      projectDir: "/not-reached/project",
      taskReference: "task.py@task",
      scorer: { name: "match", passValue: "C" },
      arms: [
        { armId: "control", model: "mockllm/model" },
        { armId: "candidate", model: "mockllm/model" },
      ],
    }));
    const host = createDefaultBenchmarkRuntimeHost();
    const context = {
      ...(await prepareDraft("inspect")),
      runtimeHost: {
        ...host,
        resolveInspectSelection: async () => ({
          manifest: InspectSelectionManifestSchema.parse({
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
              reference: "task.py@task",
              args: {},
              resolvedName: "task",
              resolvedVersion: "1.0",
              resolvedSandbox: null,
              source: {
                kind: "project-file",
                path: "task.py",
                sha256: "b".repeat(64),
                projectTreeSha256: "f".repeat(64),
              },
              dataset: { name: "task", location: null, samples: 1 },
            },
            arms: [
              { armId: "control", model: "mockllm/model" },
              { armId: "candidate", model: "mockllm/model" },
            ],
            scorer: { name: "match", passValue: "C", definition: { name: "match", options: {}, metrics: [] } },
            runOptions: { maxSamples: 1 },
          }),
          binding: { kind: "local-python", pythonPath: "/not-reached/python", projectDir: "/not-reached/project" },
        }),
      },
    };
    const selected = await selectMethod(context, { draftId: "inspect", ref: filePath, cwd: root });
    expect(selected.ok, JSON.stringify(selected)).toBe(true);
    if (!selected.ok) return;
    expect(selected.result.official).toBe(false);
    expect(selected.result.catalogId).toBeUndefined();
    expect(selected.result.suiteProtocolSha256).toBeUndefined();
    expect(selected.result.draft.spec.evaluationRuntime?.adapterId).toBe("inspect");
    const exported = exportDerivedBundle(context, { draftId: "inspect", armId: "control" });
    expect(exported.ok).toBe(false);
    if (exported.ok) return;
    expect(exported.error.code).toBe("conflict");
    expect(exported.error.detail).toMatch(/Inspect methods have no suite-named/i);
  });
});
