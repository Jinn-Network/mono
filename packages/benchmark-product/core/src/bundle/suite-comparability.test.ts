// SPDX-License-Identifier: Apache-2.0

/**
 * A suite-bound run publishes a bundle that carries its sealed selection bytes (issue #4759), and
 * the checker re-derives the claim's `suiteComparability` from them (issue #4761), with the
 * evidence `leaderboardSubmitReady` turns on (issue #4762).
 *
 * Every run here is driven through the production operations: select (the fixture drafts the
 * runtime tests use), quote, lock, launch or `run import`, collect, report and publish. `publish`
 * runs the checker on its own output, so a run that publishes has passed it; each test also runs
 * the checker again on the published directory.
 */

import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { parseRun, readRunPublicationExtension } from "@jinn-network/benchmarking-records";
import { canonicalJsonBytes } from "@jinn-network/trust-core";
import {
  BUNDLE_V10_FORMAT,
  SUITE_COMPARABILITY_CAPABILITY,
  SUITE_EVIDENCE_BUNDLE_MEMBER,
  SUITE_PROTOCOL_IDS,
  SUITE_PROTOCOL_SELECTION_ROLE,
  SuiteProtocolSelectionSchema,
  readRegisteredSuiteSelection,
  registeredSuiteRows,
  suiteLeaderboardLimitation,
  verifyPublicBundle,
  type SuiteProtocolId,
} from "@colophon-claims/check";
import { createHash } from "node:crypto";
import { runPublish } from "../operations/publish.js";
import { runReport } from "../operations/report.js";
import { readRunState } from "../run/state.js";
import { getSealedBytes } from "../workspace/sealed-store.js";
import { publicBundlePath } from "../workspace/layout.js";
import { buildBundleManifest } from "./manifest.js";
import * as check from "@colophon-claims/check";
import { HARBOR_SELECTION_ROLE } from "../runtime/harbor/venue.js";
import { SWE_BENCH_VERIFIED_DATASET_INSTANCE_COUNT, SWE_BENCH_VERIFIED_DATASET_REVISION, SWE_BENCH_VERIFIED_SELECTION_ROLE } from "../runtime/swe-bench-verified/manifest.js";
import { APEX_AGENTS_DATASET_REVISION, APEX_AGENTS_DATASET_TASK_COUNT, APEX_AGENTS_SELECTION_ROLE } from "../runtime/apex-agents/manifest.js";
import { APEX_SWE_DEV_SELECTION_ROLE } from "../runtime/apex-swe-dev/manifest.js";
import { INSPECT_EVAL_SELECTION_SCHEMA } from "../runtime/inspect-eval/manifest.js";
import { TERMINAL_BENCH_2_1_DATASET_REF } from "../runtime/terminal-bench-2-1/manifest.js";
import { TERMINAL_BENCH_3_0_DATASET_REF } from "../runtime/terminal-bench-3-0/manifest.js";
import { DEEP_SWE_V11_GIT_SHA, DEEP_SWE_V11_TASK_COUNT, DEEP_SWE_V11_TASKS_TREE_SHA } from "../runtime/deep-swe-v1.1/manifest.js";
import { harborArmJobsDir } from "../runtime/harbor/arm-job.js";
import { harborArmJobName } from "../runtime/harbor/launcher.js";
import {
  importedApexAgentsRun,
  importedApexSweDevRun,
  importedInspectEvalRun,
  importedSwebenchRun,
  importedTerminalBench30Run,
  launchedHarborSuiteRun,
  retainedHarborTrialDirectory,
  writeRetainedHarborTrials,
  type SuiteRun,
} from "./testing/suite-runs.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bp-suite-comparability-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function suiteRunFor(protocol: SuiteProtocolId): Promise<SuiteRun> {
  switch (protocol) {
    case "terminal-bench-2.1":
    case "deep-swe-v1.1":
      return launchedHarborSuiteRun(protocol, root);
    case "terminal-bench-3.0":
      return importedTerminalBench30Run(root);
    case "swe-bench-verified":
      return importedSwebenchRun(root);
    case "apex-agents":
      return importedApexAgentsRun(root);
    case "apex-swe-dev":
      return importedApexSweDevRun(root);
    case "inspect-eval":
      return importedInspectEvalRun(root);
  }
}

