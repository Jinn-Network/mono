/**
 * ERC-8004 Identity Registry integration for artifact discovery.
 *
 * Registers artifacts and nodes on-chain so other operators can discover
 * them via subgraph queries. Ported from protocol/src/discovery/registry.ts.
 */

import { createPublicClient, createWalletClient, http, type Chain } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  IntentMetadataSchema,
  EnvelopeMetadataSchema,
  SourceBundleMetadataSchema,
  metadataToTuple,
  type IntentMetadata,
  type EnvelopeMetadata,
  type SourceBundleMetadata,
} from './metadata-schemas.js';

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
   * Register a published `intent.v1` CID on the Identity Registry.
   *
   * Scope §3.3: adds `adw:Intent` as an entity kind. Every published intent
   * gets registered so knowledge-tree queries can root at `intentCid`.
   *
   * `agentURI` = `intent:<cid>` — distinct from `artifact:<id>` to let subgraph
   * queries filter on URI prefix without reading metadata.
   */
  async registerIntent(params: {
    intentCid: string;
    kind: string;
    creator: string;
    createdAt: number;
    requestId: string;
  }): Promise<bigint> {
    const metadata: IntentMetadata = {
      documentType: 'adw:Intent',
      kind: params.kind,
      creator: params.creator,
      createdAt: params.createdAt,
      requestId: params.requestId,
    };
    IntentMetadataSchema.parse(metadata);
    return this._register(`intent:${params.intentCid}`, metadataToTuple(metadata));
  }

  /**
   * Register a published `jinn.execution.v1` envelope CID on the Identity
   * Registry.
   *
   * Scope §3.3: adds `adw:ExecutionEnvelope` as an entity kind. Every
   * published envelope gets registered.
   *
   * `agentURI` = `envelope:<cid>`.
   */
  async registerEnvelope(params: {
    envelopeCid: string;
    kind: string;
    role: 'restoration' | 'verdict';
    evidenceTier: EnvelopeMetadata['evidenceTier'];
    intentCid: string;
    parentEnvelopeCid?: string;
    measurement?: string;
    participant: string;
    generatedAt: number;
  }): Promise<bigint> {
    const metadata: EnvelopeMetadata = {
      documentType: 'adw:ExecutionEnvelope',
      kind: params.kind,
      role: params.role,
      evidenceTier: params.evidenceTier,
      intentCid: params.intentCid,
      ...(params.parentEnvelopeCid ? { parentEnvelopeCid: params.parentEnvelopeCid } : {}),
      ...(params.measurement ? { measurement: params.measurement as `0x${string}` } : {}),
      participant: params.participant,
      generatedAt: params.generatedAt,
    };
    EnvelopeMetadataSchema.parse(metadata);
    return this._register(`envelope:${params.envelopeCid}`, metadataToTuple(metadata));
  }

  /**
   * Register an `adw:SourceBundle` — the IPFS-pinned source-code bundle that
   * an operator builds their executor from. Called once per release, not per
   * envelope. Referenced by every envelope via `executor.source.bundleCid`.
   *
   * Scope §3.1 K4: "Source bundle is a first-class ERC-8004 entity."
   *
   * `agentURI` = `source:<cid>`.
   */
  async registerSourceBundle(params: {
    bundleCid: string;
    measurement: string;
    buildRecipeKind: SourceBundleMetadata['buildRecipeKind'];
    publishedBy: string;
    humanUrl?: string;
  }): Promise<bigint> {
    const metadata: SourceBundleMetadata = {
      documentType: 'adw:SourceBundle',
      measurement: params.measurement as `0x${string}`,
      buildRecipeKind: params.buildRecipeKind,
      publishedBy: params.publishedBy,
      ...(params.humanUrl ? { humanUrl: params.humanUrl } : {}),
    };
    SourceBundleMetadataSchema.parse(metadata);
    return this._register(`source:${params.bundleCid}`, metadataToTuple(metadata));
  }

  /**
   * Register an `adw:Artifact` with an explicit `parentEnvelopeCid` back-pointer
   * to the envelope that produced it. New in Plan E per scope §3.3. Existing
   * `registerArtifact` method remains for callers that don't yet know the
   * parent envelope CID at registration time (legacy path).
   */
  async registerArtifactWithParent(artifact: {
    id: string;
    title: string;
    tags: string[];
    outcome: string;
    endpoint: string;
    parentEnvelopeCid: string;
  }): Promise<bigint> {
    const metadata = {
      documentType: 'adw:Artifact' as const,
      artifactId: artifact.id,
      title: artifact.title,
      tags: artifact.tags,
      outcome: artifact.outcome,
      endpoint: artifact.endpoint,
      parentEnvelopeCid: artifact.parentEnvelopeCid,
    };
    return this._register(`artifact:${artifact.id}`, metadataToTuple(metadata));
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
