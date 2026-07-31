/**
 * Discrimination gate (spec §2.4 of
 * docs/superpowers/specs/2026-07-30-skills-factory-mvp-design.md, v0.2):
 * a baseline-only (no skill) sweep over every gradeability-passing task in a
 * `SkillTaskSetV1`, `--repeats` times, that keeps only tasks with PROVEN
 * headroom — the baseline failed at least once. A task every configuration
 * solves (or none solves) measures nothing; this is the step
 * SWE-Skills-Bench's own construction skipped.
 *
 * Driving run-bench: this script does NOT reimplement solve/mount/grade —
 * `run-bench.ts` already owns that whole pipeline (auth preflight, manifest
 * guard, resumable attempts.jsonl, custom-grade.ts). But `run-bench.ts`
 * exports nothing (it is a `main()`-only CLI, unlike `sweep-gradeability.ts`
 * or `build-slate.ts`, which do export their reusable pieces) — there is
 * nothing to `import`. So this script spawns it as a subprocess with a
 * synthesized baseline-only arms file (`[{ name: 'baseline', skillDir: null
 * }]`) and `--include-screened-out` (this run's own baseline sweep must
 * cover every gradeability-passing task regardless of any screening receipts
 * already on disk from a prior pass — screening a set means measuring ALL of
 * it, not just what a stale receipt already kept). This is the "cleaner
 * path" the work item asked to choose and document: reusing run-bench's
 * internals directly would mean duplicating its mount/checkout/grade/manifest
 * logic since none of it is importable; driving it as a subprocess reuses
 * that machinery byte-for-byte instead.
 *
 * After the subprocess exits (must be exit code 0 — screening does not
 * tolerate partial baseline data; a non-zero exit means some repeat never
 * produced a logged outcome, and `attempts.jsonl` is resumable so simply
 * re-running this script picks up where it left off), this script reads
 * `<out>/attempts.jsonl`, groups the baseline outcomes by task id, applies
 * the pure selection rule (`decideScreening`, task-set.ts) per task, and
 * writes the resulting `screening` receipts + set-level `screeningSummary`
 * back into `<task-set>/set.json`. Membership never changes: a dropped task
 * stays in the file with `screening.keep === false`, so the screen is
 * auditable, not asserted. Screening receipts are excluded from
 * `hashTaskSet` the same way `gradeability` receipts are (task-set.ts) — the
 * set's identity (`sha256`) is unchanged by a re-screen.
 *
 * Usage:
 *   yarn tsx scripts/skills-bench/screen-task-set.ts \
 *     --task-set ../bench/task-sets/tdd --model claude-haiku-4-5-20251001 \
 *     [--repeats 2] [--pass-threshold 1] [--out ../bench/task-sets/tdd/.screening-run]
 */
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  loadTaskSet, assertTaskSetGradeable, buildScreeningReceipt, summarizeScreeningDecisions,
  applyScreeningResults, decideScreening,
  type SkillTaskSetV1, type ScreeningReceipt, type ScreeningDecision,
} from '../../src/skills-bench/task-set.js';
import { loadAttempts } from '../../src/skills-bench/attempts.js';

const BASELINE_ARM_NAME = 'baseline';

// client/scripts/skills-bench/screen-task-set.ts -> client
const clientDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const runBenchPath = join(clientDir, 'scripts', 'skills-bench', 'run-bench.ts');
const tsxBin = join(clientDir, 'node_modules', '.bin', 'tsx');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface ScreenConfig {
  taskSetDir: string;
  model: string;
  repeats: number;
  passThreshold: number;
  outDir: string;
}

function defaultOutDir(taskSetDir: string): string {
  return join(taskSetDir, '.screening-run');
}

export function parseArgs(argv: string[]): ScreenConfig {
  const cfg: Partial<ScreenConfig> = { repeats: 2, passThreshold: 1 };
  let taskSetDir = '';
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--task-set': taskSetDir = resolve(String(argv[++i])); break;
      case '--model': cfg.model = String(argv[++i]); break;
      case '--repeats': cfg.repeats = Number(argv[++i]); break;
      case '--pass-threshold': cfg.passThreshold = Number(argv[++i]); break;
      case '--out': cfg.outDir = resolve(String(argv[++i])); break;
      default: throw new Error(`unknown argument ${a}`);
    }
  }
  if (!taskSetDir) throw new Error('--task-set is required');
  if (!cfg.model) throw new Error('--model is required');
  if (!Number.isFinite(cfg.repeats) || cfg.repeats! < 1) throw new Error('--repeats must be a positive integer');
  if (!Number.isFinite(cfg.passThreshold) || cfg.passThreshold! <= 0 || cfg.passThreshold! > 1) {
    throw new Error('--pass-threshold must be in (0, 1]');
  }
  return {
    taskSetDir,
    model: cfg.model,
    repeats: cfg.repeats!,
    passThreshold: cfg.passThreshold!,
    outDir: cfg.outDir ?? defaultOutDir(taskSetDir),
  };
}

// ---------------------------------------------------------------------------
// Pure computation — given the baseline outcomes already grouped by task id,
// compute one receipt + decision per task. Exported and unit-testable
// without spawning anything (screen-task-set.test.ts).
// ---------------------------------------------------------------------------

