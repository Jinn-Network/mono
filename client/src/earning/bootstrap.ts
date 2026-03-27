/**
 * Earning bootstrap state machine.
 *
 * Drives the complete earning setup flow:
 *   wallet -> safe_predicted -> awaiting_funding -> safe_deployed ->
 *   service_created -> service_activated -> agents_registered ->
 *   service_deployed -> service_staked -> complete
 *
 * Each step is idempotent -- safe to re-run after interruption.
 */

import {
  Contract,
  Interface,
  JsonRpcProvider,
  Wallet,
  encryptKeystoreJson,
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
  cidToBytes32,
  getChainConfig,
} from './contracts.js';
import {
  type SafeInstance,
  executeSafeTxBatch,
  initDeployedSafe,
  initPredictedSafe,
} from './safe-adapter.js';
import { EarningStateStore } from './store.js';
import type {
  EarningBootstrapResult,
  EarningState,
  EarningStep,
  FundingRequirement,
} from './types.js';

// On-chain ServiceState enum
const ServiceState = {
  NonExistent: 0,
  PreRegistration: 1,
  ActiveRegistration: 2,
  FinishedRegistration: 3,
  Deployed: 4,
  TerminatedBonded: 5,
} as const;

export interface EarningBootstrapperOptions {
  earningDir?: string;
  chain?: 'base';
  rpcUrl?: string;
}

export class EarningBootstrapper {
  private readonly store: EarningStateStore;
  private readonly config: ChainConfig;
  private readonly provider: JsonRpcProvider;

  constructor(options: EarningBootstrapperOptions = {}) {
    this.store = new EarningStateStore(options.earningDir);
    this.config = getChainConfig(options.chain ?? 'base');

    if (options.rpcUrl) {
      this.config.rpcUrl = options.rpcUrl;
    }

    this.provider = new JsonRpcProvider(this.config.rpcUrl);
  }

  async getStatus(): Promise<EarningState> {
    return this.store.load();
  }

