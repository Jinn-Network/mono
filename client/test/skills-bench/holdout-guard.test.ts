import { describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertHoldoutUnused, recordHoldoutRun } from '../../src/skills-bench/holdout-guard.js';

describe('holdout guard', () => {
  it('allows first use, blocks second, scopes by candidate', async () => {
    const ledger = join(await mkdtemp(join(tmpdir(), 'ho-')), 'holdout-ledger.json');
    await assertHoldoutUnused(ledger, 'tdd-fork-v3');                      // ok (no ledger yet)
    await recordHoldoutRun(ledger, { candidateId: 'tdd-fork-v3', runDir: '/runs/x', at: '2026-08-01T00:00:00Z' });
    await expect(assertHoldoutUnused(ledger, 'tdd-fork-v3')).rejects.toThrow(/already consumed/);
    await assertHoldoutUnused(ledger, 'tdd-fork-v4');                      // other candidate ok
  });
});
