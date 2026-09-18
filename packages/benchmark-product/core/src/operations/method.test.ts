import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { parseBenchmark } from "@jinn-network/benchmarking-records";
import { readAuditEntries } from "../audit/journal.js";
import {
  TERMINAL_BENCH_21_OFFICIAL_SLATE_EXTENSION,
  officialTerminalBench21TaskNames,
  terminalBench21SlateDigest,
} from "../intake/terminal-bench-2-1.js";
import { TERMINAL_BENCH_21_UPSTREAM_COMMIT } from "../intake/terminal-bench-2-1-slate.js";
import { getSealedBytes } from "../workspace/sealed-store.js";
import { armAdd } from "./arms.js";
import type { OperationContext } from "./context.js";
import { createDraft } from "./drafts.js";
import { initWorkspace } from "./init.js";
import { createDefaultBenchmarkRuntimeHost } from "../runtime/host-port.js";
import { InspectSelectionManifestSchema, SUPPORTED_INSPECT_VERSION, SUPPORTED_INSPECT_WHEEL_SHA256 } from "../runtime/inspect/manifest.js";
import { exportDerivedBundle, selectMethod } from "./method.js";
import { INSPECT_SELECTION_SCHEMA } from "./method-catalog.js";
import { runtimeHostsDir } from "../workspace/layout.js";

const coreSrc = join(dirname(fileURLToPath(import.meta.url)), "..");
const OFFICIAL_SUITE_DIRS = [
  "apex-agents",
  "apex-swe-dev",
  "deep-swe-v1.1",
  "swe-bench-verified",
  "terminal-bench-2",
  "terminal-bench-2-1",
  "terminal-bench-3-0",
] as const;

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

describe("draft-selection operations are gone", () => {
  test("runtime/<suite>/select.ts is not on disk for the official suites", () => {
    for (const suite of OFFICIAL_SUITE_DIRS) {
      expect(existsSync(join(coreSrc, "runtime", suite, "select.ts")), suite).toBe(false);
    }
  });

  test("method.bind does not import official-suite executeSelect* or host.js", () => {
    const source = readFileSync(join(coreSrc, "operations", "method.ts"), "utf8");
    expect(source).not.toMatch(/executeSelect(?:TerminalBench|Swebench|Apex|DeepSwe)/u);
    expect(source).not.toMatch(
      /from "\.\.\/runtime\/(?:apex-agents|apex-swe-dev|deep-swe-v1\.1|swe-bench-verified|terminal-bench-2|terminal-bench-2-1|terminal-bench-3-0)\/(?:select|host)\.js"/u,
    );
  });

  test("host tests do not call select*Runtime", () => {
    const selectRuntime = /select(?:TerminalBench|Swebench|Apex|DeepSwe)\w*Runtime/u;
    for (const suite of OFFICIAL_SUITE_DIRS) {
      const testFile = join(coreSrc, "runtime", suite, `${suite}.test.ts`);
      if (!existsSync(testFile)) continue;
      expect(readFileSync(testFile, "utf8"), suite).not.toMatch(selectRuntime);
    }
    expect(readFileSync(join(coreSrc, "runtime", "harbor", "harbor-batched.test.ts"), "utf8")).not.toMatch(selectRuntime);
  });
});

