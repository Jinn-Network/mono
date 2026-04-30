/**
 * Shared viem PublicClient / WalletClient wiring for fleet earning + CLI.
 *
 * Two chain families: the L2 measurement chain (Base / Base Sepolia) and the
 * L1 governance chain (Ethereum mainnet / Sepolia). The cross-chain JINN
 * claim loop (jinn-mono-7x5) needs both — it emits ClaimTicket on L2 and
 * submits proofs on L1.
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  type Chain,
  type PublicClient,
  type Transport,
  type WalletClient,
} from 'viem';
import { base, baseSepolia, mainnet, sepolia } from 'viem/chains';
import type { PrivateKeyAccount } from 'viem/accounts';

export type JinnOnchainNetwork = 'base' | 'base-sepolia';

/** L1 governance chain network — JINN token + Distributor + Messenger live here. */
export type JinnL1Network = 'sepolia' | 'ethereum';

export function jinnChain(network: JinnOnchainNetwork): Chain {
  return network === 'base-sepolia' ? baseSepolia : base;
}

export function jinnL1Chain(network: JinnL1Network): Chain {
  return network === 'sepolia' ? sepolia : mainnet;
}

export function createJinnPublicClient(
  rpcUrl: string,
  network: JinnOnchainNetwork,
): PublicClient<Transport, Chain> {
  return createPublicClient({
    chain: jinnChain(network),
    transport: http(rpcUrl),
  });
}

export function createJinnWalletClient(
  rpcUrl: string,
  network: JinnOnchainNetwork,
  account: PrivateKeyAccount,
): WalletClient<Transport, Chain, PrivateKeyAccount> {
  return createWalletClient({
    account,
    chain: jinnChain(network),
    transport: http(rpcUrl),
  });
}

/**
 * PublicClient for the L1 governance chain. Used by the cross-chain claim
 * loop to read distributor state, build OP-Stack proofs (canonical mode) and
 * submit `JinnDistributor.claim`.
 */
export function createJinnL1PublicClient(
  rpcUrl: string,
  network: JinnL1Network,
): PublicClient<Transport, Chain> {
  return createPublicClient({
    chain: jinnL1Chain(network),
    transport: http(rpcUrl),
  });
}

/**
 * WalletClient for the L1 governance chain. The daemon's master wallet is
 * the default signer — same key that pays for L2 stOLAS reward claims and
 * bootstrap.
 */
export function createJinnL1WalletClient(
  rpcUrl: string,
  network: JinnL1Network,
  account: PrivateKeyAccount,
): WalletClient<Transport, Chain, PrivateKeyAccount> {
  return createWalletClient({
    account,
    chain: jinnL1Chain(network),
    transport: http(rpcUrl),
  });
}
