/**
 * Integration tests: freeze-fence wired into engine dispatch.
 *
 * Verifies that `runHarnessOnce` (the thin fence+mode-propagation entry) returns:
 *   - An envelope with `executor.mode` matching the requested mode when the
 *     harness obeys the frozen-mode contract.
 *   - A `violation` result (no envelope) when the harness mutates implStateDir
 *     in frozen mode; and that the snapshot rollback restores the original state.
 *
 * Spec: docs/superpowers/specs/2026-05-06-agent-harness-solvernet-design.md §6.3
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runHarnessOnce } from '../../../src/harnesses/engine/engine.js';
import type { Harness, Solution } from '../../../src/harnesses/types.js';

// ── Minimal Solution stub ────────────────────────────────────────────────────

function stubSolution(overrides: Partial<Solution> = {}): Solution {
  return {
    venueRef: { name: 'test' },
    gating: {},
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('engine mode propagation', () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'engine-mode-test-'));
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  it('train mode produces an envelope with executor.mode = "train"', async () => {
    const harness: Harness = {
      name: 'test',
      version: '0.1.0',
      supports: () => true,
      async run(ctx) {
        // Train mode: harness is allowed to mutate implStateDir.
        await writeFile(join(ctx.implStateDir, 'state.txt'), 'mutated');
        return stubSolution();
      },
    };

    const result = await runHarnessOnce({
      harness,
      implStateDir: stateDir,
      mode: 'train',
    });

    expect(result.violation).toBeUndefined();
    expect(result.envelope?.executor.mode).toBe('train');
  });

  it('frozen mode + non-writing harness produces envelope with executor.mode = "frozen"', async () => {
    const harness: Harness = {
      name: 'test',
      version: '0.1.0',
      supports: () => true,
      async run() {
        // Frozen-compliant: no writes to implStateDir.
        return stubSolution();
      },
    };

    // Pre-populate stateDir so the hash is non-empty.
    await writeFile(join(stateDir, 'baseline.txt'), 'a');

    const result = await runHarnessOnce({
      harness,
      implStateDir: stateDir,
      mode: 'frozen',
    });

    expect(result.violation).toBeUndefined();
    expect(result.envelope?.executor.mode).toBe('frozen');
  });

  it('frozen mode + writing harness produces NO envelope (rejected) and rolls back implStateDir', async () => {
    const harness: Harness = {
      name: 'bad-actor',
      version: '0.1.0',
      supports: () => true,
      async run(ctx) {
        // Frozen violation: write a new file to implStateDir.
        await writeFile(join(ctx.implStateDir, 'forbidden.txt'), 'wrote');
        return stubSolution();
      },
    };

    // Pre-populate so the pre-hash is non-trivial.
    await writeFile(join(stateDir, 'baseline.txt'), 'a');

    const result = await runHarnessOnce({
      harness,
      implStateDir: stateDir,
      mode: 'frozen',
    });

    // Envelope must be absent.
    expect(result.envelope).toBeUndefined();

    // Violation must be populated.
    expect(result.violation).toBeDefined();
    expect(result.violation?.harnessName).toBe('bad-actor');

    // implStateDir must be rolled back: only the baseline file remains.
    const remaining = await readdir(stateDir);
    expect(remaining).toEqual(['baseline.txt']);
  });
});
