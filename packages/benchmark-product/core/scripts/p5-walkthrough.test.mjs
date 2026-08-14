import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assertP5ReadyToCollect,
  finishStagedBundle,
  p5ArmPinning,
  p5BuildEntrypoint,
  p5CheckpointAction,
  p5ResumeNeeded,
  runCanonicalP5GreenBaseline,
} from "./p5-walkthrough.mjs";

test("walkthrough rebuilds through the package entrypoint that copies runtime assets", () => {
  const buildEntrypoint = p5BuildEntrypoint();
  assert.equal(buildEntrypoint.endsWith("/scripts/build.mjs"), true);
  assert.equal(existsSync(buildEntrypoint), true);
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
    mkdirSync(workspaceDir);
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

function expectResume(counts, evaluationRecovery, expected) {
  assert.equal(p5ResumeNeeded({ counts, evaluationRecovery }), expected);
}
