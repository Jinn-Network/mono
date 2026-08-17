/** Official Harbor CLI launcher. The local TEP backend owns Submission/Attempt/Delivery. */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AttemptIdentity } from "@jinn-network/task-execution-supervisor";
import type { LauncherCapabilities, LauncherContract, LaunchPlan } from "@jinn-network/task-execution-launchers";
import type { TaskView, WorkspacePaths } from "@jinn-network/task-execution-workspace";
import { HARBOR_ADAPTER_ID, type HarborSelectionManifest } from "./manifest.js";
import type { HarborHostBinding } from "./host.js";

export const HARBOR_LAUNCHER_ID = "harbor";

export function harborJobName(submissionSha256: string, dispatch: number): string {
  if (!/^[a-f0-9]{64}$/.test(submissionSha256) || !Number.isInteger(dispatch) || dispatch < 1) throw new TypeError("Harbor Job naming requires a Submission digest and positive dispatch index");
  return `jinn-${submissionSha256.slice(0, 24)}-d${dispatch}`;
}

export function harborArmJobName(runSha256: string, armId: string): string {
  if (!/^[a-f0-9]{64}$/.test(runSha256)) throw new TypeError("Harbor per-arm Job naming requires a Run digest");
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(armId)) throw new TypeError("Harbor per-arm Job naming requires a well-formed arm id");
  return `jinn-${runSha256.slice(0, 24)}-${armId}`;
}

export function harborJobScopedTempDir(jobsDir: string, jobName: string): string {
  return join(jobsDir, `${jobName}.tmpdir`);
}

export function harborPlannedJobChildEnv(env: NodeJS.ProcessEnv, tempDir: string): NodeJS.ProcessEnv {
  return { ...env, TMPDIR: tempDir, TMP: tempDir, TEMP: tempDir };
}

/** Planned Harbor jobs run k sequential trials; each may take the 900s task-agent timeout. */
export function harborPlannedJobWaitMs(nAttempts: number): number {
  const attempts = Number.isInteger(nAttempts) && nAttempts >= 1 ? nAttempts : 1;
  return Math.max(120_000, attempts * 900_000 + 120_000);
}

export function harborArmFollowUpJobName(
  runSha256: string,
  armId: string,
  submissionSha256: string,
  dispatch: number,
): string {
  if (!/^[a-f0-9]{64}$/.test(runSha256)) throw new TypeError("Harbor per-arm follow-up Job naming requires a Run digest");
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(armId)) throw new TypeError("Harbor per-arm follow-up Job naming requires a well-formed arm id");
  if (!/^[a-f0-9]{64}$/.test(submissionSha256)) throw new TypeError("Harbor per-arm follow-up Job naming requires a Submission digest");
  if (!Number.isInteger(dispatch) || dispatch < 2) throw new TypeError("Harbor per-arm follow-up Job naming requires a replacement dispatch index");
  return `jinn-${runSha256.slice(0, 24)}-${armId}-d${dispatch}-${submissionSha256.slice(0, 12)}`;
}

/** Official Harbor writes result.json at job start with finished_at: null; fake Harbor omits the field. */
export function harborJobResultFinished(result: Readonly<Record<string, unknown>>): boolean {
  return result.finished_at !== null;
}

export function harborTrialResultTerminal(result: Readonly<Record<string, unknown>>): boolean {
  if (result.status === "success" || result.status === "error" || result.status === "failed") return true;
  return typeof result.finished_at === "string" && result.finished_at.length > 0;
}

/** Official Harbor oracle does not write the rehearsal prediction.json; reward.txt is the native score. */
export function harborPredictionFromVerifierReward(rewardText: string, submittedAt: string): Uint8Array {
  const trimmed = rewardText.trim();
  const probabilityYes = trimmed === "1" || trimmed === "1.0" ? "1.0" : trimmed === "0" || trimmed === "0.0" ? "0.0" : trimmed;
  return new TextEncoder().encode(JSON.stringify({ probabilityYes, submittedAt }));
}

function requirePinnedHarbor(view: TaskView, manifest: HarborSelectionManifest): void {
  const requirements = view.effectiveRequirements as Record<string, unknown>;
  const harness = requirements.harness as { id?: unknown; version?: unknown } | undefined;
  if (harness?.id !== HARBOR_LAUNCHER_ID || harness.version !== manifest.harbor.version) {
    throw new TypeError("Harbor Submission does not carry the exact selected Harbor harness/version pin");
  }
  const model = requirements.model as { id?: unknown } | undefined;
  const agent = requirements.agent as { id?: unknown } | undefined;
  const arm = manifest.arms.find((candidate) => candidate.agent.id === agent?.id && candidate.model.id === model?.id);
  if (arm === undefined) throw new TypeError("Harbor Submission does not carry an exact selected arm AgentConfig/model pin");
}

