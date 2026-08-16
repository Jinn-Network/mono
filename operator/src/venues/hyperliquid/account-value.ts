/**
 * Unified account-value helper.
 *
 * Returns a single equity figure that sums perps margin + spot USDC. This
 * matches HL's `portfolio` endpoint `accountValueHistory` (which also
 * reports the unified view), so harness-claimed equity and evaluator-
 * rederived grid points compare cleanly.
 *
 * Non-USDC spot tokens are NOT valued in v0 — their midprice lookup and
 * safety semantics are out of scope for the first cut of portfolio.v0.
 */

import type {
  HlClearinghouseState,
  HlSpotClearinghouseState,
} from './types.js';

export interface UnifiedAccountValue {
  /** Sum of perps accountValue + spot USDC balance, as a decimal string. */
  accountValue: string;
  /** Perps-only accountValue (marginSummary.accountValue). */
  perpsAccountValue: string;
  /** Spot USDC balance (0 if absent). */
  spotUsdc: string;
  /** Raw perps payload from HL. */
  clearinghouseState: HlClearinghouseState;
  /** Raw spot payload from HL. */
  spotClearinghouseState: HlSpotClearinghouseState;
}

interface HlClientLike {
  clearinghouseState: (user: string) => Promise<HlClearinghouseState>;
  spotClearinghouseState: (user: string) => Promise<HlSpotClearinghouseState>;
}

export async function getUnifiedAccountValue(
  hlClient: HlClientLike,
  user: string,
): Promise<UnifiedAccountValue> {
  const [clearinghouseState, spotClearinghouseState] = await Promise.all([
    hlClient.clearinghouseState(user),
    hlClient.spotClearinghouseState(user),
  ]);

  const perpsAccountValue = clearinghouseState.marginSummary.accountValue;
  const usdcBalance = spotClearinghouseState.balances.find((b) => b.coin === 'USDC');
  const spotUsdc = usdcBalance ? usdcBalance.total : '0';

  const total = parseFloat(perpsAccountValue) + parseFloat(spotUsdc);
  const accountValue = String(total);

  return {
    accountValue,
    perpsAccountValue,
    spotUsdc,
    clearinghouseState,
    spotClearinghouseState,
  };
}
