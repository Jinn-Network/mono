// SPDX-License-Identifier: Apache-2.0

/**
 * The `suite-comparability` re-derivation and its refusals (issues #4759, #4761, #4762), over
 * synthetic selections, Runs, Matrices and evidence trees.
 *
 * The product core's own tests walk real suite-bound runs through `report` and `publish`; this file
 * covers what a fixture run cannot reach: the official dataset sizes (500 SWE-bench Verified
 * instances, 480 APEX-Agents tasks) and every missing-file branch of every protocol, and each
 * refusal `resolveCarriedSuite` makes.
 */

import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import { cellKey } from "@jinn-network/benchmarking-records";
import { canonicalJsonBytes } from "@jinn-network/trust-core";
import { BenchmarkProductError } from "./errors.js";
import { INSPECT_SELECTION_CORRELATION_ROLE } from "./binary-judge-manifest.js";
import { SUPPORTED_INSPECT_VERSION } from "./inspect-manifest.js";
import {
  ARCHIPELAGO_ADAPTER_ID,
  ARCHIPELAGO_COMMIT_PIN,
  APEX_AGENTS_DEFAULT_MAX_STEPS,
  APEX_AGENTS_DEFAULT_TIMEOUT_SECONDS,
  APEX_AGENTS_JUDGE_MODEL,
  APEX_AGENTS_JUDGE_THINKING,
  APEX_AGENTS_REACT_AGENT_ID,
  SWE_BENCH_HARNESS_ADAPTER_ID,
  suiteLeaderboardLimitation,
  type SuiteProtocolId,
} from "./suite-comparability.js";
import { SUITE_PROTOCOL_PROFILE, SUITE_PROTOCOL_SELECTION_ROLE, SuiteProtocolSelectionSchema, type SuiteProtocolSelection } from "./suite-protocol-selection.js";
import {
  APEX_AGENTS_LEADERBOARD_DATASET_REVISION,
  APEX_AGENTS_SELECTION_ROLE,
  APEX_SWE_DEV_SELECTION_ROLE,
  DEEP_SWE_V11_LEADERBOARD_GIT_SHA,
  DEEP_SWE_V11_LEADERBOARD_TASKS_TREE_SHA,
  HARBOR_SELECTION_ROLE,
  INSPECT_EVAL_SELECTION_SCHEMA,
  SUITE_EVIDENCE_BUNDLE_MEMBER,
  SWE_BENCH_VERIFIED_LEADERBOARD_DATASET_REVISION,
  SWE_BENCH_VERIFIED_SELECTION_ROLE,
  TERMINAL_BENCH_2_1_LEADERBOARD_DATASET_REF,
  TERMINAL_BENCH_3_0_LEADERBOARD_DATASET_REF,
  archipelagoGradeRelativePath,
  assertInspectEvalTask,
  buildSuiteEvidenceIndex,
  deriveSuiteComparabilityFromEvidence,
  readRegisteredSuiteSelection,
  resolveCarriedSuite,
  suiteEvidenceTreeFromFiles,
  suiteSelectionBytes,
  swebenchHarnessReportRelativePath,
  swebenchRunId,
  type RegisteredSuiteSelection,
} from "./suite-evidence.js";

const RUN_SHA256 = "a".repeat(64);
const ARMS = [{ armId: "one", pinning: {} }, { armId: "two", pinning: {} }] as const;
const encode = (value: unknown): Uint8Array => canonicalJsonBytes(value as never);
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const taskSha = (name: string): string => sha256(new TextEncoder().encode(name));

