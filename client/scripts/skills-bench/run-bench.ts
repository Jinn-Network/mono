/**
 * Skills-bench orchestrator CLI: drives real claude-code solves for a slate
 * of SWE-rebench-v2 instances across a set of "arms" (baseline = no skill,
 * treatment = one pinned skill mounted), grades each patch with the upstream
 * eval.py, and durably logs one BenchOutcome per (instance × arm × repeat)
 * to `<out>/attempts.jsonl`. Resumable: a rerun skips any attempt key
 * already present in the log; `assertManifestCompatible` fails loud if the
 * slate/model/arm bytes changed underneath an existing `--out` dir.
 *
 * IMPORTANT: this spawns real `claude` subprocesses (real inference spend)
 * and runs real Docker-based grading UNLESS `--dry-run` is passed.
 * `--dry-run` synthesizes deterministic fake outcomes and never touches
 * git/Docker/network/claude — use it to verify the wiring for free.
 *
 * Usage:
 *   yarn tsx scripts/skills-bench/run-bench.ts --dry-run \
 *     --slate ../bench/slate/slate.json --arms ../bench/arms/wave1.json --out /tmp/bench-dry
 *   yarn tsx scripts/skills-bench/run-bench.ts \
 *     --slate ../bench/slate/slate.json [--half feedback|holdout|both] \
 *     --arms ../bench/arms/wave1.json --model claude-sonnet-5 \
 *     --out ../bench/runs/wave1 [--repeats 1] [--max-turns 40] \
 *     [--max-instances N] [--grade-timeout-ms 600000] [--upstream-repo-dir PATH] \
 *     [--solve-concurrency N] [--candidate-id ID] [--force-holdout-rerun] \
 *     [--claude-config-dir PATH]
 *
 * `--claude-config-dir` (default `<repoRoot>/bench/.claude-bench-config`) is
 * the isolated `CLAUDE_CONFIG_DIR` claude-code auth lives in. It is stable
 * and reusable across runs/--out dirs by design (an operator logs into it
 * once, not once per run) — see docs/runbooks/skills-bench.md §1. Before any
 * real (non-dry-run) solve work, a cheap auth preflight probe spawns claude
 * against this dir and aborts the whole run with a clear message if it has
 * no usable credentials — see `authPreflightFailureMessage`.
 *
 * `--half holdout` requires `--candidate-id <id>` and is one-shot per
 * candidate: `<repoRoot>/bench/holdout-ledger.json` (resolved from this
 * script's own location, not CWD) records the run before it starts (an
 * aborted run still burns the slot), and a second attempt for the same
 * candidate throws unless `--force-holdout-rerun` is passed (loud warning —
 * legitimate only when the prior run aborted before grading anything).
 * `--half both` also records into the ledger (no block — see the holdout
 * backstop recommendation in batch-b-review.md) so the ledger stays a
 * complete audit trail. `--dry-run` never touches the ledger.
 *
 * arms file shape (baseline has skillDir null):
 *   [{ "name": "baseline", "skillDir": null },
 *    { "name": "tdd", "skillDir": "../bench/skills-under-test/tdd" }]
 *
 * `--task-set <dir>` is an alternative to `--slate` for an authored
 * `SkillTaskSetV1` (task-set.ts): same arms/attempts/resume/manifest
 * machinery, but the prompt is the task's 4-part requirement (never the
 * skill name), the per-attempt checkout is `task.repo`@`task.commit`, and
 * grading goes through custom-grade.ts instead of the HF/eval.py path. The
 * manifest records `taskSetSha256` instead of `slateSha256`. Every task in
 * the set MUST already carry a passing `gradeability` receipt
 * (`validate-task-set.ts`) — run-bench refuses the whole set otherwise, fail
 * loud, before any solve spend, dry-run included. `--slate` and `--task-set`
 * are mutually exclusive; `--half`/`--candidate-id`/the holdout ledger are
 * slate-only concepts and do not apply to `--task-set` runs.
 *
 * A measured `--task-set` run also honors the discrimination gate (spec
 * §2.4, `screen-task-set.ts`): only tasks with `screening.keep === true` are
 * run, UNLESS the set carries no screening receipts at all (logs a one-line
 * warning and runs unscreened — screening is recommended, not required) or
 * `--include-screened-out` is passed (runs every task regardless of the
 * gate, with a loud warning that the result is not interpretable per §2.4).
 */
import { spawn } from 'node:child_process';
import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildClaudeArgs, mountSkill, unmountSkill, prepareBenchConfigDir, parseClaudeJson,
  authPreflightFailureMessage,
} from '../../src/skills-bench/claude-solve.js';
import type { SkillsBenchSlate, SlateCandidate } from '../../src/skills-bench/slate.js';
import {
  appendAttempt, assertManifestCompatible, attemptKey, loadAttempts,
  type BenchManifest, type BenchOutcome,
} from '../../src/skills-bench/attempts.js';
import { assertHoldoutUnused, recordHoldoutRun } from '../../src/skills-bench/holdout-guard.js';
import {
  loadTaskSet, assertTaskSetGradeable, selectTasksForMeasurement,
  type SkillTaskSetV1, type SkillTaskV1, type TaskRequirement,
} from '../../src/skills-bench/task-set.js';
import { runCustomGrade, CustomGradeError } from '../../src/skills-bench/custom-grade.js';
import {
  createPilotWorkDir, prepareBaseCheckout, recoverPatch, GitStepError,
} from '../../src/pilot/repo.js';
import { mapWithConcurrency, SerialTaskQueue } from '../../src/pilot/pipeline.js';
import { fetchPilotRawRow, parsePilotInstanceRow, type PilotInstance } from '../../src/pilot/instance.js';
import { HttpHfFetcher } from '../../src/harnesses/impls/swe-rebench-v2-evaluator/hf-fetcher.js';
import { PythonEvalRunner, EvalCouldNotGradeError } from '../../src/harnesses/impls/swe-rebench-v2-evaluator/eval-runner.js';
import type { HfRow } from '../../src/harnesses/impls/swe-rebench-v2-evaluator/index.js';

