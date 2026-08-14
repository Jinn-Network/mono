import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  assertP5ReadyToCollect,
  finishStagedBundle,
  p5ArmPinning,
  p5BuildEntrypoint,
  p5CheckpointAction,
  p5LaunchElapsedMs,
  p5ResumeNeeded,
  recoverInterruptedP5LaunchStep,
  removeRunOwnedBuilderWorkspace,
  runCanonicalP5GreenBaseline,
} from "./p5-walkthrough.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

test("walkthrough rebuilds through the package entrypoint that copies runtime assets", () => {
  const buildEntrypoint = p5BuildEntrypoint();
  assert.equal(buildEntrypoint.endsWith("/scripts/build.mjs"), true);
  assert.equal(existsSync(buildEntrypoint), true);
});

test("committed P5 evidence records the completed cold bundle and truthful withheld draws", () => {
  const evidence = readFileSync(
    join(repoRoot, "docs", "superpowers", "plans", "demo-report-1", "P5-evidence.md"),
    "utf8",
  );
  assert.match(evidence, /Final outcome: complete local plumbing proof/u);
  assert.match(evidence, /Recorded:\*\* 2026-08-14/u);
  assert.match(evidence, /77da47e41e363e6dd2a1c9eff5fddcab9ed6e6b2/u);
  assert.match(evidence, /77271a709f713223119d4683358856e5d7191a66/u);
  assert.match(evidence, /c65d57d66b56ffdfb20fc45d2c1a72009f64964c/u);
  assert.match(evidence, /fe23ac64f568e73a6dc37c7a638ace571ded88e5cca20401dc916326d49ead32/u);
  assert.match(evidence, /all 12 reached a valid\s+grader outcome/u);
  assert.match(evidence, /draws=0.*no bootstrap ensemble was executed/su);
  assert.match(evidence, /standalone verifier then passed manifest, evidence-closure, trust, Matrix rederivation/su);
  assert.match(evidence, /71,463,460,864 bytes \(66\.56 GiB\)/u);
  assert.match(evidence, /gerlero__foamlib-329.*PASS.*FAIL/u);
  assert.match(evidence, /conan-io__conan-19604.*PASS.*FAIL/u);
  assert.match(evidence, /nesquena__hermes-webui-1818.*PASS.*FAIL/u);
  assert.match(evidence, /Claude Code `2\.1\.222`.*ddfe2e537c459eb33fab3469ed5a88c0df8741a421c6562af5d31f068da94028/su);
  assert.match(evidence, /claude-haiku-4-5-20251001/u);
  assert.match(evidence, /SKILL\.md.*2e2196f931c6d53ebd942d11662c319b4b191c4b397c03c3bb1aa62bee26b7a2/su);
  assert.match(evidence, /CLAUDE\.md.*98227d6fcbc9122249441581d6c44a9270f3cd45c0264e67aad20d51762f57c2/su);
  assert.match(evidence, /P5 pure\/injected tests: 37\/37/u);
  assert.match(evidence, /strict final-fixture tests: 11\/11/u);
  assert.match(evidence, /focused P5 runtime and evidence guards: 16\/16/u);
  assert.match(evidence, /1,035 tests passed,\s+28 skipped/su);
  assert.doesNotMatch(evidence, /Recovery implementation commit:\*\* `76a9857db`/u);
  assert.doesNotMatch(evidence, /P5 pure\/injected tests: 27\/27/u);
  assert.doesNotMatch(evidence, /892 tests passed/u);
  assert.doesNotMatch(evidence, /^P5 is not complete\./mu);
  assert.doesNotMatch(evidence, /## Current outcome:.*stopped/su);
});

test("canonical walkthrough always wires v2 pre-stage stop capture with attempt identity", async () => {
  let received;
  const expected = { transcript: { passed: false } };
  const result = await runCanonicalP5GreenBaseline({
    runRoot: "/immutable/p5-output",
    dockerPath: "/gated/docker",
    runGreenBaseline: async (options) => {
      received = options;
      return expected;
    },
  });

  assert.equal(result, expected);
  assert.deepEqual(received, {
    dockerPath: "/gated/docker",
    output: "/immutable/p5-output/green-baseline.json",
    stopOutput: "/immutable/p5-output/green-baseline-prestage-stop.json",
    attempt: 1,
  });
});

test("arm pinning omits the submission-baseline isolation key and preserves every arm-owned pin", () => {
  const loadout = { kind: "jinn.skill.v1", name: "SKILL.md", digest: { sha256: "a".repeat(64) } };
  assert.deepEqual(p5ArmPinning({
    harness: { id: "claude-code", version: "2.1.222" },
    model: { id: "claude-haiku-4-5-20251001" },
    effort: "high",
    isolationPolicy: "unrestricted",
    loadout,
  }), {
    harness: { id: "claude-code", version: "2.1.222" },
    model: { id: "claude-haiku-4-5-20251001" },
    effort: "high",
    loadout,
  });
});

test("arm pinning refuses an unexpected effective isolation policy", () => {
  assert.throws(
    () => p5ArmPinning({ harness: "claude-code", isolationPolicy: "oci-container" }),
    /expected unrestricted isolation policy/u,
  );
});

test("walkthrough resumes incomplete work but never a complete run", () => {
  expectResume({ judged: 10, expected: 12 }, { pendingCells: 0 }, true);
  expectResume({ judged: 11, expected: 12 }, { pendingCells: 1 }, true);
  expectResume({ judged: 12, expected: 12 }, { pendingCells: 0 }, false);
});

test("walkthrough continues from every durable post-lock lifecycle boundary", () => {
  assert.equal(p5CheckpointAction({ state: "locked", counts: { judged: 0, expected: 12 } }), "launch");
  assert.equal(p5CheckpointAction({ state: "running", counts: { judged: 11, expected: 12 } }), "resume");
  assert.equal(p5CheckpointAction({ state: "running", counts: { judged: 12, expected: 12 } }), "collect");
  assert.equal(p5CheckpointAction({ state: "closed", counts: { judged: 12, expected: 12 } }), "report");
  assert.equal(p5CheckpointAction({ state: "reported", counts: { judged: 12, expected: 12 } }), "verify");
  assert.throws(
    () => p5CheckpointAction({ state: "draft", counts: { judged: 0, expected: 12 } }),
    /cannot resume from lifecycle state draft/u,
  );
});

test("walkthrough leaves pending work open and refuses an exhausted retry before collect", () => {
  assert.throws(
    () => assertP5ReadyToCollect({ counts: { judged: 11, expected: 12 }, evaluationRecovery: { pendingCells: 1 } }),
    /checkpoint is resumable/u,
  );
  assert.throws(
    () => assertP5ReadyToCollect({ counts: { judged: 11, expected: 12 }, evaluationRecovery: { pendingCells: 0, exhaustedCells: 1 } }),
    /retry was exhausted/u,
  );
  assert.doesNotThrow(
    () => assertP5ReadyToCollect({ counts: { judged: 12, expected: 12 }, evaluationRecovery: { pendingCells: 0, exhaustedCells: 0 } }),
  );
});

test("bundle-staged checkpoint finishes after workspace deletion and re-entry is idempotent", async () => {
  const root = mkdtempSync(join(tmpdir(), "p5-finalize-test-"));
  try {
    const workspaceDir = join(root, "builder-workspace");
    const bundleDir = join(root, "bundle");
    const transcriptPath = join(root, "transcript.json");
    const immutableInput = join(workspaceDir, "attempts", "one", "input");
    mkdirSync(immutableInput, { recursive: true });
    writeFileSync(join(immutableInput, "SKILL.md"), "sealed\n", { mode: 0o400 });
    chmodSync(immutableInput, 0o500);
    mkdirSync(bundleDir);
    const pendingTranscript = {
      schema: "demo1.p5-plumbing/1",
      digests: { bundleIdentity: "a".repeat(64) },
      disk: { recoveryLog: "p5-disk-recovery.jsonl" },
      verification: { workspaceChecks: ["matrix-rederivation"] },
    };
    const checkpoint = {
      schema: "demo1.p5-walkthrough-state/1",
      phase: "bundle-staged",
      completed: false,
      pendingTranscript,
    };
    writeFileSync(join(root, "p5-walkthrough-state.json"), `${JSON.stringify(checkpoint)}\n`);
    const verification = { identity: "a".repeat(64), checks: ["manifest", "evidence-closure"] };
    const reserveRelease = { label: "cold bundle verified", reserveRemainingBytes: "0" };
    const transcript = await finishStagedBundle({
      runRoot: root,
      workspaceDir,
      bundleDir,
      transcriptPath,
      checkpoint,
      verifyPublicBundle: async () => verification,
      releaseReserve: () => reserveRelease,
    });
    assert.equal(existsSync(workspaceDir), false);
    assert.equal(transcript.verification.builderWorkspaceDeleted, true);
    assert.deepEqual(transcript.verification.coldBundleChecks, verification.checks);
    assert.deepEqual(transcript.disk.reserveRelease, reserveRelease);

    const staleCheckpoint = { ...checkpoint, phase: "bundle-staged", completed: false, pendingTranscript };
    writeFileSync(join(root, "p5-walkthrough-state.json"), `${JSON.stringify(staleCheckpoint)}\n`);
    const replayed = await finishStagedBundle({
      runRoot: root,
      workspaceDir,
      bundleDir,
      transcriptPath,
      checkpoint: staleCheckpoint,
      verifyPublicBundle: async () => verification,
      releaseReserve: () => { throw new Error("reserve must not release twice"); },
    });
    assert.deepEqual(replayed, JSON.parse(readFileSync(transcriptPath, "utf8")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bundle-staged checkpoint resumes when interruption already deleted the workspace", async () => {
  const root = mkdtempSync(join(tmpdir(), "p5-finalize-after-delete-test-"));
  try {
    const workspaceDir = join(root, "builder-workspace");
    const bundleDir = join(root, "bundle");
    const transcriptPath = join(root, "transcript.json");
    mkdirSync(bundleDir);
    const pendingTranscript = {
      schema: "demo1.p5-plumbing/1",
      digests: { bundleIdentity: "b".repeat(64) },
      disk: { recoveryLog: "p5-disk-recovery.jsonl" },
      verification: { workspaceChecks: ["matrix-rederivation"] },
    };
    const checkpoint = {
      schema: "demo1.p5-walkthrough-state/1",
      phase: "bundle-staged",
      completed: false,
      pendingTranscript,
    };
    const transcript = await finishStagedBundle({
      runRoot: root,
      workspaceDir,
      bundleDir,
      transcriptPath,
      checkpoint,
      verifyPublicBundle: async () => ({
        identity: "b".repeat(64),
        checks: ["manifest", "evidence-closure", "claim-consistency"],
      }),
      releaseReserve: () => ({ label: "cold bundle verified", reserveRemainingBytes: "0" }),
    });
    assert.equal(transcript.verification.builderWorkspaceDeleted, true);
    assert.equal(existsSync(transcriptPath), true);
    assert.equal(checkpoint.completed, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("builder-workspace deletion refuses a foreign root shape", () => {
  const root = mkdtempSync(join(tmpdir(), "p5-finalize-shape-test-"));
  const workspacePath = join(root, "builder-workspace");
  writeFileSync(workspacePath, "not a directory\n");
  try {
    assert.throws(() => removeRunOwnedBuilderWorkspace(workspacePath), /non-directory/u);
    assert.equal(existsSync(workspacePath), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("launch timing is rebuilt from durable launch and resume steps", () => {
  assert.equal(p5LaunchElapsedMs([
    { label: "init", elapsedMs: 4 },
    { label: "launch", elapsedMs: 3_000 },
    { label: "status", elapsedMs: 2 },
    { label: "resume", elapsedMs: 500 },
    { label: "launch.from-lock", elapsedMs: 250 },
  ]), 3_750);
  assert.throws(
    () => p5LaunchElapsedMs([{ label: "launch", elapsedMs: -1 }]),
    /invalid durable launch timing/u,
  );
});

test("interrupted launch timing is recovered durably instead of disappearing", () => {
  const checkpoint = {
    steps: [{ label: "init", elapsedMs: 4 }],
    inFlightLaunchStep: { label: "launch", startedAtUnixMs: 1_000 },
  };
  assert.deepEqual(recoverInterruptedP5LaunchStep(checkpoint, 4_250), {
    label: "launch",
    elapsedMs: 3_250,
    interrupted: true,
  });
  assert.equal(checkpoint.inFlightLaunchStep, undefined);
  assert.equal(p5LaunchElapsedMs(checkpoint.steps), 3_250);
  assert.equal(recoverInterruptedP5LaunchStep(checkpoint, 5_000), undefined);
  assert.throws(
    () => recoverInterruptedP5LaunchStep({
      steps: [],
      inFlightLaunchStep: { label: "launch", startedAtUnixMs: 6_000 },
    }, 5_000),
    /in-flight launch timing is invalid/u,
  );
});

function expectResume(counts, evaluationRecovery, expected) {
  assert.equal(p5ResumeNeeded({ counts, evaluationRecovery }), expected);
}
