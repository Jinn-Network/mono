import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildCurrentSupply, completedSupplyWindow } from '../src/api/supply.js';

const CHAIN_ID = 84532;
const AS_OF = Date.parse('2026-09-06T13:47:00.000Z');
const HOUR = 60 * 60;

const manifest = (overrides: Record<string, unknown> = {}) => ({
  id: 'bafy-prediction',
  cidKeccak: `0x${'11'.repeat(32)}`,
  status: 'launched',
  chainId: CHAIN_ID,
  openRoles: ['solver'],
  contractId: 'prediction',
  contractVersion: 'v1',
  manifestEnrichmentStatus: 'ok',
  ...overrides,
});

const task = (overrides: Record<string, unknown> = {}) => ({
  id: '7',
  manifestDigest: `0x${'11'.repeat(32)}`,
  chainId: CHAIN_ID,
  ...overrides,
});

const attempt = (overrides: Record<string, unknown> = {}) => ({
  taskId: '7',
  attemptIndex: 0,
  operator: `0x${'aa'.repeat(20)}`,
  chainId: CHAIN_ID,
  createdAtTimestamp: BigInt(Date.parse('2026-09-06T10:00:00.000Z') / 1000),
  ...overrides,
});

const verdict = (overrides: Record<string, unknown> = {}) => ({
  taskId: '7',
  attemptIndex: 0,
  verdictIndex: 0,
  verdictCode: 2,
  chainId: CHAIN_ID,
  createdAtTimestamp: BigInt(Date.parse('2026-09-06T11:00:00.000Z') / 1000),
  ...overrides,
});

function build(overrides: Partial<Parameters<typeof buildCurrentSupply>[0]> = {}) {
  return buildCurrentSupply({
    chainId: CHAIN_ID,
    asOfMs: AS_OF,
    evidenceComplete: true,
    manifests: [manifest()],
    tasks: [task()],
    attempts: [attempt()],
    verdicts: [verdict()],
    ...overrides,
  });
}

describe('completedSupplyWindow', () => {
  it('returns the eight most recent completed six-hour UTC buckets', () => {
    const window = completedSupplyWindow(AS_OF);
    expect(window.start).toBe('2026-09-04T12:00:00.000Z');
    expect(window.end).toBe('2026-09-06T12:00:00.000Z');
    expect(window.bucketHours).toBe(6);
    expect(window.buckets).toHaveLength(8);
    expect(window.buckets[0]).toEqual({
      start: '2026-09-04T12:00:00.000Z',
      end: '2026-09-04T18:00:00.000Z',
    });
    expect(window.buckets[7]).toEqual({
      start: '2026-09-06T06:00:00.000Z',
      end: '2026-09-06T12:00:00.000Z',
    });
  });
});

