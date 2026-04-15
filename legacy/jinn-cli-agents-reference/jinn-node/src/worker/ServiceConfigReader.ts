/**
 * Service Configuration Reader
 * 
 * Reads service configuration from middleware .operate directory
 * to extract Safe address, agent EOA, and mech contract address.
 * 
 * JINN-209: Enable Safe-based mech marketplace requests
 */

import { promises as fs } from 'fs';
import { join } from 'path';
import { logger } from '../logging/index.js';
import { decryptKeystoreV3 } from '../env/keystore-decrypt.js';
import { secrets } from '../config/index.js';

const configLogger = logger.child({ component: 'SERVICE-CONFIG-READER' });

export interface ServiceInfo {
  serviceConfigId: string;
  serviceName: string;
  serviceSafeAddress?: string;
  agentEoaAddress?: string;
  mechContractAddress?: string;
  chain: string;
  serviceId?: number;
  stakingContractAddress?: string;
  agentPrivateKey?: string;
}

export interface RedactedServiceInfoForLog extends Omit<ServiceInfo, 'agentPrivateKey'> {
  hasAgentPrivateKey: boolean;
}

/**
 * Remove sensitive fields before logging service info.
 */
export function redactServiceInfoForLog(serviceInfo: ServiceInfo): RedactedServiceInfoForLog {
  const { agentPrivateKey, ...safe } = serviceInfo;
  return {
    ...safe,
    hasAgentPrivateKey: Boolean(agentPrivateKey),
  };
}

/**
 * Read service configuration from middleware .operate directory
 * 
 * @param middlewarePath Path to olas-operate-middleware directory
 * @param serviceConfigId Optional service config ID (sc-xxx). If not provided, finds latest.
 * @returns ServiceInfo with Safe address, agent EOA, and mech address
 */
export async function readServiceConfig(
  middlewarePath: string,
  serviceConfigId?: string
): Promise<ServiceInfo | null> {
  try {
    const servicesDir = join(middlewarePath, '.operate', 'services');

    // If no serviceConfigId provided, find the latest service by modification time
    let targetServiceId = serviceConfigId;
    if (!targetServiceId) {
      const entries = await fs.readdir(servicesDir, { withFileTypes: true });
      const serviceDirs = entries
        .filter(e => e.isDirectory() && e.name.startsWith('sc-'));

      if (serviceDirs.length === 0) {
        configLogger.warn({ servicesDir }, 'No service directories found');
        return null;
      }

      // Sort by modification time (newest first)
      const dirsWithStats = await Promise.all(
        serviceDirs.map(async (dir) => {
          const dirPath = join(servicesDir, dir.name);
          const stats = await fs.stat(dirPath);
          return { name: dir.name, mtime: stats.mtime };
        })
      );

      dirsWithStats.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
      targetServiceId = dirsWithStats[0].name;
      configLogger.info({ targetServiceId }, 'Using latest service directory');
    }

    // Read service config.json
    const configPath = join(servicesDir, targetServiceId, 'config.json');
    const configContent = await fs.readFile(configPath, 'utf-8');
    const config = JSON.parse(configContent);

    // Extract service information
    const serviceName = config.name || targetServiceId;
    const homeChain = config.home_chain || 'base';

    // Get chain-specific configuration
    const chainConfig = config.chain_configs?.[homeChain]?.chain_data;
    if (!chainConfig) {
      configLogger.warn({ homeChain, serviceConfigId: targetServiceId }, 'Chain configuration not found');
      return {
        serviceConfigId: targetServiceId,
        serviceName,
        chain: homeChain,
      };
    }

    const serviceSafeAddress = chainConfig.multisig;
    const serviceId = chainConfig.token;
    const stakingContractAddress = chainConfig.user_params?.staking_program_id;

    // Read agent EOA from instances
    let agentEoaAddress: string | undefined;
    const instances = chainConfig.instances || [];
    if (instances.length > 0) {
      agentEoaAddress = instances[0]; // First instance is the agent EOA
    }

    // Read mech contract address if deployed
    let mechContractAddress: string | undefined;

    // Try to extract from env_variables.MECH_TO_CONFIG (JSON string)
    const mechToConfigEnv = config.env_variables?.MECH_TO_CONFIG?.value;
    if (mechToConfigEnv) {
      try {
        const mechToConfig = JSON.parse(mechToConfigEnv);
        const mechAddresses = Object.keys(mechToConfig);
        if (mechAddresses.length > 0) {
          mechContractAddress = mechAddresses[0]; // Use first mech address
        }
      } catch (error) {
        configLogger.debug({ error: error instanceof Error ? error.message : String(error) }, 'Failed to parse MECH_TO_CONFIG');
      }
    }

    // Fallback: Check mech_contracts field (older format)
    if (!mechContractAddress) {
      const mechContracts = config.chain_configs?.[homeChain]?.chain_data?.mech_contracts;
      if (mechContracts && mechContracts.length > 0) {
        mechContractAddress = mechContracts[0];
      }
    }

    // Read agent private key — try keys.json first (middleware daemon format),
    // fall back to deployment/agent_keys path (Docker/AEA format)
    let agentPrivateKey: string | undefined;
    try {
      const keysJsonPath = join(servicesDir, targetServiceId, 'keys.json');
      const keysJson = JSON.parse(await fs.readFile(keysJsonPath, 'utf-8'));
      if (Array.isArray(keysJson) && keysJson.length > 0 && keysJson[0].private_key) {
        const rawKey = keysJson[0].private_key;
        if (typeof rawKey === 'string' && rawKey.startsWith('{')) {
          // Encrypted keystore — decrypt with OPERATE_PASSWORD
          const password = secrets.operatePassword;
          if (password) {
            agentPrivateKey = decryptKeystoreV3(rawKey, password);
          } else {
            configLogger.warn('Encrypted keystore in keys.json but OPERATE_PASSWORD not set');
          }
        } else if (typeof rawKey === 'string' && rawKey.startsWith('0x')) {
          agentPrivateKey = rawKey;
        }
      }
    } catch {
      // keys.json not found or invalid — try legacy path
    }
    if (!agentPrivateKey) {
      try {
        const privateKeyPath = join(servicesDir, targetServiceId, 'deployment', 'agent_keys', 'agent_0', 'ethereum_private_key.txt');
        agentPrivateKey = (await fs.readFile(privateKeyPath, 'utf-8')).trim();
      } catch (error) {
        configLogger.debug({ error: error instanceof Error ? error.message : String(error) }, 'Could not read agent private key');
      }
    }

    const serviceInfo: ServiceInfo = {
      serviceConfigId: targetServiceId,
      serviceName,
      serviceSafeAddress,
      agentEoaAddress,
      mechContractAddress,
      chain: homeChain,
      serviceId,
      stakingContractAddress,
      agentPrivateKey,
    };

    configLogger.info({ serviceInfo: redactServiceInfoForLog(serviceInfo) }, 'Successfully read service configuration');
    return serviceInfo;

  } catch (error) {
    configLogger.error({ error: error instanceof Error ? error.message : String(error), middlewarePath, serviceConfigId }, 'Failed to read service configuration');
    return null;
  }
}

