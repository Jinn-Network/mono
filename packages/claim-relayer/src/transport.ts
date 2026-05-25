/**
 * Inline RPC transport helper for the claim relayer — mirrors
 * `client/src/rpc/transport.ts` (Jinn issue #592). Replicated here rather
 * than imported from `@jinn-network/client` because the relayer is a
 * separate package and may publish independently. A future
 * `@jinn-network/sdk` extraction can consolidate.
 */

import { fallback, http, type FallbackTransport } from 'viem';

/** Hard cap on the number of providers in a single fallback chain. */
export const MAX_RPC_CHAIN_LENGTH = 4;

export function parseRpcUrls(input: string | readonly string[]): string[] {
  const raw = typeof input === 'string' ? input.split(',') : [...input];
  const cleaned = raw.map((u) => u.trim()).filter((u) => u.length > 0);
  if (cleaned.length === 0) {
    throw new Error('parseRpcUrls: at least one RPC URL is required');
  }
  // Dedup before applying the cap so repeated URLs don't burn slots of the
  // 4-slot chain. Mirrors `client/src/rpc/transport.ts`. `Set` preserves
  // first-seen insertion order.
  const deduped = [...new Set(cleaned)];
  if (deduped.length > MAX_RPC_CHAIN_LENGTH) {
    process.stderr.write(
      `[claim-relayer] capped fallback chain to ${MAX_RPC_CHAIN_LENGTH} providers ` +
        `(dropped ${deduped.length - MAX_RPC_CHAIN_LENGTH} extra slots)\n`,
    );
    return deduped.slice(0, MAX_RPC_CHAIN_LENGTH);
  }
  return deduped;
}

export function maskRpcHost(url: string): string {
  try {
    return new URL(url).hostname || '(unknown host)';
  } catch {
    return '(invalid rpc url)';
  }
}

export function buildFallbackTransport(urls: readonly string[]): FallbackTransport {
  return fallback(urls.map((u) => http(u)), { rank: false, retryCount: 0 });
}

/** AC7-style boot-log summary: `fallback chain (N providers) — primary=<host>`. */
export function describeFallbackChain(urls: readonly string[]): string {
  if (urls.length === 0) return 'fallback chain (0 providers)';
  return `fallback chain (${urls.length} providers) — primary=${maskRpcHost(urls[0]!)}`;
}