function suite(protocol: SuiteProtocolId, names: readonly string[], overrides: Record<string, unknown> = {}): SuiteProtocolSelection {
  const shared = {
    schema: "jinn.network/benchmark-product/suite-protocol-selection/1",
    coverage: "full",
    selectedTaskNames: [...names],
    datasetTaskCount: names.length,
    items: names.map((taskName) => ({ taskName, taskSha256: taskSha(taskName) })),
  };
  const byProtocol: Record<SuiteProtocolId, Record<string, unknown>> = {
    "terminal-bench-2.1": { datasetId: "terminal-bench/terminal-bench-2-1", datasetRevision: TERMINAL_BENCH_2_1_LEADERBOARD_DATASET_REF, replicates: 5, atifRequired: true },
    "terminal-bench-3.0": { datasetId: "terminal-bench/terminal-bench", datasetRevision: TERMINAL_BENCH_3_0_LEADERBOARD_DATASET_REF, replicates: 5, atifRequired: true },
    "deep-swe-v1.1": { datasetId: "deep-swe", datasetRevision: DEEP_SWE_V11_LEADERBOARD_GIT_SHA, tasksTreeSha: DEEP_SWE_V11_LEADERBOARD_TASKS_TREE_SHA, replicates: 4, atifRequired: true },
    "swe-bench-verified": { datasetId: "swe-bench-verified", datasetRevision: SWE_BENCH_VERIFIED_LEADERBOARD_DATASET_REVISION, replicates: 1, atifRequired: false },
    "apex-agents": { datasetId: "apex-agents", datasetRevision: APEX_AGENTS_LEADERBOARD_DATASET_REVISION, replicates: 1, atifRequired: false },
    "apex-swe-dev": { datasetId: "apex-swe-dev", datasetRevision: "b".repeat(40), replicates: 1, atifRequired: false },
    "inspect-eval": { datasetId: "hermetic", datasetRevision: "c".repeat(64), replicates: 1, atifRequired: false },
  };
  const items = protocol === "apex-swe-dev"
    ? { items: names.map((taskName) => ({ taskName, taskSha256: taskSha(taskName), taskType: "integration" })) }
    : {};
  return SuiteProtocolSelectionSchema.parse({ ...shared, protocol, ...byProtocol[protocol], ...items, ...overrides });
}

function matrixFor(selection: SuiteProtocolSelection, outcome: (armId: string, replicate: number) => string = () => "judged") {
  return {
    cells: ARMS.flatMap(({ armId }) => selection.items.flatMap((item) =>
      Array.from({ length: selection.replicates }, (_, index) => ({
        cellKey: cellKey(item.taskSha256, armId, index + 1),
        taskDigest: item.taskSha256,
        armId,
        replicate: index + 1,
        outcome: outcome(armId, index + 1),
      })))),
  };
}

function harborSelection(selected: SuiteProtocolSelection, overrides: Record<string, unknown> = {}): RegisteredSuiteSelection {
  const pier = selected.protocol === "deep-swe-v1.1";
  return {
    kind: "harbor",
    manifest: {
      adapter: { id: pier ? "pier" : "harbor" },
      harbor: { version: pier ? "0.3.1" : "0.21.4" },
      environment: { type: "docker", configuration: {} },
      retryPolicy: { nAttempts: selected.replicates, maxRetries: 3 },
      jobGrain: "per-arm",
      arms: [{ jobAgent: { name: pier ? "mini-swe-agent" : "terminus" } }],
      ...overrides,
    },
    suite: selected,
  };
}

/** One trial per task and attempt per arm, each with a config, ATIF, and for DeepSWE a reward. */
function harborJob(selected: SuiteProtocolSelection, omit: (path: string) => boolean = () => false): Map<string, Map<string, Uint8Array>> {
  const roots = new Map<string, Map<string, Uint8Array>>();
  for (const { armId } of ARMS) {
    const files = new Map<string, Uint8Array>();
    let index = 0;
    for (const item of selected.items) {
      for (let attempt = 1; attempt <= selected.replicates; attempt += 1) {
        index += 1;
        const trial = `trial-${index}`;
        files.set(`${trial}/config.json`, encode({ task: { name: item.taskName }, attempt }));
        files.set(`${trial}/agent/trajectory.json`, encode({ schema: "ATIF" }));
        files.set(`${trial}/result.json`, encode({ status: "success" }));
        if (selected.protocol === "deep-swe-v1.1") files.set(`${trial}/verifier/reward.json`, encode({ reward: 1 }));
      }
    }
    for (const path of [...files.keys()]) if (omit(`${armId}:${path}`)) files.delete(path);
    roots.set(`harbor-job/${armId}`, files);
  }
  return roots;
}

