/**
 * E2E Test Utilities
 * Shared utilities for end-to-end testing of OLAS service staking
 */

import { VnetResult } from './tenderly.js';
import { SERVICE_CONSTANTS, createDefaultServiceConfig } from 'jinn-node/worker/config/ServiceConfig.js';

export const BASE_MAINNET_CHAIN_ID = 8453;
export const OLAS_STAKING_PROGRAM_ENVIRONMENT = "custom_staking";

/**
 * Configuration for OLAS service testing
 */
export interface ServiceTestConfig {
  testId: string;
  ownerAddress: string;
  vnetResult: VnetResult;
}

/**
 * Set up required environment variables for unattended OLAS operation
 */
export function setupOlasEnvironment(config: ServiceTestConfig): void {
  if (!process.env.OPERATE_PASSWORD) {
    throw new Error('OPERATE_PASSWORD environment variable is required for E2E testing');
  }
  
  process.env.RPC_URL = config.vnetResult.adminRpcUrl;
  process.env.CHAIN_ID = BASE_MAINNET_CHAIN_ID.toString();
  process.env.RPC_URL = config.vnetResult.adminRpcUrl;
  process.env.STAKING_PROGRAM = OLAS_STAKING_PROGRAM_ENVIRONMENT;
}

/**
 * Create a properly formatted service configuration for OLAS middleware
 */
export function createServiceConfig(config: ServiceTestConfig) {
  const baseConfig = createDefaultServiceConfig({
    name: `test-service-${config.testId}`,
    description: "Test service for E2E testing",
  });

  // Override specific test configuration
  baseConfig.configurations.base.use_mech_marketplace = true;
  baseConfig.configurations.base.rpc = config.vnetResult.adminRpcUrl;
  baseConfig.configurations.base.fund_requirements = {
    "0x0000000000000000000000000000000000000000": {
      agent: SERVICE_CONSTANTS.DEFAULT_AGENT_FUNDING_WEI,
      safe: SERVICE_CONSTANTS.DEFAULT_SAFE_FUNDING_WEI
    }
  };

  // Add mech marketplace environment variable
  baseConfig.env_variables.MECH_MARKETPLACE_ADDRESS = {
    value: process.env.MECH_MARKETPLACE_ADDRESS_BASE || ""
  };

  return baseConfig;
}

/**
 * Create placeholder on-chain verification data
 * TODO: Replace with actual on-chain queries when implementing full verification
 */
export function createOnChainVerificationPlaceholder() {
  return {
    serviceExistsInRegistry: false, // Would query ServiceRegistry.exists(serviceId)
    stakingContractHasService: false, // Would query StakingContract.services(serviceId)
    serviceStateValid: false // Would verify service state is DEPLOYED
  };
}
