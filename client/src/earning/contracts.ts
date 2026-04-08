/**
 * Chain config resolver and ABI fragments for the earning bootstrap.
 *
 * All contract addresses, bond amounts, and chain parameters are encapsulated
 * in ChainConfig. The state machine reads everything from here -- no inline
 * literals in business logic.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { keccak256, toUtf8Bytes } from 'ethers';

// ---------------------------------------------------------------------------
// CID utilities
// ---------------------------------------------------------------------------

const BASE32_LOWER = 'abcdefghijklmnopqrstuvwxyz234567';

function base32Decode(input: string): Uint8Array {
  const lookup = new Map<string, number>();
  for (let i = 0; i < BASE32_LOWER.length; i++) {
    lookup.set(BASE32_LOWER[i], i);
  }

  let bitBuffer = 0;
  let bitCount = 0;
  const bytes: number[] = [];

  for (const ch of input) {
    const val = lookup.get(ch);
    if (val === undefined) {
      throw new Error(`Invalid base32 character: '${ch}'`);
    }
    bitBuffer = (bitBuffer << 5) | val;
    bitCount += 5;
    if (bitCount >= 8) {
      bitCount -= 8;
      bytes.push((bitBuffer >> bitCount) & 0xff);
    }
  }

  return new Uint8Array(bytes);
}

/**
 * Extract the 32-byte SHA256 digest from a CIDv1 base32-lower IPFS hash.
 *
 * CIDv1 base32 structure: `b` (multibase) + base32(version + codec + multihash)
 * For dag-pb SHA256: version=0x01, codec=0x70, hashFn=0x12, hashLen=0x20, <32 bytes>
 *
 * Returns `0x`-prefixed 64-char hex string suitable for bytes32.
 */
export function cidToBytes32(cid: string): string {
  if (!cid.startsWith('b')) {
    throw new Error(`Expected CIDv1 base32-lower (starting with 'b'), got: ${cid.slice(0, 8)}...`);
  }

  const raw = base32Decode(cid.slice(1)); // strip 'b' multibase prefix

  // Validate CIDv1 header: version(0x01) + codec(0x70 dag-pb or 0x55 raw) + hashFn(0x12 sha256) + hashLen(0x20)
  if (raw.length < 36) {
    throw new Error(`CID too short: expected at least 36 bytes, got ${raw.length}`);
  }

  if (raw[0] !== 0x01) {
    throw new Error(`Expected CIDv1 (version 0x01), got 0x${raw[0].toString(16)}`);
  }

  // codec: 0x70 (dag-pb) or 0x55 (raw)
  const codec = raw[1];
  if (codec !== 0x70 && codec !== 0x55) {
    throw new Error(`Unexpected codec 0x${codec.toString(16)}, expected 0x70 (dag-pb) or 0x55 (raw)`);
  }

  if (raw[2] !== 0x12) {
    throw new Error(`Expected SHA256 hash function (0x12), got 0x${raw[2].toString(16)}`);
  }

  if (raw[3] !== 0x20) {
    throw new Error(`Expected 32-byte hash length (0x20), got 0x${raw[3].toString(16)}`);
  }

  const digest = raw.slice(4, 36);
  const hex = Array.from(digest).map(b => b.toString(16).padStart(2, '0')).join('');
  return `0x${hex}`;
}

// ---------------------------------------------------------------------------
// Chain config
// ---------------------------------------------------------------------------

export interface ChainConfig {
  chainId: number;
  rpcUrl: string;
  serviceRegistry: string;
  serviceRegistryTokenUtility: string;
  serviceManager: string;
  olasToken: string;
  stakingContract: string;
  gnosisSafeSameAddressMultisig: string;
  bondAmount: bigint;
  agentId: number;
  mechMarketplace: string;
  mechFactory: string;
  mechRequestPrice: bigint;
  serviceHash: string;
  serviceNft: string;
  minEoaGasEth: bigint;
  minSafeEth: bigint;
}

interface ChainConfigOverrides {
  testnetL2DeploymentPath?: string;
  testnetL2TokenDeploymentPath?: string;
}

