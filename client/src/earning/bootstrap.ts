/**
 * Fleet bootstrap state machine.
 *
 * Phase 1 (master): generate mnemonic → fund master EOA
 * Phase 2 (per-service): derive agent → stake → deploy mech
 */

import {
  Contract,
  Interface,
  JsonRpcProvider,
  Wallet,
  getAddress,
} from 'ethers';
import {
  type ChainConfig,
  ERC20_ABI,
  EVENT_TOPICS,
  SERVICE_MANAGER_ABI,
  SERVICE_REGISTRY_APPROVE_ABI,
  SERVICE_REGISTRY_L2_ABI,
  STAKING_ABI,
  MECH_MARKETPLACE_CREATE_ABI,
  STOLAS_DISTRIBUTOR,
  STOLAS_DISTRIBUTOR_ABI,
  STOLAS_STAKING_SLOTS_ABI,
  cidToBytes32,
  getChainConfig,
} from './contracts.js';
import {
  type SafeInstance,
  executeSafeTxBatch,
  executeSafeTxDirect,
  initDeployedSafe,
  initPredictedSafe,
} from './safe-adapter.js';
import { FleetStateStore } from './store.js';
import {
  generateMnemonic,
  encryptMnemonic,
  decryptMnemonic,
  deriveMasterAddress,
  deriveMasterSigner,
  deriveAgentAddress,
  deriveAgentSigner,
} from './wallet.js';
import type {
  FleetState,
  FleetBootstrapResult,
  FundingRequirement,
  ServiceState,
  ServiceStep,
  StakingMode,
} from './types.js';
import { createDefaultServiceState } from './types.js';

export interface FleetBootstrapperOptions {
  earningDir?: string;
  chain?: 'base' | 'base-sepolia';
  rpcUrl?: string;
  stakingMode?: 'standard' | 'self-bond';
  targetServices?: number;
  testnetL2DeploymentPath?: string;
  testnetL2TokenDeploymentPath?: string;
  testnetMechDeploymentPath?: string;
}

export class FleetBootstrapper {
  private readonly store: FleetStateStore;
  private readonly config: ChainConfig;
  private readonly provider: JsonRpcProvider;
  private readonly chain: 'base' | 'base-sepolia';
  private readonly stakingMode: StakingMode;
  private readonly targetServices: number;

  constructor(options: FleetBootstrapperOptions = {}) {
    this.store = new FleetStateStore(options.earningDir);
    this.chain = options.chain ?? 'base';
    this.stakingMode = options.stakingMode ?? 'standard';
    this.targetServices = options.targetServices ?? 1;
    this.config = getChainConfig(this.chain, {
      testnetL2DeploymentPath: options.testnetL2DeploymentPath,
      testnetL2TokenDeploymentPath: options.testnetL2TokenDeploymentPath,
      testnetMechDeploymentPath: options.testnetMechDeploymentPath,
    });

    if (options.rpcUrl) {
      this.config.rpcUrl = options.rpcUrl;
    }

    this.provider = new JsonRpcProvider(this.config.rpcUrl);
  }

  async getStatus(): Promise<FleetState> {
    return this.store.load(this.chain);
  }

