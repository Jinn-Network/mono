/**
 * x402 local facilitator — verifies and settles EVM payments.
 * Ported from protocol/src/x402/facilitator.ts.
 */

import { x402Facilitator } from '@x402/core/facilitator';
import { registerExactEvmScheme } from '@x402/evm/exact/facilitator';
import { toFacilitatorEvmSigner } from '@x402/evm';
import { privateKeyToAccount } from 'viem/accounts';
import { createWalletClient, http, createPublicClient } from 'viem';
import { base, baseSepolia } from 'viem/chains';
import type { Chain } from 'viem';
import type { FacilitatorClient } from '@x402/core/server';
import type { Network } from '@x402/core/types';

type Hex = `0x${string}`;

export interface X402FacilitatorConfig {
  privateKey: string;
  network?: string;  // CAIP-2 format, default 'eip155:8453'
  rpcUrl?: string;
}

const CHAIN_MAP: Record<string, Chain> = {
  'eip155:8453': base,
  'eip155:84532': baseSepolia,
};

export function createLocalFacilitatorClient(config: X402FacilitatorConfig): FacilitatorClient {
  const networkStr = config.network ?? 'eip155:8453';
  const chain = CHAIN_MAP[networkStr];
  if (!chain) throw new Error(`Unsupported network: ${networkStr}`);

  const network = networkStr as Network;
  const pk = (config.privateKey.startsWith('0x') ? config.privateKey : `0x${config.privateKey}`) as Hex;
  const account = privateKeyToAccount(pk);

  const walletClient = createWalletClient({
    account,
    chain,
    transport: http(config.rpcUrl),
  });

  const publicClient = createPublicClient({
    chain,
    transport: http(config.rpcUrl),
  });

  const facilitatorSigner = toFacilitatorEvmSigner({
    address: account.address as Hex,
    readContract: (args) => publicClient.readContract(args as Parameters<typeof publicClient.readContract>[0]),
    verifyTypedData: (args) => publicClient.verifyTypedData(args as Parameters<typeof publicClient.verifyTypedData>[0]),
    writeContract: async (args) => walletClient.writeContract(args as Parameters<typeof walletClient.writeContract>[0]),
    sendTransaction: async (args) => walletClient.sendTransaction(args as Parameters<typeof walletClient.sendTransaction>[0]),
    waitForTransactionReceipt: async (args) => publicClient.waitForTransactionReceipt(args as Parameters<typeof publicClient.waitForTransactionReceipt>[0]),
    getCode: async (args) => publicClient.getCode(args as Parameters<typeof publicClient.getCode>[0]),
  });

  const facilitator = new x402Facilitator();
  registerExactEvmScheme(facilitator, {
    signer: facilitatorSigner,
    networks: network,
  });

  return {
    verify: (payload, requirements) => facilitator.verify(payload, requirements),
    settle: (payload, requirements) => facilitator.settle(payload, requirements),
    getSupported: () => Promise.resolve(facilitator.getSupported() as unknown as Awaited<ReturnType<FacilitatorClient['getSupported']>>),
  };
}
