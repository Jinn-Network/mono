export interface MechAdapterConfig {
  rpcUrl: string;
  mechMarketplaceAddress: `0x${string}`;
  routerAddress: `0x${string}`;  // JinnRouter proxy on Base
  mechContractAddress: `0x${string}`;
  safeAddress: `0x${string}`;
  agentEoaPrivateKey: `0x${string}`;
  ipfsRegistryUrl: string;  // Upload endpoint (e.g., https://registry.autonolas.tech)
  ipfsGatewayUrl: string;   // Read endpoint (e.g., https://gateway.autonolas.tech)
  pollIntervalMs: number;
  chainId: number;
}

export const MECH_MARKETPLACE_ABI = [
  {
    name: 'request',
    type: 'function',
    stateMutability: 'payable',
    inputs: [
      { name: 'requestData', type: 'bytes' },
      { name: 'maxDeliveryRate', type: 'uint256' },
      { name: 'paymentType', type: 'bytes32' },
      { name: 'priorityMech', type: 'address' },
      { name: 'responseTimeout', type: 'uint256' },
      { name: 'paymentData', type: 'bytes' },
    ],
    outputs: [{ name: 'requestId', type: 'bytes32' }],
  },
  {
    name: 'mapRequestCounts',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'requester', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'minResponseTimeout',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'maxResponseTimeout',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'mapRequestIdInfos',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'requestId', type: 'bytes32' }],
    outputs: [
      { name: 'priorityMech', type: 'address' },
      { name: 'deliveryMech', type: 'address' },
      { name: 'requester', type: 'address' },
      { name: 'responseTimeout', type: 'uint256' },
      { name: 'deliveryRate', type: 'uint256' },
      { name: 'paymentType', type: 'bytes32' },
    ],
  },
  {
    name: 'MarketplaceRequest',
    type: 'event',
    inputs: [
      { name: 'priorityMech', type: 'address', indexed: true },
      { name: 'requester', type: 'address', indexed: true },
      { name: 'numRequests', type: 'uint256', indexed: false },
      { name: 'requestIds', type: 'bytes32[]', indexed: false },
      { name: 'requestDatas', type: 'bytes[]', indexed: false },
    ],
  },
] as const;

export const MECH_ABI = [
  {
    name: 'paymentType',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'bytes32' }],
  },
  {
    name: 'maxDeliveryRate',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'deliverToMarketplace',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'requestIds', type: 'bytes32[]' },
      { name: 'datas', type: 'bytes[]' },
    ],
    outputs: [{ name: 'deliveredRequests', type: 'bool[]' }],
  },
  {
    name: 'getOperator',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    name: 'Deliver',
    type: 'event',
    inputs: [
      { name: 'mech', type: 'address', indexed: true },
      { name: 'mechServiceMultisig', type: 'address', indexed: true },
      { name: 'requestId', type: 'bytes32', indexed: false },
      { name: 'deliveryRate', type: 'uint256', indexed: false },
      { name: 'data', type: 'bytes', indexed: false },
    ],
  },
] as const;

export const MECH_MARKETPLACE_DELIVER_ABI = [
  {
    name: 'deliverMarketplace',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'requestIds', type: 'bytes32[]' },
      { name: 'deliveryRates', type: 'uint256[]' },
    ],
    outputs: [{ name: 'deliveredRequests', type: 'bool[]' }],
  },
] as const;

