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
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildHarnesses } from '../../src/harnesses/impls/index.js';
import { CLAUDE_CODE_HARNESS, CODEX_HARNESS } from '../../src/harnesses/names.js';
import type { Task } from '../../src/types/task.js';
import {
  assertCycle,
  assertCycle2BootReadsCycle1Head,
  assertImplStateDirHeadAdvanced,
  runCycle,
  type CycleParams,
} from './learner-full-cycle-core.js';
import {
  checkLearnerCli,
  readLearnerHarnessE2EConfig,
} from './learner-harness-config.js';

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
