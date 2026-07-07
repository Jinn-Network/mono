/**
 * Shared viem PublicClient / WalletClient wiring for fleet earning + CLI.
 *
 * Two chain families: the L2 measurement chain (Base / Base Sepolia) and the
 * L1 governance chain (Ethereum mainnet / Sepolia). The cross-chain JINN
 * claim loop (jinn-mono-7x5) needs both — it emits ClaimTicket on L2 and
 * submits proofs on L1.
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
import { base, baseSepolia, mainnet, sepolia } from 'viem/chains';
import type { PrivateKeyAccount } from 'viem/accounts';
import { buildFallbackTransport, parseRpcUrls } from '../rpc/transport.js';

export type JinnOnchainNetwork = 'base' | 'base-sepolia';

/** L1 governance chain network — JINN token + Distributor + Messenger live here. */
export type JinnL1Network = 'sepolia' | 'ethereum';

/** Accept a single URL, an array of URLs, or a comma-separated string. */
export type RpcUrlInput = string | readonly string[];

export function jinnChain(network: JinnOnchainNetwork): Chain {
  return network === 'base-sepolia' ? baseSepolia : base;
}

export function jinnL1Chain(network: JinnL1Network): Chain {
  return network === 'sepolia' ? sepolia : mainnet;
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

/**
 * PublicClient for the L1 governance chain. Used by the cross-chain claim
 * loop to read distributor state, build OP-Stack proofs (canonical mode) and
 * submit `JinnDistributor.claim`.
 */
export function createJinnL1PublicClient(
  rpcUrl: RpcUrlInput,
  network: JinnL1Network,
): PublicClient<Transport, Chain> {
  return createPublicClient({
    chain: jinnL1Chain(network),
    transport: transportFor(rpcUrl),
  });
}

/**
 * WalletClient for the L1 governance chain. The daemon's master wallet is
 * the default signer — same key that pays for L2 stOLAS reward claims and
 * bootstrap.
 */
export function createJinnL1WalletClient(
  rpcUrl: RpcUrlInput,
  network: JinnL1Network,
  account: PrivateKeyAccount,
): WalletClient<Transport, Chain, PrivateKeyAccount> {
  return createWalletClient({
    account,
    chain: jinnL1Chain(network),
    transport: transportFor(rpcUrl),
  });
}