function derive(selection: RegisteredSuiteSelection, roots: Map<string, Map<string, Uint8Array>>, matrix = matrixFor(selection.suite), replicates = selection.suite.replicates) {
  return deriveSuiteComparabilityFromEvidence({
    selection,
    arms: ARMS,
    replicates,
    runSha256: RUN_SHA256,
    matrix,
    tree: (root) => suiteEvidenceTreeFromFiles(roots.get(root) ?? new Map()),
  });
}

describe("the Harbor-family flag is re-derived from each judged trial's files", () => {
  test.each(["terminal-bench-2.1", "terminal-bench-3.0", "deep-swe-v1.1"] as const)("%s: ready with every file, not ready without one", (protocol) => {
    const names = protocol === "deep-swe-v1.1" ? Array.from({ length: 113 }, (_, index) => `t${index}`) : ["task-a"];
    const selected = suite(protocol, names);
    const ready = derive(harborSelection(selected), harborJob(selected));
    expect(ready.comparability).toEqual({ executionConformance: true, coverage: "full", leaderboardSubmitReady: true });
    expect(ready.limitation).toBeUndefined();
    // The trial configs, the ATIF files, and DeepSWE's rewards; never `result.json`.
    expect(ready.evidence.some((file) => file.path.endsWith("result.json"))).toBe(false);
    expect(ready.evidence.filter((file) => file.path.endsWith("config.json"))).toHaveLength(2 * names.length * selected.replicates);

    const noAtif = derive(harborSelection(selected), harborJob(selected, (path) => path === "two:trial-2/agent/trajectory.json"));
    expect(noAtif.comparability.leaderboardSubmitReady).toBe(false);
    expect(noAtif.limitation).toBe(suiteLeaderboardLimitation(noAtif.comparability, protocol));
    // A trial whose config is missing has no trial a reader can find for its cell.
    const noConfig = derive(harborSelection(selected), harborJob(selected, (path) => path === "one:trial-1/config.json"));
    expect(noConfig.comparability.leaderboardSubmitReady).toBe(false);
  });

  test("deep-swe-v1.1: a judged trial without reward.json is not ready", () => {
    const selected = suite("deep-swe-v1.1", Array.from({ length: 113 }, (_, index) => `t${index}`));
    const derived = derive(harborSelection(selected), harborJob(selected, (path) => path === "one:trial-7/verifier/reward.json"));
    expect(derived.comparability.leaderboardSubmitReady).toBe(false);
  });

  test("two trials claiming one task and attempt resolve to none, so the cell has no ATIF", () => {
    const selected = suite("terminal-bench-2.1", ["task-a"]);
    const roots = harborJob(selected);
    roots.get("harbor-job/one")!.set("trial-dup/config.json", encode({ task: { name: "task-a" }, attempt: 1 }));
    expect(derive(harborSelection(selected), roots).comparability.leaderboardSubmitReady).toBe(false);
  });

  test("an ineligible method carries no evidence and is not ready whatever its files say", () => {
    const selected = suite("terminal-bench-2.1", ["task-a"]);
    const derived = derive(harborSelection(selected, { retryPolicy: { nAttempts: 5, maxRetries: 0 } }), harborJob(selected));
    expect(derived.comparability).toEqual({ executionConformance: false, coverage: "full", leaderboardSubmitReady: false });
    expect(derived.evidence).toEqual([]);
  });

  test("an unaccounted cell carries no evidence and is not ready", () => {
    const selected = suite("terminal-bench-2.1", ["task-a"]);
    const derived = derive(harborSelection(selected), harborJob(selected), matrixFor(selected, (armId, replicate) => armId === "one" && replicate === 2 ? "expired" : "judged"));
    expect(derived.comparability.leaderboardSubmitReady).toBe(false);
    expect(derived.evidence).toEqual([]);
  });
});