export const JINN_ROUTER_ABI = [
  {
    name: 'createRestorationJob',
    type: 'function',
    stateMutability: 'payable',
    inputs: [
      { name: 'requestData', type: 'bytes' },
      { name: 'priorityMech', type: 'address' },
      { name: 'maxDeliveryRate', type: 'uint256' },
      { name: 'responseTimeout', type: 'uint256' },
      { name: 'paymentType', type: 'bytes32' },
      { name: 'paymentData', type: 'bytes' },
    ],
    outputs: [{ name: 'requestId', type: 'bytes32' }],
  },
  {
    name: 'createEvaluationJob',
    type: 'function',
    stateMutability: 'payable',
    inputs: [
      { name: 'restorationRequestId', type: 'bytes32' },
      { name: 'requestData', type: 'bytes' },
      { name: 'evaluationMech', type: 'address' },
      { name: 'maxDeliveryRate', type: 'uint256' },
      { name: 'responseTimeout', type: 'uint256' },
      { name: 'paymentType', type: 'bytes32' },
      { name: 'paymentData', type: 'bytes' },
    ],
    outputs: [{ name: 'requestId', type: 'bytes32' }],
  },
  {
    name: 'claimDelivery',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'requestId', type: 'bytes32' }],
    outputs: [],
  },
  {
    name: 'RestorationJobCreated',
    type: 'event',
    inputs: [
      { name: 'creator', type: 'address', indexed: true },
      { name: 'requestId', type: 'bytes32', indexed: true },
    ],
  },
  {
    name: 'EvaluationJobCreated',
    type: 'event',
    inputs: [
      { name: 'creator', type: 'address', indexed: true },
      { name: 'requestId', type: 'bytes32', indexed: true },
      { name: 'restorationRequestId', type: 'bytes32', indexed: true },
    ],
  },
  {
    name: 'DeliveryClaimed',
    type: 'event',
    inputs: [
      { name: 'claimer', type: 'address', indexed: true },
      { name: 'requestId', type: 'bytes32', indexed: true },
      { name: 'jobType', type: 'uint8', indexed: false },
    ],
  },
] as const;

export const SAFE_ABI = [
  {
    name: 'nonce',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'getTransactionHash',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'data', type: 'bytes' },
      { name: 'operation', type: 'uint8' },
      { name: 'safeTxGas', type: 'uint256' },
      { name: 'baseGas', type: 'uint256' },
      { name: 'gasPrice', type: 'uint256' },
      { name: 'gasToken', type: 'address' },
      { name: 'refundReceiver', type: 'address' },
      { name: '_nonce', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bytes32' }],
  },
  {
    name: 'execTransaction',
    type: 'function',
    stateMutability: 'payable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'data', type: 'bytes' },
      { name: 'operation', type: 'uint8' },
      { name: 'safeTxGas', type: 'uint256' },
      { name: 'baseGas', type: 'uint256' },
      { name: 'gasPrice', type: 'uint256' },
      { name: 'gasToken', type: 'address' },
      { name: 'refundReceiver', type: 'address' },
      { name: 'signatures', type: 'bytes' },
    ],
    outputs: [{ name: 'success', type: 'bool' }],
  },
] as const;

// Safe deployment ABIs
export const SAFE_SETUP_ABI = [
  {
    name: 'setup',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: '_owners', type: 'address[]' },
      { name: '_threshold', type: 'uint256' },
      { name: 'to', type: 'address' },
      { name: 'data', type: 'bytes' },
      { name: 'fallbackHandler', type: 'address' },
      { name: 'paymentToken', type: 'address' },
      { name: 'payment', type: 'uint256' },
      { name: 'paymentReceiver', type: 'address' },
    ],
    outputs: [],
  },
] as const;

export const SAFE_PROXY_FACTORY_ABI = [
  {
    name: 'createProxyWithNonce',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: '_singleton', type: 'address' },
      { name: 'initializer', type: 'bytes' },
      { name: 'saltNonce', type: 'uint256' },
    ],
    outputs: [{ name: 'proxy', type: 'address' }],
  },
] as const;

export const SAFE_SINGLETON_ADDRESS: `0x${string}` = '0xd9Db270c1B5E3Bd161E8c8503c55cEABeE709552';
export const SAFE_PROXY_FACTORY_ADDRESS: `0x${string}` = '0xa6B71E26C5e0845f74c812102Ca7114b6a896AB2';

export const NATIVE_PAYMENT_TYPE = '0xba699a34be8fe0e7725e93dcbce1701b0211a8ca61330aaeb8a05bf2ec7abed1' as const;

// Autonolas IPFS gateway — constructs URLs from raw SHA256 multihash digests
// Format: f01551220{32-byte-hex-digest}
// 0x55 = raw codec (CIDv1 from Autonolas registry), 0x1220 = sha2-256 multihash
export const IPFS_GATEWAY_PREFIX = 'https://gateway.autonolas.tech/ipfs/f01551220' as const;
