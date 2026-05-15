/**
 * Cached chain-head block-number lookup for the explorer freshness block.
 *
 * Uses viem's createPublicClient to call eth_blockNumber against the Base Sepolia
 * RPC configured via PONDER_RPC_URL_84532 (defaults to the public endpoint).
 *
 * Cache policy: module-scope cell valid for 60 s. On RPC error the null value is
 * cached for 60 s too — this prevents retry-storming a failing RPC endpoint.
 * The route response is never blocked on a slow RPC: the 60 s cache serves most
 * callers from memory; a slow fresh fetch only blocks the first caller after a
 * 60 s window, and only for up to ~1.5 s (the client timeout).
 *
 * ebu7.9 — Part 2.
 */
import { createPublicClient, http } from 'viem';
import { baseSepolia } from 'viem/chains';

// ── Module-scope cache cell ───────────────────────────────────────────────────

interface CacheCell {
  value: bigint | null;
  fetchedAt: number;
}

/** 60 s TTL for both successful and null (error) results. */
const CACHE_TTL_MS = 60_000;

/** Race timeout for the RPC call — avoids blocking the route on a slow endpoint. */
const RPC_TIMEOUT_MS = 1_500;

let cache: CacheCell = { value: null, fetchedAt: 0 };

// ── Viem client (created once; stateless) ─────────────────────────────────────

const RPC_URL =
  process.env['PONDER_RPC_URL_84532'] ?? 'https://sepolia.base.org';

const client = createPublicClient({
  chain: baseSepolia,
  transport: http(RPC_URL, { timeout: RPC_TIMEOUT_MS }),
});

// ── getChainHead ──────────────────────────────────────────────────────────────

/**
 * Returns the current Base Sepolia chain-head block number, cached for 60 s.
 *
 * Returns `null` if the RPC is unreachable or the call times out; the null is
 * also cached for 60 s to avoid retry-storming a degraded endpoint.
 */
export async function getChainHead(): Promise<bigint | null> {
  const now = Date.now();
  if (now - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.value;
  }

  try {
    const blockNumber = await client.getBlockNumber();
    cache = { value: blockNumber, fetchedAt: now };
    return blockNumber;
  } catch {
    // Cache null so we don't retry-storm a failing RPC.
    cache = { value: null, fetchedAt: now };
    return null;
  }
}

/**
 * Reset the module-scope cache. Used in tests to avoid cross-test pollution.
 * @internal
 */
export function _resetChainHeadCache(): void {
  cache = { value: null, fetchedAt: 0 };
}
