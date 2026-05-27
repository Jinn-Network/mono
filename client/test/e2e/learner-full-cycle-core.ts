import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Harness, HarnessContext } from '../../src/harnesses/types.js';
import type { Task } from '../../src/types/task.js';
import type { LearnerHarnessE2EConfig } from './learner-harness-config.js';

export const PHASES = [
  'orient',
  'strategize',
  'plan',
  'execute',
  'debrief',
  'improve',
  'memory-consolidation',
] as const;

export interface CycleParams {
  cycleLabel: string;
  goalId: string;
  goalDescription: string;
  fieldValue?: string;
  goalSpec?: Record<string, unknown>;
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

export interface CycleResult {
  exitCode: number;
  durationMs: number;
  phasesPresent: string[];
  bootJson: BootJson | null;
  outputJson: unknown | null;
  implStateDirHeadAfter: string;
  errorMessage?: string;
}

export interface BootJson {
  implStateDirShaAtStart: string;
  skillBundleCid?: string;
  goalId: string;
  deadline: number;
}

export interface AssertOptions {
  label: string;
  requireBootJson: boolean;
  requireOutputJson?: Record<string, string>;
}

export async function runCycle(params: CycleParams): Promise<CycleResult> {
  const startedAt = Date.now();
  const startTs = startedAt;
  const endTs = startedAt + 600_000; // 10-minute window per cycle

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
      ...params.goalSpec,
      ...beforeRunSpec,
    },
  };

  const task = params.buildTask(params, goal, startTs, endTs);
  const abort = new AbortController();
  const endTimer = setTimeout(() => abort.abort(), endTs - Date.now());
  let exitCode = 0;
  let errorMessage: string | undefined;

  console.log(`  running ${params.config.harnessName} via ${params.config.cliPath} (cycle window 10min)...`);
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
  const implStateDirHeadAfter = existsSync(join(params.implStateDir, '.git'))
    ? execFileSync('git', ['-C', params.implStateDir, 'rev-parse', 'HEAD'], {
        encoding: 'utf8',
      }).trim()
    : '';

  return { exitCode, durationMs, phasesPresent, bootJson, outputJson, implStateDirHeadAfter, errorMessage };
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
  if (!subjects.some((s) => /^improve:/.test(s))) {
    throw new Error(`implStateDir log missing improve: commit; subjects=${JSON.stringify(subjects)}`);
  }
  if (!subjects.some((s) => /^consolidate:/.test(s))) {
    throw new Error(`implStateDir log missing consolidate: commit; subjects=${JSON.stringify(subjects)}`);
  }
  console.log(`  ✓ implStateDir has improve: and consolidate: commits`);
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
