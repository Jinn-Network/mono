/**
 * SimplifiedServiceBootstrap - JINN-202
 *
 * Uses middleware HTTP daemon and JSON APIs for service deployment.
 *
 * Architecture:
 * - Starts `operate daemon --port=8765` subprocess
 * - Communicates via JSON HTTP APIs (no CLI prompts)
 * - Polling-based funding detection and deployment status
 *
 * Middleware (via HTTP) handles:
 * - Master EOA/Safe detection and reuse
 * - Agent key generation
 * - Balance checking with real-time polling
 * - Service deployment and staking
 * - Mech contract deployment
 *
 * We provide:
 * - Service configuration (template JSON)
 * - Environment variables (ATTENDED, RPC, password)
 * - Funding requirement display and polling
 * - Isolated environment support (--isolated flag)
 */

import { OlasOperateWrapper } from './OlasOperateWrapper.js';
import { logger } from '../logging/index.js';
import { writeFileSync, readFileSync, readdirSync, existsSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createDefaultServiceConfig, SERVICE_CONSTANTS } from './config/ServiceConfig.js';
import { enableMechMarketplaceInConfig, DEFAULT_MECH_DELIVERY_RATE } from './config/MechConfig.js';
import { printFundingRequirements } from '../setup/display.js';
import { config } from '../config/index.js';
import { backupAllKeys } from '../env/keystore-backup.js';

const bootstrapLogger = logger.child({ component: "SIMPLIFIED-BOOTSTRAP" });

export interface SimplifiedBootstrapConfig {
  chain: 'base' | 'gnosis' | 'mode' | 'optimism';
  operatePassword: string;
  rpcUrl: string;
  /**
   * When true, run middleware in attended (interactive) mode.
   * Defaults to true unless explicitly overridden.
   */
  attended?: boolean;
  /**
   * Absolute path to the middleware directory (for Python imports and venv)
   */
  middlewarePath?: string;
  /**
   * Absolute path to the working directory (where Python cwd will be set).
   * For isolated tests, this should be a temp directory so `.operate` is created there.
   */
  workingDirectory?: string;
  deployMech?: boolean;
  mechMarketplaceAddress?: string;
  /**
   * Mech request price in wei (e.g., '5000000000000' for 0.000005 ETH)
   * Defaults to '5000000000000' (0.000005 ETH) if not specified
   */
  mechRequestPrice?: string;
  /**
   * Override RPC URL (e.g. for Tenderly Virtual TestNet)
   * If set, this takes precedence over rpcUrl
   */
  tenderlyRpcUrl?: string;
  /**
   * Staking program configuration (JINN-204)
   * Defaults to 'custom_staking' (AgentsFun1 on Base)
   */
  stakingProgram?: 'no_staking' | 'custom_staking';
  /**
   * Custom staking contract address (if stakingProgram is 'custom_staking')
   */
  customStakingAddress?: string;
  /**
   * Optional backup owner address for Master Safe creation
   */
  backupOwner?: string;
  /**
   * Reuse an existing service config from .operate/services if available.
   * Defaults to true unless JINN_REUSE_SERVICE_CONFIG is set to false.
   */
  reuseExistingService?: boolean;
  /**
   * When true, stop after creating wallet + Safe (skip service creation and deployment).
   * Used by stOLAS flow to bootstrap wallet infrastructure without requiring OLAS.
   */
  walletOnly?: boolean;
}

export interface SimplifiedBootstrapResult {
  success: boolean;
  serviceConfigId?: string;
  serviceSafeAddress?: string;
  error?: string;
  configPath?: string;
  fundingRequirements?: Record<string, any>;
}

export class SimplifiedServiceBootstrap {
  private config: SimplifiedBootstrapConfig;
  private operateWrapper?: OlasOperateWrapper;
  private outputBuffer: string = ''; // Buffer for E2E test auto-funding
  private isAttended: boolean;
  private reuseExistingService: boolean;

  constructor(config: SimplifiedBootstrapConfig) {
    this.config = config;

    const envAttended = typeof process.env.ATTENDED === 'string'
      ? process.env.ATTENDED.toLowerCase() === 'true'
      : undefined;
    this.isAttended = config.attended ?? envAttended ?? true;
    const envReuse = typeof process.env.JINN_REUSE_SERVICE_CONFIG === 'string'
      ? process.env.JINN_REUSE_SERVICE_CONFIG.toLowerCase() !== 'false'
      : undefined;
    this.reuseExistingService = config.reuseExistingService ?? envReuse ?? true;

    // Validate required config
    if (!config.operatePassword) {
      throw new Error('operatePassword is required (prevents password prompt)');
    }
    if (!config.rpcUrl) {
      throw new Error('rpcUrl is required');
    }

    bootstrapLogger.info({
      chain: config.chain,
      deployMech: config.deployMech || false
    }, "SimplifiedServiceBootstrap initialized");
  }

