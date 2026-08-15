import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

export const DEMO1_TASK_EVIDENCE_RUN_SCHEMA = "jinn.demo1.task-evidence-run.v2";
const STATE_NAME = "task-evidence-run.json";
const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/u;

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function compareCodeUnits(left, right) {
  return left === right ? 0 : left < right ? -1 : 1;
}

function syncDirectory(path) {
  const fd = openSync(path, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function writeState(runRoot, state) {
  const destination = join(runRoot, STATE_NAME);
  const temporary = `${destination}.tmp-${process.pid}-${randomUUID()}`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  const fd = openSync(temporary, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, destination);
  syncDirectory(dirname(destination));
}

function normalizedJobs(jobs) {
  const values = jobs.map((job) => {
    if (typeof job?.candidate !== "string" || job.candidate.length === 0
      || typeof job?.taskId !== "string" || job.taskId.length === 0
      || !/^[0-9a-f]{64}$/u.test(job.taskSha256)
      || !SHA256_DIGEST.test(job.imageDigest)
      || !SHA256_DIGEST.test(job.graderProgramDigest)) throw new TypeError("task-evidence job identity is invalid");
    return {
      candidate: job.candidate,
      taskId: job.taskId,
      taskSha256: job.taskSha256,
      imageDigest: job.imageDigest,
      graderProgramDigest: job.graderProgramDigest,
    };
  }).sort((left, right) => compareCodeUnits(left.candidate, right.candidate)
    || compareCodeUnits(left.taskId, right.taskId));
  const identities = values.map((job) => `${job.candidate}\u0000${job.taskId}`);
  if (new Set(identities).size !== identities.length) throw new TypeError("task-evidence jobs must be unique");
  return values;
}

function newState(jobs) {
  const planSha256 = sha256(canonical(jobs));
  return {
    schema: DEMO1_TASK_EVIDENCE_RUN_SCHEMA,
    planSha256,
    jobs: jobs.map((job) => ({ ...job, status: "pending", attempts: 0, result: null, error: null })),
    evidence: { sealed: false, sha256: null },
  };
}

function readState(runRoot) {
  return JSON.parse(readFileSync(join(runRoot, STATE_NAME), "utf8"));
}

function validateState(state, jobs) {
  if (state?.schema !== DEMO1_TASK_EVIDENCE_RUN_SCHEMA
    || state.planSha256 !== sha256(canonical(jobs))
    || !Array.isArray(state.jobs)) {
    throw new Error("task-evidence checkpoint does not match the immutable run plan");
  }
  for (const job of state.jobs) {
    if (job.status === "running") job.status = "pending";
  }
  return state;
}

function infrastructureError(error) {
  return error !== null && typeof error === "object" && error.infrastructure === true;
}

function safeError(error) {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/**
 * Sequential, crash-resumable evidence controls. The supplied `control` port is the existing
 * no-network OCI grader boundary and must return gold PASS plus empty FAIL. Shared Docker image
 * ownership cannot be proven from before/after inventories, so this coordinator never deletes
 * images, caches, volumes, user data, or other shared state. Any cleanup is a separate, explicit
 * operator action after inspecting the sealed evidence and current Docker use.
 */
export async function runDemo1TaskEvidenceControls({
  runRoot,
  jobs,
  ports,
  cleanupPolicy,
}) {
  if (cleanupPolicy !== undefined) {
    throw new TypeError("task-evidence cleanup policies are unsupported; shared Docker images require a separate operator action");
  }
  const plan = normalizedJobs(jobs);
  const statePath = join(runRoot, STATE_NAME);
  const state = existsSync(statePath)
    ? validateState(readState(runRoot), plan)
    : newState(plan);
  writeState(runRoot, state);
  if (state.evidence.sealed) return state;

  for (const job of state.jobs) {
    if (job.status === "complete") continue;
    if (job.status === "failed") throw new Error(`task-evidence job ${job.taskId} is terminally failed`);
    job.status = "running";
    job.attempts += 1;
    job.error = null;
    writeState(runRoot, state);
    try {
      await ports.assertDisk(`task-evidence image ${job.taskId}`);
      await ports.ensureImage(job);
      const after = new Set(await ports.listImages());
      if (!after.has(job.imageDigest)) throw Object.assign(new Error("exact pinned image is absent after pre-stage"), { infrastructure: true });
      await ports.assertDisk(`task-evidence grader ${job.taskId}`);
      const result = await ports.control(job);
      if (result?.gold !== "pass" || result?.empty !== "fail"
        || result?.taskLicense !== "match" || result?.conflictingInstructionFileAbsent !== "match"
        || result?.imagePullPolicy !== "never" || result?.networkPolicy !== "none"
        || result?.graderProgramDigest !== job.graderProgramDigest) {
        throw new Error(
          `control invariant failed: gold=${String(result?.gold)} empty=${String(result?.empty)} `
          + `license=${String(result?.taskLicense)} conflict=${String(result?.conflictingInstructionFileAbsent)} `
          + `pull=${String(result?.imagePullPolicy)} network=${String(result?.networkPolicy)} `
          + `grader=${String(result?.graderProgramDigest)}`,
        );
      }
      job.result = result;
      job.status = "complete";
      writeState(runRoot, state);
    } catch (error) {
      job.error = { infrastructure: infrastructureError(error), detail: safeError(error) };
      job.status = infrastructureError(error) && job.attempts < 2 ? "pending" : "failed";
      writeState(runRoot, state);
      if (job.status === "pending") continue;
      throw error;
    }
  }
  if (!state.jobs.every((job) => job.status === "complete")) {
    return runDemo1TaskEvidenceControls({ runRoot, jobs: plan, ports });
  }
  const evidenceSha256 = await ports.sealEvidence(state.jobs.map((job) => ({
    candidate: job.candidate,
    taskId: job.taskId,
    taskSha256: job.taskSha256,
    imageDigest: job.imageDigest,
    graderProgramDigest: job.graderProgramDigest,
    result: job.result,
  })));
  if (typeof evidenceSha256 !== "string" || !/^[0-9a-f]{64}$/u.test(evidenceSha256)) {
    throw new Error("sealed task evidence did not return an exact sha256");
  }
  state.evidence = { sealed: true, sha256: evidenceSha256 };
  writeState(runRoot, state);
  return state;
}

export function readDemo1TaskEvidenceRun(runRoot) {
  return readState(runRoot);
}
