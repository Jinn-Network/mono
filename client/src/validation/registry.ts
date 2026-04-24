/**
 * ERC-8004 Validation Registry client.
 *
 * Scope: docs/superpowers/specs/2026-04-23-jinn-execution-envelope-tee-scope.md
 * §3.3 — "Validation Registry hosts challenger verifications — a
 * validationRequest ('re-verify this envelope's attestation + reproducible
 * build') and validationResponse with the verdict."
 *
 * Split from the Identity Registry because the Validation Registry is a
 * *distinct* on-chain contract in ERC-8004. Same (agentURI, uri) shape for
 * calls; different contract address.
 *
 * V1 ships the client; actual challenger workflows (who calls this, when,
 * with what SDK output) are Plan F / V2.
 */

import { createPublicClient, createWalletClient, http, type Chain, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

export interface ValidationRegistryConfig {
  chainId: string;                // CAIP-2
  contractAddress: string;
  privateKey: string;
  rpcUrl?: string;
}

// Minimal Validation Registry ABI fragment — adjust against the deployed
// contract if signatures differ. ERC-8004 spec as of this writing:
//   createValidationRequest(string entityUri, string requestUri) returns (uint256)
//   createValidationResponse(uint256 requestId, string responseUri)
const VALIDATION_REGISTRY_ABI = [
  {
    name: 'createValidationRequest',
    type: 'function',
    inputs: [
      { name: 'entityUri', type: 'string' },
      { name: 'requestUri', type: 'string' },
    ],
    outputs: [{ name: 'requestId', type: 'uint256' }],
    stateMutability: 'nonpayable',
  },
  {
    name: 'createValidationResponse',
    type: 'function',
    inputs: [
      { name: 'requestId', type: 'uint256' },
      { name: 'responseUri', type: 'string' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
] as const;

const DEFAULT_RPC_URLS: Record<string, string> = {
  'eip155:8453': 'https://mainnet.base.org',
  'eip155:84532': 'https://sepolia.base.org',
};

function getChainId(caip2: string): number {
  const parts = caip2.split(':');
  if (parts.length !== 2 || parts[0] !== 'eip155') {
    throw new Error(`Unsupported CAIP-2 format: ${caip2}`);
  }
  return parseInt(parts[1]!, 10);
}

export class ValidationRegistry8004 {
  private readonly walletClient: ReturnType<typeof createWalletClient>;
  private readonly publicClient: ReturnType<typeof createPublicClient>;
  private readonly account: ReturnType<typeof privateKeyToAccount>;
  private readonly chain: Chain;
  private readonly contractAddress: Hex;

  constructor(config: ValidationRegistryConfig) {
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
    this.walletClient = createWalletClient({
      account: this.account,
      chain: this.chain,
      transport: http(rpcUrl),
    });
    this.contractAddress = config.contractAddress as Hex;
  }

  /**
   * Open a validation request for the given envelope.
   *
   * `requestType = 'attestation-verify'` is the V1 shape; the underlying
   * contract doesn't know about the distinction — it treats requestUri as
   * opaque. The consumer of the emitted event decodes `requestUri` (an IPFS
   * URI pointing to an `AttestationVerifyRequest` JSON blob).
   */
  async submitValidationRequest(params: {
    envelopeCid: string;
    requestType: 'attestation-verify';
    requestUri: string;
  }): Promise<{ txHash: Hex; blockNumber: bigint }> {
    const entityUri = `envelope:${params.envelopeCid}`;
    const txHash = await this.walletClient.writeContract({
      address: this.contractAddress,
      abi: VALIDATION_REGISTRY_ABI,
      functionName: 'createValidationRequest',
      args: [entityUri, params.requestUri],
      account: this.account,
      chain: this.chain,
    });
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash: txHash });
    return { txHash, blockNumber: BigInt(receipt.blockNumber) };
  }

  /**
   * Post a validation response. `requestId` is the `uint256` ID returned by
   * the prior `createValidationRequest` call (read from the emitted event).
   * `responseUri` points to an IPFS-pinned `AttestationVerifyResponse` blob.
   */
  async submitValidationResponse(params: {
    requestId: bigint;
    responseUri: string;
  }): Promise<{ txHash: Hex; blockNumber: bigint }> {
    const txHash = await this.walletClient.writeContract({
      address: this.contractAddress,
      abi: VALIDATION_REGISTRY_ABI,
      functionName: 'createValidationResponse',
      args: [params.requestId, params.responseUri],
      account: this.account,
      chain: this.chain,
    });
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash: txHash });
    return { txHash, blockNumber: BigInt(receipt.blockNumber) };
  }
}
