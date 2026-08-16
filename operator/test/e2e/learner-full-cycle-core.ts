import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Harness, HarnessContext } from '../../src/harnesses/types.js';
import type { Task } from '../../src/types/task.js';
import type { LearnerHarnessE2EConfig } from './learner-harness-config.js';

const PHASES = [
  'orient',
  'strategize',
  'plan',
  'execute',
  'debrief',
  'improve',
  'memory-consolidation',
] as const;

export const LEARNER_SEVEN_PHASE_LINES = [
  'Run the FULL seven-phase learner pipeline:',
  'Orient -> Strategize -> Plan -> Execute -> Debrief -> Improve -> Memory consolidation.',
].join('\n');

/**
 * Per-cycle wall-clock cap; the harness aborts the cycle at this deadline.
 * Bumped from 10→20 min (#930): on claude-code/Haiku the full seven-phase loop —
 * especially cycle 2, which reads cycle 1's accumulated implStateDir and runs
 * slower — overruns a 10-min cap and is aborted before Memory consolidation,
 * failing the "all 7 phase artifacts" check. This is headroom, NOT a target: a
 * cycle returns as soon as its loop completes (typically ~5-12 min), so the cap
 * only bites on a slow run.
 */
export const CYCLE_WINDOW_MS = 20 * 60_000;

export interface CycleParams {
  cycleLabel: string;
  goalId: string;
  goalDescription: string;
  fieldValue?: string;
  workingDir: string;
  implStateDir: string;
  harness: Harness;
  config: LearnerHarnessE2EConfig;
  solverNetName?: string;
  /** Called immediately before harness.run (e.g. seed workingDir/repo). */
  beforeHarnessRun?: (
    params: Pick<CycleParams, 'workingDir' | 'implStateDir'>,
  ) => void | Promise<void | { baseCommit?: string }>;
  /** Passed to HarnessContext; portfolio omits. */
  solverPluginRoots?: string[];
  buildTask: (
    params: CycleParams,
    goal: { id: string; description: string; kind: string; deadline: number; spec: Record<string, unknown> },
    startTs: number,
    endTs: number,
  ) => Task;
}

interface CycleResult {
  exitCode: number;
  durationMs: number;
  phasesPresent: string[];
  bootJson: BootJson | null;
  outputJson: unknown | null;
  /** `.improve/summary.json` exists — the Improve phase ran to completion. */
  improveSummaryPresent: boolean;
  /** `.memory-consolidation/consolidation_record.json` exists — Memory consolidation ran to completion. */
  consolidationRecordPresent: boolean;
  implStateDirHeadAfter: string;
  errorMessage?: string;
}

interface BootJson {
  implStateDirShaAtStart: string;
  skillBundleCid?: string;
  goalId: string;
  deadline: number;
}

interface AssertOptions {
  label: string;
  requireBootJson: boolean;
  requireOutputJson?: Record<string, string>;
  /**
   * Require the Improve + Memory-consolidation phase records (their workingDir
   * artifacts) to be present — i.e. both write-phases ran to COMPLETION, not just
   * created their marker dir. Opt-in so the portfolio variant's contract is
   * unchanged; the swe-rebench-v2 variant sets it (#930). Catches a cycle that
   * was aborted mid-loop (e.g. window-end) before consolidation finished.
   *
   * This asserts the phases *ran*, not that Improve *promoted* anything durable —
   * that guarantee is cross-cycle, via assertImplStateDirHeadAdvanced (HEAD must
   * advance + ≥1 commit between cycles). Assumes mode='train' (what runCycle uses):
   * in frozen mode Improve/Memory are skipped and write no records, so do not set
   * this for a frozen cycle.
   */
  requirePhaseRecords?: boolean;
}

export interface FullCycleWorkDirs {
  implStateDir: string;
  cycle1WorkingDir: string;
  cycle2WorkingDir: string;
}

export function cleanupFullCycleWorkDirs(dirs: FullCycleWorkDirs, exitCode: number): void {
  if (exitCode === 0) {
    rmSync(dirs.implStateDir, { recursive: true, force: true });
    rmSync(dirs.cycle1WorkingDir, { recursive: true, force: true });
    rmSync(dirs.cycle2WorkingDir, { recursive: true, force: true });
  } else {
    console.log(`\nFailure artifacts preserved at:`);
    console.log(`  implStateDir: ${dirs.implStateDir}`);
    console.log(`  cycle 1 work: ${dirs.cycle1WorkingDir}`);
    console.log(`  cycle 2 work: ${dirs.cycle2WorkingDir}`);
  }
}

