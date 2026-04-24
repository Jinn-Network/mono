import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makePredictionV0Generator } from '../../src/intents/prediction-v0-auto.js';
import type { PublicClient } from 'viem';

function makePublicClient(price: string): PublicClient {
  // price expressed as an 8-decimal Chainlink int256.
  const scaled = BigInt(Math.round(parseFloat(price) * 1e8));
  return {
    readContract: vi.fn(async (args: { functionName: string }) => {
      if (args.functionName === 'latestRoundData') {
        return [42n, scaled, 1_700_000_000n, 1_700_000_000n, 42n];
      }
      if (args.functionName === 'decimals') return 8;
      throw new Error(`unmocked: ${args.functionName}`);
    }),
  } as unknown as PublicClient;
}

describe('makePredictionV0Generator', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('produces a valid prediction.v0 RestorationJob with sentinel-resolved threshold', async () => {
    vi.setSystemTime(new Date('2026-04-21T18:23:45Z')); // mid-hour
    const gen = makePredictionV0Generator({
      feed: '0x000000000000000000000000000000000000feed',
      feedDescription: 'ETH / USD',
      venue: 'chainlink-base-sepolia',
      _publicClient: makePublicClient('2300'),
    });
    const state = await gen();
    expect(state).not.toBeNull();
    expect(state!.spec?.kind).toBe('prediction.v0');
    const q = (state!.spec as any).question;
    expect(q.kind).toBe('threshold');
    expect(q.operator).toBe('GT');
    // Default sentinel is current+0.5%  → 2300 × 1.005 = 2311.5
    expect(q.threshold).toBe('2311.5');
  });

  it('uses the window boundary as the stable intent ID (default 10min bucket)', async () => {
    // Bucket 1: 18:20:00 - 18:30:00 → both 18:23:45 and 18:29:00 land here
    vi.setSystemTime(new Date('2026-04-21T18:23:45Z'));
    const genA = makePredictionV0Generator({
      feed: '0x000000000000000000000000000000000000feed',
      feedDescription: 'ETH / USD',
      venue: 'chainlink-base-sepolia',
      _publicClient: makePublicClient('2300'),
    });
    const a1 = await genA();
    vi.setSystemTime(new Date('2026-04-21T18:29:00Z'));
    const a2 = await genA();
    expect(a1!.id).toBe(a2!.id);
    // Cross bucket boundary (18:30) → different id.
    vi.setSystemTime(new Date('2026-04-21T18:30:01Z'));
    const a3 = await genA();
    expect(a3!.id).not.toBe(a1!.id);
  });

  it('default window = 10min, resolve gap = 5min (fast-test cadence)', async () => {
    vi.setSystemTime(new Date('2026-04-21T18:23:45Z'));
    const gen = makePredictionV0Generator({
      feed: '0x000000000000000000000000000000000000feed',
      feedDescription: 'ETH / USD',
      venue: 'chainlink-base-sepolia',
      _publicClient: makePublicClient('2300'),
    });
    const state = await gen();
    expect(state!.window!.endTs - state!.window!.startTs).toBe(600_000);
    expect((state!.spec as any).question.resolveTs).toBe(state!.window!.endTs + 300_000);
  });

  it('respects custom windowDurationMs + resolveGapMs (mainnet-style 1h+15min)', async () => {
    vi.setSystemTime(new Date('2026-04-21T18:23:45Z'));
    const gen = makePredictionV0Generator({
      feed: '0x000000000000000000000000000000000000feed',
      feedDescription: 'ETH / USD',
      venue: 'chainlink-base-sepolia',
      windowDurationMs: 3_600_000,
      resolveGapMs: 900_000,
      _publicClient: makePublicClient('2300'),
    });
    const state = await gen();
    expect(state!.window!.endTs - state!.window!.startTs).toBe(3_600_000);
    expect((state!.spec as any).question.resolveTs).toBe(state!.window!.endTs + 900_000);
  });

  it('returns null when Chainlink read fails (caller skips this tick)', async () => {
    vi.setSystemTime(new Date('2026-04-21T18:23:45Z'));
    const broken = {
      readContract: vi.fn(async () => { throw new Error('RPC down'); }),
    } as unknown as PublicClient;
    const gen = makePredictionV0Generator({
      feed: '0x000000000000000000000000000000000000feed',
      feedDescription: 'ETH / USD',
      venue: 'chainlink-base-sepolia',
      _publicClient: broken,
    });
    const state = await gen();
    expect(state).toBeNull();
  });

  it('supports a custom thresholdSentinel + operator', async () => {
    vi.setSystemTime(new Date('2026-04-21T18:23:45Z'));
    const gen = makePredictionV0Generator({
      feed: '0x000000000000000000000000000000000000feed',
      feedDescription: 'ETH / USD',
      venue: 'chainlink-base-sepolia',
      thresholdSentinel: 'current-1%',
      operator: 'LT',
      _publicClient: makePublicClient('2000'),
    });
    const state = await gen();
    const q = (state!.spec as any).question;
    expect(q.operator).toBe('LT');
    // 2000 × 0.99 = 1980
    expect(q.threshold).toBe('1980');
  });
});
