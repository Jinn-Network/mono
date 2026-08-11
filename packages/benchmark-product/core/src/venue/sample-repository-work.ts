/**
 * The product-bundled hermetic `repository-work` arm (P1), the exact counterpart of
 * `./sample-uniform.ts` for the repository-work profile: a REAL `node -e` subprocess, honestly
 * labeled as a trivial baseline rather than a coding agent. It appends one line to the
 * lexicographically-first regular file in the materialized work tree and emits the corresponding
 * unified diff as the Task's declared `patch` output.
 *
 * It exists because the backend's capability assembly intersects the provisioner's task profiles
 * with the union of the registered launchers'
 * (`packages/task-execution/backend-local/assembly/src/capabilities.ts:63-75`): without at least
 * one registered launcher declaring `repository-work/1.0`, the profile can never reach
 * capabilities. The platform's real coding-agent launchers declare it but require an external
 * binary; this one requires nothing but Node, so P1 is verifiable in CI on its own and the demo
 * gets a zero-capability control arm for free.
 *
 * Guard logic is a small self-contained reimplementation rather than a reuse of platform
 * internals, for the same reason `./sample-uniform.ts` gives: the platform's `requireHarness` /
 * `isolation` / `baseEnv` planning helpers are deliberately not exported.
 */

import type {
  LauncherCapabilities,
  LauncherContract,
  LaunchPlan,
  ProbeResult,
} from "@jinn-network/task-execution-launchers";
import { REPOSITORY_WORK_PROFILE_URI } from "@jinn-network/task-execution-profiles";
import {
  STAGED_SEALED_TASK_FILENAME,
  type TaskView,
  type WorkspacePaths,
} from "@jinn-network/task-execution-workspace";
import type { AttemptIdentity } from "@jinn-network/task-execution-supervisor";

export const SAMPLE_REPOSITORY_WORK_LAUNCHER_ID = "sample-repository-work";
export const SAMPLE_REPOSITORY_WORK_HARNESS_VERSION = "0.1.0";

/** The marker line this arm appends. Fixed, so every attempt's patch is byte-identical. */
const APPENDED_LINE = "sample-repository-work";

/**
 * The inline runner. It reads the ONE staged path the product's provisioner contract writes
 * (`input/${STAGED_SEALED_TASK_FILENAME}`) and checks only the profile URI — full Task validity is
 * the platform's job. Reading the work tree is the point, not incidental: an empty `work/` means
 * provisioning did not materialize the repository, and this arm must fail loudly rather than
 * emit a patch against nothing.
 */
export const SAMPLE_REPOSITORY_WORK_RUNNER_SOURCE = `
const fs = require('node:fs');
const path = require('node:path');
const input = process.env.JINN_ATTEMPT_INPUT;
const out = process.env.JINN_ATTEMPT_OUT;
const work = process.env.JINN_ATTEMPT_WORK;
const PROFILE_URI = '${REPOSITORY_WORK_PROFILE_URI}';
const TASK_FILE = ${JSON.stringify(STAGED_SEALED_TASK_FILENAME)};
const APPENDED = ${JSON.stringify(APPENDED_LINE)};
let doc;
try {
  doc = JSON.parse(fs.readFileSync(path.join(input, TASK_FILE), 'utf8'));
} catch (error) {
  console.error('sample-repository-work: could not read input/' + TASK_FILE + ': ' + (error && error.message ? error.message : String(error)));
  process.exit(2);
}
if (!doc || !doc.profile || doc.profile.uri !== PROFILE_URI) {
  console.error('sample-repository-work: input/' + TASK_FILE + ' is not a repository-work Task');
  process.exit(2);
}
let entries;
try {
  entries = fs.readdirSync(work, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name !== '.git')
    .map((entry) => entry.name)
    .sort();
} catch (error) {
  console.error('sample-repository-work: work tree is unreadable: ' + (error && error.message ? error.message : String(error)));
  process.exit(2);
}
const target = entries[0];
if (target === undefined) {
  console.error('sample-repository-work: work tree contains no regular file -- the repository was never materialized');
  process.exit(2);
}
const before = fs.readFileSync(path.join(work, target), 'utf8');
const beforeLines = before.length === 0 ? [] : before.replace(/\\n$/, '').split('\\n');
const patch = [
  'diff --git a/' + target + ' b/' + target,
  '--- a/' + target,
  '+++ b/' + target,
  '@@ -1,' + beforeLines.length + ' +1,' + (beforeLines.length + 1) + ' @@',
  ...beforeLines.map((line) => ' ' + line),
  '+' + APPENDED,
  '',
].join('\\n');
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'patch'), patch);
fs.writeFileSync(path.join(out, 'structured-output.json'), JSON.stringify({
  subtype: 'success', status: 'success',
  structuredOutput: { changedFile: target, appended: APPENDED },
  harnessVersion: '${SAMPLE_REPOSITORY_WORK_HARNESS_VERSION}',
  sessionId: process.env.JINN_ATTEMPT_ID || 'sample-repository-work',
}));
process.exit(0);
`;

