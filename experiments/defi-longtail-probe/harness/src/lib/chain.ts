import { createPublicClient, createWalletClient, http, defineChain, type PublicClient, type WalletClient, type Account } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { rpc } from './anvil.js';

export function chainFor(rpcUrl: string, chainId: number) {
  return defineChain({
    id: chainId,
    name: `local-${chainId}`,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
}

export async function detectChainId(rpcUrl: string): Promise<number> {
  const hex = (await rpc(rpcUrl, 'eth_chainId')) as string;
  return Number.parseInt(hex, 16);
}

export interface Clients {
  chainId: number;
  pub: PublicClient;
  wallet: (account: Account) => WalletClient;
}

export async function makeClients(rpcUrl: string): Promise<Clients> {
  const chainId = await detectChainId(rpcUrl);
  const chain = chainFor(rpcUrl, chainId);
  const pub = createPublicClient({ chain, transport: http(rpcUrl) }) as PublicClient;
  return {
    chainId,
    pub,
    wallet: (account: Account) => createWalletClient({ chain, transport: http(rpcUrl), account }),
  };
}

export function freshAccount(): { key: `0x${string}`; account: Account } {
  const key = generatePrivateKey();
  return { key, account: privateKeyToAccount(key) };
}

export async function fund(rpcUrl: string, address: string, eth: number): Promise<void> {
  const wei = BigInt(Math.round(eth * 1e6)) * 10n ** 12n;
  await rpc(rpcUrl, 'anvil_setBalance', [address, `0x${wei.toString(16)}`]);
}
