import { fallback, http } from 'viem';
import { BASE_SEPOLIA_RPC_FALLBACK_URL } from './chain-config.js';

/**
 * Hard cap on the number of providers in a single fallback chain (issue #592).
 * Four covers the indexer's intended shape: Envio HyperSync (slot 0) +
 * publicnode (slot 1) + sepolia.base.org (slot 2) + optional Tenderly fallback.
 */
export const MAX_RPC_CHAIN_LENGTH = 4;

export function parseRpcChain(value: string | undefined, fallbackUrl: string): string[] {
  const raw = (value ?? fallbackUrl)
    .split(',')
    .map((u) => u.trim())
    .filter(Boolean);
  if (raw.length === 0) return [fallbackUrl];
  if (raw.length > MAX_RPC_CHAIN_LENGTH) {
    // eslint-disable-next-line no-console
    console.error(
      `[ponder] capped fallback chain to ${MAX_RPC_CHAIN_LENGTH} providers ` +
        `(dropped ${raw.length - MAX_RPC_CHAIN_LENGTH} extra slots)`,
    );
    return raw.slice(0, MAX_RPC_CHAIN_LENGTH);
  }
  return raw;
}

export function parseBaseSepoliaRpcChain(env: NodeJS.ProcessEnv = process.env): string[] {
  return parseRpcChain(env['PONDER_RPC_URL_84532'], BASE_SEPOLIA_RPC_FALLBACK_URL);
}

export function buildIndexerFallback(
  urls: readonly string[],
  options: { timeout?: number } = {},
) {
  // `rank: false` preserves operator-supplied slot order. Per #592 the intended
  // ordering is paid > free-public > free-public-backup.
  return fallback(urls.map((u) => http(u, options)), { rank: false });
}