describe("SWE-bench Verified and APEX-Agents re-derive the flag at their official sizes", () => {
  const swebench = (selected: SuiteProtocolSelection): RegisteredSuiteSelection => ({
    kind: "swe-bench-verified",
    manifest: {
      harness: { adapterId: SWE_BENCH_HARNESS_ADAPTER_ID, version: "4.1.0", timeoutSeconds: 1800, timeoutOverride: false, resourceOverride: false },
      suite: selected,
    },
    suite: selected,
  });

  function swebenchReports(selected: SuiteProtocolSelection, predictions: Uint8Array | undefined, omit?: string): Map<string, Map<string, Uint8Array>> {
    const runId = swebenchRunId(RUN_SHA256, sha256(predictions ?? new Uint8Array()));
    const files = new Map<string, Uint8Array>();
    if (predictions !== undefined) files.set("predictions.jsonl", predictions);
    for (const { armId } of ARMS) {
      for (const instanceId of selected.selectedTaskNames) {
        const path = swebenchHarnessReportRelativePath({ runId, modelNameOrPath: armId, instanceId });
        if (path !== omit) files.set(path, encode({ instance_id: instanceId, resolved: false }));
      }
    }
    return new Map([["swebench-harness", files]]);
  }

  const instances = Array.from({ length: 500 }, (_, index) => `instance-${index}`);

  test("swe-bench-verified: 500 instances with every report are ready; one missing report, or reports under another run_id, are not", () => {
    const selected = suite("swe-bench-verified", instances);
    const predictions = new TextEncoder().encode("{}\n");
    const ready = derive(swebench(selected), swebenchReports(selected, predictions), matrixFor(selected, () => "unscorable"));
    expect(ready.comparability.leaderboardSubmitReady).toBe(true);
    expect(ready.evidence).toHaveLength(1 + 2 * 500);
    expect(ready.evidence[0]).toEqual({ root: "swebench-harness", path: "predictions.jsonl" });

    const runId = swebenchRunId(RUN_SHA256, sha256(predictions));
    const missing = swebenchHarnessReportRelativePath({ runId, modelNameOrPath: "two", instanceId: "instance-7" });
    const notReady = derive(swebench(selected), swebenchReports(selected, predictions, missing), matrixFor(selected, () => "unscorable"));
    expect(notReady.comparability.leaderboardSubmitReady).toBe(false);
    expect(notReady.limitation).toBe(suiteLeaderboardLimitation(notReady.comparability, "swe-bench-verified"));

    // The run_id is derived from the predictions' digest, so reports filed under a run_id the
    // carried predictions do not produce are not the run's reports.
    const reports = swebenchReports(selected, predictions);
    reports.get("swebench-harness")!.set("predictions.jsonl", new TextEncoder().encode("{\"other\":true}\n"));
    expect(derive(swebench(selected), reports, matrixFor(selected, () => "unscorable")).comparability.leaderboardSubmitReady).toBe(false);
  });

  test("swe-bench-verified: a snapshot short of the 500-instance pin is never ready", () => {
    const selected = suite("swe-bench-verified", instances.slice(0, 12));
    const derived = derive(swebench(selected), swebenchReports(selected, undefined), matrixFor(selected, () => "unscorable"));
    expect(derived.comparability.leaderboardSubmitReady).toBe(false);
    expect(derived.evidence).toEqual([]);
  });

  test("apex-agents: 480 tasks with every grade are ready; one missing grade is not", () => {
    const tasks = Array.from({ length: 480 }, (_, index) => `task_${index}`);
    const selected = suite("apex-agents", tasks);
    const selection: RegisteredSuiteSelection = {
      kind: "apex-agents",
      manifest: {
        archipelago: {
          adapterId: ARCHIPELAGO_ADAPTER_ID,
          commit: ARCHIPELAGO_COMMIT_PIN,
          agentId: APEX_AGENTS_REACT_AGENT_ID,
          maxSteps: APEX_AGENTS_DEFAULT_MAX_STEPS,
          timeoutSeconds: APEX_AGENTS_DEFAULT_TIMEOUT_SECONDS,
          judgeModel: APEX_AGENTS_JUDGE_MODEL,
          judgeThinking: APEX_AGENTS_JUDGE_THINKING,
          webSearch: false,
          timeoutOverride: false,
          resourceOverride: false,
        },
        suite: selected,
      },
      suite: selected,
    };
    const grades = (omit?: string) => new Map([["archipelago", new Map(tasks
      .filter((taskId) => taskId !== omit)
      .map((taskId) => [archipelagoGradeRelativePath(taskId), encode({ task_id: taskId, passed: true })] as const))]]);
    const ready = derive(selection, grades(), matrixFor(selected, () => "judged"));
    expect(ready.comparability.leaderboardSubmitReady).toBe(true);
    expect(ready.evidence).toHaveLength(480);
    const notReady = derive(selection, grades("task_9"), matrixFor(selected, () => "judged"));
    expect(notReady.comparability.leaderboardSubmitReady).toBe(false);
    expect(notReady.limitation).toBe(suiteLeaderboardLimitation(notReady.comparability, "apex-agents"));
  });
});

