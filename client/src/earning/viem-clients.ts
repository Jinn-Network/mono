/**
 * Shared viem PublicClient / WalletClient wiring for fleet earning + CLI.
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
import { base, baseSepolia } from 'viem/chains';
import type { PrivateKeyAccount } from 'viem/accounts';

export type JinnOnchainNetwork = 'base' | 'base-sepolia';

export function jinnChain(network: JinnOnchainNetwork): Chain {
  return network === 'base-sepolia' ? baseSepolia : base;
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
