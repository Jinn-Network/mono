/**
 * Service Configuration Loader
 * 
 * Loads service configuration from the .operate directory at startup
 * and provides mech address, safe address, and agent EOA for use throughout the worker.
 * 
 * This replaces the need for MECH_ADDRESS, MECH_SAFE_ADDRESS, and MECH_PRIVATE_KEY env vars.
 */

import { join } from 'path';
import { readServiceConfig, type ServiceInfo } from './ServiceConfigReader.js';
import { logger } from '../logging/index.js';
import { getMechAddress as getOperateMechAddress, getServiceSafeAddress as getOperateSafeAddress, getServicePrivateKey as getOperatePrivateKey } from '../env/operate-profile.js';

const loaderLogger = logger.child({ component: 'SERVICE-CONFIG-LOADER' });

let serviceConfig: ServiceInfo | null = null;

/**
 * Initialize service configuration from middleware
 * Should be called once at worker startup
 */
export async function initializeServiceConfig(): Promise<void> {
  const middlewarePath = process.env.MIDDLEWARE_PATH || process.cwd();
  
  loaderLogger.info({ middlewarePath }, 'Loading service configuration from middleware');
  
  try {
    serviceConfig = await readServiceConfig(middlewarePath);
    
    if (!serviceConfig) {
      loaderLogger.warn('No service configuration found - worker will use environment variables as fallback');
      return;
    }
    
    loaderLogger.info({
      serviceConfigId: serviceConfig.serviceConfigId,
      serviceName: serviceConfig.serviceName,
      mechAddress: serviceConfig.mechContractAddress,
      safeAddress: serviceConfig.serviceSafeAddress,
      agentEoa: serviceConfig.agentEoaAddress,
      chain: serviceConfig.chain,
    }, 'Service configuration loaded successfully');
    
  } catch (error) {
    loaderLogger.error({ error: error instanceof Error ? error.message : String(error), middlewarePath }, 
      'Failed to load service configuration - worker will use environment variables as fallback');
  }
}

/**
 * Get mech contract address
 * Priority: 1) service config, 2) operate-profile, 3) throw error
 */
export function getMechAddress(): string {
  const addr = serviceConfig?.mechContractAddress || getOperateMechAddress() || '';
  if (!addr) {
    throw new Error('Mech address not found in service config or .operate profile');
  }
  return addr.trim();
}

/**
 * Get service Safe address
 * Priority: 1) service config, 2) operate-profile, 3) throw error
 */
export function getSafeAddress(): string {
  const addr = serviceConfig?.serviceSafeAddress || getOperateSafeAddress() || '';
  if (!addr) {
    throw new Error('Safe address not found in service config or .operate profile');
  }
  return addr.trim();
}

/**
 * Get agent EOA address
 * Prefers service config over environment variable
 */
export function getAgentEoaAddress(): string {
  const addr = serviceConfig?.agentEoaAddress || '';
  if (!addr) {
    throw new Error('Agent EOA address not found in service config');
  }
  return addr.trim();
}

/**
 * Get service configuration
 * Returns null if not initialized
 */
export function getServiceConfig(): ServiceInfo | null {
  return serviceConfig;
}

/**
 * Get agent private key
 * Priority: 1) service config, 2) operate-profile, 3) throw error
 */
export function getAgentPrivateKey(): string {
  const key = serviceConfig?.agentPrivateKey || getOperatePrivateKey() || '';
  if (!key) {
    throw new Error('Agent private key not found in service config or .operate profile');
  }
  return key.trim();
}

/**
 * Check if service config is loaded
 */
export function isServiceConfigLoaded(): boolean {
  return serviceConfig !== null && !!serviceConfig.mechContractAddress;
}

