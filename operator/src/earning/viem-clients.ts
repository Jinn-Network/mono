/**
 * Shared viem PublicClient / WalletClient wiring for fleet earning + CLI.
 *
 * One chain family: the L2 measurement chain (Base / Base Sepolia). The
 * Ethereum-L1 governance-chain clients were removed in the tokenless-OLAS
 * pivot along with the cross-chain JINN claim loop.
 *
 * RPC input shape: every factory accepts `string | readonly string[]`. A
 * single URL is wrapped into a 1-slot fallback chain (back-compat); an array
 * (or comma-separated string) produces a multi-slot viem `fallback()` per
 * issue #592. See `src/rpc/transport.ts` for the helper.
 */

import {
  createPublicClient,
  createWalletClient,
  type Chain,
  type PublicClient,
  type Transport,
  type WalletClient,
} from 'viem';
import { base, baseSepolia } from 'viem/chains';
import type { PrivateKeyAccount } from 'viem/accounts';
import { buildFallbackTransport, parseRpcUrls } from '../rpc/transport.js';

export type JinnOnchainNetwork = 'base' | 'base-sepolia';

/** Accept a single URL, an array of URLs, or a comma-separated string. */
export type RpcUrlInput = string | readonly string[];

export function jinnChain(network: JinnOnchainNetwork): Chain {
  return network === 'base-sepolia' ? baseSepolia : base;
}

function transportFor(rpcUrl: RpcUrlInput) {
  return buildFallbackTransport(parseRpcUrls(rpcUrl));
}

export function createJinnPublicClient(
  rpcUrl: RpcUrlInput,
  network: JinnOnchainNetwork,
): PublicClient<Transport, Chain> {
  return createPublicClient({
    chain: jinnChain(network),
    transport: transportFor(rpcUrl),
  });
}

export function createJinnWalletClient(
  rpcUrl: RpcUrlInput,
  network: JinnOnchainNetwork,
  account: PrivateKeyAccount,
): WalletClient<Transport, Chain, PrivateKeyAccount> {
  return createWalletClient({
    account,
    chain: jinnChain(network),
    transport: transportFor(rpcUrl),
  });
}