  /**
   * Run the bootstrap from the current step to completion (or until funding needed).
   * Returns immediately at `awaiting_funding` if balances are insufficient.
   */
  async bootstrap(password: string): Promise<EarningBootstrapResult> {
    let state = await this.store.load();

    try {
      while (state.step !== 'complete') {
        const prevStep = state.step;
        state = await this.runStep(state, password);

        if (state.step === prevStep) {
          // Step didn't advance -- funding gate or terminal
          break;
        }
      }

      // Clear any previous error on success
      if (state.error) {
        state = await this.store.patch({ error: null });
      }

      const funding = state.step === 'awaiting_funding'
        ? await this.buildFundingRequirement(state)
        : undefined;

      return {
        ok: state.step === 'complete',
        step: state.step,
        earning_state: state,
        message: this.describeStep(state.step, funding),
        funding,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[earning-bootstrap] Bootstrap step failed at '${state.step}':`, error);
      await this.store.patch({ error: message });

      return {
        ok: false,
        step: state.step,
        earning_state: { ...state, error: message },
        message: `Failed at step '${state.step}': ${message}`,
      };
    }
  }

  // -----------------------------------------------------------------------
  // Step dispatcher
  // -----------------------------------------------------------------------

  private async runStep(state: EarningState, password: string): Promise<EarningState> {
    switch (state.step) {
      case 'wallet':
        return this.stepCreateWallet(state, password);
      case 'safe_predicted':
        return this.stepPredictSafe(state, password);
      case 'awaiting_funding':
        return this.stepCheckFunding(state);
      case 'safe_deployed':
        return this.stepDeploySafe(state, password);
      case 'service_created':
        return this.stepCreateService(state, password);
      case 'service_activated':
        return this.stepActivateService(state, password);
      case 'agents_registered':
        return this.stepRegisterAgents(state, password);
      case 'service_deployed':
        return this.stepDeployService(state, password);
      case 'service_staked':
        return this.stepStakeService(state, password);
      case 'complete':
        return state;
      default:
        throw new Error(`Unknown step: ${state.step}`);
    }
  }

  // -----------------------------------------------------------------------
  // Step 1: wallet
  // -----------------------------------------------------------------------

  private async stepCreateWallet(state: EarningState, password: string): Promise<EarningState> {
    if (this.store.hasKeystore() && state.agent_address) {
      console.error('[earning-bootstrap] Wallet already exists, skipping');
      return this.store.patch({ step: 'safe_predicted' });
    }

    console.error('[earning-bootstrap] Creating new agent wallet');
    const wallet = Wallet.createRandom();

    const keystoreJson = await encryptKeystoreJson(
      { address: wallet.address, privateKey: wallet.privateKey },
      password,
      { scrypt: { N: 131072, r: 8, p: 1 } },
    );

    await this.store.saveKeystore(keystoreJson);

    return this.store.patch({
      step: 'safe_predicted',
      agent_address: getAddress(wallet.address),
    });
  }

  // -----------------------------------------------------------------------
  // Step 2: safe_predicted
  // -----------------------------------------------------------------------

  private async stepPredictSafe(state: EarningState, password: string): Promise<EarningState> {
    if (state.safe_address) {
      console.error('[earning-bootstrap] Safe address already predicted, skipping');
      return this.store.patch({ step: 'awaiting_funding' });
    }

    const signerKey = await this.loadPrivateKey(password);
    const agentAddress = state.agent_address!;

    console.error(`[earning-bootstrap] Predicting Safe address for agent ${agentAddress}`);
    const { address } = await initPredictedSafe({
      rpcUrl: this.config.rpcUrl,
      signerKey,
      owners: [agentAddress],
      threshold: 1,
    });

    return this.store.patch({
      step: 'awaiting_funding',
      safe_address: getAddress(address),
    });
  }

  // -----------------------------------------------------------------------
  // Step 3: awaiting_funding
  // -----------------------------------------------------------------------

  private async stepCheckFunding(state: EarningState): Promise<EarningState> {
    const eoaAddress = state.agent_address!;
    const safeAddress = state.safe_address!;

    const [eoaBalance, olasBalance] = await Promise.all([
      this.provider.getBalance(eoaAddress),
      this.getOlasBalance(safeAddress),
    ]);

    const eoaFunded = eoaBalance >= this.config.minEoaGasEth;
    const safeOlasFunded = olasBalance >= this.config.bondAmount;

    if (eoaFunded && safeOlasFunded) {
      console.error('[earning-bootstrap] Funding requirements met, proceeding');
      return this.store.patch({ step: 'safe_deployed' });
    }

    console.error(
      `[earning-bootstrap] Waiting for funding: eoaBalance=${eoaBalance} (need ${this.config.minEoaGasEth}), olasBalance=${olasBalance} (need ${this.config.bondAmount})`,
    );

    return state;
  }

  // -----------------------------------------------------------------------
  // Step 4: safe_deployed
  // -----------------------------------------------------------------------

  private async stepDeploySafe(state: EarningState, password: string): Promise<EarningState> {
    const safeAddress = state.safe_address!;

    const code = await this.provider.getCode(safeAddress);
    if (code !== '0x') {
      console.error(`[earning-bootstrap] Safe already deployed at ${safeAddress}, skipping`);
      return this.store.patch({ step: 'service_created' });
    }

    const signerKey = await this.loadPrivateKey(password);
    const agentAddress = state.agent_address!;

    console.error(`[earning-bootstrap] Deploying Safe at ${safeAddress}`);
    const { safe } = await initPredictedSafe({
      rpcUrl: this.config.rpcUrl,
      signerKey,
      owners: [agentAddress],
      threshold: 1,
    });

    const deployTx = await safe.createSafeDeploymentTransaction();

    const signer = new Wallet(signerKey, this.provider);
    const txResponse = await signer.sendTransaction({
      to: deployTx.to,
      value: deployTx.value,
      data: deployTx.data,
    });

    const receipt = await txResponse.wait();
    if (!receipt || receipt.status !== 1) {
      throw new Error(`Safe deployment tx failed: ${txResponse.hash}`);
    }

    const deployedCode = await this.provider.getCode(safeAddress);
    if (deployedCode === '0x') {
      throw new Error(`Safe deployment succeeded but no code at ${safeAddress}`);
    }

    console.error(`[earning-bootstrap] Safe deployed at ${safeAddress} (tx: ${txResponse.hash})`);
    return this.store.patch({ step: 'service_created' });
  }

  // -----------------------------------------------------------------------
  // Step 5: service_created
  // -----------------------------------------------------------------------

  private async stepCreateService(state: EarningState, password: string): Promise<EarningState> {
    if (state.service_id !== null) {
      const onChainState = await this.getServiceState(state.service_id);
      if (onChainState >= ServiceState.PreRegistration) {
        console.error(`[earning-bootstrap] Service ${state.service_id} already created, skipping`);
        return this.store.patch({ step: 'service_activated' });
      }
    }

    const signerKey = await this.loadPrivateKey(password);
    const safe = await this.getSafe(state, signerKey);
    const safeAddress = state.safe_address!;

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

    console.error('[earning-bootstrap] Creating service through Safe');
    const result = await executeSafeTxBatch(safe, [
      {
        to: this.config.serviceManager,
        value: '0',
        data: createData,
      },
    ]);

    const serviceId = await this.parseServiceIdFromTx(result.hash);
    if (serviceId === null) {
      throw new Error(`CreateService event not found in tx ${result.hash}`);
    }

    console.error(`[earning-bootstrap] Service created: id=${serviceId} (tx: ${result.hash})`);

    return this.store.patch({
      step: 'service_activated',
      service_id: serviceId,
      staking_address: this.config.stakingContract,
    });
  }

  // -----------------------------------------------------------------------
  // Step 6: service_activated
  // -----------------------------------------------------------------------

  private async stepActivateService(state: EarningState, password: string): Promise<EarningState> {
    const serviceId = state.service_id!;
    const onChainState = await this.getServiceState(serviceId);

    if (onChainState >= ServiceState.ActiveRegistration) {
      console.error(`[earning-bootstrap] Service ${serviceId} already activated, skipping`);
      return this.store.patch({ step: 'agents_registered' });
    }

    const signerKey = await this.loadPrivateKey(password);
    const safe = await this.getSafe(state, signerKey);

    const erc20Iface = new Interface(ERC20_ABI);
    const serviceManagerIface = new Interface(SERVICE_MANAGER_ABI);

    const approveData = erc20Iface.encodeFunctionData('approve', [
      this.config.serviceRegistryTokenUtility,
      this.config.bondAmount,
    ]);

    const activateData = serviceManagerIface.encodeFunctionData('activateRegistration', [
      serviceId,
    ]);

    console.error(`[earning-bootstrap] Activating service ${serviceId} (approve + activate)`);
    const result = await executeSafeTxBatch(safe, [
      { to: this.config.olasToken, value: '0', data: approveData },
      { to: this.config.serviceManager, value: '1', data: activateData },
    ]);

    console.error(`[earning-bootstrap] Service ${serviceId} activated (tx: ${result.hash})`);
    return this.store.patch({ step: 'agents_registered' });
  }

  // -----------------------------------------------------------------------
  // Step 7: agents_registered
  // -----------------------------------------------------------------------

  private async stepRegisterAgents(state: EarningState, password: string): Promise<EarningState> {
    const serviceId = state.service_id!;
    const onChainState = await this.getServiceState(serviceId);

    if (onChainState >= ServiceState.FinishedRegistration) {
      console.error(`[earning-bootstrap] Agents already registered for service ${serviceId}, skipping`);
      return this.store.patch({ step: 'service_deployed' });
    }

    const signerKey = await this.loadPrivateKey(password);
    const safe = await this.getSafe(state, signerKey);

    const serviceManagerIface = new Interface(SERVICE_MANAGER_ABI);
    const agentAddress = state.agent_address!;

    const erc20Iface = new Interface(ERC20_ABI);
    const approveData = erc20Iface.encodeFunctionData('approve', [
      this.config.serviceRegistryTokenUtility,
      this.config.bondAmount,
    ]);

    const registerData = serviceManagerIface.encodeFunctionData('registerAgents', [
      serviceId,
      [agentAddress],
      [this.config.agentId],
    ]);

    console.error(`[earning-bootstrap] Registering agent ${agentAddress} for service ${serviceId}`);
    const result = await executeSafeTxBatch(safe, [
      { to: this.config.olasToken, value: '0', data: approveData },
      { to: this.config.serviceManager, value: '1', data: registerData },
    ]);

    console.error(`[earning-bootstrap] Agent registered (tx: ${result.hash})`);
    return this.store.patch({ step: 'service_deployed' });
  }

  // -----------------------------------------------------------------------
  // Step 8: service_deployed
  // -----------------------------------------------------------------------

  private async stepDeployService(state: EarningState, password: string): Promise<EarningState> {
    const serviceId = state.service_id!;
    const onChainState = await this.getServiceState(serviceId);

    if (onChainState >= ServiceState.Deployed) {
      console.error(`[earning-bootstrap] Service ${serviceId} already deployed, skipping`);
      return this.store.patch({ step: 'service_staked' });
    }

    const signerKey = await this.loadPrivateKey(password);
    const safe = await this.getSafe(state, signerKey);

    const serviceManagerIface = new Interface(SERVICE_MANAGER_ABI);
    const safeAddress = state.safe_address!;

    const deployData = serviceManagerIface.encodeFunctionData('deploy', [
      serviceId,
      this.config.gnosisSafeSameAddressMultisig,
      safeAddress,
    ]);

    console.error(`[earning-bootstrap] Deploying service ${serviceId}`);
    const result = await executeSafeTxBatch(safe, [
      { to: this.config.serviceManager, value: '0', data: deployData },
    ]);

    console.error(`[earning-bootstrap] Service ${serviceId} deployed (tx: ${result.hash})`);
    return this.store.patch({ step: 'service_staked' });
  }

  // -----------------------------------------------------------------------
  // Step 9: service_staked
  // -----------------------------------------------------------------------

  private async stepStakeService(state: EarningState, password: string): Promise<EarningState> {
    const serviceId = state.service_id!;

    const signerKey = await this.loadPrivateKey(password);
    const safe = await this.getSafe(state, signerKey);

    const serviceApproveIface = new Interface(SERVICE_REGISTRY_APPROVE_ABI);
    const stakingIface = new Interface(STAKING_ABI);

    const approveData = serviceApproveIface.encodeFunctionData('approve', [
      this.config.stakingContract,
      serviceId,
    ]);

    const stakeData = stakingIface.encodeFunctionData('stake', [serviceId]);

    console.error(`[earning-bootstrap] Staking service ${serviceId} (approve + stake)`);
    const result = await executeSafeTxBatch(safe, [
      { to: this.config.serviceRegistry, value: '0', data: approveData },
      { to: this.config.stakingContract, value: '0', data: stakeData },
    ]);

    console.error(`[earning-bootstrap] Service ${serviceId} staked (tx: ${result.hash})`);
    return this.store.patch({ step: 'complete' });
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  private async loadPrivateKey(password: string): Promise<string> {
    const keystoreJson = await this.store.loadKeystore();
    const wallet = await Wallet.fromEncryptedJson(keystoreJson, password);
    return wallet.privateKey;
  }

  private async getSafe(state: EarningState, signerKey: string): Promise<SafeInstance> {
    const safeAddress = state.safe_address!;

    const code = await this.provider.getCode(safeAddress);
    if (code !== '0x') {
      return initDeployedSafe({
        rpcUrl: this.config.rpcUrl,
        signerKey,
        safeAddress,
      });
    }

    const { safe } = await initPredictedSafe({
      rpcUrl: this.config.rpcUrl,
      signerKey,
      owners: [state.agent_address!],
      threshold: 1,
    });
    return safe;
  }

  private async getOlasBalance(address: string): Promise<bigint> {
    const olas = new Contract(this.config.olasToken, ERC20_ABI, this.provider);
    const balance: bigint = await olas.balanceOf(address);
    return balance;
  }

  private async getServiceState(serviceId: number): Promise<number> {
    const registry = new Contract(
      this.config.serviceRegistry,
      SERVICE_REGISTRY_L2_ABI,
      this.provider,
    );
    const service = await registry.getService(serviceId);
    return Number(service.state);
  }

  private async parseServiceIdFromTx(txHash: string): Promise<number | null> {
    const receipt = await this.provider.getTransactionReceipt(txHash);
    if (!receipt) {
      return null;
    }

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
        // Log didn't match -- continue
      }
    }

    return null;
  }

  private async buildFundingRequirement(state: EarningState): Promise<FundingRequirement> {
    const eoaAddress = state.agent_address!;
    const safeAddress = state.safe_address!;

    const [eoaBalance, olasBalance] = await Promise.all([
      this.provider.getBalance(eoaAddress),
      this.getOlasBalance(safeAddress),
    ]);

    return {
      eoa_address: eoaAddress,
      eoa_eth_required: this.config.minEoaGasEth.toString(),
      eoa_eth_balance: eoaBalance.toString(),
      safe_address: safeAddress,
      safe_olas_required: this.config.bondAmount.toString(),
      safe_olas_balance: olasBalance.toString(),
    };
  }

  private describeStep(step: EarningStep, funding?: FundingRequirement): string {
    if (step === 'complete') {
      return 'Earning bootstrap complete. Service is staked and running.';
    }

    if (step === 'awaiting_funding' && funding) {
      const lines = ['Waiting for funding:'];
      const eoaNeeded = BigInt(funding.eoa_eth_required) - BigInt(funding.eoa_eth_balance);
      const olasNeeded = BigInt(funding.safe_olas_required) - BigInt(funding.safe_olas_balance);

      if (eoaNeeded > 0n) {
        lines.push(`  EOA (${funding.eoa_address}): needs ${eoaNeeded} wei ETH for gas`);
      }
      if (olasNeeded > 0n) {
        lines.push(`  Safe (${funding.safe_address}): needs ${olasNeeded} wei OLAS for bond`);
      }

      return lines.join('\n');
    }

    return `Bootstrap paused at step '${step}'.`;
  }
}
