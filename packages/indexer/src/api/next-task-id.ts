/**
 * Cached on-chain lookup of the JinnRouter's `nextTaskId()` view, consumed by
 * the /health/task-coverage route to detect the issue-#567 silent-handler-drop
 * condition. Uses the shared `createCachedRpcCall` helper (60 s TTL on both
 * success and error) so we share a degraded-endpoint backoff with chain-head.
 *
 * Address is hard-coded rather than imported from `ponder.config.ts` because
 * the config module registers Ponder event handlers on load — pulling it into
 * a Vitest run would drag those side effects in. When mainnet indexing lands
 * this will need a per-chain extension; the testnet-only scope matches what
 * the indexer serves today.
 */
import { createPublicClient, http } from 'viem';
import { baseSepolia } from 'viem/chains';
import { JINN_ROUTER_ABI } from '../../abis/JinnRouter.js';
import { createCachedRpcCall, RPC_TIMEOUT_MS } from './rpc-cache.js';

/** JinnRouter address on Base Sepolia — must stay in sync with `ponder.config.ts`. */
const ROUTER_ADDRESS = '0xdC9BCcEB7aca21Ad4Ca2Fc5B4d7aea6b4F6CedD9' as const;

const RPC_URL =
  process.env['PONDER_RPC_URL_84532'] ?? 'https://sepolia.base.org';

const client = createPublicClient({
  chain: baseSepolia,
  transport: http(RPC_URL, { timeout: RPC_TIMEOUT_MS }),
});

const cached = createCachedRpcCall<bigint>(async () => {
  return (await client.readContract({
    address: ROUTER_ADDRESS,
    abi: JINN_ROUTER_ABI,
    functionName: 'nextTaskId',
  })) as bigint;
});

/**
 * Returns the JinnRouter's current `nextTaskId()` value, cached for 60 s.
 * Returns `null` if the RPC is unreachable or the call times out; the null is
 * also cached for 60 s.
 */
export async function getNextTaskId(): Promise<bigint | null> {
  return cached();
}

/**
 * Reset the module-scope cache. Used in tests to avoid cross-test pollution.
 * @internal
 */
export function _resetNextTaskIdCache(): void {
  cached.reset();
}
