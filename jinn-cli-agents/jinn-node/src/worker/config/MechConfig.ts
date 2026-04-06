/**
 * Mech Configuration Utilities
 * 
 * Centralizes mech-related configuration logic and constants.
 */

import { SERVICE_CONSTANTS } from "./ServiceConfig.js";

/**
 * Default maxDeliveryRate for mech contracts (in wei).
 * Must match ecosystem standard — the marketplace rejects deliveries where
 * the mech's rate exceeds the requester's agreed rate.
 * Reference: priority mechs on Base use maxDeliveryRate = 99.
 */
export const DEFAULT_MECH_DELIVERY_RATE = '99';

/**
 * Mech deployment result interface
 */
export interface MechDeploymentResult {
  mechAddress: string;
  agentId: string;
}

/**
 * Mech persistence info interface
 */
export interface MechPersistenceInfo {
  mechAddress: string;
  agentId: string;
  serviceName: string;
  configPath: string;
  deployedAt: string;
  lastUpdated: string;
}

/**
 * Enables mech marketplace in a service configuration
 */
export function enableMechMarketplaceInConfig(
  config: any, 
  mechMarketplaceAddress: string,
  mechRequestPrice?: string
): void {
  if (!config.configurations || !config.home_chain) {
    throw new Error("Invalid service configuration: missing configurations or home_chain");
  }

  const homeChainConfig = config.configurations[config.home_chain];
  if (!homeChainConfig) {
    throw new Error(`Missing configuration for home chain: ${config.home_chain}`);
  }

  // Enable mech marketplace
  homeChainConfig.use_mech_marketplace = true;

  // Add mech marketplace environment variables
  if (!config.env_variables) {
    config.env_variables = {};
  }

  // CRITICAL: Middleware checks for ALL these vars before deploying mech
  // See operate/services/manage.py:1118-1127
  config.env_variables.MECH_MARKETPLACE_ADDRESS = {
    value: mechMarketplaceAddress,
    provision_type: "fixed"
  };
  
  config.env_variables.MECH_REQUEST_PRICE = {
    value: mechRequestPrice || DEFAULT_MECH_DELIVERY_RATE,
    provision_type: "fixed"
  };
  
  config.env_variables.AGENT_ID = {
    value: "",  // Empty triggers mech deployment
    provision_type: "computed"
  };
  
  config.env_variables.MECH_TO_CONFIG = {
    value: "",  // Empty triggers mech deployment
    provision_type: "computed"
  };
  
  config.env_variables.ON_CHAIN_SERVICE_ID = {
    value: "",
    provision_type: "computed"
  };
  
  // Middleware sets BOTH non-suffixed AND _0 suffixed RPC vars
  // See operate/services/manage.py:709 and migration.py:46
  config.env_variables.GNOSIS_LEDGER_RPC = {
    value: "",  // Middleware reads from this (line 1160)
    provision_type: "computed"
  };
  
  config.env_variables.ETHEREUM_LEDGER_RPC_0 = {
    value: "",  // Middleware writes to this (line 1160)
    provision_type: "computed"
  };
  
  config.env_variables.GNOSIS_LEDGER_RPC_0 = {
    value: "",  // Middleware writes to this (line 1163)
    provision_type: "computed"
  };
}

/**
 * Parses mech deployment output to extract address and agent ID
 */
export function parseMechDeployOutput(output: string): MechDeploymentResult {
  try {
    // First try to parse as JSON
    const lines = output.split('\n');
    for (const line of lines) {
      if (line.trim().startsWith('{') && line.trim().endsWith('}')) {
        try {
          const parsed = JSON.parse(line.trim());
          if (parsed.mech_address && parsed.agent_id) {
            return {
              mechAddress: parsed.mech_address,
              agentId: parsed.agent_id.toString()
            };
          }
        } catch {
          continue;
        }
      }
    }

    // Fallback to regex parsing
    const mechAddressMatch = output.match(/mech_address[:\s]+([0-9a-fA-Fx]+)/i);
    const agentIdMatch = output.match(/agent_id[:\s]+(\d+)/i);

    if (mechAddressMatch && agentIdMatch) {
      return {
        mechAddress: mechAddressMatch[1],
        agentId: agentIdMatch[1]
      };
    }

    throw new Error("Could not find mech_address and agent_id in output");
  } catch (error) {
    throw new Error(`Failed to parse mech deploy output: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Creates mech persistence info object
 */
export function createMechPersistenceInfo(
  mechAddress: string,
  agentId: string,
  serviceName: string,
  configPath: string
): MechPersistenceInfo {
  const now = new Date().toISOString();
  
  return {
    mechAddress,
    agentId,
    serviceName,
    configPath,
    deployedAt: now,
    lastUpdated: now
  };
}

/**
 * Gets the mech info file path for a service
 */
export function getMechInfoPath(configPath: string, serviceName: string): string {
  const path = require('path');
  const mechInfoDir = path.join(path.dirname(configPath), SERVICE_CONSTANTS.MECH_INFO_DIR);
  return path.join(mechInfoDir, `${serviceName}-mech.json`);
}