export async function runCycle(params: CycleParams): Promise<CycleResult> {
  const startedAt = Date.now();
  const startTs = startedAt;
  const endTs = startedAt + CYCLE_WINDOW_MS;

  let beforeRunSpec: Record<string, unknown> = {};
  if (params.beforeHarnessRun) {
    const extra = await params.beforeHarnessRun(params);
    if (extra && typeof extra === 'object' && 'baseCommit' in extra && extra.baseCommit) {
      beforeRunSpec = { base_commit: extra.baseCommit };
    }
  }

  const goal = {
    id: params.goalId,
    description: params.goalDescription,
    kind: 'smoke-test',
    deadline: endTs,
    spec: {
      ...(params.fieldValue !== undefined
        ? { fieldNames: ['foo', 'bar', 'baz'], fieldValue: params.fieldValue }
        : {}),
      ...beforeRunSpec,
    },
  };

  const task = params.buildTask(params, goal, startTs, endTs);
  const abort = new AbortController();
  const endTimer = setTimeout(() => abort.abort(), endTs - Date.now());
  let exitCode = 0;
  let errorMessage: string | undefined;

  console.log(
    `  running ${params.config.harnessName} via ${params.config.cliPath} ` +
      `(cycle window ${Math.round(CYCLE_WINDOW_MS / 60_000)}min)...`,
  );
  try {
    await params.harness.run({
      task,
      requestId: `${params.goalId}-request`,
      solverNet: {
        name: params.solverNetName ?? 'learner-full-cycle-e2e',
        solverType: task.solverType,
        model: params.config.model,
      },
      implStateDir: params.implStateDir,
      workingDir: params.workingDir,
      solverPluginRoots: params.solverPluginRoots,
      log: (event) => {
        console.log(`    [${params.cycleLabel}:${event.level}] ${event.msg}`);
      },
      abort: abort.signal,
      msUntilEndTs: () => Math.max(0, endTs - Date.now()),
      trajectory: { addSpan: () => undefined } as unknown as HarnessContext['trajectory'],
      mode: 'train',
    });
  } catch (err) {
    exitCode = 1;
    errorMessage = err instanceof Error ? err.message : String(err);
    console.error(`    [${params.cycleLabel}:err] ${errorMessage.slice(0, 500)}`);
  } finally {
    clearTimeout(endTimer);
  }

  const durationMs = Date.now() - startedAt;
  console.log(`  ${params.config.harnessName} exited ${exitCode} after ${Math.round(durationMs / 1000)}s`);

  const phasesPresent = PHASES.filter((p) => existsSync(join(params.workingDir, `.${p}`)));
  const bootJsonPath = join(params.workingDir, '.coordinator', 'boot.json');
  const bootJson: BootJson | null = existsSync(bootJsonPath)
    ? (JSON.parse(readFileSync(bootJsonPath, 'utf8')) as BootJson)
    : null;
  const outputJsonPath = join(params.workingDir, 'output.json');
  const outputJson: unknown | null = existsSync(outputJsonPath)
    ? JSON.parse(readFileSync(outputJsonPath, 'utf8'))
    : null;
  // Existence only — the record JSON is model-authored free-form (its schema
  // varies run-to-run), so we assert it was WRITTEN, never on its field values.
  const improveSummaryPresent = existsSync(join(params.workingDir, '.improve', 'summary.json'));
  const consolidationRecordPresent = existsSync(
    join(params.workingDir, '.memory-consolidation', 'consolidation_record.json'),
  );
  const implStateDirHeadAfter = existsSync(join(params.implStateDir, '.git'))
    ? execFileSync('git', ['-C', params.implStateDir, 'rev-parse', 'HEAD'], {
        encoding: 'utf8',
      }).trim()
    : '';

  return {
    exitCode,
    durationMs,
    phasesPresent,
    bootJson,
    outputJson,
    improveSummaryPresent,
    consolidationRecordPresent,
    implStateDirHeadAfter,
    errorMessage,
  };
}

export function assertCycle(result: CycleResult, opts: AssertOptions): void {
  if (result.exitCode !== 0) {
    throw new Error(`${opts.label}: learner harness exited with code ${result.exitCode}: ${result.errorMessage ?? ''}`);
  }
  for (const phase of PHASES) {
    if (!result.phasesPresent.includes(phase)) {
      throw new Error(`${opts.label}: phase artifact missing for '${phase}'`);
    }
  }
  console.log(`  ✓ ${opts.label} produced all 7 phase artifacts`);

  if (opts.requireBootJson) {
    if (result.bootJson === null) {
      throw new Error(`${opts.label}: workingDir/.coordinator/boot.json missing`);
    }
    if (typeof result.bootJson.implStateDirShaAtStart !== 'string') {
      throw new Error(`${opts.label}: boot.json.implStateDirShaAtStart not a string`);
    }
    console.log(
      `  ✓ ${opts.label} boot.json captures implStateDirShaAtStart=${result.bootJson.implStateDirShaAtStart.slice(0, 8)}`,
    );
  }

  if (opts.requirePhaseRecords) {
    if (!result.improveSummaryPresent) {
      throw new Error(`${opts.label}: .improve/summary.json missing — Improve phase did not run to completion`);
    }
    if (!result.consolidationRecordPresent) {
      throw new Error(
        `${opts.label}: .memory-consolidation/consolidation_record.json missing — ` +
          `Memory consolidation did not run to completion (cycle likely aborted mid-loop, e.g. at window-end)`,
      );
    }
    console.log(`  ✓ ${opts.label} Improve + Memory-consolidation phase records present`);
  }

  if (opts.requireOutputJson) {
    if (result.outputJson === null) {
      throw new Error(`${opts.label}: workingDir/output.json missing`);
    }
    const got = result.outputJson as Record<string, string>;
    for (const [k, v] of Object.entries(opts.requireOutputJson)) {
      if (got[k] !== v) {
        throw new Error(`${opts.label}: output.json.${k}=${JSON.stringify(got[k])} expected ${JSON.stringify(v)}`);
      }
    }
    console.log(`  ✓ ${opts.label} output.json matches expected ${JSON.stringify(opts.requireOutputJson)}`);
  }
}