function closedHarborEnv(paths: WorkspacePaths): Record<string, string> {
  return { PATH: process.env.PATH ?? "/usr/bin:/bin", HARBOR_TELEMETRY: "0", DO_NOT_TRACK: "1", TMPDIR: paths.tmp };
}

function harborInvocationPlan(argv: readonly string[], paths: WorkspacePaths): LaunchPlan {
  return {
    argv: [...argv], cwd: paths.work,
    // The backend spawns with exactly this environment. Keep the surface closed while
    // retaining PATH so an already byte-pinned executable with an `/usr/bin/env` shebang can
    // resolve its interpreter and installed dependencies. No credentials or arbitrary
    // ambient variables cross the boundary.
    env: closedHarborEnv(paths), validExitCodes: [0],
    blameExitCodes: [{ match: { signal: "SIGTERM" }, blame: "infrastructure", reasonCode: "cancelled" }],
    resultContract: { envelopeFormat: "harbor-job-directory-v1", correlationFields: ["harnessVersion"] }, interruptionBehavior: "nonrepeatable",
  };
}

function harborArmDispatchPlan(executable: string, paths: WorkspacePaths): LaunchPlan {
  const rolePath = join(paths.meta, "harbor-arm-role");
  const jobPath = join(paths.input, "harbor-job.json");
  const waitPath = join(paths.meta, "harbor-arm-wait.json");
  const script = `const { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } = require("fs");
const { join } = require("path");
const { spawnSync } = require("child_process");
const waitPath = ${JSON.stringify(waitPath)};
const rolePath = ${JSON.stringify(rolePath)};
const jobPath = ${JSON.stringify(jobPath)};
const deadline = Date.now() + 120000;
const excluded = new Set(["AgentTimeoutError","VerifierTimeoutError","RewardFileNotFoundError","RewardFileEmptyError","VerifierOutputParseError"]);
function sleep(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
function waitFor(pred, until = deadline) {
  while (!pred()) {
    if (Date.now() >= until) { console.error("timed out waiting for Harbor Job"); process.exit(1); }
    sleep(25);
  }
}
waitFor(() => existsSync(waitPath) && existsSync(jobPath) && existsSync(rolePath));
const wait = JSON.parse(readFileSync(waitPath, "utf8"));
const role = readFileSync(rolePath, "utf8").trim();
const job = JSON.parse(readFileSync(jobPath, "utf8"));
const resultPath = join(job.jobs_dir, job.job_name, "result.json");
const harborTmp = join(job.jobs_dir, job.job_name + ".tmpdir");
const harborEnv = Object.assign({}, process.env, { TMPDIR: harborTmp, TMP: harborTmp, TEMP: harborTmp });
const runDeadline = wait.kind === "planned"
  ? Date.now() + Math.max(120000, (Number.isInteger(Number(job.n_attempts)) && Number(job.n_attempts) >= 1 ? Number(job.n_attempts) : 1) * 900000 + 120000)
  : deadline;
function jobFinished() {
  try {
    const result = JSON.parse(readFileSync(resultPath, "utf8"));
    return result.finished_at !== null;
  } catch { return false; }
}
function trialTerminal(result) {
  return result.status === "success" || result.status === "error" || result.status === "failed" || (typeof result.finished_at === "string" && result.finished_at.length > 0);
}
function mappingTrialDir() {
  if (!existsSync(wait.mappingPath)) return undefined;
  try {
    const mapped = JSON.parse(readFileSync(wait.mappingPath, "utf8"));
    const trialId = typeof mapped.trialId === "string" ? mapped.trialId : "";
    return trialId.replace(/\\.g\\d+$/, "");
  } catch { return undefined; }
}
function trialResultReady() {
  const dir = mappingTrialDir();
  return dir !== undefined && existsSync(join(wait.jobRoot, dir, "result.json"));
}
function thisGenerationOwnsLiveDir() {
  const dir = mappingTrialDir();
  if (dir === undefined || !existsSync(wait.mappingPath)) return false;
  try {
    return statSync(join(wait.jobRoot, dir, "config.json")).mtimeMs <= statSync(wait.mappingPath).mtimeMs + 50;
  } catch { return false; }
}
function dispatchReady() {
  if (existsSync(wait.snapshotRetryPath)) return true;
  const owns = thisGenerationOwnsLiveDir();
  if (existsSync(wait.mappingPath) && !owns) {
    return jobFinished();
  }
  if (!trialResultReady() || !owns) return false;
  const dir = mappingTrialDir();
  try {
    const result = JSON.parse(readFileSync(join(wait.jobRoot, dir, "result.json"), "utf8"));
    if (trialTerminal(result)) return true;
    if (typeof result.exception_type === "string" && excluded.has(result.exception_type)) return true;
    if (typeof result.exceptionType === "string" && excluded.has(result.exceptionType)) return true;
  } catch { return false; }
  return false;
}
if (wait.kind === "follow-up") {
  if (role !== "leader" || existsSync(resultPath)) {
    waitFor(() => jobFinished());
    process.exit(0);
  }
  mkdirSync(harborTmp, { recursive: true });
  const result = spawnSync(${JSON.stringify(executable)}, ["run", "-c", jobPath], { stdio: "inherit", env: harborEnv, cwd: process.cwd() });
  process.exit(result.status === null ? 1 : result.status);
}
if (role === "leader" && wait.kind === "planned") {
  mkdirSync(job.jobs_dir, { recursive: true });
  if (!existsSync(wait.startedMarkerPath)) {
    try {
      writeFileSync(wait.startedMarkerPath, "started\\n", { flag: "wx" });
      mkdirSync(harborTmp, { recursive: true });
      const result = spawnSync(${JSON.stringify(executable)}, ["run", "-c", jobPath], { stdio: "ignore", env: harborEnv, cwd: process.cwd() });
      if (result.status !== 0) process.exit(result.status === null ? 1 : result.status);
    } catch (cause) {
      if (cause.code !== "EEXIST") throw cause;
    }
  }
}
waitFor(() => existsSync(wait.mappingPath) && dispatchReady(), runDeadline);
process.exit(0);
`;
  return harborInvocationPlan([process.execPath, "-e", script], paths);
}

