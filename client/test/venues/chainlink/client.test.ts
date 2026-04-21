import { describe, it, expect, vi } from 'vitest';
import { scaleToDecimal, oraclePriceAtResolveTs } from '../../../src/venues/chainlink/client.js';

describe('scaleToDecimal', () => {
  it('scales an 8-decimal Chainlink int256 to a decimal string', () => {
    expect(scaleToDecimal(350_000_000_000n, 8)).toBe('3500');
  });

  it('preserves fractional precision', () => {
    expect(scaleToDecimal(345_012_345_678n, 8)).toBe('3450.12345678');
  });

  it('handles zero', () => {
    expect(scaleToDecimal(0n, 8)).toBe('0');
  });

  it('strips trailing zeros in the fractional part', () => {
    expect(scaleToDecimal(350_000_000_000n, 8)).toBe('3500');
    expect(scaleToDecimal(350_010_000_000n, 8)).toBe('3500.1');
  });

  it('throws on negative values (price feeds are non-negative in v0)', () => {
    expect(() => scaleToDecimal(-1n, 8)).toThrow();
  });
});

describe('oraclePriceAtResolveTs', () => {
  function makePublicClient(rounds: Array<{roundId: bigint, answer: bigint, updatedAt: number}>) {
    const byRound = new Map(rounds.map(r => [r.roundId, r]));
    const latest = rounds[rounds.length - 1]!;
    return {
      readContract: vi.fn(async ({ functionName, args }: any) => {
        if (functionName === 'decimals') return 8;
        if (functionName === 'latestRoundData') {
          return [latest.roundId, latest.answer, BigInt(latest.updatedAt / 1000), BigInt(latest.updatedAt / 1000), latest.roundId];
        }
        if (functionName === 'getRoundData') {
          const r = byRound.get(args[0]);
          if (!r) throw new Error(`round ${args[0]} not found`);
          return [r.roundId, r.answer, BigInt(r.updatedAt / 1000), BigInt(r.updatedAt / 1000), r.roundId];
        }
        throw new Error(functionName);
      }),
    } as any;
  }

  it('returns latest when latest.updatedAt > resolveTs and finds the spanning round via walk-back', async () => {
    const rounds = [
      { roundId: 1n, answer: 350_000_000_000n, updatedAt: 1000 },
      { roundId: 2n, answer: 351_000_000_000n, updatedAt: 2000 },
      { roundId: 3n, answer: 352_000_000_000n, updatedAt: 5000 },
    ];
    const pc = makePublicClient(rounds);
    const { round, nextRound } = await oraclePriceAtResolveTs(
      '0x000000000000000000000000000000000000feed',
      3000,
      pc,
    );
    expect(round.roundId).toBe(2n);
    expect(nextRound?.roundId).toBe(3n);
  });

  it('returns null nextRound and indicates spanning=false when latest.updatedAt <= resolveTs', async () => {
    const rounds = [
      { roundId: 1n, answer: 350_000_000_000n, updatedAt: 1000 },
      { roundId: 2n, answer: 351_000_000_000n, updatedAt: 2000 },
    ];
    const pc = makePublicClient(rounds);
    const result = await oraclePriceAtResolveTs(
      '0x000000000000000000000000000000000000feed',
      5000,
      pc,
    );
    expect(result.round.roundId).toBe(2n);
    expect(result.nextRound).toBeNull();
    expect(result.spanning).toBe(false);
  });
});
