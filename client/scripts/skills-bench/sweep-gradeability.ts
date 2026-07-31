/**
 * Zero-inference gradeability pre-sweep for the generic swe-rebench slate
 * path (spec §2b). The motivating incident: slate instance
 * zarr-developers__zarr-python-2629 was ungradeable
 * (`conftest_import_error`, both arms, consistent) but that was discovered
 * only AFTER paying for two solves. This script finds that class of problem
 * *before* any solve spend: grade an EMPTY patch through the real Docker
 * eval path for every slate instance and classify the outcome —
 *
 *   - the eval completes (any `passed_match` value, since an empty patch is
 *     expected not to resolve) → `gradeable`
 *   - `EvalCouldNotGradeError` → `ungradeable`, with the operator-environment
 *     reason recorded for `build-slate.ts --exclude-instances`
 *   - anything else → `error` — this is NOT a verdict about the instance, it
 *     means the sweep itself broke; the script fails loud (non-zero exit)
 *     once all requested instances have been attempted.
 *
 * Durable/resumable like `attempts.ts`: the report is rewritten to disk
 * after every instance, and a re-run skips any instance already classified
 * in the report on disk.
 *
 * Usage:
 *   yarn tsx scripts/skills-bench/sweep-gradeability.ts \
 *     --slate ../bench/slate/slate.json \
 *     [--instances id1,id2] [--timeout-ms 3600000] [--upstream-repo-dir PATH] \
 *     [--out ../bench/slate/gradeability-sweep.json]
 */
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { SkillsBenchSlate, SlateCandidate } from '../../src/skills-bench/slate.js';
import type { HfFetcher, EvalRunner } from '../../src/harnesses/impls/swe-rebench-v2-evaluator/index.js';
import { HttpHfFetcher } from '../../src/harnesses/impls/swe-rebench-v2-evaluator/hf-fetcher.js';
import {
  PythonEvalRunner,
  EvalCouldNotGradeError,
} from '../../src/harnesses/impls/swe-rebench-v2-evaluator/eval-runner.js';

export type GradeabilityStatus = 'gradeable' | 'ungradeable' | 'error';

export interface GradeabilitySweepResult {
  instance_id: string;
  status: GradeabilityStatus;
  /** Present for `ungradeable` (EvalCouldNotGradeError.reason) and `error`
   *  (the unexpected error's message). Absent for `gradeable`. */
  reason?: string;
  durationMs: number;
  gradedAt: string;
}

export interface GradeabilitySweepReport {
  version: 'skills-bench-gradeability-sweep.v1';
  slateSha256: string;
  results: Record<string, GradeabilitySweepResult>;
}

/**
 * The three raw outcomes an empty-patch grade attempt can produce, decoupled
 * from the try/catch that observes them so the gradeable/ungradeable/error
 * mapping is a pure, directly unit-testable function.
 */
export type GradeEmptyPatchOutcome =
  | { kind: 'completed' }
  | { kind: 'could-not-grade'; reason: string }
  | { kind: 'unexpected'; message: string };

export function classifyGradeability(outcome: GradeEmptyPatchOutcome): { status: GradeabilityStatus; reason?: string } {
  switch (outcome.kind) {
    case 'completed':
      return { status: 'gradeable' };
    case 'could-not-grade':
      return { status: 'ungradeable', reason: outcome.reason };
    case 'unexpected':
      return { status: 'error', reason: outcome.message };
  }
}

function initReport(slateSha256: string): GradeabilitySweepReport {
  return { version: 'skills-bench-gradeability-sweep.v1', slateSha256, results: {} };
}

async function loadOrInitReport(reportPath: string, slateSha256: string): Promise<GradeabilitySweepReport> {
  if (!existsSync(reportPath)) return initReport(slateSha256);
  const existing = JSON.parse(readFileSync(reportPath, 'utf8')) as GradeabilitySweepReport;
  if (existing.slateSha256 !== slateSha256) {
    throw new Error(
      `gradeability sweep report mismatch: ${reportPath} was written for slate sha256=${existing.slateSha256}, ` +
      `but the current slate hashes to ${slateSha256}. Use a fresh --out path for a changed slate.`,
    );
  }
  return existing;
}

async function writeReport(reportPath: string, report: GradeabilitySweepReport): Promise<void> {
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
}

/** Runs the empty-patch grade for one candidate and reduces every failure
 *  mode (fetch error, could-not-grade, anything else) to a `GradeEmptyPatchOutcome`
 *  — this function never throws. */
async function gradeEmptyPatch(
  deps: { fetcher: HfFetcher; runner: EvalRunner },
  candidate: SlateCandidate,
): Promise<GradeEmptyPatchOutcome> {
  try {
    const row = await deps.fetcher.fetchTaskRow({
      hf_dataset: candidate.hf_dataset,
      hf_split: candidate.hf_split,
      instance_id: candidate.instance_id,
    });
    await deps.runner.runEval({
      instance_id: candidate.instance_id,
      repo: row.repo,
      image: row.image_name,
      patch: '',
      test_patch: row.test_patch,
      install: row.install_config.install,
      test_cmd: row.install_config.test_cmd,
      log_parser: row.install_config.log_parser,
      fail_to_pass: row.FAIL_TO_PASS,
      pass_to_pass: row.PASS_TO_PASS,
    });
    return { kind: 'completed' };
  } catch (err) {
    if (err instanceof EvalCouldNotGradeError) return { kind: 'could-not-grade', reason: err.reason };
    return { kind: 'unexpected', message: err instanceof Error ? err.message : String(err) };
  }
}

