import { parseBenchmark } from "@jinn-network/benchmarking-records";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { cellKey } from "@jinn-network/benchmarking-records";
import { createDraft } from "./drafts.js";
import { initWorkspace } from "./init.js";
import { selectInspectEvaluation } from "./inspect-runtime.js";
import { selectInspectAsSpecifiedRuntime } from "./inspect-as-specified.js";
import {
  decideInspectViewExportMode,
  exportInspectViewBundle,
} from "./inspect-view-export.js";
import { runLock } from "./run-lock.js";
import { runQuote } from "./run-quote.js";
import { requireRunState, writeRunState } from "../run/state.js";
import { appendRunJournalEntry } from "../run/journal.js";
import { createDefaultBenchmarkRuntimeHost } from "../runtime/host-port.js";
import {
  INSPECT_SELECTION_SCHEMA,
  InspectSelectionManifestSchema,
  SUPPORTED_INSPECT_VERSION,
  SUPPORTED_INSPECT_WHEEL_SHA256,
} from "../runtime/inspect/manifest.js";
import { InspectAsSpecifiedSelectionManifestSchema } from "../runtime/inspect-as-specified/manifest.js";
import { suiteFactsFromAccountedInspectRun } from "../runtime/suite-protocol/from-inspect.js";
import { getSealedBytes, putSealedBytes } from "../workspace/sealed-store.js";
import type { OperationContext } from "./context.js";
import type { LocalVenue } from "../venue/venue.js";
import {
  INSPECT_AS_SPECIFIED_NOT_LEADERBOARD_READY_LIMITATION,
  INSPECT_AS_SPECIFIED_SUBMIT_CLOSED_SENTENCE,
} from "../runtime/suite-protocol/comparability.js";

const catalogIds = [
  "HumanEval/0", "s01", "s02", "s03", "s04", "s05", "s06", "s07", "s08", "s09", "s10", "s11",
] as const;

const inspectManifest = InspectSelectionManifestSchema.parse({
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
    dataset: { name: "hermetic", location: null, samples: catalogIds.length },
  },
  arms: [
    { armId: "control", model: "mockllm/control" },
    { armId: "candidate", model: "mockllm/candidate" },
  ],
  scorer: { name: "match", passValue: "C", definition: { name: "match", options: {}, metrics: [] } },
  runOptions: { maxSamples: 1 },
});

function quoteVenue(): LocalVenue {
  return {
    backend: {
      async capabilities() {
        return {
          taskProfiles: [],
          inputMediaTypes: [],
          outputMediaTypes: [],
          cancel: false,
          watch: false,
          preflight: false,
          fetchArtifact: false,
          confidentialInputs: false,
          signedObservations: false,
          signedDeliveries: false,
          evidenceCapture: "none",
          deadlineEnforcement: false,
          isolation: ["unrestricted"],
          attempts: {},
          runPinning: {
            keys: [
              { key: "harness", inventory: ["inspect-ai"], posture: "enforced" },
              { key: "model", inventory: ["mockllm/control", "mockllm/candidate"], posture: "enforced" },
              { key: "jinn.network/inspect-arm", inventory: ["control", "candidate"], posture: "enforced" },
              { key: "isolationPolicy", inventory: ["unrestricted"], posture: "enforced" },
            ],
          },
        };
      },
      submit: async () => { throw new Error("not used by runQuote"); },
      observe: async () => { throw new Error("not used by runQuote"); },
      recover: async () => { throw new Error("not used by runQuote"); },
      deliveries: async () => [],
      fetchDelivery: async () => { throw new Error("not used by runQuote"); },
    } as unknown as LocalVenue["backend"],
    verdictKeyId: "stub-key",
    evaluators: [{ id: "urn:jinn:benchmark-product:local-venue:evaluator-1", keyId: "stub-key" }],
    prepareEvaluationCell: () => { throw new Error("not used by runQuote"); },
    async shutdown() {},
  };
}

