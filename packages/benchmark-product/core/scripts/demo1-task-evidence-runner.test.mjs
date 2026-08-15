import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  readDemo1TaskEvidenceRun,
  runDemo1TaskEvidenceControls,
} from "./demo1-task-evidence-runner.mjs";

const digest = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const hash = (value) => createHash("sha256").update(value).digest("hex");

function job(taskId, imageDigest) {
  return {
    candidate: "skills/frontend-design",
    taskId,
    taskSha256: hash(`task:${taskId}`),
    imageDigest,
    graderProgramDigest: digest("grader"),
  };
}

function root() {
  return mkdtempSync(join(tmpdir(), "demo1-task-evidence-"));
}

function ports({ images = [], failOnce = false } = {}) {
  const present = new Set(images);
  const calls = { ensure: [], control: [], removed: [], sealed: 0, disk: [] };
  let failed = false;
  return {
    calls,
    port: {
      async listImages() { return [...present]; },
      async assertDisk(label) { calls.disk.push(label); },
      async ensureImage(job) {
        calls.ensure.push(job.taskId);
        if (failOnce && !failed) {
          failed = true;
          throw Object.assign(new Error("transient registry failure"), { infrastructure: true });
        }
        present.add(job.imageDigest);
      },
      async control(job) {
        calls.control.push(job.taskId);
        return {
          gold: "pass",
          empty: "fail",
          taskLicense: "match",
          conflictingInstructionFileAbsent: "match",
          imagePullPolicy: "never",
          networkPolicy: "none",
          graderProgramDigest: digest("grader"),
        };
      },
      async sealEvidence(values) {
        calls.sealed += 1;
        return createHash("sha256").update(JSON.stringify(values)).digest("hex");
      },
      async removeImage(image) {
        calls.removed.push(image);
        present.delete(image);
      },
    },
  };
}

test("task-evidence controls retry infrastructure once, checkpoint, seal, and retain the shared image", async () => {
  const runRoot = root();
  try {
    const image = digest("new-image");
    const runtime = ports({ images: [digest("pre-existing")], failOnce: true });
    const state = await runDemo1TaskEvidenceControls({
      runRoot,
      jobs: [job("task-1", image)],
      ports: runtime.port,
    });
    assert.equal(state.jobs[0].attempts, 2);
    assert.equal(state.jobs[0].status, "complete");
    assert.equal(state.evidence.sealed, true);
    assert.deepEqual(runtime.calls.removed, []);
    assert.equal("ownedImages" in state, false);
    assert.equal(runtime.calls.control.length, 1);
    assert.equal(runtime.calls.sealed, 1);
  } finally {
    rmSync(runRoot, { recursive: true, force: true });
  }
});

test("resume preserves images and never repeats completed controls", async () => {
  const runRoot = root();
  try {
    const image = digest("manual-image");
    const runtime = ports();
    const input = {
      runRoot,
      jobs: [{ ...job("task-2", image), candidate: "skills/brand-guidelines" }],
      ports: runtime.port,
    };
    await runDemo1TaskEvidenceControls(input);
    await runDemo1TaskEvidenceControls(input);
    assert.equal(runtime.calls.control.length, 1);
    assert.equal(runtime.calls.sealed, 1);
    assert.deepEqual(runtime.calls.removed, []);
    assert.equal("ownedImages" in readDemo1TaskEvidenceRun(runRoot), false);
  } finally {
    rmSync(runRoot, { recursive: true, force: true });
  }
});

test("refuses the former automatic cleanup policy before touching shared Docker state", async () => {
  const runRoot = root();
  try {
    const runtime = ports();
    await assert.rejects(runDemo1TaskEvidenceControls({
      runRoot,
      jobs: [job("task-legacy-cleanup", digest("shared-image"))],
      ports: runtime.port,
      cleanupPolicy: "run-owned",
    }), /cleanup policies are unsupported/u);
    assert.deepEqual(runtime.calls.ensure, []);
    assert.deepEqual(runtime.calls.removed, []);
  } finally {
    rmSync(runRoot, { recursive: true, force: true });
  }
});

test("a grader invariant failure is terminal and does not auto-delete the newly pulled image", async () => {
  const runRoot = root();
  try {
    const runtime = ports();
    runtime.port.control = async () => ({ gold: "fail", empty: "fail" });
    await assert.rejects(runDemo1TaskEvidenceControls({
      runRoot,
      jobs: [job("task-3", digest("failed"))],
      ports: runtime.port,
    }), /control invariant failed/u);
    const state = readDemo1TaskEvidenceRun(runRoot);
    assert.equal(state.jobs[0].status, "failed");
    assert.equal(state.evidence.sealed, false);
    assert.deepEqual(runtime.calls.removed, []);
  } finally {
    rmSync(runRoot, { recursive: true, force: true });
  }
});