// client/scripts/skills-bench/run-bench.ts -> client/scripts/skills-bench -> client/scripts -> client -> repo root
// (same derivation as pin-skill.ts) — anchors bench/holdout-ledger.json to the
// repo regardless of the operator's CWD (issue: a bare `resolve('../bench/...')`
// is process.cwd()-relative and silently lands outside the repo when invoked
// from anywhere but client/, voiding the one-shot holdout seal).
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface Arm {
  name: string;
  skillDir: string | null;
}

interface BenchConfig {
  dryRun: boolean;
  slatePath: string;
  /** Alternative to slatePath — a `SkillTaskSetV1` directory (--task-set).
   *  Mutually exclusive with slatePath; exactly one must be set. */
  taskSetDir: string;
  half: 'feedback' | 'holdout' | 'both';
  armsPath: string;
  model: string;
  outDir: string;
  repeats: number;
  maxTurns: number;
  maxInstances: number;
  gradeTimeoutMs: number;
  upstreamRepoDir: string;
  solveConcurrency: number;
  candidateId: string | undefined;
  forceHoldoutRerun: boolean;
  /** Isolated CLAUDE_CONFIG_DIR claude-code auth lives in. Stable and
   *  reusable across runs/--out dirs by design — see the module doc and
   *  docs/runbooks/skills-bench.md §1. */
  claudeConfigDir: string;
  /** --task-set only: override the discrimination gate (spec §2.4) and run
   *  EVERY task regardless of `screening.keep`. Loud warning — see
   *  `selectTasksForMeasurement` (task-set.ts). Ignored in --slate mode. */
  includeScreenedOut: boolean;
}

const DEFAULT_MODEL = 'claude-sonnet-5';

function parseArgs(argv: string[]): BenchConfig {
  const cfg: BenchConfig = {
    dryRun: false,
    slatePath: '',
    taskSetDir: '',
    half: 'feedback',
    armsPath: '',
    model: DEFAULT_MODEL,
    outDir: '',
    repeats: 1,
    maxTurns: 40,
    maxInstances: Infinity,
    gradeTimeoutMs: 600_000,
    upstreamRepoDir: join(homedir(), '.jinn-client', 'SWE-rebench-V2-upstream'),
    solveConcurrency: 1,
    candidateId: undefined,
    forceHoldoutRerun: false,
    claudeConfigDir: join(repoRoot, 'bench', '.claude-bench-config'),
    includeScreenedOut: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--dry-run': cfg.dryRun = true; break;
      case '--slate': cfg.slatePath = resolve(String(argv[++i])); break;
      case '--task-set': cfg.taskSetDir = resolve(String(argv[++i])); break;
      case '--half': {
        const v = String(argv[++i]);
        if (v !== 'feedback' && v !== 'holdout' && v !== 'both') throw new Error(`invalid --half ${v}`);
        cfg.half = v;
        break;
      }
      case '--arms': cfg.armsPath = resolve(String(argv[++i])); break;
      case '--model': cfg.model = String(argv[++i]); break;
      case '--out': cfg.outDir = resolve(String(argv[++i])); break;
      case '--repeats': cfg.repeats = Number(argv[++i]); break;
      case '--max-turns': cfg.maxTurns = Number(argv[++i]); break;
      case '--max-instances': cfg.maxInstances = Number(argv[++i]); break;
      case '--grade-timeout-ms': cfg.gradeTimeoutMs = Number(argv[++i]); break;
      case '--upstream-repo-dir': cfg.upstreamRepoDir = resolve(String(argv[++i])); break;
      case '--solve-concurrency': cfg.solveConcurrency = Math.max(1, Number(argv[++i]) || 1); break;
      case '--candidate-id': cfg.candidateId = String(argv[++i]); break;
      case '--force-holdout-rerun': cfg.forceHoldoutRerun = true; break;
      case '--claude-config-dir': cfg.claudeConfigDir = resolve(String(argv[++i])); break;
      case '--include-screened-out': cfg.includeScreenedOut = true; break;
      default: throw new Error(`unknown argument ${a}`);
    }
  }
  if (!cfg.slatePath && !cfg.taskSetDir) throw new Error('either --slate or --task-set is required');
  if (cfg.slatePath && cfg.taskSetDir) throw new Error('--slate and --task-set are mutually exclusive');
  if (!cfg.armsPath) throw new Error('--arms is required');
  if (!cfg.outDir) throw new Error('--out is required');
  if (cfg.half === 'holdout' && !cfg.candidateId) throw new Error('--half holdout requires --candidate-id <id>');
  return cfg;
}

function loadSlate(path: string): SkillsBenchSlate {
  return JSON.parse(readFileSync(path, 'utf8')) as SkillsBenchSlate;
}

