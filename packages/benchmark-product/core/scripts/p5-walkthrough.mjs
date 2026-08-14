#!/usr/bin/env node

/**
 * Demo-1 P5's one-command plumbing gate. It drives the public operations facade through exactly
 * 3 tasks x 2 native Claude Code arms x 2 replicates, emits the local digest-addressed bundle,
 * deletes the builder workspace, and verifies the copied bundle cold. It never calls the
 * product's publication operation and never creates a public URL or discovery source.
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
  const launchLabels = new Set(["launch", "launch.from-lock", "resume"]);
  return steps.reduce((total, step) => {
    if (!launchLabels.has(step.label)) return total;
    if (!Number.isSafeInteger(step.elapsedMs) || step.elapsedMs < 0) {
      fail(`invalid durable launch timing for ${step.label}: ${String(step.elapsedMs)}`);
    }
    return total + step.elapsedMs;
  }, 0);
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

  removeRunOwnedBuilderWorkspace(workspaceDir);
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
  const claudePath = resolve(option("--claude", "JINN_P5_CLAUDE_PATH"));
  const claudeVersion = option("--claude-version", "JINN_P5_CLAUDE_VERSION");
  const claudeTokenFile = resolve(option("--claude-token-file", "JINN_P5_CLAUDE_TOKEN_FILE"));
  const dockerPath = resolve(option("--docker", "JINN_P5_DOCKER_PATH"));
  for (const [label, path] of [
    ["Claude Code", claudePath],
    ["Claude setup-token file", claudeTokenFile],
    ["Docker", dockerPath],
  ]) {
    if (!isAbsolute(path) || !existsSync(path)) fail(`${label} is not an existing absolute path`);
  }
  const requestedOutput = option("--output-dir", "JINN_P5_OUTPUT_DIR", { required: false });
  const requestedResume = option("--resume-output-dir", "JINN_P5_RESUME_OUTPUT_DIR", { required: false });
  if (requestedOutput !== undefined && requestedResume !== undefined) {
    fail("--output-dir and --resume-output-dir are mutually exclusive");
  }
  const resuming = requestedResume !== undefined;
  const runRoot = resuming
    ? resolve(requestedResume)
    : requestedOutput === undefined
      ? mkdtempSync(join(tmpdir(), "demo1-p5-output-"))
      : resolve(requestedOutput);
  if (requestedOutput !== undefined) mkdirSync(runRoot, { recursive: false });
  if (resuming && !existsSync(runRoot)) fail("--resume-output-dir does not exist");
  const workspaceDir = join(runRoot, "builder-workspace");
  const bundleDir = join(runRoot, "bundle");
  const transcriptPath = join(runRoot, "transcript.json");
  let checkpoint;
  if (resuming) {
    const statePath = join(runRoot, WALKTHROUGH_STATE);
    if (!existsSync(statePath)) fail("resume output has no durable walkthrough checkpoint");
    checkpoint = JSON.parse(readFileSync(statePath, "utf8"));
    if (checkpoint?.schema !== "demo1.p5-walkthrough-state/1" || checkpoint.draftId !== DRAFT_ID
      || checkpoint.completed === true || checkpoint.claudePath !== claudePath
      || checkpoint.claudeVersion !== claudeVersion || checkpoint.dockerPath !== dockerPath) {
      fail("resume checkpoint is completed, invalid, or bound to different runtime paths");
    }
    inspectP5DiskReserve(runRoot);
    checkpoint.resumeInvocations += 1;
    replaceWalkthroughState(runRoot, checkpoint);
  } else {
    const reserveAtStart = createP5DiskReserve(runRoot);
    checkpoint = {
      schema: "demo1.p5-walkthrough-state/1",
      draftId: DRAFT_ID,
      startedAt: new Date().toISOString(),
      phase: "initialized",
      completed: false,
      claudePath,
      claudeVersion,
      dockerPath,
      reserveAtStart,
      resumeInvocations: 0,
      steps: [],
    };
    writeWalkthroughState(runRoot, checkpoint);
  }
  const startedAt = new Date(checkpoint.startedAt);
  const diskAtStart = checkpoint.reserveAtStart.before;

  ensureBuilt();
  const core = await import(pathToFileURL(join(distRoot, "index.js")).href);
  const { createLocalVenue } = await import(pathToFileURL(join(distRoot, "venue", "venue.js")).href);
  const { materializePublicBundle } = await import(pathToFileURL(join(distRoot, "bundle", "materialize.js")).href);
  const { requireRunState } = await import(pathToFileURL(join(distRoot, "run", "state.js")).href);
  const records = await import("@jinn-network/benchmarking-records");
  const { graderProgramDigest } = await import("@jinn-network/task-execution-oci-grader");
  const { parseDsseEnvelope } = await import("@jinn-network/trust-core");

  if (checkpoint.phase === "bundle-staged") {
    const transcript = await finishStagedBundle({
      runRoot,
      workspaceDir,
      bundleDir,
      transcriptPath,
      checkpoint,
      verifyPublicBundle: core.verifyPublicBundle,
    });
    process.stdout.write(`${JSON.stringify(transcript, null, 2)}\n`);
    return;
  }

  const sourceMd = new Uint8Array(readFileSync(join(fixtureRoot, "instructions", "source.md")));
  const frontmatter = JSON.parse(readFileSync(join(fixtureRoot, "instructions", "frontmatter.json"), "utf8"));
  const artifacts = core.generateDemo1InstructionArtifacts(sourceMd, frontmatter);
  const runtime = core.createDemo1ClaudeRuntimeBinding({
    executablePath: claudePath,
    harnessVersion: claudeVersion,
    artifacts,
    oauthCredential: {
      tokenFilePath: claudeTokenFile,
      wrapperPath: join(runRoot, "demo1-claude-oauth-wrapper.mjs"),
    },
  });
  const readiness = await runtime.probe();
  if (!readiness.ready) {
    writeFileSync(transcriptPath, `${JSON.stringify({
      schema: "demo1.p5-stop-evidence/1",
      stoppedAt: new Date().toISOString(),
      reason: "claude-runtime-not-ready",
      readiness,
      diskAtStart,
    }, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    fail(`Claude runtime readiness failed; evidence: ${transcriptPath}`);
  }

  const dockerGatePath = createDockerGateWrapper(runRoot, dockerPath);
  let greenBaseline = checkpoint.greenBaseline;
  if (!resuming) {
    ({ transcript: greenBaseline } = await runCanonicalP5GreenBaseline({
      runRoot,
      dockerPath: dockerGatePath,
    }));
    if (!greenBaseline.passed) fail("gold/empty grader control did not pass for all three tasks");
    checkpoint.greenBaseline = greenBaseline;
    checkpoint.readiness = readiness;
    checkpoint.phase = "baseline-passed";
    replaceWalkthroughState(runRoot, checkpoint);
  } else if (greenBaseline?.passed !== true) {
    fail("resume checkpoint has no completed gold/empty grader control");
  }
  const createVenue = (options) => createLocalVenue({
    ...options,
    demo1ClaudeRuntime: runtime,
    sweRebenchGrader: {
      runtime: "docker",
      dockerPath: dockerGatePath,
      allowPublicNetwork: false,
    },
  });
  const context = {
    workspaceDir,
    principal: "p5-operator",
    clock: () => new Date().toISOString(),
  };
  const steps = checkpoint.steps;
  const step = async (label, operation) => {
    const before = Date.now();
    const result = await operation();
    steps.push({ label, elapsedMs: Date.now() - before });
    replaceWalkthroughState(runRoot, checkpoint);
    return expectOk(label, result);
  };

  const rows = JSON.parse(readFileSync(join(fixtureRoot, "rows.json"), "utf8"));
  const provenance = JSON.parse(readFileSync(join(fixtureRoot, "provenance.json"), "utf8"));
  const timestamps = Object.fromEntries(
    provenance.rows.map((row) => [row.instance_id, rfc3339(row.createdAt)]),
  );

  let benchmarkSha256;
  let runSha256;
  let diskBeforeLaunch;
  if (!resuming) {
    await step("init", () => core.initWorkspace(context));
    await step("draft.create", () => core.createDraft(context, {
      draftId: DRAFT_ID,
      name: "Demo-1 P5 plumbing gate",
      description: "Disposable three-task plumbing proof; not a capability measurement.",
    }));
    const imported = await step("import.swebench", () => core.importSweBenchRows(context, {
      draftId: DRAFT_ID,
      rows,
      name: "Demo-1 P5 micro-slate",
      description: "Three repositories; plumbing-only and below paired-delta minN.",
      version: "1.0.0",
      provenanceTimestamps: timestamps,
    }));
    benchmarkSha256 = imported.benchmarkSha256;
    await step("arm.add baseline", () => core.armAdd(context, {
      draftId: DRAFT_ID,
      armId: BASELINE_ARM,
      pinning: p5ArmPinning(core.demo1ClaudeArmRequirements(runtime, "claude-md")),
      notes: "Native root CLAUDE.md baseline B.",
    }));
    await step("arm.add candidate", () => core.armAdd(context, {
      draftId: DRAFT_ID,
      armId: CANDIDATE_ARM,
      pinning: p5ArmPinning(core.demo1ClaudeArmRequirements(runtime, "skill")),
      notes: "Native Claude Code skill arm A.",
    }));
    await step("draft.update", () => core.updateDraft(context, {
      draftId: DRAFT_ID,
      patch: {
        replicates: 2,
        assurance: { preset: "direct-check", overrides: { maxInfrastructureRetries: 1 } },
        analysis: {
          method: "jinn.benchmarking.method/paired-delta",
          version: "1",
          baseline: BASELINE_ARM,
          candidate: CANDIDATE_ARM,
          parameters: { seed: SEED, resamples: RESAMPLES, alpha: "0.05" },
        },
      },
    }));
    const quoted = await step("quote", () => core.runQuote(context, { draftId: DRAFT_ID }, { createVenue }));
    if (!quoted.quote.ok || quoted.quote.expectedCellCount !== 12
      || quoted.presentation.coverage.refusals.length !== 0) {
      fail(`quote did not admit exactly 12 cells: ${JSON.stringify(quoted)}`);
    }
    const locked = await step("lock", () => core.runLock(context, { draftId: DRAFT_ID }));
    runSha256 = locked.runSha256;
    checkpoint.benchmarkSha256 = benchmarkSha256;
    checkpoint.runSha256 = runSha256;
    checkpoint.phase = "locked";
    replaceWalkthroughState(runRoot, checkpoint);
    diskBeforeLaunch = recoverP5DiskCapacity(runRoot, "official P5 launch");
    await step("launch", () => core.runLaunch(context, { draftId: DRAFT_ID }, { createVenue }));
    checkpoint.phase = "launched";
    replaceWalkthroughState(runRoot, checkpoint);
  } else {
    benchmarkSha256 = checkpoint.benchmarkSha256;
    runSha256 = checkpoint.runSha256;
    if (typeof benchmarkSha256 !== "string" || typeof runSha256 !== "string") {
      fail("resume checkpoint predates the sealed Benchmark/Run boundary");
    }
    diskBeforeLaunch = recoverP5DiskCapacity(runRoot, "resume preflight");
  }

  let status = await step("status", () => core.runStatus(context, { draftId: DRAFT_ID }));
  if (p5CheckpointAction(status) === "launch") {
    recoverP5DiskCapacity(runRoot, "before same-Run launch");
    await step("launch.from-lock", () => core.runLaunch(context, { draftId: DRAFT_ID }, { createVenue }));
    checkpoint.phase = "launched";
    replaceWalkthroughState(runRoot, checkpoint);
    status = await step("status.after-launch", () => core.runStatus(context, { draftId: DRAFT_ID }));
  }
  if (p5CheckpointAction(status) === "resume") {
    recoverP5DiskCapacity(runRoot, "before same-cell resume");
    await step("resume", () => core.runResume(context, { draftId: DRAFT_ID }, { createVenue }));
    checkpoint.phase = "resumed";
    replaceWalkthroughState(runRoot, checkpoint);
    status = await step("status.after-resume", () => core.runStatus(context, { draftId: DRAFT_ID }));
  }
  assertP5ReadyToCollect(status);
  let lifecycleState = status.state;
  let collected;
  if (lifecycleState === "running") {
    collected = await step("collect", () => core.runCollect(context, { draftId: DRAFT_ID }));
    checkpoint.matrixSha256 = collected.matrixSha256;
    checkpoint.phase = "closed";
    replaceWalkthroughState(runRoot, checkpoint);
    lifecycleState = "closed";
  } else if (lifecycleState === "closed" || lifecycleState === "reported") {
    const existing = requireRunState(workspaceDir, DRAFT_ID);
    if (existing.matrixSha256 === undefined) fail(`${lifecycleState} checkpoint has no sealed Matrix`);
    collected = { matrixSha256: existing.matrixSha256 };
  } else {
    fail(`cannot resume from lifecycle state ${String(lifecycleState)}`);
  }

  const results = await step("results", () => core.runResults(context, { draftId: DRAFT_ID }));
  let reported;
  if (lifecycleState === "closed") {
    reported = await step("report", () => core.runReport(context, { draftId: DRAFT_ID }));
    checkpoint.reportSha256 = reported.reportSha256;
    checkpoint.reportEnvelopeSha256 = reported.reportEnvelopeSha256;
    checkpoint.phase = "reported";
    replaceWalkthroughState(runRoot, checkpoint);
  } else {
    if (results.report === undefined) fail("reported checkpoint has no readable Report projection");
    reported = {
      reportSha256: results.report.reportSha256,
      reportEnvelopeSha256: results.report.reportEnvelopeSha256,
      claimPackage: results.report.claimPackage,
    };
  }
  const verified = await step("verify", () => core.runVerify(context, { draftId: DRAFT_ID }));

  const matrix = records.parseMatrix(core.getSealedBytes(workspaceDir, collected.matrixSha256));
  const run = records.parseRun(core.getSealedBytes(workspaceDir, runSha256));
  const report = records.parseReport(core.getSealedBytes(workspaceDir, reported.reportSha256));
  if (run.replicates !== 2 || run.arms.map((arm) => arm.armId).sort().join(",")
    !== [BASELINE_ARM, CANDIDATE_ARM].sort().join(",")) {
    fail(`sealed Run does not carry exactly the two A/B arms and two replicates`);
  }
  const pairedPlan = run.analysisPlan?.find((entry) => entry.method === "jinn.benchmarking.method/paired-delta");
  if (pairedPlan?.version !== "1" || pairedPlan.parameters?.seed !== SEED
    || pairedPlan.parameters?.resamples !== RESAMPLES || pairedPlan.parameters?.alpha !== "0.05") {
    fail(`sealed Run paired-delta plan moved: ${JSON.stringify(pairedPlan)}`);
  }
  const comparison = reported.claimPackage.comparison;
  const { clusterCount, draws } = auditP5Accounting({ matrix, status, comparison });

  const expectedProgram = graderProgramDigest().slice("sha256:".length);
  for (const cell of matrix.cells) {
    for (const verdict of cell.validVerdicts) {
      const envelope = parseDsseEnvelope(core.getSealedBytes(workspaceDir, verdict.slice("sha256:".length)));
      const statement = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(envelope.payloadBytes));
      if (statement.predicate?.evaluationMethod?.digest?.sha256 !== expectedProgram) {
        fail(`${cell.cellKey} verdict did not bind the frozen grader program`);
      }
    }
  }

  const runState = requireRunState(workspaceDir, DRAFT_ID);
  const materialized = materializePublicBundle({
    workspaceDir,
    draftId: DRAFT_ID,
    benchmarkSha256,
    runState,
  });
  if (existsSync(bundleDir)) {
    const existing = await core.verifyPublicBundle(bundleDir);
    if (existing.identity !== materialized.identity) fail("staged bundle identity disagrees on resume");
  } else {
    const bundleStage = join(runRoot, ".bundle-staging");
    rmSync(bundleStage, { recursive: true, force: true });
    cpSync(materialized.bundleDir, bundleStage, { recursive: true, errorOnExist: true, force: false });
    const staged = await core.verifyPublicBundle(bundleStage);
    if (staged.identity !== materialized.identity) fail("copied bundle identity disagrees before cold cut");
    renameSync(bundleStage, bundleDir);
  }

  const pendingTranscript = {
    schema: "demo1.p5-plumbing/1",
    startedAt: startedAt.toISOString(),
    scope: {
      taskCount: 3,
      arms: [CANDIDATE_ARM, BASELINE_ARM],
      replicates: 2,
      cells: 12,
      statement: "This disposable micro-slate proves plumbing, not capability.",
      publicationBoundary: "Local immutable bundle only; no public URL, discovery source, mirror, or publication claim.",
    },
    readiness,
    greenBaseline,
    disk: {
      atStart: diskAtStart,
      beforeLaunch: diskBeforeLaunch,
      recoveryLog: P5_RECOVERY_LOG,
    },
    fixture: {
      rows: provenance.rows.map((row) => ({
        instanceId: row.instance_id,
        repo: row.repo,
        imageDigest: row.imageDigest,
      })),
      parser: provenance.parser,
      graderProgramDigest: provenance.graderProgramDigest,
      timeoutSeconds: provenance.timeoutSeconds,
    },
    digests: {
      benchmarkSha256,
      runSha256,
      matrixSha256: collected.matrixSha256,
      reportSha256: reported.reportSha256,
      reportEnvelopeSha256: reported.reportEnvelopeSha256,
      bundleIdentity: materialized.identity,
    },
    accounting: {
      status: status.counts,
      evaluationRecovery: status.evaluationRecovery,
      matrix: matrix.completeness,
      perAxis: Object.fromEntries(["harness", "model", "loadout", "isolation"].map((axis) => [
        axis,
        { match: matrix.cells.filter((cell) => cell.verification[axis] === "match").length },
      ])),
      clusters: comparison.bootstrap.clusters,
      bootstrap: {
        seed: SEED,
        resamples: RESAMPLES,
        clusterCount,
        draws,
        identity: "interval withheld; draws performed = 0; resamples is planned capacity",
      },
    },
    report: {
      method: report.method,
      pairs: comparison.pairs,
      delta: comparison.delta,
      interval: comparison.interval,
      withheldReasons: comparison.reasons,
      plumbingNotCapability: true,
    },
    timing: {
      launchElapsedMs: p5LaunchElapsedMs(steps),
      meanLaunchPipelineCellMs: Math.round(p5LaunchElapsedMs(steps) / 12),
      steps,
    },
    verification: {
      workspaceChecks: verified.checks,
    },
    bundleDir,
  };
  checkpoint.phase = "bundle-staged";
  checkpoint.pendingTranscript = pendingTranscript;
  replaceWalkthroughState(runRoot, checkpoint);
  const transcript = await finishStagedBundle({
    runRoot,
    workspaceDir,
    bundleDir,
    transcriptPath,
    checkpoint,
    verifyPublicBundle: core.verifyPublicBundle,
  });
  process.stdout.write(`${JSON.stringify(transcript, null, 2)}\n`);
}

if (process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
