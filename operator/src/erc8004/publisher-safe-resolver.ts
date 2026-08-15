/**
 * Resolve the Safe bound to an ERC-8004 publisher agent.
 *
 * Evidence acceptance uses this read to bind a MetadataSet publisher agent to
 * the authoritative JinnRouter evaluator/operator. The resolver validates the
 * RPC chain once and caches immutable observations for the duration of a
 * distillation run.
 */
import {
  createPublicClient,
  getAddress,
  http,
  zeroAddress,
  type Address,
} from 'viem';
import { getIdentityRegistryAddress } from '../contracts/addresses.js';
import { IDENTITY_REGISTRY_GET_AGENT_WALLET_ABI } from './abis.js';

export interface RegistryReadClient {
  getChainId: () => Promise<number>;
  readContract: (args: {
    address: Address;
    abi: typeof IDENTITY_REGISTRY_GET_AGENT_WALLET_ABI;
    functionName: 'getAgentWallet';
    args: readonly [bigint];
    blockNumber: bigint;
  }) => Promise<unknown>;
}

export interface PublisherSafeResolverOptions {
  rpcUrl: string;
  expectedChainId?: number;
  identityRegistry?: string;
  /** Structural injection seam for hermetic tests. */
  client?: RegistryReadClient;
  /** Additional injected clients, tried sequentially after `client`. */
  fallbackClients?: readonly RegistryReadClient[];
  /** Additional RPC URLs, tried sequentially after `rpcUrl`. */
  fallbackRpcUrls?: readonly string[];
}

export function createPublisherSafeResolver(
  options: PublisherSafeResolverOptions,
): (
  chainId: number,
  publisherAgentId: string,
  publishedAtBlock: bigint,
) => Promise<string> {
  const primaryClient: RegistryReadClient =
    options.client
    ?? createPublicClient({ transport: http(options.rpcUrl) }) as RegistryReadClient;
  const fallbackUrls = (options.fallbackRpcUrls ?? []).filter(
    (url) => url !== options.rpcUrl,
  );
  const clients: readonly RegistryReadClient[] = [
    primaryClient,
    ...(options.fallbackClients ?? []),
    ...fallbackUrls.map(
      (url) => createPublicClient({ transport: http(url) }) as RegistryReadClient,
    ),
  ];
  const cache = new Map<string, Promise<string>>();
  const rpcChains = new Map<RegistryReadClient, number>();

  return async (chainId, publisherAgentId, publishedAtBlock) => {
    if (!Number.isSafeInteger(chainId) || chainId <= 0) {
      throw new Error(`publisher Safe resolver received invalid chainId ${chainId}`);
    }
    if (
      options.expectedChainId !== undefined
      && chainId !== options.expectedChainId
    ) {
      throw new Error(
        `publisher Safe resolver chain ${chainId} does not match expected ${options.expectedChainId}`,
      );
    }
    if (!/^[1-9][0-9]*$/.test(publisherAgentId)) {
      throw new Error(`publisher agent id must be a positive decimal: ${publisherAgentId}`);
    }
    if (publishedAtBlock <= 0n) {
      throw new Error(
        `publisher metadata block must be positive: ${publishedAtBlock}`,
      );
    }

    const registryCandidate =
      options.identityRegistry ?? getIdentityRegistryAddress(chainId);
    if (!registryCandidate) {
      throw new Error(`IdentityRegistry is not configured for chainId ${chainId}`);
    }
    let registry: Address;
    try {
      registry = getAddress(registryCandidate);
    } catch {
      throw new Error(`IdentityRegistry address is invalid for chainId ${chainId}`);
    }

    const key = `${chainId}:${publisherAgentId}:${publishedAtBlock}`;
    let pending = cache.get(key);
    if (!pending) {
      pending = (async () => {
        const failures: string[] = [];
        for (const [index, candidate] of clients.entries()) {
          try {
            let actualChainId = rpcChains.get(candidate);
            if (actualChainId === undefined) {
              actualChainId = await candidate.getChainId();
              // Cache only fulfilled probes. A transient rejected probe must
              // remain retryable just like a failed historical read.
              rpcChains.set(candidate, actualChainId);
            }
            if (actualChainId !== chainId) {
              throw new Error(
                `publisher Safe RPC chain ${actualChainId} does not match expected ${chainId}`,
              );
            }

            const raw = await candidate.readContract({
              address: registry,
              abi: IDENTITY_REGISTRY_GET_AGENT_WALLET_ABI,
              functionName: 'getAgentWallet',
              args: [BigInt(publisherAgentId)],
              blockNumber: publishedAtBlock,
            });
            if (typeof raw !== 'string') {
              throw new Error(
                `IdentityRegistry getAgentWallet(${publisherAgentId}) returned a non-address`,
              );
            }
            let wallet: Address;
            try {
              wallet = getAddress(raw);
            } catch {
              throw new Error(
                `IdentityRegistry getAgentWallet(${publisherAgentId}) returned an invalid address`,
              );
            }
            if (wallet.toLowerCase() === zeroAddress) {
              throw new Error(`publisher agent ${publisherAgentId} is not bound to a Safe`);
            }
            return wallet;
          } catch (error) {
            failures.push(
              `provider ${index + 1}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
        throw new Error(
          `publisher Safe resolution failed on all RPC providers: ${failures.join('; ')}`,
        );
      })();
      cache.set(key, pending);
      void pending.catch(() => {
        if (cache.get(key) === pending) cache.delete(key);
      });
    }
    return pending;
  };
}
