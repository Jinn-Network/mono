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
 * Runtime budget: ~15-20 min (two ~10 min cycle windows).
 *
 * Usage:
 *   yarn e2e:full-cycle-swe-rebench-v2
 *
 * Issue #682.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildHarnesses } from '../../src/harnesses/impls/index.js';
import { CLAUDE_CODE_HARNESS, CODEX_HARNESS } from '../../src/harnesses/names.js';
import type { Task } from '../../src/types/task.js';
import { seedWorkingRepo, resolveSweLearnerPluginRoots } from './fixtures/swe-rebench-v2-learner-e2e.js';
import {
  assertCycle,
  assertCycle2BootReadsCycle1Head,
  assertImplStateDirHeadAdvanced,
  assertImplStateDirLearnerCommitSubjects,
  runCycle,
  type CycleParams,
} from './learner-full-cycle-core.js';
import {
  checkLearnerCli,
  readLearnerHarnessE2EConfig,
} from './learner-harness-config.js';

const SOLVER_NET_NAME = 'learner-full-cycle-swe-rebench-v2-e2e';

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
      'Run the FULL seven-phase learner pipeline:',
      'Orient -> Strategize -> Plan -> Execute -> Debrief -> Improve -> Memory consolidation.',
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
  const config = readLearnerHarnessE2EConfig();

  const cliCheck = checkLearnerCli(config);
  if (!cliCheck.ok) {
    console.log(`SKIP: ${cliCheck.reason}`);
    process.exit(0);
  }
  console.log(`learner harness: ${config.harnessName}`);
  console.log(`learner CLI:     ${config.cliPath} (${cliCheck.version})`);
  console.log(`learner model:   ${config.model}`);

  const { roots, names } = await resolveSweLearnerPluginRoots();
  if (!names.includes('@jinn-network/network-tools') || !names.includes('swe-rebench-v2-runtime')) {
    throw new Error(`E2E plugin fixture missing expected runtime plugins: ${names.join(', ')}`);
  }
  console.log(`runtime plugins: ${names.join(', ')}`);

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
      beforeHarnessRun: ({ workingDir }) => seedWorkingRepo(workingDir),
      buildTask: buildSweTaskForCycle,
    });

    assertCycle(cycle1, { label: 'cycle-1', requireBootJson: true });

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
      beforeHarnessRun: ({ workingDir }) => seedWorkingRepo(workingDir),
      buildTask: buildSweTaskForCycle,
    });

    assertCycle(cycle2, { label: 'cycle-2', requireBootJson: true });

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

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
