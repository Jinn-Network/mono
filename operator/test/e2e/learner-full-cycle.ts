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
 * Runtime budget: each cycle typically takes ~5-12 min as the agent walks through
 * Orient → Strategize → Plan → Execute → Debrief → Improve → Memory
 * consolidation, spawning specialized subagents per phase. The per-cycle
 * wall-clock cap is CYCLE_WINDOW_MS (20 min; see learner-full-cycle-core.ts) —
 * a headroom cap, not a target; cycles return when their loop completes.
 *
 * Usage:
 *   yarn e2e:full-cycle
 *
 * Plan 4 T3 / bd jinn-mono-iee.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Task } from '../../src/types/task.js';
import {
  assertCycle,
  assertCycle2BootReadsCycle1Head,
  assertImplStateDirHeadAdvanced,
  cleanupFullCycleWorkDirs,
  LEARNER_SEVEN_PHASE_LINES,
  runCycle,
  type CycleParams,
} from './learner-full-cycle-core.js';
import { bootstrapLearnerFullCycleE2e, logLearnerHarnessBanner } from './learner-harness-config.js';

function buildPortfolioTaskForCycle(
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
      LEARNER_SEVEN_PHASE_LINES,
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

  console.log('=== learner full-cycle e2e ===\n');

  const implStateDir = mkdtempSync(join(tmpdir(), 'jinn-fullcycle-state-'));
  const cycle1WorkingDir = mkdtempSync(join(tmpdir(), 'jinn-fullcycle-c1-'));
  const cycle2WorkingDir = mkdtempSync(join(tmpdir(), 'jinn-fullcycle-c2-'));

  let exitCode = 0;
  try {
    console.log(`implStateDir:   ${implStateDir}`);
    console.log(`cycle 1 work:   ${cycle1WorkingDir}`);
    console.log(`cycle 2 work:   ${cycle2WorkingDir}\n`);

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
      buildTask: buildPortfolioTaskForCycle,
    });

    assertCycle(cycle1, {
      label: 'cycle-1',
      requireBootJson: true,
      requireOutputJson: { foo: 'hello', bar: 'hello', baz: 'hello' },
    });

    const sha1 = cycle1.implStateDirHeadAfter;
    console.log(`  cycle 1 ended; implStateDir HEAD = ${sha1.slice(0, 8)}\n`);

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
      buildTask: buildPortfolioTaskForCycle,
    });

    assertCycle(cycle2, {
      label: 'cycle-2',
      requireBootJson: true,
      requireOutputJson: { foo: 'world', bar: 'world', baz: 'world' },
    });

    const sha2 = cycle2.implStateDirHeadAfter;
    console.log(`  cycle 2 ended; implStateDir HEAD = ${sha2.slice(0, 8)}\n`);

    console.log('--- LOAD-BEARING ASSERTIONS ---');
    assertImplStateDirHeadAdvanced(sha1, sha2, implStateDir);
    assertCycle2BootReadsCycle1Head(cycle2, sha1);

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
