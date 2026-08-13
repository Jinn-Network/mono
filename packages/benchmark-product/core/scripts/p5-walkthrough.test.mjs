import assert from "node:assert/strict";
import test from "node:test";
import {
  assertP5ReadyToCollect,
  p5ArmPinning,
  p5CheckpointAction,
  p5ResumeNeeded,
  runCanonicalP5GreenBaseline,
} from "./p5-walkthrough.mjs";

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

function expectResume(counts, evaluationRecovery, expected) {
  assert.equal(p5ResumeNeeded({ counts, evaluationRecovery }), expected);
}