interface Published {
  readonly bundleDir: string;
  readonly manifest: { readonly format: string; readonly capabilities: readonly string[]; readonly files: readonly { readonly path: string }[] };
  readonly evidence: { readonly records: readonly { readonly sha256: string; readonly roles: readonly string[] }[] };
  readonly claim: { readonly suiteComparability?: { readonly executionConformance: boolean; readonly coverage: string; readonly leaderboardSubmitReady: boolean }; readonly limitations: readonly string[] };
  readonly suiteEvidence: { readonly files: readonly { readonly root: string; readonly path: string; readonly sha256: string }[] };
}

async function reportAndPublish(run: SuiteRun): Promise<Published> {
  const reported = await runReport(run.context, { draftId: run.draftId });
  expect(reported.ok, JSON.stringify(reported)).toBe(true);
  const published = await runPublish(run.context, { draftId: run.draftId, includeNativeArtifacts: true });
  expect(published.ok, JSON.stringify(published)).toBe(true);
  if (!published.ok) throw new Error("unreachable");
  const bundleDir = publicBundlePath(run.workspaceDir, run.draftId, published.result.bundleIdentity);
  const readJson = <T>(path: string): T => JSON.parse(readFileSync(join(bundleDir, path), "utf8")) as T;
  return {
    bundleDir,
    manifest: readJson("bundle.json"),
    evidence: readJson("evidence.json"),
    claim: readJson("claim-package.json"),
    suiteEvidence: readJson(SUITE_EVIDENCE_BUNDLE_MEMBER),
  };
}

function rolesOf(published: Published, sha256: string): readonly string[] {
  return published.evidence.records.find((record) => record.sha256 === sha256)?.roles ?? [];
}

/** Every file of a directory tree, by its path relative to `dir`. */
function filesUnder(dir: string, prefix = ""): string[] {
  return readdirSync(join(dir, prefix), { withFileTypes: true }).flatMap((entry) => {
    const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    return entry.isDirectory() ? filesUnder(dir, path) : [path];
  });
}

/** The bundle files whose bytes name `path`. */
function bundleFilesNaming(bundleDir: string, path: string): string[] {
  return filesUnder(bundleDir).filter((file) => readFileSync(join(bundleDir, file)).includes(Buffer.from(path)));
}

/** The bytes each carried trial `config.json` travels as: the part that names its task and attempt. */
function carriedTrialConfigs(published: Published): string[] {
  return published.suiteEvidence.files
    .filter((file) => file.path.endsWith("/config.json"))
    .map((file) => readFileSync(join(published.bundleDir, "records", `${file.sha256}.bin`), "utf8"));
}

