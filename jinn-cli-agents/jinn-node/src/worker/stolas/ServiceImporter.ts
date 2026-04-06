/**
 * Service Importer for stOLAS
 *
 * Creates a middleware-compatible `.operate/services/sc-<uuid>/` directory
 * from on-chain service data. Used after stake() on the ExternalStakingDistributor
 * creates a service + Safe on-chain — this module synthesizes the local config
 * that ServiceConfigReader and the middleware daemon expect.
 */

import { promises as fs } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { ethers } from 'ethers';
import { createRpcProvider } from '../../config/index.js';
import { logger } from '../../logging/index.js';
import { SERVICE_CONSTANTS } from '../config/ServiceConfig.js';
import { backupKeystore } from '../../env/keystore-backup.js';

const importLogger = logger.child({ component: 'SERVICE-IMPORTER' });

// ─── Contracts ──────────────────────────────────────────────────────────────────

const SERVICE_REGISTRY = '0x3C1fF68f5aa342D296d4DEe4Bb1cACCA912D95fE';
const MECH_MARKETPLACE = '0xf24eE42edA0fc9b33B7D41B06Ee8ccD2Ef7C5020';

const SERVICE_REGISTRY_ABI = [
  'function getService(uint256 serviceId) view returns (tuple(address token, uint32 maxNumAgentInstances, uint32 numAgentInstances, bytes32 configHash, uint8 state))',
  'function ownerOf(uint256 tokenId) view returns (address)',
];

const STAKING_ABI = [
  'function mapServiceInfo(uint256 serviceId) view returns (address multisig, address owner)',
  'function getStakingState(uint256 serviceId) view returns (uint8)',
];

// ─── Interfaces ─────────────────────────────────────────────────────────────────

export interface ImportServiceParams {
  serviceId: number;
  agentInstanceAddress: string;
  encryptedKeystore: string;         // encrypted keystore V3 JSON string
  rpcUrl: string;
  chain: string;
  operateBasePath: string;           // directory that will contain .operate/
  stakingContractAddress: string;
  agentId?: number;                  // defaults to SERVICE_CONSTANTS.DEFAULT_AGENT_ID (103)
}

export interface ImportServiceResult {
  serviceConfigId: string;           // sc-<uuid>
  configPath: string;
  keysPath: string;
  multisig: string;
  serviceId: number;
}

// ─── Implementation ─────────────────────────────────────────────────────────────

/**
 * Import an on-chain service into a local .operate/ directory.
 *
 * Queries the ServiceRegistry for the service's multisig and state,
 * then writes config.json + keys.json in the format that ServiceConfigReader
 * and the middleware daemon expect.
 */
