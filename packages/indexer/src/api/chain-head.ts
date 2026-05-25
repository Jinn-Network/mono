/**
 * Cached chain-head block-number lookup for the explorer freshness block.
 *
 * Uses viem's `createPublicClient` to call `eth_blockNumber` against the Base
 * Sepolia RPC configured via `PONDER_RPC_URL_84532`. Caching policy lives in
 * `./rpc-cache.ts` — 60 s TTL on both successful and null (error) results so
 * we never retry-storm a failing endpoint.
 *
 * ebu7.9 — Part 2.
 */
import { createPublicClient, http } from 'viem';
import { baseSepolia } from 'viem/chains';
import { createCachedRpcCall, RPC_TIMEOUT_MS } from './rpc-cache.js';

const RPC_URL =
  process.env['PONDER_RPC_URL_84532'] ?? 'https://sepolia.base.org';

const client = createPublicClient({
  chain: baseSepolia,
  transport: http(RPC_URL, { timeout: RPC_TIMEOUT_MS }),
});

const cached = createCachedRpcCall<bigint>(() => client.getBlockNumber());

/**
 * Returns the current Base Sepolia chain-head block number, cached for 60 s.
 * Returns `null` if the RPC is unreachable or the call times out; the null is
 * also cached for 60 s.
 */
export async function getChainHead(): Promise<bigint | null> {
  return cached();
}

/**
 * Reset the module-scope cache. Used in tests to avoid cross-test pollution.
 * @internal
 */
export function _resetChainHeadCache(): void {
  cached.reset();
}
