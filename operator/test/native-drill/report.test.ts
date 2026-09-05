import { describe, expect, it } from 'vitest';
import { PHASE_B_RESTART_CHECKPOINT_SET } from '../../src/daemon/phase-b-closure-manifest.js';
import { DRILL_CHECKPOINTS, DRILL_SPECS, drillSpec } from '../../src/native-drill/checkpoints.js';
import {
  buildDrillReport,
  parseDrillReport,
  sealDrillReport,
} from '../../src/native-drill/report.js';
import type { RunObservation } from '../../src/native-drill/observation.js';

function observation(overrides: Partial<RunObservation> = {}): RunObservation {
  return {
    checkpoint: 'posting',
    seed: 'B810',
    mode: 'uninterrupted',
    finalState: 'published',
    graphDigest: `sha256:${'1'.repeat(64)}`,
    operationIds: ['post:a:b'],
    transactionHashes: [`0x${'a'.repeat(64)}`],
    sourceHeads: [`sha256:${'2'.repeat(64)}`],
    effects: { posting: 1, signedSourceEntries: 1, duplicatePosts: 0 },
    invocations: { broadcast: 1, recover: 0 },
    stateBefore: 'draft not yet broadcast',
    stateAfter: 'one canonical posting transaction',
    ...overrides,
  };
}

function report() {
  return buildDrillReport({
    runId: 'B810-posting',
    createdAt: '2026-08-02T12:00:00.000Z',
    chain: { chainId: 84532, mode: 'hermetic' },
    boundary: {
      role: 'requester',
      injection: 'SIGKILL',
      description: 'after the wallet returns, before the hash is persisted',
      proof: 'zero duplicate posts',
    },
    uninterrupted: observation(),
    recovered: observation({ mode: 'recovered', invocations: { broadcast: 0, recover: 1 } }),
    comparison: { equal: true, differences: [] },
    requiredEffects: drillSpec('posting').requiredEffects,
  });
}

describe('restart-drill recovery report', () => {
  it('covers exactly the checkpoint set the closure manifest requires', () => {
    expect([...DRILL_CHECKPOINTS]).toEqual([...PHASE_B_RESTART_CHECKPOINT_SET]);
    expect(DRILL_SPECS.map(({ checkpoint }) => checkpoint)).toEqual([...PHASE_B_RESTART_CHECKPOINT_SET]);
    expect(new Set(DRILL_SPECS.map(({ seed }) => seed)).size).toBe(DRILL_SPECS.length);
  });

  it('seals to a stable digest and round-trips through its canonical encoding', () => {
    const sealed = report();
    expect(sealed.digest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(report().digest).toBe(sealed.digest);
    expect(parseDrillReport(sealed.bytes).digest).toBe(sealed.digest);
  });

  it('rejects a report that leaks a producer path', () => {
    const sealed = report();
    expect(() => sealDrillReport({
      ...sealed.report,
      uninterrupted: { ...sealed.report.uninterrupted, stateBefore: '/Users/operator/state' },
    })).toThrow(/private producer path/u);
  });

  it('rejects a non-canonical encoding of its own content', () => {
    const sealed = report();
    const reordered = Buffer.from(`${JSON.stringify(JSON.parse(Buffer.from(sealed.bytes).toString('utf8')), null, 2)}\n`);
    expect(() => parseDrillReport(reordered)).toThrow(/canonical producer encoding/u);
  });

  it('cannot represent a divergent pair as a report', () => {
    expect(() => buildDrillReport({
      runId: 'B810-posting',
      createdAt: '2026-08-02T12:00:00.000Z',
      chain: { chainId: 84532, mode: 'hermetic' },
      boundary: {
        role: 'requester', injection: 'SIGKILL', description: 'boundary', proof: 'proof',
      },
      uninterrupted: observation(),
      recovered: observation({ mode: 'recovered' }),
      comparison: { equal: false, differences: ['graphDigest differs'] },
      requiredEffects: {},
    })).toThrow(/diverged from the uninterrupted run/u);
  });

  it('refuses a pair that does not share one checkpoint and seed', () => {
    expect(() => buildDrillReport({
      runId: 'B810-posting',
      createdAt: '2026-08-02T12:00:00.000Z',
      chain: { chainId: 84532, mode: 'hermetic' },
      boundary: {
        role: 'requester', injection: 'SIGKILL', description: 'boundary', proof: 'proof',
      },
      uninterrupted: observation(),
      recovered: observation({ mode: 'recovered', seed: 'B811' }),
      comparison: { equal: true, differences: [] },
      requiredEffects: {},
    })).toThrow(/one checkpoint and seed/u);
  });

  it('records the pinned fork block so a fork run is re-runnable', () => {
    const sealed = buildDrillReport({
      runId: 'B810-posting',
      createdAt: '2026-08-02T12:00:00.000Z',
      chain: { chainId: 84532, mode: 'fork', forkBlockNumber: '31337000' },
      boundary: {
        role: 'requester', injection: 'SIGKILL', description: 'boundary', proof: 'proof',
      },
      uninterrupted: observation(),
      recovered: observation({ mode: 'recovered' }),
      comparison: { equal: true, differences: [] },
      requiredEffects: {},
    });
    expect(sealed.report.chain).toEqual({ chainId: 84532, mode: 'fork', forkBlockNumber: '31337000' });
  });
});
