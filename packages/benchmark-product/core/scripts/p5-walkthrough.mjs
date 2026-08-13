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
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { auditP5Accounting } from "./p5-accounting.mjs";
import { assertP5DiskGate } from "./p5-disk-gate.mjs";
import { runP5GreenBaseline } from "./p5-green-baseline.mjs";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixtureRoot = join(packageRoot, "fixtures", "p5-micro-slate");
const distRoot = join(packageRoot, "dist");
const RESAMPLES = 1_000;
const SEED = 2_026_081_3;
const DRAFT_ID = "demo1-p5-plumbing";
const BASELINE_ARM = "claude-md-baseline";
const CANDIDATE_ARM = "skill-candidate";

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

function ensureBuilt() {
  const tsc = join(packageRoot, "node_modules", "typescript", "bin", "tsc");
  if (!existsSync(tsc)) fail("dependencies are not installed; run the package's immutable install first");
  rmSync(distRoot, { recursive: true, force: true });
  const built = spawnSync(process.execPath, [tsc, "-p", "tsconfig.build.json"], {
    cwd: packageRoot,
    stdio: "inherit",
  });
  if (built.status !== 0) fail(`clean build exited ${String(built.status)}`);
}

function createDockerGateWrapper(root, dockerPath) {
  const wrapper = join(root, "p5-docker-gate.mjs");
  const source = `#!${process.execPath}
import { statfsSync } from "node:fs";
import { spawnSync } from "node:child_process";
const minimum = 40n * 1024n * 1024n * 1024n;
function gate(phase) {
  const stats = statfsSync("/", { bigint: true });
  const available = stats.bavail * stats.bsize;
  if (available < minimum) {
    console.error("P5 disk gate refused Docker " + phase + ": " +
      (Number(available) / 1024 ** 3).toFixed(2) + " GiB free; 40.00 GiB required. " +
      "No caches or user data were deleted.");
    process.exit(78);
  }
}
gate("before " + (process.argv[2] ?? "command"));
const result = spawnSync(${JSON.stringify(dockerPath)}, process.argv.slice(2), {
  stdio: "inherit", env: process.env,
});
gate("after " + (process.argv[2] ?? "command"));
if (result.error !== undefined) {
  console.error(result.error.message);
  process.exit(127);
}
if (result.signal !== null) process.kill(process.pid, result.signal);
process.exit(result.status ?? 1);
`;
  writeFileSync(wrapper, source, { encoding: "utf8", mode: 0o700, flag: "wx" });
  chmodSync(wrapper, 0o700);
  return wrapper;
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

async function main() {
  const claudePath = resolve(option("--claude", "JINN_P5_CLAUDE_PATH"));
  const claudeVersion = option("--claude-version", "JINN_P5_CLAUDE_VERSION");
  const dockerPath = resolve(option("--docker", "JINN_P5_DOCKER_PATH"));
  for (const [label, path] of [["Claude Code", claudePath], ["Docker", dockerPath]]) {
    if (!isAbsolute(path) || !existsSync(path)) fail(`${label} executable is not an existing absolute path`);
  }
  const requestedOutput = option("--output-dir", "JINN_P5_OUTPUT_DIR", { required: false });
  const runRoot = requestedOutput === undefined
    ? mkdtempSync(join(tmpdir(), "demo1-p5-output-"))
    : resolve(requestedOutput);
  if (requestedOutput !== undefined) mkdirSync(runRoot, { recursive: false });
  const workspaceDir = join(runRoot, "builder-workspace");
  const bundleDir = join(runRoot, "bundle");
  const transcriptPath = join(runRoot, "transcript.json");
  const startedAt = new Date();
  const diskAtStart = assertP5DiskGate("walkthrough start");

  ensureBuilt();
  const core = await import(pathToFileURL(join(distRoot, "index.js")).href);
  const { createLocalVenue } = await import(pathToFileURL(join(distRoot, "venue", "venue.js")).href);
  const { materializePublicBundle } = await import(pathToFileURL(join(distRoot, "bundle", "materialize.js")).href);
  const { requireRunState } = await import(pathToFileURL(join(distRoot, "run", "state.js")).href);
  const records = await import("@jinn-network/benchmarking-records");
  const { graderProgramDigest } = await import("@jinn-network/task-execution-oci-grader");
  const { parseDsseEnvelope } = await import("@jinn-network/trust-core");

  const sourceMd = new Uint8Array(readFileSync(join(fixtureRoot, "instructions", "source.md")));
  const frontmatter = JSON.parse(readFileSync(join(fixtureRoot, "instructions", "frontmatter.json"), "utf8"));
  const artifacts = core.generateDemo1InstructionArtifacts(sourceMd, frontmatter);
  const runtime = core.createDemo1ClaudeRuntimeBinding({
    executablePath: claudePath,
    harnessVersion: claudeVersion,
    artifacts,
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
  const { transcript: greenBaseline } = await runCanonicalP5GreenBaseline({
    runRoot,
    dockerPath: dockerGatePath,
  });
  if (!greenBaseline.passed) fail("gold/empty grader control did not pass for all three tasks");
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
  const steps = [];
  const step = async (label, operation) => {
    const before = Date.now();
    const result = await operation();
    steps.push({ label, elapsedMs: Date.now() - before });
    return expectOk(label, result);
  };

  const rows = JSON.parse(readFileSync(join(fixtureRoot, "rows.json"), "utf8"));
  const provenance = JSON.parse(readFileSync(join(fixtureRoot, "provenance.json"), "utf8"));
  const timestamps = Object.fromEntries(
    provenance.rows.map((row) => [row.instance_id, rfc3339(row.createdAt)]),
  );

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
  await step("arm.add baseline", () => core.armAdd(context, {
    draftId: DRAFT_ID,
    armId: BASELINE_ARM,
    pinning: core.demo1ClaudeArmRequirements(runtime, "claude-md"),
    notes: "Native root CLAUDE.md baseline B.",
  }));
  await step("arm.add candidate", () => core.armAdd(context, {
    draftId: DRAFT_ID,
    armId: CANDIDATE_ARM,
    pinning: core.demo1ClaudeArmRequirements(runtime, "skill"),
    notes: "Native Claude Code skill arm A.",
  }));
  await step("draft.update", () => core.updateDraft(context, {
    draftId: DRAFT_ID,
    patch: {
      replicates: 2,
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

  const diskBeforeLaunch = assertP5DiskGate("official P5 launch");
  const launchStarted = Date.now();
  await step("launch", () => core.runLaunch(context, { draftId: DRAFT_ID }, { createVenue }));
  const launchElapsedMs = Date.now() - launchStarted;
  const status = await step("status", () => core.runStatus(context, { draftId: DRAFT_ID }));
  const collected = await step("collect", () => core.runCollect(context, { draftId: DRAFT_ID }));
  await step("results", () => core.runResults(context, { draftId: DRAFT_ID }));
  const reported = await step("report", () => core.runReport(context, { draftId: DRAFT_ID }));
  const verified = await step("verify", () => core.runVerify(context, { draftId: DRAFT_ID }));

  const matrix = records.parseMatrix(core.getSealedBytes(workspaceDir, collected.matrixSha256));
  const run = records.parseRun(core.getSealedBytes(workspaceDir, locked.runSha256));
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
    benchmarkSha256: imported.benchmarkSha256,
    runState,
  });
  cpSync(materialized.bundleDir, bundleDir, { recursive: true, errorOnExist: true, force: false });
  rmSync(workspaceDir, { recursive: true, force: true });
  if (existsSync(workspaceDir)) fail("builder workspace survived deletion-portability cut");
  const coldVerification = await core.verifyPublicBundle(bundleDir);

  const transcript = {
    schema: "demo1.p5-plumbing/1",
    startedAt: startedAt.toISOString(),
    completedAt: new Date().toISOString(),
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
    disk: { atStart: diskAtStart, beforeLaunch: diskBeforeLaunch },
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
      benchmarkSha256: imported.benchmarkSha256,
      runSha256: locked.runSha256,
      matrixSha256: collected.matrixSha256,
      reportSha256: reported.reportSha256,
      reportEnvelopeSha256: reported.reportEnvelopeSha256,
      bundleIdentity: materialized.identity,
    },
    accounting: {
      status: status.counts,
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
        identity: "draws = resamples x clusterCount",
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
      launchElapsedMs,
      meanLaunchPipelineCellMs: Math.round(launchElapsedMs / 12),
      steps,
    },
    verification: {
      workspaceChecks: verified.checks,
      builderWorkspaceDeleted: true,
      coldBundleChecks: coldVerification.checks,
    },
    bundleDir,
  };
  writeFileSync(transcriptPath, `${JSON.stringify(transcript, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
  process.stdout.write(`${JSON.stringify(transcript, null, 2)}\n`);
}

if (process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
