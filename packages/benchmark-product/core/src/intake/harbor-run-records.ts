// SPDX-License-Identifier: Apache-2.0

/**
 * Harbor 0.21 jobs/trials reader for `run import --from harbor` (#3991).
 *
 * This is a named harness reader, not a second interpretation of Harbor output. Trial identity
 * (task name, attempt) is the same mapping the orchestrated path already uses:
 * `harborTrialTaskName` / `assignHarborTrialAttempt` (Harbor 0.21 omits `attempt_number`) and
 * `taskNameByDigestFromSuite` / `digestByTaskNameFromSuite` from `from-harbor.ts`. Outcomes are
 * the closed import vocabulary. One finished trial becomes one per-attempt record; timings and
 * evidence paths are carried. Missing expected slots are written as `unrun` with a reason so the
 * denominator does not shrink. Extra or duplicate trials are left for the sealed-slate validator
 * (#2979) to refuse.
 *
 * On a draft bound by `method terminal-bench-2.1` the task names are the ones the official slate
 * seals, and a name is not enough to place a trial (#4937): the trial must carry the package ref
 * the Task seals, and its job must not name another dataset revision. The agent is resolved per
 * trial, because Harbor 0.21 leaves its default agent out of the job `config.json`.
 *
 * A trial of such a task is graded from Harbor's raw reward (#4938). Each official Task seals an
 * `external-verifier` EvaluationSpec that declares the measurements a reward map is read into, and
 * a trial whose `result.json` carries that map is imported as `graded` with those measurements.
 * The reader supplies no verdict: the Task's sealed rule gives it at import and the checker
 * recomputes it. A task with no official pin, or whose spec is of another family, is never graded.
 *
 * The reader accepts a job only when Harbor wrote it at a version this reader has a real jobs
 * directory of (`HARBOR_RUN_IMPORT_VERSIONS`), and only with retries off. Both are refused by job
 * name before any trial is read.
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import {
  basename,
  isAbsolute,
  join,
  parse as parsePath,
  relative as relativePath,
  resolve as resolvePath,
  sep,
  win32,
} from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  cellKey,
  expectedCellSet,
  itemTaskDigest,
  parseBenchmark,
  parseRun,
  type CellCoord,
} from "@jinn-network/benchmarking-records";
import {
  EXTERNAL_VERIFIER_FAMILY,
  compareCodePointStrings,
  parseEvaluationSpec,
  readExternalVerifierMeasurements,
  type ExternalVerifierBlock,
  type MeasurementDeclaration,
  type MeasurementMap,
} from "@jinn-network/task-execution-profiles";
import type { DraftDocument } from "../domain/draft.js";
import { refuse } from "../errors.js";
import { readDraftDocument } from "../operations/drafts.js";
import {
  assignHarborTrialAttempt,
  harborTrialTaskName,
  HarborSelectionManifestSchema,
  isHarborCompatibleEvaluationRuntime,
  type HarborSelectionManifest,
} from "../runtime/harbor/manifest.js";
import { harborTrialExceptionType } from "../runtime/harbor/retry-bind.js";
import { harborTrialResultTerminal } from "../runtime/harbor/launcher.js";
import {
  digestByTaskNameFromSuite,
  suiteSelectionFromHarbor,
  taskNameByDigestFromSuite,
} from "../runtime/suite-protocol/from-harbor.js";
import {
  EXTERNAL_IMPORT_MAX_AGGREGATE_BYTES,
  type CarriedEvidence,
  type ExternalRunImportSource,
} from "../run/external-import.js";
import { requireRunState } from "../run/state.js";
import { getSealedBytes } from "../workspace/sealed-store.js";
import type { ExternalRunEvidenceRef, ExternalRunRecord } from "./external-run-records.js";
import { TERMINAL_BENCH_21_ITEM_PROFILE_URI } from "./terminal-bench-2-1.js";

export interface HarborImportArm {
  readonly armId: string;
  readonly agentName?: string;
  readonly modelName?: string;
}

/**
 * The Harbor versions this reader accepts: exactly the versions that wrote a real jobs directory
 * kept under `test/fixtures/`, and a test holds the two lists equal. What the reader knows about
 * a jobs directory (where the reward is, how two attempts of a task are laid out, where the
 * version itself is stated) was read from those records, so a job written by any other version is
 * refused by name instead of being read on a guess. To accept a version, add its record.
 */
export const HARBOR_RUN_IMPORT_VERSIONS = ["0.21.0"] as const;

/**
 * Evidence bytes the reader allows for each expected cell of the locked run.
 *
 * Measured on a real Harbor 0.21.0 run of eight trials (two tasks, two arms, two attempts,
 * 2026-10-06): the most evidence one trial carried was 1,126,370 bytes, of which the largest file
 * was 588,436 bytes, and both timed-out trials were over 0.9 MiB. Evidence grew with agent time,
 * at 1.0 to 1.3 KB for each second, so a trial that runs to its agent timeout is the large case.
 * 1 MiB would already refuse the largest measured cell. 4 MiB is 3.7 times that cell, and about
 * twice an estimate, made at the measured rate from the tasks' agent timeouts, of what two agent
 * arms would carry if every trial of the full slate ran to its timeout. The measurement is thin
 * (two short tasks, one model), which is why the figure leans high: refusing a run after it was
 * paid for costs more than a loose bound on the claimant's own files. The 8 MiB cap on a single
 * evidence file is not moved by this.
 */
export const HARBOR_RUN_IMPORT_EVIDENCE_BYTES_PER_CELL = 4 * 1024 * 1024;

/** The most evidence, in bytes, a Harbor import of this many expected cells may carry: the
 * default aggregate cap, or the per-cell figure times the cells when that is larger. */
export function harborRunImportEvidenceCap(expectedCellCount: number): number {
  return Math.max(
    EXTERNAL_IMPORT_MAX_AGGREGATE_BYTES,
    expectedCellCount * HARBOR_RUN_IMPORT_EVIDENCE_BYTES_PER_CELL,
  );
}

/** What the official Terminal-Bench 2.1 slate seals about one task (`sealOfficialItem`). */
export interface HarborOfficialTaskPin {
  readonly datasetId: string;
  readonly datasetRevision: string;
  readonly packageRef: string;
  /**
   * The measurements the Task's sealed `external-verifier` EvaluationSpec declares for harness
   * `harbor`. Present, a trial's raw reward map is read into them and the trial is graded.
   * Absent, no trial of this task is graded. They sit on the pin so that a task cannot be graded
   * unless its trials are also held to the sealed package ref.
   */
  readonly measurements?: readonly MeasurementDeclaration[];
}

export interface ReadHarborRunRecordsInput {
  readonly jobsDir: string;
  /** Suite protocol `taskName → taskSha256`. Prefer `digestByTaskNameFromSuite`. */
  readonly digestByTaskName: Readonly<Record<string, string>>;
  readonly arms: readonly HarborImportArm[];
  readonly expected: readonly CellCoord[];
  /**
   * Official-slate pins by task digest. A trial that lands on a pinned task must carry the sealed
   * package ref, and its job must not name another dataset revision.
   */
  readonly officialPins?: Readonly<Record<string, HarborOfficialTaskPin>>;
}

