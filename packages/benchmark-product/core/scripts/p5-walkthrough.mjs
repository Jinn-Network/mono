#!/usr/bin/env node

/**
 * Demo-1 P5 plumbing helpers remain for offline tests. The live walkthrough path is retired:
 * this branch removed the Demo-1 hub APIs it called. Deleting the rest of the programme-script
 * family is issue #3985.
 */
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  cpSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { auditP5Accounting } from "./p5-accounting.mjs";
import {
  createP5DiskReserve,
  inspectP5DiskReserve,
  P5_RECOVERY_LOG,
  recoverP5DiskCapacity,
  releaseP5DiskReserve,
} from "./p5-disk-reserve.mjs";
import { runP5GreenBaseline } from "./p5-green-baseline.mjs";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixtureRoot = join(packageRoot, "fixtures", "p5-micro-slate");
const distRoot = join(packageRoot, "dist");
const RESAMPLES = 1_000;
const SEED = 2_026_081_3;
const DRAFT_ID = "demo1-p5-plumbing";
const BASELINE_ARM = "claude-md-baseline";
const CANDIDATE_ARM = "skill-candidate";
const WALKTHROUGH_STATE = "p5-walkthrough-state.json";
const LAUNCH_STEP_LABELS = new Set(["launch", "launch.from-lock", "resume"]);

function fail(message) {
  throw new Error(`P5 walkthrough: ${message}`);
}

function option(name, environmentName, { required = true } = {}) {
  const index = process.argv.indexOf(name);
  const value = index === -1 ? process.env[environmentName] : process.argv[index + 1];
  if (required && (value === undefined || value.length === 0)) {
    fail(`${name} (or ${environmentName}) is required`);
  }
  return value;
}

function expectOk(label, result) {
  if (result?.ok !== true) fail(`${label} failed: ${JSON.stringify(result)}`);
  return result.result;
}

export function p5BuildEntrypoint() {
  return join(packageRoot, "scripts", "build.mjs");
}

function ensureBuilt() {
  const tsc = join(packageRoot, "node_modules", "typescript", "bin", "tsc");
  if (!existsSync(tsc)) fail("dependencies are not installed; run the package's immutable install first");
  const buildEntrypoint = p5BuildEntrypoint();
  if (!existsSync(buildEntrypoint)) fail("the package's canonical build entrypoint is missing");
  const built = spawnSync(process.execPath, [buildEntrypoint], {
    cwd: packageRoot,
    stdio: "inherit",
  });
  if (built.status !== 0) fail(`canonical clean build exited ${String(built.status)}`);
}

export function createDockerGateWrapper(root, dockerPath) {
  const wrapper = join(root, "p5-docker-gate.mjs");
  const recoveryModule = pathToFileURL(join(packageRoot, "scripts", "p5-disk-reserve.mjs")).href;
  const source = `#!${process.execPath}
import { spawnSync } from "node:child_process";
import { recoverP5DiskCapacity } from ${JSON.stringify(recoveryModule)};
const runRoot = ${JSON.stringify(root)};
try {
  recoverP5DiskCapacity(runRoot, "before Docker " + (process.argv[2] ?? "command"));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(78);
}
const result = spawnSync(${JSON.stringify(dockerPath)}, process.argv.slice(2), {
  stdio: "inherit", env: process.env,
});
try {
  recoverP5DiskCapacity(runRoot, "after Docker " + (process.argv[2] ?? "command"));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(78);
}
if (result.error !== undefined) {
  console.error(result.error.message);
  process.exit(127);
}
if (result.signal !== null) process.kill(process.pid, result.signal);
process.exit(result.status ?? 1);
`;
  if (existsSync(wrapper)) {
    if (readFileSync(wrapper, "utf8") !== source) fail("run-owned Docker gate wrapper changed; refusing resume");
    return wrapper;
  }
  writeFileSync(wrapper, source, { encoding: "utf8", mode: 0o700, flag: "wx" });
  chmodSync(wrapper, 0o700);
  return wrapper;
}