describe("selectMethod", () => {
  test("catalog bind seals catalog identity without host selection", async () => {
    const hostPath = join(root, "host.json");
    writeFileSync(hostPath, "{}");
    const context = await prepareDraft("one");
    const selected = await selectMethod(context, {
      draftId: "one",
      ref: "swe-bench-verified",
      cwd: root,
      slice: "1",
      hostPath,
    });
    expect(selected.ok, JSON.stringify(selected)).toBe(true);
    if (!selected.ok) return;
    expect(selected.result.catalogId).toBe("swe-bench-verified");
    expect(selected.result.documentKind).toBe("swe-bench-verified");
    expect(selected.result.official).toBe(true);
    expect(selected.result.selectionManifestSha256).toBeUndefined();
    expect(selected.result.benchmarkSha256).toBeUndefined();
    expect(selected.result.suiteProtocolSha256).toBeUndefined();
    expect(selected.result.draft.spec.evaluationRuntime).toBeUndefined();
    expect(selected.result.draft.spec.arms.map((arm) => arm.pinning)).toEqual([
      { harness: { id: "placeholder", version: "1" } },
      { harness: { id: "placeholder", version: "1" } },
    ]);
    expect(existsSync(runtimeHostsDir(workspaceDir)) ? readdirSync(runtimeHostsDir(workspaceDir)) : []).toEqual([]);
    const actions = readAuditEntries(workspaceDir).map((entry) => entry.action);
    expect(actions).toContain("method.bind");
    expect(actions).not.toContain("runtime.swe-bench-verified.select");
  });

  test("catalog terminal-bench-2.1 bind seals the official slate without Harbor select", async () => {
    const hostPath = join(root, "host.json");
    writeFileSync(hostPath, "{}");
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
    expect(selected.result.selectionManifestSha256).toBeUndefined();
    expect(selected.result.suiteProtocolSha256).toBeUndefined();
    expect(selected.result.draft.spec.evaluationRuntime).toBeUndefined();
    expect(selected.result.draft.spec.taskSet).toEqual({
      kind: "benchmark",
      benchmarkSha256: selected.result.benchmarkSha256,
    });
    const benchmark = parseBenchmark(getSealedBytes(workspaceDir, selected.result.benchmarkSha256!));
    expect(benchmark.items).toHaveLength(1);
    expect(benchmark.name).toBe("terminal-bench-2.1");
    const slate = benchmark[TERMINAL_BENCH_21_OFFICIAL_SLATE_EXTENSION] as {
      coverage: string;
      selectedTaskNames: string[];
      upstreamCommit: string;
      slateDigest: string;
      datasetTaskCount: number;
    };
    expect(slate).toMatchObject({
      coverage: "one_task",
      selectedTaskNames: [officialTerminalBench21TaskNames()[0]],
      upstreamCommit: TERMINAL_BENCH_21_UPSTREAM_COMMIT,
      slateDigest: terminalBench21SlateDigest(),
      datasetTaskCount: 89,
    });
    const actions = readAuditEntries(workspaceDir).map((entry) => entry.action);
    expect(actions).toContain("method.bind");
    expect(actions).not.toContain("runtime.terminal-bench-2-1.select");
  });

  test("catalog terminal-bench-2.1 --slice all is byte-stable official 89 and ignores host contents", async () => {
    const hostPath = join(root, "host.json");
    writeFileSync(hostPath, JSON.stringify({ executable: "/not-a-harbor" }));
    const firstContext = await prepareDraft("all");
    const first = await selectMethod(firstContext, {
      draftId: "all",
      ref: "terminal-bench-2.1",
      cwd: root,
      slice: "all",
      hostPath,
    });
    expect(first.ok, JSON.stringify(first)).toBe(true);
    if (!first.ok) return;
    const firstBenchmark = parseBenchmark(getSealedBytes(workspaceDir, first.result.benchmarkSha256!));
    expect(firstBenchmark.items).toHaveLength(89);
    expect(first.result.draft.spec.evaluationRuntime).toBeUndefined();
    const firstDigest = first.result.benchmarkSha256;

    rmSync(workspaceDir, { recursive: true, force: true });
    mkdirSync(workspaceDir);
    const secondContext = await prepareDraft("again");
    const second = await selectMethod(secondContext, {
      draftId: "again",
      ref: "terminal-bench-2.1",
      cwd: root,
      slice: "all",
      hostPath,
    });
    expect(second.ok, JSON.stringify(second)).toBe(true);
    if (!second.ok) return;
    expect(second.result.benchmarkSha256).toBe(firstDigest);
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
    const context: OperationContext = {
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
          binding: { pythonPath: "/not-reached/python", projectDir: "/not-reached/project" },
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