export function makeHarborLauncher(input: { readonly manifest: HarborSelectionManifest; readonly host: HarborHostBinding }): LauncherContract {
  const executable = input.host.executable;
  const executableDigest = createHash("sha256").update(readFileSync(executable)).digest("hex");
  if (executableDigest !== input.manifest.harbor.executableSha256) throw new TypeError("Harbor executable bytes drifted from the sealed selection manifest");
  return {
    id: HARBOR_LAUNCHER_ID,
    capabilities: (): LauncherCapabilities => ({
      taskProfiles: ["https://spec.jinn.network/task-profiles/prediction-forecast/1.0", "https://spec.jinn.network/task-profiles/repository-work/1.0"],
      inputMediaTypes: ["application/json", "text/plain"], outputMediaTypes: ["application/json"], structuredOutput: true,
      resume: false, interruptionBehaviorDefault: "nonrepeatable", secretForwards: [],
      runPinning: { keys: [
        { key: "harness", inventory: [HARBOR_LAUNCHER_ID], posture: "enforced" },
        { key: "agent", inventory: input.manifest.arms.map((arm) => arm.agent.id), posture: "enforced" },
        { key: "model", inventory: input.manifest.arms.map((arm) => arm.model.id), posture: "enforced" },
        { key: "isolationPolicy", inventory: ["unrestricted"], posture: "enforced" },
      ] },
    }),
    async probe() {
      const actual = createHash("sha256").update(readFileSync(executable)).digest("hex");
      if (actual !== input.manifest.harbor.executableSha256) return { ready: false, detail: "Harbor executable bytes drifted from selection" };
      let version: string;
      try { version = execFileSync(executable, ["--version"], { encoding: "utf8", env: { PATH: process.env.PATH ?? "", HARBOR_TELEMETRY: "0", DO_NOT_TRACK: "1" } }).trim().replace(/^harbor\s+/iu, ""); }
      catch { return { ready: false, detail: "Harbor version probe failed" }; }
      return version === input.manifest.harbor.version
        ? { ready: true }
        : { ready: false, detail: `Harbor version drifted: expected ${input.manifest.harbor.version}, got ${version}` };
    },
    plan(view: TaskView, paths: WorkspacePaths, attempt: AttemptIdentity): LaunchPlan {
      void attempt;
      requirePinnedHarbor(view, input.manifest);
      const grain = input.manifest.jobGrain ?? "per-dispatch";
      if (grain === "per-arm") return harborArmDispatchPlan(executable, paths);
      return harborInvocationPlan([executable, "run", "-c", join(paths.input, "harbor-job.json")], paths);
    },
  };
}