function fakeHost(specifiedEpochs = 1) {
  const runtimeHost = createDefaultBenchmarkRuntimeHost();
  return {
    ...runtimeHost,
    assessAgentReadiness: () => [],
    catalogInspectTask: async () => ({
      sampleIds: [...catalogIds],
      specifiedEpochs,
      datasetName: "hermetic",
      datasetLocation: null,
      datasetSampleCount: catalogIds.length,
    }),
    resolveInspectSelection: async (input: { readonly runOptions?: { readonly sampleId?: string | number } }) => ({
      manifest: InspectSelectionManifestSchema.parse({
        ...inspectManifest,
        runOptions: {
          ...inspectManifest.runOptions,
          ...(input.runOptions?.sampleId === undefined ? {} : { sampleId: input.runOptions.sampleId }),
        },
        task: {
          ...inspectManifest.task,
          dataset: {
            ...inspectManifest.task.dataset,
            ...(input.runOptions?.sampleId === undefined ? {} : { selectedSampleId: input.runOptions.sampleId }),
          },
        },
      }),
      binding: { pythonPath: "/usr/bin/python3", projectDir: "/tmp/inspect-project" },
    }),
  };
}

const workspaces: string[] = [];

afterEach(() => {
  for (const workspace of workspaces.splice(0)) rmSync(workspace, { recursive: true, force: true });
});

function setup(draftId: string, specifiedEpochs = 1): OperationContext {
  const workspaceDir = mkdtempSync(join(tmpdir(), "benchmark-product-inspect-as-specified-"));
  workspaces.push(workspaceDir);
  const context: OperationContext = {
    workspaceDir,
    principal: "sponsor-1",
    clock: () => "2026-08-18T12:00:00.000Z",
    runtimeHost: fakeHost(specifiedEpochs),
  };
  expect(initWorkspace(context).ok).toBe(true);
  expect(createDraft(context, { draftId, name: draftId }).ok).toBe(true);
  return context;
}

function selectionJson(workspaceDir: string, digest: string): unknown {
  return JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(getSealedBytes(workspaceDir, digest)));
}

describe("decideInspectViewExportMode", () => {
  test("ready full is suite-named; named slices inspect; custom and non-conforming refuse", () => {
    expect(decideInspectViewExportMode({
      executionConformance: true, coverage: "full", leaderboardSubmitReady: true,
    })).toBe("suite-named");
    expect(decideInspectViewExportMode({
      executionConformance: true, coverage: "one_task", leaderboardSubmitReady: false,
    })).toBe("inspection-upload");
    expect(decideInspectViewExportMode({
      executionConformance: true, coverage: "ten_task", leaderboardSubmitReady: false,
    })).toBe("inspection-upload");
    expect(decideInspectViewExportMode({
      executionConformance: true, coverage: "custom", leaderboardSubmitReady: false,
    })).toBe("refused");
    expect(decideInspectViewExportMode({
      executionConformance: false, coverage: "full", leaderboardSubmitReady: false,
    })).toBe("refused");
  });
});

