/**
 * Chain config resolver and ABI fragments for the earning bootstrap.
 *
 * All contract addresses, bond amounts, and chain parameters are encapsulated
 * in ChainConfig. The state machine reads everything from here -- no inline
 * literals in business logic.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { keccak256, stringToBytes } from 'viem';

// Package root, resolved from this file's location. Works identically from
// src/earning/ (tsx) and dist/earning/ (tsc output) — both are 2 dirs below client/.
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BUNDLED_DEPLOYMENTS_DIR = path.join(PACKAGE_ROOT, 'deployments');

/**
 * Default Phase 1b deployment artifacts bundled in the client package. These let
 * the client run against Base Sepolia with zero env vars. Callers can still
 * override individual paths via ChainConfigOverrides or JINN_TESTNET_*_DEPLOYMENT
 * env vars.
 *
 * After a contract redeploy, run `scripts/sync-deployments.sh` to refresh these
 * from the contracts/ directory.
 */
export const DEFAULT_TESTNET_ARTIFACTS = {
  token: path.join(BUNDLED_DEPLOYMENTS_DIR, 'deployment-phase1a-token-baseSepolia-fast.json'),
  l2: path.join(BUNDLED_DEPLOYMENTS_DIR, 'deployment-phase1a-l2-baseSepolia-fast.json'),
  mech: path.join(BUNDLED_DEPLOYMENTS_DIR, 'deployment-phase1b-mech-baseSepolia-fast.json'),
  stolas: path.join(BUNDLED_DEPLOYMENTS_DIR, 'deployment-stolas-l2-baseSepolia-fast.json'),
  faucet: path.join(BUNDLED_DEPLOYMENTS_DIR, 'deployment-jinn-testnet-faucet-baseSepolia-fast.json'),
  /** v0 MVI L1 stack (JINN, Timelock, Governor, Distributor, Messenger) on Sepolia. */
  jinnMviL1: path.join(BUNDLED_DEPLOYMENTS_DIR, 'deployment-jinn-mvi-l1-sepolia.json'),
  /** v0 MVI L2 emitter (TaskClaimEmitter) on Base Sepolia. */
  jinnMviL2: path.join(BUNDLED_DEPLOYMENTS_DIR, 'deployment-jinn-mvi-l2-baseSepolia.json'),
} as const;

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
  eoaTopupTrigger: bigint;
  safeTopupTrigger: bigint;
  jinnRouter?: string;
  distributorAddress?: string;
  /**
   * ERC-8004 IdentityRegistry contract — operator agent NFT mint target.
   * See subgraph/networks.json + /tmp/erc8004-ref/IdentityRegistry.json.
   * Resolved per chainId from `IDENTITY_REGISTRY_ADDRESSES` below.
   */
  identityRegistry?: string;
  /**
   * Testnet-only JINN faucet (testnet operator onboarding). Absent on mainnet.
   * Resolved from the deployment-jinn-testnet-faucet-baseSepolia artifact.
   */
  jinnFaucet?: string;
  /**
   * JinnRouter delivery claim ABI: V1 single arg (Base mainnet), V2 + evidenceHash
   * (Phase 1b), or Task-native V3 split Solution/Verdict delivery claims.
   * Override with JINN_ROUTER_CLAIM_DELIVERY_VERSION=v1|v2|v3.
   */
  routerClaimDeliveryVersion: 'v1' | 'v2' | 'v3';
}

export interface ChainGasOverrides {
  minEoaGasWei?: string;
  minSafeEthWei?: string;
}

function parseWeiOverride(value: string | undefined, name: string): bigint | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) {
    throw new Error(`${name} must be a non-negative wei integer string`);
  }
  return BigInt(value);
}

