import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ScreenProgressStore, screenSignature } from '../../src/eval/screen-progress.js';
import type { ScreenMeasurement } from '../../src/eval/screen.js';

const M: ScreenMeasurement = {
  gradeable: true, basePasses: 0, baseRuns: 3, baseUnscorable: false, proverRan: true, proverPassed: true,
};
const SIG = 'base=haiku|prover=claude-code:opus|R=3|sem=4';

describe('ScreenProgressStore', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'screen-progress-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('records and reloads measurements under the same signature', () => {
    const a = new ScreenProgressStore({ stateDir: dir, signature: SIG });
    expect(a.get('x')).toBeUndefined();
    a.record('x', M);
    expect(a.get('x')).toEqual(M);
    expect(a.size).toBe(1);
    // a fresh store with the SAME signature reloads the persisted measurement
    const b = new ScreenProgressStore({ stateDir: dir, signature: SIG });
    expect(b.get('x')).toEqual(M);
    expect(b.size).toBe(1);
  });

  it('discards the cache on signature mismatch (fresh start)', () => {
    new ScreenProgressStore({ stateDir: dir, signature: SIG }).record('x', M);
    // different config → different signature → cache must not be served
    const other = new ScreenProgressStore({ stateDir: dir, signature: 'base=haiku|prover=codex:gpt-5.5|R=5|sem=4' });
    expect(other.get('x')).toBeUndefined();
    expect(other.size).toBe(0);
  });

  it('screenSignature is stable + reflects each config field', () => {
    const base = { baseModel: 'haiku', proverHarness: 'claude-code', proverModel: 'opus', R: 3, evalSemanticsVersion: '4' };
    expect(screenSignature(base)).toBe(screenSignature({ ...base }));
    expect(screenSignature(base)).not.toBe(screenSignature({ ...base, R: 5 }));
    expect(screenSignature(base)).not.toBe(screenSignature({ ...base, proverModel: 'gpt-5.5' }));
  });
});
