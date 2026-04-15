/**
 * ⚠️ DEPRECATED - DO NOT USE ⚠️
 * 
 * This class is DEPRECATED and SHOULD NOT be used under any circumstances.
 * 
 * Use the olas-operate-middleware CLI directly instead:
 * - For staking: `poetry run python -m operate.quickstart`
 * - For claiming: `poetry run python -m operate.cli claim`
 * - For termination: `poetry run python -m operate.cli terminate`
 * 
 * The operate CLI is the official interface and handles all service lifecycle operations correctly.
 * This wrapper layer adds complexity and potential for errors.
 * 
 * @deprecated Use olas-operate-middleware CLI directly
 * 
 * OLAS Service Manager (DEPRECATED)
 *
 * Manages the OLAS service lifecycle through the olas-operate-middleware CLI.
 * This class abstracts the entire service lifecycle (creation, deployment, staking)
 * into high-level calls to the middleware, removing direct blockchain interactions.
 *
 * Part of JINN-180: Refactor OlasServiceManager for Service Lifecycle
 */

import { OlasOperateWrapper, OperateCommandResult } from "./OlasOperateWrapper.js";
import { logger } from '../logging/index.js';
import { writeFileSync } from "fs";
import { promises as fs } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { config as nodeConfig, secrets } from '../config/index.js';
import {
  SERVICE_CONSTANTS,
  createDefaultServiceConfig,
  validateServiceConfig,
  extractServiceName
} from "./config/ServiceConfig.js";
import {
  enableMechMarketplaceInConfig,
  parseMechDeployOutput,
  createMechPersistenceInfo,
  getMechInfoPath
} from "./config/MechConfig.js";

const serviceLogger = logger.child({ component: "OLAS-SERVICE-MANAGER" });

export interface CreateServiceResult {
  success: boolean;
  serviceConfigId?: string;
  error?: string;
}

export interface QuickstartOptions {
  chain: string;
  keys?: string;
}

export interface ServiceInfo {
  serviceId?: number;
  serviceName: string;
  configPath: string;
  isRunning: boolean;
  isStaked: boolean;
  stakingContract?: string;
  mechAddress?: string;
  agentId?: string;
}

export interface ServiceManagerConfig {
  operateWrapper?: OlasOperateWrapper;
  serviceConfigPath?: string;
}

export enum ServiceLifecycleTransition {
  ServiceDeployed = "SERVICE_DEPLOYED",
  ServiceStaked = "SERVICE_STAKED",
  MechDeployed = "MECH_DEPLOYED",
  ServiceStopped = "SERVICE_STOPPED",
  ServiceTerminated = "SERVICE_TERMINATED",
  RewardsClaimed = "REWARDS_CLAIMED",
  NoActionNeeded = "NO_ACTION_NEEDED",
}

export interface ServiceLifecycleResult {
  transition: ServiceLifecycleTransition;
  serviceInfo?: ServiceInfo;
  error?: string;
}

export class OlasServiceManager {
  private operateWrapper: OlasOperateWrapper;
  private serviceConfigPath: string;

  constructor(operateWrapper: OlasOperateWrapper, serviceConfigPath: string) {
    if (!operateWrapper) {
      throw new Error("OlasServiceManager requires OlasOperateWrapper instance");
    }
    if (!serviceConfigPath) {
      throw new Error("OlasServiceManager requires service config path");
    }

    this.operateWrapper = operateWrapper;
    this.serviceConfigPath = serviceConfigPath;

    serviceLogger.info({
      serviceConfigPath: this.serviceConfigPath,
    }, "OlasServiceManager initialized with operate wrapper");
  }

  /**
   * Get the service configuration path
   */
  getServiceConfigPath(): string {
    return this.serviceConfigPath;
  }

  static async createDefault(options: ServiceManagerConfig = {}): Promise<OlasServiceManager> {
    const operateWrapper = options.operateWrapper || await OlasOperateWrapper.create();
    const serviceConfigPath = options.serviceConfigPath || process.env.OLAS_SERVICE_CONFIG_PATH || this.generateDefaultConfigPath();

    return new OlasServiceManager(operateWrapper, serviceConfigPath);
  }