export function applyChainGasOverrides(config: ChainConfig, overrides: ChainGasOverrides): ChainConfig {
  const minEoaGasEth = parseWeiOverride(overrides.minEoaGasWei, 'minEoaGasWei');
  const minSafeEth = parseWeiOverride(overrides.minSafeEthWei, 'minSafeEthWei');
  if (minEoaGasEth !== undefined) {
    config.minEoaGasEth = minEoaGasEth;
  }
  if (minSafeEth !== undefined) {
    config.minSafeEth = minSafeEth;
  }
  return config;
}

interface ChainConfigOverrides {
  testnetL2DeploymentPath?: string;
  testnetL2TokenDeploymentPath?: string;
  testnetMechDeploymentPath?: string;
  testnetStolasDeploymentPath?: string;
  testnetFaucetDeploymentPath?: string;
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
  jinnRouter: '0xfFa7118A3D820cd4E820010837D65FAfF463181B',

  // stOLAS ExternalStakingDistributor (LemonTree, Base mainnet)
  distributorAddress: '0x40abf47B926181148000DbCC7c8DE76A3a61a66f',

  // ERC-8004 IdentityRegistry (Base mainnet, vanity 0x8004…)
  identityRegistry: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',

  // Service package
  agentId: 103,
  serviceHash: 'bafybeiawqqwkoeovm453mscwkxvmtnvaanhatlqh52cf5sdqavz6ldybae',
  serviceNft: 'bafybeiaakdeconw7j5z76fgghfdjmsr6tzejotxcwnvmp3nroaw3glgyve',

  // Bond: 5000 OLAS (minStakingDeposit for this staking contract)
  bondAmount: 5000n * 10n ** 18n,

  // Conservative gas estimate for: Safe deploy + ~6 Safe exec txs
  minEoaGasEth: 5_000_000_000_000_000n, // 0.005 ETH
  minSafeEth: 2_000_000_000_000_000n,   // 0.002 ETH

  // Balance top-up triggers (refill starts when balance drops below these)
  eoaTopupTrigger: 1_000_000_000_000_000n,  // 0.001 ETH
  safeTopupTrigger: 500_000_000_000_000n,   // 0.0005 ETH

  routerClaimDeliveryVersion: 'v1',
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

  // ERC-8004 IdentityRegistry (Base Sepolia, vanity 0x8004…)
  identityRegistry: '0x8004A818BFB912233c491871b3d84c89A494BD9e',

  // Reuse the current service package defaults unless testnet-specific overrides are supplied.
  agentId: 103,
  serviceHash: 'bafybeiawqqwkoeovm453mscwkxvmtnvaanhatlqh52cf5sdqavz6ldybae',
  serviceNft: 'bafybeiaakdeconw7j5z76fgghfdjmsr6tzejotxcwnvmp3nroaw3glgyve',

  // Bond: match the live Phase 1a staking minStakingDeposit.
  bondAmount: 10n * 10n ** 18n,

  // Conservative gas estimate
  minEoaGasEth: 5_000_000_000_000_000n, // 0.005 ETH
  minSafeEth: 2_000_000_000_000_000n,   // 0.002 ETH

  // Balance top-up triggers (refill starts when balance drops below these)
  eoaTopupTrigger: 1_000_000_000_000_000n,  // 0.001 ETH
  safeTopupTrigger: 500_000_000_000_000n,   // 0.0005 ETH

  /** Clean-break TaskCoordinator/JinnRouterV3 uses split Task-native delivery claims. */
  routerClaimDeliveryVersion: 'v3',
};

function loadArtifact(filePath: string): DeploymentArtifact {
  const resolvedPath = path.resolve(filePath);
  if (!existsSync(resolvedPath)) {
    throw new Error(`Phase 1a artifact not found: ${resolvedPath}`);
  }

  return JSON.parse(readFileSync(resolvedPath, 'utf8')) as DeploymentArtifact;
}