export async function importServiceFromChain(
  params: ImportServiceParams
): Promise<ImportServiceResult> {
  const {
    serviceId,
    agentInstanceAddress,
    encryptedKeystore,
    rpcUrl,
    chain,
    operateBasePath,
    stakingContractAddress,
    agentId = SERVICE_CONSTANTS.DEFAULT_AGENT_ID,
  } = params;

  importLogger.info({ serviceId, chain, agentInstanceAddress }, 'Importing service from chain');

  // ── 1. Query on-chain state ───────────────────────────────────────────────

  const provider = createRpcProvider(rpcUrl);

  // Get multisig from staking contract's mapServiceInfo
  const staking = new ethers.Contract(stakingContractAddress, STAKING_ABI, provider);
  const [multisig] = await staking.mapServiceInfo(serviceId);

  if (!multisig || multisig === ethers.ZeroAddress) {
    throw new Error(`Service ${serviceId} has no multisig on staking contract ${stakingContractAddress}`);
  }

  // Verify staking state = 1 (Staked)
  const stakingState = await staking.getStakingState(serviceId);
  if (Number(stakingState) !== 1) {
    importLogger.warn({ serviceId, stakingState: Number(stakingState) }, 'Service is not actively staked');
  }

  // Get service details from registry
  const registry = new ethers.Contract(SERVICE_REGISTRY, SERVICE_REGISTRY_ABI, provider);
  const svc = await registry.getService(serviceId);

  importLogger.info({
    serviceId,
    multisig,
    registryState: Number(svc.state),
    stakingState: Number(stakingState),
  }, 'On-chain service data retrieved');

  // ── 2. Create directory structure ─────────────────────────────────────────

  const serviceConfigId = `sc-${randomUUID()}`;
  const servicePath = join(operateBasePath, '.operate', 'services', serviceConfigId);
  await fs.mkdir(servicePath, { recursive: true });

  // ── 3. Write config.json ──────────────────────────────────────────────────

  const config = {
    name: `jinn-stolas-${serviceId}`,
    version: 9,
    service_config_id: serviceConfigId,
    package_path: 'memeooorr',
    hash: 'bafybeiawqqwkoeovm453mscwkxvmtnvaanhatlqh52cf5sdqavz6ldybae',
    hash_history: {
      [String(Math.floor(Date.now() / 1000))]: 'bafybeiawqqwkoeovm453mscwkxvmtnvaanhatlqh52cf5sdqavz6ldybae',
    },
    agent_release: {
      is_aea: false,
      repository: { owner: 'valory-xyz', name: 'meme-ooorr', version: 'v2.0.2' },
    },
    agent_addresses: [agentInstanceAddress],
    home_chain: chain,
    chain_configs: {
      [chain]: {
        ledger_config: { rpc: rpcUrl, chain },
        chain_data: {
          instances: [agentInstanceAddress],
          token: serviceId,
          multisig: ethers.getAddress(multisig),
          user_params: {
            staking_program_id: stakingContractAddress,
            nft: 'bafybeiaakdeconw7j5z76fgghfdjmsr6tzejotxcwnvmp3nroaw3glgyve',
            agent_id: agentId,
            cost_of_bond: '5000000000000000000000',
            fund_requirements: {
              '0x0000000000000000000000000000000000000000': {
                agent: '2000000000000000',   // 0.002 ETH per agent EOA
                safe: '1628500000000000',    // ~0.0016 ETH per service Safe
              },
            },
          },
        },
      },
    },
    description: '',
    env_variables: {
      MECH_MARKETPLACE_ADDRESS: { value: MECH_MARKETPLACE, provision_type: 'fixed' },
      MECH_REQUEST_PRICE: { value: '99', provision_type: 'fixed' },
      // Empty values trigger middleware mech deployment
      AGENT_ID: { value: '', provision_type: 'computed' },
      MECH_TO_CONFIG: { value: '', provision_type: 'computed' },
      ON_CHAIN_SERVICE_ID: { value: String(serviceId), provision_type: 'computed' },
      GNOSIS_LEDGER_RPC: { value: rpcUrl, provision_type: 'computed' },
      ETHEREUM_LEDGER_RPC_0: { value: rpcUrl, provision_type: 'computed' },
      GNOSIS_LEDGER_RPC_0: { value: rpcUrl, provision_type: 'computed' },
    },
  };

  const configPath = join(servicePath, 'config.json');
  await fs.writeFile(configPath, JSON.stringify(config, null, 2));

  // ── 4. Write keys.json (encrypted keystore format) ───────────────────────

  const keysPath = join(servicePath, 'keys.json');
  await fs.writeFile(keysPath, JSON.stringify([{ private_key: encryptedKeystore }]));

  // Back up key to ~/.jinn/key-backups/ (non-fatal)
  try {
    await backupKeystore({
      address: agentInstanceAddress,
      encryptedKeystore,
      operateBasePath,
      context: `import-${serviceId}`,
    });
  } catch {
    importLogger.warn({ agentInstanceAddress, serviceId }, 'Key backup failed (non-fatal)');
  }

  importLogger.info({
    serviceConfigId,
    configPath,
    multisig: ethers.getAddress(multisig),
    serviceId,
  }, 'Service imported successfully');

  return {
    serviceConfigId,
    configPath,
    keysPath,
    multisig: ethers.getAddress(multisig),
    serviceId,
  };
}