export interface HarborRunImportDump {
  readonly records: readonly ExternalRunRecord[];
  readonly source: ExternalRunImportSource;
  readonly evidenceRoot: string;
  /** The aggregate evidence cap for this run (`harborRunImportEvidenceCap`), for the caller to
   * pass to the import. */
  readonly maxAggregateEvidenceBytes: number;
}

const UTF8 = new TextDecoder("utf8", { fatal: true });
const SHIM_MARKET_PREFIX = "terminal-bench-2-1/";
const EXTRA_ARM = "extra";

function readJsonObject(path: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(UTF8.decode(readFileSync(path)));
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/**
 * Child directory names in Unicode code-point order.
 *
 * The order decides more than the row numbers. Harbor does not number two attempts of one task:
 * they are sibling trial directories that differ only in a random suffix, and the reader numbers
 * them in the order it meets them. A locale-aware comparison would let the machine's locale
 * choose which trial is replicate 1 (`__EZiYZgD` sorts before `__eiRCBED` by code point and after
 * it in a dictionary order), and with it the cell keys and the dump's identity. Code-point order
 * is the same on every machine.
 */
function childDirectories(root: string): readonly string[] {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => entry.name)
      .sort(compareCodePointStrings);
  } catch {
    return [];
  }
}

function isHarborTrialConfig(config: Record<string, unknown> | undefined): config is Record<string, unknown> {
  return config !== undefined && harborTrialTaskName(config).length > 0;
}

function trialDirectoryNames(jobDir: string): readonly string[] {
  return childDirectories(jobDir).filter((name) =>
    isHarborTrialConfig(readJsonObject(join(jobDir, name, "config.json"))),
  );
}

function isHarborJobRoot(dir: string): boolean {
  return trialDirectoryNames(dir).length > 0;
}

/** A job is named as Harbor named it (`--job-name`), or by its directory when it states no name. */
function harborJobName(jobRoot: string, jobConfig: Record<string, unknown> | undefined): string {
  return typeof jobConfig?.["job_name"] === "string" ? jobConfig["job_name"] : basename(jobRoot);
}

function harborJobRoots(jobsDir: string): readonly string[] {
  if (!existsSync(jobsDir) || !statSync(jobsDir).isDirectory()) {
    refuse("validation", "jobs-dir", `Harbor jobs directory ${jobsDir} does not exist`);
  }
  if (isHarborJobRoot(jobsDir)) return [jobsDir];
  const nested = childDirectories(jobsDir)
    .map((name) => join(jobsDir, name))
    .filter((dir) => isHarborJobRoot(dir));
  return nested;
}

interface HarborAgent {
  readonly name?: string;
  readonly modelName?: string;
}

function harborAgent(value: unknown): HarborAgent | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const agent = {
    ...(typeof record["name"] === "string" ? { name: record["name"] } : {}),
    ...(typeof record["model_name"] === "string" ? { modelName: record["model_name"] } : {}),
  };
  return agent.name === undefined && agent.modelName === undefined ? undefined : agent;
}

/** The job `config.json` agent speaks for a trial only when the job names exactly one. */
function jobAgent(config: Record<string, unknown> | undefined): HarborAgent | undefined {
  const agents = config?.["agents"];
  return Array.isArray(agents) && agents.length === 1 ? harborAgent(agents[0]) : undefined;
}

/** The job `lock.json` lists each planned trial with its agent, keyed by task and not by trial. */
function lockAgent(lock: Record<string, unknown> | undefined, taskName: string): HarborAgent | undefined {
  const trials = lock?.["trials"];
  if (!Array.isArray(trials)) return undefined;
  const agents = new Map<string, HarborAgent>();
  for (const entry of trials) {
    if (typeof entry !== "object" || entry === null) continue;
    const planned = entry as Record<string, unknown>;
    if (harborTrialTaskName(planned) !== taskName) continue;
    const agent = harborAgent(planned["agent"]);
    if (agent !== undefined) agents.set(JSON.stringify([agent.name, agent.modelName]), agent);
  }
  return agents.size === 1 ? [...agents.values()][0] : undefined;
}

/**
 * The agent that ran one trial. Harbor 0.21 omits defaults from what it saves, so a job run with
 * the default agent has no `agents` in its `config.json` and no `agent` in a trial `config.json`.
 * The trial `result.json` echoes the full trial config, and the job `lock.json` lists the agent
 * of every planned trial, so those are read before the job-level agent.
 */
function trialAgent(input: {
  readonly trial: Record<string, unknown>;
  readonly result: Record<string, unknown> | undefined;
  readonly lock: Record<string, unknown> | undefined;
  readonly jobConfig: Record<string, unknown> | undefined;
  readonly taskName: string;
}): HarborAgent {
  const echoed = input.result?.["config"];
  return (typeof echoed === "object" && echoed !== null
    ? harborAgent((echoed as Record<string, unknown>)["agent"])
    : undefined)
    ?? harborAgent(input.trial["agent"])
    ?? lockAgent(input.lock, input.taskName)
    ?? jobAgent(input.jobConfig)
    ?? {};
}

function resolveArmId(
  agent: HarborAgent,
  arms: readonly HarborImportArm[],
  where: string,
): string {
  if (arms.length === 1) return arms[0]!.armId;
  const matched = arms.filter((arm) => {
    if (agent.name !== undefined && arm.agentName !== undefined && agent.name !== arm.agentName) return false;
    if (agent.modelName !== undefined && arm.modelName !== undefined && agent.modelName !== arm.modelName) {
      return false;
    }
    if (agent.name !== undefined && arm.agentName === undefined && agent.name !== arm.armId) return false;
    return arm.agentName !== undefined || agent.name === arm.armId || agent.name === undefined;
  });
  if (matched.length === 1) return matched[0]!.armId;
  if (agent.name !== undefined) {
    const byId = arms.filter((arm) => arm.armId === agent.name);
    if (byId.length === 1) return byId[0]!.armId;
  }
  const who = agent.name === undefined
    ? "An unnamed Harbor agent"
    : `Harbor agent "${agent.name}"${agent.modelName === undefined ? "" : ` with model "${agent.modelName}"`}`;
  refuse(
    "validation",
    "harbor-arm",
    `${who} in trial ${where} does not match exactly one locked arm (locked arms: `
      + `${arms.map((arm) => arm.armId).join(", ")}). A trial is placed on the arm whose id is the `
      + "Harbor agent name, or whose pinning carries agent.id and model.id equal to the Harbor "
      + "agent name and model_name.",
  );
}

