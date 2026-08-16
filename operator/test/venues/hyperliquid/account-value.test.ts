/**
 * Tests for the unified account-value helper.
 *
 * Rationale: HL's `clearinghouseState.marginSummary.accountValue` reflects
 * perps margin only. Accounts holding USDC on the spot side (whether on
 * Portfolio Margin or classic) see accountValue=0 there, even though the
 * account has usable equity. The unified helper sums perps + spot USDC so
 * the harness and evaluator agree on a single equity figure that matches
 * HL's own portfolio-endpoint `accountValueHistory`.
 */

import { describe, expect, it, vi } from 'vitest';
import { getUnifiedAccountValue } from '../../../src/venues/hyperliquid/account-value.js';
import type {
  HlClearinghouseState,
  HlSpotClearinghouseState,
} from '../../../src/venues/hyperliquid/types.js';

function mockPerps(accountValue: string): HlClearinghouseState {
  return {
    marginSummary: { accountValue, totalNtlPos: '0', totalRawUsd: '0', totalMarginUsed: '0' },
    crossMarginSummary: { accountValue, totalNtlPos: '0', totalRawUsd: '0', totalMarginUsed: '0' },
    crossMaintenanceMarginUsed: '0',
    withdrawable: accountValue,
    assetPositions: [],
    time: 0,
  };
}

function mockSpot(balances: { coin: string; total: string }[]): HlSpotClearinghouseState {
  return {
    balances: balances.map((b) => ({
      coin: b.coin,
      token: 0,
      total: b.total,
      hold: '0.0',
      entryNtl: '0.0',
    })),
  };
}

describe('getUnifiedAccountValue', () => {
  it('sums perps marginSummary.accountValue and spot USDC balance', async () => {
    const hlClient = {
      clearinghouseState: vi.fn().mockResolvedValue(mockPerps('250')),
      spotClearinghouseState: vi.fn().mockResolvedValue(mockSpot([{ coin: 'USDC', total: '1012.106681' }])),
    };

    const result = await getUnifiedAccountValue(hlClient as any, '0xabc');

    expect(result.perpsAccountValue).toBe('250');
    expect(result.spotUsdc).toBe('1012.106681');
    expect(result.accountValue).toBe('1262.106681');
    expect(result.clearinghouseState).toEqual(mockPerps('250'));
    expect(result.spotClearinghouseState).toEqual(
      mockSpot([{ coin: 'USDC', total: '1012.106681' }]),
    );
  });

  it('treats missing USDC balance as zero', async () => {
    const hlClient = {
      clearinghouseState: vi.fn().mockResolvedValue(mockPerps('500')),
      spotClearinghouseState: vi.fn().mockResolvedValue(mockSpot([])),
    };

    const result = await getUnifiedAccountValue(hlClient as any, '0xabc');

    expect(result.spotUsdc).toBe('0');
    expect(result.accountValue).toBe('500');
  });

  it('ignores non-USDC spot tokens (v0 keeps valuation simple)', async () => {
    const hlClient = {
      clearinghouseState: vi.fn().mockResolvedValue(mockPerps('0')),
      spotClearinghouseState: vi.fn().mockResolvedValue(
        mockSpot([
          { coin: 'USDC', total: '100' },
          { coin: 'HYPE', total: '5' },
          { coin: 'USDT0', total: '50' },
        ]),
      ),
    };

    const result = await getUnifiedAccountValue(hlClient as any, '0xabc');

    expect(result.accountValue).toBe('100');
    expect(result.spotUsdc).toBe('100');
  });

  it('handles both zero balances', async () => {
    const hlClient = {
      clearinghouseState: vi.fn().mockResolvedValue(mockPerps('0')),
      spotClearinghouseState: vi.fn().mockResolvedValue(mockSpot([{ coin: 'USDC', total: '0.0' }])),
    };

    const result = await getUnifiedAccountValue(hlClient as any, '0xabc');

    expect(result.accountValue).toBe('0');
    expect(result.perpsAccountValue).toBe('0');
    expect(result.spotUsdc).toBe('0.0');
  });
});