  private writeOutput(text: string): void {
    this.outputBuffer += text;
    if (this.outputBuffer.length > 50000) {
      this.outputBuffer = this.outputBuffer.slice(-50000);
    }
    process.stdout.write(text);
  }

  private findReusableServiceConfig(): { serviceConfigId: string } | null {
    if (!this.operateWrapper) {
      return null;
    }

    const middlewarePath = this.operateWrapper.getMiddlewarePath();
    const servicesDir = join(middlewarePath, '.operate', 'services');
    if (!existsSync(servicesDir)) {
      return null;
    }

    const entries = readdirSync(servicesDir, { withFileTypes: true })
      .filter((dirent) => dirent.isDirectory() && dirent.name.startsWith('sc-'))
      .map((dirent) => dirent.name);

    const candidates: Array<{
      serviceConfigId: string;
      score: number;
      mtimeMs: number;
    }> = [];

    for (const dirName of entries) {
      const configPath = join(servicesDir, dirName, 'config.json');
      if (!existsSync(configPath)) continue;

      try {
        const raw = readFileSync(configPath, 'utf-8');
        const config = JSON.parse(raw) as {
          service_config_id?: string;
          home_chain?: string;
          chain_configs?: Record<string, any>;
          env_variables?: { MECH_TO_CONFIG?: { value?: string } };
        };

        const homeChain = config.home_chain || Object.keys(config.chain_configs || {})[0] || this.config.chain;
        const chainMatches = homeChain === this.config.chain;

        const mechToConfig = config.env_variables?.MECH_TO_CONFIG?.value;
        const hasMechConfig = Boolean(mechToConfig && mechToConfig.trim() !== '');

        let hasMultisig = false;
        let hasInstance = false;
        if (config.chain_configs) {
          for (const chainConfig of Object.values(config.chain_configs)) {
            if (chainConfig?.chain_data?.multisig) {
              hasMultisig = true;
            }
            if (Array.isArray(chainConfig?.chain_data?.instances) && chainConfig.chain_data.instances.length > 0) {
              hasInstance = true;
            }
          }
        }

        let score = 0;
        if (chainMatches) score += 3;
        if (hasMechConfig) score += 4;
        if (hasMultisig) score += 2;
        if (hasInstance) score += 1;

        const mtimeMs = statSync(configPath).mtimeMs;

        candidates.push({
          serviceConfigId: config.service_config_id || dirName,
          score,
          mtimeMs,
        });
      } catch {
        continue;
      }
    }

    if (candidates.length === 0) {
      return null;
    }

    candidates.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return b.mtimeMs - a.mtimeMs;
    });

    const chosen = candidates[0];
    if (candidates.length > 1) {
      bootstrapLogger.info(
        { serviceConfigId: chosen.serviceConfigId, score: chosen.score, totalCandidates: candidates.length },
        'Reusing existing service config'
      );
    }

    return { serviceConfigId: chosen.serviceConfigId };
  }

  /**
   * Run the complete bootstrap process using middleware's configured attended mode.
   */
  async bootstrap(): Promise<SimplifiedBootstrapResult> {
    try {
      // Step 1: Create operate wrapper with configured ATTENDED mode
      await this.initializeWrapper();

      // Step 2: Create service config
      const { serviceConfig, configPath } = await this.createServiceConfig();

      // Step 3: Show user intro (what to expect)
      this.printIntro();

      // Step 4: Run HTTP-based flow (daemon + API)
      return await this.runHttpFlow(serviceConfig, configPath);

    } catch (error) {
      bootstrapLogger.error({ error }, "Bootstrap failed");
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  /**
   * Initialize OlasOperateWrapper with configured ATTENDED mode.
   */
  private async initializeWrapper(): Promise<void> {
    const effectiveRpcUrl = this.config.tenderlyRpcUrl || this.config.rpcUrl;

    bootstrapLogger.info({
      rpc: effectiveRpcUrl,
      workingDirectory: this.config.workingDirectory
    }, "Initializing operate wrapper with attended mode");

    // Build RPC environment variables
    const chainLedgerRpc: Record<string, string> = {
      [this.config.chain]: effectiveRpcUrl
    };

    // Respect ATTENDED and STAKING_PROGRAM from environment
    bootstrapLogger.info({
      operatePasswordSet: !!this.config.operatePassword,
      operatePasswordLength: this.config.operatePassword?.length,
      stakingProgram: this.config.stakingProgram,
      chain: this.config.chain
    }, "Creating OlasOperateWrapper with config");

    this.operateWrapper = await OlasOperateWrapper.create({
      middlewarePath: this.config.middlewarePath, // For Python imports and Poetry venv resolution
      workingDirectory: this.config.workingDirectory, // For Python cwd (where .operate is created)
      rpcUrl: effectiveRpcUrl,
      timeout: 30 * 60 * 1000, // 30 minutes
      defaultEnv: {
        operatePassword: this.config.operatePassword,
        stakingProgram: this.config.stakingProgram || 'no_staking', // Default to no_staking for safety
        customStakingAddress: this.config.customStakingAddress,
        chainLedgerRpc,
        attended: this.isAttended
      }
    });

    bootstrapLogger.info({
      attended: this.isAttended,
      stakingProgram: this.config.stakingProgram || 'no_staking',
      resolvedMiddlewarePath: this.operateWrapper?.getMiddlewarePath()
    }, "Wrapper initialized");
  }

  /**
   * Create quickstart configuration file
   */
  private async createServiceConfig(): Promise<{
    serviceConfig: ReturnType<typeof createDefaultServiceConfig>;
    configPath: string;
  }> {
    bootstrapLogger.info("Creating service config");

    // Determine effective RPC URL
    const effectiveRpcUrl = this.config.tenderlyRpcUrl || this.config.rpcUrl;

    // Use unique service name to force new service creation (not reuse existing)
    const serviceName = `jinn-service-${Date.now()}`;

    // Create base service config with home_chain set
    const serviceConfig = createDefaultServiceConfig({
      name: serviceName,
      home_chain: this.config.chain
    });

    // Override RPC URL
    if (effectiveRpcUrl && serviceConfig.configurations[this.config.chain]) {
      serviceConfig.configurations[this.config.chain].rpc = effectiveRpcUrl;
    }

    if (serviceConfig.configurations[this.config.chain]) {
      const stakingProgram = this.config.stakingProgram || 'custom_staking';
      if (stakingProgram === 'custom_staking') {
        serviceConfig.configurations[this.config.chain].staking_program_id =
          this.config.customStakingAddress || SERVICE_CONSTANTS.DEFAULT_STAKING_PROGRAM_ID;
        serviceConfig.configurations[this.config.chain].use_staking = true;
      } else {
        serviceConfig.configurations[this.config.chain].staking_program_id = 'no_staking';
        serviceConfig.configurations[this.config.chain].use_staking = false;
      }

      bootstrapLogger.info({
        stakingProgram,
        staking_program_id: serviceConfig.configurations[this.config.chain].staking_program_id,
        use_staking: serviceConfig.configurations[this.config.chain].use_staking
      }, "Configured staking in service config");
    }

    // Add mech configuration if requested
    if (this.config.deployMech) {
      const mechPrice = this.config.mechRequestPrice || DEFAULT_MECH_DELIVERY_RATE;
      bootstrapLogger.info({ mechRequestPrice: mechPrice }, "Enabling mech marketplace deployment");
      enableMechMarketplaceInConfig(
        serviceConfig,
        this.config.mechMarketplaceAddress || '0xf24eE42edA0fc9b33B7D41B06Ee8ccD2Ef7C5020',
        mechPrice
      );
    }

    // Write to temp file
    const configPath = join(tmpdir(), `jinn-simplified-bootstrap-${Date.now()}.json`);
    writeFileSync(configPath, JSON.stringify(serviceConfig, null, 2));

    bootstrapLogger.info({
      configPath,
      rpc: effectiveRpcUrl
    }, "Service config created");
    return { serviceConfig, configPath };
  }

  /**
   * Print intro explaining what user will see
   */
  private printIntro(): void {
    const intro = `
${'='.repeat(80)}
  🚀 OLAS Service Setup - HTTP/Daemon Mode (JINN-202)
${'='.repeat(80)}

Network: ${this.config.chain.toUpperCase()}
RPC: ${this.config.rpcUrl}
Mech Deployment: ${this.config.deployMech ? 'YES' : 'NO'}

📋 This flow uses the middleware daemon and JSON APIs (no CLI prompts):

   1. Start daemon and authenticate
   2. Create or reuse Master EOA + Master Safe
   3. Create service config
   4. Show funding requirements
   5. Wait for funding (attended) and deploy

⚠️  IMPORTANT (Funding):
   • You must fund the Master EOA / Master Safe as instructed
   • The process will wait until funding is detected (attended mode)
   • Total time: 5-10 minutes (depending on funding speed)

${'='.repeat(80)}

🚀 Starting service setup...

`;
    this.writeOutput(intro);
  }

  private async runHttpFlow(
    serviceConfig: ReturnType<typeof createDefaultServiceConfig>,
    configPath: string
  ): Promise<SimplifiedBootstrapResult> {
    if (!this.operateWrapper) {
      throw new Error('Wrapper not initialized');
    }

    // Preflight guard: ensure middleware path is the isolated one when provided
    if (this.config.workingDirectory) {
      const resolved = this.operateWrapper.getMiddlewarePath();
      if (resolved !== this.config.workingDirectory) {
        throw new Error(`Isolated workingDirectory mismatch. Expected ${this.config.workingDirectory}, got ${resolved}`);
      }
      bootstrapLogger.info({ isolatedPath: resolved }, "✅ Running in isolated directory");
    }

    const serverStartResult = await this.operateWrapper.startServer();
    if (!serverStartResult.success) {
      throw new Error(`Failed to start daemon: ${serverStartResult.error}`);
    }

    const accountResult = await this.operateWrapper.setupUserAccount(this.config.operatePassword);
    if (!accountResult.success) {
      if (accountResult.error?.includes('Account already exists')) {
        const loginResult = await this.operateWrapper.login(this.config.operatePassword);
        if (!loginResult.success) {
          throw new Error(`Login failed: ${loginResult.error}`);
        }
      } else {
        throw new Error(`Account setup failed: ${accountResult.error}`);
      }
    }

    let walletAddress: string | undefined;
    let mnemonic: string[] | undefined;
    const walletInfo = await this.operateWrapper.getWalletInfo();
    if (walletInfo.success && walletInfo.wallets?.length) {
      walletAddress = walletInfo.wallets[0].address;
    } else {
      const walletResult = await this.operateWrapper.createWallet('ethereum');
      if (!walletResult.success) {
        throw new Error(`Wallet creation failed: ${walletResult.error}`);
      }
      walletAddress = walletResult.wallet?.address;
      mnemonic = walletResult.wallet?.mnemonic;
    }

    if (mnemonic?.length) {
      this.writeOutput(`Please save the mnemonic phrase for the Master EOA: ${mnemonic.join(' ')}\n`);
    }

    let serviceConfigId: string | undefined;
    if (this.reuseExistingService) {
      const existing = this.findReusableServiceConfig();
      if (existing?.serviceConfigId) {
        serviceConfigId = existing.serviceConfigId;
        bootstrapLogger.info({ serviceConfigId }, 'Reusing existing service config');
      }
    }

    if (!serviceConfigId) {
      const serviceCreate = await this.operateWrapper.createService(serviceConfig);
      if (!serviceCreate.success) {
        throw new Error(`Service creation failed: ${serviceCreate.error}`);
      }

      serviceConfigId = serviceCreate.service?.service_config_id;
      if (!serviceConfigId) {
        throw new Error('Service creation succeeded but no service_config_id returned');
      }
    }

    const fundingResult = await this.operateWrapper.getFundingRequirements(serviceConfigId);
    if (!fundingResult.success) {
      throw new Error(`Failed to fetch funding requirements: ${fundingResult.error}`);
    }

    const initialFundingRequirements = fundingResult.requirements || {};
    this.printFundingRequests({
      chain: this.config.chain,
      fundingRequirements: initialFundingRequirements,
      masterEoa: walletAddress,
      masterSafe: undefined,
      serviceConfig
    });

    const needsEoaFunding = !!walletAddress &&
      this.hasRefillRequirementForAddress(
        initialFundingRequirements,
        this.config.chain,
        walletAddress
      );

    if (needsEoaFunding) {
      if (!this.isAttended) {
        return {
          success: false,
          serviceConfigId,
          serviceSafeAddress: undefined,
          configPath,
          fundingRequirements: initialFundingRequirements,
          error: 'Funding required before safe creation. Please fund and rerun.'
        };
      }
      this.writeOutput('\n⏳ Waiting for Master EOA funding to be detected...\n');
      await this.waitForEoaFunding(serviceConfigId, this.config.chain, walletAddress);
    }

    let masterSafe = await this.operateWrapper.getExistingSafeForChain(this.config.chain);
    if (!masterSafe) {
      const safeResult = await this.operateWrapper.createSafe(this.config.chain, this.config.backupOwner);
      if (!safeResult.success) {
        throw new Error(`Safe creation failed: ${safeResult.error}`);
      }
      masterSafe = safeResult.safeAddress;
    }

    // walletOnly mode: return after wallet + Safe creation (skip service deployment).
    // Used by stOLAS to bootstrap wallet infrastructure without requiring OLAS.
    if (this.config.walletOnly) {
      bootstrapLogger.info({ walletAddress, masterSafe }, 'walletOnly mode — returning after wallet + Safe creation');
      return {
        success: true,
        serviceConfigId,
        serviceSafeAddress: masterSafe,
        configPath,
        fundingRequirements: {},
      };
    }

    const fundingResultAfterSafe = await this.operateWrapper.getFundingRequirements(serviceConfigId);
    if (!fundingResultAfterSafe.success) {
      throw new Error(`Failed to fetch funding requirements: ${fundingResultAfterSafe.error}`);
    }

    const fundingRequirements = fundingResultAfterSafe.requirements || {};
    this.printFundingRequests({
      chain: this.config.chain,
      fundingRequirements,
      masterEoa: walletAddress,
      masterSafe,
      serviceConfig
    });

    if (!this.isServiceFunded(fundingRequirements)) {
      if (!this.isAttended) {
        return {
          success: false,
          serviceConfigId,
          serviceSafeAddress: masterSafe,
          configPath,
          fundingRequirements,
          error: 'Funding required before deployment. Please fund and rerun.'
        };
      }
      this.writeOutput('\n⏳ Waiting for funding to be detected...\n');
      await this.waitForFunding(serviceConfigId);
    }

    const startResult = await this.operateWrapper.startService(serviceConfigId);
    if (!startResult.success) {
      throw new Error(`Service start failed: ${startResult.error}`);
    }

    const serviceSafeAddress = this.extractServiceSafeAddress(
      startResult.service,
      this.config.chain
    ) || masterSafe;

    await this.waitForDeployment(serviceConfigId);

    // Back up all keys created by the middleware during this flow
    try {
      const middlewarePath = this.operateWrapper!.getMiddlewarePath();
      await backupAllKeys({ operateBasePath: middlewarePath });
    } catch {
      bootstrapLogger.warn('Post-bootstrap key backup scan failed (non-fatal)');
    }

    return {
      success: true,
      serviceConfigId,
      serviceSafeAddress,
      configPath,
      fundingRequirements
    };
  }

  private extractServiceSafeAddress(
    service: Record<string, any> | undefined,
    chain: string
  ): string | undefined {
    const chainConfig = service?.chain_configs?.[chain];
    return chainConfig?.chain_data?.multisig;
  }

  private printFundingRequests(params: {
    chain: string;
    fundingRequirements: Record<string, any>;
    masterEoa?: string;
    masterSafe?: string;
    serviceConfig: ReturnType<typeof createDefaultServiceConfig>;
  }): void {
    const { chain, fundingRequirements, masterEoa, masterSafe } = params;
    const refill = fundingRequirements?.refill_requirements?.[chain] || {};
    const zeroAddress = "0x0000000000000000000000000000000000000000";
    const olasTokenAddress = SERVICE_CONSTANTS.DEFAULT_OLAS_TOKEN_ADDRESS;

    const requirements: Array<{
      purpose: string;
      address: string;
      amount: string;
      token: string;
    }> = [];

    if (masterEoa) {
      const masterEoaRefill = this.getRefillForAddress(refill, masterEoa);
      const ethWei = this.toBigInt(masterEoaRefill?.[zeroAddress]);
      if (ethWei > 0n) {
        const ethAmount = this.formatUnits(ethWei, 18);
        requirements.push({
          purpose: 'Master EOA',
          address: masterEoa,
          amount: ethAmount,
          token: 'ETH',
        });
      }
    }

    if (masterSafe) {
      const masterSafeRefill = this.getRefillForAddress(refill, masterSafe);
      const ethWei = this.toBigInt(masterSafeRefill?.[zeroAddress]);
      if (ethWei > 0n) {
        const ethAmount = this.formatUnits(ethWei, 18);
        requirements.push({
          purpose: 'Master Safe',
          address: masterSafe,
          amount: ethAmount,
          token: 'ETH',
        });
      }

      const olasWei = this.toBigInt(masterSafeRefill?.[olasTokenAddress]);
      if (olasWei > 0n) {
        const olasAmount = this.formatUnits(olasWei, 18);
        requirements.push({
          purpose: 'Master Safe (staking)',
          address: masterSafe,
          amount: olasAmount,
          token: 'OLAS',
        });
      }
    }

    // Use the new display utility
    if (requirements.length > 0) {
      printFundingRequirements(requirements, this.config.chain);
    }
  }

  private getRefillForAddress(
    refill: Record<string, any>,
    address: string
  ): Record<string, any> | undefined {
    const addressKey = Object.keys(refill).find(
      (key) => key.toLowerCase() === address.toLowerCase()
    );
    return addressKey ? refill[addressKey] : undefined;
  }

  private hasRefillRequirementForAddress(
    fundingRequirements: Record<string, any>,
    chain: string,
    address: string
  ): boolean {
    const refill = fundingRequirements?.refill_requirements?.[chain] || {};
    const addressRefill = this.getRefillForAddress(refill, address);
    if (!addressRefill) {
      return false;
    }
    return Object.values(addressRefill).some((amount) => this.toBigInt(amount) > 0n);
  }

  private isServiceFunded(fundingRequirements: Record<string, any>): boolean {
    const allowStart = fundingRequirements?.allow_start_agent === true;
    const isRefillRequired = fundingRequirements?.is_refill_required === true;
    return allowStart && !isRefillRequired;
  }

  private async waitForEoaFunding(
    serviceConfigId: string,
    chain: string,
    address: string
  ): Promise<void> {
    if (!this.operateWrapper) {
      throw new Error('Wrapper not initialized');
    }

    const timeoutMs = 30 * 60 * 1000;
    const intervalMs = 10000;
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      const result = await this.operateWrapper.getFundingRequirements(serviceConfigId);
      if (result.success && result.requirements) {
        const stillNeedsFunding = this.hasRefillRequirementForAddress(
          result.requirements,
          chain,
          address
        );
        if (!stillNeedsFunding) {
          return;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }

    throw new Error('Master EOA funding not detected before timeout');
  }

  private async waitForFunding(serviceConfigId: string): Promise<void> {
    if (!this.operateWrapper) {
      throw new Error('Wrapper not initialized');
    }

    const timeoutMs = 30 * 60 * 1000;
    const intervalMs = 10000;
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      const result = await this.operateWrapper.getFundingRequirements(serviceConfigId);
      if (result.success && result.requirements && this.isServiceFunded(result.requirements)) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }

    throw new Error('Funding not detected before timeout');
  }

  private async waitForDeployment(serviceConfigId: string): Promise<void> {
    if (!this.operateWrapper) {
      throw new Error('Wrapper not initialized');
    }

    const timeoutMs = 30 * 60 * 1000;
    const intervalMs = 10000;
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      const result = await this.operateWrapper.getDeployment(serviceConfigId);
      if (result.success) {
        const status = result.deployment?.status;
        if (typeof status === 'number' && status === 3) {
          return;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }

    throw new Error('Deployment did not reach DEPLOYED status before timeout');
  }

  private toBigInt(value: unknown): bigint {
    if (value === null || value === undefined) return 0n;
    if (typeof value === 'bigint') return value;
    if (typeof value === 'number') return BigInt(Math.trunc(value));
    if (typeof value === 'string') return BigInt(value);
    return 0n;
  }

  private formatUnits(amount: bigint, decimals: number): string {
    const negative = amount < 0n;
    const value = negative ? -amount : amount;
    const padded = value.toString().padStart(decimals + 1, '0');
    const whole = padded.slice(0, -decimals);
    const fraction = padded.slice(-decimals).replace(/0+$/, '');
    const result = fraction ? `${whole}.${fraction}` : whole;
    return negative ? `-${result}` : result;
  }

  /**
   * Get recent output for E2E test monitoring (auto-funding)
   * Returns the buffered stdout from the middleware process
   */
  getRecentOutput(): string {
    return this.outputBuffer;
  }

  /**
   * Clean up resources
   */
  async cleanup(): Promise<void> {
    if (this.operateWrapper) {
      await this.operateWrapper.stopServer();
    }
  }
}