export interface TaskScreeningResult {
  taskId: string;
  receipt: ScreeningReceipt;
  decision: ScreeningDecision;
}

export function computeScreeningResults(
  taskIds: string[],
  baselineOutcomesByTaskId: Map<string, (boolean | null)[]>,
  opts: { model: string; passThreshold: number; screenedAt?: string },
): TaskScreeningResult[] {
  return taskIds.map((taskId) => {
    const outcomes = baselineOutcomesByTaskId.get(taskId);
    if (!outcomes || outcomes.length === 0) {
      throw new Error(
        `no baseline attempts recorded for task '${taskId}' — run-bench should have produced at least one; ` +
        `screening cannot proceed (re-run this script, attempts.jsonl is resumable)`,
      );
    }
    const decision = decideScreening(outcomes, opts.passThreshold);
    const receipt = buildScreeningReceipt(outcomes, {
      model: opts.model, passThreshold: opts.passThreshold, screenedAt: opts.screenedAt,
    });
    return { taskId, receipt, decision };
  });
}

/** Writes the screened set back to `<dir>/set.json`. Trivial IO wrapper,
 *  mirroring validate-task-set.ts's own write — extracted so the "receipt
 *  write + reload round-trip" test can drive it directly. */
export async function writeScreenedTaskSet(dir: string, set: SkillTaskSetV1): Promise<void> {
  await writeFile(join(dir, 'set.json'), `${JSON.stringify(set, null, 2)}\n`);
}

// ---------------------------------------------------------------------------
// Subprocess driver
// ---------------------------------------------------------------------------

function runBenchSubprocess(args: string[]): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(tsxBin, [runBenchPath, ...args], { cwd: clientDir, env: process.env, stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', (code) => resolvePromise(code ?? 1));
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const cfg = parseArgs(process.argv.slice(2));
  const taskSet = await loadTaskSet(cfg.taskSetDir);

  // Screening spends real inference (baseline solves) — the zero-inference
  // gradeability gate must already be clean before that spend, same fail-loud
  // posture run-bench.ts --task-set enforces.
  assertTaskSetGradeable(taskSet);

  await mkdir(cfg.outDir, { recursive: true });
  const armsPath = join(cfg.outDir, 'screen-arms.json');
  await writeFile(armsPath, `${JSON.stringify([{ name: BASELINE_ARM_NAME, skillDir: null }], null, 2)}\n`);

  console.log(
    `[screen-task-set] driving run-bench.ts (subprocess) — baseline-only, ${cfg.repeats} repeat(s) over ` +
    `${taskSet.tasks.length} task(s) of '${taskSet.skill}'`,
  );
  const exitCode = await runBenchSubprocess([
    '--task-set', cfg.taskSetDir,
    '--arms', armsPath,
    '--model', cfg.model,
    '--repeats', String(cfg.repeats),
    '--out', cfg.outDir,
    // This sweep must cover every gradeability-passing task, independent of
    // any screening receipts already on disk from a prior pass — see the
    // module doc comment.
    '--include-screened-out',
  ]);
  if (exitCode !== 0) {
    throw new Error(
      `run-bench (baseline sweep) exited ${exitCode} — screening aborted before any receipts were written. ` +
      `Fix the underlying failure and re-run this script (attempts.jsonl in ${cfg.outDir} is resumable).`,
    );
  }

  const attempts = (await loadAttempts(join(cfg.outDir, 'attempts.jsonl')))
    .filter((o) => o.arm === BASELINE_ARM_NAME);
  const byTaskId = new Map<string, (boolean | null)[]>();
  for (const outcome of attempts) {
    const list = byTaskId.get(outcome.instanceId);
    if (list) list.push(outcome.passed);
    else byTaskId.set(outcome.instanceId, [outcome.passed]);
  }

  const screenedAt = new Date().toISOString();
  const results = computeScreeningResults(
    taskSet.tasks.map((t) => t.id),
    byTaskId,
    { model: cfg.model, passThreshold: cfg.passThreshold, screenedAt },
  );

  const receipts = new Map(results.map((r) => [r.taskId, r.receipt]));
  const summary = summarizeScreeningDecisions(
    results.map((r) => ({ taskId: r.taskId, decision: r.decision })),
    { model: cfg.model, repeats: cfg.repeats, passThreshold: cfg.passThreshold, screenedAt },
  );
  const screenedSet = applyScreeningResults(taskSet, receipts, summary);
  await writeScreenedTaskSet(cfg.taskSetDir, screenedSet);

  console.log(
    `[screen-task-set] done: kept=${summary.kept.length} droppedNoHeadroom=${summary.droppedNoHeadroom.length} ` +
    `droppedUngradeable=${summary.droppedUngradeable.length} (of ${taskSet.tasks.length} task(s))`,
  );
  if (summary.droppedUngradeable.length > 0) {
    console.error(
      `[screen-task-set] ${summary.droppedUngradeable.length} task(s) had an ungradeable baseline attempt ` +
      `during screening despite passing the gradeability gate — investigate before trusting this task set: ` +
      `${summary.droppedUngradeable.join(', ')}`,
    );
    process.exitCode = 1;
  }
  if (summary.kept.length === 0) {
    console.error('[screen-task-set] every task was screened out — nothing left with proven headroom.');
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