export function assertImplStateDirHeadAdvanced(sha1: string, sha2: string, implStateDir: string): void {
  if (sha1 === sha2) {
    throw new Error(
      `implStateDir HEAD did not advance between cycles. sha1=${sha1} sha2=${sha2}. ` +
        `Improve did not commit anything in cycle 2 — the learner is not learning across runs.`,
    );
  }
  console.log(`  ✓ implStateDir HEAD advanced cycle1→cycle2: ${sha1.slice(0, 8)} → ${sha2.slice(0, 8)}`);

  const commitsBetweenCycles = execFileSync(
    'git',
    ['-C', implStateDir, 'log', '--oneline', `${sha1}..${sha2}`],
    { encoding: 'utf8' },
  ).trim();
  if (commitsBetweenCycles === '') {
    throw new Error(
      `no commits between cycle 1 (${sha1.slice(0, 8)}) and cycle 2 (${sha2.slice(0, 8)}); ` +
        `but HEAD differs — investigate`,
    );
  }
  console.log(`  ✓ ${commitsBetweenCycles.split('\n').length} commit(s) between cycles:`);
  for (const line of commitsBetweenCycles.split('\n')) {
    console.log(`      ${line}`);
  }
}

export function assertImplStateDirLearnerCommitSubjects(implStateDir: string): void {
  const subjects = execFileSync('git', ['-C', implStateDir, 'log', '--format=%s'], {
    encoding: 'utf8',
  })
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);

  const nonInit = subjects.filter((s) => s !== 'init implStateDir');
  if (nonInit.length === 0) {
    throw new Error('implStateDir has no commits beyond init implStateDir');
  }

  // We deliberately do NOT gate on commit-subject prefixes (`improve:` /
  // `consolidate:`). Those prefixes are model-authored free text, and a small
  // model (Haiku) does not reliably emit them — observed subjects across runs
  // include `Learn: ...` and `Promote HIGH recommendation: ...` for what is
  // mechanically an Improve promotion (#930). Gating on that prose tests the
  // model's formatting, not the learner's mechanism. The mechanism is asserted
  // robustly elsewhere: durable commits landed (≥1 non-init commit here + HEAD
  // advanced in assertImplStateDirHeadAdvanced), both write-phases ran to
  // completion (their workingDir records, via assertCycle's requirePhaseRecords),
  // and cycle 2 booted from cycle 1's HEAD (assertCycle2BootReadsCycle1Head).
  // Subjects (and whether the canonical prefixes appeared) are logged for
  // visibility only.
  //
  // Separately, Memory consolidation commits ONLY when it has durable curation
  // work; on a trivial task it legitimately makes no commit. See the consolidator
  // prompt ("If there's nothing to consolidate ... no commit is made") and the
  // design spec §9 ("If no commit was made (empty curation set), implStateDirShaAfter
  // must equal implStateDirShaBefore"):
  //   operator/plugins/learner/skills/learn/consolidator-prompt.md
  //   docs/superpowers/specs/2026-04-23-default-learning-restorer-design.md §9
  const sawImprove = subjects.some((s) => /^improve:/i.test(s));
  const sawConsolidate = subjects.some((s) => /^consolidate:/i.test(s));
  console.log(
    `  ✓ implStateDir has ${nonInit.length} durable learning commit(s) beyond init ` +
      `(canonical prefixes seen: improve:=${sawImprove} consolidate:=${sawConsolidate} — informational, not gated)`,
  );
}

export function assertCycle2BootReadsCycle1Head(
  cycle2: CycleResult,
  sha1: string,
): void {
  if (cycle2.bootJson === null) {
    throw new Error(`cycle 2 boot.json missing; cannot verify implStateDirShaAtStart`);
  }
  if (cycle2.bootJson.implStateDirShaAtStart !== sha1) {
    throw new Error(
      `cycle 2 boot.json.implStateDirShaAtStart=${cycle2.bootJson.implStateDirShaAtStart} ` +
        `did not match cycle 1's final HEAD ${sha1}. ` +
        `Cycle 2's learn skill did not read the updated implStateDir.`,
    );
  }
  console.log(`  ✓ cycle 2 boot.json.implStateDirShaAtStart matches cycle 1's HEAD`);
}
