import { describe, it, expect } from 'vitest';
import { repoOf, stratifyByRepo } from '../../src/eval/screen.js';
import type { PoolTask } from '../../src/solver-types/_swe-rebench-v2-pool.js';

const t = (instance_id: string): PoolTask => ({ instance_id }) as PoolTask;

describe('repoOf', () => {
  it('returns the org prefix before the first __', () => {
    expect(repoOf(t('tobymao__sqlglot-4661'))).toBe('tobymao');
    expect(repoOf(t('All-Hands-AI__OpenHands-11914'))).toBe('All-Hands-AI');
  });
});

describe('stratifyByRepo', () => {
  it('round-robins across repos, deterministic within and across groups', () => {
    const pool = [
      t('b__r-2'), t('a__r-3'), t('a__r-1'), t('b__r-1'), t('a__r-2'),
    ];
    // groups sorted by repo: a=[a__r-1,a__r-2,a__r-3], b=[b__r-1,b__r-2]
    // round-robin: a__r-1, b__r-1, a__r-2, b__r-2, a__r-3
    expect(stratifyByRepo(pool).map((x) => x.instance_id)).toEqual([
      'a__r-1', 'b__r-1', 'a__r-2', 'b__r-2', 'a__r-3',
    ]);
  });
});

import { screenBaseFailures, type ScreenDeps, type ScreenOpts, type ScreenMeasurement } from '../../src/eval/screen.js';

function deps(over: Partial<ScreenDeps>): ScreenDeps {
  return {
    ensureGradeable: async () => true,
    runBaseFrozen: async () => ({ passed: false }),
    runProverFrozen: async () => ({ passed: true }),
    ...over,
  };
}
const OPTS: ScreenOpts = { R: 3, heldOutCount: 10, maxCandidates: 100, perRepoCap: 10 };

describe('screenBaseFailures resumability (cache)', () => {
  it('replays a cached measurement without re-running gradeable/base/prover', async () => {
    let calls = 0;
    const cached: ScreenMeasurement = {
      gradeable: true, basePasses: 0, baseRuns: 3, baseUnscorable: false, proverRan: true, proverPassed: true,
    };
    const r = await screenBaseFailures([t('o__a-1')], deps({
      ensureGradeable: async () => { calls++; throw new Error('should not measure on cache hit'); },
      runBaseFrozen: async () => { calls++; return { passed: false }; },
      runProverFrozen: async () => { calls++; return { passed: true }; },
      getCachedMeasurement: () => cached,
    }), OPTS);
    expect(calls).toBe(0);
    expect(r.heldOut.map((h) => h.instance_id)).toEqual(['o__a-1']); // cached held-out replayed
  });

  it('records a freshly-measured candidate for resume', async () => {
    const recorded: Record<string, ScreenMeasurement> = {};
    await screenBaseFailures([t('o__a-1')], deps({
      getCachedMeasurement: () => undefined,
      recordMeasurement: (id, m) => { recorded[id] = m; },
    }), OPTS);
    expect(recorded['o__a-1']).toMatchObject({ gradeable: true, basePasses: 0, proverRan: true, proverPassed: true });
  });

  it('budget bounds only NEW measurements; cache hits are free', async () => {
    let measured = 0;
    const cache: Record<string, ScreenMeasurement> = {
      'o__a-1': { gradeable: true, basePasses: 1, baseRuns: 1, baseUnscorable: false, proverRan: false, proverPassed: null },
    };
    const r = await screenBaseFailures([t('o__a-1'), t('o__b-1'), t('o__c-1')], deps({
      runBaseFrozen: async () => { measured++; return { passed: true }; }, // base-passes
      getCachedMeasurement: (id) => cache[id],
    }), { ...OPTS, maxCandidates: 1 });
    // a-1 is cached (free); budget=1 allows one new measurement (b-1); c-1 hits budget → break.
    expect(measured).toBe(1);
    expect(r.screened.map((s) => s.instance_id)).toEqual(['o__a-1', 'o__b-1']);
  });
});

describe('screenBaseFailures', () => {
  it('admits gradeable × base-0/R × prover-pass; classifies the rest', async () => {
    const cands = [t('o__a-1'), t('o__b-1'), t('o__c-1'), t('o__d-1')];
    const r = await screenBaseFailures(cands, deps({
      ensureGradeable: async (x) => x.instance_id !== 'o__a-1',          // a: not gradeable
      runBaseFrozen: async (x) => ({ passed: x.instance_id === 'o__b-1' }), // b: base passes
      runProverFrozen: async (x) => ({ passed: x.instance_id === 'o__c-1' }), // c: prover passes, d: not
    }), OPTS);
    expect(r.heldOut.map((h) => h.instance_id)).toEqual(['o__c-1']);
    const byId = Object.fromEntries(r.screened.map((s) => [s.instance_id, s.reason]));
    expect(byId).toEqual({
      'o__a-1': 'not-gradeable', 'o__b-1': 'base-passes',
      'o__c-1': 'held-out', 'o__d-1': 'no-headroom',
    });
  });

  it('excludes a base-unscorable task (never coerces to fail)', async () => {
    const r = await screenBaseFailures([t('o__a-1')], deps({
      runBaseFrozen: async () => ({ passed: null }),
    }), OPTS);
    expect(r.heldOut).toHaveLength(0);
    expect(r.screened[0]!.reason).toBe('base-unscorable');
  });

  it('honors the per-repo cap', async () => {
    const r = await screenBaseFailures([t('o__a-1'), t('o__a-2')], deps({}), { ...OPTS, perRepoCap: 1 });
    expect(r.heldOut.map((h) => h.instance_id)).toEqual(['o__a-1']);
    expect(r.screened.find((s) => s.instance_id === 'o__a-2')!.reason).toBe('per-repo-cap');
  });

  it('stops at the held-out cap', async () => {
    const r = await screenBaseFailures([t('o__a-1'), t('o__b-1')], deps({}), { ...OPTS, heldOutCount: 1 });
    expect(r.heldOut).toHaveLength(1);
    expect(r.screened).toHaveLength(1); // loop breaks once the cap is full
  });

  it('runs base exactly R times and stops early on a base pass', async () => {
    let runs = 0;
    await screenBaseFailures([t('o__a-1')], deps({
      runBaseFrozen: async () => { runs++; return { passed: true }; },
    }), { ...OPTS, R: 3 });
    expect(runs).toBe(1); // first pass ⇒ not a reliable fail ⇒ stop
  });
});

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildV2SlateFile } from '../../src/eval/screen.js';
import { loadHeldOutSlate } from '../../src/solver-types/_swe-rebench-v2-held-out-slate.js';

describe('buildV2SlateFile', () => {
  it('builds a v2 slate that loadHeldOutSlate accepts with a matching hash', () => {
    const file = buildV2SlateFile(['o__b-2', 'o__a-1'], '2026-06-03T00:00:00.000Z');
    expect(file.version).toBe('v2');
    expect(file.solverType).toBe('swe-rebench-v2.v1');
    expect(file.instanceIds).toEqual(['o__a-1', 'o__b-2']); // sorted
    const dir = mkdtempSync(join(tmpdir(), 'slate-test-'));
    try {
      writeFileSync(join(dir, 'held-out-slate.swe-rebench-v2.v2.json'), JSON.stringify(file));
      const loaded = loadHeldOutSlate('swe-rebench-v2.v1', 'v2', { dir });
      expect(loaded.hash).toBe(file.hash);
      expect([...loaded.instanceIds].sort()).toEqual(['o__a-1', 'o__b-2']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
