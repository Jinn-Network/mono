/**
 * Automated two-cycle full-cycle e2e for the claude-code-learner plugin.
 *
 * Verifies the load-bearing claim: between cycle 1 and cycle 2, `implStateDir`
 * HEAD sha advances AND cycle 2's learn skill's boot reads the new sha.
 *
 * This script runs through the configured learner Harness, so it exercises the
 * daemon adapter path (shim → adapter → configured CLI) while still focusing on
 * learner loop semantics.
 *
 * Configure with:
 *   JINN_E2E_LEARNER_HARNESS=claude-code | codex
 *   JINN_E2E_LEARNER_CLI_PATH=/path/to/claude-or-codex
 *   JINN_E2E_LEARNER_MODEL=...
 *
 * Gates on configured CLI availability — skips cleanly with a clear message
 * when the CLI isn't in PATH (e.g. CI without Claude Code / Codex installed).
 *
 * Runtime budget: each cycle takes ~5-10 min as the agent walks through
 * Orient → Strategize → Plan → Execute → Debrief → Improve → Memory
 * consolidation, spawning specialized subagents per phase. Total: ~15-20 min.
 *
 * Usage:
 *   yarn e2e:full-cycle
 *
 * Plan 4 T3 / bd jinn-mono-iee.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildHarnesses } from '../../src/harnesses/impls/index.js';
import { CLAUDE_CODE_HARNESS, CODEX_HARNESS } from '../../src/harnesses/names.js';
import type { Harness, HarnessContext } from '../../src/harnesses/types.js';
import type { Task } from '../../src/types/task.js';
import {
  checkLearnerCli,
  readLearnerHarnessE2EConfig,
  type LearnerHarnessE2EConfig,
} from './learner-harness-config.js';

const PHASES = [
  'orient',
  'strategize',
  'plan',
  'execute',
  'debrief',
  'improve',
  'memory-consolidation',
] as const;

interface CycleParams {
  cycleLabel: string;
  goalId: string;
  goalDescription: string;
  fieldValue: string;
  workingDir: string;
  implStateDir: string;
  harness: Harness;
  config: LearnerHarnessE2EConfig;
}

interface CycleResult {
  exitCode: number;
  durationMs: number;
  phasesPresent: string[];
  bootJson: BootJson | null;
  outputJson: unknown | null;
  implStateDirHeadAfter: string;
  errorMessage?: string;
}

interface BootJson {
  implStateDirShaAtStart: string;
  skillBundleCid?: string;
  goalId: string;
  deadline: number;
}

async function main(): Promise<void> {
  const config = readLearnerHarnessE2EConfig();

  // Pre-flight: skip cleanly if configured learner CLI is not available.
  const cliCheck = checkLearnerCli(config);
  if (!cliCheck.ok) {
    console.log(`SKIP: ${cliCheck.reason}`);
    process.exit(0);
  }
  console.log(`learner harness: ${config.harnessName}`);
  console.log(`learner CLI:     ${config.cliPath} (${cliCheck.version})`);
  console.log(`learner model:   ${config.model}`);

  const harness = buildHarnesses({
    stub: true,
    rpcUrl: 'http://stub',
    claudePath: config.harnessName === CLAUDE_CODE_HARNESS ? config.cliPath : 'claude',
    claudeModel: config.model,
    codexPath: config.harnessName === CODEX_HARNESS ? config.cliPath : 'codex',
    codexModel: config.model,
  }).find((impl) => impl.name === config.harnessName);
  if (!harness) {
    console.error(`FAIL: configured learner harness not registered: ${config.harnessName}`);
    process.exit(1);
  }

  console.log('=== learner full-cycle e2e ===\n');

  const implStateDir = mkdtempSync(join(tmpdir(), 'jinn-fullcycle-state-'));
  const cycle1WorkingDir = mkdtempSync(join(tmpdir(), 'jinn-fullcycle-c1-'));
  const cycle2WorkingDir = mkdtempSync(join(tmpdir(), 'jinn-fullcycle-c2-'));

  let exitCode = 0;
  try {
    console.log(`implStateDir:   ${implStateDir}`);
    console.log(`cycle 1 work:   ${cycle1WorkingDir}`);
    console.log(`cycle 2 work:   ${cycle2WorkingDir}\n`);

    // ── CYCLE 1 ─────────────────────────────────────────────────────────────
    console.log('--- CYCLE 1 ---');
    const cycle1 = await runCycle({
      cycleLabel: 'cycle-1',
      goalId: 'fullcycle-c1',
      goalDescription:
        "Trivial smoke test. Write a JSON file with three fields named foo, bar, baz, each containing the string 'hello'. Output to workingDir/output.json.",
      fieldValue: 'hello',
      workingDir: cycle1WorkingDir,
      implStateDir,
      harness,
      config,
    });

    assertCycle(cycle1, {
      label: 'cycle-1',
      requireBootJson: true,
      requireOutputJson: { foo: 'hello', bar: 'hello', baz: 'hello' },
    });

    const sha1 = cycle1.implStateDirHeadAfter;
    console.log(`  cycle 1 ended; implStateDir HEAD = ${sha1.slice(0, 8)}\n`);

    // ── CYCLE 2 ─────────────────────────────────────────────────────────────
    console.log('--- CYCLE 2 ---');
    const cycle2 = await runCycle({
      cycleLabel: 'cycle-2',
      goalId: 'fullcycle-c2',
      goalDescription:
        "Second cycle. Same kind as cycle 1 — write a JSON output file with three fields named foo, bar, baz, each containing the string 'world' (different value). The implStateDir already contains content from cycle 1; the agent should leverage it.",
      fieldValue: 'world',
      workingDir: cycle2WorkingDir,
      implStateDir,
      harness,
      config,
    });

    assertCycle(cycle2, {
      label: 'cycle-2',
      requireBootJson: true,
      requireOutputJson: { foo: 'world', bar: 'world', baz: 'world' },
    });

    const sha2 = cycle2.implStateDirHeadAfter;
    console.log(`  cycle 2 ended; implStateDir HEAD = ${sha2.slice(0, 8)}\n`);

    // ── LOAD-BEARING ASSERTIONS ─────────────────────────────────────────────
    console.log('--- LOAD-BEARING ASSERTIONS ---');

    if (sha1 === sha2) {
      throw new Error(
        `implStateDir HEAD did not advance between cycles. sha1=${sha1} sha2=${sha2}. ` +
          `Improve did not commit anything in cycle 2 — the learner is not learning across runs.`,
      );
    }
    console.log(`  ✓ implStateDir HEAD advanced cycle1→cycle2: ${sha1.slice(0, 8)} → ${sha2.slice(0, 8)}`);

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

    console.log('\n=== e2e PASSED ===');
  } catch (err) {
    console.error(`\ne2e FAILED: ${err instanceof Error ? err.message : err}`);
    exitCode = 1;
  } finally {
    // Preserve artifacts on failure for postmortem; clean up on success.
    if (exitCode === 0) {
      rmSync(implStateDir, { recursive: true, force: true });
      rmSync(cycle1WorkingDir, { recursive: true, force: true });
      rmSync(cycle2WorkingDir, { recursive: true, force: true });
    } else {
      console.log(`\nFailure artifacts preserved at:`);
      console.log(`  implStateDir: ${implStateDir}`);
      console.log(`  cycle 1 work: ${cycle1WorkingDir}`);
      console.log(`  cycle 2 work: ${cycle2WorkingDir}`);
    }
  }
  process.exit(exitCode);
}

async function runCycle(params: CycleParams): Promise<CycleResult> {
  const startedAt = Date.now();
  const startTs = startedAt;
  const endTs = startedAt + 600_000; // 10-minute window per cycle

  const goal = {
    id: params.goalId,
    description: params.goalDescription,
    kind: 'smoke-test',
    deadline: endTs,
    spec: { fieldNames: ['foo', 'bar', 'baz'], fieldValue: params.fieldValue },
  };

  const task = buildTaskForCycle(params, goal, startTs, endTs);
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
        name: 'learner-full-cycle-e2e',
        solverType: task.solverType,
        model: params.config.model,
      },
      implStateDir: params.implStateDir,
      workingDir: params.workingDir,
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

  // Capture phase presence + boot.json + output.json + final implStateDir HEAD.
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

function buildTaskForCycle(
  params: CycleParams,
  goal: { id: string; description: string; kind: string; deadline: number; spec: Record<string, unknown> },
  startTs: number,
  endTs: number,
): Task {
  return {
    id: params.goalId,
    role: 'restoration',
    description: [
      params.goalDescription,
      '',
      'Run the FULL seven-phase learner pipeline:',
      'Orient -> Strategize -> Plan -> Execute -> Debrief -> Improve -> Memory consolidation.',
      'For Improve: even if Debrief found no major issues, write at least one trivial improvement',
      'such as a note in implStateDir/notes/ so the cross-cycle test can verify learning state mutation.',
      'Exit cleanly when all phases are done.',
    ].join('\n'),
    window: { startTs, endTs },
    spec: {
      ...goal.spec,
      goal,
    },
  };
}

interface AssertOptions {
  label: string;
  requireBootJson: boolean;
  requireOutputJson: Record<string, string>;
}

function assertCycle(result: CycleResult, opts: AssertOptions): void {
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

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
