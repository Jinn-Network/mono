import { describe, expect, it } from 'vitest';
import {
  buildGammaMarketFixture,
  buildPredictionSmokeTaskSpec,
  summarizeSmokeStatus,
} from './olas-rails-smoke.js';

describe('olas rails smoke helpers', () => {
  it('builds an open prediction.v1 smoke task with deterministic market ids', () => {
    const spec = buildPredictionSmokeTaskSpec({
      nowMs: Date.parse('2026-06-29T16:00:00.000Z'),
      runSlug: 'abc123',
    });

    expect(spec.solverType).toBe('prediction.v1');
    expect(spec.role).toBe('restoration');
    expect(spec.window).toEqual({
      startTs: Date.parse('2026-06-29T15:59:00.000Z'),
      endTs: Date.parse('2026-06-29T17:00:00.000Z'),
    });
    expect(spec.spec.source.identifiers).toEqual({
      marketId: 'jinn-local-smoke-abc123',
      conditionId: '0xjinn-local-smoke-abc123',
      yesTokenId: 'yes-jinn-local-smoke-abc123',
      noTokenId: 'no-jinn-local-smoke-abc123',
    });
    expect(spec.eligibility.dedupKey).toBe('polymarket:jinn-local-smoke-abc123');
  });

  it('builds a resolved Gamma market fixture accepted by the Polymarket client', () => {
    const market = buildGammaMarketFixture({
      marketId: 'jinn-local-smoke-abc123',
      conditionId: '0xjinn-local-smoke-abc123',
      outcome: 'YES',
      nowMs: Date.parse('2026-06-29T16:00:00.000Z'),
    });

    expect(market).toMatchObject({
      id: 'jinn-local-smoke-abc123',
      conditionId: '0xjinn-local-smoke-abc123',
      question: 'Will this tokenless OLAS smoke test complete successfully?',
      closed: true,
      archived: false,
      winningOutcome: 'YES',
    });
    expect(JSON.parse(market.outcomes)).toEqual(['YES', 'NO']);
    expect(JSON.parse(market.clobTokenIds)).toEqual([
      'yes-jinn-local-smoke-abc123',
      'no-jinn-local-smoke-abc123',
    ]);
    expect(JSON.parse(market.outcomePrices)).toEqual(['1', '0']);
  });

  it('summarizes daemon status in the B0 evidence shape', () => {
    const summary = summarizeSmokeStatus({
      daemon: { shutdownState: 'running' },
      rewards: { claimedStakingRewardsWei: '30000000000000000' },
      taskRuns: {
        totals: {
          completed: 4,
          activeTaskRuns: 0,
          failed: 0,
          solutions: 2,
          verdicts: 2,
        },
        inFlight: [],
      },
      predictionV1: {
        totals: {
          observedTasks: 2,
          activeTaskRuns: 0,
          solutions: 2,
          verdicts: 2,
          failed: 0,
        },
      },
    });

    expect(summary).toEqual({
      shutdownState: 'running',
      activeTaskRuns: 0,
      completed: 4,
      failed: 0,
      inFlightCount: 0,
      solutions: 2,
      verdicts: 2,
      claimedStakingRewardsWei: '30000000000000000',
    });
  });
});