interface DeploymentArtifact {
  contracts?: Record<string, string | undefined>;
  config?: Record<string, unknown>;
}

function getArtifactString(config: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = config?.[key];
  return typeof value === 'string' ? value : undefined;
}

const BASE_CONFIG: ChainConfig = {
  chainId: 8453,
  rpcUrl: 'https://mainnet.base.org',

  // Autonolas protocol contracts (Base L2)
  serviceRegistry: '0x3C1fF68f5aa342D296d4DEe4Bb1cACCA912D95fE',
  serviceRegistryTokenUtility: '0x34C895f302D0b5cf52ec0Edd3945321EB0f83dd5',
  serviceManager: '0x1262136cac6a06A782DC94eb3a3dF0b4d09FF6A6',
  gnosisSafeSameAddressMultisig: '0xFbBEc0C8b13B38a9aC0499694A69a10204c5E2aB',

  // Tokens
  olasToken: '0x54330d28ca3357F294334BDC454a032e7f353416',

  // Mech marketplace
  mechMarketplace: '0xf24eE42edA0fc9b33B7D41B06Ee8ccD2Ef7C5020',
  mechFactory: '0x2E008211f34b25A7d7c102403c6C2C3B665a1abe', // Native payment type
  mechRequestPrice: 99n, // wei — ecosystem standard

  // Jinn staking (JinnRouter activity checker)
  stakingContract: '0x51c5f4982b9b0b3c0482678f5847ea6228cc8e54',

  // Service package
  agentId: 103,
  serviceHash: 'bafybeiawqqwkoeovm453mscwkxvmtnvaanhatlqh52cf5sdqavz6ldybae',
  serviceNft: 'bafybeiaakdeconw7j5z76fgghfdjmsr6tzejotxcwnvmp3nroaw3glgyve',

  // Bond: 5000 OLAS (minStakingDeposit for this staking contract)
  bondAmount: 5000n * 10n ** 18n,

  // Conservative gas estimate for: Safe deploy + ~6 Safe exec txs
  minEoaGasEth: 5_000_000_000_000_000n, // 0.005 ETH
  minSafeEth: 2_000_000_000_000_000n,   // 0.002 ETH
};

const BASE_SEPOLIA_CONFIG: ChainConfig = {
  chainId: 84532,
  rpcUrl: 'https://sepolia.base.org',

  // Autonolas protocol contracts (Base Sepolia)
  serviceRegistry: '0x31D3202d8744B16A120117A053459DDFAE93c855',
  serviceRegistryTokenUtility: '0xeB49bE5DF00F74bd240DE4535DDe6Bc89CEfb994',
  serviceManager: '0x5BA58970c2Ae16Cf6218783018100aF2dCcFc915',
  gnosisSafeSameAddressMultisig: '0x10100e74b7F706222F8A7C0be9FC7Ae1717Ad8B2',

  // Phase 1a uses bridged JINN as the staking/bond token on Base Sepolia.
  olasToken: '0x4F177E56bd79c169742a1BF8907dB0A5e54F5524',

  // Mech marketplace is out of scope for the staking-only Phase 1a loop.
  mechMarketplace: '0x0000000000000000000000000000000000000000',
  mechFactory: '0x0000000000000000000000000000000000000000',
  mechRequestPrice: 99n,

  // Phase 1a staking proxy (Base Sepolia)
  stakingContract: '0xe9c8DaBb4062deEc921562e7E286be3cEcb826b0',

  // Reuse the current service package defaults unless testnet-specific overrides are supplied.
  agentId: 103,
  serviceHash: 'bafybeiawqqwkoeovm453mscwkxvmtnvaanhatlqh52cf5sdqavz6ldybae',
  serviceNft: 'bafybeiaakdeconw7j5z76fgghfdjmsr6tzejotxcwnvmp3nroaw3glgyve',

  // Bond: match the live Phase 1a staking minStakingDeposit.
  bondAmount: 10n * 10n ** 18n,

  // Conservative gas estimate
  minEoaGasEth: 5_000_000_000_000_000n, // 0.005 ETH
  minSafeEth: 2_000_000_000_000_000n,   // 0.002 ETH
};

