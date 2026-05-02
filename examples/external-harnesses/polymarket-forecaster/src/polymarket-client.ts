/**
 * Polymarket fetch stub. The real impl calls
 * https://gamma-api.polymarket.com/markets/<id>; this example ships a
 * deterministic mock keyed off the marketId hash so tests run offline.
 */

export interface PolymarketMarketSnapshot {
  marketId: string;
  question: string;
  endTimeIso: string;
  /** Polymarket's outcome_0_price = implied probability of YES, [0..1]. */
  yesPrice: number;
}

export async function fetchMarketSnapshot(
  marketId: string,
): Promise<PolymarketMarketSnapshot> {
  const seed = Array.from(marketId).reduce(
    (s, c) => (s * 31 + c.charCodeAt(0)) >>> 0,
    0,
  );
  const yesPrice = (seed % 1000) / 1000;
  return {
    marketId,
    question: `Stub market ${marketId}`,
    endTimeIso: new Date(Date.now() + 86_400_000).toISOString(),
    yesPrice,
  };
}