describe("Inspect-as-specified official-suite select", () => {
  test("named slices are lexicographic first 1 / first 10 / all; custom cannot be full", async () => {
    const context = setup("one");
    const one = await selectInspectAsSpecifiedRuntime(context, {
      draftId: "one",
      coverage: "one_task",
      pythonPath: "/usr/bin/python3",
      projectDir: "/tmp/inspect-project",
      taskReference: "eval.py@hermetic",
      arms: inspectManifest.arms,
      scorer: { name: "match", passValue: "C" },
    });
    expect(one.ok, JSON.stringify(one)).toBe(true);
    if (!one.ok) return;
    expect(one.result.draft.spec.replicates).toBe(1);
    expect(one.result.draft.spec.evaluationRuntime?.adapterId).toBe("inspect");
    const sealed = InspectAsSpecifiedSelectionManifestSchema.parse(selectionJson(context.workspaceDir, one.result.selectionManifestSha256));
    expect(sealed.suite.protocol).toBe("inspect-as-specified");
    expect(sealed.suite.selectedTaskNames).toEqual(["HumanEval/0"]);
    expect(sealed.selectedSamples).toEqual([{ sampleId: "HumanEval/0" }]);
    expect(parseBenchmark(getSealedBytes(context.workspaceDir, one.result.benchmarkSha256)).items).toHaveLength(1);

    const tenContext = setup("ten");
    const ten = await selectInspectAsSpecifiedRuntime(tenContext, {
      draftId: "ten",
      coverage: "ten_task",
      pythonPath: "/usr/bin/python3",
      projectDir: "/tmp/inspect-project",
      taskReference: "eval.py@hermetic",
      arms: inspectManifest.arms,
      scorer: { name: "match", passValue: "C" },
    });
    expect(ten.ok, JSON.stringify(ten)).toBe(true);
    if (!ten.ok) return;
    expect(parseBenchmark(getSealedBytes(tenContext.workspaceDir, ten.result.benchmarkSha256)).items).toHaveLength(10);

    const customContext = setup("custom");
    const custom = await selectInspectAsSpecifiedRuntime(customContext, {
      draftId: "custom",
      sampleIds: ["s11"],
      pythonPath: "/usr/bin/python3",
      projectDir: "/tmp/inspect-project",
      taskReference: "eval.py@hermetic",
      arms: inspectManifest.arms,
      scorer: { name: "match", passValue: "C" },
    });
    expect(custom.ok, JSON.stringify(custom)).toBe(true);
    if (!custom.ok) return;
    const customSealed = InspectAsSpecifiedSelectionManifestSchema.parse(
      selectionJson(customContext.workspaceDir, custom.result.selectionManifestSha256),
    );
    expect(customSealed.coverage).toBe("custom");
    expect(customSealed.suite.coverage).toBe("custom");
  });

  test("quote is protocol-conforming and not leaderboard_submit_ready; k follows specified epochs", async () => {
    const context = setup("quoted", 3);
    const selected = await selectInspectAsSpecifiedRuntime(context, {
      draftId: "quoted",
      coverage: "one_task",
      pythonPath: "/usr/bin/python3",
      projectDir: "/tmp/inspect-project",
      taskReference: "eval.py@hermetic",
      arms: inspectManifest.arms,
      scorer: { name: "match", passValue: "C" },
    });
    expect(selected.ok, JSON.stringify(selected)).toBe(true);
    if (!selected.ok) return;
    expect(selected.result.draft.spec.replicates).toBe(3);
    const quoted = await runQuote(context, { draftId: "quoted" }, { createVenue: () => quoteVenue() });
    expect(quoted.ok, JSON.stringify(quoted)).toBe(true);
    if (!quoted.ok) return;
    expect(quoted.result.presentation.suite).toEqual({
      executionConformance: true,
      coverage: "one_task",
      leaderboardSubmitReady: false,
      methodLeaderboardEligible: false,
      cellCount: "1 × 2 × 3",
      inspectVersion: SUPPORTED_INSPECT_VERSION,
      selectedTaskCount: 1,
      armCount: 2,
      replicates: 3,
    });
    expect(requireRunState(context.workspaceDir, "quoted").suiteQuote?.leaderboardSubmitReady).toBe(false);
  });

  test("full coverage quote is method-eligible and not ready; lock without those quote bits refuses", async () => {
    const context = setup("full");
    const selected = await selectInspectAsSpecifiedRuntime(context, {
      draftId: "full",
      coverage: "full",
      pythonPath: "/usr/bin/python3",
      projectDir: "/tmp/inspect-project",
      taskReference: "eval.py@hermetic",
      arms: inspectManifest.arms,
      scorer: { name: "match", passValue: "C" },
    });
    expect(selected.ok, JSON.stringify(selected)).toBe(true);
    if (!selected.ok) return;
    expect(parseBenchmark(getSealedBytes(context.workspaceDir, selected.result.benchmarkSha256)).items).toHaveLength(12);
    const quoted = await runQuote(context, { draftId: "full" }, { createVenue: () => quoteVenue() });
    expect(quoted.ok, JSON.stringify(quoted)).toBe(true);
    if (!quoted.ok) return;
    expect(quoted.result.presentation.suite).toMatchObject({
      coverage: "full",
      executionConformance: true,
      leaderboardSubmitReady: false,
      methodLeaderboardEligible: true,
      cellCount: "12 × 2 × 1",
    });
    expect(runLock(context, { draftId: "full" }).ok).toBe(true);

    const refuseContext = setup("full-refuse");
    const refuseSelected = await selectInspectAsSpecifiedRuntime(refuseContext, {
      draftId: "full-refuse",
      coverage: "full",
      pythonPath: "/usr/bin/python3",
      projectDir: "/tmp/inspect-project",
      taskReference: "eval.py@hermetic",
      arms: inspectManifest.arms,
      scorer: { name: "match", passValue: "C" },
    });
    expect(refuseSelected.ok, JSON.stringify(refuseSelected)).toBe(true);
    if (!refuseSelected.ok) return;
    const refuseQuoted = await runQuote(refuseContext, { draftId: "full-refuse" }, { createVenue: () => quoteVenue() });
    expect(refuseQuoted.ok, JSON.stringify(refuseQuoted)).toBe(true);
    const quotedState = requireRunState(refuseContext.workspaceDir, "full-refuse");
    const { suiteQuote: _omitted, ...withoutQuote } = quotedState;
    writeRunState(refuseContext.workspaceDir, "full-refuse", withoutQuote);
    const refused = runLock(refuseContext, { draftId: "full-refuse" });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.detail).toMatch(/Inspect-as-specified lock requires a quote/u);
  });

  test("solver override and sampleLimit are not executionConformance", async () => {
    const solverContext = setup("solver");
    const solver = await selectInspectAsSpecifiedRuntime(solverContext, {
      draftId: "solver",
      coverage: "full",
      solver: "custom-solver",
      pythonPath: "/usr/bin/python3",
      projectDir: "/tmp/inspect-project",
      taskReference: "eval.py@hermetic",
      arms: inspectManifest.arms,
      scorer: { name: "match", passValue: "C" },
    });
    expect(solver.ok, JSON.stringify(solver)).toBe(true);
    if (!solver.ok) return;
    const solverQuoted = await runQuote(solverContext, { draftId: "solver" }, { createVenue: () => quoteVenue() });
    expect(solverQuoted.ok, JSON.stringify(solverQuoted)).toBe(true);
    if (!solverQuoted.ok) return;
    expect(solverQuoted.result.presentation.suite?.executionConformance).toBe(false);

    const limitContext = setup("limit");
    const limited = await selectInspectAsSpecifiedRuntime(limitContext, {
      draftId: "limit",
      coverage: "full",
      sampleLimit: 4,
      pythonPath: "/usr/bin/python3",
      projectDir: "/tmp/inspect-project",
      taskReference: "eval.py@hermetic",
      arms: inspectManifest.arms,
      scorer: { name: "match", passValue: "C" },
    });
    expect(limited.ok, JSON.stringify(limited)).toBe(true);
    if (!limited.ok) return;
    const limitQuoted = await runQuote(limitContext, { draftId: "limit" }, { createVenue: () => quoteVenue() });
    expect(limitQuoted.ok, JSON.stringify(limitQuoted)).toBe(true);
    if (!limitQuoted.ok) return;
    expect(limitQuoted.result.presentation.suite?.executionConformance).toBe(false);
  });

  test("cousin inspect select has no suite object and cannot export as inspect-as-specified", async () => {
    const context = setup("cousin");
    const cousin = await selectInspectEvaluation(context, {
      draftId: "cousin",
      pythonPath: "/usr/bin/python3",
      projectDir: "/tmp/inspect-project",
      taskReference: "eval.py@hermetic",
      arms: inspectManifest.arms,
      scorer: { name: "match", passValue: "C" },
      runOptions: { sampleId: "alpha", maxSamples: 1 },
    });
    expect(cousin.ok, JSON.stringify(cousin)).toBe(true);
    if (!cousin.ok) return;
    const sealed = selectionJson(context.workspaceDir, cousin.result.selectionManifestSha256) as { protocol?: unknown; schema?: unknown };
    expect(sealed.protocol).toBeUndefined();
    expect(String(sealed.schema)).toMatch(/inspect-selection/u);
    const quoted = await runQuote(context, { draftId: "cousin" }, { createVenue: () => quoteVenue() });
    expect(quoted.ok, JSON.stringify(quoted)).toBe(true);
    if (!quoted.ok) return;
    expect(quoted.result.presentation.suite).toBeUndefined();
    expect(requireRunState(context.workspaceDir, "cousin").suiteQuote).toBeUndefined();
    expect(runLock(context, { draftId: "cousin" }).ok).toBe(true);
    const exported = exportInspectViewBundle(context, { draftId: "cousin", armId: "control" });
    expect(exported.ok).toBe(false);
    if (exported.ok) return;
    expect(exported.error.detail).toMatch(/cousin Inspect select cannot wear/u);
  });

  test("accounted sample × k cells may flip ready; a missing cell keeps the limitation", async () => {
    const context = setup("accounted", 2);
    const selected = await selectInspectAsSpecifiedRuntime(context, {
      draftId: "accounted",
      coverage: "full",
      pythonPath: "/usr/bin/python3",
      projectDir: "/tmp/inspect-project",
      taskReference: "eval.py@hermetic",
      arms: inspectManifest.arms,
      scorer: { name: "match", passValue: "C" },
    });
    expect(selected.ok, JSON.stringify(selected)).toBe(true);
    if (!selected.ok) return;
    const manifest = InspectAsSpecifiedSelectionManifestSchema.parse(
      selectionJson(context.workspaceDir, selected.result.selectionManifestSha256),
    );
    const completeCells = manifest.suite.items.flatMap((item) => (
      ["control", "candidate"].flatMap((armId) => (
        [1, 2].map((replicate) => ({
          cellKey: cellKey(item.taskSha256, armId, replicate),
          taskDigest: item.taskSha256,
          armId,
          replicate,
          outcome: "judged" as const,
        }))
      ))
    ));
    const ready = suiteFactsFromAccountedInspectRun({
      manifest,
      armCount: 2,
      itemCount: 12,
      replicates: 2,
      matrix: { cells: completeCells },
      armIds: ["control", "candidate"],
    });
    expect(ready.quote.leaderboardSubmitReady).toBe(true);
    expect(ready.limitation).toBeUndefined();
    const missing = suiteFactsFromAccountedInspectRun({
      manifest,
      armCount: 2,
      itemCount: 12,
      replicates: 2,
      matrix: { cells: completeCells.slice(1) },
      armIds: ["control", "candidate"],
    });
    expect(missing.quote.leaderboardSubmitReady).toBe(false);
    expect(missing.limitation).toBe(INSPECT_AS_SPECIFIED_NOT_LEADERBOARD_READY_LIMITATION);
  });

  test("named-slice View export is inspection-only; custom and non-conforming refuse", async () => {
    const context = setup("export-one");
    const selected = await selectInspectAsSpecifiedRuntime(context, {
      draftId: "export-one",
      coverage: "one_task",
      pythonPath: "/usr/bin/python3",
      projectDir: "/tmp/inspect-project",
      taskReference: "eval.py@hermetic",
      arms: inspectManifest.arms,
      scorer: { name: "match", passValue: "C" },
    });
    expect(selected.ok, JSON.stringify(selected)).toBe(true);
    if (!selected.ok) return;
    expect((await runQuote(context, { draftId: "export-one" }, { createVenue: () => quoteVenue() })).ok).toBe(true);
    expect(runLock(context, { draftId: "export-one" }).ok).toBe(true);
    const logBytes = new TextEncoder().encode("fake-eval-log");
    const logSha256 = putSealedBytes(context.workspaceDir, logBytes);
    const taskSha256 = InspectAsSpecifiedSelectionManifestSchema.parse(
      selectionJson(context.workspaceDir, selected.result.selectionManifestSha256),
    ).suite.items[0]!.taskSha256;
    appendRunJournalEntry(context.workspaceDir, "export-one", {
      kind: "delivery",
      at: "2026-08-18T12:00:01.000Z",
      cellKey: cellKey(taskSha256, "control", 1),
      dispatch: 1,
      attempt: "urn:jinn:attempt:1",
      deliverySha256: "3".repeat(64),
      outputs: [{ name: "inspect-log", sha256: logSha256 }],
    });
    const exported = exportInspectViewBundle(context, { draftId: "export-one", armId: "control" });
    expect(exported.ok, JSON.stringify(exported)).toBe(true);
    if (!exported.ok) return;
    expect(exported.result.mode).toBe("inspection-upload");
    expect(exported.result.instructions).toContain(INSPECT_AS_SPECIFIED_SUBMIT_CLOSED_SENTENCE);
    expect(existsSync(join(exported.result.exportDir, `${logSha256}.eval`))).toBe(true);
    expect(readFileSync(join(exported.result.exportDir, `${logSha256}.eval`))).toEqual(Buffer.from(logBytes));

    const customContext = setup("export-custom");
    const custom = await selectInspectAsSpecifiedRuntime(customContext, {
      draftId: "export-custom",
      sampleIds: ["s11"],
      pythonPath: "/usr/bin/python3",
      projectDir: "/tmp/inspect-project",
      taskReference: "eval.py@hermetic",
      arms: inspectManifest.arms,
      scorer: { name: "match", passValue: "C" },
    });
    expect(custom.ok, JSON.stringify(custom)).toBe(true);
    if (!custom.ok) return;
    expect((await runQuote(customContext, { draftId: "export-custom" }, { createVenue: () => quoteVenue() })).ok).toBe(true);
    expect(runLock(customContext, { draftId: "export-custom" }).ok).toBe(true);
    const customExport = exportInspectViewBundle(customContext, { draftId: "export-custom", armId: "control" });
    expect(customExport.ok).toBe(false);
    if (customExport.ok) return;
    expect(customExport.error.detail).toMatch(/custom coverage cannot wear/u);

    const solverContext = setup("export-solver");
    const solver = await selectInspectAsSpecifiedRuntime(solverContext, {
      draftId: "export-solver",
      coverage: "one_task",
      solver: "custom-solver",
      pythonPath: "/usr/bin/python3",
      projectDir: "/tmp/inspect-project",
      taskReference: "eval.py@hermetic",
      arms: inspectManifest.arms,
      scorer: { name: "match", passValue: "C" },
    });
    expect(solver.ok, JSON.stringify(solver)).toBe(true);
    if (!solver.ok) return;
    expect((await runQuote(solverContext, { draftId: "export-solver" }, { createVenue: () => quoteVenue() })).ok).toBe(true);
    expect(runLock(solverContext, { draftId: "export-solver" }).ok).toBe(true);
    const solverExport = exportInspectViewBundle(solverContext, { draftId: "export-solver", armId: "control" });
    expect(solverExport.ok).toBe(false);
    if (solverExport.ok) return;
    expect(solverExport.error.detail).toMatch(/not protocol-conforming/u);
  });
});