describe("a suite-bound run publishes a bundle that carries its sealed selection bytes (#4759)", () => {
  test.each([...SUITE_PROTOCOL_IDS])("%s", async (protocol) => {
    const run = await suiteRunFor(protocol);
    const published = await reportAndPublish(run);

    expect(published.manifest.format).toBe(BUNDLE_V10_FORMAT);
    expect(published.manifest.capabilities).toContain(SUITE_COMPARABILITY_CAPABILITY);

    const runSha256 = readRunState(run.workspaceDir, run.draftId)!.runSha256!;
    const rows = registeredSuiteRows(
      readRunPublicationExtension(parseRun(getSealedBytes(run.workspaceDir, runSha256)) as unknown as Record<string, unknown>)
        ?.registrationArtifacts ?? [],
    );

    // The runtime selection: the exact sealed bytes, at the digest the Run registered.
    expect(rows.runtimeSelection).toHaveLength(1);
    const runtimeRow = rows.runtimeSelection[0]!;
    const runtimeSha256 = runtimeRow.artifact.digest.sha256;
    const runtimeBytes = readFileSync(join(published.bundleDir, "records", `${runtimeSha256}.bin`));
    expect(createHash("sha256").update(runtimeBytes).digest("hex")).toBe(runtimeSha256);
    expect(Buffer.compare(runtimeBytes, Buffer.from(getSealedBytes(run.workspaceDir, runtimeSha256)))).toBe(0);
    expect(rolesOf(published, runtimeSha256)).toContain("runtime-selection");
    const selection = readRegisteredSuiteSelection(runtimeRow.role, runtimeBytes, "runtime selection");
    expect(selection?.suite.protocol).toBe(protocol);

    // The suite-protocol object: carried on its own wherever the Run registered it on its own.
    if (protocol === "inspect-eval") {
      expect(rows.suiteSelection).toHaveLength(0);
    } else {
      expect(rows.suiteSelection).toHaveLength(1);
      expect(rows.suiteSelection[0]!.role).toBe(SUITE_PROTOCOL_SELECTION_ROLE);
      const suiteSha256 = rows.suiteSelection[0]!.artifact.digest.sha256;
      const suiteBytes = readFileSync(join(published.bundleDir, "records", `${suiteSha256}.bin`));
      expect(createHash("sha256").update(suiteBytes).digest("hex")).toBe(suiteSha256);
      expect(rolesOf(published, suiteSha256)).toEqual(["suite-protocol-selection"]);
      // The board key: the `protocol` field of the sealed suite-protocol selection object.
      expect(SuiteProtocolSelectionSchema.parse(JSON.parse(suiteBytes.toString("utf8"))).protocol).toBe(protocol);
    }

    // The claim states the section the checker re-derived.
    expect(published.claim.suiteComparability).toBeDefined();
    const verified = await verifyPublicBundle(published.bundleDir);
    expect(verified.format).toBe(BUNDLE_V10_FORMAT);
  }, 240_000);
});

