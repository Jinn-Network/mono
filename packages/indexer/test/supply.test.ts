import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildCurrentSupply, completedSupplyWindow, resolveSupplyChainId } from '../src/api/supply.js';
import { BASE_SEPOLIA_CHAIN_ID, indexedChainIds } from '../src/chain-config.js';

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
    manifestEvidenceComplete: true,
    activityEvidenceComplete: true,
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
      verdictDeliveries: 2,
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
    expect(result.classes[0]?.verdictDeliveries).toBe(1);
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
      status: 'zero_supply',
      reason: 'no_recent_completed_loops',
      classes: [],
    });
  });

  it('counts an in-window verdict whose attempt predates the window as a closed loop', () => {
    // A long-running task claimed before the window and delivered inside it is
    // ordinary, not corrupt. It must not black out the chain's whole answer —
    // and it must not, by itself, make the class look live either: the class
    // still needs a claiming operator inside the window.
    const oldAttempt = attempt({
      taskId: '9',
      attemptIndex: 3,
      operator: `0x${'cc'.repeat(20)}`,
      createdAtTimestamp: BigInt(AS_OF / 1000) - BigInt(50 * HOUR),
    });
    const result = build({
      tasks: [task(), task({ id: '9' })],
      attempts: [attempt(), oldAttempt],
      verdicts: [verdict(), verdict({ taskId: '9', attemptIndex: 3 })],
    });
    expect(result.status).toBe('available');
    expect(result.classes).toHaveLength(1);
    expect(result.classes[0]).toMatchObject({
      workClass: 'prediction.v1',
      claimingOperators: 1,
      verdictDeliveries: 2,
    });
  });

  it('still reads a verdict with no attempt row at all as broken evidence', () => {
    expect(build({ verdicts: [verdict({ attemptIndex: 9 })] }).status).toBe('unknown');
  });

  it('does not read a degraded empty-role manifest as an absent requestable class', () => {
    // `parseSolverNetManifestLite` degrades an unusable `roles` to `[]` while
    // still writing manifestEnrichmentStatus 'ok'. Filtering that row out
    // before the completeness check turned missing evidence into a false zero.
    expect(build({ manifests: [manifest({ openRoles: [] })] })).toMatchObject({
      status: 'unknown',
      reason: 'incomplete_indexer_evidence',
    });
  });

  it('answers an unrenderable clock as unknown rather than throwing', () => {
    for (const asOfMs of [Number.NaN, Number.POSITIVE_INFINITY, 8.7e15]) {
      const result = buildCurrentSupply({
        chainId: CHAIN_ID,
        asOfMs,
        manifestEvidenceComplete: true,
        activityEvidenceComplete: true,
        manifests: [manifest()],
        tasks: [task()],
        attempts: [attempt()],
        verdicts: [verdict()],
      });
      expect(result.status).toBe('unknown');
    }
  });

  it('reports no requestable SolverNets without requiring unrelated activity evidence', () => {
    expect(build({
      activityEvidenceComplete: false,
      manifests: [manifest({ openRoles: ['evaluator'] })],
      attempts: [attempt({ createdAtTimestamp: 0n })],
      verdicts: [verdict({ createdAtTimestamp: 0n })],
    })).toMatchObject({
      status: 'zero_supply',
      reason: 'no_requestable_solver_nets',
      classes: [],
    });
  });

  it('does not turn incomplete activity evidence into zero when a SolverNet is requestable', () => {
    expect(build({ activityEvidenceComplete: false })).toMatchObject({
      status: 'unknown',
      reason: 'incomplete_indexer_evidence',
      classes: [],
    });
  });

  it('does not infer no requestable SolverNets from an incomplete manifest read', () => {
    expect(build({
      manifestEvidenceComplete: false,
      manifests: [manifest({ openRoles: ['evaluator'] })],
    })).toMatchObject({
      status: 'unknown',
      reason: 'incomplete_indexer_evidence',
      classes: [],
    });
  });

  it.each([
    ['launched manifest enrichment is incomplete', { manifests: [manifest({ manifestEnrichmentStatus: 'pending' })] }],
    ['a relevant timestamp is missing', { attempts: [attempt({ createdAtTimestamp: 0n })] }],
    ['an attempt is orphaned', { attempts: [attempt({ taskId: '404' })] }],
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
    expect(route.match(/\.limit\(/gu)).toHaveLength(7);
    // The attempts referenced by in-window verdicts are fetched WITHOUT the
    // window filter, so a long loop cannot look like a broken join.
    expect(route).toContain('inArray(attempt.taskId, verdictTaskIds)');
    expect(route).toContain('attempt.createdAtTimestamp} >= ${windowStart}');
    expect(route).toContain('attempt.createdAtTimestamp} < ${windowEnd}');
    expect(route).toContain('verdict.createdAtTimestamp} >= ${windowStart}');
    expect(route).toContain('verdict.createdAtTimestamp} < ${windowEnd}');
  });
});

describe('served chain set', () => {
  it('serves only Base Sepolia by default, so an unindexed chain is refused rather than answered', () => {
    // Without this, GET /supply?chainId=8453 reads an empty table and returns a
    // confident `zero_supply` for a chain nothing has ever been indexed for —
    // total absence of evidence rendered as an authoritative negative.
    expect(indexedChainIds({} as NodeJS.ProcessEnv)).toEqual([BASE_SEPOLIA_CHAIN_ID]);
    expect(indexedChainIds({} as NodeJS.ProcessEnv)).not.toContain(8453);
  });

  it('follows hermetic snapshot mode onto its own chain', () => {
    expect(indexedChainIds({
      JINN_INDEXER_SNAPSHOT_ROUTER: '0xrouter',
      JINN_INDEXER_SNAPSHOT_CHAIN_ID: '31337',
    } as NodeJS.ProcessEnv)).toEqual([31337]);
    expect(indexedChainIds({
      JINN_INDEXER_SNAPSHOT_ROUTER: '0xrouter',
    } as NodeJS.ProcessEnv)).toEqual([8453]);
  });

  it('refuses an unserved chain by name instead of answering it', () => {
    expect(resolveSupplyChainId('8453', [BASE_SEPOLIA_CHAIN_ID])).toEqual({
      ok: false,
      error: 'unsupported chainId',
      detail: 'this indexer serves 84532; it has no evidence about 8453',
    });
    expect(resolveSupplyChainId('84532', [BASE_SEPOLIA_CHAIN_ID]))
      .toEqual({ ok: true, chainId: BASE_SEPOLIA_CHAIN_ID });
  });

  it.each([undefined, '', '   ', 'abc', '0', '-1', '1.5', 'Infinity', '9007199254740993'])(
    'refuses %o as a chain id before touching the database',
    (raw) => {
      expect(resolveSupplyChainId(raw, [BASE_SEPOLIA_CHAIN_ID])).toMatchObject({
        ok: false,
        error: 'invalid chainId',
      });
    },
  );

  it('is the guard the route actually applies', () => {
    const source = readFileSync(new URL('../src/api/index.ts', import.meta.url), 'utf8');
    const route = source.slice(
      source.indexOf('// \u2500\u2500 GET /supply'),
      source.indexOf('// \u2500\u2500 Shared ebu7-schema probe'),
    );
    expect(route).toContain("resolveSupplyChainId(c.req.query('chainId'), indexedChainIds())");
  });
});