function loadArms(path: string): Arm[] {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  if (!Array.isArray(parsed) || parsed.length === 0) throw new Error(`--arms must be a non-empty JSON array: ${path}`);
  return parsed.map((item, idx) => {
    if (item === null || typeof item !== 'object') throw new Error(`arm ${idx} must be an object`);
    const record = item as Record<string, unknown>;
    if (typeof record.name !== 'string' || !record.name) throw new Error(`arm ${idx} missing name`);
    const skillDir = typeof record.skillDir === 'string' && record.skillDir ? resolve(record.skillDir) : null;
    return { name: record.name, skillDir };
  });
}

function pinSha256(skillDir: string): string {
  const pinPath = join(skillDir, 'pin.json');
  const pin = JSON.parse(readFileSync(pinPath, 'utf8')) as { sha256?: string };
  if (typeof pin.sha256 !== 'string' || !pin.sha256) throw new Error(`pin.json at ${pinPath} missing sha256`);
  return pin.sha256;
}

function candidatesForHalf(slate: SkillsBenchSlate, half: BenchConfig['half']): SlateCandidate[] {
  if (half === 'feedback') return slate.feedback;
  if (half === 'holdout') return slate.holdout;
  return [...slate.feedback, ...slate.holdout];
}

// ---------------------------------------------------------------------------
// Attempt specs
// ---------------------------------------------------------------------------

interface AttemptSpec {
  candidate: SlateCandidate;
  arm: Arm;
  repeat: number;
  /** Position among (candidate, repeat) units, in slate order — used to
   *  make dry-run synthesis a pure function of the attempt's identity,
   *  independent of which keys are already resumed. */
  unitIndex: number;
}

function buildAttemptSpecs(candidates: SlateCandidate[], arms: Arm[], repeats: number): AttemptSpec[] {
  const specs: AttemptSpec[] = [];
  let unitIndex = 0;
  for (const candidate of candidates) {
    for (let repeat = 0; repeat < repeats; repeat++) {
      for (const arm of arms) {
        specs.push({ candidate, arm, repeat, unitIndex });
      }
      unitIndex++;
    }
  }
  return specs;
}

// ---------------------------------------------------------------------------
// --task-set attempt specs (mirrors AttemptSpec/buildAttemptSpecs above, with
// `task: SkillTaskV1` in place of `candidate: SlateCandidate` — kept as a
// parallel type rather than a shared generic so the slate path is untouched).
// ---------------------------------------------------------------------------

interface TaskSetAttemptSpec {
  task: SkillTaskV1;
  arm: Arm;
  repeat: number;
  unitIndex: number;
}

function buildTaskSetAttemptSpecs(tasks: SkillTaskV1[], arms: Arm[], repeats: number): TaskSetAttemptSpec[] {
  const specs: TaskSetAttemptSpec[] = [];
  let unitIndex = 0;
  for (const task of tasks) {
    for (let repeat = 0; repeat < repeats; repeat++) {
      for (const arm of arms) {
        specs.push({ task, arm, repeat, unitIndex });
      }
      unitIndex++;
    }
  }
  return specs;
}

// ---------------------------------------------------------------------------
// Prompt (run-pilot's buildPrompt, minus the skillsNudge line — claude-code
// loads skill descriptions natively, so a nudge would measure prompt
// compliance rather than the skill itself)
// ---------------------------------------------------------------------------

function buildPrompt(problemStatement: string, iface: string | undefined): string {
  const spec = iface && iface.trim()
    ? `\n\n## Required interface (the contract your fix must satisfy)\n${iface.trim()}`
    : '';
  return `You are fixing a bug in this repository. Work efficiently and DO NOT get stuck exploring:\n` +
    `1. Briefly locate the relevant code — a few targeted searches/reads, not an exhaustive tour of the repo.\n` +
    `2. Then MAKE THE EDIT: modify the source file(s) to fix the issue. You MUST produce an actual code change (a git diff), not just analysis. Do not end your turn without having edited a file.\n` +
    `Make the minimal change needed. Do not add explanatory files or scripts outside the repo's existing structure.\n` +
    `\n${problemStatement}${spec}`;
}

/** --task-set prompt: renders the task's 4-part requirement verbatim. Never
 *  mentions the skill under test — the arm's skill (if any) is mounted into
 *  `.claude/skills/`, not named in the prompt (spec §2.2; the whole point of
 *  a domain-matched task set is measuring whether the skill helps, not
 *  whether an instruction to use it helps). */
function buildTaskSetPrompt(requirement: TaskRequirement): string {
  return `You are working in this repository. Work efficiently and DO NOT get stuck exploring:\n` +
    `1. Briefly locate the relevant code — a few targeted searches/reads, not an exhaustive tour of the repo.\n` +
    `2. Then MAKE THE EDIT: modify the source file(s) to satisfy the requirement below. You MUST produce an actual code change (a git diff), not just analysis. Do not end your turn without having edited a file.\n` +
    `\n## Background\n${requirement.background}\n` +
    `\n## Requirement\n${requirement.requirement}\n` +
    `\n## File operations\n${requirement.fileOps}\n` +
    `\n## Acceptance criteria\n${requirement.acceptance}\n`;
}

// ---------------------------------------------------------------------------
// Shell helper (mirrors run-pilot's `run`)
// ---------------------------------------------------------------------------

function run(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => resolvePromise({ stdout, stderr, exitCode: code ?? 1 }));
  });
}

function compactProcessOutput(value: string, limit = 4000): string {
  const trimmed = value.trim();
  if (trimmed.length <= limit) return trimmed;
  return `${trimmed.slice(0, limit)}\n...[truncated ${trimmed.length - limit} chars]`;
}

// ---------------------------------------------------------------------------
// Grading (mirrors run-pilot.ts:361 gradeOne exactly)
// ---------------------------------------------------------------------------