describe("leaderboardSubmitReady is re-derived from carried evidence (#4761, #4762)", () => {
  const notReady = (protocol: SuiteProtocolId) =>
    suiteLeaderboardLimitation({ executionConformance: true, coverage: "full", leaderboardSubmitReady: false }, protocol);

  test("terminal-bench-3.0: a full, conforming run with ATIF on every judged trial is ready, and the checker agrees from the carried files", async () => {
    const run = await importedTerminalBench30Run(root);
    writeRetainedHarborTrials(run, "task-alpha", 5);
    const published = await reportAndPublish(run);
    expect(published.claim.suiteComparability).toEqual({ executionConformance: true, coverage: "full", leaderboardSubmitReady: true });
    expect(published.claim.limitations).not.toContain(notReady("terminal-bench-3.0"));
    // Every trial's config.json and every judged trial's ATIF file, under each arm's job root, and
    // nothing the flag does not read.
    const carried = published.suiteEvidence.files.map((file) => `${file.root}:${file.path}`).sort();
    const expected = ["one", "two"].flatMap((armId) => [1, 2, 3, 4, 5].flatMap((attempt) => [
      `harbor-job/${armId}:${retainedHarborTrialDirectory("task-alpha", attempt)}/agent/trajectory.json`,
      `harbor-job/${armId}:${retainedHarborTrialDirectory("task-alpha", attempt)}/config.json`,
    ])).sort();
    expect(carried).toEqual(expected);
    for (const file of published.suiteEvidence.files) expect(rolesOf(published, file.sha256)).toEqual(["suite-evidence"]);
    // Harbor's trial configs name the task with its dataset prefix and record trials_dir, a path in
    // the workspace (#5245). Each travels as the part that names its task and attempt.
    expect(carriedTrialConfigs(published)).toEqual(Array.from({ length: 10 }, () => '{"task":{"name":"task-alpha"}}'));
    expect(bundleFilesNaming(published.bundleDir, run.workspaceDir)).toEqual([]);
    await verifyPublicBundle(published.bundleDir);
  }, 240_000);

  test("terminal-bench-3.0: the same run with one judged trial's ATIF file missing is not ready, and publishes with the sentence that says so", async () => {
    const run = await importedTerminalBench30Run(root);
    writeRetainedHarborTrials(run, "task-alpha", 5, (armId, attempt) => armId === "two" && attempt === 3);
    const published = await reportAndPublish(run);
    expect(published.claim.suiteComparability).toEqual({ executionConformance: true, coverage: "full", leaderboardSubmitReady: false });
    expect(published.claim.limitations).toContain(notReady("terminal-bench-3.0"));
    // The evidence that decided the flag still travels: every config.json, so a reader sees that
    // the third trial is the one trial for its task and attempt and that it has no ATIF file.
    const carried = published.suiteEvidence.files.map((file) => `${file.root}:${file.path}`);
    expect(carried).toContain(`harbor-job/two:${retainedHarborTrialDirectory("task-alpha", 3)}/config.json`);
    expect(carried).not.toContain(`harbor-job/two:${retainedHarborTrialDirectory("task-alpha", 3)}/agent/trajectory.json`);
    await verifyPublicBundle(published.bundleDir);
  }, 240_000);

  test("terminal-bench-2.1: a full, conforming launched run whose trials are all accounted unscorable is ready on the trial configs alone", async () => {
    const run = await launchedHarborSuiteRun("terminal-bench-2.1", root);
    // The run gave Harbor a jobs directory inside the workspace, and each trial config.json Harbor
    // wrote records it (#5245).
    const runSha256 = readRunState(run.workspaceDir, run.draftId)!.runSha256!;
    const job = join(harborArmJobsDir(run.workspaceDir, runSha256), harborArmJobName(runSha256, "one"));
    const trialConfigs = filesUnder(job).filter((path) => /^[^/]+\/config\.json$/u.test(path));
    expect(trialConfigs).toHaveLength(5);
    for (const path of trialConfigs) expect(readFileSync(join(job, path), "utf8")).toContain(run.workspaceDir);

    const published = await reportAndPublish(run);
    expect(published.claim.suiteComparability).toEqual({ executionConformance: true, coverage: "full", leaderboardSubmitReady: true });
    expect(published.claim.limitations).not.toContain(notReady("terminal-bench-2.1"));
    const carried = published.suiteEvidence.files.map((file) => `${file.root}:${file.path}`);
    expect(carried).toHaveLength(10);
    expect(carried.every((entry) => /^harbor-job\/(one|two):[a-z0-9-]+__[0-9a-f]{7}\/config\.json$/u.test(entry))).toBe(true);
    const taskName = trialConfigs[0]!.slice(0, trialConfigs[0]!.indexOf("__"));
    expect(carriedTrialConfigs(published)).toEqual(Array.from({ length: 10 }, () => `{"task":{"name":"${taskName}"}}`));
    expect(bundleFilesNaming(published.bundleDir, run.workspaceDir)).toEqual([]);
    await verifyPublicBundle(published.bundleDir);
  }, 240_000);

  test("deep-swe-v1.1: a fixture cannot lock the pinned 113-task tree, so the method is not eligible and no evidence travels", async () => {
    const run = await launchedHarborSuiteRun("deep-swe-v1.1", root);
    const published = await reportAndPublish(run);
    expect(published.claim.suiteComparability).toEqual({ executionConformance: true, coverage: "one_task", leaderboardSubmitReady: false });
    expect(published.suiteEvidence.files).toEqual([]);
    await verifyPublicBundle(published.bundleDir);
  }, 240_000);

  test("inspect-eval: a full-coverage run whose cells were not run is not ready, and publishes with the sentence that says so", async () => {
    const run = await importedInspectEvalRun(root, { coverage: "full" });
    const published = await reportAndPublish(run);
    expect(published.claim.suiteComparability).toEqual({ executionConformance: true, coverage: "full", leaderboardSubmitReady: false });
    expect(published.claim.limitations).toContain(
      suiteLeaderboardLimitation({ executionConformance: true, coverage: "full", leaderboardSubmitReady: false }, "inspect-eval"),
    );
    expect(published.suiteEvidence.files).toEqual([]);
    await verifyPublicBundle(published.bundleDir);
  }, 240_000);
});

