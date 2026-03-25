import {
  createPublicClient,
  createWalletClient,
  http,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
  type Chain,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import { SAFE_ABI } from './types.js';

export function buildSafeSignature(signerAddress: string): Hex {
  const r = signerAddress.toLowerCase().replace('0x', '').padStart(64, '0');
  const s = '0'.repeat(64);
  const v = '01';
  return `0x${r}${s}${v}` as Hex;
}

export interface SafeTransactionParams {
  safeAddress: Address;
  to: Address;
  value: bigint;
  data: Hex;
}

// Per-Safe transaction lock to prevent nonce races when concurrent
// loops (creator + restorer) share the same Safe
const safeLocks = new Map<string, Promise<void>>();

export async function executeSafeTransaction(
  publicClient: PublicClient,
  walletClient: WalletClient,
  params: SafeTransactionParams,
): Promise<Hex> {
  const lockKey = params.safeAddress.toLowerCase();

  // Wait for any pending transaction on this Safe to complete
  const pending = safeLocks.get(lockKey) ?? Promise.resolve();

  let releaseLock!: () => void;
  const newLock = new Promise<void>(resolve => { releaseLock = resolve; });
  safeLocks.set(lockKey, newLock);

  await pending;

  try {
    return await executeSafeTransactionInner(publicClient, walletClient, params);
  } finally {
    releaseLock();
  }
}

async function executeSafeTransactionInner(
  publicClient: PublicClient,
  walletClient: WalletClient,
  params: SafeTransactionParams,
): Promise<Hex> {
  const { safeAddress, to, value, data } = params;
  const account = walletClient.account;
  if (!account) throw new Error('Wallet client has no account');

  const nonce = await publicClient.readContract({
    address: safeAddress,
    abi: SAFE_ABI,
    functionName: 'nonce',
  });

  const txHash = await publicClient.readContract({
    address: safeAddress,
    abi: SAFE_ABI,
    functionName: 'getTransactionHash',
    args: [to, value, data, 0, 0n, 0n, 0n, '0x0000000000000000000000000000000000000000' as Address, '0x0000000000000000000000000000000000000000' as Address, nonce],
  });

  const ethSignature = await walletClient.signMessage({
    account,
    message: { raw: txHash as Hex },
  });

  const sigBytes = Buffer.from((ethSignature as string).slice(2), 'hex');
  sigBytes[64] = sigBytes[64] + 4;
  const safeSignature = `0x${sigBytes.toString('hex')}` as Hex;

  const hash = await walletClient.writeContract({
    address: safeAddress,
    abi: SAFE_ABI,
    functionName: 'execTransaction',
    args: [to, value, data, 0, 0n, 0n, 0n, '0x0000000000000000000000000000000000000000' as Address, '0x0000000000000000000000000000000000000000' as Address, safeSignature],
    account,
    chain: walletClient.chain,
  });

  return hash;
}

export function createClients(rpcUrl: string, privateKey: Hex, chain?: Chain): { publicClient: PublicClient; walletClient: WalletClient; account: ReturnType<typeof privateKeyToAccount> } {
  const account = privateKeyToAccount(privateKey);
  const selectedChain = chain ?? base;

  const publicClient = createPublicClient({
    chain: selectedChain,
    transport: http(rpcUrl),
  });

  const walletClient = createWalletClient({
    account,
    chain: selectedChain,
    transport: http(rpcUrl),
  });

  return { publicClient: publicClient as unknown as PublicClient, walletClient: walletClient as unknown as WalletClient, account };
}