describe('buildCurrentSupply', () => {
  it('reports requestable work classes backed by recent operators and completed-loop verdicts', () => {
    const result = build({
      manifests: [manifest(), manifest({ id: 'bafy-prediction-2', cidKeccak: `0x${'22'.repeat(32)}` })],
      tasks: [task(), task({ id: '8', manifestDigest: `0x${'22'.repeat(32)}` })],
      attempts: [attempt(), attempt({ taskId: '8', operator: `0x${'AA'.repeat(20)}` })],
      verdicts: [verdict({ verdictCode: 0 }), verdict({ taskId: '8', verdictCode: 4 })],
    });

    expect(result.status).toBe('available');
    expect(result.classes).toEqual([{
      workClass: 'prediction.v1',
      contractId: 'prediction',
      contractVersion: 'v1',
      acceptingSolverNets: 2,
      claimingOperators: 1,
      verifiedDeliveries: 2,
      latestAttemptAt: '2026-09-06T10:00:00.000Z',
      latestVerdictAt: '2026-09-06T11:00:00.000Z',
    }]);
  });

  it('uses a start-inclusive, end-exclusive completed window', () => {
    const start = BigInt(Date.parse('2026-09-04T12:00:00.000Z') / 1000);
    const end = BigInt(Date.parse('2026-09-06T12:00:00.000Z') / 1000);
    const result = build({
      attempts: [attempt({ createdAtTimestamp: start })],
      verdicts: [verdict({ createdAtTimestamp: end - 1n }), verdict({ verdictIndex: 1, createdAtTimestamp: end })],
    });
    expect(result.status).toBe('available');
    expect(result.classes[0]?.verifiedDeliveries).toBe(1);
  });

  it('excludes evaluator-only and non-launched SolverNets', () => {
    const result = build({
      manifests: [manifest({ openRoles: ['evaluator'] }), manifest({ id: 'bafy-paused', status: 'paused' })],
    });
    expect(result).toMatchObject({
      status: 'zero_supply',
      reason: 'no_requestable_solver_nets',
      classes: [],
    });
  });

  it('reports proven zero when complete requestable classes have no recent completed loops', () => {
    const result = build({
      attempts: [attempt({ createdAtTimestamp: BigInt(AS_OF / 1000) - BigInt(50 * HOUR) })],
      verdicts: [verdict({ createdAtTimestamp: BigInt(AS_OF / 1000) - BigInt(50 * HOUR) })],
    });
    expect(result).toMatchObject({
      status: 'zero_supply',
      reason: 'no_recent_completed_loops',
      classes: [],
    });
  });

  it('does not let a recent verdict make an old attempt look recently active', () => {
    const result = build({
      attempts: [attempt({ createdAtTimestamp: BigInt(AS_OF / 1000) - BigInt(50 * HOUR) })],
      verdicts: [verdict()],
    });
    expect(result).toMatchObject({
      status: 'unknown',
      reason: 'incomplete_indexer_evidence',
      classes: [],
    });
  });

  it('does not turn a capped or otherwise incomplete evidence read into zero supply', () => {
    expect(build({ evidenceComplete: false })).toMatchObject({
      status: 'unknown',
      reason: 'incomplete_indexer_evidence',
      classes: [],
    });
  });

  it.each([
    ['launched manifest enrichment is incomplete', { manifests: [manifest({ manifestEnrichmentStatus: 'pending' })] }],
    ['a relevant timestamp is missing', { attempts: [attempt({ createdAtTimestamp: 0n })] }],
    ['an attempt is orphaned', { attempts: [attempt({ taskId: '404' })] }],
    ['a verdict is orphaned by attempt index', { verdicts: [verdict({ attemptIndex: 9 })] }],
    ['a cross-chain attempt cannot join', { attempts: [attempt({ chainId: 8453 })] }],
  ])('preserves uncertainty when %s', (_label, overrides) => {
    expect(build(overrides).status).toBe('unknown');
  });

  it('orders classes deterministically', () => {
    const other = manifest({
      id: 'bafy-aave',
      cidKeccak: `0x${'22'.repeat(32)}`,
      contractId: 'aave',
      contractVersion: 'v3',
    });
    const result = build({
      manifests: [manifest(), other],
      tasks: [task(), task({ id: '8', manifestDigest: other.cidKeccak })],
      attempts: [attempt(), attempt({ taskId: '8', attemptIndex: 1 })],
      verdicts: [verdict(), verdict({ taskId: '8', attemptIndex: 1 })],
    });
    expect(result.classes.map((entry) => entry.workClass)).toEqual(['aave.v3', 'prediction.v1']);
  });
});

describe('GET /supply evidence reads', () => {
  it('bounds every result set and time-scopes activity at the database', () => {
    const source = readFileSync(new URL('../src/api/index.ts', import.meta.url), 'utf8');
    const route = source.slice(
      source.indexOf('// ── GET /supply'),
      source.indexOf('// ── Shared ebu7-schema probe'),
    );
    expect(route.match(/\.limit\(/gu)).toHaveLength(6);
    expect(route).toContain('attempt.createdAtTimestamp} >= ${windowStart}');
    expect(route).toContain('attempt.createdAtTimestamp} < ${windowEnd}');
    expect(route).toContain('verdict.createdAtTimestamp} >= ${windowStart}');
    expect(route).toContain('verdict.createdAtTimestamp} < ${windowEnd}');
  });
});