describe("a reader refuses a suite-bound bundle whose claim or evidence the carried bytes do not back (#4761, #4762)", () => {
  /** A copy of a published bundle with `edit` applied and the manifest re-sealed over the tree as it
   * now stands, so what the reader refuses is the inconsistency and not a stale digest. */
  function tampered(bundleDir: string, edit: (dir: string) => void): string {
    const copy = join(root, `tampered-${Math.random().toString(16).slice(2)}`);
    cpSync(bundleDir, copy, { recursive: true });
    edit(copy);
    const manifest = JSON.parse(readFileSync(join(copy, "bundle.json"), "utf8")) as { capabilities: string[]; files: { path: string }[] };
    const paths = manifest.files.map((file) => file.path).filter((path) => {
      try { readFileSync(join(copy, path)); return true; } catch { return false; }
    });
    writeFileSync(join(copy, "bundle.json"), buildBundleManifest(copy, paths, { format: BUNDLE_V10_FORMAT, capabilities: manifest.capabilities }).bytes);
    return copy;
  }

  function editJson(dir: string, path: string, edit: (value: Record<string, any>) => void): void {
    const value = JSON.parse(readFileSync(join(dir, path), "utf8")) as Record<string, any>;
    edit(value);
    writeFileSync(join(dir, path), canonicalJsonBytes(value as never));
  }

  test("a claimed flag, coverage, conformance or omitted section is refused; a dropped evidence file is refused", async () => {
    const run = await importedTerminalBench30Run(root);
    writeRetainedHarborTrials(run, "task-alpha", 5);
    const published = await reportAndPublish(run);
    await verifyPublicBundle(published.bundleDir);

    for (const [field, value] of [
      ["leaderboardSubmitReady", false],
      ["coverage", "ten_task"],
      ["executionConformance", false],
    ] as const) {
      const copy = tampered(published.bundleDir, (dir) => editJson(dir, "claim-package.json", (claim) => {
        claim["suiteComparability"][field] = value;
      }));
      await expect(verifyPublicBundle(copy), field).rejects.toThrow(new RegExp(`suiteComparability\\.${field}`, "u"));
    }

    // Omitting the section leaves a claim whose sections no longer imply the reader line it pins.
    const omitted = tampered(published.bundleDir, (dir) => editJson(dir, "claim-package.json", (claim) => {
      delete claim["suiteComparability"];
    }));
    await expect(verifyPublicBundle(omitted)).rejects.toThrow();

    // Dropping one judged trial's ATIF file from the carried evidence makes the reader re-derive the
    // flag false, so the claim's true is refused.
    const dropped = tampered(published.bundleDir, (dir) => {
      let droppedSha256 = "";
      editJson(dir, SUITE_EVIDENCE_BUNDLE_MEMBER, (index) => {
        const position = (index["files"] as { path: string; sha256: string }[]).findIndex((file) => file.path.endsWith("trajectory.json"));
        droppedSha256 = index["files"][position].sha256;
        index["files"].splice(position, 1);
      });
      const stillNamed = (JSON.parse(readFileSync(join(dir, SUITE_EVIDENCE_BUNDLE_MEMBER), "utf8")) as { files: { sha256: string }[] })
        .files.some((file) => file.sha256 === droppedSha256);
      if (!stillNamed) {
        editJson(dir, "evidence.json", (catalog) => {
          catalog["records"] = (catalog["records"] as { sha256: string }[]).filter((record) => record.sha256 !== droppedSha256);
        });
        unlinkSync(join(dir, "records", `${droppedSha256}.bin`));
      }
    });
    await expect(verifyPublicBundle(dropped)).rejects.toThrow(/suiteComparability\.leaderboardSubmitReady/u);

    // Carrying a file the flag does not read is refused: the evidence is exactly what decides it.
    const extra = tampered(published.bundleDir, (dir) => editJson(dir, SUITE_EVIDENCE_BUNDLE_MEMBER, (index) => {
      const files = index["files"] as { root: string; path: string; sha256: string }[];
      files.push({ ...files[0]!, path: `${retainedHarborTrialDirectory("task-alpha", 1)}/result.json` });
      files.sort((left, right) => left.root < right.root ? -1 : left.root > right.root ? 1 : left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
    }));
    await expect(verifyPublicBundle(extra)).rejects.toThrow(/not exactly the set of files that decides leaderboardSubmitReady/u);
  }, 240_000);
});

describe("the producer refuses what no reader could check (#4759, #4761)", () => {
  test("report refuses the legacy rollback for a suite-bound run", async () => {
    const run = await launchedHarborSuiteRun("deep-swe-v1.1", root);
    const reported = await runReport(run.context, { draftId: run.draftId, composedFormat: false });
    expect(reported.ok).toBe(false);
    if (reported.ok) return;
    expect(reported.error.code).toBe("conflict");
    expect(reported.error.detail).toMatch(/bound to an official suite, so composedFormat: false is refused/u);
  }, 240_000);

  test("publish refuses when the retained evidence changed after report, before any reader sees it", async () => {
    const run = await importedTerminalBench30Run(root);
    writeRetainedHarborTrials(run, "task-alpha", 5);
    const reported = await runReport(run.context, { draftId: run.draftId });
    expect(reported.ok, JSON.stringify(reported)).toBe(true);
    const runSha256 = readRunState(run.workspaceDir, run.draftId)!.runSha256!;
    unlinkSync(join(harborArmJobsDir(run.workspaceDir, runSha256), harborArmJobName(runSha256, "one"), retainedHarborTrialDirectory("task-alpha", 2), "agent", "trajectory.json"));
    const published = await runPublish(run.context, { draftId: run.draftId, includeNativeArtifacts: true });
    expect(published.ok).toBe(false);
    if (published.ok) return;
    expect(published.error.detail).toMatch(/suiteComparability\.leaderboardSubmitReady is not the exact projection/u);
  }, 240_000);
});

describe("the checker restates core's registration roles and leaderboard pins exactly", () => {
  test("every role and pin the reader re-derives with is the value core seals", () => {
    expect(check.HARBOR_SELECTION_ROLE).toBe(HARBOR_SELECTION_ROLE);
    expect(check.SWE_BENCH_VERIFIED_SELECTION_ROLE).toBe(SWE_BENCH_VERIFIED_SELECTION_ROLE);
    expect(check.APEX_AGENTS_SELECTION_ROLE).toBe(APEX_AGENTS_SELECTION_ROLE);
    expect(check.APEX_SWE_DEV_SELECTION_ROLE).toBe(APEX_SWE_DEV_SELECTION_ROLE);
    expect(check.INSPECT_EVAL_SELECTION_SCHEMA).toBe(INSPECT_EVAL_SELECTION_SCHEMA);
    expect(check.TERMINAL_BENCH_2_1_LEADERBOARD_DATASET_REF).toBe(TERMINAL_BENCH_2_1_DATASET_REF);
    expect(check.TERMINAL_BENCH_3_0_LEADERBOARD_DATASET_REF).toBe(TERMINAL_BENCH_3_0_DATASET_REF);
    expect(check.DEEP_SWE_V11_LEADERBOARD_GIT_SHA).toBe(DEEP_SWE_V11_GIT_SHA);
    expect(check.DEEP_SWE_V11_LEADERBOARD_TASKS_TREE_SHA).toBe(DEEP_SWE_V11_TASKS_TREE_SHA);
    expect(check.DEEP_SWE_V11_LEADERBOARD_TASK_COUNT).toBe(DEEP_SWE_V11_TASK_COUNT);
    expect(check.SWE_BENCH_VERIFIED_LEADERBOARD_DATASET_REVISION).toBe(SWE_BENCH_VERIFIED_DATASET_REVISION);
    expect(check.SWE_BENCH_VERIFIED_LEADERBOARD_INSTANCE_COUNT).toBe(SWE_BENCH_VERIFIED_DATASET_INSTANCE_COUNT);
    expect(check.APEX_AGENTS_LEADERBOARD_DATASET_REVISION).toBe(APEX_AGENTS_DATASET_REVISION);
    expect(check.APEX_AGENTS_LEADERBOARD_TASK_COUNT).toBe(APEX_AGENTS_DATASET_TASK_COUNT);
  });
});