describe("APEX-SWE-dev and Inspect eval decide the flag without evidence files", () => {
  test("apex-swe-dev is never ready and carries nothing", () => {
    const selected = suite("apex-swe-dev", ["1-int-00"]);
    const derived = derive({
      kind: "apex-swe-dev",
      manifest: {
        dataset: { revision: "b".repeat(40) },
        harness: { adapterId: "apex-swe-dev", nTrials: 1, timeoutSeconds: 3600, timeoutOverride: false, resourceOverride: false, messageLimit: 250 },
        suite: selected,
      },
      suite: selected,
    }, new Map(), matrixFor(selected, () => "judged"));
    expect(derived.comparability).toEqual({ executionConformance: true, coverage: "full", leaderboardSubmitReady: false });
    expect(derived.evidence).toEqual([]);
  });

  test("inspect-eval is ready when every planned cell is accounted, and not when one is not", () => {
    const selected = suite("inspect-eval", ["s0", "s1"]);
    const selection: RegisteredSuiteSelection = {
      kind: "inspect-eval",
      manifest: {
        inspect: { runtime: { inspectVersion: SUPPORTED_INSPECT_VERSION }, runOptions: {} },
        catalog: { specifiedEpochs: 1, snapshotSha256: "c".repeat(64) },
        solver: "task-default",
        sampleLimit: null,
        suite: selected,
      },
      suite: selected,
      selectedSampleIds: ["s0", "s1"],
    };
    const ready = derive(selection, new Map(), matrixFor(selected, () => "unscorable"), 1);
    expect(ready.comparability.leaderboardSubmitReady).toBe(true);
    expect(ready.limitation).toBe(suiteLeaderboardLimitation(ready.comparability, "inspect-eval"));
    const notReady = derive(selection, new Map(), matrixFor(selected, (armId) => armId === "two" ? "expired" : "unscorable"), 1);
    expect(notReady.comparability.leaderboardSubmitReady).toBe(false);
    // The planned k, not the sealed one, decides conformance.
    expect(derive(selection, new Map(), matrixFor(selected, () => "unscorable"), 2).comparability.executionConformance).toBe(false);
  });
});