function resolveBaseSepoliaConfig(overrides: ChainConfigOverrides = {}): ChainConfig {
  const tokenArtifactPath =
    overrides.testnetL2TokenDeploymentPath
    ?? process.env['JINN_TESTNET_TOKEN_DEPLOYMENT']
    ?? DEFAULT_TESTNET_ARTIFACTS.token;
  const l2ArtifactPath =
    overrides.testnetL2DeploymentPath
    ?? process.env['JINN_TESTNET_L2_DEPLOYMENT']
    ?? DEFAULT_TESTNET_ARTIFACTS.l2;
  const mechArtifactPath =
    overrides.testnetMechDeploymentPath
    ?? process.env['JINN_TESTNET_MECH_DEPLOYMENT']
    ?? DEFAULT_TESTNET_ARTIFACTS.mech;

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

  if (mechArtifactPath) {
    const mechArtifact = loadArtifact(mechArtifactPath);
    const mechMarketplace = mechArtifact.contracts?.mechMarketplace;
    const mechFactory = mechArtifact.contracts?.mechFactory;
    const jinnRouter = mechArtifact.contracts?.jinnRouter;

    if (!mechMarketplace) {
      throw new Error(`Testnet mech artifact ${path.resolve(mechArtifactPath)} is missing contracts.mechMarketplace`);
    }
    if (!mechFactory) {
      throw new Error(`Testnet mech artifact ${path.resolve(mechArtifactPath)} is missing contracts.mechFactory`);
    }

    resolved.mechMarketplace = mechMarketplace;
    resolved.mechFactory = mechFactory;
    if (jinnRouter) {
      resolved.jinnRouter = jinnRouter;
    }
    // Mech artifact can also override the staking contract (e.g., Phase 1b staking proxy
    // with JinnRouterV2 as activity checker)
    const stakingToken = mechArtifact.contracts?.stakingToken;
    if (stakingToken) {
      resolved.stakingContract = stakingToken;
    }
  }

  const stolasArtifactPath =
    overrides.testnetStolasDeploymentPath
    ?? process.env['JINN_TESTNET_STOLAS_DEPLOYMENT']
    ?? DEFAULT_TESTNET_ARTIFACTS.stolas;
  if (stolasArtifactPath) {
    const stolasArtifact = loadArtifact(stolasArtifactPath);
    const distributor = stolasArtifact.contracts?.distributor;
    if (!distributor) {
      throw new Error(`stOLAS artifact ${path.resolve(stolasArtifactPath)} is missing contracts.distributor`);
    }
    resolved.distributorAddress = distributor;
  }

  // Testnet JINN faucet (optional — if the artifact is absent we just skip auto-drip).
  const faucetArtifactPath =
    overrides.testnetFaucetDeploymentPath
    ?? process.env['JINN_TESTNET_FAUCET_DEPLOYMENT']
    ?? DEFAULT_TESTNET_ARTIFACTS.faucet;
  if (faucetArtifactPath && existsSync(path.resolve(faucetArtifactPath))) {
    const faucetArtifact = loadArtifact(faucetArtifactPath);
    const faucetAddress = faucetArtifact.contracts?.faucet;
    if (faucetAddress) {
      resolved.jinnFaucet = faucetAddress;
    }
  }

  return resolved;
}

function applyRouterClaimDeliveryEnvOverride(config: ChainConfig): ChainConfig {
  const raw = process.env['JINN_ROUTER_CLAIM_DELIVERY_VERSION']?.trim().toLowerCase();
  if (raw === 'v1' || raw === 'v2' || raw === 'v3') {
    return { ...config, routerClaimDeliveryVersion: raw };
  }
  return config;
}

