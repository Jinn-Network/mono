/**
 * ERC-8004 Identity Registry integration for artifact discovery.
 *
 * Registers artifacts and nodes on-chain so other operators can discover
 * them via subgraph queries. Ported from protocol/src/discovery/registry.ts.
 */

import { createPublicClient, createWalletClient, http, type Chain } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

type Hex = `0x${string}`;

export interface RegistryConfig {
  /** CAIP-2 chain identifier, e.g. 'eip155:8453' */
  chainId: string;
  /** EVM address of the 8004 Identity Registry contract */
  contractAddress: string;
  /** Hex private key for signing transactions */
  privateKey: string;
  /** Optional RPC URL override */
  rpcUrl?: string;
}

const IDENTITY_REGISTRY_ABI = [
  {
    name: 'register',
    type: 'function',
    inputs: [
      { name: 'agentURI', type: 'string' },
      {
        name: 'metadata',
        type: 'tuple[]',
        components: [
          { name: 'metadataKey', type: 'string' },
          { name: 'metadataValue', type: 'bytes' },
        ],
      },
    ],
    outputs: [{ name: 'agentId', type: 'uint256' }],
    stateMutability: 'nonpayable',
  },
] as const;

const DEFAULT_RPC_URLS: Record<string, string> = {
  'eip155:8453': 'https://mainnet.base.org',
  'eip155:84532': 'https://sepolia.base.org',
};

function encodeMetadataValue(value: string): Hex {
  return ('0x' + Buffer.from(value).toString('hex')) as Hex;
}

function getChainId(caip2: string): number {
  const parts = caip2.split(':');
  if (parts.length !== 2 || parts[0] !== 'eip155') {
    throw new Error(`Unsupported CAIP-2 format: ${caip2}`);
  }
  return parseInt(parts[1]!, 10);
}

export class Registry8004 {
  private readonly walletClient: ReturnType<typeof createWalletClient>;
  private readonly publicClient: ReturnType<typeof createPublicClient>;
  private readonly account: ReturnType<typeof privateKeyToAccount>;
  private readonly chain: Chain;
  private readonly contractAddress: Hex;

  constructor(config: RegistryConfig) {
    const rpcUrl = config.rpcUrl ?? DEFAULT_RPC_URLS[config.chainId];
    if (!rpcUrl) throw new Error(`No RPC URL for chain ${config.chainId}`);

    const chainId = getChainId(config.chainId);
    this.chain = {
      id: chainId,
      name: `chain-${chainId}`,
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: [rpcUrl] } },
    } as Chain;

    const pk = (config.privateKey.startsWith('0x') ? config.privateKey : `0x${config.privateKey}`) as Hex;
    this.account = privateKeyToAccount(pk);
    this.publicClient = createPublicClient({ chain: this.chain, transport: http(rpcUrl) });
    this.walletClient = createWalletClient({ account: this.account, chain: this.chain, transport: http(rpcUrl) });
    this.contractAddress = config.contractAddress as Hex;
  }

  private async _register(
    uri: string,
    metadata: Array<{ metadataKey: string; metadataValue: Hex }>,
  ): Promise<bigint> {
    const hash = await this.walletClient.writeContract({
      address: this.contractAddress,
      abi: IDENTITY_REGISTRY_ABI,
      functionName: 'register',
      args: [uri, metadata],
      account: this.account,
      chain: this.chain,
    });

    const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
    return BigInt(receipt.blockNumber);
  }

  /**
   * Register this node on the 8004 Identity Registry.
   */
  async registerNode(nodeInfo: {
    endpoint: string;
    ownerAddress: string;
    price?: string;
  }): Promise<bigint> {
    const metadata = [
      { metadataKey: 'documentType', metadataValue: encodeMetadataValue('adw:AgentCard') },
      { metadataKey: 'endpoint', metadataValue: encodeMetadataValue(nodeInfo.endpoint) },
      { metadataKey: 'ownerAddress', metadataValue: encodeMetadataValue(nodeInfo.ownerAddress) },
      { metadataKey: 'price', metadataValue: encodeMetadataValue(nodeInfo.price ?? '$0') },
    ];
    return this._register(nodeInfo.endpoint, metadata);
  }

  /**
   * Register an artifact on the 8004 Identity Registry.
   */
  async registerArtifact(artifact: {
    id: string;
    title: string;
    tags: string[];
    outcome: string;
    endpoint: string;
  }): Promise<bigint> {
    const metadata = [
      { metadataKey: 'documentType', metadataValue: encodeMetadataValue('adw:Artifact') },
      { metadataKey: 'artifactId', metadataValue: encodeMetadataValue(artifact.id) },
      { metadataKey: 'title', metadataValue: encodeMetadataValue(artifact.title) },
      { metadataKey: 'outcome', metadataValue: encodeMetadataValue(artifact.outcome) },
      { metadataKey: 'tags', metadataValue: encodeMetadataValue(JSON.stringify(artifact.tags)) },
      { metadataKey: 'endpoint', metadataValue: encodeMetadataValue(artifact.endpoint) },
    ];
    return this._register(`artifact:${artifact.id}`, metadata);
  }
}