describe("reading a Run's registered selection", () => {
  const selected = suite("terminal-bench-2.1", ["task-a"]);
  const manifest = {
    adapter: { id: "harbor", version: "1" },
    harbor: { version: "0.21.4", executableSha256: "d".repeat(64) },
    environment: { type: "docker", image: `x@sha256:${"e".repeat(64)}`, configuration: {} },
    retryPolicy: { nAttempts: 5, nConcurrent: 1, maxRetries: 3 },
    jobGrain: "per-arm",
    arms: [{ armId: "one", jobAgent: { name: "terminus", model_name: "m" } }],
    profiles: { [SUITE_PROTOCOL_PROFILE]: selected },
  };

  test("a Harbor manifest binds the suite its profile seals; one with no suite profile binds none", () => {
    expect(readRegisteredSuiteSelection(HARBOR_SELECTION_ROLE, encode(manifest), "m")?.suite.protocol).toBe("terminal-bench-2.1");
    expect(readRegisteredSuiteSelection(HARBOR_SELECTION_ROLE, encode({ ...manifest, profiles: {} }), "m")).toBeUndefined();
  });

  test("an Inspect selection that is not an Inspect eval binds no suite", () => {
    expect(readRegisteredSuiteSelection(INSPECT_SELECTION_CORRELATION_ROLE, encode({ schema: "jinn.network/benchmark-product/inspect-selection/1" }), "m")).toBeUndefined();
  });

  test("refuses bytes that are not the exact canonical encoding", () => {
    const pretty = new TextEncoder().encode(JSON.stringify(manifest, null, 2));
    expect(() => readRegisteredSuiteSelection(HARBOR_SELECTION_ROLE, pretty, "m")).toThrow(/exact canonical encoding/u);
  });

  test("refuses a SWE-bench Verified selection whose suite is off its grammar", () => {
    expect(() => readRegisteredSuiteSelection(SWE_BENCH_VERIFIED_SELECTION_ROLE, encode({ harness: {}, suite: {} }), "m"))
      .toThrow(/not a SWE-bench Verified selection manifest/u);
    expect(() => readRegisteredSuiteSelection(APEX_AGENTS_SELECTION_ROLE, encode({}), "m")).toThrow(/APEX-Agents/u);
    expect(() => readRegisteredSuiteSelection(APEX_SWE_DEV_SELECTION_ROLE, encode({}), "m")).toThrow(/APEX-SWE-dev/u);
  });

  test("refuses an Inspect eval selection whose samples differ from its suite's names", () => {
    const inspectSuite = suite("inspect-eval", ["s0", "s1"]);
    const value = {
      schema: INSPECT_EVAL_SELECTION_SCHEMA,
      inspect: { runtime: { inspectVersion: SUPPORTED_INSPECT_VERSION }, runOptions: {} },
      catalog: { specifiedEpochs: 1, snapshotSha256: "c".repeat(64) },
      selectedSamples: [{ sampleId: "s1" }, { sampleId: "s0" }],
      solver: "task-default",
      sampleLimit: null,
      suite: inspectSuite,
    };
    expect(() => readRegisteredSuiteSelection(INSPECT_SELECTION_CORRELATION_ROLE, encode(value), "m")).toThrow(/selected samples differ/u);
  });
});

