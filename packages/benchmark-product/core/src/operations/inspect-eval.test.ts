import { parseBenchmark } from "@jinn-network/benchmarking-records";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { cellKey } from "@jinn-network/benchmarking-records";
import { createDraft, updateDraft } from "./drafts.js";
import { initWorkspace } from "./init.js";
import { selectInspectEvaluation } from "./inspect-runtime.js";
import { CLI_VERB_NAMES } from "../cli/main.js";
import { OPERATION_TO_ACTION, OPERATION_TO_VERB } from "../cli/parity-map.js";
import { selectInspectEvalRuntime } from "./inspect-eval.js";
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
import { InspectEvalSelectionManifestSchema } from "../runtime/inspect-eval/manifest.js";
import { suiteFactsFromAccountedInspectRun } from "../runtime/suite-protocol/from-inspect.js";
import { getSealedBytes, putSealedBytes, sha256Hex } from "../workspace/sealed-store.js";
import { INSPECT_TASK_PROFILE_URI } from "../runtime/inspect/artifacts.js";
import type { LocalProvisionerInput } from "@jinn-network/task-execution-backend-local";
import { createEvaluationCellRegistry, createLocalProvisioner } from "../venue/provisioner.js";
import type { OperationContext } from "./context.js";
import type { LocalVenue } from "../venue/venue.js";
import {
  INSPECT_EVAL_NOT_LEADERBOARD_READY_LIMITATION,
  INSPECT_EVAL_SUBMIT_CLOSED_SENTENCE,
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
  const workspaceDir = mkdtempSync(join(tmpdir(), "benchmark-product-inspect-eval-"));
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

describe("Inspect eval official-suite select", () => {
  test("Inspect task and Inspect eval CLI verbs are distinct", () => {
    expect(OPERATION_TO_VERB.selectInspectEvaluation).toBe("runtime inspect select");
    expect(OPERATION_TO_VERB.selectInspectEvalRuntime).toBe("runtime inspect eval select");
    expect(OPERATION_TO_VERB.exportInspectViewBundle).toBe("runtime inspect eval export");
    expect(OPERATION_TO_ACTION.selectInspectEvaluation).toBe("runtime.inspect.select");
    expect(OPERATION_TO_ACTION.selectInspectEvalRuntime).toBe("runtime.inspect.eval.select");
    expect(OPERATION_TO_ACTION.exportInspectViewBundle).toBe("runtime.inspect.eval.export");
    expect(CLI_VERB_NAMES).toContain("runtime inspect select");
    expect(CLI_VERB_NAMES).toContain("runtime inspect eval select");
    expect(CLI_VERB_NAMES).toContain("runtime inspect eval export");
  });

  test("named slices are lexicographic first 1 / first 10 / all; custom cannot be full", async () => {
    const context = setup("one");
    const one = await selectInspectEvalRuntime(context, {
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
    const sealed = InspectEvalSelectionManifestSchema.parse(selectionJson(context.workspaceDir, one.result.selectionManifestSha256));
    expect(sealed.suite.protocol).toBe("inspect-eval");
    expect(sealed.suite.selectedTaskNames).toEqual(["HumanEval/0"]);
    expect(sealed.selectedSamples).toEqual([{ sampleId: "HumanEval/0" }]);
    expect(parseBenchmark(getSealedBytes(context.workspaceDir, one.result.benchmarkSha256)).items).toHaveLength(1);

    const tenContext = setup("ten");
    const ten = await selectInspectEvalRuntime(tenContext, {
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
    const custom = await selectInspectEvalRuntime(customContext, {
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
    const customSealed = InspectEvalSelectionManifestSchema.parse(
      selectionJson(customContext.workspaceDir, custom.result.selectionManifestSha256),
    );
    expect(customSealed.coverage).toBe("custom");
    expect(customSealed.suite.coverage).toBe("custom");
  });

  test("quote is protocol-conforming and not leaderboard_submit_ready; k follows specified epochs", async () => {
    const context = setup("quoted", 3);
    const selected = await selectInspectEvalRuntime(context, {
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
    const selected = await selectInspectEvalRuntime(context, {
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
    const refuseSelected = await selectInspectEvalRuntime(refuseContext, {
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
    expect(refused.error.detail).toMatch(/Inspect eval lock requires a quote/u);
  });

  test("solver override and sampleLimit are not executionConformance", async () => {
    const solverContext = setup("solver");
    const solver = await selectInspectEvalRuntime(solverContext, {
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
    const limited = await selectInspectEvalRuntime(limitContext, {
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

  test("cousin inspect select has no suite object and cannot export as inspect-eval", async () => {
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
    expect(exported.error.detail).toMatch(/Inspect task select cannot wear/u);
  });

  test("accounted sample × k cells may flip ready; a missing cell keeps the limitation", async () => {
    const context = setup("accounted", 2);
    const selected = await selectInspectEvalRuntime(context, {
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
    const manifest = InspectEvalSelectionManifestSchema.parse(
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
    expect(missing.limitation).toBe(INSPECT_EVAL_NOT_LEADERBOARD_READY_LIMITATION);
  });

  test("the sealed catalog digest moves when the eval's declared epochs move", async () => {
    // The drift re-probe compares only `catalog.snapshotSha256`, so this digest moving is
    // exactly what makes a post-lock epochs change refuse("conflict"). Same samples, same
    // task source, different declared epochs.
    const digests: string[] = [];
    for (const specifiedEpochs of [1, 3]) {
      const draftId = `epochs-${specifiedEpochs}`;
      const context = setup(draftId, specifiedEpochs);
      const selected = await selectInspectEvalRuntime(context, {
        draftId,
        coverage: "full",
        pythonPath: "/usr/bin/python3",
        projectDir: "/tmp/inspect-project",
        taskReference: "eval.py@hermetic",
        arms: inspectManifest.arms,
        scorer: { name: "match", passValue: "C" },
      });
      expect(selected.ok, JSON.stringify(selected)).toBe(true);
      if (!selected.ok) return;
      const manifest = InspectEvalSelectionManifestSchema.parse(
        selectionJson(context.workspaceDir, selected.result.selectionManifestSha256),
      );
      expect(manifest.catalog.specifiedEpochs).toBe(specifiedEpochs);
      digests.push(manifest.catalog.snapshotSha256);
    }
    expect(digests[0]).not.toBe(digests[1]);
  });

  test("an under-run patched below specified epochs loses executionConformance at quote", async () => {
    const context = setup("under-run", 3);
    const selected = await selectInspectEvalRuntime(context, {
      draftId: "under-run",
      coverage: "full",
      pythonPath: "/usr/bin/python3",
      projectDir: "/tmp/inspect-project",
      taskReference: "eval.py@hermetic",
      arms: inspectManifest.arms,
      scorer: { name: "match", passValue: "C" },
    });
    expect(selected.ok, JSON.stringify(selected)).toBe(true);
    if (!selected.ok) return;
    expect(selected.result.draft.spec.replicates).toBe(3);
    const conforming = await runQuote(context, { draftId: "under-run" }, { createVenue: () => quoteVenue() });
    expect(conforming.ok, JSON.stringify(conforming)).toBe(true);
    if (!conforming.ok) return;
    expect(requireRunState(context.workspaceDir, "under-run").suiteQuote?.executionConformance).toBe(true);

    // `draft update` can move planned k after select; the sealed selection cannot see it.
    expect(updateDraft(context, { draftId: "under-run", patch: { replicates: 1 } }).ok).toBe(true);
    const patched = await runQuote(context, { draftId: "under-run" }, { createVenue: () => quoteVenue() });
    expect(patched.ok, JSON.stringify(patched)).toBe(true);
    if (!patched.ok) return;
    const quote = requireRunState(context.workspaceDir, "under-run").suiteQuote;
    expect(quote?.replicates).toBe(1);
    expect(quote?.executionConformance).toBe(false);
    expect(quote?.leaderboardSubmitReady).toBe(false);
  });

  test("the venue binds the executed Task bytes to the sealed selection's Task documents", async () => {
    const context = setup("venue-binding");
    const selected = await selectInspectEvalRuntime(context, {
      draftId: "venue-binding",
      coverage: "one_task",
      pythonPath: "/usr/bin/python3",
      projectDir: "/tmp/inspect-project",
      taskReference: "eval.py@hermetic",
      arms: inspectManifest.arms,
      scorer: { name: "match", passValue: "C" },
    });
    expect(selected.ok, JSON.stringify(selected)).toBe(true);
    if (!selected.ok) return;
    const manifest = InspectEvalSelectionManifestSchema.parse(
      selectionJson(context.workspaceDir, selected.result.selectionManifestSha256),
    );
    const sealedTaskSha256 = manifest.suite.items[0]!.taskSha256;
    const sealedTaskBytes = getSealedBytes(context.workspaceDir, sealedTaskSha256);

    const provisionerRoot = mkdtempSync(join(tmpdir(), "benchmark-product-inspect-eval-venue-"));
    workspaces.push(provisionerRoot);
    const select = createLocalProvisioner({
      registry: createEvaluationCellRegistry(),
      evaluators: [],
      inspect: {
        selectionManifestSha256: selected.result.selectionManifestSha256,
        manifest: manifest.inspect,
        host: { kind: "local-python", pythonPath: "/usr/bin/python3", projectDir: "/tmp/inspect-project" },
        inspectEval: manifest,
      },
    });
    const provisionerInput = (taskBytes: Uint8Array): LocalProvisionerInput => ({
      sealedTaskBytes: taskBytes,
      dispatchContextBytes: new TextEncoder().encode("{}"),
      task: {
        profile: { uri: INSPECT_TASK_PROFILE_URI },
        payload: { sampleId: "HumanEval/0" },
      } as unknown as LocalProvisionerInput["task"],
      submission: {
        nonce: `x:${cellKey(sealedTaskSha256, "control", 1)}:1`,
      } as unknown as LocalProvisionerInput["submission"],
      attempt: {
        attemptUri: "urn:uuid:00000000-0000-4000-8000-000000000009",
        nonce: "inspect-eval-venue-test",
        attemptNumber: 1,
      } as unknown as LocalProvisionerInput["attempt"],
    });
    const paths = (root: string) => ({
      root,
      input: join(root, "input"),
      work: join(root, "work"),
      out: join(root, "out"),
      logs: join(root, "logs"),
      harnessState: join(root, "harness-state"),
      secrets: join(root, "secrets"),
      tmp: join(root, "tmp"),
      meta: join(root, "meta"),
    });

    const honest = select(provisionerInput(sealedTaskBytes));
    await expect(honest.contract.setup(
      undefined as never,
      paths(join(provisionerRoot, "honest")) as never,
      [],
    )).resolves.toBeUndefined();

    // Same sampleId, same sealed selection, but Task documents this selection never sealed.
    const swapped = new TextEncoder().encode(`${new TextDecoder().decode(sealedTaskBytes)} `);
    expect(sha256Hex(swapped)).not.toBe(sealedTaskSha256);
    const tampered = select(provisionerInput(swapped));
    await expect(tampered.contract.setup(
      undefined as never,
      paths(join(provisionerRoot, "tampered")) as never,
      [],
    )).rejects.toThrow(/not one of the sealed selection's Task documents/u);
  });

  test("an over-run with every sealed cell judged still refuses leaderboard-ready", async () => {
    const context = setup("over-run", 3);
    const selected = await selectInspectEvalRuntime(context, {
      draftId: "over-run",
      coverage: "full",
      pythonPath: "/usr/bin/python3",
      projectDir: "/tmp/inspect-project",
      taskReference: "eval.py@hermetic",
      arms: inspectManifest.arms,
      scorer: { name: "match", passValue: "C" },
    });
    expect(selected.ok, JSON.stringify(selected)).toBe(true);
    if (!selected.ok) return;
    const manifest = InspectEvalSelectionManifestSchema.parse(
      selectionJson(context.workspaceDir, selected.result.selectionManifestSha256),
    );
    expect(manifest.suite.replicates).toBe(3);
    // Every cell the sealed selection accounts for (replicates 1..3) is judged, so
    // `cellsAccounted` is true — only the planned-k check can refuse this run.
    const sealedCells = manifest.suite.items.flatMap((item) => (
      ["control", "candidate"].flatMap((armId) => (
        [1, 2, 3].map((replicate) => ({
          cellKey: cellKey(item.taskSha256, armId, replicate),
          taskDigest: item.taskSha256,
          armId,
          replicate,
          outcome: "judged" as const,
        }))
      ))
    ));
    const overRun = suiteFactsFromAccountedInspectRun({
      manifest,
      armCount: 2,
      itemCount: 12,
      replicates: 5,
      matrix: { cells: sealedCells },
      armIds: ["control", "candidate"],
    });
    expect(overRun.quote.executionConformance).toBe(false);
    expect(overRun.quote.leaderboardSubmitReady).toBe(false);
    expect(overRun.limitation).toBe(INSPECT_EVAL_NOT_LEADERBOARD_READY_LIMITATION);
  });

  test("named-slice View export is inspection-only; custom and non-conforming refuse", async () => {
    const context = setup("export-one");
    const selected = await selectInspectEvalRuntime(context, {
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
    const taskSha256 = InspectEvalSelectionManifestSchema.parse(
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
    expect(exported.result.instructions).toContain(INSPECT_EVAL_SUBMIT_CLOSED_SENTENCE);
    expect(existsSync(join(exported.result.exportDir, `${logSha256}.eval`))).toBe(true);
    expect(readFileSync(join(exported.result.exportDir, `${logSha256}.eval`))).toEqual(Buffer.from(logBytes));

    const customContext = setup("export-custom");
    const custom = await selectInspectEvalRuntime(customContext, {
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
    const solver = await selectInspectEvalRuntime(solverContext, {
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
