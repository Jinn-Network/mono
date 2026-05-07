/**
 * Freeze-mode lifecycle integration test.
 *
 * Public command: `yarn e2e:freeze-mode`
 *
 * Option B (lightweight integration): exercises the daemon-config → engine →
 * freeze-fence → envelope path using `runHarnessOnce` directly, without
 * spawning Anvil or submitting on-chain. This is sufficient for v1 confidence:
 * the substantive freeze-mode contract (snapshot / hash / rollback) is verified
 * end-to-end at the daemon-engine boundary. Full Anvil-fork integration
 * (on-chain settlement under freeze-mode) is deferred to a later integration
 * sprint.
 *
 * Three cases:
 *   1. Train mode: codeDigest mutates between Tasks (harness may write).
 *   2. Frozen mode: codeDigest is stable across Tasks (harness reads only).
 *   3. Frozen mode: deliberate-violation harness is caught; envelope is NOT
 *      produced; implStateDir is rolled back to pre-run state.
 *
 * Spec: docs/superpowers/specs/2026-05-06-agent-harness-solvernet-design.md §6.3
 *
 * DONE_WITH_CONCERNS: Anvil-fork path (full on-chain settlement in freeze mode)
 * is not covered here. The unit coverage in
 * test/harnesses/engine/engine-mode.test.ts covers the same fence logic;
 * this file adds the e2e entry point and runPhase scaffolding. Full
 * Anvil-fork integration deferred to the Phase A integration sprint.
 */

import { mkdtemp, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runHarnessOnce } from '../../src/harnesses/engine/engine.js';
import type { Harness, Solution } from '../../src/harnesses/types.js';
import { runPhase, summarize, assert } from './task-first-helpers.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function stubSolution(overrides: Partial<Solution> = {}): Solution {
  return { venueRef: { name: 'test' }, gating: {}, ...overrides };
}

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'jinn-freeze-e2e-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ── Test cases ────────────────────────────────────────────────────────────────

/**
 * Case 1: train mode — codeDigest mutates between Tasks.
 *
 * Each call to `runHarnessOnce` in train mode should return a different
 * `executor.codeDigest` because the harness writes a new file each time,
 * mutating `implStateDir`.
 */
async function runTrainModeMutatesDigest(): Promise<void> {
  await withTempDir(async (implStateDir) => {
    let callCount = 0;
    const harness: Harness = {
      name: 'writing-harness',
      version: '0.1.0',
      supports: () => true,
      async run(ctx) {
        callCount++;
        // Write a new file each time — legitimate in train mode.
        await writeFile(join(ctx.implStateDir, `run-${callCount}.txt`), `run ${callCount} data`);
        return stubSolution();
      },
    };

    const result1 = await runHarnessOnce({ harness, implStateDir, mode: 'train' });
    const result2 = await runHarnessOnce({ harness, implStateDir, mode: 'train' });

    assert(!result1.violation, 'train run 1: unexpected violation');
    assert(!result2.violation, 'train run 2: unexpected violation');
    assert(result1.envelope !== undefined, 'train run 1: envelope must be present');
    assert(result2.envelope !== undefined, 'train run 2: envelope must be present');

    assert(
      result1.envelope.executor.mode === 'train',
      `train run 1: executor.mode must be "train", got "${result1.envelope.executor.mode}"`,
    );
    assert(
      result2.envelope.executor.mode === 'train',
      `train run 2: executor.mode must be "train", got "${result2.envelope.executor.mode}"`,
    );

    assert(
      result1.envelope.executor.codeDigest !== result2.envelope.executor.codeDigest,
      `train mode: codeDigest must mutate between Tasks (both were ${result1.envelope.executor.codeDigest})`,
    );

    process.stdout.write(
      `  run1.codeDigest=${result1.envelope.executor.codeDigest.slice(0, 20)}… ` +
      `run2.codeDigest=${result2.envelope.executor.codeDigest.slice(0, 20)}… (differ, as expected)\n`,
    );
  });
}

/**
 * Case 2: frozen mode — codeDigest is stable across Tasks.
 *
 * When the harness is read-only (frozen-compliant), consecutive calls in
 * frozen mode must return the same `executor.codeDigest` — the state hash
 * does not change.
 */
