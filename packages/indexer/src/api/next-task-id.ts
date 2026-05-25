/**
 * Cached on-chain lookup of the JinnRouter's `nextTaskId()` view.
 *
 * Mirrors src/api/chain-head.ts: module-scope cell with a 60 s TTL on both
 * successful and null (error) results so a degraded RPC endpoint does not get
 * retry-stormed. The /health/task-coverage route consumes this value to detect
 * the issue-#567 condition where the indexer's TaskCreated handler has
 * silently stopped writing rows.
 *
 * Address + chain mirror the chain-head module's source (PONDER_RPC_URL_84532
 * → Base Sepolia). When mainnet indexing lands, this file will need a
 * per-chain extension; the testnet-only scope matches what the indexer
 * actually serves today.
 */
import { createPublicClient, http } from 'viem';
import { baseSepolia } from 'viem/chains';
import { JINN_ROUTER_ABI } from '../../abis/JinnRouter.js';

// ── Constants ─────────────────────────────────────────────────────────────────

/** 60 s TTL for both successful and null (error) results. */
const CACHE_TTL_MS = 60_000;

/** Race timeout for the RPC call — avoids blocking the route on a slow endpoint. */
const RPC_TIMEOUT_MS = 1_500;

/**
 * JinnRouter address on Base Sepolia — must stay in sync with the address in
 * `ponder.config.ts`. The address is hard-coded rather than imported from
 * ponder.config.ts because the config module is loaded by Ponder at startup
 * and has side effects (event registration); importing it from an API helper
 * would pull in those side effects under Vitest.
 */
const ROUTER_ADDRESS = '0xdC9BCcEB7aca21Ad4Ca2Fc5B4d7aea6b4F6CedD9' as const;

// ── Module-scope cache cell ───────────────────────────────────────────────────

interface CacheCell {
  value: bigint | null;
  fetchedAt: number;
}

let cache: CacheCell = { value: null, fetchedAt: 0 };

// ── Viem client (created once; stateless) ─────────────────────────────────────

const RPC_URL =
  process.env['PONDER_RPC_URL_84532'] ?? 'https://sepolia.base.org';

const client = createPublicClient({
  chain: baseSepolia,
  transport: http(RPC_URL, { timeout: RPC_TIMEOUT_MS }),
});

// ── getNextTaskId ─────────────────────────────────────────────────────────────

/**
 * Returns the JinnRouter's current `nextTaskId()` view value, cached for 60 s.
 *
 * Returns `null` if the RPC is unreachable or the call times out; the null is
 * also cached for 60 s to avoid retry-storming a degraded endpoint.
 */
export async function getNextTaskId(): Promise<bigint | null> {
  const now = Date.now();
  if (now - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.value;
  }

  try {
    const value = (await client.readContract({
      address: ROUTER_ADDRESS,
      abi: JINN_ROUTER_ABI,
      functionName: 'nextTaskId',
    })) as bigint;
    cache = { value, fetchedAt: now };
    return value;
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
export function _resetNextTaskIdCache(): void {
  cache = { value: null, fetchedAt: 0 };
}
