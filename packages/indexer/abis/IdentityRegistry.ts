/**
 * IdentityRegistry ABI slice — the MetadataSet event that the indexer
 * consumes for SolverNetManifest and Envelope entities.
 *
 * Sourced from operator/src/corpus/onchain-query.ts and
 * operator/src/erc8004/abis.ts.
 *
 * Deployed addresses:
 *   Base Sepolia (84532): 0x8004A818BFB912233c491871b3d84c89A494BD9e
 *   Base mainnet (8453):  0x8004A169FB4a3325136EB29fA0ceB6D2e539a432
 */
export const IDENTITY_REGISTRY_ABI = [
  {
    type: 'event',
    name: 'MetadataSet',
    inputs: [
      { name: 'agentId', type: 'uint256', indexed: true },
      { name: 'indexedMetadataKey', type: 'string', indexed: true },
      { name: 'metadataKey', type: 'string', indexed: false },
      { name: 'metadataValue', type: 'bytes', indexed: false },
    ],
  },
  {
    type: 'function',
    name: 'setMetadata',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'agentId', type: 'uint256' },
      { name: 'metadataKey', type: 'string' },
      { name: 'metadataValue', type: 'bytes' },
    ],
    outputs: [],
  },
] as const;