export function getChainConfig(
  chain: 'base' | 'base-sepolia',
  overrides: ChainConfigOverrides = {},
): ChainConfig {
  switch (chain) {
    case 'base':
      return applyRouterClaimDeliveryEnvOverride({ ...BASE_CONFIG });
    case 'base-sepolia':
      return applyRouterClaimDeliveryEnvOverride(resolveBaseSepoliaConfig(overrides));
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
  {
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    name: 'transfer',
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'nonpayable',
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
  CreateService: keccak256(stringToBytes('CreateService(uint256,bytes32)')),
  CreateMultisigWithAgents: keccak256(stringToBytes('CreateMultisigWithAgents(uint256,address)')),
  // ERC-8004 IdentityRegistry mint event (jinn-mono-j07).
  Registered: keccak256(stringToBytes('Registered(uint256,string,address)')),
} as const;

// ---------------------------------------------------------------------------
// ERC-8004 IdentityRegistry (vanity 0x8004… on every supported chain)
// ---------------------------------------------------------------------------
//
// Source of truth: subgraph/networks.json (cross-checked against
// erc-8004/erc-8004-contracts/scripts/addresses.ts and used by
// jinn-mono-fud's subgraph). Only the chains the client compiles for
// are mirrored here; the registry is also deployed on Sepolia/Mainnet
// for completeness, but the bootstrap currently runs against Base or
// Base Sepolia.

export const IDENTITY_REGISTRY_ADDRESSES: Record<number, string> = {
  8453: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',  // Base mainnet
  84532: '0x8004A818BFB912233c491871b3d84c89A494BD9e', // Base Sepolia
  // Mainnet (1) and Sepolia (11155111) share the Base mainnet / Base
  // Sepolia vanity addresses respectively; recorded in subgraph/networks.json
  // but not currently consumed from the client.
  1: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
  11155111: '0x8004A818BFB912233c491871b3d84c89A494BD9e',
};

/**
 * Minimal ABI surface used by the bootstrap mint step. The full
 * subgraph/abis/IdentityRegistry.json carries the same definitions —
 * we keep only what the bootstrap touches to avoid drift if the
 * subgraph ABI is regenerated. Per-execution `setMetadata` lives in
 * a separate client (`jinn-mono-3zk`) and re-derives its own ABI.
 */
export const IDENTITY_REGISTRY_ABI = [
  // Mint without an agentURI — emits Registered(agentId, "", owner).
  {
    inputs: [],
    name: 'register',
    outputs: [{ name: 'agentId', type: 'uint256' }],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  // Mint with an agentURI string — emits Registered(agentId, agentURI, owner).
  {
    inputs: [{ name: 'agentURI', type: 'string' }],
    name: 'register',
    outputs: [{ name: 'agentId', type: 'uint256' }],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  // Bind a wallet to an agentId. msg.sender must be owner / approved /
  // operator; the inner `signature` is recovered against `newWallet`
  // (ECDSA EOA path, ERC-1271 contract-wallet path).
  {
    inputs: [
      { name: 'agentId', type: 'uint256' },
      { name: 'newWallet', type: 'address' },
      { name: 'deadline', type: 'uint256' },
      { name: 'signature', type: 'bytes' },
    ],
    name: 'setAgentWallet',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [{ name: 'agentId', type: 'uint256' }],
    name: 'getAgentWallet',
    outputs: [{ name: '', type: 'address' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    type: 'event',
    name: 'Registered',
    inputs: [
      { name: 'agentId', type: 'uint256', indexed: true },
      { name: 'agentURI', type: 'string', indexed: false },
      { name: 'owner', type: 'address', indexed: true },
    ],
  },
] as const;

// ---------------------------------------------------------------------------
// stOLAS ExternalStakingDistributor (Base mainnet)
// ---------------------------------------------------------------------------

export const STOLAS_DISTRIBUTOR = '0x40abf47B926181148000DbCC7c8DE76A3a61a66f';

export const STOLAS_DISTRIBUTOR_ABI = [
  {
    inputs: [{ name: 'stakingProxy', type: 'address' }],
    name: 'mapStakingProxyConfigs',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      { name: 'stakingProxy', type: 'address' },
      { name: 'serviceId', type: 'uint256' },
      { name: 'agentId', type: 'uint256' },
      { name: 'configHash', type: 'bytes32' },
      { name: 'agentInstance', type: 'address' },
    ],
    name: 'stake',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      { name: 'stakingProxy', type: 'address' },
      { name: 'serviceId', type: 'uint256' },
      { name: 'operation', type: 'bytes32' },
    ],
    name: 'unstakeAndWithdraw',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      { name: 'stakingProxy', type: 'address' },
      { name: 'serviceId', type: 'uint256' },
    ],
    name: 'reStake',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      { name: 'stakingProxies', type: 'address[]' },
      { name: 'serviceIds', type: 'uint256[]' },
    ],
    name: 'claim',
    outputs: [{ name: 'rewards', type: 'uint256[]' }],
    stateMutability: 'nonpayable',
    type: 'function',
  },
] as const;

export const STOLAS_STAKING_SLOTS_ABI = [
  {
    inputs: [],
    name: 'getServiceIds',
    outputs: [{ name: 'serviceIds', type: 'uint256[]' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'maxNumServices',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const;

// ---------------------------------------------------------------------------
// v0 MVI cross-chain claim flow (Phase B / jinn-mono-7x5)
// ---------------------------------------------------------------------------

/**
 * Resolved v0 MVI deployment surface.
 *
 * Two artifacts: an L1 stack (deployed by deploy-jinn-mvi-l1.ts) carrying
 * JINN + Timelock + Governor + Distributor + Messenger; and an L2 emitter
 * (separate deploy script) carrying just the TaskClaimEmitter address.
 *
 * The daemon's cross-chain claim loop reads `distributor` + `messenger` for
 * the L1 submission step and `claimEmitter` for the L2 emit step.
 */
export interface JinnMviConfig {
  jinn?: string;
  timelock?: string;
  governor?: string;
  distributor?: string;
  messenger?: string;
  messengerMode?: 'canonical' | 'mock';
  claimEmitter?: string;
}

interface JinnMviL1Artifact {
  network?: string;
  chainId?: number;
  messenger?: { mode?: string; address?: string };
  contracts?: {
    JINN?: string;
    TimelockController?: string;
    JinnGovernor?: string;
    JinnDistributor?: string;
    Messenger?: string;
  };
}

interface JinnMviL2Artifact {
  network?: string;
  chainId?: number;
  contracts?: {
    TaskClaimEmitter?: string;
  };
}

/**
 * Load and merge the v0 MVI L1/L2 deployment artifacts. Both are optional —
 * the daemon falls back to direct address overrides from config / env when
 * neither is present.
 *
 * Throws when an artifact path is supplied but the file is missing or
 * malformed; this is the same fail-loud pattern as resolveBaseSepoliaConfig.
 */
export function loadJinnMviConfig(args: {
  l1ArtifactPath?: string;
  l2ArtifactPath?: string;
  /** Direct overrides (config field or env var); take precedence over artifacts. */
  distributorAddress?: string;
  messengerAddress?: string;
  claimEmitterAddress?: string;
  messengerMode?: 'canonical' | 'mock';
}): JinnMviConfig {
  const out: JinnMviConfig = {};

  if (args.l1ArtifactPath) {
    const resolved = path.resolve(args.l1ArtifactPath);
    if (!existsSync(resolved)) {
      throw new Error(`Jinn MVI L1 artifact not found: ${resolved}`);
    }
    const artifact = JSON.parse(readFileSync(resolved, 'utf8')) as JinnMviL1Artifact;
    out.jinn = artifact.contracts?.JINN;
    out.timelock = artifact.contracts?.TimelockController;
    out.governor = artifact.contracts?.JinnGovernor;
    out.distributor = artifact.contracts?.JinnDistributor;
    out.messenger = artifact.contracts?.Messenger ?? artifact.messenger?.address;
    const rawMode = artifact.messenger?.mode;
    if (rawMode === 'canonical' || rawMode === 'mock') {
      out.messengerMode = rawMode;
    }
  }

  if (args.l2ArtifactPath) {
    const resolved = path.resolve(args.l2ArtifactPath);
    if (!existsSync(resolved)) {
      throw new Error(`Jinn MVI L2 artifact not found: ${resolved}`);
    }
    const artifact = JSON.parse(readFileSync(resolved, 'utf8')) as JinnMviL2Artifact;
    out.claimEmitter = artifact.contracts?.TaskClaimEmitter;
  }

  // Direct overrides take precedence.
  if (args.distributorAddress) out.distributor = args.distributorAddress;
  if (args.messengerAddress) out.messenger = args.messengerAddress;
  if (args.claimEmitterAddress) out.claimEmitter = args.claimEmitterAddress;
  if (args.messengerMode) out.messengerMode = args.messengerMode;

  return out;
}

// ---------------------------------------------------------------------------
// TaskClaimEmitter / IClaimMessenger / JinnDistributor ABI fragments
// ---------------------------------------------------------------------------

export const JINN_CLAIM_EMITTER_ABI = [
  {
    type: 'event',
    name: 'ClaimTicket',
    inputs: [
      { name: 'claimId', type: 'uint256', indexed: true },
      { name: 'serviceId', type: 'uint256', indexed: true },
      { name: 'taskCreationWeight', type: 'uint256', indexed: false },
      { name: 'solutionDeliveryWeight', type: 'uint256', indexed: false },
      { name: 'verdictDeliveryWeight', type: 'uint256', indexed: false },
      { name: 'multisig', type: 'address', indexed: true },
      { name: 'claimer', type: 'address', indexed: false },
    ],
  },
  {
    inputs: [{ name: 'serviceId', type: 'uint256' }],
    name: 'emitClaim',
    outputs: [{ name: 'claimId', type: 'uint256' }],
    stateMutability: 'nonpayable',
    type: 'function',
  },
] as const;

export const CLAIM_TICKET_TOPIC0 = keccak256(
  stringToBytes('ClaimTicket(uint256,uint256,uint256,uint256,uint256,address,address)'),
);

export const JINN_DISTRIBUTOR_ABI = [
  {
    inputs: [{ name: 'proof', type: 'bytes' }],
    name: 'claim',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [{ name: '', type: 'uint256' }],
    name: 'totalClaimedOperator',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ name: '', type: 'uint256' }],
    name: 'totalClaimedDao',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'messenger',
    outputs: [{ name: '', type: 'address' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const;

export const CLAIM_MESSENGER_ABI = [
  {
    inputs: [{ name: 'proof', type: 'bytes' }],
    name: 'verifyClaim',
    outputs: [
      { name: 'serviceId', type: 'uint256' },
      { name: 'taskCreationWeight', type: 'uint256' },
      { name: 'solutionDeliveryWeight', type: 'uint256' },
      { name: 'verdictDeliveryWeight', type: 'uint256' },
      { name: 'multisig', type: 'address' },
    ],
    stateMutability: 'view',
    type: 'function',
  },
] as const;

/**
 * Mock messenger ABI — admin setFixture path used by burn-in to plant
 * fixtures on Sepolia. The verifyClaim path matches IClaimMessenger.
 */
export const MOCK_MESSENGER_ABI = [
  {
    inputs: [
      { name: 'claimId', type: 'uint256' },
      {
        name: 'f',
        type: 'tuple',
        components: [
          { name: 'serviceId', type: 'uint256' },
          { name: 'taskCreationWeight', type: 'uint256' },
          { name: 'solutionDeliveryWeight', type: 'uint256' },
          { name: 'verdictDeliveryWeight', type: 'uint256' },
          { name: 'multisig', type: 'address' },
        ],
      },
    ],
    name: 'setFixture',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [{ name: 'claimId', type: 'uint256' }],
    name: 'fixtures',
    outputs: [
      { name: 'serviceId', type: 'uint256' },
      { name: 'taskCreationWeight', type: 'uint256' },
      { name: 'solutionDeliveryWeight', type: 'uint256' },
      { name: 'verdictDeliveryWeight', type: 'uint256' },
      { name: 'multisig', type: 'address' },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'owner',
    outputs: [{ name: '', type: 'address' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const;
