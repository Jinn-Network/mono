// Deterministic stub. Real builders swap for the Polymarket gamma-markets API.
export interface PolymarketMarket {
  marketId: string;
  question: string;
  yesPrice: number;
  endTimeIso: string;
}

export async function fetchMarket(marketId: string): Promise<PolymarketMarket> {
  const seed = Array.from(marketId).reduce(
    (s, c) => (s * 31 + c.charCodeAt(0)) >>> 0,
    0,
  );
  return {
    marketId,
    question: `Stub market ${marketId}`,
    yesPrice: (seed % 1000) / 1000,
    endTimeIso: new Date(Date.now() + 7 * 86_400_000).toISOString(),
  };
}

export async function fetchRecentVolume(
  marketId: string,
): Promise<{ marketId: string; volume24h: number }> {
  const seed = Array.from(marketId).reduce(
    (s, c) => (s * 17 + c.charCodeAt(0)) >>> 0,
    0,
  );
  return { marketId, volume24h: seed % 100_000 };
}
