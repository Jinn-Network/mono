// SPDX-License-Identifier: Apache-2.0

import {
  createPublicClient,
  getAddress,
  http,
  zeroAddress,
  type Address,
} from "viem";
import type { ChainFactResolver } from "@jinn-network/trust-core";

import { ERC721_OWNER_OF_ABI, IDENTITY_REGISTRY_GET_AGENT_WALLET_ABI } from "./abis.js";
import { invalidInput, resolutionFailed } from "./errors.js";

// ---------------------------------------------------------------------------
// Promotes `client/src/erc8004/publisher-safe-resolver.ts` (multi-provider
// fallback, per-provider chain-id validation, immutable caching) into the
// `ChainFactResolver` interface `trust-core` defines (§17 I/O split). The
// one behavioral change from the client-internal precedent: the
// IdentityRegistry address arrives via `options.identityRegistry` -- this
// package does not import a client-internal address table
// (`getIdentityRegistryAddress`); the caller/deployment profile supplies it.
// ---------------------------------------------------------------------------

/** Structural injection seam for hermetic tests -- mirrors viem's
 * `PublicClient.getChainId`/`readContract` surface exactly enough to be
 * satisfied by either a real `createPublicClient` or a fake. */
export interface RegistryReadClient {
  getChainId: () => Promise<number>;
  readContract: (args: {
    address: Address;
    abi: typeof IDENTITY_REGISTRY_GET_AGENT_WALLET_ABI | typeof ERC721_OWNER_OF_ABI;
    functionName: "getAgentWallet" | "ownerOf";
    args: readonly [bigint];
    blockNumber?: bigint;
  }) => Promise<unknown>;
}

export interface ChainFactResolverOptions {
  readonly rpcUrl: string;
  readonly expectedChainId?: number;
  /** The IdentityRegistry contract address this resolver reads -- supplied
   * by the caller/deployment profile (no client-internal address table). */
  readonly identityRegistry: string;
  /** Structural injection seam for hermetic tests. */
  readonly client?: RegistryReadClient;
  /** Additional injected clients, tried sequentially after `client`. */
  readonly fallbackClients?: readonly RegistryReadClient[];
  /** Additional RPC URLs, tried sequentially after `rpcUrl`. */
  readonly fallbackRpcUrls?: readonly string[];
}

const CAIP19_AGENT_PATTERN = /^eip155:([0-9]+)\/erc721:(0x[0-9a-fA-F]{40})\/([1-9][0-9]*)$/;

/**
 * Builds a `ChainFactResolver` (`trust-core`'s injected interface) bound to
 * one IdentityRegistry deployment on one chain: `ownerOf` reads the
 * ERC-721 owner of a CAIP-19-named agent asset (validating the CAIP-19's
 * embedded chain and registry match this resolver's configuration before
 * reading); `getAgentWalletAtBlock` reads the ERC-8004 `agentWallet`
 * mapping at a historical block (§7.2's composition leg + §7.3's at-time
 * resolution).
 */