async function runFrozenModeStableDigest(): Promise<void> {
  await withTempDir(async (implStateDir) => {
    // Pre-populate so the hash is over real content.
    await writeFile(join(implStateDir, 'knowledge.json'), JSON.stringify({ version: 1 }));

    const harness: Harness = {
      name: 'readonly-harness',
      version: '0.1.0',
      supports: () => true,
      async run() {
        // Frozen-compliant: no writes to implStateDir.
        return stubSolution();
      },
    };

    const result1 = await runHarnessOnce({ harness, implStateDir, mode: 'frozen' });
    const result2 = await runHarnessOnce({ harness, implStateDir, mode: 'frozen' });

    assert(!result1.violation, 'frozen run 1: unexpected violation');
    assert(!result2.violation, 'frozen run 2: unexpected violation');
    assert(result1.envelope !== undefined, 'frozen run 1: envelope must be present');
    assert(result2.envelope !== undefined, 'frozen run 2: envelope must be present');

    assert(
      result1.envelope.executor.mode === 'frozen',
      `frozen run 1: executor.mode must be "frozen", got "${result1.envelope.executor.mode}"`,
    );
    assert(
      result2.envelope.executor.mode === 'frozen',
      `frozen run 2: executor.mode must be "frozen", got "${result2.envelope.executor.mode}"`,
    );

    assert(
      result1.envelope.executor.codeDigest === result2.envelope.executor.codeDigest,
      `frozen mode: codeDigest must be stable across Tasks ` +
      `(got ${result1.envelope.executor.codeDigest} vs ${result2.envelope.executor.codeDigest})`,
    );

    process.stdout.write(
      `  codeDigest=${result1.envelope.executor.codeDigest.slice(0, 20)}… (stable across 2 runs)\n`,
    );
  });
}

/**
 * Case 3: frozen mode — deliberate-violation harness detected; envelope
 * rejected; implStateDir rolled back.
 *
 * A harness that writes to `implStateDir` in frozen mode violates the
 * contract. The fence must:
 *   a) return `{ violation }` (no `envelope`),
 *   b) roll back implStateDir to its pre-run state.
 */
async function runFrozenModeViolationRejectedAndRolledBack(): Promise<void> {
  await withTempDir(async (implStateDir) => {
    // Pre-populate one file so we can verify rollback.
    await writeFile(join(implStateDir, 'baseline.json'), JSON.stringify({ stable: true }));

    const harness: Harness = {
      name: 'bad-actor-harness',
      version: '0.1.0',
      supports: () => true,
      async run(ctx) {
        // Deliberate violation: write a forbidden file.
        await writeFile(join(ctx.implStateDir, 'forbidden.txt'), 'should not persist');
        return stubSolution();
      },
    };

    const result = await runHarnessOnce({ harness, implStateDir, mode: 'frozen' });

    // Envelope must be absent.
    assert(result.envelope === undefined, 'violation: envelope must NOT be produced');

    // Violation metadata must be present and correct.
    assert(result.violation !== undefined, 'violation: violation object must be present');
    assert(
      result.violation.harnessName === 'bad-actor-harness',
      `violation: harnessName must be "bad-actor-harness", got "${result.violation.harnessName}"`,
    );
    assert(
      result.violation.stateHashBefore !== result.violation.stateHashAfter,
      'violation: stateHashBefore and stateHashAfter must differ',
    );

    // implStateDir must be rolled back: only baseline.json survives.
    const remaining = await readdir(implStateDir);
    assert(
      remaining.length === 1 && remaining[0] === 'baseline.json',
      `violation: rollback must restore only baseline.json; found [${remaining.join(', ')}]`,
    );

    process.stdout.write(
      `  violation detected: harnessName=${result.violation.harnessName} ` +
      `hashBefore=${result.violation.stateHashBefore.slice(0, 12)}… ` +
      `hashAfter=${result.violation.stateHashAfter.slice(0, 12)}…\n` +
      `  implStateDir rolled back: [${remaining.join(', ')}]\n`,
    );
  });
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const results = [];

  results.push(await runPhase(
    'freeze-mode / train mode: codeDigest mutates between Tasks',
    runTrainModeMutatesDigest,
  ));

  results.push(await runPhase(
    'freeze-mode / frozen mode: codeDigest stable across Tasks',
    runFrozenModeStableDigest,
  ));

  results.push(await runPhase(
    'freeze-mode / frozen mode: violation harness rejected + implStateDir rolled back',
    runFrozenModeViolationRejectedAndRolledBack,
  ));

  summarize(results);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
