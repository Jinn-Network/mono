/**
 * On-Chain Service Resolver
 *
 * Given a mech address + RPC URL, derives all service config from on-chain state:
 *   mech.tokenId()                        → serviceId
 *   ServiceRegistry.getService(serviceId) → { multisig (Safe), state }
 *   ServiceRegistry.ownerOf(serviceId)    → owner (may be staking contract)
 *     if owner is contract → getStakingState(serviceId)
 *       1=Staked → owner is the staking contract
 *       0 or 2  → no active staking
 *   mech.mechMarketplace()                → marketplace address
 *
 * This eliminates the need for WORKER_SERVICE_ID, WORKER_STAKING_CONTRACT,
 * JINN_SERVICE_SAFE_ADDRESS, and MECH_MARKETPLACE_ADDRESS_BASE env vars.
 * Those env vars still work as explicit overrides when set.
 */

import { ethers } from 'ethers';
import { workerLogger } from '../../logging/index.js';
import { config, secrets, createRpcProvider } from '../../config/index.js';

const log = workerLogger.child({ component: 'SERVICE_RESOLVER' });

// ServiceRegistry on Base
const SERVICE_REGISTRY_BASE = '0x3C1fF68f5aa342D296d4DEe4Bb1cACCA912D95fE';

const MECH_ABI = [
  'function tokenId() view returns (uint256)',
  'function mechMarketplace() view returns (address)',
];

const SERVICE_REGISTRY_ABI = [
  'function getService(uint256 serviceId) view returns (tuple(uint96 securityDeposit, address multisig, bytes32 configHash, uint32 threshold, uint32 maxNumAgentInstances, uint32 numAgentInstances, uint8 state) service)',
  'function ownerOf(uint256 tokenId) view returns (address)',
];

const STAKING_ABI = [
  'function getStakingState(uint256 serviceId) view returns (uint8 stakingState)',
  'function getServiceInfo(uint256 serviceId) view returns (tuple(address multisig, address owner, uint256[] nonces, uint256 tsStart, uint256 reward, uint256 inactivity))',
];

export interface ResolvedServiceConfig {
  serviceId: number;
  multisig: string;
  marketplace: string;
  stakingContract: string | null;
  serviceState: number;
}

// Process-lifetime cache keyed by mech address.
// Multi-service workers may resolve multiple mechs in one process.
const _cachedByMech = new Map<string, ResolvedServiceConfig>();
let _lastCached: ResolvedServiceConfig | null = null;

/**
 * Resolve all derived config from on-chain state.
 * Results are cached for process lifetime (call clearCache() to reset).
 */
export async function resolveServiceConfig(
  mechAddress: string,
  rpcUrl: string,
): Promise<ResolvedServiceConfig> {
  const mechKey = mechAddress.toLowerCase();
  const cached = _cachedByMech.get(mechKey);
  if (cached) return cached;

  const provider = createRpcProvider(rpcUrl);
  const mech = new ethers.Contract(mechAddress, MECH_ABI, provider);

  // Step 1: Read tokenId and marketplace from mech
  const [tokenIdBN, marketplace] = await Promise.all([
    mech.tokenId(),
    mech.mechMarketplace(),
  ]);
  const serviceId = Number(tokenIdBN);

  log.info({ mechAddress, serviceId, marketplace }, 'Resolved mech → serviceId + marketplace');

  // Step 2: Read service info from ServiceRegistry
  const registry = new ethers.Contract(SERVICE_REGISTRY_BASE, SERVICE_REGISTRY_ABI, provider);
  const [service, owner] = await Promise.all([
    registry.getService(serviceId),
    registry.ownerOf(serviceId),
  ]);

  let multisig: string = service.multisig;
  const serviceState: number = Number(service.state);

  log.info({ serviceId, multisig, serviceState, owner }, 'Resolved ServiceRegistry state');

  // Step 3: Determine staking contract
  // If owner is a contract (not an EOA), check if it's a staking contract.
  // When staked, the ServiceRegistry's multisig may be a sentinel (0x...0001)
  // because the NFT was transferred. The real Safe comes from the staking
  // contract's getServiceInfo().multisig.
  let stakingContract: string | null = null;
  const ownerCode = await provider.getCode(owner);
  if (ownerCode !== '0x') {
    // Owner is a contract — check getStakingState
    try {
      const stakingCandidate = new ethers.Contract(owner, STAKING_ABI, provider);
      const stakingState = Number(await stakingCandidate.getStakingState(serviceId));
      if (stakingState === 1) {
        stakingContract = owner;
        // Read the real multisig from the staking contract
        const stakingServiceInfo = await stakingCandidate.getServiceInfo(serviceId);
        const stakingMultisig: string = stakingServiceInfo.multisig;
        if (stakingMultisig && stakingMultisig !== ethers.ZeroAddress) {
          log.info({ stakingContract, serviceId, registryMultisig: multisig, stakingMultisig }, 'Service is actively staked — using staking multisig');
          multisig = stakingMultisig;
        } else {
          log.info({ stakingContract, serviceId }, 'Service is actively staked');
        }
      } else {
        log.info({ owner, stakingState, serviceId }, 'Owner is contract but service not actively staked (state: 0=Unstaked, 2=Evicted)');
      }
    } catch {
      // Not a staking contract (doesn't implement getStakingState)
      log.debug({ owner }, 'Owner contract does not implement getStakingState — not a staking contract');
    }
  }

  const result: ResolvedServiceConfig = {
    serviceId,
    multisig,
    marketplace,
    stakingContract,
    serviceState,
  };

  _cachedByMech.set(mechKey, result);
  _lastCached = result;
  return result;
}

/**
 * Get the cached resolved config, or null if not yet resolved.
 * If mechAddress is provided, returns the cache entry for that mech.
 * Without mechAddress, returns the most recently resolved config.
 */
export function getCachedServiceConfig(mechAddress?: string): ResolvedServiceConfig | null {
  if (mechAddress) {
    return _cachedByMech.get(mechAddress.toLowerCase()) ?? null;
  }
  return _lastCached;
}

/**
 * Clear the cached config (for testing or forced re-resolution).
 */
export function clearServiceConfigCache(): void {
  _cachedByMech.clear();
  _lastCached = null;
}

// ── Standalone self-test ─────────────────────────────────────────────────────

const isMain = typeof process !== 'undefined'
  && process.argv[1]
  && (process.argv[1].endsWith('serviceResolver.ts') || process.argv[1].endsWith('serviceResolver.js'));

if (isMain) {
  const mechAddr = process.env.JINN_SERVICE_MECH_ADDRESS || process.argv[2];
  const rpcUrl = secrets.rpcUrl || process.argv[3];

  if (!mechAddr || !rpcUrl) {
    console.error('Usage: tsx serviceResolver.ts <mechAddress> <rpcUrl>');
    console.error('  Or set JINN_SERVICE_MECH_ADDRESS and RPC_URL env vars');
    process.exit(1);
  }

  resolveServiceConfig(mechAddr, rpcUrl)
    .then((config) => {
      console.log('\nResolved Service Config:');
      console.log(JSON.stringify(config, null, 2));
    })
    .catch((err) => {
      console.error('Resolution failed:', err.message);
      process.exit(1);
    });
}