function trialTaskField(trial: Record<string, unknown>, field: string): string | undefined {
  const task = trial["task"];
  if (typeof task !== "object" || task === null) return undefined;
  const value = (task as Record<string, unknown>)[field];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * A trial placed on an official-slate task must be a trial of that task, not of one that shares
 * its name. The sealed Task names the dataset revision and the task's package ref; Harbor records
 * the dataset ref on the job and the package ref on the trial. A mismatch is refused with both
 * values. A job that records no dataset ref is accepted: the package ref still binds each trial.
 */
function assertOfficialTaskPin(input: {
  readonly pin: HarborOfficialTaskPin;
  readonly trial: Record<string, unknown>;
  readonly jobConfig: Record<string, unknown> | undefined;
  readonly jobName: string;
  readonly where: string;
  readonly taskName: string;
}): void {
  const { pin, trial, jobConfig, jobName, where } = input;
  const rerun = `Run Harbor against the sealed revision (harbor run -d '${pin.datasetId}@${pin.datasetRevision}') `
    + "and import that jobs directory.";
  const source = trialTaskField(trial, "source");
  const datasets = jobConfig?.["datasets"];
  for (const entry of Array.isArray(datasets) ? datasets : []) {
    if (typeof entry !== "object" || entry === null) continue;
    const dataset = entry as Record<string, unknown>;
    if (source !== undefined && typeof dataset["name"] === "string" && dataset["name"] !== source) continue;
    const ref = dataset["ref"];
    if (typeof ref !== "string" || ref.length === 0 || ref === pin.datasetRevision) continue;
    refuse(
      "validation",
      "harbor-dataset-ref",
      `Harbor job ${jobName} ran dataset ${typeof dataset["name"] === "string" ? dataset["name"] : "(unnamed)"} at ${ref}, `
        + `but the locked slate seals ${pin.datasetId} at ${pin.datasetRevision}. ${rerun}`,
    );
  }
  const name = trialTaskField(trial, "name") ?? input.taskName;
  const ref = trialTaskField(trial, "ref");
  if (ref === undefined) {
    refuse(
      "validation",
      "harbor-task-ref",
      `Harbor trial ${where} records no package ref for task ${name}, and the locked slate seals `
        + `${pin.packageRef} for it: a task name alone does not say which task ran. ${rerun}`,
    );
  }
  if (ref !== pin.packageRef) {
    refuse(
      "validation",
      "harbor-task-ref",
      `Harbor trial ${where} ran task ${name} at package ref ${ref}, but the locked slate seals `
        + `${pin.packageRef} for that task. ${rerun}`,
    );
  }
}

function extraCellKey(taskName: string, attempt: number): string {
  const digest = createHash("sha256").update(`harbor-extra:${taskName}`).digest("hex");
  const replicate = Number.isInteger(attempt) && attempt >= 1 ? attempt : 1;
  return cellKey(digest, EXTRA_ARM, replicate);
}

function relativeEvidencePath(jobsDir: string, absolute: string): string {
  return relativePath(jobsDir, absolute).split(sep).join("/");
}

function evidenceIfPresent(jobsDir: string, absolute: string, name: string): ExternalRunEvidenceRef | undefined {
  if (!existsSync(absolute) || !statSync(absolute).isFile()) return undefined;
  return { name, path: relativeEvidencePath(jobsDir, absolute) };
}

function trialEvidence(jobsDir: string, trialDir: string): readonly ExternalRunEvidenceRef[] {
  const refs = [
    evidenceIfPresent(jobsDir, join(trialDir, "result.json"), "trial-result.json"),
    evidenceIfPresent(jobsDir, join(trialDir, "config.json"), "trial-config.json"),
    evidenceIfPresent(jobsDir, join(trialDir, "verifier", "reward.txt"), "reward.txt"),
    evidenceIfPresent(jobsDir, join(trialDir, "verifier", "reward.json"), "reward.json"),
    evidenceIfPresent(jobsDir, join(trialDir, "reward.json"), "reward-root.json"),
    evidenceIfPresent(jobsDir, join(trialDir, "artifacts", "prediction.json"), "prediction.json"),
    evidenceIfPresent(jobsDir, join(trialDir, "agent", "recording.cast"), "recording.cast"),
    evidenceIfPresent(jobsDir, join(trialDir, "agent", "trajectory.json"), "trajectory.json"),
  ].filter((ref): ref is ExternalRunEvidenceRef => ref !== undefined);
  return refs;
}

/** The evidence names under which the reader carries Harbor's own record of a trial. */
const HARBOR_TRIAL_RECORDS: ReadonlySet<string> = new Set(["trial-result.json", "trial-config.json"]);

/**
 * How Harbor 0.21 begins the message of each error that means the verifier wrote no usable reward
 * file (`RewardFileNotFoundError`, `RewardFileEmptyError`, `VerifierOutputParseError`, in
 * `harbor/verifier/verifier.py`). The rest of the message is the trial's reward file path, under
 * `trials_dir`.
 */
const HARBOR_REWARD_FILE_MESSAGES = [
  "No reward file found at ",
  "Reward file is empty at ",
  "Failed to parse rewards from text file ",
  "Failed to parse rewards from JSON file ",
] as const;

/**
 * The members Harbor 0.21 fills with the machine it ran on (`TrialResult`, `TrialConfig`):
 * `trial_uri` is the trial directory as an absolute `file:` URI, `exception_traceback` is a stack
 * trace of install paths, and `trials_dir` and the `path` of a local task are absolute when Harbor
 * was given an absolute path. A reward-file error's `exception_message` names the reward file
 * under `trials_dir`, so it is absolute when `trials_dir` is (#5289); its `exception_type` stays.
 * The last three are kept when relative.
 */
function isHarborHostPathMember(key: string, parentKey: string | undefined, valueText: string): boolean {
  if (key === "trial_uri" || key === "exception_traceback") return true;
  const pathValued = key === "trials_dir"
    || (key === "path" && (parentKey === "task" || parentKey === "task_id"))
    || (key === "exception_message" && parentKey === "exception_info");
  if (!pathValued) return false;
  const value: unknown = JSON.parse(valueText);
  if (typeof value !== "string") return false;
  // `win32` reads `/x`, `\x`, `C:\x` and `C:/x` as absolute: each platform Harbor runs on.
  if (key !== "exception_message") return win32.isAbsolute(value);
  return HARBOR_REWARD_FILE_MESSAGES.some((start) => value.startsWith(start) && win32.isAbsolute(value.slice(start.length)));
}

/**
 * The settings through which a Harbor run passes credentials to the agent, the environment and
 * the verifier: `kwargs` and `env` (agent, environment and verifier), `mcp_servers`, and
 * `headers` wherever they appear. These are the four `prune.mjs` requires to be empty.
 */
const HARBOR_SETTINGS = new Set(["kwargs", "env", "mcp_servers", "headers"]);

/**
 * The `TrialConfig` fields whose value is a path on the machine that ran Harbor, by Harbor 0.21's
 * own model (`harbor/models/trial/config.py`), with `[]` for any array index. In a trial
 * `result.json` they sit under `config`.
 */
const HARBOR_HOST_PATH_FIELDS = new Set([
  "environment.mounts[].source",
  "environment.extra_docker_compose[]",
  "extra_instruction_paths[]",
  "agent.skills[]",
  "agent.load_trajectory",
  "task.download_dir",
  "source_trial.path",
]);

/** A home directory on Linux (`/home/<name>`, `/root`), macOS (`/Users/<name>`) or Windows
 * (`C:\Users\<name>`, `C:/Users/<name>`), wherever it sits in a string, with any run of
 * separators (`C:\\Users\\<name>` as Python prints a Windows path). The name stops at `?`, `#`,
 * `&`, `=`, `;`, `:` and `@`, so a reason that shows it shows no query, fragment or password
 * after it. */
const HOME_DIRECTORY = /[\\/]+(?:home|Users)[\\/]+[^\\/\s"'`?#&=;:@]+|(?<![\w.-])\/root(?![\w.-])/iu;
/** A `file:` URI, however its path is spelled or percent-encoded. */
const FILE_URI = /(?<![a-z0-9+.-])file:\//iu;
/** `prune.mjs`'s credential-shaped name, widened to the names Harbor itself treats as sensitive
 * (`KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|AUTH`, `harbor/utils/env.py`). */
const CREDENTIAL_NAME = /key|secret|token|passw(?:or)?d|credential|auth|bearer/iu;
/** Harbor's placeholder for a value it reads from the host's environment: it names the variable,
 * not the value. A placeholder with a default (`${NAME:-value}`) carries the default, so it is
 * not one of these. */
const HARBOR_ENV_PLACEHOLDER = /^\$\{[^}:]+\}$/u;
/** Credentials by their shape, wherever they appear. The first three are `prune.mjs`'s, with
 * `sk-` held to the start of a word so that a name ending in `task-` or `disk-` is not one. */
const CREDENTIAL_TEXT: readonly (readonly [RegExp, string])[] = [
  [/(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{6,}/u, "a key-shaped string"],
  [/bearer\s+\S/iu, "a bearer credential"],
  [/[a-z][a-z0-9+.-]*:\/\/[^/\s?#@]*@/iu, "a URL carrying credentials"],
  [new RegExp(`[?&;][^=&#\\s]*(?:${CREDENTIAL_NAME.source})[^=&#\\s]*=[^&#\\s]`, "iu"), "a URL carrying credentials"],
  [/\*{4}/u, "a credential Harbor redacted to its first four and last three characters"],
];

/** A run of 20 or more letters, digits, `_` and `-` that mixes upper case, lower case and digits:
 * how most API keys and access tokens are spelled, and no setting name or model id is. */
function tokenShaped(text: string): boolean {
  return (text.match(/[A-Za-z0-9_-]{20,}/gu) ?? []).some((run) => /[A-Z]/u.test(run) && /[a-z]/u.test(run) && /[0-9]/u.test(run));
}

interface HostPath {
  readonly what: string;
  readonly path: string;
}

/** Whether `text` names `path` or something under it: an occurrence of `path` not followed by a
 * letter, digit, `_` or `-`, or by a `.` and one of those, so that `/home/runner-7` does not name
 * `/home/runner` and a path that ends a sentence is still named. */
function namesPath(text: string, path: string): boolean {
  for (let at = text.indexOf(path); at !== -1; at = text.indexOf(path, at + 1)) {
    const after = text.slice(at + path.length, at + path.length + 2);
    if (!/^(?:[\w-]|\.[\w-])/u.test(after)) return true;
  }
  return false;
}

/** Where a string sits in a trial record: the settings, the `env` and the credential-shaped name
 * it is under. */
interface Within {
  readonly settings: boolean;
  readonly inEnv: boolean;
  readonly credentialName: boolean;
}

/**
 * Why one key or string of a carried trial record cannot be published, or nothing. `shape` is
 * its field with every array index written `[]`; a key is checked by its text alone. A credential's
 * shape is checked first, so a string that holds one is reported by its kind before any rule that
 * shows text. Paths are shown in the reason; a credential never is.
 */
function trialRecordStringFinding(
  text: string,
  thisMachine: readonly HostPath[],
  shape: string | undefined,
  within: Within,
): string | undefined {
  for (const [pattern, what] of CREDENTIAL_TEXT) {
    if (pattern.test(text)) return `holds ${what}`;
  }
  for (const { what, path } of thisMachine) {
    if (namesPath(text, path)) return `names ${what} (${path})`;
  }
  const home = HOME_DIRECTORY.exec(text);
  if (home !== null) return `names a home directory (${home[0]})`;
  if (FILE_URI.test(text)) return "holds a file: URI";
  if (shape !== undefined) {
    if (HARBOR_HOST_PATH_FIELDS.has(shape.replace(/^config\./u, "")) && win32.isAbsolute(text)) {
      return `names a path on the machine that ran Harbor (${text})`;
    }
  }
  if (shape === undefined || HARBOR_ENV_PLACEHOLDER.test(text)) return undefined;
  if (within.inEnv) return "holds an env value other than Harbor's ${NAME} placeholder, which can be a credential";
  if (within.credentialName && text !== "") return "holds a value under a credential-shaped name";
  if (within.settings && tokenShaped(text)) return "holds a token-shaped string, which can be a credential";
  return undefined;
}

/** The first key or string of a carried trial record that cannot be published, by its field. A
 * key is reported as a member name in the field that holds it, so the key itself is not shown. */
function trialRecordFinding(
  value: unknown,
  thisMachine: readonly HostPath[],
  field = "",
  shape = "",
  within: Within = { settings: false, inEnv: false, credentialName: false },
): { readonly field: string; readonly reason: string } | undefined {
  if (typeof value === "string") {
    const reason = trialRecordStringFinding(value, thisMachine, shape, within);
    return reason === undefined ? undefined : { field, reason };
  }
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) {
      const found = trialRecordFinding(entry, thisMachine, `${field}[${index}]`, `${shape}[]`, within);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  for (const [key, entry] of Object.entries(value)) {
    const memberField = field === "" ? key : `${field}.${key}`;
    const reason = trialRecordStringFinding(key, thisMachine, undefined, within);
    if (reason !== undefined) return { field: `a member name in ${field === "" ? "the top level" : field}`, reason };
    const found = trialRecordFinding(entry, thisMachine, memberField, shape === "" ? key : `${shape}.${key}`, {
      settings: within.settings || HARBOR_SETTINGS.has(key),
      inEnv: within.inEnv || key === "env",
      credentialName: within.credentialName || CREDENTIAL_NAME.test(key),
    });
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * Deletes the members `remove` selects from a JSON text, and no other character: everything
 * around them stays as written, layout and number spelling included. `text` must already parse.
 * `remove` sees a member's key, the key of the object that holds it (none at the top level or
 * in an array), and the member's value as written.
 */
function withoutJsonMembers(
  text: string,
  remove: (key: string, parentKey: string | undefined, valueText: string) => boolean,
): string {
  const spans: [number, number][] = [];
  let at = 0;
  const skipSpace = () => {
    while (at < text.length && " \t\n\r\uFEFF".includes(text[at]!)) at += 1;
  };
  const readString = (): string => {
    const start = at;
    at += 1;
    while (text[at] !== '"') at += text[at] === "\\" ? 2 : 1;
    at += 1;
    return JSON.parse(text.slice(start, at)) as string;
  };
  const readValue = (key: string | undefined): void => {
    skipSpace();
    if (text[at] === "{") readObject(key);
    else if (text[at] === "[") readArray();
    else if (text[at] === '"') readString();
    else while (at < text.length && !",]} \t\n\r".includes(text[at]!)) at += 1;
  };
  const readArray = (): void => {
    at += 1;
    skipSpace();
    if (text[at] === "]") {
      at += 1;
      return;
    }
    for (;;) {
      readValue(undefined);
      skipSpace();
      at += 1;
      if (text[at - 1] === "]") return;
    }
  };
  const readObject = (ownKey: string | undefined): void => {
    at += 1;
    skipSpace();
    if (text[at] === "}") {
      at += 1;
      return;
    }
    const members: { readonly start: number; readonly end: number; readonly removed: boolean }[] = [];
    for (;;) {
      skipSpace();
      const start = at;
      const key = readString();
      skipSpace();
      at += 1;
      skipSpace();
      const valueStart = at;
      const inner = spans.length;
      readValue(key);
      const removed = remove(key, ownKey, text.slice(valueStart, at));
      // A removed member takes everything inside it, so nothing nested in it is cut twice.
      if (removed) spans.length = inner;
      members.push({ start, end: at, removed });
      skipSpace();
      at += 1;
      if (text[at - 1] === "}") break;
    }
    // A member followed by a kept one goes with its comma and the space before the next key. A
    // removed run at the end goes with the comma before it, so no comma is left trailing.
    let tail = members.length;
    while (tail > 0 && members[tail - 1]!.removed) tail -= 1;
    members.forEach((member, index) => {
      if (member.removed && index < tail) spans.push([member.start, members[index + 1]!.start]);
    });
    if (tail < members.length) {
      spans.push([tail === 0 ? members[0]!.start : members[tail - 1]!.end, members.at(-1)!.end]);
    }
  };
  readValue(undefined);
  let out = text;
  for (const [start, end] of spans.sort((a, b) => b[0] - a[0])) out = out.slice(0, start) + out.slice(end);
  return out;
}

/** The same members taken out of the parsed value, which the edited text must parse to. */
function withoutParsedMembers(
  value: unknown,
  remove: (key: string, parentKey: string | undefined, valueText: string) => boolean,
  ownKey?: string,
): unknown {
  if (Array.isArray(value)) return value.map((entry) => withoutParsedMembers(entry, remove));
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key, entry]) => !remove(key, ownKey, JSON.stringify(entry)))
    .map(([key, entry]) => [key, withoutParsedMembers(entry, remove, key)]));
}

/**
 * What a Harbor import carries of one evidence file it read (#5266, #5289). Applied to every file
 * a `run import --from harbor` reads, with the jobs directory it was given.
 *
 * Everything carried is sealed and published with the claim. From a trial's `result.json` and
 * `config.json` the reader removes the members `isHarborHostPathMember` names, character by
 * character, so every other byte is what Harbor wrote, and it holds the edit to that by parsing
 * the result.
 *
 * Then it refuses the trial record, naming the file and the field, when any key or string left in
 * it (after JSON unescaping):
 * - names the jobs directory (as given or resolved) or the home directory of the machine
 *   running the import, or a path under one (`namesPath`);
 * - names a home directory of any machine: `/home/<name>`, `/Users/<name>` or a Windows
 *   `\Users\<name>` or `/Users/<name>` anywhere in the string, or a path that starts at `/root`;
 * - holds a `file:` URI;
 * - is an absolute path in a field that Harbor's model defines as a path on the machine that ran
 *   it (`HARBOR_HOST_PATH_FIELDS`);
 * - is an `env` value other than Harbor's `${NAME}` placeholder;
 * - is a non-empty value, other than that placeholder, under a credential-shaped name
 *   (`CREDENTIAL_NAME`) at any depth;
 * - holds a key-shaped `sk-` string, a bearer value, a URL with a user name or password or with a
 *   credential-shaped query parameter, or Harbor's `****` redaction (`CREDENTIAL_TEXT`);
 * - is token-shaped (`tokenShaped`) inside `kwargs`, `env`, `mcp_servers` or `headers`.
 * These are the rules `test/fixtures/harbor-0.21-jobs-terminal-bench-2-1/prune.mjs` made the
 * committed records under, less two that a claimant's run cannot meet: `prune.mjs` refuses every
 * absolute path, where a trial record names container paths (`/app`, `/tmp`, `/opt`), and every
 * non-empty `kwargs`, `mcp_servers` or `headers`, where those hold the agent's settings.
 *
 * Not detected: an absolute path of another machine outside a home directory and outside
 * those fields (`/srv/data` in an agent setting or an exception message), a home directory
 * written as `~name` or percent-encoded outside a `file:` URI, and a credential with none of
 * these shapes under an ordinary name outside `env` (a lowercase hex key in `kwargs`). Every
 * other file is carried as read and is not checked.
 */
export function harborCarriedEvidence(jobsDir: string): CarriedEvidence {
  const hostPaths: HostPath[] = [];
  const known = new Set<string>();
  const add = (what: string, path: string) => {
    // The filesystem root would match every path.
    if (!isAbsolute(path) || parsePath(path).root === path || known.has(path)) return;
    known.add(path);
    hostPaths.push({ what, path });
  };
  add("the jobs directory", resolvePath(jobsDir));
  try {
    add("the jobs directory", realpathSync(jobsDir));
  } catch {
    // A jobs directory that cannot be resolved is read by no import.
  }
  add("your home directory", homedir());

  return (file) => {
    if (!HARBOR_TRIAL_RECORDS.has(file.name)) return file.bytes;
    const cannotRemove = (why: string): never => refuse(
      "validation",
      file.path,
      `Harbor trial file ${file.path} cannot be carried as ${file.name} without the host paths `
        + `Harbor writes into it: ${why}.`,
    );
    let text: string;
    let parsed: unknown;
    try {
      // The byte order mark, if any, stays in the text so that it is carried too.
      text = new TextDecoder("utf8", { fatal: true, ignoreBOM: true }).decode(file.bytes);
      parsed = JSON.parse(text.replace(/^\uFEFF/u, ""));
    } catch {
      return cannotRemove("it is not UTF-8 JSON");
    }
    const carried = withoutJsonMembers(text, isHarborHostPathMember);
    if (!isDeepStrictEqual(
      JSON.parse(carried.replace(/^\uFEFF/u, "")),
      withoutParsedMembers(parsed, isHarborHostPathMember),
    )) {
      cannotRemove("removing them would change more than those fields");
    }
    const finding = trialRecordFinding(JSON.parse(carried.replace(/^\uFEFF/u, "")), hostPaths);
    if (finding !== undefined) {
      refuse(
        "validation",
        file.path,
        `Harbor trial file ${file.path}, at ${finding.field}, ${finding.reason}. It would be `
          + `carried as ${file.name} and published with the claim, so nothing was imported. run `
          + "import removes trial_uri, exception_traceback, an absolute trials_dir or task path, and "
          + "a reward-file error message that names an absolute path from a trial's result.json and "
          + "config.json, and refuses any other host path or credential in them. To import this "
          + "run, run its trials again without the setting or input that put it there.",
      );
    }
    return carried === text ? file.bytes : new TextEncoder().encode(carried);
  };
}

function hasExecutionEvidence(evidence: readonly ExternalRunEvidenceRef[]): boolean {
  return evidence.some((ref) => ref.name === "reward.txt" || ref.name === "reward.json" || ref.name === "prediction.json");
}

function optionalRfc3339(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function durationMs(startedAt: string | undefined, endedAt: string | undefined): number | undefined {
  if (startedAt === undefined || endedAt === undefined) return undefined;
  const start = Date.parse(startedAt);
  const end = Date.parse(endedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return undefined;
  return Math.round(end - start);
}

interface HarborTrialRecordShape {
  readonly outcome: string;
  readonly reason?: string;
  readonly measurements?: MeasurementMap;
}

/** Harbor's raw reward map for one trial: the object at `verifier_result.rewards` in the trial
 * `result.json`. A trial whose verifier never reported has none. */
function harborRewardMap(result: Record<string, unknown>): Record<string, unknown> | undefined {
  const verifier = result["verifier_result"];
  if (typeof verifier !== "object" || verifier === null) return undefined;
  const rewards = (verifier as Record<string, unknown>)["rewards"];
  return typeof rewards === "object" && rewards !== null && !Array.isArray(rewards)
    ? rewards as Record<string, unknown>
    : undefined;
}

/**
 * A trial that has a reward map, read into the measurements its Task's sealed spec declares.
 *
 * `graded` says the verifier reported and its numbers were recorded. It says nothing about the
 * verdict, which the sealed rule gives. A map that cannot supply a required measurement, or that
 * holds something other than a finite number under a declared name, is `ungradeable` with a
 * reason naming the key: the reader never fills a reward in.
 */
function gradedFromRewardMap(
  rewards: Record<string, unknown>,
  declared: readonly MeasurementDeclaration[],
): HarborTrialRecordShape {
  for (const { name, required } of declared) {
    if (!Object.hasOwn(rewards, name)) {
      if (required) return { outcome: "ungradeable", reason: `Harbor reward map has no "${name}" key` };
      continue;
    }
    const value = rewards[name];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return { outcome: "ungradeable", reason: `Harbor reward "${name}" is not a finite number` };
    }
  }
  // The profiles package holds the one rule for carrying a reward: a whole number a sealed number
  // can hold stays a number, and any other is the shortest decimal string that reads back as it.
  return {
    outcome: "graded",
    measurements: readExternalVerifierMeasurements({ harness: "harbor", measurements: declared, rewards }),
  };
}

/**
 * One trial's import outcome. `declared` is present only for a task that can be graded from
 * Harbor's reward (`HarborOfficialTaskPin.measurements`).
 *
 * For such a task a trial with a reward map is graded by it whatever exception Harbor also
 * recorded: an agent that ran to its timeout and whose work the verifier then scored has a
 * result, and that result is its reward. A trial with no reward map keeps the mapping below.
 */
function harborTrialRecordShape(
  result: Record<string, unknown> | undefined,
  evidence: readonly ExternalRunEvidenceRef[],
  declared: readonly MeasurementDeclaration[] | undefined,
): HarborTrialRecordShape {
  if (result === undefined || !harborTrialResultTerminal(result)) {
    return { outcome: "unrun", reason: "Harbor trial is not finished" };
  }
  if (declared !== undefined) {
    const rewards = harborRewardMap(result);
    if (rewards !== undefined) return gradedFromRewardMap(rewards, declared);
  }
  const exception = harborTrialExceptionType(result);
  if (exception === "AgentTimeoutError" || exception === "VerifierTimeoutError") {
    return { outcome: "timeout", reason: exception };
  }
  if (
    exception === "RewardFileNotFoundError"
    || exception === "RewardFileEmptyError"
    || exception === "VerifierOutputParseError"
  ) {
    return { outcome: "ungradeable", reason: exception };
  }
  if (result.status === "error" || result.status === "failed" || exception !== undefined) {
    return {
      outcome: "error",
      reason: exception ?? `Harbor trial status ${String(result.status)}`,
    };
  }
  if (!hasExecutionEvidence(evidence)) {
    return { outcome: "error", reason: "Harbor trial finished without verifier reward or prediction artifact" };
  }
  return {
    outcome: "ungradeable",
    reason: declared === undefined
      ? "Harbor verifier produced execution evidence; the sealed EvaluationSpec was not applied"
      : "Harbor trial result.json has no reward map (verifier_result.rewards), which is where the reward is read from",
  };
}

function withTimings(
  record: ExternalRunRecord,
  result: Record<string, unknown> | undefined,
): ExternalRunRecord {
  const startedAt = optionalRfc3339(result?.["started_at"] ?? result?.["startedAt"]);
  const endedAt = optionalRfc3339(result?.["finished_at"] ?? result?.["ended_at"] ?? result?.["finishedAt"]);
  const duration = durationMs(startedAt, endedAt);
  return {
    ...record,
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(endedAt === undefined ? {} : { endedAt }),
    ...(duration === undefined ? {} : { durationMs: duration }),
  };
}

/**
 * Reads Harbor 0.21 job and trial directories into the #2979 per-attempt record shape.
 * Missing expected slots are emitted as `unrun` with a required reason.
 */
export function readHarborRunRecords(input: ReadHarborRunRecordsInput): ExternalRunRecord[] {
  const { jobsDir, digestByTaskName, arms, expected, officialPins } = input;
  if (arms.length === 0) refuse("validation", "harbor-arm", "Harbor import requires at least one locked arm");
  const nextAttemptByArmTask = new Map<string, Map<string, number>>();
  const directoryAttempt = new Map<string, number>();
  const records: ExternalRunRecord[] = [];
  let row = 0;

  for (const jobRoot of harborJobRoots(jobsDir)) {
    const jobConfig = readJsonObject(join(jobRoot, "config.json"));
    const jobLock = readJsonObject(join(jobRoot, "lock.json"));
    const jobName = harborJobName(jobRoot, jobConfig);
    for (const directory of trialDirectoryNames(jobRoot)) {
      const trialDir = join(jobRoot, directory);
      const where = relativeEvidencePath(jobsDir, trialDir);
      const trial = readJsonObject(join(trialDir, "config.json"));
      if (!isHarborTrialConfig(trial)) {
        refuse("validation", trialDir, `Harbor trial config at ${join(trialDir, "config.json")} is missing or not a JSON object`);
      }
      const result = readJsonObject(join(trialDir, "result.json"));
      const armId = resolveArmId(
        trialAgent({ trial, result, lock: jobLock, jobConfig, taskName: harborTrialTaskName(trial) }),
        arms,
        where,
      );
      let nextAttemptByTask = nextAttemptByArmTask.get(armId);
      if (nextAttemptByTask === undefined) {
        nextAttemptByTask = new Map<string, number>();
        nextAttemptByArmTask.set(armId, nextAttemptByTask);
      }
      const assigned = assignHarborTrialAttempt({
        trial,
        directory: `${jobRoot}\u0000${directory}`,
        nextAttemptByTask,
        directoryAttempt,
      });
      if (assigned === undefined) {
        refuse("validation", trialDir, `Harbor trial at ${trialDir} has no task name`);
      }
      const digest = digestByTaskName[assigned.taskName];
      const pin = digest === undefined ? undefined : officialPins?.[digest];
      if (pin !== undefined) {
        assertOfficialTaskPin({ pin, trial, jobConfig, jobName, where, taskName: assigned.taskName });
      }
      const mappedKey = digest === undefined
        ? extraCellKey(assigned.taskName, assigned.attempt)
        : cellKey(digest, armId, assigned.attempt);
      const evidence = trialEvidence(jobsDir, trialDir);
      const shape = harborTrialRecordShape(result, evidence, pin?.measurements);
      row += 1;
      const carriesEvidence = shape.outcome === "graded" || shape.outcome === "ungradeable";
      records.push(withTimings({
        row,
        cellKey: mappedKey,
        outcome: shape.outcome,
        ...(shape.reason === undefined ? {} : { reason: shape.reason }),
        ...(carriesEvidence && evidence.length > 0 ? { evidence } : {}),
        ...(shape.measurements === undefined ? {} : { measurements: shape.measurements }),
      }, result));
    }
  }

  const claimed = new Set(records.map((record) => record.cellKey));
  for (const coord of expected) {
    if (claimed.has(coord.cellKey)) continue;
    row += 1;
    records.push({
      row,
      cellKey: coord.cellKey,
      outcome: "unrun",
      reason: "Harbor jobs directory contained no trial for this slot",
    });
  }
  return records;
}

function pinningId(pinning: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = pinning[key];
  if (typeof value === "object" && value !== null && "id" in value && typeof (value as { id: unknown }).id === "string") {
    return (value as { id: string }).id;
  }
  return undefined;
}

function armsFromHarborManifest(manifest: HarborSelectionManifest): HarborImportArm[] {
  return manifest.arms.map((arm) => ({
    armId: arm.armId,
    agentName: arm.jobAgent.name,
    modelName: arm.jobAgent.model_name,
  }));
}

function armsFromDraft(document: DraftDocument): HarborImportArm[] {
  return document.spec.arms.map((arm) => ({
    armId: arm.armId,
    ...(pinningId(arm.pinning, "agent") === undefined ? {} : { agentName: pinningId(arm.pinning, "agent") }),
    ...(pinningId(arm.pinning, "model") === undefined ? {} : { modelName: pinningId(arm.pinning, "model") }),
  }));
}

function marketIdTaskName(task: Record<string, unknown>): string | undefined {
  const payload = task["payload"];
  if (typeof payload !== "object" || payload === null) return undefined;
  const forecast = (payload as Record<string, unknown>)["forecast"];
  if (typeof forecast !== "object" || forecast === null) return undefined;
  const marketId = (forecast as Record<string, unknown>)["marketId"];
  if (typeof marketId !== "string" || marketId.length === 0) return undefined;
  if (marketId.startsWith(SHIM_MARKET_PREFIX)) {
    const name = marketId.slice(SHIM_MARKET_PREFIX.length);
    return name.length > 0 ? name : undefined;
  }
  return marketId;
}

/** The task name and pins an official Terminal-Bench 2.1 item seals in its payload. */
function officialSlateTask(
  task: Record<string, unknown>,
): { readonly taskName: string; readonly pin: HarborOfficialTaskPin } | undefined {
  const profile = task["profile"];
  if (typeof profile !== "object" || profile === null) return undefined;
  if ((profile as Record<string, unknown>)["uri"] !== TERMINAL_BENCH_21_ITEM_PROFILE_URI) return undefined;
  const payload = task["payload"];
  if (typeof payload !== "object" || payload === null) return undefined;
  const { taskName, packageRef, datasetId, datasetRevision } = payload as Record<string, unknown>;
  if (
    typeof taskName !== "string" || taskName.length === 0
    || typeof packageRef !== "string" || typeof datasetId !== "string" || typeof datasetRevision !== "string"
  ) return undefined;
  return { taskName, pin: { datasetId, datasetRevision, packageRef } };
}

/**
 * The measurements a trial's raw reward map is read into, for a Task that can be graded from it.
 *
 * That is a Task whose sealed EvaluationSpec is of family `external-verifier` for harness
 * `harbor`, and whose spec names as its grader the package the Task itself seals as `packageRef`.
 * The last condition is what joins the two checks: a trial is held to `packageRef`, so the reward
 * it carries is the reward of the package the spec calls its grader. Every Task
 * `method terminal-bench-2.1` seals meets all three. Any other Task returns `undefined` and its
 * trials keep the ungraded mapping.
 */
function harborRewardMeasurements(
  workspaceDir: string,
  task: Record<string, unknown>,
  packageRef: string,
): readonly MeasurementDeclaration[] | undefined {
  const evaluation = task["evaluation"] as { readonly digest?: { readonly sha256?: unknown } } | undefined;
  const sha256 = evaluation?.digest?.sha256;
  if (typeof sha256 !== "string") return undefined;
  const spec = parseEvaluationSpec(getSealedBytes(workspaceDir, sha256));
  if (spec.family !== EXTERNAL_VERIFIER_FAMILY || Array.isArray(spec.grader)) return undefined;
  if ((spec.familyBlock as ExternalVerifierBlock).harness !== "harbor") return undefined;
  if (`sha256:${String(spec.grader.digest?.["sha256"])}` !== packageRef) return undefined;
  return spec.measurements;
}

interface HarborImportSlate {
  readonly taskNameByDigest: Readonly<Record<string, string>>;
  readonly officialPins: Readonly<Record<string, HarborOfficialTaskPin>>;
}

/**
 * Task names for a locked run. Prefers the suite-protocol mapping already used by the
 * orchestrated Harbor path (`from-harbor.ts`). Otherwise the names come from the sealed Tasks:
 * the official Terminal-Bench 2.1 slate (`method terminal-bench-2.1`) seals `payload.taskName`,
 * which is Harbor's `terminal-bench/<taskName>`, beside the package ref and dataset revision a
 * trial is then held to. Prediction-shaped intake encodes the name in `payload.forecast.marketId`.
 *
 * Only the sealed Tasks give pins. A draft that binds a Harbor suite-protocol selection is named
 * from that selection and gets none, so its trials are placed by name and never graded. No
 * claimant command binds such a draft to the official slate.
 */
function harborImportSlate(workspaceDir: string, document: DraftDocument): HarborImportSlate {
  const runtime = document.spec.evaluationRuntime;
  if (isHarborCompatibleEvaluationRuntime(runtime)) {
    const manifest = HarborSelectionManifestSchema.parse(
      JSON.parse(UTF8.decode(getSealedBytes(workspaceDir, runtime.selectionManifestSha256))),
    );
    const suite = suiteSelectionFromHarbor(manifest);
    if (suite !== undefined) return { taskNameByDigest: taskNameByDigestFromSuite(suite), officialPins: {} };
  }
  if (document.spec.taskSet.kind !== "benchmark") {
    refuse("conflict", `drafts.${document.draftId}.taskSet`, `draft ${document.draftId} has no attached benchmark`);
  }
  const benchmark = parseBenchmark(getSealedBytes(workspaceDir, document.spec.taskSet.benchmarkSha256));
  const names: Record<string, string> = {};
  const pins: Record<string, HarborOfficialTaskPin> = {};
  for (const item of benchmark.items) {
    const digest = itemTaskDigest(item);
    const task = JSON.parse(UTF8.decode(getSealedBytes(workspaceDir, digest))) as Record<string, unknown>;
    const official = officialSlateTask(task);
    if (official !== undefined) {
      names[digest] = official.taskName;
      const measurements = harborRewardMeasurements(workspaceDir, task, official.pin.packageRef);
      pins[digest] = measurements === undefined ? official.pin : { ...official.pin, measurements };
      continue;
    }
    const name = marketIdTaskName(task);
    if (name !== undefined) names[digest] = name;
  }
  const named = Object.keys(names).length;
  if (named !== benchmark.items.length) {
    refuse(
      "conflict",
      `drafts.${document.draftId}.harbor`,
      `Harbor import cannot name ${benchmark.items.length - named} of the ${benchmark.items.length} tasks `
        + `on draft ${document.draftId}, so it cannot tell which Harbor trial belongs to which cell. `
        + "`run import --from harbor` reads a draft bound with `method terminal-bench-2.1`, whose tasks "
        + "seal their Harbor task names. Bind a draft that way before running Harbor, or bring this run "
        + "as a generic dump with `run import --file <records.jsonl> --source harbor` "
        + "(`run import --template` prints the slate to fill in).",
    );
  }
  return { taskNameByDigest: names, officialPins: pins };
}

export function taskNameByDigestForHarborImport(
  workspaceDir: string,
  document: DraftDocument,
): Readonly<Record<string, string>> {
  return harborImportSlate(workspaceDir, document).taskNameByDigest;
}

export function harborImportArmsForDraft(workspaceDir: string, document: DraftDocument): HarborImportArm[] {
  const runtime = document.spec.evaluationRuntime;
  if (isHarborCompatibleEvaluationRuntime(runtime)) {
    const manifest = HarborSelectionManifestSchema.parse(
      JSON.parse(UTF8.decode(getSealedBytes(workspaceDir, runtime.selectionManifestSha256))),
    );
    return armsFromHarborManifest(manifest);
  }
  return armsFromDraft(document);
}

function jsonObjectField(value: Record<string, unknown> | undefined, field: string): Record<string, unknown> | undefined {
  const nested = value?.[field];
  return typeof nested === "object" && nested !== null && !Array.isArray(nested)
    ? nested as Record<string, unknown>
    : undefined;
}

/**
 * Holds one job to what this reader can read, and returns the Harbor version it states. Each
 * refusal names the job.
 *
 * - **Version.** Harbor states its version in the job `lock.json` (`harbor.version`) and nowhere
 *   else. It must be one of `HARBOR_RUN_IMPORT_VERSIONS`. Another version is refused, and so is a
 *   job that states none: there is no default to fall back to.
 * - **Retries.** The job `lock.json` must state `retry.max_retries` as 0, and a job `result.json`
 *   that counts retries must count 0. No real record shows how Harbor lays out a retried trial,
 *   so a retried trial would be numbered as one more attempt of its task, and land outside the
 *   locked slots or take the slot of a planned attempt. 0 is Harbor's default.
 */
function readableHarborJobVersion(jobRoot: string): string {
  const jobName = harborJobName(jobRoot, readJsonObject(join(jobRoot, "config.json")));
  const lock = readJsonObject(join(jobRoot, "lock.json"));
  const accepted = HARBOR_RUN_IMPORT_VERSIONS.join(", ");
  const onlyAccepted = `This reader accepts only a job written by Harbor ${accepted}: it is tested against `
    + "a real jobs directory of each version it accepts, and it has none of any other. Run Harbor "
    + `${accepted} and import that jobs directory.`;
  const version = jsonObjectField(lock, "harbor")?.["version"];
  if (typeof version !== "string" || version.length === 0) {
    refuse(
      "validation",
      "harbor-version",
      `Harbor job ${jobName} states no Harbor version: its lock.json has no harbor.version. ${onlyAccepted}`,
    );
  }
  if (!(HARBOR_RUN_IMPORT_VERSIONS as readonly string[]).includes(version)) {
    refuse("validation", "harbor-version", `Harbor job ${jobName} was written by Harbor ${version}. ${onlyAccepted}`);
  }
  const retriesOff = "This reader accepts only a job run with retries off, because it has no real "
    + "record of how Harbor lays out a retried trial. Run Harbor with --max-retries 0, which is its "
    + "default, and import that jobs directory.";
  const maxRetries = jsonObjectField(lock, "retry")?.["max_retries"];
  if (maxRetries !== 0) {
    refuse(
      "validation",
      "harbor-retry",
      `Harbor job ${jobName} does not show that retries were off: its lock.json `
        + (maxRetries === undefined
          ? "states no retry.max_retries"
          : `states retry.max_retries as ${JSON.stringify(maxRetries)}`)
        + `. ${retriesOff}`,
    );
  }
  const retried = jsonObjectField(readJsonObject(join(jobRoot, "result.json")), "stats")?.["n_retries"];
  if (retried !== undefined && retried !== 0) {
    refuse(
      "validation",
      "harbor-retry",
      `Harbor job ${jobName} retried a trial: its result.json states stats.n_retries as `
        + `${JSON.stringify(retried)}. ${retriesOff}`,
    );
  }
  return version;
}

/**
 * Holds every job in the directory to what this reader can read (`readableHarborJobVersion`) and
 * returns the Harbor version the jobs state. A directory with no job in it states none and is
 * refused: an import of nothing would leave the run with no result and no way back to `locked`.
 *
 * With one accepted version every job states the same one. A second entry in the list needs a
 * decision here about a directory that mixes them.
 */
function assertReadableHarborJobs(jobsDir: string): string {
  const [first, ...rest] = harborJobRoots(jobsDir);
  if (first === undefined) {
    refuse(
      "validation",
      "jobs-dir",
      `Harbor jobs directory ${jobsDir} holds no Harbor job: nothing in it is a job directory with a `
        + "trial in it, so there is no Harbor version to accept and no trial to read. Pass the "
        + "directory Harbor wrote its jobs to (harbor run -o <jobs-dir>).",
    );
  }
  const version = readableHarborJobVersion(first);
  for (const jobRoot of rest) readableHarborJobVersion(jobRoot);
  return version;
}

/** Loads the locked slate and reads a Harbor jobs directory into import records. */
export function readHarborRunImport(input: {
  readonly workspaceDir: string;
  readonly draftId: string;
  readonly jobsDir: string;
}): HarborRunImportDump {
  const { workspaceDir, draftId, jobsDir } = input;
  const document = readDraftDocument(workspaceDir, draftId);
  if (document.spec.taskSet.kind !== "benchmark") {
    refuse("conflict", `drafts.${draftId}.taskSet`, `draft ${draftId} has no attached benchmark`);
  }
  const runState = requireRunState(workspaceDir, draftId);
  if (runState.runSha256 === undefined) {
    refuse("conflict", `runs.${draftId}`, `draft ${draftId} has no sealed Run record yet — lock it first`);
  }
  const benchmark = parseBenchmark(getSealedBytes(workspaceDir, document.spec.taskSet.benchmarkSha256));
  const run = parseRun(getSealedBytes(workspaceDir, runState.runSha256));
  const expected = expectedCellSet(benchmark, run);
  const { taskNameByDigest, officialPins } = harborImportSlate(workspaceDir, document);
  // Before any trial is read: a job this reader cannot read is refused for that, by name, and not
  // for whatever its trials would then look like.
  const version = assertReadableHarborJobs(jobsDir);
  const digestByTaskName: Record<string, string> = {};
  for (const [digest, name] of Object.entries(taskNameByDigest)) digestByTaskName[name] = digest;
  // Keep the from-harbor inverse in the same path the orchestrated adapter uses when a suite is present.
  const runtime = document.spec.evaluationRuntime;
  if (isHarborCompatibleEvaluationRuntime(runtime)) {
    const manifest = HarborSelectionManifestSchema.parse(
      JSON.parse(UTF8.decode(getSealedBytes(workspaceDir, runtime.selectionManifestSha256))),
    );
    const suite = suiteSelectionFromHarbor(manifest);
    if (suite !== undefined) {
      Object.assign(digestByTaskName, digestByTaskNameFromSuite(suite));
    }
  }
  return {
    records: readHarborRunRecords({
      jobsDir,
      digestByTaskName,
      arms: harborImportArmsForDraft(workspaceDir, document),
      expected,
      officialPins,
    }),
    source: { harness: "harbor", version },
    evidenceRoot: jobsDir,
    maxAggregateEvidenceBytes: harborRunImportEvidenceCap(expected.length),
  };
}