function requireHarness(view: TaskView): void {
  const value = (view.effectiveRequirements as Record<string, unknown>)["harness"];
  if (value === undefined) return;
  if (
    typeof value !== "object" || value === null
    || (value as { id?: unknown }).id !== SAMPLE_REPOSITORY_WORK_LAUNCHER_ID
  ) {
    throw new Error(`${SAMPLE_REPOSITORY_WORK_LAUNCHER_ID}: harness pin does not select this launcher`);
  }
}

function requireIsolation(view: TaskView): void {
  const value = (view.effectiveRequirements as Record<string, unknown>)["isolationPolicy"];
  if (value === undefined) return;
  if (value !== "unrestricted") throw new Error(`unsupported isolationPolicy ${String(value)}`);
}

export function makeSampleRepositoryWorkLauncher(
  options: { readonly probe?: () => Promise<ProbeResult> } = {},
): LauncherContract {
  return {
    id: SAMPLE_REPOSITORY_WORK_LAUNCHER_ID,
    capabilities: (): LauncherCapabilities => ({
      taskProfiles: [REPOSITORY_WORK_PROFILE_URI],
      inputMediaTypes: ["application/json", "text/plain"],
      outputMediaTypes: ["application/json", "text/plain", "text/x-diff", "text/markdown"],
      structuredOutput: true,
      resume: false,
      interruptionBehaviorDefault: "repeatable",
      secretForwards: [],
      runPinning: {
        keys: [
          { key: "harness", inventory: [SAMPLE_REPOSITORY_WORK_LAUNCHER_ID], posture: "enforced" },
          { key: "isolationPolicy", inventory: ["unrestricted"], posture: "enforced" },
        ],
      },
    }),
    probe: options.probe ?? (async () => ({ ready: true })),
    plan(view: TaskView, paths: WorkspacePaths, attempt: AttemptIdentity): LaunchPlan {
      requireHarness(view);
      requireIsolation(view);
      return {
        argv: [process.execPath, "-e", SAMPLE_REPOSITORY_WORK_RUNNER_SOURCE],
        cwd: paths.work,
        env: {
          JINN_ATTEMPT_ID: attempt.attemptUri,
          JINN_ATTEMPT_INPUT: paths.input,
          JINN_ATTEMPT_WORK: paths.work,
          JINN_ATTEMPT_OUT: paths.out,
          JINN_ATTEMPT_LOGS: paths.logs,
          JINN_ATTEMPT_META: paths.meta,
          TMPDIR: paths.tmp,
        },
        validExitCodes: [0],
        blameExitCodes: [{ match: { signal: "SIGKILL" }, blame: "infrastructure", reasonCode: "killed" }],
        resultContract: {
          envelopeFormat: "sample-repository-work-json",
          structuredOutputArtifact: "out/structured-output.json",
          correlationFields: ["harnessVersion", "sessionId"],
        },
        interruptionBehavior: "repeatable",
        secretForwards: [],
      };
    },
  };
}

export const sampleRepositoryWorkLauncher: LauncherContract = makeSampleRepositoryWorkLauncher();