describe("resolveCarriedSuite binds the declaration to the Run and the carried bytes", () => {
  const selected = suite("terminal-bench-3.0", ["task-a"]);
  const manifestBytes = encode({
    adapter: { id: "harbor", version: "1" },
    harbor: { version: "0.21.4" },
    environment: { type: "docker", configuration: {} },
    retryPolicy: { nAttempts: 5, maxRetries: 3 },
    jobGrain: "per-arm",
    arms: [{ jobAgent: { name: "terminus" } }],
    profiles: { [SUITE_PROTOCOL_PROFILE]: selected },
  });
  const suiteBytes = suiteSelectionBytes(selected);
  const rows = [
    { role: HARBOR_SELECTION_ROLE, artifact: { digest: { sha256: sha256(manifestBytes) }, mediaType: "application/json" } },
    { role: SUITE_PROTOCOL_SELECTION_ROLE, artifact: { digest: { sha256: sha256(suiteBytes) }, mediaType: "application/json" } },
  ];
  const job = harborJob(selected);
  const evidence = [...job].flatMap(([root, files]) => [...files]
    .filter(([path]) => !path.endsWith("result.json"))
    .map(([path, bytes]) => ({ root, path, sha256: sha256(bytes), bytes })));

  function resolve(overrides: {
    declared?: boolean;
    rows?: typeof rows;
    records?: Map<string, Uint8Array>;
    index?: readonly { root: string; path: string; sha256: string }[];
  } = {}) {
    const records = overrides.records ?? new Map<string, Uint8Array>([
      [sha256(manifestBytes), manifestBytes],
      [sha256(suiteBytes), suiteBytes],
      ...evidence.map((file) => [file.sha256, file.bytes] as const),
    ]);
    const index = buildSuiteEvidenceIndex(overrides.index ?? evidence);
    return resolveCarriedSuite({
      declared: overrides.declared ?? true,
      runRecord: { arms: ARMS, replicates: 5 },
      registrationArtifacts: overrides.rows ?? rows,
      runSha256: RUN_SHA256,
      matrix: matrixFor(selected),
      records,
      readMember: (path) => {
        expect(path).toBe(SUITE_EVIDENCE_BUNDLE_MEMBER);
        return index;
      },
    });
  }

  function refusal(run: () => unknown): string {
    try {
      run();
    } catch (cause) {
      expect(cause).toBeInstanceOf(BenchmarkProductError);
      return (cause as Error).message;
    }
    throw new Error("expected a refusal");
  }

  test("a declaring bundle with every byte re-derives its suite comparability", () => {
    const carried = resolve();
    expect(carried?.comparability).toEqual({ executionConformance: true, coverage: "full", leaderboardSubmitReady: true });
    expect(carried?.runtimeSelectionSha256).toBe(sha256(manifestBytes));
    expect(carried?.suiteSelectionSha256).toBe(sha256(suiteBytes));
  });

  test("a Run that registers a suite selection must declare the capability", () => {
    expect(refusal(() => resolve({ declared: false }))).toMatch(/must declare "suite-comparability"/u);
    expect(resolve({ declared: false, rows: [rows[0]!] })).toBeUndefined();
  });

  test("the declaration needs one registered runtime selection, carried, that binds a suite", () => {
    expect(refusal(() => resolve({ rows: [rows[1]!] }))).toMatch(/exactly one runtime selection/u);
    expect(refusal(() => resolve({ records: new Map([[sha256(suiteBytes), suiteBytes]]) }))).toMatch(/does not carry the runtime selection/u);
  });

  test("the carried suite object must be the one nested in the runtime selection", () => {
    const other = suiteSelectionBytes(suite("terminal-bench-3.0", ["task-b"]));
    const tampered = new Map<string, Uint8Array>([
      [sha256(manifestBytes), manifestBytes],
      [sha256(other), other],
      ...evidence.map((file) => [file.sha256, file.bytes] as const),
    ]);
    const swapped = [rows[0]!, { ...rows[1]!, artifact: { ...rows[1]!.artifact, digest: { sha256: sha256(other) } } }];
    expect(refusal(() => resolve({ rows: swapped, records: tampered }))).toMatch(/not the suite object its runtime selection seals/u);
    expect(refusal(() => resolve({ rows: [rows[0]!] }))).toMatch(/exactly one suite-protocol selection/u);
  });

  test("the carried evidence must be exactly the files that decide the flag, under roots the run has", () => {
    expect(refusal(() => resolve({ index: evidence.slice(1) }))).toMatch(/not exactly the set of files/u);
    expect(refusal(() => resolve({ index: [...evidence, { root: "harbor-job/three", path: "x/config.json", sha256: evidence[0]!.sha256 }] })))
      .toMatch(/not one this terminal-bench-3.0 run has/u);
    const unknownRecord = [{ ...evidence[0]!, sha256: "f".repeat(64) }, ...evidence.slice(1)];
    expect(refusal(() => resolve({ index: unknownRecord }))).toMatch(/names a record the bundle does not carry/u);
  });
});

describe("an Inspect eval Task is bound by its sample id", () => {
  const selected = suite("inspect-eval", ["s0", "s1"]);
  const selection = {
    kind: "inspect-eval" as const,
    manifest: {
      inspect: { runtime: { inspectVersion: SUPPORTED_INSPECT_VERSION }, runOptions: {} },
      catalog: { specifiedEpochs: 1, snapshotSha256: "c".repeat(64) },
      solver: "task-default",
      sampleLimit: null,
      suite: selected,
    },
    suite: selected,
    selectedSampleIds: ["s0", "s1"],
  };
  const bind = (payload: unknown, taskDigest = taskSha("s0")) => () => assertInspectEvalTask({ selection, payload, taskDigest, cellKey: "cell" });

  test("a selected sample whose Task digest the suite names is bound", () => {
    expect(bind({ sampleId: "s0" })).not.toThrow();
  });

  test("an unselected sample, another Task's digest, or a payload with more than the sample is refused", () => {
    expect(bind({ sampleId: "s9" })).toThrow(/Inspect eval Task is not a sample its sealed selection names/u);
    expect(bind({ sampleId: "s0" }, taskSha("s1"))).toThrow(/not a sample its sealed selection names/u);
    expect(bind({ sampleId: "s0", selectionManifestSha256: "a".repeat(64) })).toThrow(/not a sample/u);
    expect(bind(undefined)).toThrow(/not a sample/u);
  });
});
