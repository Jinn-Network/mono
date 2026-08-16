import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSlate } from '../../scripts/build-jinn-repo-pool.js';
import { loadHeldOutSlate } from '../../src/solver-types/_swe-rebench-v2-held-out-slate.js';

describe('buildSlate', () => {
  it('sorts instance ids and sets the jinn-repo solverType/version', () => {
    const slate = buildSlate(['Jinn-Network__mono-2', 'Jinn-Network__mono-1'], 'v1', '2026-06-08T00:00:00.000Z');
    expect(slate.instanceIds).toEqual(['Jinn-Network__mono-1', 'Jinn-Network__mono-2']);
    expect(slate.solverType).toBe('jinn-repo.v1');
    expect(slate.version).toBe('v1');
  });

  it('emits a slate the shipped loader accepts (hash matches)', () => {
    const slate = buildSlate(['Jinn-Network__mono-1', 'Jinn-Network__mono-2'], 'v1', '2026-06-08T00:00:00.000Z');
    const dir = mkdtempSync(join(tmpdir(), 'jinn-slate-'));
    mkdirSync(join(dir, 'slates'), { recursive: true });
    writeFileSync(join(dir, 'slates', 'held-out-slate.jinn-repo.v1.json'), JSON.stringify(slate, null, 2));
    // Must not throw — loader recomputes the hash and validates solverType/version.
    const loaded = loadHeldOutSlate('jinn-repo.v1', 'v1', { dir: join(dir, 'slates') });
    expect([...loaded.instanceIds]).toEqual(['Jinn-Network__mono-1', 'Jinn-Network__mono-2']);
  });
});