function loadArtifact(filePath: string): DeploymentArtifact {
  const resolvedPath = path.resolve(filePath);
  if (!existsSync(resolvedPath)) {
    throw new Error(`Phase 1a artifact not found: ${resolvedPath}`);
  }

  return JSON.parse(readFileSync(resolvedPath, 'utf8')) as DeploymentArtifact;
}

function resolveBaseSepoliaConfig(overrides: ChainConfigOverrides = {}): ChainConfig {
  const tokenArtifactPath = overrides.testnetL2TokenDeploymentPath ?? process.env['JINN_TESTNET_TOKEN_DEPLOYMENT'];
  const l2ArtifactPath = overrides.testnetL2DeploymentPath ?? process.env['JINN_TESTNET_L2_DEPLOYMENT'];

  if (!tokenArtifactPath && !l2ArtifactPath) {
    return { ...BASE_SEPOLIA_CONFIG };
  }

  const resolved: ChainConfig = { ...BASE_SEPOLIA_CONFIG };

  if (tokenArtifactPath) {
    const tokenArtifact = loadArtifact(tokenArtifactPath);
    const l2Token = tokenArtifact.contracts?.l2Token;
    if (!l2Token) {
      throw new Error(`Testnet token artifact ${path.resolve(tokenArtifactPath)} is missing contracts.l2Token`);
    }
    resolved.olasToken = l2Token;
  }

  if (l2ArtifactPath) {
    const l2Artifact = loadArtifact(l2ArtifactPath);
    const stakingContract = l2Artifact.contracts?.stakingToken;
    const serviceRegistry = l2Artifact.contracts?.serviceRegistry;
    const serviceRegistryTokenUtility = l2Artifact.contracts?.serviceRegistryTokenUtility;
    const minStakingDeposit = getArtifactString(l2Artifact.config, 'minStakingDeposit');

    if (!stakingContract) {
      throw new Error(`Testnet L2 artifact ${path.resolve(l2ArtifactPath)} is missing contracts.stakingToken`);
    }
    if (!serviceRegistry) {
      throw new Error(`Testnet L2 artifact ${path.resolve(l2ArtifactPath)} is missing contracts.serviceRegistry`);
    }
    if (!serviceRegistryTokenUtility) {
      throw new Error(
        `Testnet L2 artifact ${path.resolve(l2ArtifactPath)} is missing contracts.serviceRegistryTokenUtility`,
      );
    }

    resolved.stakingContract = stakingContract;
    resolved.serviceRegistry = serviceRegistry;
    resolved.serviceRegistryTokenUtility = serviceRegistryTokenUtility;
    if (minStakingDeposit) {
      resolved.bondAmount = BigInt(minStakingDeposit);
    }
  }

  return resolved;
}

export function getChainConfig(
  chain: 'base' | 'base-sepolia',
  overrides: ChainConfigOverrides = {},
): ChainConfig {
  switch (chain) {
    case 'base':
      return { ...BASE_CONFIG };
    case 'base-sepolia':
      return resolveBaseSepoliaConfig(overrides);
    default:
      throw new Error(`Unsupported chain: ${chain}. Supported: 'base', 'base-sepolia'.`);
  }
}

// ---------------------------------------------------------------------------
// ABI fragments -- only the functions we call
// ---------------------------------------------------------------------------

