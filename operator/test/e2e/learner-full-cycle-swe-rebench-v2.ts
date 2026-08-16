/**
 * Two-cycle learner full-cycle e2e on `swe-rebench-v2.v1`.
 *
 * Exercises production-like runtime plugins (`network-tools`, `swe-rebench-v2-runtime`)
 * resolved via `loadSolverNets`, with an offline pre-seeded repo under
 * `workingDir/repo` (no GitHub, Hugging Face, Docker, or eval-runner).
 *
 * Configure with:
 *   JINN_E2E_LEARNER_HARNESS=claude-code | codex
 *   JINN_E2E_LEARNER_CLI_PATH=/path/to/claude-or-codex
 *   JINN_E2E_LEARNER_MODEL=...
 *
 * Gates on configured CLI availability — skips cleanly when the CLI is missing
 * (same as portfolio `e2e:full-cycle`). Does not assert solution delivery or eval.
 *
 * Runtime budget: typically ~12-25 min. The per-cycle wall-clock cap is
 * CYCLE_WINDOW_MS (20 min; see learner-full-cycle-core.ts) — headroom for
 * claude-code/Haiku's slower cycle 2, not a target; cycles return when their
 * loop completes.
 *
 * Usage:
 *   yarn e2e:full-cycle-swe-rebench-v2
 *
 * Issue #682.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Task } from '../../src/types/task.js';
import { seedWorkingRepo, resolveSweLearnerPluginRoots } from './fixtures/swe-rebench-v2-learner-e2e.js';
import {
  assertCycle,
  assertCycle2BootReadsCycle1Head,
  assertImplStateDirHeadAdvanced,
  assertImplStateDirLearnerCommitSubjects,
  cleanupFullCycleWorkDirs,
  LEARNER_SEVEN_PHASE_LINES,
  runCycle,
  type CycleParams,
} from './learner-full-cycle-core.js';
import { bootstrapLearnerFullCycleE2e, logLearnerHarnessBanner } from './learner-harness-config.js';

const SOLVER_NET_NAME = 'learner-full-cycle-swe-rebench-v2-e2e';
const beforeSweHarnessRun = ({ workingDir }: Pick<CycleParams, 'workingDir'>) => seedWorkingRepo(workingDir);

function buildSweTaskForCycle(
  params: CycleParams,
  goal: { id: string; description: string; kind: string; deadline: number; spec: Record<string, unknown> },
  startTs: number,
  endTs: number,
): Task {
  const baseCommit = goal.spec.base_commit as string;
  return {
    id: params.goalId,
    solverType: 'swe-rebench-v2.v1',
    role: 'restoration',
    description: [
      goal.description,
      '',
      'IMPORTANT: The repository is ALREADY checked out at workingDir/repo at base_commit.',
      'Do NOT clone from GitHub or Hugging Face. Do NOT use Docker or the eval runner.',
      'All SWE edits belong under workingDir/repo only.',
      '',
      LEARNER_SEVEN_PHASE_LINES,
      'For Improve: write at least one trivial change under implStateDir/notes/ so learning state mutates.',
      'Exit cleanly when all phases are done.',
    ].join('\n'),
    window: { startTs, endTs },
    spec: {
      schemaVersion: 'swe-rebench-v2.v1',
      instance_id: 'jinn-e2e__local-fixture-1',
      repo: 'jinn/e2e-local-fixture',
      base_commit: baseCommit,
      language: 'text',
      problem_statement:
        'Append a line "e2e-ok" to README.md under workingDir/repo. No external network.',
      interface: '',
      hf_dataset: 'nebius/SWE-rebench-leaderboard',
      hf_split: '2026_02',
      deadline_unix: Math.floor(endTs / 1000),
      round_month: '2026-05',
      goal,
    },
  } as unknown as Task;
}

async function main(): Promise<void> {
  const boot = bootstrapLearnerFullCycleE2e();
  if (boot.kind === 'skip') {
    console.log(`SKIP: ${boot.reason}`);
    process.exit(0);
  }
  if (boot.kind === 'fail') {
    console.error(`FAIL: ${boot.reason}`);
    process.exit(1);
  }
  const { config, harness, cliVersion } = boot;
  logLearnerHarnessBanner(config, cliVersion);

  const { roots, names } = await resolveSweLearnerPluginRoots();
  console.log(`runtime plugins: ${names.join(', ')}`);

  console.log('=== learner full-cycle swe-rebench-v2 e2e ===\n');

  const implStateDir = mkdtempSync(join(tmpdir(), 'jinn-swe-fullcycle-state-'));
  const cycle1WorkingDir = mkdtempSync(join(tmpdir(), 'jinn-swe-fullcycle-c1-'));
  const cycle2WorkingDir = mkdtempSync(join(tmpdir(), 'jinn-swe-fullcycle-c2-'));

  let exitCode = 0;
  try {
    console.log(`implStateDir:   ${implStateDir}`);
    console.log(`cycle 1 work:   ${cycle1WorkingDir}`);
    console.log(`cycle 2 work:   ${cycle2WorkingDir}\n`);

    console.log('--- CYCLE 1 ---');
    const cycle1 = await runCycle({
      cycleLabel: 'cycle-1',
      goalId: 'swe-fullcycle-c1',
      goalDescription:
        'SWE-rebench v2 smoke cycle 1. Use the pre-seeded repo at workingDir/repo; append "e2e-ok" to README.md.',
      workingDir: cycle1WorkingDir,
      implStateDir,
      harness,
      config,
      solverNetName: SOLVER_NET_NAME,
      solverPluginRoots: roots,
      beforeHarnessRun: beforeSweHarnessRun,
      buildTask: buildSweTaskForCycle,
    });

    assertCycle(cycle1, { label: 'cycle-1', requireBootJson: true, requirePhaseRecords: true });

    const sha1 = cycle1.implStateDirHeadAfter;
    console.log(`  cycle 1 ended; implStateDir HEAD = ${sha1.slice(0, 8)}\n`);

    console.log('--- CYCLE 2 ---');
    const cycle2 = await runCycle({
      cycleLabel: 'cycle-2',
      goalId: 'swe-fullcycle-c2',
      goalDescription:
        'SWE-rebench v2 smoke cycle 2. Same repo layout as cycle 1; implStateDir already has cycle 1 learning. Append "e2e-ok-cycle2" to README.md.',
      workingDir: cycle2WorkingDir,
      implStateDir,
      harness,
      config,
      solverNetName: SOLVER_NET_NAME,
      solverPluginRoots: roots,
      beforeHarnessRun: beforeSweHarnessRun,
      buildTask: buildSweTaskForCycle,
    });

    assertCycle(cycle2, { label: 'cycle-2', requireBootJson: true, requirePhaseRecords: true });

    const sha2 = cycle2.implStateDirHeadAfter;
    console.log(`  cycle 2 ended; implStateDir HEAD = ${sha2.slice(0, 8)}\n`);

    console.log('--- LOAD-BEARING ASSERTIONS ---');
    assertImplStateDirHeadAdvanced(sha1, sha2, implStateDir);
    assertCycle2BootReadsCycle1Head(cycle2, sha1);
    assertImplStateDirLearnerCommitSubjects(implStateDir);

    console.log('\n=== e2e PASSED ===');
  } catch (err) {
    console.error(`\ne2e FAILED: ${err instanceof Error ? err.message : err}`);
    exitCode = 1;
  } finally {
    cleanupFullCycleWorkDirs({ implStateDir, cycle1WorkingDir, cycle2WorkingDir }, exitCode);
  }
  process.exit(exitCode);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
