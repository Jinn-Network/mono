/**
 * The shared native assembly helpers (one-swap M2, umbrella #2461).
 *
 * These bodies were extracted verbatim from `native-solver-production.ts` so the fleet daemon's
 * native composition and the retiring native solver host build the same graph. Behaviour was
 * previously covered only indirectly, through the solver host; these tests pin it directly so a
 * later edit to the shared copy cannot quietly change either caller.
 */
import { describe, expect, it } from 'vitest';
import { documentDigest } from '@jinn-network/task-execution-protocol';
import {
  address,
  buildNativeClaimPolicy,
  buildNativeEvaluationSpecResolver,
  buildNativeExactDocuments,
  chain,
  closeAll,
  digest,
  hash,
  object,
  nonterminal,
  uint,
} from '../../src/daemon/native-assembly.js';

const CHAIN_CONFIG = {
  chainId: 84532,
  generation: 'today' as const,
  contracts: {
    taskCoordinator: '0x8a34793e10595c89B7e41Cc7Ff0F76850F44AD98',
    jinnRouter: '0x1111111111111111111111111111111111111111',
    mechMarketplace: '0x2222222222222222222222222222222222222222',
    activityChecker: '0x3333333333333333333333333333333333333333',
  },
};

describe('native assembly field readers', () => {
  it('accepts canonical values and refuses everything else with the caller label', () => {
    expect(object({ a: 1 }, 'facts')).toEqual({ a: 1 });
    expect(() => object([], 'facts')).toThrow('facts is not an object');
    expect(() => object(null, 'facts')).toThrow('facts is not an object');

    const good = `sha256:${'a'.repeat(64)}`;
    expect(digest(good, 'taskDigest')).toBe(good);
    expect(() => digest(`sha256:${'A'.repeat(64)}`, 'taskDigest')).toThrow(
      'taskDigest is not a canonical sha256 digest',
    );

    expect(address('0x8a34793e10595c89B7e41Cc7Ff0F76850F44AD98', 'coordinator'))
      .toBe('0x8a34793e10595c89B7e41Cc7Ff0F76850F44AD98');
    expect(() => address('0x1234', 'coordinator')).toThrow('coordinator is not an EVM address');

    expect(hash(`0x${'b'.repeat(64)}`, 'txHash')).toBe(`0x${'b'.repeat(64)}`);
    expect(() => hash(`0x${'b'.repeat(63)}`, 'txHash')).toThrow('txHash is not a 32-byte hash');

    expect(uint('0', 'taskId')).toBe(0n);
    expect(uint('12345678901234567890', 'taskId')).toBe(12345678901234567890n);
    // Leading zeroes are not canonical -- two spellings of one integer would be two identities.
    expect(() => uint('007', 'taskId')).toThrow('taskId is not a canonical unsigned integer');
    expect(() => uint(7, 'taskId')).toThrow('taskId is not a canonical unsigned integer');
  });
});

describe('chain', () => {
  it('projects structured chain identity without renaming or lowercasing anything', () => {
    expect(chain(CHAIN_CONFIG)).toEqual({
      chainId: 84532,
      generation: 'today',
      taskCoordinator: CHAIN_CONFIG.contracts.taskCoordinator,
      jinnRouter: CHAIN_CONFIG.contracts.jinnRouter,
      mechMarketplace: CHAIN_CONFIG.contracts.mechMarketplace,
      activityChecker: CHAIN_CONFIG.contracts.activityChecker,
    });
  });
});

describe('nonterminal', () => {
  it('counts only states that still owe work', () => {
    for (const state of ['discovered', 'eligible', 'claimed', 'executing', 'delivered']) {
      expect(nonterminal(state)).toBe(true);
    }
    for (const state of ['solution-settled', 'lost', 'failed']) {
      expect(nonterminal(state)).toBe(false);
    }
  });
});

describe('closeAll', () => {
  it('runs every action once, even when earlier ones throw, and aggregates the failures', async () => {
    const calls: string[] = [];
    const close = closeAll([
      () => { calls.push('a'); throw new Error('boom-a'); },
      async () => { calls.push('b'); },
      () => { calls.push('c'); throw new Error('boom-c'); },
    ]);
    await expect(close()).rejects.toThrow('native solver cleanup failed');
    expect(calls).toEqual(['a', 'b', 'c']);

    // Idempotent: a second close is a no-op and does not re-throw.
    await expect(close()).resolves.toBeUndefined();
    expect(calls).toEqual(['a', 'b', 'c']);
  });
});

describe('buildNativeExactDocuments', () => {
  const taskBytes = new TextEncoder().encode('{"kind":"task"}');
  const submissionBytes = new TextEncoder().encode('{"kind":"submission"}');
  const taskDigest = documentDigest(taskBytes);
  const submissionDigest = documentDigest(submissionBytes);

  it('returns the exact bytes when both digests hold', async () => {
    const resolve = buildNativeExactDocuments({
      byDigest: async (want) => (want === taskDigest ? taskBytes : submissionBytes),
    });
    await expect(resolve({ taskDigest, submissionDigest })).resolves.toEqual({
      taskBytes, submissionBytes,
    });
  });

  it('refuses bytes whose digest changed in transit', async () => {
    const resolve = buildNativeExactDocuments({
      byDigest: async () => new TextEncoder().encode('{"kind":"substituted"}'),
    });
    await expect(resolve({ taskDigest, submissionDigest })).rejects.toThrow(
      'native exact Task/Submission retrieval changed digest',
    );
  });
});

describe('buildNativeEvaluationSpecResolver', () => {
  const bytes = new TextEncoder().encode('{"kind":"evaluation-spec"}');
  const specDigest = documentDigest(bytes);

  it('returns bytes on an exact digest match', async () => {
    const resolve = buildNativeEvaluationSpecResolver({ byDigest: async () => bytes });
    await expect(resolve(specDigest)).resolves.toEqual(bytes);
  });

  it('returns undefined -- never a substitute -- on mismatch or transport failure', async () => {
    const mismatched = buildNativeEvaluationSpecResolver({
      byDigest: async () => new TextEncoder().encode('{"kind":"other"}'),
    });
    await expect(mismatched(specDigest)).resolves.toBeUndefined();

    const failing = buildNativeEvaluationSpecResolver({
      byDigest: async () => { throw new Error('gateway down'); },
    });
    await expect(failing(specDigest)).resolves.toBeUndefined();
  });
});

describe('buildNativeClaimPolicy', () => {
  it('carries the operator escrow cap and the fixed tier-4 admission bounds', () => {
    expect(buildNativeClaimPolicy({ ...CHAIN_CONFIG, transactionCaps: { escrowMaxWei: '1000' } }))
      .toEqual({
        chainId: 84532,
        coordinator: CHAIN_CONFIG.contracts.taskCoordinator,
        generation: 'today',
        maxSpendWei: 1000n,
        minDeadlineLeadMs: 300_000,
        maxConcurrent: 1,
      });
  });
});