export const SERVICE_MANAGER_ABI = [
  {
    inputs: [
      { name: 'serviceOwner', type: 'address' },
      { name: 'token', type: 'address' },
      { name: 'configHash', type: 'bytes32' },
      { name: 'agentIds', type: 'uint32[]' },
      { name: 'agentParams', type: 'tuple[]', components: [
        { name: 'slots', type: 'uint32' },
        { name: 'bond', type: 'uint96' },
      ]},
      { name: 'threshold', type: 'uint32' },
    ],
    name: 'create',
    outputs: [{ name: 'serviceId', type: 'uint256' }],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [{ name: 'serviceId', type: 'uint256' }],
    name: 'activateRegistration',
    outputs: [{ name: 'success', type: 'bool' }],
    stateMutability: 'payable',
    type: 'function',
  },
  {
    inputs: [
      { name: 'serviceId', type: 'uint256' },
      { name: 'agentInstances', type: 'address[]' },
      { name: 'agentIds', type: 'uint32[]' },
    ],
    name: 'registerAgents',
    outputs: [{ name: 'success', type: 'bool' }],
    stateMutability: 'payable',
    type: 'function',
  },
  {
    inputs: [
      { name: 'serviceId', type: 'uint256' },
      { name: 'multisigImplementation', type: 'address' },
      { name: 'data', type: 'bytes' },
    ],
    name: 'deploy',
    outputs: [{ name: 'multisig', type: 'address' }],
    stateMutability: 'nonpayable',
    type: 'function',
  },
] as const;

export const SERVICE_REGISTRY_L2_ABI = [
  {
    type: 'event',
    name: 'CreateService',
    inputs: [
      { name: 'serviceId', type: 'uint256', indexed: true },
      { name: 'configHash', type: 'bytes32', indexed: false },
    ],
  },
  {
    inputs: [{ name: 'serviceId', type: 'uint256' }],
    name: 'getService',
    outputs: [
      {
        name: 'service',
        type: 'tuple',
        components: [
          { name: 'securityDeposit', type: 'uint96' },
          { name: 'multisig', type: 'address' },
          { name: 'configHash', type: 'bytes32' },
          { name: 'threshold', type: 'uint32' },
          { name: 'maxNumAgentInstances', type: 'uint32' },
          { name: 'numAgentInstances', type: 'uint32' },
          { name: 'state', type: 'uint8' },
          { name: 'agentIds', type: 'uint32[]' },
        ],
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      { name: 'serviceId', type: 'uint256' },
      { name: 'agentInstances', type: 'address[]' },
      { name: 'agentIds', type: 'uint32[]' },
    ],
    name: 'registerAgents',
    outputs: [{ name: 'success', type: 'bool' }],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      { name: 'serviceId', type: 'uint256' },
      { name: 'multisigImplementation', type: 'address' },
      { name: 'data', type: 'bytes' },
    ],
    name: 'deploy',
    outputs: [{ name: 'multisig', type: 'address' }],
    stateMutability: 'nonpayable',
    type: 'function',
  },
] as const;

export const ERC20_ABI = [
  {
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    name: 'approve',
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [{ name: 'account', type: 'address' }],
    name: 'balanceOf',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const;

export const STAKING_ABI = [
  {
    inputs: [{ name: 'serviceId', type: 'uint256' }],
    name: 'stake',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [{ name: 'serviceId', type: 'uint256' }],
    name: 'getServiceInfo',
    outputs: [
      { name: 'securityDeposit', type: 'uint256' },
      { name: 'multisig', type: 'address' },
      { name: 'nonces', type: 'uint256[]' },
      { name: 'tsStart', type: 'uint256' },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ name: 'serviceId', type: 'uint256' }],
    name: 'getStakingState',
    outputs: [{ name: 'stakingState', type: 'uint8' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'getServiceIds',
    outputs: [{ name: 'serviceIds', type: 'uint256[]' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const;

export const SERVICE_REGISTRY_APPROVE_ABI = [
  {
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'tokenId', type: 'uint256' },
    ],
    name: 'approve',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
] as const;

export const MECH_MARKETPLACE_CREATE_ABI = [
  {
    inputs: [
      { name: 'serviceId', type: 'uint256' },
      { name: 'mechFactory', type: 'address' },
      { name: 'payload', type: 'bytes' },
    ],
    name: 'create',
    outputs: [{ name: 'mech', type: 'address' }],
    stateMutability: 'nonpayable',
    type: 'function',
  },
] as const;

// ---------------------------------------------------------------------------
// Event topics for strict log filtering
// ---------------------------------------------------------------------------

export const EVENT_TOPICS = {
  CreateService: keccak256(toUtf8Bytes('CreateService(uint256,bytes32)')),
} as const;