async function gradeAttempt(cfg: BenchConfig, row: HfRow, patch: string): Promise<boolean | null> {
  if (!patch.trim()) {
    console.warn(`[bench]   empty patch for ${row.instance_id} — agent produced no diff; scoring as not-resolved`);
    return false; // empty patch never resolves
  }
  const runner = new PythonEvalRunner({ upstreamRepoDir: cfg.upstreamRepoDir, evalTimeoutMs: cfg.gradeTimeoutMs });
  try {
    const result = await runner.runEval({
      instance_id: row.instance_id,
      repo: row.repo,
      image: row.image_name,
      patch,
      test_patch: row.test_patch,
      install: row.install_config.install,
      test_cmd: row.install_config.test_cmd,
      log_parser: row.install_config.log_parser,
      fail_to_pass: row.FAIL_TO_PASS,
      pass_to_pass: row.PASS_TO_PASS,
    });
    return result.passed_match;
  } catch (err) {
    if (err instanceof EvalCouldNotGradeError) {
      console.warn(`[bench]   ungradeable (${err.reason}) for ${row.instance_id}`);
      return null;
    }
    throw err;
  }
}

/** --task-set grading via custom-grade.ts instead of the HF/eval.py path.
 *  `CustomGradeError` (container/checkout/patch/verifier-collection failure)
 *  becomes an unscorable (`passed: null`) outcome — the same "ungradeable is
 *  not a fail" posture as `gradeAttempt` above, not a crash. The gradeability
 *  gate (validate-task-set.ts) already proved this task CAN grade both
 *  directions; a `CustomGradeError` on a real solve attempt means THIS
 *  attempt's patch broke something (e.g. an unparseable diff), not that the
 *  task itself is broken. */
