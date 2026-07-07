/**
 * Cached on-chain lookup of the TaskCoordinator's `nextTaskId()` view, consumed
 * by the /health/task-coverage route to detect the issue-#567
 * silent-handler-drop condition. Uses the shared `createCachedRpcCall` helper
 * (60 s TTL on both success and error) so we share a degraded-endpoint backoff
 * with chain-head.
 *
 * NOTE: the `nextTaskId` storage slot lives on TaskCoordinator
 * (`contracts/src/tasks/TaskCoordinator.sol`), not JinnRouter. JinnRouterV3
 * holds a reference to the coordinator (`taskCoordinator` field) but does not
 * re-expose the view, so this probe reads the active router's coordinator
 * reference first, then calls the returned coordinator.
 *
 * The active router address and RPC parsing live in side-effect-free helpers
 * rather than `ponder.config.ts` because the config module registers Ponder
 * event handlers on load. When mainnet indexing lands this will need a
 * per-chain extension; the testnet-only scope matches what the indexer serves
 * today.
 */
import { createPublicClient } from 'viem';
import { baseSepolia } from 'viem/chains';
import { JINN_ROUTER_ABI } from '../../abis/JinnRouter.js';
import { TASK_COORDINATOR_ABI } from '../../abis/TaskCoordinator.js';
import { BASE_SEPOLIA_JINN_ROUTER_ADDRESS } from '../chain-config.js';
import { buildIndexerFallback, parseBaseSepoliaRpcChain } from '../rpc-config.js';
import { createCachedRpcCall, RPC_TIMEOUT_MS } from './rpc-cache.js';

const baseSepoliaUrls = parseBaseSepoliaRpcChain();

const client = createPublicClient({
  chain: baseSepolia,
  transport: buildIndexerFallback(baseSepoliaUrls, { timeout: RPC_TIMEOUT_MS }),
});

const cached = createCachedRpcCall<bigint>(async () => {
  const coordinatorAddress = (await client.readContract({
    address: BASE_SEPOLIA_JINN_ROUTER_ADDRESS,
    abi: JINN_ROUTER_ABI,
    functionName: 'taskCoordinator',
  })) as `0x${string}`;

  return (await client.readContract({
    address: coordinatorAddress,
    abi: TASK_COORDINATOR_ABI,
    functionName: 'nextTaskId',
  })) as bigint;
});

/**
 * Returns the TaskCoordinator's current `nextTaskId()` value, cached for 60 s.
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
