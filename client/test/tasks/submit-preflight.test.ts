import { describe, expect, it, vi } from 'vitest';
import {
  MarketplaceTaskSubmitPreflightError,
  runMarketplaceTaskSubmitPreflight,
  type MarketplaceTaskSubmitPreflightCheck,
  selectMarketplaceTaskSolverNet,
  assertMarketplaceTaskFunding,
  assertMarketplaceTaskRequestFreshness,
  MARKETPLACE_TASK_FRESHNESS_RESERVE_MS,
  MarketplaceTaskRequestExpiredError,
} from '../../src/tasks/submit-preflight.js';

const categories = [
  'creator',
  'funds',
  'contracts',
  'solverNet',
  'indexer',
  'gateway',
  'rpc',
] as const;

describe('runMarketplaceTaskSubmitPreflight', () => {
  it.each(categories)('fails closed when the %s dependency is unavailable', async (failed) => {
    const checks = Object.fromEntries(categories.map((category) => [
      category,
      vi.fn(async () => {
        if (category === failed) throw new Error(`${category} unavailable`);
      }),
    ])) as Record<typeof categories[number], MarketplaceTaskSubmitPreflightCheck>;

    await expect(runMarketplaceTaskSubmitPreflight(checks))
      .rejects.toEqual(expect.objectContaining({
        name: 'MarketplaceTaskSubmitPreflightError',
        category: failed,
      }));
  });

  it('runs every dependency check without mutation hooks', async () => {
    const checks = Object.fromEntries(categories.map((category) => [
      category,
      vi.fn(async () => undefined),
    ])) as Record<typeof categories[number], MarketplaceTaskSubmitPreflightCheck>;

    await runMarketplaceTaskSubmitPreflight(checks);

    for (const category of categories) expect(checks[category]).toHaveBeenCalledOnce();
    expect(MarketplaceTaskSubmitPreflightError).toBeTypeOf('function');
  });
});

describe('selectMarketplaceTaskSolverNet', () => {
  const compatible = (manifestCid: string, name = manifestCid) => ({
    manifestCid,
    name,
    status: 'launched' as const,
    contractId: 'jinn-repo',
    contractVersion: 'v1',
  });

  it('auto-selects the unique live jinn-repo.v1 SolverNet when selection is omitted', () => {
    expect(selectMarketplaceTaskSolverNet({
      summaries: [compatible('bafy-unique'), {
        ...compatible('bafy-other'),
        contractId: 'prediction',
      }],
    })).toBe('bafy-unique');
  });

  it.each([
    ['zero', []],
    ['multiple', [compatible('bafy-a'), compatible('bafy-b')]],
  ])('requires an explicit manifest when %s compatible SolverNets are live', (_label, summaries) => {
    expect(() => selectMarketplaceTaskSolverNet({ summaries }))
      .toThrow(/explicit solverNetManifestCid/i);
  });

  it('verifies an explicit manifest is live and compatible', () => {
    expect(selectMarketplaceTaskSolverNet({
      explicitManifestCid: 'bafy-target',
      summaries: [compatible('bafy-target'), compatible('bafy-other')],
    })).toBe('bafy-target');
    expect(() => selectMarketplaceTaskSolverNet({
      explicitManifestCid: 'bafy-paused',
      summaries: [{ ...compatible('bafy-paused'), status: 'paused' }],
    })).toThrow(/not a live jinn-repo.v1/i);
  });

  it('resolves a public indexer name without a locally joined display name', () => {
    expect(selectMarketplaceTaskSolverNet({
      requestedName: 'Autopilot production',
      summaries: [compatible('bafy-public', 'Autopilot production')],
    })).toBe('bafy-public');
  });
});

describe('assertMarketplaceTaskFunding', () => {
  const funding = (agentBalanceWei: bigint) => ({
    safeBalanceWei: 20n,
    agentBalanceWei,
    solutionMaxDeliveryRateWei: 5n,
    verdictMaxDeliveryRateWei: 5n,
    maxClaims: 1,
    agentGasReserveWei: 7n,
  });

  it('rejects a one-wei EOA and an EOA funded for task value but not gas', () => {
    expect(() => assertMarketplaceTaskFunding(funding(1n))).toThrow(/agent EOA/i);
    expect(() => assertMarketplaceTaskFunding(funding(10n))).toThrow(/gas reserve/i);
  });

  it('accepts Safe task budget plus EOA task value and conservative gas reserve', () => {
    expect(() => assertMarketplaceTaskFunding(funding(17n))).not.toThrow();
  });

  it('retains the independent creator Safe task-budget gate', () => {
    expect(() => assertMarketplaceTaskFunding({
      ...funding(17n),
      safeBalanceWei: 9n,
    })).toThrow(/creator Safe/i);
  });
});

describe('assertMarketplaceTaskRequestFreshness', () => {
  const nowMs = Date.parse('2026-07-24T00:00:00.000Z');
  const liveAt = nowMs + 60_000 + 1;
  const request = () => ({
    claimPolicy: {
      claimWindowEndTs: liveAt,
      submissionDeadlineTs: liveAt + 2_000,
    },
    spec: {
      session: {
        deadline: new Date(liveAt + 1_000).toISOString(),
      },
    },
  });

  it('accepts every operational deadline just beyond the fixed reserve boundary', () => {
    expect(MARKETPLACE_TASK_FRESHNESS_RESERVE_MS).toBe(60_000);
    expect(() => assertMarketplaceTaskRequestFreshness(request(), { nowMs })).not.toThrow();
  });

  it('throws a named policy-expiration error for command-boundary classification', () => {
    const value = request();
    value.claimPolicy.claimWindowEndTs = nowMs + 60_000;
    expect(MarketplaceTaskRequestExpiredError).toBeTypeOf('function');
    expect(() => assertMarketplaceTaskRequestFreshness(value, { nowMs }))
      .toThrow(MarketplaceTaskRequestExpiredError);
  });

  it.each([
    ['claim window end', (value: ReturnType<typeof request>) => {
      value.claimPolicy.claimWindowEndTs = nowMs + 60_000;
    }],
    ['submission deadline', (value: ReturnType<typeof request>) => {
      value.claimPolicy.submissionDeadlineTs = nowMs + 60_000;
    }],
    ['session/adoption deadline', (value: ReturnType<typeof request>) => {
      value.spec.session.deadline = new Date(nowMs + 60_000).toISOString();
    }],
  ])('rejects %s at the reserve boundary', (_label, mutate) => {
    const value = request();
    mutate(value);
    expect(() => assertMarketplaceTaskRequestFreshness(value, { nowMs }))
      .toThrow(/freshness|reserve|deadline/i);
  });
});