async function gradeTaskAttempt(taskSetDir: string, task: SkillTaskV1, patch: string): Promise<boolean | null> {
  if (!patch.trim()) {
    console.warn(`[bench]   empty patch for ${task.id} — agent produced no diff; scoring as not-resolved`);
    return false; // empty patch never resolves
  }
  try {
    const result = await runCustomGrade({ task, taskSetDir, patch });
    return result.passed;
  } catch (err) {
    if (err instanceof CustomGradeError) {
      console.warn(`[bench]   ungradeable (${err.reason}) for ${task.id}`);
      return null;
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Dry-run synthesis
// ---------------------------------------------------------------------------

function synthesizeOutcome(spec: AttemptSpec, armIndex: number): BenchOutcome {
  const passed = spec.unitIndex % 2 === 0;
  return {
    instanceId: spec.candidate.instance_id,
    arm: spec.arm.name,
    repeat: spec.repeat,
    passed,
    unscorable: false,
    costUsd: armIndex === 0 ? 0.03 : 0.025,
  };
}

function synthesizeTaskSetOutcome(spec: TaskSetAttemptSpec, armIndex: number): BenchOutcome {
  const passed = spec.unitIndex % 2 === 0;
  return {
    instanceId: spec.task.id,
    arm: spec.arm.name,
    repeat: spec.repeat,
    passed,
    unscorable: false,
    costUsd: armIndex === 0 ? 0.03 : 0.025,
  };
}

// ---------------------------------------------------------------------------
// Real solve + grade
// ---------------------------------------------------------------------------

async function solveAndGrade(
  cfg: BenchConfig,
  benchCfgDir: string,
  attemptsFile: string,
  transcriptsDir: string,
  instance: PilotInstance,
  hfRow: HfRow,
  baseDir: string,
  spec: AttemptSpec,
  gradeQueue: SerialTaskQueue,
  gradeFailures: string[],
  writtenKeys: string[],
): Promise<void> {
  const armDir = await createPilotWorkDir(cfg.outDir, `solve-${spec.arm.name}-${spec.repeat}-`);
  try {
    console.log(`[bench] solving ${instance.instance_id} arm=${spec.arm.name} repeat=${spec.repeat}`);
    await rm(armDir, { recursive: true, force: true });
    await cp(baseDir, armDir, { recursive: true });
    if (spec.arm.skillDir) await mountSkill(armDir, spec.arm.skillDir, spec.arm.name);

    const prompt = buildPrompt(instance.problem_statement, instance.interface);
    const args = buildClaudeArgs({ prompt, model: cfg.model, maxTurns: cfg.maxTurns });
    const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_CONFIG_DIR: benchCfgDir };
    const { stdout, stderr, exitCode } = await run('claude', args, { cwd: armDir, env });
    if (exitCode !== 0) {
      const context = compactProcessOutput([stderr, stdout].filter((part) => part.trim()).join('\n'));
      throw new Error(`claude exited ${exitCode}${context ? `: ${context}` : ''}`);
    }

    const claudeResult = parseClaudeJson(stdout);
    // Remove the mounted skill BEFORE recovering the patch — recoverPatch's
    // `git add -A` stages untracked files by design, and a still-mounted
    // skill would ship as an added file in every treatment arm's patch (see
    // unmountSkill's doc comment / final-review.md C1).
    if (spec.arm.skillDir) await unmountSkill(armDir);
    const patch = await recoverPatch(run, armDir);

    await mkdir(transcriptsDir, { recursive: true });
    const key = attemptKey({ instanceId: spec.candidate.instance_id, arm: spec.arm.name, repeat: spec.repeat });
    await writeFile(join(transcriptsDir, `${key}.json`), `${JSON.stringify({ ...claudeResult, patch }, null, 2)}\n`);

    gradeQueue.push(async () => {
      // gradeAttempt already converts EvalCouldNotGradeError into passed=null
      // (unscorable) — that is a legitimate grading outcome and is logged
      // normally. Anything else thrown here is an unexpected infra failure
      // (Docker, disk, network). It must NOT be folded into "unscorable" —
      // that would misrepresent an infra outage as a harness verdict. Instead:
      // log loudly, skip appendAttempt entirely (the attempt key stays absent
      // from attempts.jsonl, so a resume re-runs it), and record it so main()
      // can summarize + exit non-zero without aborting the rest of the run.
      try {
        const passed = await gradeAttempt(cfg, hfRow, patch);
        const outcome: BenchOutcome = {
          instanceId: spec.candidate.instance_id,
          arm: spec.arm.name,
          repeat: spec.repeat,
          passed,
          unscorable: passed === null,
          costUsd: claudeResult.costUsd,
        };
        await appendAttempt(attemptsFile, outcome);
        writtenKeys.push(key);
        const verdict = passed === null ? 'ungradeable' : passed ? 'passed' : 'failed';
        console.log(`[bench] graded ${instance.instance_id} arm=${spec.arm.name} → ${verdict}`);
      } catch (err) {
        console.error(`[bench] grade ERROR ${instance.instance_id} arm=${spec.arm.name}: ${(err as Error).message}`);
        gradeFailures.push(key);
      }
    });
  } finally {
    await rm(armDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

interface RunRealResult {
  gradeFailures: string[];
  /** Attempts that never reached the grade queue — claude spawn/exit failure,
   *  patch recovery failure, etc. (F3: previously silently swallowed by the
   *  per-spec `catch` below, which is how a run where every solve failed
   *  instantly still exited 0). */
  solveFailures: string[];
  /** Count of outcomes actually appended to attempts.jsonl by this run. Zero
   *  across a non-empty runnable set is a silence-looks-like-success signal
   *  distinct from any individual solve/grade failure (e.g. every instance
   *  failed at fetch/checkout, which isn't tracked in either failure list). */
  outcomesWritten: number;
}

async function runReal(
  cfg: BenchConfig,
  specs: AttemptSpec[],
  attemptsFile: string,
  transcriptsDir: string,
  benchCfgDir: string,
): Promise<RunRealResult> {
  const hfFetcher = new HttpHfFetcher();
  const gradeQueue = new SerialTaskQueue();
  const gradeFailures: string[] = [];
  const solveFailures: string[] = [];
  const writtenKeys: string[] = [];

  const byInstance = new Map<string, AttemptSpec[]>();
  for (const spec of specs) {
    const list = byInstance.get(spec.candidate.instance_id);
    if (list) list.push(spec);
    else byInstance.set(spec.candidate.instance_id, [spec]);
  }

  await mapWithConcurrency([...byInstance.entries()], cfg.solveConcurrency, async ([instanceId, instanceSpecs]) => {
    const candidate = instanceSpecs[0]!.candidate;
    let instance: PilotInstance;
    let hfRow: HfRow;
    try {
      const [rawRow, row] = await Promise.all([
        fetchPilotRawRow(candidate),
        hfFetcher.fetchTaskRow(candidate),
      ]);
      instance = parsePilotInstanceRow(rawRow, candidate);
      hfRow = row;
    } catch (err) {
      console.warn(`[bench] instance ${instanceId} fetch failed (${(err as Error).message}) — skipping, continuing`);
      return;
    }

    const baseDir = await createPilotWorkDir(cfg.outDir, `base-${instanceId.replace(/[^a-zA-Z0-9_-]/g, '_')}-`);
    try {
      console.log(`[bench] cloning ${instance.repo} @ ${instance.base_commit}...`);
      await prepareBaseCheckout(run, instance.repo, instance.base_commit, baseDir);
    } catch (err) {
      if (err instanceof GitStepError) {
        console.warn(`[bench] instance ${instanceId} base checkout failed (${err.message}) — skipping, continuing`);
      } else {
        console.warn(`[bench] instance ${instanceId} failed (${(err as Error).message}) — skipping, continuing`);
      }
      await rm(baseDir, { recursive: true, force: true });
      return;
    }

    try {
      for (const spec of instanceSpecs) {
        try {
          await solveAndGrade(cfg, benchCfgDir, attemptsFile, transcriptsDir, instance, hfRow, baseDir, spec, gradeQueue, gradeFailures, writtenKeys);
        } catch (solveErr) {
          console.warn(`[bench]   solve error for ${instanceId}/${spec.arm.name}/${spec.repeat}: ${(solveErr as Error).message} — skipping, continuing`);
          solveFailures.push(attemptKey({ instanceId: spec.candidate.instance_id, arm: spec.arm.name, repeat: spec.repeat }));
        }
      }
    } finally {
      await rm(baseDir, { recursive: true, force: true });
    }
  });

  await gradeQueue.drain();
  return { gradeFailures, solveFailures, outcomesWritten: writtenKeys.length };
}

// ---------------------------------------------------------------------------
// --task-set solve + grade (mirrors solveAndGrade/runReal above: same
// mount/spawn/unmount/recoverPatch sequence and the same "grade errors never
// abort the run" posture, with the task's 4-part requirement as the prompt,
// task.repo@task.commit as the per-task checkout, and custom-grade.ts as the
// grader in place of the HF/eval.py path).
// ---------------------------------------------------------------------------

async function solveAndGradeTaskSet(
  cfg: BenchConfig,
  benchCfgDir: string,
  attemptsFile: string,
  transcriptsDir: string,
  taskSetDir: string,
  baseDir: string,
  spec: TaskSetAttemptSpec,
  gradeQueue: SerialTaskQueue,
  gradeFailures: string[],
  writtenKeys: string[],
): Promise<void> {
  const armDir = await createPilotWorkDir(cfg.outDir, `solve-${spec.arm.name}-${spec.repeat}-`);
  try {
    console.log(`[bench] solving ${spec.task.id} arm=${spec.arm.name} repeat=${spec.repeat}`);
    await rm(armDir, { recursive: true, force: true });
    await cp(baseDir, armDir, { recursive: true });
    if (spec.arm.skillDir) await mountSkill(armDir, spec.arm.skillDir, spec.arm.name);

    const prompt = buildTaskSetPrompt(spec.task.requirement);
    const args = buildClaudeArgs({ prompt, model: cfg.model, maxTurns: cfg.maxTurns });
    const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_CONFIG_DIR: benchCfgDir };
    const { stdout, stderr, exitCode } = await run('claude', args, { cwd: armDir, env });
    if (exitCode !== 0) {
      const context = compactProcessOutput([stderr, stdout].filter((part) => part.trim()).join('\n'));
      throw new Error(`claude exited ${exitCode}${context ? `: ${context}` : ''}`);
    }

    const claudeResult = parseClaudeJson(stdout);
    // Same ordering rule as solveAndGrade: unmount BEFORE recoverPatch's
    // `git add -A` so a still-mounted skill never rides along in the patch.
    if (spec.arm.skillDir) await unmountSkill(armDir);
    const patch = await recoverPatch(run, armDir);

    await mkdir(transcriptsDir, { recursive: true });
    const key = attemptKey({ instanceId: spec.task.id, arm: spec.arm.name, repeat: spec.repeat });
    await writeFile(join(transcriptsDir, `${key}.json`), `${JSON.stringify({ ...claudeResult, patch }, null, 2)}\n`);

    gradeQueue.push(async () => {
      try {
        const passed = await gradeTaskAttempt(taskSetDir, spec.task, patch);
        const outcome: BenchOutcome = {
          instanceId: spec.task.id,
          arm: spec.arm.name,
          repeat: spec.repeat,
          passed,
          unscorable: passed === null,
          costUsd: claudeResult.costUsd,
        };
        await appendAttempt(attemptsFile, outcome);
        writtenKeys.push(key);
        const verdict = passed === null ? 'ungradeable' : passed ? 'passed' : 'failed';
        console.log(`[bench] graded ${spec.task.id} arm=${spec.arm.name} → ${verdict}`);
      } catch (err) {
        console.error(`[bench] grade ERROR ${spec.task.id} arm=${spec.arm.name}: ${(err as Error).message}`);
        gradeFailures.push(key);
      }
    });
  } finally {
    await rm(armDir, { recursive: true, force: true });
  }
}

async function runRealTaskSet(
  cfg: BenchConfig,
  specs: TaskSetAttemptSpec[],
  attemptsFile: string,
  transcriptsDir: string,
  benchCfgDir: string,
  taskSetDir: string,
): Promise<RunRealResult> {
  const gradeQueue = new SerialTaskQueue();
  const gradeFailures: string[] = [];
  const solveFailures: string[] = [];
  const writtenKeys: string[] = [];

  const byTask = new Map<string, TaskSetAttemptSpec[]>();
  for (const spec of specs) {
    const list = byTask.get(spec.task.id);
    if (list) list.push(spec);
    else byTask.set(spec.task.id, [spec]);
  }

  await mapWithConcurrency([...byTask.entries()], cfg.solveConcurrency, async ([taskId, taskSpecs]) => {
    const task = taskSpecs[0]!.task;
    const baseDir = await createPilotWorkDir(cfg.outDir, `base-${taskId.replace(/[^a-zA-Z0-9_-]/g, '_')}-`);
    try {
      console.log(`[bench] cloning ${task.repo} @ ${task.commit}...`);
      await prepareBaseCheckout(run, task.repo, task.commit, baseDir);
    } catch (err) {
      if (err instanceof GitStepError) {
        console.warn(`[bench] task ${taskId} base checkout failed (${err.message}) — skipping, continuing`);
      } else {
        console.warn(`[bench] task ${taskId} failed (${(err as Error).message}) — skipping, continuing`);
      }
      await rm(baseDir, { recursive: true, force: true });
      return;
    }

    try {
      for (const spec of taskSpecs) {
        try {
          await solveAndGradeTaskSet(
            cfg, benchCfgDir, attemptsFile, transcriptsDir, taskSetDir, baseDir, spec,
            gradeQueue, gradeFailures, writtenKeys,
          );
        } catch (solveErr) {
          console.warn(`[bench]   solve error for ${taskId}/${spec.arm.name}/${spec.repeat}: ${(solveErr as Error).message} — skipping, continuing`);
          solveFailures.push(attemptKey({ instanceId: spec.task.id, arm: spec.arm.name, repeat: spec.repeat }));
        }
      }
    } finally {
      await rm(baseDir, { recursive: true, force: true });
    }
  });

  await gradeQueue.drain();
  return { gradeFailures, solveFailures, outcomesWritten: writtenKeys.length };
}

/** Cheap auth probe against the isolated bench config dir, run once before
 *  any real solve work. Never in --dry-run (no claude spawn happens there
 *  anyway). Aborts the whole run with `authPreflightFailureMessage` on
 *  failure — never attempts to read/copy/extract a credential itself. */
async function runAuthPreflight(cfg: BenchConfig, benchCfgDir: string): Promise<void> {
  const probeCwd = await createPilotWorkDir(cfg.outDir, 'auth-probe-');
  try {
    const args = ['-p', 'ok', '--model', cfg.model, '--output-format', 'json', '--max-turns', '1'];
    const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_CONFIG_DIR: benchCfgDir };
    const { stdout, exitCode } = await run('claude', args, { cwd: probeCwd, env });
    const result = exitCode === 0 ? parseClaudeJson(stdout) : null;
    if (exitCode !== 0 || !result || result.isError) {
      throw new Error(authPreflightFailureMessage(benchCfgDir));
    }
    console.log('[bench] auth preflight ok');
  } finally {
    await rm(probeCwd, { recursive: true, force: true });
  }
}

/** Shared failure summary + non-zero exit-code decision for both run modes
 *  (extracted so slate and task-set main bodies don't duplicate F2/F3). */
function reportRunResult(
  solveFailures: string[],
  gradeFailures: string[],
  outcomesWritten: number,
  attemptsFile: string,
  runnableCount: number,
): void {
  let hadFailure = false;
  if (solveFailures.length > 0) {
    console.error(
      `[bench] ${solveFailures.length} attempt(s) failed before producing a gradeable patch and were ` +
      `NOT logged (re-runnable on resume): ${solveFailures.join(', ')}`,
    );
    hadFailure = true;
  }
  if (gradeFailures.length > 0) {
    console.error(
      `[bench] ${gradeFailures.length} attempt(s) hit an unexpected grade error and were NOT ` +
      `logged (re-runnable on resume): ${gradeFailures.join(', ')}`,
    );
    hadFailure = true;
  }
  // F3: a run where every solve failed instantly (e.g. auth broke mid-run,
  // every instance failed fetch/checkout) must not exit 0 with an empty
  // attempts.jsonl just because no individual failure list happened to
  // capture it — outcomesWritten is the ground-truth backstop.
  if (outcomesWritten === 0) {
    console.error(
      `[bench] NOTHING WAS RECORDED — 0 outcomes were appended to ${attemptsFile} across ` +
      `${runnableCount} runnable attempt(s). Treat this run as failed, not a clean no-op, even ` +
      `though no individual attempt above may show as a failure.`,
    );
    hadFailure = true;
  }
  if (hadFailure) process.exitCode = 1;
}

async function runSlateMode(cfg: BenchConfig): Promise<void> {
  const slate = loadSlate(cfg.slatePath);
  const arms = loadArms(cfg.armsPath);

  const manifest: BenchManifest = {
    version: 'skills-bench-manifest.v1',
    slateSha256: slate.sha256,
    half: cfg.half,
    model: cfg.model,
    arms: arms.map((arm) => ({ name: arm.name, skillSha256: arm.skillDir ? pinSha256(arm.skillDir) : null })),
    ...(cfg.dryRun ? { dryRun: true as const } : {}),
  };
  await assertManifestCompatible(join(cfg.outDir, 'bench-manifest.json'), manifest);

  const candidates = candidatesForHalf(slate, cfg.half)
    .slice(0, Number.isFinite(cfg.maxInstances) ? cfg.maxInstances : undefined);
  const specs = buildAttemptSpecs(candidates, arms, cfg.repeats);

  const attemptsFile = join(cfg.outDir, 'attempts.jsonl');
  const transcriptsDir = join(cfg.outDir, 'transcripts');
  const existingKeys = new Set((await loadAttempts(attemptsFile)).map(attemptKey));
  const runnable = specs.filter((spec) => !existingKeys.has(attemptKey({
    instanceId: spec.candidate.instance_id, arm: spec.arm.name, repeat: spec.repeat,
  })));

  if (runnable.length === 0) {
    console.log('[bench] no runnable attempts — every attempt key already present in attempts.jsonl (resumed).');
    return;
  }
  console.log(`[bench] ${runnable.length}/${specs.length} attempt(s) to run (${specs.length - runnable.length} already resumed)`);

  if (cfg.dryRun) {
    console.log('');
    console.log('==================== DRY RUN — no spend ====================');
    console.log('Skipping clone/spawn/grade/network. Synthesizing deterministic fake outcomes.');
    for (const spec of runnable) {
      const armIndex = arms.findIndex((a) => a.name === spec.arm.name);
      const outcome = synthesizeOutcome(spec, armIndex);
      await appendAttempt(attemptsFile, outcome);
      console.log(`[bench] dry-run result ${outcome.instanceId} arm=${outcome.arm} repeat=${outcome.repeat}: passed=${outcome.passed} cost=$${outcome.costUsd.toFixed(4)}`);
    }
    return;
  }

  // F2: fail loud before any real solve work if the isolated config dir has
  // no usable credentials — never in --dry-run (handled above by the return).
  await prepareBenchConfigDir(cfg.claudeConfigDir, {
    sourceConfigDir: process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'),
  });
  await runAuthPreflight(cfg, cfg.claudeConfigDir);

  if (cfg.half !== 'feedback') {
    // Every non-dry run that can touch holdout instances (--half holdout OR
    // --half both) records into the ledger, so the ledger is a complete audit
    // trail a receipt reader can inspect. Only --half holdout is *blocked* by
    // the one-shot guard — wave 1's --half both is a pre-candidate baseline
    // with no candidate id to key a block on (see batch-b-review.md "Holdout
    // backstop — recommendation").
    const ledgerFile = join(repoRoot, 'bench', 'holdout-ledger.json');
    console.log(`[bench] holdout ledger: ${ledgerFile}`);
    if (cfg.half === 'holdout') {
      if (cfg.forceHoldoutRerun) {
        console.warn(
          `[bench] --force-holdout-rerun set — skipping the one-shot holdout guard for candidate ` +
          `'${cfg.candidateId}'. Legitimate only if the prior holdout run for this candidate aborted ` +
          `before grading anything.`,
        );
      } else {
        await assertHoldoutUnused(ledgerFile, cfg.candidateId!);
      }
    }
    await recordHoldoutRun(ledgerFile, {
      candidateId: cfg.candidateId ?? '<pre-candidate>',
      runDir: cfg.outDir,
      at: new Date().toISOString(),
    });
  }

  const { gradeFailures, solveFailures, outcomesWritten } = await runReal(cfg, runnable, attemptsFile, transcriptsDir, cfg.claudeConfigDir);
  reportRunResult(solveFailures, gradeFailures, outcomesWritten, attemptsFile, runnable.length);
}

// ---------------------------------------------------------------------------
// --task-set main body (mirrors runSlateMode above). Diverges from it in
// four places: the zero-inference gradeability-gate refusal (before ANY
// work, dry-run included), the discrimination-gate task filter
// (selectTasksForMeasurement — spec §2.4), no holdout ledger (a
// `SkillTaskSetV1` has no feedback/holdout split — `half` is fixed to
// 'feedback' in its manifest so the field stays populated without implying a
// real split), and runRealTaskSet/synthesizeTaskSetOutcome in place of the
// slate equivalents.
// ---------------------------------------------------------------------------

async function runTaskSetMode(cfg: BenchConfig): Promise<void> {
  const taskSet = await loadTaskSet(cfg.taskSetDir);
  const arms = loadArms(cfg.armsPath);

  // The zero-inference gradeability gate (spec §2.3): fail loud, manifest-guard
  // style, before any solve/grade work — dry-run included, since this is a
  // configuration check, not a cost concern.
  assertTaskSetGradeable(taskSet);

  const manifest: BenchManifest = {
    version: 'skills-bench-manifest.v1',
    taskSetSha256: taskSet.sha256,
    half: 'feedback',
    model: cfg.model,
    arms: arms.map((arm) => ({ name: arm.name, skillSha256: arm.skillDir ? pinSha256(arm.skillDir) : null })),
    ...(cfg.dryRun ? { dryRun: true as const } : {}),
  };
  await assertManifestCompatible(join(cfg.outDir, 'bench-manifest.json'), manifest);

  // Discrimination gate (spec §2.4): a measured run only spends on tasks with
  // proven baseline headroom, unless the set carries no screening receipts
  // at all (screening is recommended, not hard-required) or the operator
  // passes --include-screened-out (loud warning either way).
  const screenedTasks = selectTasksForMeasurement(taskSet.tasks, { includeScreenedOut: cfg.includeScreenedOut });
  const tasks: SkillTaskSetV1['tasks'] = screenedTasks
    .slice(0, Number.isFinite(cfg.maxInstances) ? cfg.maxInstances : undefined);
  const specs = buildTaskSetAttemptSpecs(tasks, arms, cfg.repeats);

  const attemptsFile = join(cfg.outDir, 'attempts.jsonl');
  const transcriptsDir = join(cfg.outDir, 'transcripts');
  const existingKeys = new Set((await loadAttempts(attemptsFile)).map(attemptKey));
  const runnable = specs.filter((spec) => !existingKeys.has(attemptKey({
    instanceId: spec.task.id, arm: spec.arm.name, repeat: spec.repeat,
  })));

  if (runnable.length === 0) {
    console.log('[bench] no runnable attempts — every attempt key already present in attempts.jsonl (resumed).');
    return;
  }
  console.log(`[bench] ${runnable.length}/${specs.length} attempt(s) to run (${specs.length - runnable.length} already resumed)`);

  if (cfg.dryRun) {
    console.log('');
    console.log('==================== DRY RUN — no spend ====================');
    console.log('Skipping clone/spawn/grade/network. Synthesizing deterministic fake outcomes.');
    for (const spec of runnable) {
      const armIndex = arms.findIndex((a) => a.name === spec.arm.name);
      const outcome = synthesizeTaskSetOutcome(spec, armIndex);
      await appendAttempt(attemptsFile, outcome);
      console.log(`[bench] dry-run result ${outcome.instanceId} arm=${outcome.arm} repeat=${outcome.repeat}: passed=${outcome.passed} cost=$${outcome.costUsd.toFixed(4)}`);
    }
    return;
  }

  // F2: fail loud before any real solve work if the isolated config dir has
  // no usable credentials — never in --dry-run (handled above by the return).
  await prepareBenchConfigDir(cfg.claudeConfigDir, {
    sourceConfigDir: process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'),
  });
  await runAuthPreflight(cfg, cfg.claudeConfigDir);

  const { gradeFailures, solveFailures, outcomesWritten } = await runRealTaskSet(
    cfg, runnable, attemptsFile, transcriptsDir, cfg.claudeConfigDir, cfg.taskSetDir,
  );
  reportRunResult(solveFailures, gradeFailures, outcomesWritten, attemptsFile, runnable.length);
}

async function main(): Promise<void> {
  const cfg = parseArgs(process.argv.slice(2));
  console.log(`[bench] claude config dir: ${cfg.claudeConfigDir}`);
  if (cfg.taskSetDir) {
    await runTaskSetMode(cfg);
  } else {
    await runSlateMode(cfg);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
