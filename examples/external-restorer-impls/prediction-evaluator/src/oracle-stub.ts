/**
 * Deterministic stub oracle. Real impls call an on-chain or HTTP
 * oracle (UMA, Pyth, Polymarket resolution, etc.); this stub returns
 * a per-intentId outcome so tests are offline + deterministic.
 */

export interface OracleSnapshot {
  intentId: string;
  resolvedOutcome: 0 | 1; // 0 = NO, 1 = YES (binary markets)
  resolvedAt: number;     // unix ms
}

export async function fetchResolution(
  intentId: string,
): Promise<OracleSnapshot> {
  const seed = Array.from(intentId).reduce(
    (s, c) => (s * 31 + c.charCodeAt(0)) >>> 0,
    0,
  );
  return {
    intentId,
    resolvedOutcome: (seed & 1) as 0 | 1,
    resolvedAt: Date.now(),
  };
}