export function createChainFactResolver(options: ChainFactResolverOptions): ChainFactResolver {
  const primaryClient: RegistryReadClient =
    options.client
    ?? (createPublicClient({ transport: http(options.rpcUrl) }) as unknown as RegistryReadClient);
  const fallbackUrls = (options.fallbackRpcUrls ?? []).filter((url) => url !== options.rpcUrl);
  const clients: readonly RegistryReadClient[] = [
    primaryClient,
    ...(options.fallbackClients ?? []),
    ...fallbackUrls.map(
      (url) => createPublicClient({ transport: http(url) }) as unknown as RegistryReadClient,
    ),
  ];

  let registry: Address;
  try {
    registry = getAddress(options.identityRegistry);
  } catch {
    invalidInput(`identityRegistry address is invalid: "${options.identityRegistry}".`);
  }

  const rpcChains = new Map<RegistryReadClient, number>();
  const walletCache = new Map<string, Promise<string>>();
  const ownerCache = new Map<string, Promise<string>>();

  async function readAcrossProviders<T>(read: (client: RegistryReadClient) => Promise<T>): Promise<T> {
    const failures: string[] = [];
    for (const [index, candidate] of clients.entries()) {
      try {
        let actualChainId = rpcChains.get(candidate);
        if (actualChainId === undefined) {
          actualChainId = await candidate.getChainId();
          // Cache only fulfilled probes -- a transient rejected probe must
          // remain retryable just like a failed historical read.
          rpcChains.set(candidate, actualChainId);
        }
        if (options.expectedChainId !== undefined && actualChainId !== options.expectedChainId) {
          throw new Error(
            `trust-resolve RPC chain ${actualChainId} does not match expected ${options.expectedChainId}`,
          );
        }
        return await read(candidate);
      } catch (error) {
        failures.push(`provider ${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    resolutionFailed(`chain-fact resolution failed on all RPC providers: ${failures.join("; ")}`);
  }

  function memoize(cache: Map<string, Promise<string>>, key: string, produce: () => Promise<string>): Promise<string> {
    let pending = cache.get(key);
    if (!pending) {
      pending = produce();
      cache.set(key, pending);
      void pending.catch(() => {
        if (cache.get(key) === pending) cache.delete(key);
      });
    }
    return pending;
  }

  return {
    async getAgentWalletAtBlock(agentId: string, block: number): Promise<string> {
      if (!/^[1-9][0-9]*$/.test(agentId)) {
        invalidInput(`agentId must be a positive decimal: "${agentId}".`);
      }
      if (!Number.isSafeInteger(block) || block <= 0) {
        invalidInput(`block must be a positive safe integer: ${block}.`);
      }
      return memoize(walletCache, `${agentId}:${block}`, () => readAcrossProviders(async (client) => {
        const raw = await client.readContract({
          address: registry,
          abi: IDENTITY_REGISTRY_GET_AGENT_WALLET_ABI,
          functionName: "getAgentWallet",
          args: [BigInt(agentId)],
          blockNumber: BigInt(block),
        });
        if (typeof raw !== "string") {
          throw new Error(`getAgentWallet(${agentId}) returned a non-address`);
        }
        let wallet: Address;
        try {
          wallet = getAddress(raw);
        } catch {
          throw new Error(`getAgentWallet(${agentId}) returned an invalid address`);
        }
        if (wallet.toLowerCase() === zeroAddress) {
          throw new Error(`agentId ${agentId} is not bound to a wallet`);
        }
        return wallet;
      }));
    },

    async ownerOf(caip19Agent: string): Promise<string> {
      const match = CAIP19_AGENT_PATTERN.exec(caip19Agent);
      if (!match) {
        invalidInput(`"${caip19Agent}" is not a CAIP-19 agent asset ID (eip155:<chainId>/erc721:0x<registry>/<agentId>).`);
      }
      const [, chainIdText, registryText, agentId] = match;
      const claimedChainId = Number(chainIdText);
      if (options.expectedChainId !== undefined && claimedChainId !== options.expectedChainId) {
        invalidInput(
          `CAIP-19 chain "${claimedChainId}" does not match this resolver's chain "${options.expectedChainId}".`,
        );
      }
      let claimedRegistry: Address;
      try {
        claimedRegistry = getAddress(registryText!);
      } catch {
        invalidInput(`CAIP-19 registry address is invalid: "${registryText}".`);
      }
      if (claimedRegistry !== registry) {
        invalidInput(
          `CAIP-19 registry "${claimedRegistry}" does not match this resolver's registry "${registry}".`,
        );
      }

      return memoize(ownerCache, agentId!, () => readAcrossProviders(async (client) => {
        const raw = await client.readContract({
          address: registry,
          abi: ERC721_OWNER_OF_ABI,
          functionName: "ownerOf",
          args: [BigInt(agentId!)],
        });
        if (typeof raw !== "string") {
          throw new Error(`ownerOf(${agentId}) returned a non-address`);
        }
        try {
          return getAddress(raw);
        } catch {
          throw new Error(`ownerOf(${agentId}) returned an invalid address`);
        }
      }));
    },
  };
}
