/**
 * Earning bootstrap state machine.
 *
 * Drives the complete earning setup flow:
 *   wallet -> safe_predicted -> awaiting_funding -> safe_deployed ->
 *   service_created -> service_activated -> agents_registered ->
 *   service_deployed -> service_staked -> mech_deployed -> complete
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
  MECH_MARKETPLACE_CREATE_ABI,
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
import { EarningStateStore } from './store.js';
import type {
  EarningBootstrapResult,
  EarningState,
  EarningStep,
  FundingRequirement,
  StakingMode,
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

// Token-secured services consume the configured bond twice during bootstrap:
// once as the service security deposit during activation, and once as the
// operator bond when registering the single agent instance.
const SAFE_TOKEN_BOOTSTRAP_MULTIPLIER = 2n;

export interface EarningBootstrapperOptions {
  earningDir?: string;
  chain?: 'base' | 'base-sepolia';
  rpcUrl?: string;
  testnetL2DeploymentPath?: string;
  testnetL2TokenDeploymentPath?: string;
  testnetMechDeploymentPath?: string;
  stopAt?: 'service_staked' | 'mech_deployed' | 'complete';
  stakingMode?: 'standard' | 'self-bond';
}

export function reconcilePredictedSafeState(
  state: Pick<EarningState, 'step' | 'safe_address' | 'service_id' | 'mech_address' | 'staking_address'>,
  predictedSafeAddress: string,
): {
  safeAddress: string;
  step: EarningStep;
  changed: boolean;
  rewound: boolean;
} {
  const normalizedPredictedSafeAddress = getAddress(predictedSafeAddress);

  if (!state.safe_address) {
    return {
      safeAddress: normalizedPredictedSafeAddress,
      step: state.step,
      changed: true,
      rewound: false,
    };
  }

  const normalizedStoredSafeAddress = getAddress(state.safe_address);
  if (normalizedStoredSafeAddress === normalizedPredictedSafeAddress) {
    return {
      safeAddress: normalizedPredictedSafeAddress,
      step: state.step,
      changed: false,
      rewound: false,
    };
  }

  if (state.service_id !== null || state.mech_address || state.staking_address) {
    throw new Error(
      `Stored Safe ${normalizedStoredSafeAddress} does not match current predicted Safe ${normalizedPredictedSafeAddress} after service bootstrap progressed beyond Safe funding.`,
    );
  }

  return {
    safeAddress: normalizedPredictedSafeAddress,
    step: 'awaiting_funding',
    changed: true,
    rewound: true,
  };
}

export function reconcileServiceProgressState(
  state: Pick<EarningState, 'step' | 'service_id'>,
  serviceState: number,
  stakingState: number,
): {
  step: EarningStep;
  changed: boolean;
} {
  if (state.service_id === null) {
    return {
      step: state.step,
      changed: false,
    };
  }

  let step: EarningStep;
  if (serviceState >= ServiceState.Deployed) {
    step = stakingState === 1 ? 'mech_deployed' : 'service_staked';
  } else if (serviceState >= ServiceState.FinishedRegistration) {
    step = 'service_deployed';
  } else if (serviceState >= ServiceState.ActiveRegistration) {
    step = 'agents_registered';
  } else if (serviceState >= ServiceState.PreRegistration) {
    step = 'service_activated';
  } else {
    step = 'service_created';
  }

  return {
    step,
    changed: step !== state.step,
  };
}

export class EarningBootstrapper {
  private readonly store: EarningStateStore;
  private readonly config: ChainConfig;
  private readonly provider: JsonRpcProvider;
  private readonly chain: 'base' | 'base-sepolia';
  private readonly stopAt: 'service_staked' | 'mech_deployed' | 'complete';
  private readonly stakingMode: StakingMode;

  constructor(options: EarningBootstrapperOptions = {}) {
    this.store = new EarningStateStore(options.earningDir);
    this.chain = options.chain ?? 'base';
    this.stopAt = options.stopAt ?? 'complete';
    this.stakingMode = options.stakingMode ?? 'standard';
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

  async getStatus(): Promise<EarningState> {
    return this.store.load();
  }

  /**
   * Run the bootstrap from the current step to completion (or until funding needed).
   * Returns immediately at `awaiting_funding` if balances are insufficient.
   */
  async bootstrap(password: string): Promise<EarningBootstrapResult> {
    let state = await this.store.load();
    if (state.chain !== this.chain) {
      state = await this.store.patch({ chain: this.chain });
    }
    if (state.staking_mode !== this.stakingMode && state.service_id === null) {
      state = await this.store.patch({ staking_mode: this.stakingMode });
    }
    state = await this.refreshPredictedSafeAddress(state, password);
    state = await this.refreshServiceProgressState(state);

    try {
      while (state.step !== 'complete' && !this.hasReachedStopTarget(state.step)) {
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
        ok: state.step === 'complete' || this.hasReachedStopTarget(state.step),
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
        return this.stepCheckFunding(state, password);
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
      case 'mech_deployed':
        return this.stepDeployMech(state, password);
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

  private async stepCheckFunding(state: EarningState, password: string): Promise<EarningState> {
    const eoaAddress = state.agent_address!;
    const safeAddress = state.safe_address!;
    const requiredSafeTokenBalance = this.getRequiredSafeTokenBalance();

    let [eoaBalance, safeNativeBalance, olasBalance] = await Promise.all([
      this.provider.getBalance(eoaAddress),
      this.provider.getBalance(safeAddress),
      this.getOlasBalance(safeAddress),
    ]);

    const safeNativeShortfall = this.getFundingShortfall(this.config.minSafeEth, safeNativeBalance);
    const eoaAvailableForSafeTopUp = eoaBalance > this.config.minEoaGasEth
      ? eoaBalance - this.config.minEoaGasEth
      : 0n;

    if (safeNativeShortfall > 0n && eoaAvailableForSafeTopUp >= safeNativeShortfall) {
      await this.transferEth(password, safeAddress, safeNativeShortfall);
      eoaBalance -= safeNativeShortfall;
      safeNativeBalance += safeNativeShortfall;
      console.error(
        `[earning-bootstrap] Auto-topped Safe ${safeAddress} with ${safeNativeShortfall} wei ETH from agent EOA`,
      );
    }

    const eoaFunded = eoaBalance >= this.config.minEoaGasEth;
    const safeNativeFunded = safeNativeBalance >= this.config.minSafeEth;
    const safeOlasFunded = olasBalance >= requiredSafeTokenBalance;

    if (eoaFunded && safeNativeFunded && safeOlasFunded) {
      console.error('[earning-bootstrap] Funding requirements met, proceeding');
      return this.store.patch({ step: 'safe_deployed' });
    }

    console.error(
      `[earning-bootstrap] Waiting for funding: eoaBalance=${eoaBalance} (need ${this.config.minEoaGasEth}), ` +
        `safeNativeBalance=${safeNativeBalance} (need ${this.config.minSafeEth}), ` +
        `olasBalance=${olasBalance} (need ${requiredSafeTokenBalance})`,
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

    await this.waitForSuccessfulTx(result.hash, `create service ${safeAddress}`);

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

    await this.ensureSafeTokenBalance(state.safe_address!, this.config.bondAmount, 'activate the service');

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

    await this.waitForSuccessfulTx(result.hash, `activate service ${serviceId}`);
    const finalState = await this.getServiceState(serviceId);
    if (finalState < ServiceState.ActiveRegistration) {
      throw new Error(
        `Service ${serviceId} activation verification failed: expected state >= ${ServiceState.ActiveRegistration} ` +
          `but got ${finalState}. Tx: ${result.hash}`,
      );
    }

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

    await this.ensureSafeTokenBalance(state.safe_address!, this.config.bondAmount, 'register the service agent');

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

    await this.waitForSuccessfulTx(result.hash, `register agents for service ${serviceId}`);
    const finalState = await this.getServiceState(serviceId);
    if (finalState < ServiceState.FinishedRegistration) {
      throw new Error(
        `Service ${serviceId} agent-registration verification failed: expected state >= ${ServiceState.FinishedRegistration} ` +
          `but got ${finalState}. Tx: ${result.hash}`,
      );
    }

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

    await this.waitForSuccessfulTx(result.hash, `deploy service ${serviceId}`);
    const finalState = await this.getServiceState(serviceId);
    if (finalState < ServiceState.Deployed) {
      throw new Error(
        `Service ${serviceId} deploy verification failed: expected state >= ${ServiceState.Deployed} ` +
          `but got ${finalState}. Tx: ${result.hash}`,
      );
    }

    console.error(`[earning-bootstrap] Service ${serviceId} deployed (tx: ${result.hash})`);
    return this.store.patch({ step: 'service_staked' });
  }

  // -----------------------------------------------------------------------
  // Step 9: service_staked
  // -----------------------------------------------------------------------

  private async stepStakeService(state: EarningState, password: string): Promise<EarningState> {
    const serviceId = state.service_id!;

    // Check if already staked (idempotency on re-run)
    const stakingState = await this.getStakingState(serviceId);
    if (stakingState === 1) {
      console.error(`[earning-bootstrap] Service ${serviceId} already staked, skipping`);
      return this.store.patch({ step: 'mech_deployed' });
    }

    const signerKey = await this.loadPrivateKey(password);
    const safe = await this.getSafe(state, signerKey);

    const serviceApproveIface = new Interface(SERVICE_REGISTRY_APPROVE_ABI);
    const stakingIface = new Interface(STAKING_ABI);

    // Execute approve and stake as separate Safe transactions to avoid
    // silent inner-call failures in MultiSend batches.
    const approveData = serviceApproveIface.encodeFunctionData('approve', [
      this.config.stakingContract,
      serviceId,
    ]);
    console.error(`[earning-bootstrap] Approving service ${serviceId} NFT for staking contract`);
    const approveResult = await executeSafeTxBatch(safe, [
      { to: this.config.serviceRegistry, value: '0', data: approveData },
    ]);
    console.error(`[earning-bootstrap] Approve tx: ${approveResult.hash}`);
    await this.waitForSuccessfulTx(approveResult.hash, `approve service ${serviceId} NFT for staking`);

    const stakeData = stakingIface.encodeFunctionData('stake', [serviceId]);
    console.error(`[earning-bootstrap] Staking service ${serviceId}`);
    // Safe SDK gas estimation is unreliable for stake(); execute the final
    // call directly via the Safe contract with an explicit gas limit.
    const stakeResult = await executeSafeTxDirect({
      rpcUrl: this.config.rpcUrl,
      signerKey,
      safeAddress: state.safe_address!,
      to: this.config.stakingContract,
      data: stakeData,
    });
    console.error(`[earning-bootstrap] Stake tx: ${stakeResult.hash}`);
    await this.waitForSuccessfulTx(stakeResult.hash, `stake service ${serviceId}`);

    // Verify the on-chain staking state before advancing
    const finalState = await this.getStakingState(serviceId);
    if (finalState !== 1) {
      throw new Error(
        `Service ${serviceId} staking verification failed: expected state 1 (Staked) but got ${finalState}. ` +
          `Approve tx: ${approveResult.hash}, Stake tx: ${stakeResult.hash}`,
      );
    }

    console.error(`[earning-bootstrap] Service ${serviceId} staked and verified`);
    return this.store.patch({ step: 'mech_deployed' });
  }

  // -----------------------------------------------------------------------
  // Step 10: mech_deployed
  // -----------------------------------------------------------------------

  private async stepDeployMech(state: EarningState, password: string): Promise<EarningState> {
    if (state.mech_address) {
      console.error(`[earning-bootstrap] Mech already deployed at ${state.mech_address}, skipping`);
      return this.store.patch({ step: 'complete' });
    }

    const serviceId = state.service_id!;
    const signerKey = await this.loadPrivateKey(password);
    const safe = await this.getSafe(state, signerKey);

    const mechMarketplaceIface = new Interface(MECH_MARKETPLACE_CREATE_ABI);

    // Encode the request price as the payload
    const { AbiCoder } = await import('ethers');
    const payload = AbiCoder.defaultAbiCoder().encode(['uint256'], [this.config.mechRequestPrice]);

    const createData = mechMarketplaceIface.encodeFunctionData('create', [
      serviceId,
      this.config.mechFactory,
      payload,
    ]);

    console.error(`[earning-bootstrap] Deploying mech for service ${serviceId}`);
    const result = await executeSafeTxBatch(safe, [
      { to: this.config.mechMarketplace, value: '0', data: createData },
    ]);

    // Wait for confirmation and parse CreateMech event
    console.error(`[earning-bootstrap] Mech deployment tx: ${result.hash}`);
    const receipt = await this.provider.waitForTransaction(result.hash, 1, 30000);
    let mechAddress: string | null = null;

    if (!receipt) {
      throw new Error(`Mech deployment tx not confirmed: ${result.hash}`);
    } else if (receipt.status === 0) {
      throw new Error(`Mech deployment tx reverted: ${result.hash}`);
    }

    if (receipt) {
      console.error(`[earning-bootstrap] Receipt has ${receipt.logs.length} logs:`);
      for (const log of receipt.logs) {
        console.error(`  addr=${log.address.slice(0, 10)}... topic0=${log.topics[0]?.slice(0, 10)}... topics=${log.topics.length}`);
      }
      // CreateMech(address indexed mech, uint256 indexed serviceId, address indexed mechFactory)
      // Topic0 = 0x46e1ca45c09520471c43e2e88eca33bb51803011cfd456933629dcc645ecacd6
      const createMechTopic = '0x46e1ca45c09520471c43e2e88eca33bb51803011cfd456933629dcc645ecacd6';
      for (const log of receipt.logs) {
        if (log.topics[0] === createMechTopic && log.topics.length >= 2) {
          mechAddress = getAddress('0x' + log.topics[1].slice(26));
          break;
        }
      }

      // Fallback: scan for any log from the marketplace with enough topics
      if (!mechAddress) {
        for (const log of receipt.logs) {
          if (log.address.toLowerCase() === this.config.mechMarketplace.toLowerCase() && log.topics.length >= 2) {
            const potentialMech = '0x' + log.topics[1].slice(26);
            if (potentialMech.length === 42 && potentialMech !== '0x0000000000000000000000000000000000000000') {
              mechAddress = getAddress(potentialMech);
              break;
            }
          }
        }
      }
    }

    if (!mechAddress) {
      throw new Error(`CreateMech event not found in tx ${result.hash}`);
    }

    console.error(`[earning-bootstrap] Mech deployed at ${mechAddress} (tx: ${result.hash})`);
    return this.store.patch({
      step: 'complete',
      mech_address: mechAddress,
    });
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  private async loadPrivateKey(password: string): Promise<string> {
    const keystoreJson = await this.store.loadKeystore();
    const wallet = await Wallet.fromEncryptedJson(keystoreJson, password);
    return wallet.privateKey;
  }

  private async refreshPredictedSafeAddress(
    state: EarningState,
    password: string,
  ): Promise<EarningState> {
    if (state.step === 'wallet' || !state.agent_address || !this.store.hasKeystore()) {
      return state;
    }

    const signerKey = await this.loadPrivateKey(password);
    const { address } = await initPredictedSafe({
      rpcUrl: this.config.rpcUrl,
      signerKey,
      owners: [state.agent_address],
      threshold: 1,
    });

    const reconciliation = reconcilePredictedSafeState(state, address);
    if (!reconciliation.changed) {
      return state;
    }

    const previousSafeAddress = state.safe_address;
    const nextState = await this.store.patch({
      safe_address: reconciliation.safeAddress,
      step: reconciliation.step,
      error: null,
    });

    if (reconciliation.rewound && previousSafeAddress) {
      console.error(
        `[earning-bootstrap] Safe prediction changed from ${previousSafeAddress} to ${reconciliation.safeAddress}; rewinding to awaiting_funding to recheck balances on the current chain.`,
      );
    } else {
      console.error(`[earning-bootstrap] Using predicted Safe ${reconciliation.safeAddress}`);
    }

    return nextState;
  }

  private async refreshServiceProgressState(state: EarningState): Promise<EarningState> {
    if (
      state.service_id === null ||
      state.step === 'wallet' ||
      state.step === 'safe_predicted' ||
      state.step === 'awaiting_funding' ||
      state.step === 'safe_deployed'
    ) {
      return state;
    }

    const serviceState = await this.getServiceState(state.service_id);
    const stakingState = serviceState >= ServiceState.Deployed
      ? await this.getStakingState(state.service_id)
      : 0;
    const reconciliation = reconcileServiceProgressState(state, serviceState, stakingState);
    if (!reconciliation.changed) {
      return state;
    }

    const nextState = await this.store.patch({
      step: reconciliation.step,
      error: null,
    });

    console.error(
      `[earning-bootstrap] Reconciled service ${state.service_id} from local step ${state.step} to on-chain step ${reconciliation.step}.`,
    );

    return nextState;
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
    let lastError: unknown;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        const balance: bigint = await olas.balanceOf(address);
        return balance;
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
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

  private async waitForSuccessfulTx(txHash: string, label: string): Promise<void> {
    const receipt = await this.provider.waitForTransaction(txHash, 1, 30000);
    if (!receipt) {
      throw new Error(`${label} tx not confirmed: ${txHash}`);
    }
    if (receipt.status !== 1) {
      throw new Error(`${label} tx reverted: ${txHash}`);
    }
  }

  /** Returns 0=Unstaked, 1=Staked, 2=Evicted */
  private async getStakingState(serviceId: number): Promise<number> {
    const staking = new Contract(
      this.config.stakingContract,
      STAKING_ABI,
      this.provider,
    );
    return Number(await staking.getStakingState(serviceId));
  }

  private async parseServiceIdFromTx(txHash: string): Promise<number | null> {
    // Retry fetching receipt: Anvil fork may return receipt without logs on first attempt
    let receipt = await this.provider.getTransactionReceipt(txHash);

    // If receipt exists but has no logs, retry more aggressively (Anvil lazy state)
    if (receipt && receipt.logs.length === 0) {
      for (let i = 0; i < 15; i++) {
        await new Promise(resolve => setTimeout(resolve, 200));
        const retryReceipt = await this.provider.getTransactionReceipt(txHash);
        if (retryReceipt && retryReceipt.logs.length > 0) {
          receipt = retryReceipt;
          console.error(`[earning-bootstrap] Receipt logs appeared after ${(i + 1) * 200}ms`);
          break;
        }
      }
    }

    if (!receipt) {
      return null;
    }

    if (receipt.logs.length === 0) {
      console.error(`[earning-bootstrap] Warning: receipt has no logs after all retries for tx ${txHash}`);
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

    // Fallback: extract from ERC721 Transfer event (mint from 0x0)
    const transferTopic = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
    const zeroTopic = '0x0000000000000000000000000000000000000000000000000000000000000000';
    for (const log of receipt.logs) {
      if (
        log.address.toLowerCase() === serviceRegistryAddress &&
        log.topics[0] === transferTopic &&
        log.topics[1] === zeroTopic // from = 0x0 (mint)
      ) {
        const tokenId = parseInt(log.topics[3], 16);
        if (!isNaN(tokenId) && tokenId > 0) {
          return tokenId;
        }
      }
    }

    return null;
  }

  private async buildFundingRequirement(state: EarningState): Promise<FundingRequirement> {
    const eoaAddress = state.agent_address!;
    const safeAddress = state.safe_address!;
    const requiredSafeTokenBalance = this.getRequiredSafeTokenBalance();

    const [eoaBalance, safeNativeBalance, olasBalance] = await Promise.all([
      this.provider.getBalance(eoaAddress),
      this.provider.getBalance(safeAddress),
      this.getOlasBalance(safeAddress),
    ]);

    const safeNativeShortfall = this.getFundingShortfall(this.config.minSafeEth, safeNativeBalance);

    return {
      eoa_address: eoaAddress,
      eoa_eth_required: (this.config.minEoaGasEth + safeNativeShortfall).toString(),
      eoa_eth_balance: eoaBalance.toString(),
      safe_address: safeAddress,
      safe_eth_required: this.config.minSafeEth.toString(),
      safe_eth_balance: safeNativeBalance.toString(),
      safe_olas_required: requiredSafeTokenBalance.toString(),
      safe_olas_balance: olasBalance.toString(),
    };
  }

  private describeStep(step: EarningStep, funding?: FundingRequirement): string {
    if (step === 'complete' && this.stopAt === 'complete') {
      return 'Earning bootstrap complete. Service is staked and running.';
    }

    if (this.stopAt !== 'complete' && this.hasReachedStopTarget(step)) {
      return `Earning bootstrap reached stop target at ${this.stopAt}.`;
    }

    if (step === 'awaiting_funding' && funding) {
      const lines = ['Waiting for funding:'];
      const eoaNeeded = BigInt(funding.eoa_eth_required) - BigInt(funding.eoa_eth_balance);
      const safeEthNeeded = BigInt(funding.safe_eth_required) - BigInt(funding.safe_eth_balance);
      const olasNeeded = BigInt(funding.safe_olas_required) - BigInt(funding.safe_olas_balance);

      if (eoaNeeded > 0n) {
        lines.push(`  EOA (${funding.eoa_address}): needs ${eoaNeeded} wei ETH for gas and Safe top-up`);
      }
      if (safeEthNeeded > 0n) {
        lines.push(`  Safe (${funding.safe_address}): needs ${safeEthNeeded} wei ETH for bootstrap/request value (or fund the EOA and it will auto-top-up the Safe)`);
      }
      if (olasNeeded > 0n) {
        lines.push(`  Safe (${funding.safe_address}): needs ${olasNeeded} wei OLAS for service security deposit and agent bond`);
      }

      return lines.join('\n');
    }

    return `Bootstrap paused at step '${step}'.`;
  }

  private hasReachedStopTarget(step: EarningStep): boolean {
    if (this.stopAt === 'service_staked') {
      return step === 'mech_deployed' || step === 'complete';
    }

    if (this.stopAt === 'mech_deployed') {
      return step === 'complete';
    }

    return step === 'complete';
  }

  private getFundingShortfall(required: bigint, balance: bigint): bigint {
    return balance >= required ? 0n : required - balance;
  }

  private getRequiredSafeTokenBalance(): bigint {
    return this.config.bondAmount * SAFE_TOKEN_BOOTSTRAP_MULTIPLIER;
  }

  private async ensureSafeTokenBalance(safeAddress: string, required: bigint, action: string): Promise<void> {
    const balance = await this.getOlasBalance(safeAddress);
    if (balance < required) {
      throw new Error(
        `Safe ${safeAddress} needs ${required} token wei to ${action} but only has ${balance}.`,
      );
    }
  }

  private async transferEth(password: string, to: string, amount: bigint): Promise<void> {
    const signerKey = await this.loadPrivateKey(password);
    const signer = new Wallet(signerKey, this.provider);
    const txResponse = await signer.sendTransaction({ to, value: amount });
    const receipt = await txResponse.wait();

    if (!receipt || receipt.status !== 1) {
      throw new Error(`ETH transfer failed: ${txResponse.hash}`);
    }
  }
}
