import { describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertReevalTasksFresh, recordAnnexDerivation } from '../../src/skills-bench/reeval-guard.js';

describe('reeval guard', () => {
  it('allows first re-eval, blocks overlap with burned tasks, listing the overlap', async () => {
    const ledger = join(await mkdtemp(join(tmpdir(), 'reeval-')), 'reeval-ledger.json');
    await assertReevalTasksFresh(ledger, { skill: 'tdd', taskIds: ['t1', 't2'] }); // ok (no ledger yet)
    await recordAnnexDerivation(ledger, {
      skill: 'tdd', skillSha: 'sha-v1', runDir: '/runs/tdd-pilot', taskIds: ['t1', 't2', 't3'], at: '2026-08-01T00:00:00Z',
    });
    await expect(assertReevalTasksFresh(ledger, { skill: 'tdd', taskIds: ['t2', 't9'] }))
      .rejects.toThrow(/t2/);
    await assertReevalTasksFresh(ledger, { skill: 'tdd', taskIds: ['t4', 't5'] }); // fresh tasks ok
  });

  it('scopes burns to the skill lineage — other skills are unaffected', async () => {
    const ledger = join(await mkdtemp(join(tmpdir(), 'reeval-')), 'reeval-ledger.json');
    await recordAnnexDerivation(ledger, {
      skill: 'tdd', skillSha: 'sha-v1', runDir: '/runs/tdd-pilot', taskIds: ['t1'], at: '2026-08-01T00:00:00Z',
    });
    await assertReevalTasksFresh(ledger, { skill: 'grill-me', taskIds: ['t1'] }); // same task id, different skill: ok
  });

  it('unions burns across every recorded sha for the same skill lineage', async () => {
    const ledger = join(await mkdtemp(join(tmpdir(), 'reeval-')), 'reeval-ledger.json');
    await recordAnnexDerivation(ledger, {
      skill: 'tdd', skillSha: 'sha-v1', runDir: '/runs/r1', taskIds: ['t1'], at: '2026-08-01T00:00:00Z',
    });
    await recordAnnexDerivation(ledger, {
      skill: 'tdd', skillSha: 'sha-v2', runDir: '/runs/r2', taskIds: ['t2'], at: '2026-08-05T00:00:00Z',
    });
    // A third revision (sha-v3) must avoid tasks burned by EITHER prior annex.
    await expect(assertReevalTasksFresh(ledger, { skill: 'tdd', taskIds: ['t1'] })).rejects.toThrow(/already burned/);
    await expect(assertReevalTasksFresh(ledger, { skill: 'tdd', taskIds: ['t2'] })).rejects.toThrow(/already burned/);
    await assertReevalTasksFresh(ledger, { skill: 'tdd', taskIds: ['t3'] }); // never burned: ok
  });

  it('a missing ledger file behaves as an empty ledger (first evaluation ever)', async () => {
    const ledger = join(await mkdtemp(join(tmpdir(), 'reeval-')), 'does-not-exist.json');
    await assertReevalTasksFresh(ledger, { skill: 'tdd', taskIds: ['t1', 't2'] });
  });
});