  /**
   * Generate a default service configuration path for cases where none is provided
   * This creates a proper quickstart configuration compatible with the middleware
   */
  private static generateDefaultConfigPath(): string {
    const defaultConfig = createDefaultServiceConfig();
    const configPath = `${tmpdir()}/olas-default-service-config.json`;

    try {
      writeFileSync(configPath, JSON.stringify(defaultConfig, null, 2));
      serviceLogger.info({ configPath }, "Generated default service configuration");
    } catch (error) {
      serviceLogger.warn({ error, configPath }, "Failed to write default config, using in-memory path");
    }

    return configPath;
  }

  /**
   * Deploy and stake a service using the operate HTTP API
   * This is the primary method that combines service creation, deployment, and staking
   * 
   * @param serviceConfigPath Optional path to service config (uses instance config if not provided)
   * @returns Promise<ServiceInfo> Information about the deployed and staked service
   */
  async deployAndStakeService(serviceConfigPath?: string): Promise<ServiceInfo> {
    const configPath = serviceConfigPath || this.serviceConfigPath;
    serviceLogger.info({ configPath }, "Deploying and staking service via HTTP API");

    try {
      // Step 1: Start server and authenticate
      const serverResult = await this.operateWrapper.bootstrapWallet({
        password: secrets.operatePassword || "12345678",
        chain: "base",
        ledgerType: "ethereum"
      });

      if (!serverResult.success) {
        // If wallet funding failed, try Tenderly funding approach
        if (serverResult.error?.includes('Client does not have any funds') ||
          serverResult.error?.includes('Safe creation failed')) {
          serviceLogger.info("Wallet funding failed, attempting Tenderly funding approach");
          return await this.deployWithTenderlyFunding(configPath);
        }
        throw new Error(`Failed to bootstrap wallet: ${serverResult.error}`);
      }

      // Step 2: Create service via HTTP API
      const serviceConfig = await this.loadServiceConfig(configPath);
      const createResult = await this.createServiceViaAPI(serviceConfig);

      if (!createResult.success) {
        throw new Error(`Failed to create service: ${createResult.error}`);
      }

      const serviceConfigId = createResult.serviceConfigId;
      if (!serviceConfigId) {
        throw new Error('Service creation succeeded but no serviceConfigId returned');
      }
      serviceLogger.info({ serviceConfigId }, "Service created successfully");

      // Step 3: Deploy and stake service via HTTP API
      const deployResult = await this.deployServiceViaAPI(serviceConfigId);

      if (!deployResult.success) {
        throw new Error(`Failed to deploy and stake service: ${deployResult.error}`);
      }

      serviceLogger.info({ serviceConfigId }, "Service deployed and staked successfully");

      return {
        serviceName: this.extractServiceNameFromConfig(configPath),
        configPath,
        isRunning: true,
        isStaked: true,
        serviceId: deployResult.serviceData?.chain_configs?.base?.chain_data?.token,
        stakingContract: deployResult.serviceData?.chain_configs?.base?.chain_data?.user_params?.staking_program_id,
      };

    } catch (error) {
      serviceLogger.error({ error, configPath }, "Failed to deploy and stake service via HTTP API");
      throw new Error(`Failed to deploy and stake service: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Stop a running service using the operate quickstop command
   * 
   * @param serviceConfigPath Optional path to service config (uses instance config if not provided)
   * @returns Promise<ServiceInfo> Information about the stopped service
   */
  async stopService(serviceConfigPath?: string): Promise<ServiceInfo> {
    const configPath = serviceConfigPath || this.serviceConfigPath;
    serviceLogger.info({ configPath }, "Stopping service via operate quickstop");

    try {
      const result = await this.operateWrapper.executeCommand('quickstop', [configPath]);

      if (!result.success) {
        throw new Error(`Quickstop command failed: ${result.stderr || result.stdout}`);
      }

      serviceLogger.info({ configPath }, "Service stopped successfully");

      // Query actual status after stopping to get accurate staking info
      const { isStaked } = await this.queryServiceStatus(configPath);

      return {
        serviceName: this.extractServiceNameFromConfig(configPath),
        configPath,
        isRunning: false,
        isStaked, // Use actual status rather than assuming false
      };

    } catch (error) {
      serviceLogger.error({ error, configPath }, "Failed to stop service");
      throw new Error(`Failed to stop service: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Claim staking rewards using the operate claim command
   * 
   * @param serviceConfigPath Optional path to service config (uses instance config if not provided)
   * @returns Promise<ServiceInfo> Information about the service after claiming rewards
   */
  async claimRewards(serviceConfigPath?: string): Promise<ServiceInfo> {
    return this.executeServiceCommand(
      'claim',
      serviceConfigPath,
      'Claiming staking rewards via operate claim',
      'Staking rewards claimed successfully',
      'Failed to claim staking rewards',
      { isRunning: true, isStaked: true },
      ['--attended=false']
    );
  }

  /**
   * Terminate a service using the operate terminate command
   * 
   * @param serviceConfigPath Optional path to service config (uses instance config if not provided)
   * @returns Promise<ServiceInfo> Information about the terminated service
   */
  async terminateService(serviceConfigPath?: string): Promise<ServiceInfo> {
    return this.executeServiceCommand(
      'terminate',
      serviceConfigPath,
      'Terminating service via operate terminate',
      'Service terminated successfully',
      'Failed to terminate service',
      { isRunning: false, isStaked: false },
      ['--attended=false']
    );
  }

  /**
   * Deploy a Mech contract for the service via the MechMarketplace
   * This method uses the olas-operate-middleware to deploy a service with mech marketplace enabled.
   * Since there's no separate 'mech deploy' command, we need to create a service config with
   * mech marketplace enabled and use the standard deployment process.
   * 
   * @param serviceConfigPath Optional path to service config (uses instance config if not provided)
   * @returns Promise<ServiceInfo> Information about the service including mech_address and agent_id
   */
  async deployMech(serviceConfigPath?: string): Promise<ServiceInfo> {
    const configPath = serviceConfigPath || this.serviceConfigPath;
    serviceLogger.info({ configPath }, "Deploying Mech via service config with marketplace enabled");

    try {
      // First, ensure the service config has mech marketplace enabled
      await this.enableMechMarketplaceInConfig(configPath);

      // Deploy service with mech marketplace enabled
      const result = await this.operateWrapper.executeCommand('quickstart', [configPath, '--attended=false']);

      if (!result.success) {
        throw new Error(`Service deployment with mech failed: ${result.stderr || result.stdout}`);
      }

      // Parse the output to extract mech_address and agent_id
      const { mechAddress, agentId } = parseMechDeployOutput(result.stdout);

      serviceLogger.info({
        configPath,
        mechAddress,
        agentId
      }, "Mech deployed successfully via service deployment");

      // Persist mech information for mech-client-ts monitoring
      await this.persistMechInfo(configPath, mechAddress, agentId);

      // Get current service status and add mech information
      const currentStatus = await this.getServiceStatus(configPath);

      return {
        ...currentStatus,
        mechAddress,
        agentId,
      };

    } catch (error) {
      serviceLogger.error({ error, configPath }, "Failed to deploy mech");
      throw new Error(`Failed to deploy mech: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Get the current status of a service
   * 
   * @param serviceConfigPath Optional path to service config (uses instance config if not provided)
   * @returns Promise<ServiceInfo> Current service information
   */
  async getServiceStatus(serviceConfigPath?: string): Promise<ServiceInfo> {
    const configPath = serviceConfigPath || this.serviceConfigPath;

    try {
      const { isRunning, isStaked } = await this.queryServiceStatus(configPath);

      return {
        serviceName: this.extractServiceNameFromConfig(configPath),
        configPath,
        isRunning,
        isStaked,
      };
    } catch (error) {
      serviceLogger.error({ error, configPath }, "Failed to get service status");
      throw new Error(`Failed to get service status: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Query the actual service status from the operate CLI
   * @private
   */
  private async queryServiceStatus(configPath: string): Promise<{ isRunning: boolean; isStaked: boolean }> {
    try {
      // Try to get status with JSON output first
      const statusResult = await this.operateWrapper.executeCommand('service', ['status', configPath, '--json']);
      if (statusResult.success && statusResult.stdout.trim()) {
        try {
          const statusData = JSON.parse(statusResult.stdout);
          return {
            isRunning: statusData.is_running === true || statusData.status === 'running',
            isStaked: statusData.is_staked === true || statusData.staking_status === 'staked'
          };
        } catch (jsonError) {
          serviceLogger.debug({ jsonError }, "Failed to parse JSON status, falling back to text parsing");
        }
      }

      // Fallback to text parsing if JSON fails
      const textStatusResult = await this.operateWrapper.executeCommand('service', ['status', configPath]);
      if (textStatusResult.success) {
        const statusOutput = textStatusResult.stdout.toLowerCase();
        return {
          isRunning: statusOutput.includes('running') || statusOutput.includes('active'),
          isStaked: statusOutput.includes('staked') || statusOutput.includes('deployed')
        };
      }
    } catch (statusError) {
      serviceLogger.debug({ statusError, configPath }, "Could not query service status, using defaults");
    }

    // Conservative defaults if status query fails
    return { isRunning: false, isStaked: false };
  }

  /**
   * Execute a service command with common error handling and logging
   * @private
   */
  private async executeServiceCommand(
    command: string,
    serviceConfigPath: string | undefined,
    startMessage: string,
    successMessage: string,
    errorMessage: string,
    statusOverride: Pick<ServiceInfo, 'isRunning' | 'isStaked'>,
    optionalFlags: string[] = []
  ): Promise<ServiceInfo> {
    const configPath = serviceConfigPath || this.serviceConfigPath;
    serviceLogger.info({ configPath }, startMessage);

    try {
      const result = await this.executeCommandWithFallback(command, [configPath], optionalFlags);

      if (!result.success) {
        throw new Error(`${command} command failed: ${result.stderr || result.stdout}`);
      }

      serviceLogger.info({ configPath, stdout: result.stdout }, successMessage);

      return {
        serviceName: this.extractServiceNameFromConfig(configPath),
        configPath,
        ...statusOverride,
      };

    } catch (error) {
      serviceLogger.error({ error, configPath }, errorMessage);
      throw new Error(`${errorMessage}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Execute a command with fallback options for unsupported flags
   * @private
   */
  private async executeCommandWithFallback(
    command: string,
    baseArgs: string[],
    optionalFlags: string[] = []
  ): Promise<OperateCommandResult> {
    // First try with all optional flags
    const fullArgs = [...baseArgs, ...optionalFlags];

    try {
      const result = await this.operateWrapper.executeCommand(command, fullArgs);

      // If successful, return the result
      if (result.success) {
        return result;
      }

      // If failed due to unknown flag, try fallback
      const errorOutput = (result.stderr || result.stdout || '').toLowerCase();
      const hasUnknownFlag = errorOutput.includes('unknown flag') ||
        errorOutput.includes('unrecognized option') ||
        errorOutput.includes('invalid option');

      if (hasUnknownFlag && optionalFlags.length > 0) {
        serviceLogger.warn({
          command,
          optionalFlags,
          error: result.stderr
        }, "Optional flags not supported, retrying without them");

        // Retry without optional flags
        return await this.operateWrapper.executeCommand(command, baseArgs);
      }

      return result;

    } catch (error) {
      // If command execution throws, try fallback if we have optional flags
      if (optionalFlags.length > 0) {
        serviceLogger.warn({
          command,
          optionalFlags,
          error: error instanceof Error ? error.message : String(error)
        }, "Command failed with optional flags, retrying without them");

        return await this.operateWrapper.executeCommand(command, baseArgs);
      }

      throw error;
    }
  }

  /**
   * Persist mech information to file for mech-client-ts monitoring
   * @private
   */
  private async persistMechInfo(configPath: string, mechAddress: string, agentId: string): Promise<void> {
    try {
      const fs = await import('fs/promises');
      const path = await import('path');

      const serviceName = this.extractServiceNameFromConfig(configPath);
      const mechInfoPath = getMechInfoPath(configPath, serviceName);
      const mechInfo = createMechPersistenceInfo(mechAddress, agentId, serviceName, configPath);

      // Create directory and write file
      const pathModule = await import('path');
      await fs.mkdir(pathModule.dirname(mechInfoPath), { recursive: true });
      await fs.writeFile(mechInfoPath, JSON.stringify(mechInfo, null, 2));

      serviceLogger.info({
        mechInfoPath,
        mechAddress,
        agentId
      }, "Persisted mech information for monitoring");

    } catch (error) {
      serviceLogger.error({ error, configPath }, "Failed to persist mech information");
      // Don't throw here as this is not critical for operation
    }
  }

  /**
   * Enable mech marketplace in service configuration
   * @private
   */
  private async enableMechMarketplaceInConfig(configPath: string): Promise<void> {
    try {
      const fs = await import('fs/promises');

      // Read existing config
      const configContent = await fs.readFile(configPath, 'utf8');
      const config = JSON.parse(configContent);

      // Get mech marketplace address from config
      const mechMarketplaceAddress = process.env.MECH_MARKETPLACE_ADDRESS_BASE;
      if (!mechMarketplaceAddress) {
        throw new Error('MECH_MARKETPLACE_ADDRESS_BASE is required for mech deployment');
      }

      enableMechMarketplaceInConfig(config, mechMarketplaceAddress);

      // Write updated config back
      await fs.writeFile(configPath, JSON.stringify(config, null, 2));

      serviceLogger.info({ configPath, mechMarketplaceAddress }, "Enabled mech marketplace in service config");

    } catch (error) {
      serviceLogger.error({ error, configPath }, "Failed to enable mech marketplace in config");
      throw new Error(`Failed to enable mech marketplace in config: ${error instanceof Error ? error.message : String(error)}`);
    }
  }


  /**
   * Load service configuration from file
   * @private
   */
  private async loadServiceConfig(configPath: string): Promise<any> {
    try {
      const fs = await import('fs/promises');
      const configContent = await fs.readFile(configPath, 'utf8');
      return JSON.parse(configContent);
    } catch (error) {
      serviceLogger.error({ error, configPath }, "Failed to load service configuration");
      throw new Error(`Failed to load service configuration: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Create service via HTTP API
   * @private
   */
  private async createServiceViaAPI(serviceConfig: any): Promise<{
    success: boolean;
    serviceConfigId?: string;
    error?: string;
  }> {
    try {
      const result = await this.operateWrapper.makeRequest('/api/v2/service', 'POST', {
        ...serviceConfig,
        deploy: false // We'll deploy in a separate step
      });

      if (result.success && result.data?.service_config_id) {
        return {
          success: true,
          serviceConfigId: result.data.service_config_id
        };
      }

      return {
        success: false,
        error: result.error || 'Failed to create service'
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  /**
   * Deploy and stake service via HTTP API
   * @private
   */
  private async deployServiceViaAPI(serviceConfigId: string): Promise<{
    success: boolean;
    serviceData?: any;
    error?: string;
  }> {
    try {
      const result = await this.operateWrapper.makeRequest(`/api/v2/service/${serviceConfigId}`, 'POST');

      if (result.success && result.data) {
        return {
          success: true,
          serviceData: result.data
        };
      }

      return {
        success: false,
        error: result.error || 'Failed to deploy and stake service'
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  /**
   * Wait for wallet balance to be recognized by RPC after Tenderly funding
   * @private
   */
  private async waitForBalance(walletAddress: string, expectedAmount: string, rpcUrl: string): Promise<boolean> {
    const maxRetries = 10;
    const retryDelay = 2000; // 2 seconds

    serviceLogger.info({ walletAddress, expectedAmount, rpcUrl }, "Starting balance verification");

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        // Use ethers to check balance directly via RPC
        const { ethers } = await import('ethers');
        const { createRpcProvider } = await import('../config/index.js');
        const provider = createRpcProvider(rpcUrl);
        const balance = await provider.getBalance(walletAddress);
        const balanceEth = ethers.formatEther(balance);
        const expectedEth = ethers.formatEther(expectedAmount);

        serviceLogger.info({
          attempt,
          walletAddress,
          balance: balanceEth,
          expected: expectedEth
        }, "Balance check");

        // Check if balance is at least the expected amount
        if (balance >= BigInt(expectedAmount)) {
          serviceLogger.info({
            walletAddress,
            balance: balanceEth,
            attempts: attempt
          }, "Balance verification successful");
          return true;
        }

        if (attempt < maxRetries) {
          serviceLogger.info({
            attempt,
            maxRetries,
            walletAddress,
            balance: balanceEth,
            expected: expectedEth
          }, "Balance not yet available, retrying");
          await new Promise(resolve => setTimeout(resolve, retryDelay));
        }
      } catch (error) {
        serviceLogger.warn({
          attempt,
          error: error instanceof Error ? error.message : String(error)
        }, "Balance check failed");

        if (attempt < maxRetries) {
          await new Promise(resolve => setTimeout(resolve, retryDelay));
        }
      }
    }

    serviceLogger.error({ walletAddress, maxRetries }, "Balance verification failed after maximum retries");
    return false;
  }

  /**
   * Deploy service using Tenderly funding approach
   * @private
   */
  private async deployWithTenderlyFunding(configPath: string): Promise<ServiceInfo> {
    const { createTenderlyClient, ethToWei } = await import('../lib/tenderly.js');

    serviceLogger.info("Setting up Tenderly environment for funded deployment");

    // Step 0: Stop the original wrapper's server to prevent port conflicts
    serviceLogger.info("Stopping original server to prevent port conflicts");
    await this.operateWrapper.stopServer();

    // Create Tenderly client and VNet
    const tenderlyClient = createTenderlyClient();
    if (!tenderlyClient.isConfigured()) {
      throw new Error('Tenderly client must be configured. Set TENDERLY_ACCESS_KEY, TENDERLY_ACCOUNT_SLUG, and TENDERLY_PROJECT_SLUG environment variables.');
    }

    const vnetResult = await tenderlyClient.createVnet(8453); // Base mainnet
    serviceLogger.info({ vnetId: vnetResult.id, adminRpcUrl: vnetResult.adminRpcUrl }, "Created Tenderly VNet");

    let tenderlyOperateWrapper: any = null;
    try {
      // Create a new OlasOperateWrapper configured to use the Tenderly VNet RPC
      const { OlasOperateWrapper } = await import('./OlasOperateWrapper.js');
      tenderlyOperateWrapper = await OlasOperateWrapper.create({
        middlewarePath: this.operateWrapper.getMiddlewarePath(),
        rpcUrl: vnetResult.publicRpcUrl || vnetResult.adminRpcUrl // Use Tenderly VNet RPC
      });

      // First, set up the server with just account and wallet creation (no Safe yet)
      const serverResult = await tenderlyOperateWrapper.bootstrapWalletWithoutSafe({
        password: secrets.operatePassword || "12345678",
        chain: "base",
        ledgerType: "ethereum"
      });

      if (!serverResult.success) {
        throw new Error(`Failed to bootstrap wallet: ${serverResult.error}`);
      }

      // Fund the wallet address with ETH via Tenderly
      const walletAddress = serverResult.walletAddress;
      if (!walletAddress) {
        throw new Error("Wallet address not returned from bootstrap");
      }

      const fundingAmount = ethToWei('0.1'); // 0.1 ETH should be enough for Safe creation
      await tenderlyClient.fundAddress(walletAddress, fundingAmount, vnetResult.adminRpcUrl);
      serviceLogger.info({ walletAddress, amount: '0.1 ETH' }, "Funded wallet via Tenderly");

      // Wait for balance to be recognized by RPC before Safe creation
      const balanceVerified = await this.waitForBalance(walletAddress, fundingAmount, vnetResult.publicRpcUrl || vnetResult.adminRpcUrl);
      if (!balanceVerified) {
        throw new Error("Wallet balance not confirmed after Tenderly funding");
      }
      serviceLogger.info({ walletAddress }, "Balance verified, proceeding with Safe creation");

      // Now create the Safe with the funded wallet using the Tenderly-configured wrapper
      const safeResult = await tenderlyOperateWrapper.createSafe("base");
      if (!safeResult.success) {
        throw new Error(`Failed to create Safe after funding: ${safeResult.error}`);
      }
      serviceLogger.info({ safeAddress: safeResult.safeAddress }, "Safe created successfully with funded wallet");

      // Now create the service with funded wallet using the Tenderly-configured wrapper
      const serviceConfig = await this.loadServiceConfig(configPath);

      // Update service config to use Tenderly RPC
      serviceConfig.configurations.base.rpc = vnetResult.publicRpcUrl || vnetResult.adminRpcUrl;

      // Create a temporary service manager with the Tenderly wrapper for API calls
      const tenderlyServiceManager = new OlasServiceManager(tenderlyOperateWrapper, configPath);

      const createResult = await tenderlyServiceManager.createServiceViaAPI(serviceConfig);

      if (!createResult.success) {
        throw new Error(`Failed to create service: ${createResult.error}`);
      }

      const serviceConfigId = createResult.serviceConfigId;
      if (!serviceConfigId) {
        throw new Error('Service creation succeeded but no serviceConfigId returned');
      }
      serviceLogger.info({ serviceConfigId }, "Service created successfully on Tenderly");

      // Deploy and stake service
      const deployResult = await tenderlyServiceManager.deployServiceViaAPI(serviceConfigId);

      if (!deployResult.success) {
        throw new Error(`Failed to deploy and stake service: ${deployResult.error}`);
      }

      serviceLogger.info({ serviceConfigId, vnetId: vnetResult.id }, "Service deployed and staked successfully on Tenderly");

      return {
        serviceName: this.extractServiceNameFromConfig(configPath),
        configPath,
        isRunning: true,
        isStaked: true,
        serviceId: deployResult.serviceData?.chain_configs?.base?.chain_data?.token,
        stakingContract: deployResult.serviceData?.chain_configs?.base?.chain_data?.user_params?.staking_program_id,
      };

    } finally {
      // Clean up Tenderly server
      if (tenderlyOperateWrapper) {
        try {
          await tenderlyOperateWrapper.stopServer();
          serviceLogger.info("Cleaned up Tenderly server");
        } catch (error) {
          serviceLogger.warn({ error }, "Failed to cleanup Tenderly server");
        }
      }

      // Clean up Tenderly VNet
      try {
        await tenderlyClient.deleteVnet(vnetResult.id);
        serviceLogger.info({ vnetId: vnetResult.id }, "Cleaned up Tenderly VNet");
      } catch (error) {
        serviceLogger.warn({ error, vnetId: vnetResult.id }, "Failed to cleanup Tenderly VNet");
      }
    }
  }

  /**
   * Extract service name from config path
   * @private
   */
  private extractServiceNameFromConfig(configPath: string): string {
    return extractServiceName(configPath);
  }

  /**
   * Create a service using the operate quickstart command
   * This is used by the interactive bootstrap wizard
   */
  async createServiceViaQuickstart(options: { chain: string, keys?: string }): Promise<CreateServiceResult> {
    try {
      const args = ['--quick-start', options.chain];
      if (options.keys) {
        args.push('--keys', options.keys);
      }

      // JINN-198 Fix: The middleware CLI expects `operate new service`, not `operate service new`
      const result = await this.operateWrapper.executeCommand('service', ['create', ...args]);

      if (!result.success) {
        return { success: false, error: result.stderr || 'Failed to create service' };
      }

      // Find the created service config ID from stdout
      // e.g., "Service config created with ID: sc-..."
      const match = result.stdout.match(/Service config created with ID: (sc-[a-f0-9-]+)/);
      if (!match || !match[1]) {
        return { success: false, error: 'Could not parse service config ID from output' };
      }
      const serviceConfigId = match[1];

      return { success: true, serviceConfigId };

    } catch (error) {
      serviceLogger.error({ error }, "Failed to create service via quickstart");
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Public helper to create a service via HTTP API from a template
   */
  async createServiceFromTemplate(serviceTemplate: any): Promise<{
    success: boolean;
    serviceConfigId?: string;
    error?: string;
  }> {
    return await this.createServiceViaAPI(serviceTemplate);
  }

  /**
   * Clean up corrupted service directories
   * Removes services with:
   * - Missing config.json
   * - Zero address Safe (0x000...)
   * - NO_MULTISIG placeholder
   * - Token ID -1 (unminted)
   * - Malformed JSON
   */
  async cleanupCorruptServices(): Promise<{ cleaned: string[]; errors: string[] }> {
    const cleaned: string[] = [];
    const errors: string[] = [];

    try {
      const middlewarePath = this.operateWrapper.getMiddlewarePath();
      const servicesDir = join(middlewarePath, '.operate/services');

      // Check if services directory exists
      try {
        await fs.access(servicesDir);
      } catch {
        serviceLogger.debug({ servicesDir }, "Services directory doesn't exist, nothing to clean");
        return { cleaned, errors };
      }

      const entries = await fs.readdir(servicesDir, { withFileTypes: true });
      const servicesDirs = entries.filter(e => e.isDirectory() && e.name.startsWith('sc-'));

      serviceLogger.info({ count: servicesDirs.length }, "Checking service directories for corruption");

      for (const dir of servicesDirs) {
        const servicePath = join(servicesDir, dir.name);
        const configPath = join(servicePath, 'config.json');

        try {
          // Check if config.json exists
          await fs.access(configPath);

          // Read and validate config
          const configContent = await fs.readFile(configPath, 'utf-8');
          let config: any;

          try {
            config = JSON.parse(configContent);
          } catch {
            // Malformed JSON
            serviceLogger.warn({ service: dir.name }, "Service has malformed config.json, removing");
            await fs.rm(servicePath, { recursive: true, force: true });
            cleaned.push(dir.name);
            continue;
          }

          // Check for corruption markers
          let isCorrupt = false;
          const chainConfigs = config.chain_configs || {};

          for (const [chain, chainData] of Object.entries<any>(chainConfigs)) {
            const multisig = chainData?.chain_data?.multisig;
            const token = chainData?.chain_data?.token;

            // Check for zero address
            if (multisig === '0x0000000000000000000000000000000000000000') {
              serviceLogger.warn({ service: dir.name, chain }, "Service has zero address Safe, removing");
              isCorrupt = true;
              break;
            }

            // Check for NO_MULTISIG placeholder
            if (multisig === 'NO_MULTISIG') {
              serviceLogger.warn({ service: dir.name, chain }, "Service has NO_MULTISIG placeholder, removing");
              isCorrupt = true;
              break;
            }

            // Check for unminted token (-1)
            if (token === -1) {
              serviceLogger.warn({ service: dir.name, chain }, "Service has unminted token ID (-1), removing");
              isCorrupt = true;
              break;
            }
          }

          if (isCorrupt) {
            await fs.rm(servicePath, { recursive: true, force: true });
            cleaned.push(dir.name);
          }

        } catch (error: any) {
          if (error.code === 'ENOENT') {
            // Missing config.json
            serviceLogger.warn({ service: dir.name }, "Service missing config.json, removing");
            try {
              await fs.rm(servicePath, { recursive: true, force: true });
              cleaned.push(dir.name);
            } catch (rmError) {
              errors.push(`Failed to remove ${dir.name}: ${rmError}`);
            }
          } else {
            errors.push(`Error checking ${dir.name}: ${error.message}`);
          }
        }
      }

      if (cleaned.length > 0) {
        serviceLogger.info({ count: cleaned.length, services: cleaned }, "Cleaned up corrupt services");
      } else {
        serviceLogger.info("No corrupt services found");
      }

    } catch (error: any) {
      serviceLogger.error({ error }, "Failed to cleanup corrupt services");
      errors.push(`Cleanup failed: ${error.message}`);
    }

    return { cleaned, errors };
  }
}