/**
 * Remove service directories that were created but never deployed on-chain.
 * A config is "undeployed" if chain_data.token and chain_data.multisig are both absent.
 * Also removes directories with missing or malformed config.json.
 */
export async function cleanupUndeployedConfigs(
  middlewarePath: string
): Promise<{ removed: string[]; errors: string[] }> {
  const removed: string[] = [];
  const errors: string[] = [];
  const servicesDir = join(middlewarePath, '.operate', 'services');

  let entries;
  try {
    entries = await fs.readdir(servicesDir, { withFileTypes: true });
  } catch {
    return { removed, errors };
  }

  const serviceDirs = entries.filter(e => e.isDirectory() && e.name.startsWith('sc-'));

  for (const dir of serviceDirs) {
    const servicePath = join(servicesDir, dir.name);
    const configPath = join(servicePath, 'config.json');

    try {
      const raw = await fs.readFile(configPath, 'utf-8');
      const config = JSON.parse(raw);
      const homeChain = config.home_chain || 'base';
      const chainData = config.chain_configs?.[homeChain]?.chain_data;
      const token = chainData?.token;
      const multisig = chainData?.multisig;

      // If token and multisig are both absent → never deployed on-chain
      // Note: middleware uses token=-1 as "unminted" placeholder, which is truthy in JS
      if ((!token || token === -1) && !multisig) {
        configLogger.info({ service: dir.name }, 'Removing undeployed service config');
        await fs.rm(servicePath, { recursive: true, force: true });
        removed.push(dir.name);
      }
    } catch (err: any) {
      if (err.code === 'ENOENT' || err instanceof SyntaxError) {
        // Missing or malformed config.json → remove
        configLogger.info({ service: dir.name }, 'Removing service config with missing/malformed config.json');
        try {
          await fs.rm(servicePath, { recursive: true, force: true });
          removed.push(dir.name);
        } catch (rmErr) {
          errors.push(`${dir.name}: ${rmErr}`);
        }
      }
    }
  }

  if (removed.length > 0) {
    configLogger.info({ count: removed.length, services: removed }, 'Cleaned up undeployed service configs');
  }

  return { removed, errors };
}

/**
 * List all service configurations in middleware .operate directory
 *
 * @param middlewarePath Path to olas-operate-middleware directory
 * @returns Array of ServiceInfo objects
 */
export async function listServiceConfigs(middlewarePath: string): Promise<ServiceInfo[]> {
  try {
    const servicesDir = join(middlewarePath, '.operate', 'services');
    const entries = await fs.readdir(servicesDir, { withFileTypes: true });
    const serviceDirs = entries
      .filter(e => e.isDirectory() && e.name.startsWith('sc-'))
      .sort((a, b) => b.name.localeCompare(a.name)); // Sort descending (latest first)

    const services: ServiceInfo[] = [];
    for (const dir of serviceDirs) {
      const serviceInfo = await readServiceConfig(middlewarePath, dir.name);
      if (serviceInfo) {
        services.push(serviceInfo);
      }
    }

    return services;
  } catch (error) {
    configLogger.error({ error: error instanceof Error ? error.message : String(error), middlewarePath }, 'Failed to list service configurations');
    return [];
  }
}
