import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describeSweRebenchV2PoolFreshness } from '../../src/cli/commands/solver-nets.js';
import { EVAL_SEMANTICS_VERSION } from '../../src/solver-types/_swe-rebench-v2-validated-pool.js';

const tmps: string[] = [];
function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'doctor-pool-freshness-'));
  tmps.push(d);
  return d;
}
afterAll(() => {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('describeSweRebenchV2PoolFreshness', () => {
  it('reports "stale" when the file is absent', async () => {
    const dir = tmpDir();
    const r = await describeSweRebenchV2PoolFreshness({ stateDir: dir });
    expect(r.status).toBe('stale');
    expect(r.reason).toMatch(/absent/);
  });

  it('reports "stale" when the file has a different semantics version', async () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'validated-pool.json'), JSON.stringify({
      schemaVersion: 'swe-rebench-v2-validated-pool.v1',
      evalSemanticsVersion: 'OLD',
      updatedAt: '2026-01-01T00:00:00Z',
      entries: {},
    }));
    const r = await describeSweRebenchV2PoolFreshness({ stateDir: dir });
    expect(r.status).toBe('stale');
    expect(r.reason).toMatch(/OLD/);
  });

  it('reports "ready" with counts when the file is current', async () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'validated-pool.json'), JSON.stringify({
      schemaVersion: 'swe-rebench-v2-validated-pool.v1',
      evalSemanticsVersion: EVAL_SEMANTICS_VERSION,
      updatedAt: '2026-05-14T00:00:00Z',
      entries: {
        'a__1': { scorable: true, reason: 'ok', checkedAt: 'now' },
        'a__2': { scorable: false, reason: 'nope', checkedAt: 'now' },
      },
    }));
    const r = await describeSweRebenchV2PoolFreshness({ stateDir: dir });
    expect(r.status).toBe('ready');
    expect(r.scorable).toBe(1);
    expect(r.unscorable).toBe(1);
  });
});