function writeWalkthroughState(runRoot, state) {
  const destination = join(runRoot, WALKTHROUGH_STATE);
  const temporary = `${destination}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  const fileFd = openSync(temporary, "r");
  try {
    fsyncSync(fileFd);
  } finally {
    closeSync(fileFd);
  }
  renameSync(temporary, destination);
  const directoryFd = openSync(runRoot, "r");
  try {
    fsyncSync(directoryFd);
  } finally {
    closeSync(directoryFd);
  }
}

function replaceWalkthroughState(runRoot, state) {
  const destination = join(runRoot, WALKTHROUGH_STATE);
  const temporary = `${destination}.tmp`;
  rmSync(temporary, { force: true });
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  const fileFd = openSync(temporary, "r");
  try {
    fsyncSync(fileFd);
  } finally {
    closeSync(fileFd);
  }
  renameSync(temporary, destination);
  const directoryFd = openSync(runRoot, "r");
  try {
    fsyncSync(directoryFd);
  } finally {
    closeSync(directoryFd);
  }
}

function writeDurableJsonExclusive(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  const fileFd = openSync(path, "r");
  try {
    fsyncSync(fileFd);
  } finally {
    closeSync(fileFd);
  }
  const directoryFd = openSync(dirname(path), "r");
  try {
    fsyncSync(directoryFd);
  } finally {
    closeSync(directoryFd);
  }
}

/** Restore deletion permission only on directories owned by this run's operator, then remove it. */
export function removeRunOwnedBuilderWorkspace(workspaceDir) {
  const operatorUid = typeof process.getuid === "function" ? process.getuid() : undefined;
  const prepareDirectory = (path) => {
    const entry = lstatSync(path);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      fail(`builder workspace contains a non-directory where a directory was expected: ${path}`);
    }
    if (operatorUid !== undefined && entry.uid !== operatorUid) {
      fail(`builder workspace directory is not owned by the current operator: ${path}`);
    }
    chmodSync(path, 0o700);
    for (const child of readdirSync(path, { withFileTypes: true })) {
      if (child.isDirectory() && !child.isSymbolicLink()) {
        prepareDirectory(join(path, child.name));
      }
    }
  };
  prepareDirectory(workspaceDir);
  rmSync(workspaceDir, { recursive: true, force: true });
}

/** Rebuild run time from durable step evidence so a post-run resume cannot reset it to zero. */
export function p5LaunchElapsedMs(steps) {
  return steps.reduce((total, step) => {
    if (!LAUNCH_STEP_LABELS.has(step.label)) return total;
    if (!Number.isSafeInteger(step.elapsedMs) || step.elapsedMs < 0) {
      fail(`invalid durable launch timing for ${step.label}: ${String(step.elapsedMs)}`);
    }
    return total + step.elapsedMs;
  }, 0);
}

/**
 * Close a durable launch-timing boundary left open by a terminated process. The recovered
 * duration deliberately includes the interruption window: omitting it would understate the
 * end-to-end time consumed by the same locked Run.
 */
export function recoverInterruptedP5LaunchStep(checkpoint, nowMs = Date.now()) {
  const inFlight = checkpoint?.inFlightLaunchStep;
  if (inFlight === undefined) return undefined;
  if (!LAUNCH_STEP_LABELS.has(inFlight.label)
    || !Number.isSafeInteger(inFlight.startedAtUnixMs) || inFlight.startedAtUnixMs < 0
    || !Number.isSafeInteger(nowMs) || nowMs < inFlight.startedAtUnixMs
    || !Array.isArray(checkpoint.steps)) {
    fail("durable in-flight launch timing is invalid");
  }
  const recovered = {
    label: inFlight.label,
    elapsedMs: nowMs - inFlight.startedAtUnixMs,
    interrupted: true,
  };
  checkpoint.steps.push(recovered);
  delete checkpoint.inFlightLaunchStep;
  return recovered;
}

function rfc3339(value) {
  const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.\d+)?Z?$/u.exec(value);
  if (match === null) fail(`fixture provenance timestamp is not a supported UTC instant: ${value}`);
  const normalized = `${match[1]}T${match[2]}Z`;
  const instant = new Date(normalized);
  if (Number.isNaN(instant.valueOf()) || instant.toISOString().replace(".000Z", "Z") !== normalized) {
    fail(`fixture provenance timestamp is not calendar-valid: ${value}`);
  }
  return normalized;
}

/** Canonical walkthrough boundary: every green-baseline pre-stage stop must emit v2 evidence. */
export async function runCanonicalP5GreenBaseline({
  runRoot,
  dockerPath,
  runGreenBaseline = runP5GreenBaseline,
}) {
  return runGreenBaseline({
    dockerPath,
    output: join(runRoot, "green-baseline.json"),
    stopOutput: join(runRoot, "green-baseline-prestage-stop.json"),
    attempt: 1,
  });
}

/**
 * `compileDraft` owns the venue isolation policy in `policy.submissionBaseline`. The Demo-1
 * runtime helper returns the complete effective requirement set because launcher/preflight callers
 * need it, so the operations path must remove that one baseline-owned key before sealing an arm.
 * Duplicating it on an arm is invalid under RunRecord §7.79 even when the value is identical.
 */
export function p5ArmPinning(effectiveRequirements) {
  if (effectiveRequirements?.isolationPolicy !== "unrestricted") {
    fail("Demo-1 effective requirements did not carry the expected unrestricted isolation policy");
  }
  const { isolationPolicy: _baselineOwned, ...armPinning } = effectiveRequirements;
  return armPinning;
}

export function p5ResumeNeeded(status) {
  return (status?.evaluationRecovery?.pendingCells ?? 0) > 0
    || status?.counts?.judged < status?.counts?.expected;
}

export function p5CheckpointAction(status) {
  if (status?.state === "locked") return "launch";
  if (status?.state === "running") return p5ResumeNeeded(status) ? "resume" : "collect";
  if (status?.state === "closed") return "report";
  if (status?.state === "reported") return "verify";
  fail(`cannot resume from lifecycle state ${String(status?.state)}`);
}

export function assertP5ReadyToCollect(status) {
  if ((status?.evaluationRecovery?.pendingCells ?? 0) > 0) {
    fail("evaluation retry remains pending; checkpoint is resumable and collect was not attempted");
  }
  if ((status?.evaluationRecovery?.exhaustedCells ?? 0) > 0) {
    fail("the single sealed evaluation retry was exhausted; P5 remains incomplete");
  }
  if (status?.counts?.judged !== status?.counts?.expected) {
    fail("not all cells reached a grader outcome; checkpoint remains resumable");
  }
}

export async function finishStagedBundle({
  runRoot,
  workspaceDir,
  bundleDir,
  transcriptPath,
  checkpoint,
  verifyPublicBundle,
  releaseReserve = releaseP5DiskReserve,
}) {
  const pending = checkpoint.pendingTranscript;
  if (pending?.schema !== "demo1.p5-plumbing/1"
    || typeof pending.digests?.bundleIdentity !== "string") {
    fail("bundle-staged checkpoint has no valid pending transcript");
  }
  if (existsSync(transcriptPath)) {
    const existing = JSON.parse(readFileSync(transcriptPath, "utf8"));
    if (existing?.schema !== pending.schema
      || existing?.digests?.bundleIdentity !== pending.digests.bundleIdentity
      || existsSync(workspaceDir)) {
      fail("completed transcript disagrees with its staged bundle checkpoint");
    }
    const verified = await verifyPublicBundle(bundleDir);
    if (verified.identity !== pending.digests.bundleIdentity) {
      fail("completed transcript names a different cold bundle identity");
    }
    checkpoint.phase = "complete";
    checkpoint.completed = true;
    checkpoint.completedAt = existing.completedAt;
    delete checkpoint.pendingTranscript;
    replaceWalkthroughState(runRoot, checkpoint);
    return existing;
  }

  // A process may stop after the deletion-portability cut but before cold verification or the
  // transcript write. Absence is therefore the expected resumable state, not an ENOENT failure.
  if (existsSync(workspaceDir)) removeRunOwnedBuilderWorkspace(workspaceDir);
  if (existsSync(workspaceDir)) fail("builder workspace survived deletion-portability cut");
  const coldVerification = await verifyPublicBundle(bundleDir);
  if (coldVerification.identity !== pending.digests.bundleIdentity) {
    fail("cold bundle identity moved after builder-workspace deletion");
  }
  const reserveRelease = releaseReserve(runRoot, "cold bundle verified");
  const transcript = {
    ...pending,
    completedAt: new Date().toISOString(),
    disk: { ...pending.disk, reserveRelease },
    verification: {
      ...pending.verification,
      builderWorkspaceDeleted: true,
      coldBundleChecks: coldVerification.checks,
    },
  };
  writeDurableJsonExclusive(transcriptPath, transcript);
  checkpoint.phase = "complete";
  checkpoint.completed = true;
  checkpoint.completedAt = transcript.completedAt;
  delete checkpoint.pendingTranscript;
  replaceWalkthroughState(runRoot, checkpoint);
  return transcript;
}

async function main() {
  fail(
    "the Demo-1 Claude walkthrough path is retired; remaining programme-script deletion is issue #3985",
  );
}

if (process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