export interface SweepArgs {
  slate: SkillsBenchSlate;
  /** Instance ids to sweep; defaults to every instance in both halves.
   *  Throws if an id is not present in the slate. */
  instanceIds?: string[];
  reportPath: string;
  deps: { fetcher: HfFetcher; runner: EvalRunner };
  /** Injectable for tests; defaults to the real wall clock. */
  now?: () => number;
}

export async function sweepGradeability(args: SweepArgs): Promise<GradeabilitySweepReport> {
  const all = [...args.slate.feedback, ...args.slate.holdout];
  let targets = all;
  if (args.instanceIds && args.instanceIds.length > 0) {
    const byId = new Map(all.map((c) => [c.instance_id, c]));
    targets = args.instanceIds.map((id) => {
      const candidate = byId.get(id);
      if (!candidate) throw new Error(`instance ${id} not found in slate (feedback + holdout)`);
      return candidate;
    });
  }

  const now = args.now ?? Date.now;
  const report = await loadOrInitReport(args.reportPath, args.slate.sha256);

  for (const candidate of targets) {
    const existing = report.results[candidate.instance_id];
    // 'error' means the SWEEP ITSELF broke on this instance (docker/network/
    // etc.) — it is not a verdict about the instance, unlike 'gradeable'/
    // 'ungradeable', so it must never be cached as terminal: a resume
    // re-attempts it instead of silently treating an infra hiccup as
    // permanent (I3).
    if (existing && existing.status !== 'error') {
      console.log(`[sweep-gradeability] skip ${candidate.instance_id} — already classified: ${existing.status}`);
      continue;
    }
    if (existing) {
      console.log(`[sweep-gradeability] retrying ${candidate.instance_id} — previously errored (not a terminal verdict)`);
    }
    console.log(`[sweep-gradeability] grading empty patch for ${candidate.instance_id}...`);
    const started = now();
    const outcome = await gradeEmptyPatch(args.deps, candidate);
    const durationMs = now() - started;
    const classified = classifyGradeability(outcome);
    report.results[candidate.instance_id] = {
      instance_id: candidate.instance_id,
      status: classified.status,
      ...(classified.reason ? { reason: classified.reason } : {}),
      durationMs,
      gradedAt: new Date().toISOString(),
    };
    await writeReport(args.reportPath, report);
    const mins = (durationMs / 60000).toFixed(1);
    console.log(`[sweep-gradeability] ${candidate.instance_id} -> ${classified.status} (${mins} min)`);
  }

  return report;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface CliArgs {
  slatePath: string;
  instanceIds: string[] | undefined;
  timeoutMs: number;
  upstreamRepoDir: string;
  out: string | undefined;
}

function parseArgs(argv: string[]): CliArgs {
  let slatePath = '';
  let instances: string | undefined;
  let timeoutMs = 3_600_000;
  let upstreamRepoDir = join(homedir(), '.jinn-client', 'SWE-rebench-V2-upstream');
  let out: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--slate') slatePath = String(argv[++i]);
    else if (a === '--instances') instances = String(argv[++i]);
    else if (a === '--timeout-ms') timeoutMs = Number(argv[++i]);
    else if (a === '--upstream-repo-dir') upstreamRepoDir = resolvePath(String(argv[++i]));
    else if (a === '--out') out = String(argv[++i]);
    else throw new Error(`unknown argument ${a}`);
  }
  if (!slatePath) throw new Error('--slate is required');
  return {
    slatePath: resolvePath(slatePath),
    instanceIds: instances ? instances.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
    timeoutMs,
    upstreamRepoDir,
    out,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const slate = JSON.parse(readFileSync(args.slatePath, 'utf8')) as SkillsBenchSlate;
  const reportPath = args.out ? resolvePath(args.out) : join(dirname(args.slatePath), 'gradeability-sweep.json');

  const deps = {
    fetcher: new HttpHfFetcher(),
    runner: new PythonEvalRunner({ upstreamRepoDir: args.upstreamRepoDir, evalTimeoutMs: args.timeoutMs }),
  };

  const report = await sweepGradeability({
    slate,
    instanceIds: args.instanceIds,
    reportPath,
    deps,
  });

  const results = Object.values(report.results);
  const gradeable = results.filter((r) => r.status === 'gradeable').length;
  const ungradeable = results.filter((r) => r.status === 'ungradeable');
  const errored = results.filter((r) => r.status === 'error');
  console.log(
    `[sweep-gradeability] done: gradeable=${gradeable} ungradeable=${ungradeable.length} error=${errored.length}`,
  );
  if (ungradeable.length > 0) {
    console.log('[sweep-gradeability] ungradeable instances (candidates for build-slate.ts --exclude-instances):');
    for (const r of ungradeable) console.log(`  ${r.instance_id}: ${r.reason}`);
  }
  if (errored.length > 0) {
    console.error('[sweep-gradeability] the sweep itself errored on these instances (not a gradeability verdict):');
    for (const r of errored) console.error(`  ${r.instance_id}: ${r.reason}`);
    process.exitCode = 1;
  }
  console.log(`[sweep-gradeability] report: ${reportPath}`);
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
