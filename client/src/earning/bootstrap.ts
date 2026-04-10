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
  SelfBondFundingRequirement,
  ServiceState,
  ServiceStep,
  StakingMode,
} from './types.js';
import { createDefaultServiceState } from './types.js';

const SAFE_TOKEN_BOOTSTRAP_MULTIPLIER = 2n;

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
      // Self-bond mode needs much more ETH than standard mode because the master
      // funds the agent which then pays for: Safe deploy, 5 service registry txs
      // (create, activate, register, deploy, stake), and mech deploy. Roughly
      // 15 txs at varying gas costs. 0.03 ETH per service is a safe estimate.
      // On re-runs, include ETH already held by funded agents/safes in the total.
      const SELF_BOND_ETH_PER_SERVICE = 30_000_000_000_000_000n; // 0.03 ETH
      let systemEth = masterBalance;
      if (this.stakingMode === 'self-bond') {
        for (const svc of state.services) {
          if (svc.agent_address) {
            systemEth += await this.provider.getBalance(svc.agent_address);
          }
          if (svc.safe_address) {
            systemEth += await this.provider.getBalance(svc.safe_address);
          }
        }
      }
      const requiredMasterEth = this.stakingMode === 'standard'
        ? this.config.minEoaGasEth
        : SELF_BOND_ETH_PER_SERVICE * BigInt(this.targetServices);
      if (systemEth < requiredMasterEth) {
        return {
          ok: false,
          fleet_state: state,
          message: `Fund master wallet with ETH, then re-run.`,
          funding: {
            master_address: masterAddress,
            eth_required: (requiredMasterEth - systemEth).toString(),
            eth_balance: masterBalance.toString(),
          },
        };
      }

      // Phase 2: Bootstrap services up to target
      const mnemonic = await decryptMnemonic(
        await this.store.loadMnemonicKeystore(),
        password,
      );

      // Resume any incomplete services first
      for (const svc of state.services) {
        if (svc.step !== 'complete') {
          console.error(`[fleet-bootstrap] Resuming service ${svc.index} at step '${svc.step}'`);
          state = await this.resumeService(state, mnemonic, svc.index);
        }
      }

      // Then create new services if needed
      const completedCount = state.services.filter(s => s.step === 'complete').length;
      const needed = this.targetServices - completedCount;

      if (needed > 0) {
        console.error(`[fleet-bootstrap] ${completedCount}/${this.targetServices} services complete, bootstrapping ${needed} more`);
      }

      for (let i = 0; i < needed; i++) {
        const nextIndex = state.services.length + 1;
        state = await this.bootstrapService(state, mnemonic, nextIndex);
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

    if (this.stakingMode === 'standard') {
      return this.resumeServiceStandard(state, mnemonic, index);
    }
    return this.resumeServiceSelfBond(state, mnemonic, index);
  }

  private async resumeServiceStandard(
    state: FleetState,
    mnemonic: string,
    index: number,
  ): Promise<FleetState> {
    const svc = state.services.find(s => s.index === index)!;

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

  private async resumeServiceSelfBond(
    state: FleetState,
    mnemonic: string,
    index: number,
  ): Promise<FleetState> {
    let svc = state.services.find(s => s.index === index)!;

    if (svc.step === 'awaiting_stake') {
      state = await this.stepSelfBondSetup(state, mnemonic, index);
      svc = (await this.store.load(this.chain)).services.find(s => s.index === index)!;
    }

    if (svc.step === 'service_created') {
      state = await this.stepSelfBondCreateService(state, mnemonic, index);
      svc = (await this.store.load(this.chain)).services.find(s => s.index === index)!;
    }

    if (svc.step === 'service_activated') {
      state = await this.stepSelfBondActivateService(state, mnemonic, index);
      svc = (await this.store.load(this.chain)).services.find(s => s.index === index)!;
    }

    if (svc.step === 'agents_registered') {
      state = await this.stepSelfBondRegisterAgents(state, mnemonic, index);
      svc = (await this.store.load(this.chain)).services.find(s => s.index === index)!;
    }

    if (svc.step === 'service_deployed') {
      state = await this.stepSelfBondDeployService(state, mnemonic, index);
      svc = (await this.store.load(this.chain)).services.find(s => s.index === index)!;
    }

    if (svc.step === 'service_staked') {
      state = await this.stepSelfBondStakeService(state, mnemonic, index);
      svc = (await this.store.load(this.chain)).services.find(s => s.index === index)!;
    }

    if (svc.step === 'staked' || svc.step === 'mech_deployed') {
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

    // Agent needs enough gas for mech deployment Safe tx (~2.6M gas)
    const minAgentGas = this.config.minEoaGasEth;
    if (agentBalance < minAgentGas) {
      const fundAmount = minAgentGas - agentBalance;
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

  // ── Self-bond step handlers ──────────────────────────────────────────

  private async stepSelfBondSetup(
    state: FleetState,
    mnemonic: string,
    index: number,
  ): Promise<FleetState> {
    const svc = state.services.find(s => s.index === index)!;
    const agentSigner = deriveAgentSigner(mnemonic, index);
    const agentKey = agentSigner.privateKey;
    const agentAddress = svc.agent_address;

    // 1. Predict Safe if not yet done
    if (!svc.safe_address) {
      console.error(`[fleet-bootstrap] Service ${index}: predicting Safe for agent ${agentAddress}`);
      const { address } = await initPredictedSafe({
        rpcUrl: this.config.rpcUrl,
        signerKey: agentKey,
        owners: [agentAddress],
        threshold: 1,
      });
      state = await this.store.updateService(index, { safe_address: getAddress(address) });
    }

    // Reload svc to get safe_address
    const updatedSvc = (await this.store.load(this.chain)).services.find(s => s.index === index)!;
    const safeAddress = updatedSvc.safe_address!;

    // 2. Fund agent EOA from master if needed
    // The agent pays for: Safe deploy + Safe top-up + ~8 Safe txs (service lifecycle + staking + mech)
    const SELF_BOND_AGENT_ETH = 25_000_000_000_000_000n; // 0.025 ETH
    const requiredAgentEth = SELF_BOND_AGENT_ETH;
    const masterSigner = deriveMasterSigner(mnemonic);
    const masterWithProvider = masterSigner.connect(this.provider);
    const agentBalance = await this.provider.getBalance(agentAddress);

    if (agentBalance < requiredAgentEth) {
      const fundAmount = requiredAgentEth - agentBalance;
      console.error(`[fleet-bootstrap] Service ${index}: funding agent with ${fundAmount} wei from master`);
      const fundTx = await masterWithProvider.sendTransaction({
        to: agentAddress,
        value: fundAmount,
      });
      await fundTx.wait();
    }

    // 3. Check agent ETH balance (retry — public RPCs can lag after a write)
    let agentBalanceAfter = 0n;
    for (let attempt = 0; attempt < 5; attempt++) {
      agentBalanceAfter = await this.provider.getBalance(agentAddress);
      if (agentBalanceAfter >= requiredAgentEth) break;
      if (attempt < 4) await new Promise(r => setTimeout(r, 2000));
    }
    if (agentBalanceAfter < requiredAgentEth) {
      throw new Error(
        `Service ${index}: agent ${agentAddress} needs ${requiredAgentEth} wei ETH but has ${agentBalanceAfter}`,
      );
    }

    // 4. Check Safe ETH balance (agent can auto-top)
    let safeEthBalance = await this.provider.getBalance(safeAddress);
    if (safeEthBalance < this.config.minSafeEth) {
      const eoaAvailable = agentBalanceAfter - this.config.minEoaGasEth;
      const shortfall = this.config.minSafeEth - safeEthBalance;
      if (eoaAvailable >= shortfall) {
        console.error(`[fleet-bootstrap] Service ${index}: auto-topping Safe with ${shortfall} wei ETH`);
        const agentWithProvider = agentSigner.connect(this.provider);
        const topTx = await agentWithProvider.sendTransaction({
          to: safeAddress,
          value: shortfall,
        });
        await topTx.wait();
        safeEthBalance += shortfall;
      }
    }

    if (safeEthBalance < this.config.minSafeEth) {
      throw new Error(
        `Service ${index}: Safe ${safeAddress} needs ${this.config.minSafeEth} wei ETH but has ${safeEthBalance}`,
      );
    }

    // 5. Check Safe OLAS balance
    const requiredOlas = this.config.bondAmount * SAFE_TOKEN_BOOTSTRAP_MULTIPLIER;
    const olasBalance = await this.getOlasBalance(safeAddress);
    if (olasBalance < requiredOlas) {
      throw new Error(
        `Service ${index}: Safe ${safeAddress} needs ${requiredOlas} OLAS wei for bonding but has ${olasBalance}. ` +
        `Send OLAS tokens to the Safe address.`,
      );
    }

    // 6. Deploy Safe if not yet deployed
    const code = await this.provider.getCode(safeAddress);
    if (code === '0x') {
      console.error(`[fleet-bootstrap] Service ${index}: deploying Safe at ${safeAddress}`);
      const { safe } = await initPredictedSafe({
        rpcUrl: this.config.rpcUrl,
        signerKey: agentKey,
        owners: [agentAddress],
        threshold: 1,
      });

      const deployTx = await safe.createSafeDeploymentTransaction();
      const agentWithProvider = agentSigner.connect(this.provider);
      const txResponse = await agentWithProvider.sendTransaction({
        to: deployTx.to,
        value: deployTx.value,
        data: deployTx.data,
      });

      const receipt = await txResponse.wait();
      if (!receipt || receipt.status !== 1) {
        throw new Error(`Safe deployment tx failed for service ${index}: ${txResponse.hash}`);
      }

      const deployedCode = await this.provider.getCode(safeAddress);
      if (deployedCode === '0x') {
        throw new Error(`Safe deployment succeeded but no code at ${safeAddress}`);
      }

      console.error(`[fleet-bootstrap] Service ${index}: Safe deployed (tx: ${txResponse.hash})`);
    }

    // 7. Advance to service_created
    return this.store.updateService(index, { step: 'service_created' });
  }

  private async stepSelfBondCreateService(
    state: FleetState,
    mnemonic: string,
    index: number,
  ): Promise<FleetState> {
    const svc = state.services.find(s => s.index === index)!;

    // Idempotency: if service already exists on-chain, skip
    if (svc.service_id !== null) {
      const onChainState = await this.getServiceState(svc.service_id);
      if (onChainState >= 1) { // PreRegistration or beyond
        console.error(`[fleet-bootstrap] Service ${index}: service ${svc.service_id} already created, skipping`);
        return this.store.updateService(index, { step: 'service_activated' });
      }
    }

    const agentSigner = deriveAgentSigner(mnemonic, index);
    const agentKey = agentSigner.privateKey;
    const safeAddress = svc.safe_address!;

    const safe = await initDeployedSafe({
      rpcUrl: this.config.rpcUrl,
      signerKey: agentKey,
      safeAddress,
    });

    const configHashBytes = cidToBytes32(this.config.serviceHash);
    const serviceManagerIface = new Interface(SERVICE_MANAGER_ABI);

    const createData = serviceManagerIface.encodeFunctionData('create', [
      safeAddress,
      this.config.olasToken,
      configHashBytes,
      [this.config.agentId],
      [{ slots: 1, bond: this.config.bondAmount }],
      1,
    ]);

    console.error(`[fleet-bootstrap] Service ${index}: creating service through Safe`);
    const result = await executeSafeTxBatch(safe, [
      { to: this.config.serviceManager, value: '0', data: createData },
    ]);

    const receipt = await this.provider.waitForTransaction(result.hash, 1, 30000);
    if (!receipt || receipt.status !== 1) {
      throw new Error(`Create service tx failed for service ${index}: ${result.hash}`);
    }

    const serviceId = await this.parseServiceIdFromReceipt(receipt);
    if (serviceId === null) {
      throw new Error(`CreateService event not found for service ${index} (tx: ${result.hash})`);
    }

    console.error(`[fleet-bootstrap] Service ${index}: created id=${serviceId} (tx: ${result.hash})`);

    return this.store.updateService(index, {
      service_id: serviceId,
      staking_address: this.config.stakingContract,
      step: 'service_activated',
    });
  }

  private async stepSelfBondActivateService(
    state: FleetState,
    mnemonic: string,
    index: number,
  ): Promise<FleetState> {
    const svc = state.services.find(s => s.index === index)!;
    const serviceId = svc.service_id!;

    // Idempotency
    const onChainState = await this.getServiceState(serviceId);
    if (onChainState >= 2) { // ActiveRegistration or beyond
      console.error(`[fleet-bootstrap] Service ${index}: service ${serviceId} already activated, skipping`);
      return this.store.updateService(index, { step: 'agents_registered' });
    }

    const agentSigner = deriveAgentSigner(mnemonic, index);
    const agentKey = agentSigner.privateKey;

    const safe = await initDeployedSafe({
      rpcUrl: this.config.rpcUrl,
      signerKey: agentKey,
      safeAddress: svc.safe_address!,
    });

    const erc20Iface = new Interface(ERC20_ABI);
    const serviceManagerIface = new Interface(SERVICE_MANAGER_ABI);

    const approveData = erc20Iface.encodeFunctionData('approve', [
      this.config.serviceRegistryTokenUtility,
      this.config.bondAmount,
    ]);

    const activateData = serviceManagerIface.encodeFunctionData('activateRegistration', [
      serviceId,
    ]);

    console.error(`[fleet-bootstrap] Service ${index}: activating service ${serviceId}`);
    const result = await executeSafeTxBatch(safe, [
      { to: this.config.olasToken, value: '0', data: approveData },
      { to: this.config.serviceManager, value: '1', data: activateData },
    ]);

    const receipt = await this.provider.waitForTransaction(result.hash, 1, 30000);
    if (!receipt || receipt.status !== 1) {
      throw new Error(`Activate service tx failed for service ${index}: ${result.hash}`);
    }

    console.error(`[fleet-bootstrap] Service ${index}: activated (tx: ${result.hash})`);
    return this.store.updateService(index, { step: 'agents_registered' });
  }

  private async stepSelfBondRegisterAgents(
    state: FleetState,
    mnemonic: string,
    index: number,
  ): Promise<FleetState> {
    const svc = state.services.find(s => s.index === index)!;
    const serviceId = svc.service_id!;

    // Idempotency
    const onChainState = await this.getServiceState(serviceId);
    if (onChainState >= 3) { // FinishedRegistration or beyond
      console.error(`[fleet-bootstrap] Service ${index}: agents already registered for service ${serviceId}, skipping`);
      return this.store.updateService(index, { step: 'service_deployed' });
    }

    const agentSigner = deriveAgentSigner(mnemonic, index);
    const agentKey = agentSigner.privateKey;

    const safe = await initDeployedSafe({
      rpcUrl: this.config.rpcUrl,
      signerKey: agentKey,
      safeAddress: svc.safe_address!,
    });

    const erc20Iface = new Interface(ERC20_ABI);
    const serviceManagerIface = new Interface(SERVICE_MANAGER_ABI);

    const approveData = erc20Iface.encodeFunctionData('approve', [
      this.config.serviceRegistryTokenUtility,
      this.config.bondAmount,
    ]);

    const registerData = serviceManagerIface.encodeFunctionData('registerAgents', [
      serviceId,
      [svc.agent_address],
      [this.config.agentId],
    ]);

    console.error(`[fleet-bootstrap] Service ${index}: registering agent ${svc.agent_address} for service ${serviceId}`);
    const result = await executeSafeTxBatch(safe, [
      { to: this.config.olasToken, value: '0', data: approveData },
      { to: this.config.serviceManager, value: '1', data: registerData },
    ]);

    const receipt = await this.provider.waitForTransaction(result.hash, 1, 30000);
    if (!receipt || receipt.status !== 1) {
      throw new Error(`Register agents tx failed for service ${index}: ${result.hash}`);
    }

    console.error(`[fleet-bootstrap] Service ${index}: agents registered (tx: ${result.hash})`);
    return this.store.updateService(index, { step: 'service_deployed' });
  }

  private async stepSelfBondDeployService(
    state: FleetState,
    mnemonic: string,
    index: number,
  ): Promise<FleetState> {
    const svc = state.services.find(s => s.index === index)!;
    const serviceId = svc.service_id!;

    // Idempotency
    const onChainState = await this.getServiceState(serviceId);
    if (onChainState >= 4) { // Deployed or beyond
      console.error(`[fleet-bootstrap] Service ${index}: service ${serviceId} already deployed, skipping`);
      return this.store.updateService(index, { step: 'service_staked' });
    }

    const agentSigner = deriveAgentSigner(mnemonic, index);
    const agentKey = agentSigner.privateKey;
    const safeAddress = svc.safe_address!;

    const safe = await initDeployedSafe({
      rpcUrl: this.config.rpcUrl,
      signerKey: agentKey,
      safeAddress,
    });

    const serviceManagerIface = new Interface(SERVICE_MANAGER_ABI);
    const deployData = serviceManagerIface.encodeFunctionData('deploy', [
      serviceId,
      this.config.gnosisSafeSameAddressMultisig,
      safeAddress,
    ]);

    console.error(`[fleet-bootstrap] Service ${index}: deploying service ${serviceId}`);
    const result = await executeSafeTxBatch(safe, [
      { to: this.config.serviceManager, value: '0', data: deployData },
    ]);

    const receipt = await this.provider.waitForTransaction(result.hash, 1, 30000);
    if (!receipt || receipt.status !== 1) {
      throw new Error(`Deploy service tx failed for service ${index}: ${result.hash}`);
    }

    console.error(`[fleet-bootstrap] Service ${index}: service deployed (tx: ${result.hash})`);
    return this.store.updateService(index, { step: 'service_staked' });
  }

  private async stepSelfBondStakeService(
    state: FleetState,
    mnemonic: string,
    index: number,
  ): Promise<FleetState> {
    const svc = state.services.find(s => s.index === index)!;
    const serviceId = svc.service_id!;

    // Idempotency: check if already staked
    const stakingState = await this.getStakingState(serviceId);
    if (stakingState === 1) {
      console.error(`[fleet-bootstrap] Service ${index}: service ${serviceId} already staked, skipping`);
      return this.store.updateService(index, { step: 'staked' });
    }

    const agentSigner = deriveAgentSigner(mnemonic, index);
    const agentKey = agentSigner.privateKey;
    const safeAddress = svc.safe_address!;

    const safe = await initDeployedSafe({
      rpcUrl: this.config.rpcUrl,
      signerKey: agentKey,
      safeAddress,
    });

    // Transaction 1: Approve service NFT for staking contract
    const serviceApproveIface = new Interface(SERVICE_REGISTRY_APPROVE_ABI);
    const approveData = serviceApproveIface.encodeFunctionData('approve', [
      this.config.stakingContract,
      serviceId,
    ]);

    console.error(`[fleet-bootstrap] Service ${index}: approving service ${serviceId} NFT for staking`);
    const approveResult = await executeSafeTxBatch(safe, [
      { to: this.config.serviceRegistry, value: '0', data: approveData },
    ]);

    await this.waitForSuccessfulTx(approveResult.hash, `approve service ${serviceId} NFT`);
    console.error(`[fleet-bootstrap] Service ${index}: approve tx confirmed (${approveResult.hash})`);

    // Transaction 2: Stake via executeSafeTxDirect (bypasses Safe SDK gas estimation)
    const stakingIface = new Interface(STAKING_ABI);
    const stakeData = stakingIface.encodeFunctionData('stake', [serviceId]);

    console.error(`[fleet-bootstrap] Service ${index}: staking service ${serviceId}`);
    const stakeResult = await executeSafeTxDirect({
      rpcUrl: this.config.rpcUrl,
      signerKey: agentKey,
      safeAddress,
      to: this.config.stakingContract,
      data: stakeData,
    });

    await this.waitForSuccessfulTx(stakeResult.hash, `stake service ${serviceId}`);

    // Verify staking state
    const finalState = await this.getStakingState(serviceId);
    if (finalState !== 1) {
      throw new Error(
        `Service ${index}: staking verification failed for service ${serviceId}: expected state 1 (Staked) but got ${finalState}`,
      );
    }

    console.error(`[fleet-bootstrap] Service ${index}: service ${serviceId} staked and verified`);
    return this.store.updateService(index, { step: 'staked' });
  }

  // ── Helpers ──────────────────────────────────────────────────────────

  private async getOlasBalance(address: string): Promise<bigint> {
    const olas = new Contract(this.config.olasToken, ERC20_ABI, this.provider);
    return await olas.balanceOf(address);
  }

  private async getServiceState(serviceId: number): Promise<number> {
    const registry = new Contract(this.config.serviceRegistry, SERVICE_REGISTRY_L2_ABI, this.provider);
    const service = await registry.getService(serviceId);
    return Number(service.state);
  }

  private async waitForSuccessfulTx(txHash: string, label: string): Promise<void> {
    const receipt = await this.provider.waitForTransaction(txHash, 1, 30000);
    if (!receipt) throw new Error(`${label} tx not confirmed: ${txHash}`);
    if (receipt.status !== 1) throw new Error(`${label} tx reverted: ${txHash}`);
  }

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