  async bootstrap(password: string): Promise<FleetBootstrapResult> {
    // Handle legacy keystore migration
    if (!this.store.hasMnemonicKeystore() && this.store.hasLegacyKeystore()) {
      await this.store.migrateLegacyFiles();
    }

    let state = await this.store.load(this.chain);

    try {
      // Phase 1: Master wallet setup
      state = await this.ensureMasterWallet(state, password);

      // Phase 1b: Check master funding
      const masterAddress = state.master_address!;
      const masterBalance = await this.provider.getBalance(masterAddress);
      if (masterBalance < this.config.minEoaGasEth) {
        return {
          ok: false,
          fleet_state: state,
          message: `Fund master wallet with ETH, then re-run.`,
          funding: {
            master_address: masterAddress,
            eth_required: this.config.minEoaGasEth.toString(),
            eth_balance: masterBalance.toString(),
          },
        };
      }

      // Phase 2: Bootstrap services up to target
      const mnemonic = await decryptMnemonic(
        await this.store.loadMnemonicKeystore(),
        password,
      );

      const completedCount = state.services.filter(s => s.step === 'complete').length;
      const needed = this.targetServices - completedCount;

      if (needed > 0) {
        console.error(`[fleet-bootstrap] ${completedCount}/${this.targetServices} services complete, bootstrapping ${needed} more`);
      }

      for (let i = 0; i < needed; i++) {
        const nextIndex = state.services.length + 1;
        state = await this.bootstrapService(state, mnemonic, nextIndex);
      }

      // Also resume any incomplete services
      for (const svc of state.services) {
        if (svc.step !== 'complete') {
          state = await this.resumeService(state, mnemonic, svc.index);
        }
      }

      return {
        ok: true,
        fleet_state: state,
        message: `Fleet bootstrap complete. ${state.services.filter(s => s.step === 'complete').length}/${this.targetServices} services running.`,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[fleet-bootstrap] Bootstrap failed:`, error);
      return {
        ok: false,
        fleet_state: state,
        message: `Fleet bootstrap failed: ${message}`,
      };
    }
  }

  // ── Phase 1: Master wallet ───────────────────────────────────────────

  private async ensureMasterWallet(
    state: FleetState,
    password: string,
  ): Promise<FleetState> {
    if (this.store.hasMnemonicKeystore() && state.master_address) {
      return state;
    }

    console.error('[fleet-bootstrap] Generating new HD wallet...');
    const mnemonic = generateMnemonic();
    const encrypted = await encryptMnemonic(mnemonic, password);
    await this.store.saveMnemonicKeystore(encrypted);

    const masterAddress = deriveMasterAddress(mnemonic);
    console.error(`[fleet-bootstrap] Master address: ${masterAddress}`);

    return this.store.patchFleet({
      master_address: masterAddress,
      chain: this.chain,
      staking_mode: this.stakingMode,
    });
  }

  // ── Phase 2: Per-service bootstrap ───────────────────────────────────

  private async bootstrapService(
    state: FleetState,
    mnemonic: string,
    index: number,
  ): Promise<FleetState> {
    const agentAddress = deriveAgentAddress(mnemonic, index);
    const svc = createDefaultServiceState(index, agentAddress);

    console.error(`[fleet-bootstrap] Service ${index}: agent ${agentAddress}`);
    state = await this.store.addService(svc);

    return this.resumeService(state, mnemonic, index);
  }

  private async resumeService(
    state: FleetState,
    mnemonic: string,
    index: number,
  ): Promise<FleetState> {
    const svc = state.services.find(s => s.index === index);
    if (!svc) throw new Error(`Service ${index} not found in state`);
    if (svc.step === 'complete') return state;

    if (svc.step === 'awaiting_stake') {
      state = await this.stepStolasStake(state, mnemonic, index);
    }

    // Reload service state after stake
    const updatedSvc = (await this.store.load(this.chain)).services.find(s => s.index === index);
    if (!updatedSvc) throw new Error(`Service ${index} disappeared from state`);

    if (updatedSvc.step === 'staked' || updatedSvc.step === 'mech_deployed') {
      state = await this.stepDeployMech(state, mnemonic, index);
    }

    return this.store.load(this.chain);
  }

  private async stepStolasStake(
    state: FleetState,
    mnemonic: string,
    index: number,
  ): Promise<FleetState> {
    const svc = state.services.find(s => s.index === index)!;

    // Idempotency: if service already has a service_id, check if staked
    if (svc.service_id !== null) {
      const stakingState = await this.getStakingState(svc.service_id);
      if (stakingState === 1) {
        console.error(`[fleet-bootstrap] Service ${index} already staked, skipping`);
        return this.store.updateService(index, { step: 'staked' });
      }
    }

    // Preflight
    await this.stolasPreflightCheck();

    // Master EOA signs the stake() call
    const masterSigner = deriveMasterSigner(mnemonic);
    const masterWithProvider = masterSigner.connect(this.provider);
    const agentAddress = svc.agent_address;

    const configHashBytes = cidToBytes32(this.config.serviceHash);
    const distributorIface = new Interface(STOLAS_DISTRIBUTOR_ABI);
    const stakeData = distributorIface.encodeFunctionData('stake', [
      this.config.stakingContract,
      0,
      this.config.agentId,
      configHashBytes,
      agentAddress,
    ]);

    console.error(`[fleet-bootstrap] Service ${index}: calling distributor.stake() from master`);
    const txResponse = await masterWithProvider.sendTransaction({
      to: STOLAS_DISTRIBUTOR,
      data: stakeData,
      gasLimit: 2_500_000n,
    });

    const receipt = await txResponse.wait();
    if (!receipt || receipt.status !== 1) {
      throw new Error(`stOLAS stake() tx failed for service ${index}: ${txResponse.hash}`);
    }

    console.error(`[fleet-bootstrap] Service ${index}: stake() confirmed (tx: ${txResponse.hash})`);

    // Parse events
    const serviceId = await this.parseServiceIdFromReceipt(receipt);
    if (serviceId === null) {
      throw new Error(`stake() succeeded but CreateService event not found (tx: ${txResponse.hash})`);
    }

    const safeAddress = this.parseMultisigFromReceipt(receipt);
    if (!safeAddress) {
      throw new Error(`stake() succeeded but CreateMultisigWithAgents event not found (tx: ${txResponse.hash})`);
    }

    console.error(`[fleet-bootstrap] Service ${index}: id=${serviceId}, safe=${safeAddress}`);

    return this.store.updateService(index, {
      service_id: serviceId,
      safe_address: safeAddress,
      staking_address: this.config.stakingContract,
      step: 'staked',
    });
  }

  private async stepDeployMech(
    state: FleetState,
    mnemonic: string,
    index: number,
  ): Promise<FleetState> {
    const svc = state.services.find(s => s.index === index)!;

    if (svc.mech_address) {
      console.error(`[fleet-bootstrap] Service ${index}: mech already deployed at ${svc.mech_address}`);
      return this.store.updateService(index, { step: 'complete' });
    }

    const serviceId = svc.service_id!;
    const safeAddress = svc.safe_address!;

    // Fund agent with gas from master
    const masterSigner = deriveMasterSigner(mnemonic);
    const masterWithProvider = masterSigner.connect(this.provider);
    const agentBalance = await this.provider.getBalance(svc.agent_address);

    if (agentBalance < this.config.minSafeEth) {
      const fundAmount = this.config.minSafeEth - agentBalance;
      console.error(`[fleet-bootstrap] Service ${index}: funding agent with ${fundAmount} wei`);
      const fundTx = await masterWithProvider.sendTransaction({
        to: svc.agent_address,
        value: fundAmount,
      });
      await fundTx.wait();
    }

    // Deploy mech via the service Safe (agent is Safe owner)
    const agentSigner = deriveAgentSigner(mnemonic, index);
    const agentKey = agentSigner.privateKey;

    const safe = await initDeployedSafe({
      rpcUrl: this.config.rpcUrl,
      signerKey: agentKey,
      safeAddress,
    });

    const mechMarketplaceIface = new Interface(MECH_MARKETPLACE_CREATE_ABI);
    const { AbiCoder } = await import('ethers');
    const payload = AbiCoder.defaultAbiCoder().encode(['uint256'], [this.config.mechRequestPrice]);

    const createData = mechMarketplaceIface.encodeFunctionData('create', [
      serviceId,
      this.config.mechFactory,
      payload,
    ]);

    console.error(`[fleet-bootstrap] Service ${index}: deploying mech`);
    const result = await executeSafeTxBatch(safe, [
      { to: this.config.mechMarketplace, value: '0', data: createData },
    ]);

    const mechReceipt = await this.provider.waitForTransaction(result.hash, 1, 30000);
    if (!mechReceipt || mechReceipt.status === 0) {
      throw new Error(`Mech deployment tx failed for service ${index}: ${result.hash}`);
    }

    // Parse CreateMech event
    const createMechTopic = '0x46e1ca45c09520471c43e2e88eca33bb51803011cfd456933629dcc645ecacd6';
    let mechAddress: string | null = null;
    for (const log of mechReceipt.logs) {
      if (log.topics[0] === createMechTopic && log.topics.length >= 2) {
        mechAddress = getAddress('0x' + log.topics[1].slice(26));
        break;
      }
    }

    if (!mechAddress) {
      throw new Error(`CreateMech event not found for service ${index} (tx: ${result.hash})`);
    }

    console.error(`[fleet-bootstrap] Service ${index}: mech deployed at ${mechAddress}`);

    return this.store.updateService(index, {
      mech_address: mechAddress,
      step: 'complete',
    });
  }

  // ── Helpers ──────────────────────────────────────────────────────────

  private async stolasPreflightCheck(): Promise<void> {
    const distributor = new Contract(STOLAS_DISTRIBUTOR, STOLAS_DISTRIBUTOR_ABI, this.provider);
    const proxyConfig: bigint = await distributor.mapStakingProxyConfigs(this.config.stakingContract);
    if (proxyConfig === 0n) {
      throw new Error(
        `stOLAS distributor not configured for ${this.config.stakingContract}. ` +
        `Use stakingMode: 'self-bond' or contact the stOLAS team.`,
      );
    }

    const staking = new Contract(this.config.stakingContract, STOLAS_STAKING_SLOTS_ABI, this.provider);
    const serviceIds: bigint[] = await staking.getServiceIds();
    const maxServices: bigint = await staking.maxNumServices();
    const slotsRemaining = Number(maxServices) - serviceIds.length;

    if (slotsRemaining <= 0) {
      throw new Error(`All ${maxServices} staking slots occupied. Try again later.`);
    }

    console.error(`[fleet-bootstrap] Preflight passed: ${slotsRemaining} slots remaining`);
  }

  private async getStakingState(serviceId: number): Promise<number> {
    const staking = new Contract(this.config.stakingContract, STAKING_ABI, this.provider);
    return Number(await staking.getStakingState(serviceId));
  }

  private async parseServiceIdFromReceipt(receipt: { logs: readonly { address: string; topics: readonly string[]; data: string }[] }): Promise<number | null> {
    const registryIface = new Interface(SERVICE_REGISTRY_L2_ABI);
    const createServiceTopic = EVENT_TOPICS.CreateService;
    const serviceRegistryAddress = this.config.serviceRegistry.toLowerCase();

    for (const log of receipt.logs) {
      if (
        log.address.toLowerCase() !== serviceRegistryAddress ||
        log.topics[0] !== createServiceTopic
      ) {
        continue;
      }
      try {
        const parsed = registryIface.parseLog({
          topics: log.topics as string[],
          data: log.data,
        });
        if (parsed && parsed.args.serviceId !== undefined) {
          return Number(parsed.args.serviceId);
        }
      } catch {
        // Not a matching event
      }
    }
    return null;
  }

  private parseMultisigFromReceipt(receipt: { logs: readonly { topics: readonly string[] }[] }): string | null {
    const topic = EVENT_TOPICS.CreateMultisigWithAgents;
    for (const log of receipt.logs) {
      if (log.topics[0] === topic && log.topics.length >= 3) {
        return getAddress('0x' + log.topics[2].slice(26));
      }
    }
    return null;
  }
}

/** @deprecated Use FleetBootstrapper */
export const EarningBootstrapper = FleetBootstrapper;
