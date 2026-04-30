/**
 * Fleet bootstrap state machine.
 *
 * Phase 1 (master): generate mnemonic → fund master EOA
 * Phase 2 (per-service): derive agent → stake → deploy mech
 */

import {
  decodeEventLog,
  encodeAbiParameters,
  encodeFunctionData,
  formatEther,
  getAddress,
  zeroAddress,
  type Address,
  type Hex,
  type TransactionReceipt,
} from 'viem';
import {
  type ChainConfig,
  ERC20_ABI,
  EVENT_TOPICS,
  IDENTITY_REGISTRY_ABI,
  IDENTITY_REGISTRY_ADDRESSES,
  SERVICE_MANAGER_ABI,
  SERVICE_REGISTRY_APPROVE_ABI,
  SERVICE_REGISTRY_L2_ABI,
  STAKING_ABI,
  MECH_MARKETPLACE_CREATE_ABI,
  STOLAS_DISTRIBUTOR_ABI,
  STOLAS_STAKING_SLOTS_ABI,
  applyChainGasOverrides,
  cidToBytes32,
  getChainConfig,
} from './contracts.js';
import {
  executeSafeTxBatch,
  executeSafeTxDirect,
  initDeployedSafe,
  initPredictedSafe,
} from './safe-adapter.js';
import { bindAgentWalletToSafe } from './agent-wallet-binding.js';
import { FleetStateStore } from './store.js';
import {
  generateMnemonic,
  encryptMnemonic,
  decryptMnemonic,
  deriveMasterAddress,
  deriveMasterSigner,
  deriveAgentAddress,
  deriveAgentSigner,
  walletPrivateKeyAtIndex,
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
import {
  formatBootstrapOperatorMessage,
  isJinnDebug,
} from '../operator-errors.js';
import {
  reconcileServiceAgainstChain,
  type ServiceChainSignals,
} from './reconcile.js';
import {
  previousSafeBeingAbandoned,
  sweepOrphanedServiceFunds,
} from './orphan-sweep.js';
import { requestTestnetFunding } from './faucet.js';
import {
  flattenErrorMessage,
  viemSendTransactionWithRetry,
  waitForTransactionReceiptWithRetry,
} from '../tx-retry.js';
import { isUnauthorizedAccountError } from '../errors/unauthorized-account.js';
import { createJinnPublicClient, createJinnWalletClient, type JinnOnchainNetwork } from './viem-clients.js';
import { isTransientEthReadError } from '../chain-read-errors.js';
import { nextFleetServiceIndex } from './next-service-index.js';
import { rpcHostForDisplay } from '../preflight/rpc-network.js';
import type { Account } from 'viem/accounts';

const addr = (value: string): Address => getAddress(value) as Address;

const SAFE_TOKEN_BOOTSTRAP_MULTIPLIER = 2n;

/** Conservative default: ~0.001 ETH/day master gas if not configured. */
const DEFAULT_MASTER_ETH_DAILY_WEI = 1_000_000_000_000_000n;
/** Warn when ETH above the minimum would last fewer than this many days at the daily estimate. */
const MASTER_ETH_RUNWAY_WARN_DAYS = 7n;

export interface FleetBootstrapperOptions {
  earningDir?: string;
  chain?: 'base' | 'base-sepolia';
  rpcUrl?: string;
  env?: NodeJS.ProcessEnv;
  stakingMode?: 'standard' | 'self-bond';
  targetServices?: number;
  testnetL2DeploymentPath?: string;
  testnetL2TokenDeploymentPath?: string;
  testnetMechDeploymentPath?: string;
  testnetStolasDeploymentPath?: string;
  testnetClaimRegistryDeploymentPath?: string;
  /** Verbose errors (default: JINN_DEBUG env or false). */
  debug?: boolean;
  /** Estimated master gas per day (wei) for runway warnings. */
  masterEthDailyEstimateWei?: bigint | string;
  /** Optional bootstrap/top-up target override (wei). */
  minEoaGasWei?: string;
  /** Optional Safe ETH target override (wei). */
  minSafeEthWei?: string;
  /**
   * When `masterEthDailyEstimateWei` is unset, blends a conservative daily estimate
   * from poll frequency (config.pollIntervalMs).
   */
  pollIntervalMs?: number;
  /**
   * Injectable faucet function — defaults to {@link requestTestnetFunding}.
   * Provided in tests to avoid hitting the real CDP endpoint.
   */
  requestFunding?: typeof requestTestnetFunding;
}

export class FleetBootstrapper {
  private readonly store: FleetStateStore;
  private readonly config: ChainConfig;
  private readonly publicClient: ReturnType<typeof createJinnPublicClient>;
  private readonly chain: JinnOnchainNetwork;
  private readonly stakingMode: StakingMode;
  private readonly targetServices: number;
  private readonly debug: boolean;
  private readonly masterEthDailyEstimateWei: bigint;
  private readonly env: NodeJS.ProcessEnv;
  private readonly requestFunding: typeof requestTestnetFunding;

  constructor(options: FleetBootstrapperOptions = {}) {
    this.store = new FleetStateStore(options.earningDir);
    this.chain = options.chain ?? 'base';
    this.env = options.env ?? process.env;
    this.stakingMode = options.stakingMode ?? 'standard';
    this.targetServices = options.targetServices ?? 1;
    this.debug = options.debug ?? isJinnDebug();
    this.requestFunding = options.requestFunding ?? requestTestnetFunding;
    const dailyOpt = options.masterEthDailyEstimateWei;
    this.masterEthDailyEstimateWei =
      dailyOpt !== undefined
        ? BigInt(dailyOpt)
        : this.estimateMasterDailyGasWei(options.pollIntervalMs);
    this.config = applyChainGasOverrides(getChainConfig(this.chain, {
      testnetL2DeploymentPath: options.testnetL2DeploymentPath,
      testnetL2TokenDeploymentPath: options.testnetL2TokenDeploymentPath,
      testnetMechDeploymentPath: options.testnetMechDeploymentPath,
      testnetStolasDeploymentPath: options.testnetStolasDeploymentPath,
      testnetClaimRegistryDeploymentPath: options.testnetClaimRegistryDeploymentPath,
    }), {
      minEoaGasWei: options.minEoaGasWei ?? this.env['JINN_MIN_EOA_GAS_WEI'],
      minSafeEthWei: options.minSafeEthWei ?? this.env['JINN_MIN_SAFE_ETH_WEI'],
    });

    if (options.rpcUrl) {
      this.config.rpcUrl = options.rpcUrl;
    }

    this.publicClient = createJinnPublicClient(this.config.rpcUrl, this.chain);
  }

  async getStatus(): Promise<FleetState> {
    return this.store.load(this.chain);
  }

  /**
   * Conservative daily master gas (wei): max(DEFAULT, rough tx count from poll interval × cost).
   */
  private estimateMasterDailyGasWei(pollIntervalMs?: number): bigint {
    const interval = Math.max(pollIntervalMs ?? 5000, 1000);
    const pollsPerDay = 86400000 / interval;
    // Assume at most one funding-sized tx per ~600 polls (~50 min at 5s), capped at 12/day
    const txsPerDay = Math.min(Math.ceil(pollsPerDay / 600), 12);
    const txCostWei = 150_000n * 2_000_000_000n; // ~150k gas @ 2 gwei
    const fromPoll = BigInt(txsPerDay) * txCostWei;
    return fromPoll > DEFAULT_MASTER_ETH_DAILY_WEI ? fromPoll : DEFAULT_MASTER_ETH_DAILY_WEI;
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
      let masterBalance = await this.publicClient.getBalance({ address: masterAddress as Address });
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
            systemEth += await this.publicClient.getBalance({
              address: getAddress(svc.agent_address) as Address,
            });
          }
          if (svc.safe_address) {
            systemEth += await this.publicClient.getBalance({
              address: getAddress(svc.safe_address) as Address,
            });
          }
        }
      }
      const completedCountBeforeFunding = state.services.filter(s => s.step === 'complete').length;
      const standardFleetAlreadyComplete =
        this.stakingMode === 'standard' && completedCountBeforeFunding >= this.targetServices;
      const requiredMasterEth = this.stakingMode === 'standard'
        ? (standardFleetAlreadyComplete ? 0n : this.config.minEoaGasEth)
        : SELF_BOND_ETH_PER_SERVICE * BigInt(this.targetServices);
      const autoFaucetEnabled = this.env['JINN_DISABLE_TESTNET_FAUCET'] !== '1';

      // Re-sum system ETH (master + agent/safe balances for self-bond mode).
      // Hoisted so the drip loop below can refresh cheaply.
      const refreshSystemEth = async (): Promise<{ system: bigint; master: bigint }> => {
        const m = await this.publicClient.getBalance({ address: masterAddress as Address });
        let total = m;
        if (this.stakingMode === 'self-bond') {
          for (const svc of state.services) {
            if (svc.agent_address) {
              total += await this.publicClient.getBalance({
                address: getAddress(svc.agent_address) as Address,
              });
            }
            if (svc.safe_address) {
              total += await this.publicClient.getBalance({
                address: getAddress(svc.safe_address) as Address,
              });
            }
          }
        }
        return { system: total, master: m };
      };

      // On testnet, drain the CDP faucet in a loop until master has enough ETH.
      // CDP's drip is tiny (~0.0001 ETH) vs the 0.005 ETH bootstrap floor — a
      // single drip is never enough, and the older two-drip pattern forced
      // operators to re-run `jinn bootstrap` 25+ times. We loop until funded,
      // rate-limited, or an error. Cap at 60 iterations as a safety bound.
      if (systemEth < requiredMasterEth && this.chain === 'base-sepolia' && autoFaucetEnabled) {
        const MAX_FAUCET_ITERS = 60;
        const INTER_DRIP_PAUSE_MS = 1_000;
        console.error(
          `[fleet-bootstrap] Master has ${formatEther(systemEth)} ETH; need ${formatEther(requiredMasterEth)} ETH. ` +
          `Draining CDP faucet on ${this.chain} via ${rpcHostForDisplay(this.config.rpcUrl)} ` +
          `(each drip ≈ 0.0001 ETH, up to ${MAX_FAUCET_ITERS} drips; expect ~30-60 s on first run).`,
        );
        for (let i = 0; i < MAX_FAUCET_ITERS; i++) {
          const faucetResult = await this.requestFunding(masterAddress, 'base-sepolia');
          if (!faucetResult.ok) {
            if (faucetResult.rateLimited) {
              console.error(`[fleet-bootstrap] CDP faucet rate-limited after ${i} drips: ${faucetResult.reason}`);
            } else {
              console.error(`[fleet-bootstrap] CDP faucet error after ${i} drips: ${faucetResult.reason}`);
            }
            break;
          }
          await new Promise(r => setTimeout(r, INTER_DRIP_PAUSE_MS));
          const refreshed = await refreshSystemEth();
          systemEth = refreshed.system;
          masterBalance = refreshed.master;
          if ((i + 1) % 5 === 0) {
            console.error(
              `[fleet-bootstrap] drip ${i + 1}/${MAX_FAUCET_ITERS} · chain=${this.chain} · rpc=${rpcHostForDisplay(this.config.rpcUrl)} · ` +
              `master=${formatEther(masterBalance)} ETH · target=${formatEther(requiredMasterEth)} ETH`,
            );
          }
          if (systemEth >= requiredMasterEth) {
            console.error(
              `[fleet-bootstrap] Faucet funding sufficient after ${i + 1} drip${i === 0 ? '' : 's'} ` +
              `(master=${formatEther(masterBalance)} ETH). Continuing bootstrap...`,
            );
            break;
          }
        }
      }

      if (systemEth < requiredMasterEth && this.chain === 'base-sepolia' && autoFaucetEnabled) {
        console.error(
          '[fleet-bootstrap] Automatic faucet funding did not reach the target. ' +
          'Switching to manual funding only; no more faucet requests will be sent in this run.',
        );
      }

      if (systemEth < requiredMasterEth) {
        const shortfall = requiredMasterEth - systemEth;
        const friendly = `Your master wallet needs more ETH (currently ${formatEther(masterBalance)} ETH, need ${formatEther(shortfall)} ETH more). Please send ETH to: ${masterAddress}`;
        return {
          ok: false,
          fleet_state: state,
          message: friendly,
          funding: {
            master_address: masterAddress,
            eth_required: shortfall.toString(),
            eth_balance: masterBalance.toString(),
          },
        };
      }

      this.warnMasterEthRunway(masterAddress, masterBalance, requiredMasterEth);

      // Phase 2: Bootstrap services up to target
      const mnemonic = await decryptMnemonic(
        await this.store.loadMnemonicKeystore(),
        password,
      );

      state = await this.reconcileFleetWithChain(state, mnemonic);

      // Resume all services. For incomplete services, this picks up where they
      // left off. For "complete" services in standard mode, this also runs the
      // eviction recovery check (since on-chain state may have changed since
      // the daemon was last running — e.g., evicted due to inactivity).
      for (const svc of state.services) {
        if (svc.step !== 'complete') {
          console.error(`[fleet-bootstrap] Resuming service ${svc.index} at step '${svc.step}'`);
        }
        state = await this.resumeService(state, mnemonic, svc.index);
      }

      // Then create new services if needed
      const completedCount = state.services.filter(s => s.step === 'complete').length;
      const needed = this.targetServices - completedCount;

      if (needed > 0) {
        console.error(`[fleet-bootstrap] ${completedCount}/${this.targetServices} services complete, bootstrapping ${needed} more`);
      }

      for (let i = 0; i < needed; i++) {
        const nextIndex = nextFleetServiceIndex(state.services);
        state = await this.bootstrapService(state, mnemonic, nextIndex);
      }

      return {
        ok: true,
        fleet_state: state,
        message: `Fleet bootstrap complete. ${state.services.filter(s => s.step === 'complete').length}/${this.targetServices} services running.`,
      };
    } catch (error) {
      const { summary, hint } = formatBootstrapOperatorMessage(error);
      const userMessage = hint !== undefined ? `${summary}\nHint: ${hint}` : summary;
      if (this.debug) {
        console.error(`[fleet-bootstrap] Bootstrap failed:`, error);
      } else {
        console.error(`[fleet-bootstrap] ${summary}`);
        if (hint !== undefined) console.error(`Hint: ${hint}`);
      }
      return {
        ok: false,
        fleet_state: state,
        message: userMessage,
      };
    }
  }

  /**
   * If the master is only slightly above the minimum, warn about gas runway (heuristic days).
   */
  private warnMasterEthRunway(
    masterAddress: string,
    masterBalance: bigint,
    requiredMasterEth: bigint,
  ): void {
    const daily = this.masterEthDailyEstimateWei;
    if (daily === 0n) return;
    const excess = masterBalance > requiredMasterEth ? masterBalance - requiredMasterEth : 0n;
    const threshold = daily * MASTER_ETH_RUNWAY_WARN_DAYS;
    if (excess >= threshold) return;

    const days = excess / daily;
    console.error(
      `[fleet-bootstrap] Warning: Master wallet ETH headroom is low (~${days} day(s) at estimated daily usage). ` +
        `Consider sending more ETH to: ${masterAddress}`,
    );
  }

  // ── Phase 1: Master wallet ───────────────────────────────────────────

  private async ensureMasterWallet(
    state: FleetState,
    password: string,
  ): Promise<FleetState> {
    if (this.store.hasMnemonicKeystore() && state.master_address) {
      return state;
    }

    // `jinn init` writes the mnemonic keystore but does not patch earning_state.json.
    // Hydrate master_address from the existing keystore instead of generating a new wallet.
    if (this.store.hasMnemonicKeystore()) {
      const mnemonic = await decryptMnemonic(await this.store.loadMnemonicKeystore(), password);
      const masterAddress = deriveMasterAddress(mnemonic);
      return this.store.patchFleet({
        master_address: masterAddress,
        chain: this.chain,
        staking_mode: this.stakingMode,
      });
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

  /**
   * Compare persisted per-service state to registry/staking/Safe bytecode and patch store
   * when local JSON is ahead, behind, or stale (idempotent; safe to repeat).
   */
  private async reconcileFleetWithChain(
    state: FleetState,
    mnemonic: string,
  ): Promise<FleetState> {
    const ctx = { stakingContract: this.config.stakingContract };
    let next = state;
    for (const svc of state.services) {
      const signals = await this.gatherChainSignals(svc);
      const result = reconcileServiceAgainstChain(this.stakingMode, svc, signals, ctx);
      if (result) {
        const abandoned = previousSafeBeingAbandoned(svc, result.patch);
        if (abandoned && state.master_address) {
          await this.sweepAbandonedSafeForService(
            state,
            mnemonic,
            svc.index,
            abandoned,
          );
        }
        console.error(result.message);
        next = await this.store.updateService(svc.index, result.patch);
      }
    }
    return next;
  }

  /** Best-effort ETH recovery before persisted Safe address is cleared or replaced. */
  private async sweepAbandonedSafeForService(
    state: FleetState,
    mnemonic: string,
    serviceIndex: number,
    abandonedSafeAddress: string,
  ): Promise<void> {
    if (!state.master_address) return;
    const masterSigner = deriveMasterSigner(mnemonic);
    const agentSigner = deriveAgentSigner(mnemonic, serviceIndex);
    await sweepOrphanedServiceFunds({
      rpcUrl: this.config.rpcUrl,
      network: this.chain,
      publicClient: this.publicClient,
      masterAddress: state.master_address,
      masterAccount: masterSigner,
      serviceIndex,
      agentPrivateKey: walletPrivateKeyAtIndex(mnemonic, serviceIndex),
      agentAddress: agentSigner.address,
      abandonedSafeAddress,
      minAgentReserveWei: this.config.minEoaGasEth,
    });
  }

  private async gatherChainSignals(svc: ServiceState): Promise<ServiceChainSignals> {
    let safeDeployed: boolean | null = null;
    if (svc.safe_address) {
      try {
        const code = await this.publicClient.getCode({ address: getAddress(svc.safe_address) as Address });
        safeDeployed = code !== '0x';
      } catch {
        safeDeployed = null;
      }
    }

    if (svc.service_id === null) {
      return {
        stakingState: 0,
        stakingMultisig: null,
        registryState: 0,
        registryMultisig: null,
        safeDeployed,
      };
    }

    const id = svc.service_id;
    const stakingAddr = this.config.stakingContract as Address;
    const registryAddr = this.config.serviceRegistry as Address;

    let stakingState: number | 'revert' | 'inconclusive' = 0;
    try {
      stakingState = Number(
        await this.publicClient.readContract({
          address: stakingAddr,
          abi: STAKING_ABI,
          functionName: 'getStakingState',
          args: [BigInt(id)],
        }),
      );
    } catch (e) {
      stakingState = isTransientEthReadError(e) ? 'inconclusive' : 'revert';
    }

    let stakingMultisig: string | null = null;
    if (stakingState !== 'revert' && stakingState !== 'inconclusive') {
      try {
        const info = await this.publicClient.readContract({
          address: stakingAddr,
          abi: STAKING_ABI,
          functionName: 'getServiceInfo',
          args: [BigInt(id)],
        });
        const m = info[1] as string;
        stakingMultisig =
          m && getAddress(m) !== getAddress(zeroAddress) ? getAddress(m) : null;
      } catch {
        stakingMultisig = null;
      }
    }

    let registryState: number | 'revert' | 'inconclusive' = 0;
    let registryMultisig: string | null = null;
    try {
      const s = await this.publicClient.readContract({
        address: registryAddr,
        abi: SERVICE_REGISTRY_L2_ABI,
        functionName: 'getService',
        args: [BigInt(id)],
      });
      registryState = Number(s.state);
      const m = s.multisig as string;
      registryMultisig =
        m && getAddress(m) !== getAddress(zeroAddress) ? getAddress(m) : null;
    } catch (e) {
      registryState = isTransientEthReadError(e) ? 'inconclusive' : 'revert';
      registryMultisig = null;
    }

    if (stakingState === 'inconclusive' || registryState === 'inconclusive') {
      console.error(
        `[fleet-bootstrap] Service ${svc.index}: chain read inconclusive (likely RPC). Skipping reconcile for this run; persisted state unchanged.`,
      );
    }

    return {
      stakingState,
      stakingMultisig,
      registryState,
      registryMultisig,
      safeDeployed,
    };
  }

  private async resumeService(
    state: FleetState,
    mnemonic: string,
    index: number,
  ): Promise<FleetState> {
    let svc = state.services.find(s => s.index === index);
    if (!svc) throw new Error(`Service ${index} not found in state`);

    // Eviction recovery: even for "complete" services, check if on-chain shows
    // evicted (state=2). If so, unstake and reset to awaiting_stake so the
    // bootstrap restakes fresh. Only applies to standard mode (distributor-managed).
    if (
      this.stakingMode === 'standard' &&
      svc.service_id !== null &&
      (svc.step === 'complete' || svc.step === 'mech_deployed' || svc.step === 'staked')
    ) {
      const onChainState = await this.getStakingState(svc.service_id);
      if (onChainState === 2) {
        console.error(
          `[jinn-earning] Noticed service ${svc.service_id} (fleet index ${index}) evicted on-chain; running distributor reStake to restake.`,
        );
        state = await this.recoverEvictedService(state, mnemonic, index);
        svc = state.services.find(s => s.index === index)!;
      }
    }

    if (svc.step === 'complete') {
      // Legacy operator recovery: agent NFT was minted (agent_id set) but the
      // Safe was never bound via IdentityRegistry.setAgentWallet. This happens
      // for operators who ran bootstrap after the mint step landed (jinn-mono-j07)
      // but before the Safe-binding feature shipped (jinn-mono-aev). Without this
      // check they would remain permanently unbound.
      if (svc.agent_id && svc.safe_address && svc.safe_bound_to_agent !== true) {
        console.error(
          `[fleet-bootstrap] Service ${index}: legacy agent_id=${svc.agent_id} with unbound Safe; running binding step.`,
        );
        state = await this.stepRegisterAgent(state, mnemonic, index);
        // Restore step to complete after the binding sub-step finishes.
        state = await this.store.updateService(index, { step: 'complete' });
      }
      return state;
    }

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
    let updatedSvc = (await this.store.load(this.chain)).services.find(s => s.index === index);
    if (!updatedSvc) throw new Error(`Service ${index} disappeared from state`);

    if (updatedSvc.step === 'staked' || updatedSvc.step === 'mech_deployed') {
      state = await this.stepDeployMech(state, mnemonic, index);
      updatedSvc = (await this.store.load(this.chain)).services.find(s => s.index === index)!;
    }

    if (updatedSvc.step === 'mech_deployed' || updatedSvc.step === 'agent_registered') {
      state = await this.stepRegisterAgent(state, mnemonic, index);
      updatedSvc = (await this.store.load(this.chain)).services.find(s => s.index === index)!;
    }

    if (updatedSvc.step === 'agent_registered') {
      state = await this.store.updateService(index, { step: 'complete' });
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
      svc = (await this.store.load(this.chain)).services.find(s => s.index === index)!;
    }

    if (svc.step === 'mech_deployed' || svc.step === 'agent_registered') {
      state = await this.stepRegisterAgent(state, mnemonic, index);
      svc = (await this.store.load(this.chain)).services.find(s => s.index === index)!;
    }

    if (svc.step === 'agent_registered') {
      state = await this.store.updateService(index, { step: 'complete' });
    }

    return this.store.load(this.chain);
  }

  private async stepStolasStake(
    state: FleetState,
    mnemonic: string,
    index: number,
  ): Promise<FleetState> {
    const svc = state.services.find(s => s.index === index)!;

    // Idempotency: if this service already has an id and is already staked, skip
    if (svc.service_id !== null) {
      const stakingState = await this.getStakingState(svc.service_id);
      if (stakingState === 1) {
        console.error(`[fleet-bootstrap] Service ${index} already staked, skipping`);
        return this.store.updateService(index, { step: 'staked' });
      }
    }

    // Fresh distributor stake() creates a new on-chain service. If state still
    // references an old Safe (e.g. hand-edited JSON), sweep it before replacing.
    if (svc.service_id === null && svc.safe_address && state.master_address) {
      try {
        const oldSafe = getAddress(svc.safe_address);
        await this.sweepAbandonedSafeForService(state, mnemonic, index, oldSafe);
      } catch {
        // Ignore invalid persisted safe_address; later steps will surface errors if needed.
      }
    }

    // Preflight
    await this.stolasPreflightCheck();

    // Master EOA signs the stake() call
    const masterAccount = deriveMasterSigner(mnemonic);
    const masterWallet = createJinnWalletClient(this.config.rpcUrl, this.chain, masterAccount);
    const agentAddress = svc.agent_address as Address;

    const configHashBytes = cidToBytes32(this.config.serviceHash) as Hex;
    const stakeData = encodeFunctionData({
      abi: STOLAS_DISTRIBUTOR_ABI,
      functionName: 'stake',
      args: [
        this.config.stakingContract as Address,
        0n,
        BigInt(this.config.agentId),
        configHashBytes,
        agentAddress,
      ],
    }) as Hex;

    console.error(`[fleet-bootstrap] Service ${index}: calling distributor.stake() from master`);
    const txHash = await viemSendTransactionWithRetry(
      masterWallet,
      this.publicClient,
      {
        account: masterAccount as Account,
        to: addr(this.config.distributorAddress!),
        data: stakeData,
        gas: 2_500_000n,
      },
    );

    const receipt = await waitForTransactionReceiptWithRetry(this.publicClient, txHash);
    if (receipt.status !== 'success') {
      throw new Error(`stOLAS stake() tx failed for service ${index}: ${txHash}`);
    }

    console.error(`[fleet-bootstrap] Service ${index}: stake() confirmed (tx: ${txHash})`);

    // Parse events
    const serviceId = await this.parseServiceIdFromReceipt(receipt);
    if (serviceId === null) {
      throw new Error(`stake() succeeded but CreateService event not found (tx: ${txHash})`);
    }

    const safeAddress = this.parseMultisigFromReceipt(receipt);
    if (!safeAddress) {
      throw new Error(`stake() succeeded but CreateMultisigWithAgents event not found (tx: ${txHash})`);
    }

    console.error(`[fleet-bootstrap] Service ${index}: id=${serviceId}, safe=${safeAddress}`);

    return this.store.updateService(index, {
      service_id: serviceId,
      safe_address: safeAddress,
      staking_address: this.config.stakingContract,
      step: 'staked',
    });
  }

  private async recoverEvictedService(
    state: FleetState,
    mnemonic: string,
    index: number,
  ): Promise<FleetState> {
    if (!this.config.distributorAddress) {
      throw new Error('distributorAddress not configured');
    }

    const svc = state.services.find(s => s.index === index)!;
    const serviceId = svc.service_id!;

    // `reStake()` is operator-scoped: the master EOA must match the
    // distributor's recorded `mapServiceIdCuratingAgents[serviceId]` entry.
    // If it doesn't, the operator is likely using the wrong earning dir or
    // password, or the service needs owner / managing-agent recovery.
    const masterAccount = deriveMasterSigner(mnemonic);
    const masterWallet = createJinnWalletClient(this.config.rpcUrl, this.chain, masterAccount);

    const reStakeData = encodeFunctionData({
      abi: STOLAS_DISTRIBUTOR_ABI,
      functionName: 'reStake',
      args: [this.config.stakingContract as Address, BigInt(serviceId)],
    }) as Hex;

    console.error(`[fleet-bootstrap] Service ${index}: calling distributor.reStake() for evicted service ${serviceId}`);
    let reStakeHash: Hex;
    try {
      reStakeHash = await viemSendTransactionWithRetry(masterWallet, this.publicClient, {
        account: masterAccount as Account,
        to: addr(this.config.distributorAddress),
        data: reStakeData,
        gas: 1_500_000n,
      });
    } catch (err) {
      const message = flattenErrorMessage(err);
      if (isUnauthorizedAccountError(message)) {
        throw new Error(
          `Service ${index} (service_id ${serviceId}) is evicted on the staking proxy, but master EOA ${masterAccount.address} is not authorized to reStake it. ` +
          `The distributor only permits the recorded service operator, a managing agent, or the owner. ` +
          `Verify JINN_EARNING_DIR and JINN_PASSWORD derive the original master EOA for this service, then re-run jinn bootstrap; otherwise request owner / managing-agent recovery or abandon-and-rebootstrap. ` +
          `reStake revert: ${message}`,
        );
      }
      throw err;
    }
    const receipt = await waitForTransactionReceiptWithRetry(this.publicClient, reStakeHash);
    if (receipt.status !== 'success') {
      throw new Error(`reStake failed for service ${index}: ${reStakeHash}`);
    }
    console.error(`[fleet-bootstrap] Service ${index}: reStake confirmed (tx: ${reStakeHash})`);

    // Service is now Staked again with the same service_id, safe_address, and mech_address.
    // Step back to `mech_deployed` so the resume loop advances through
    // `stepRegisterAgent` (idempotent — short-circuits if `agent_id` is
    // already set; mints if a pre-j07 operator was just re-staked and
    // never had the operator agent NFT). See jinn-mono-jgp.
    return this.store.updateService(index, {
      step: 'mech_deployed',
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
      return this.store.updateService(index, { step: 'mech_deployed' });
    }

    const serviceId = svc.service_id!;
    const safeAddress = svc.safe_address!;

    // Fund agent with gas from master
    const masterAccount = deriveMasterSigner(mnemonic);
    const masterWallet = createJinnWalletClient(this.config.rpcUrl, this.chain, masterAccount);
    const agentBalance = await this.publicClient.getBalance({
      address: getAddress(svc.agent_address) as Address,
    });

    // Agent needs enough gas for mech deployment Safe tx (~2.6M gas)
    const minAgentGas = this.config.minEoaGasEth;
    if (agentBalance < minAgentGas) {
      const fundAmount = minAgentGas - agentBalance;
      console.error(`[fleet-bootstrap] Service ${index}: funding agent with ${fundAmount} wei`);
      const fundHash = await viemSendTransactionWithRetry(masterWallet, this.publicClient, {
        account: masterAccount as Account,
        to: addr(svc.agent_address),
        value: fundAmount,
      });
      await waitForTransactionReceiptWithRetry(this.publicClient, fundHash);
    }

    // Deploy mech via the service Safe (agent is Safe owner)
    const agentKey = walletPrivateKeyAtIndex(mnemonic, index);

    const safe = await initDeployedSafe({
      rpcUrl: this.config.rpcUrl,
      signerKey: agentKey,
      safeAddress,
    });

    const payload = encodeAbiParameters([{ type: 'uint256' }], [this.config.mechRequestPrice]);

    const createData = encodeFunctionData({
      abi: MECH_MARKETPLACE_CREATE_ABI,
      functionName: 'create',
      args: [BigInt(serviceId), this.config.mechFactory as Address, payload],
    }) as Hex;

    console.error(`[fleet-bootstrap] Service ${index}: deploying mech`);
    const result = await executeSafeTxBatch(safe, [
      { to: this.config.mechMarketplace, value: '0', data: createData },
    ]);

    const mechReceipt = await waitForTransactionReceiptWithRetry(
      this.publicClient,
      result.hash as Hex,
    );
    if (mechReceipt.status !== 'success') {
      throw new Error(`Mech deployment tx failed for service ${index}: ${result.hash}`);
    }

    // Parse CreateMech event
    const createMechTopic = '0x46e1ca45c09520471c43e2e88eca33bb51803011cfd456933629dcc645ecacd6';
    let mechAddress: string | null = null;
    for (const log of mechReceipt.logs) {
      const t0 = log.topics[0];
      if (t0 === createMechTopic && log.topics.length >= 2) {
        mechAddress = getAddress(('0x' + log.topics[1]!.slice(26)) as Hex);
        break;
      }
    }

    if (!mechAddress) {
      throw new Error(`CreateMech event not found for service ${index} (tx: ${result.hash})`);
    }

    console.error(`[fleet-bootstrap] Service ${index}: mech deployed at ${mechAddress}`);

    return this.store.updateService(index, {
      mech_address: mechAddress,
      step: 'mech_deployed',
    });
  }

  /**
   * ERC-8004 IdentityRegistry mint + Safe wallet bind (jinn-mono-j07,
   * jinn-mono-aev).
   *
   * Two on-chain effects, gated independently for idempotency:
   *
   * 1. **Mint** (jinn-mono-j07): one operator agent NFT per service Safe;
   *    the agent EOA owns the token. Persists `agent_id` (and metadata)
   *    to state immediately after the receipt parses, so a crash between
   *    register and the subsequent `setAgentWallet` does not lose the
   *    token. v0 uses an empty `agentURI` — operators are expected to
   *    populate it later via `setAgentURI`. Re-run with `svc.agent_id`
   *    already set short-circuits the mint.
   *
   * 2. **Bind** (jinn-mono-aev): `IdentityRegistry.setAgentWallet(agentId,
   *    safe, deadline, sig)` from the agent EOA. The contract recovers
   *    `sig` against the Safe via ERC-1271; we wrap the EIP-712
   *    AgentWalletSet digest in Safe's SafeMessage typed-data and
   *    raw-ECDSA-sign with the sole owner (= agent EOA). On success,
   *    `safe_bound_to_agent` flips to true. Re-run with
   *    `svc.safe_bound_to_agent` already true short-circuits the bind.
   *    See `agent-wallet-binding.ts` + spec §4.1.
   *
   * Folded into a single step (rather than a discrete state) because the
   * existing `safe_bound_to_agent` flag already provides per-effect
   * idempotency, and the order is fixed (mint → bind → complete). Both
   * sub-steps re-enter cleanly on the existing `mech_deployed |
   * agent_registered` step guard.
   */
  private async stepRegisterAgent(
    state: FleetState,
    mnemonic: string,
    index: number,
  ): Promise<FleetState> {
    void state;
    let svc = (await this.store.load(this.chain)).services.find(s => s.index === index);
    if (!svc) throw new Error(`Service ${index} not found in state`);

    const identityRegistry = this.config.identityRegistry
      ?? IDENTITY_REGISTRY_ADDRESSES[this.config.chainId];
    if (!identityRegistry) {
      throw new Error(
        `IdentityRegistry address not configured for chainId=${this.config.chainId}; ` +
        `update IDENTITY_REGISTRY_ADDRESSES in earning/contracts.ts.`,
      );
    }

    const agentSigner = deriveAgentSigner(mnemonic, index);
    const agentWallet = createJinnWalletClient(this.config.rpcUrl, this.chain, agentSigner);

    // ── Sub-step A: mint NFT (skip if agent_id is already set). ─────────
    let agentId: string;
    if (svc.agent_id) {
      console.error(
        `[fleet-bootstrap] Service ${index}: ERC-8004 agent already registered ` +
        `(agentId=${svc.agent_id}); skipping mint.`,
      );
      agentId = svc.agent_id;
      svc = await this.firstServiceUpdate(index, {
        identity_registry_address: svc.identity_registry_address ?? getAddress(identityRegistry),
        step: 'agent_registered',
      });
    } else {
      // v0: empty agentURI. The richer agent card (per §6 of the spec) is
      // future work — operators may later call `setAgentURI`.
      const agentURI = '';
      const registerData = encodeFunctionData({
        abi: IDENTITY_REGISTRY_ABI,
        functionName: 'register',
        args: [agentURI],
      }) as Hex;

      console.error(
        `[fleet-bootstrap] Service ${index}: minting ERC-8004 agent NFT ` +
        `(IdentityRegistry=${identityRegistry}, agentEOA=${agentSigner.address})`,
      );

      const mintTxHash = await viemSendTransactionWithRetry(
        agentWallet,
        this.publicClient,
        {
          account: agentSigner as Account,
          to: addr(identityRegistry),
          data: registerData,
        },
      );

      const receipt = await waitForTransactionReceiptWithRetry(this.publicClient, mintTxHash);
      if (receipt.status !== 'success') {
        throw new Error(`IdentityRegistry.register() tx failed for service ${index}: ${mintTxHash}`);
      }

      const parsed = this.parseAgentIdFromReceipt(receipt, identityRegistry);
      if (parsed === null) {
        throw new Error(
          `IdentityRegistry.register() succeeded but Registered event was not found ` +
          `(service ${index}, tx: ${mintTxHash})`,
        );
      }
      agentId = parsed;

      console.error(
        `[fleet-bootstrap] Service ${index}: ERC-8004 agent registered ` +
        `(agentId=${agentId}, tx=${mintTxHash})`,
      );

      // Persist agentId IMMEDIATELY so a crash between this write and the
      // setAgentWallet call below does not lose the token.
      svc = await this.firstServiceUpdate(index, {
        agent_id: agentId,
        agent_uri: agentURI,
        identity_registry_address: getAddress(identityRegistry),
        agent_registered_tx: mintTxHash,
        step: 'agent_registered',
      });
    }

    // ── Sub-step B: bind Safe wallet via ERC-1271 (jinn-mono-aev). ──────
    // Idempotent: skip when already bound. Requires safe_address — if the
    // operator is in a topology without a Safe (future), the bind step is
    // simply not applicable and `safe_bound_to_agent` stays false.
    if (svc.safe_bound_to_agent) {
      console.error(
        `[fleet-bootstrap] Service ${index}: Safe already bound to agentId=${agentId} ` +
        `(safe=${svc.safe_address}); skipping setAgentWallet.`,
      );
    } else if (!svc.safe_address) {
      console.error(
        `[fleet-bootstrap] Service ${index}: no safe_address — cannot bind agent NFT ` +
        `(agentId=${agentId}). Bootstrap will leave safe_bound_to_agent=false; this is ` +
        `unexpected for the standard staking topology.`,
      );
    } else {
      console.error(
        `[fleet-bootstrap] Service ${index}: binding Safe ${svc.safe_address} to ` +
        `agentId=${agentId} via setAgentWallet (ERC-1271).`,
      );
      const result = await bindAgentWalletToSafe({
        identityRegistryAddress: addr(identityRegistry),
        agentId: BigInt(agentId),
        safeAddress: addr(svc.safe_address),
        agentEoaAccount: agentSigner,
        agentEoaWalletClient: agentWallet,
        publicClient: this.publicClient,
        chainId: this.config.chainId,
      });
      console.error(
        `[fleet-bootstrap] Service ${index}: setAgentWallet succeeded ` +
        `(tx=${result.txHash}, safe=${svc.safe_address}).`,
      );
      svc = await this.firstServiceUpdate(index, {
        safe_bound_to_agent: true,
      });
    }

    return this.store.load(this.chain);
  }

  /**
   * Tiny store wrapper: re-loads the service row after `updateService` so
   * the next sub-step sees the latest persisted shape (including any
   * fields written by sibling code paths since this fn started).
   */
  private async firstServiceUpdate(
    index: number,
    patch: Parameters<FleetStateStore['updateService']>[1],
  ): Promise<ServiceState> {
    await this.store.updateService(index, patch);
    const fleet = await this.store.load(this.chain);
    const svc = fleet.services.find(s => s.index === index);
    if (!svc) throw new Error(`Service ${index} not found after update`);
    return svc;
  }

  // ── Self-bond step handlers ──────────────────────────────────────────

  private async stepSelfBondSetup(
    state: FleetState,
    mnemonic: string,
    index: number,
  ): Promise<FleetState> {
    const svc = state.services.find(s => s.index === index)!;
    const agentSigner = deriveAgentSigner(mnemonic, index);
    const agentKey = walletPrivateKeyAtIndex(mnemonic, index);
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
    const masterAccount = deriveMasterSigner(mnemonic);
    const masterWallet = createJinnWalletClient(this.config.rpcUrl, this.chain, masterAccount);
    const agentBalance = await this.publicClient.getBalance({ address: getAddress(agentAddress) as Address });

    if (agentBalance < requiredAgentEth) {
      const fundAmount = requiredAgentEth - agentBalance;
      console.error(`[fleet-bootstrap] Service ${index}: funding agent with ${fundAmount} wei from master`);
      const fundHash = await viemSendTransactionWithRetry(masterWallet, this.publicClient, {
        account: masterAccount as Account,
        to: addr(agentAddress),
        value: fundAmount,
      });
      await waitForTransactionReceiptWithRetry(this.publicClient, fundHash);
    }

    // 3. Check agent ETH balance (retry — public RPCs can lag after a write)
    let agentBalanceAfter = 0n;
    for (let attempt = 0; attempt < 5; attempt++) {
      agentBalanceAfter = await this.publicClient.getBalance({ address: getAddress(agentAddress) as Address });
      if (agentBalanceAfter >= requiredAgentEth) break;
      if (attempt < 4) await new Promise(r => setTimeout(r, 2000));
    }
    if (agentBalanceAfter < requiredAgentEth) {
      throw new Error(
        `Service ${index}: agent ${agentAddress} needs ${requiredAgentEth} wei ETH but has ${agentBalanceAfter}`,
      );
    }

    // 4. Check Safe ETH balance (agent can auto-top)
    let safeEthBalance = await this.publicClient.getBalance({ address: getAddress(safeAddress) as Address });
    if (safeEthBalance < this.config.minSafeEth) {
      const eoaAvailable = agentBalanceAfter - this.config.minEoaGasEth;
      const shortfall = this.config.minSafeEth - safeEthBalance;
      if (eoaAvailable >= shortfall) {
        console.error(`[fleet-bootstrap] Service ${index}: auto-topping Safe with ${shortfall} wei ETH`);
        const agentWallet = createJinnWalletClient(this.config.rpcUrl, this.chain, agentSigner);
        const topHash = await viemSendTransactionWithRetry(agentWallet, this.publicClient, {
          account: agentSigner as Account,
          to: addr(safeAddress),
          value: shortfall,
        });
        await waitForTransactionReceiptWithRetry(this.publicClient, topHash);
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
    const olasBalance = await this.getBondTokenBalance(safeAddress);
    if (olasBalance < requiredOlas) {
      throw new Error(
        `Service ${index}: Safe ${safeAddress} needs ${requiredOlas} OLAS wei for bonding but has ${olasBalance}. ` +
        `Send OLAS tokens to the Safe address.`,
      );
    }

    // 6. Deploy Safe if not yet deployed
    const code = await this.publicClient.getCode({ address: getAddress(safeAddress) as Address });
    if (code === undefined || code === '0x') {
      console.error(`[fleet-bootstrap] Service ${index}: deploying Safe at ${safeAddress}`);
      const { safe } = await initPredictedSafe({
        rpcUrl: this.config.rpcUrl,
        signerKey: agentKey,
        owners: [agentAddress],
        threshold: 1,
      });

      const deployTx = await safe.createSafeDeploymentTransaction();
      const agentWallet = createJinnWalletClient(this.config.rpcUrl, this.chain, agentSigner);
      const deployHash = await viemSendTransactionWithRetry(agentWallet, this.publicClient, {
        account: agentSigner as Account,
        to: deployTx.to as Address,
        value: BigInt(deployTx.value),
        data: deployTx.data as Hex,
      });

      const receipt = await waitForTransactionReceiptWithRetry(this.publicClient, deployHash);
      if (receipt.status !== 'success') {
        throw new Error(`Safe deployment tx failed for service ${index}: ${deployHash}`);
      }

      const deployedCode = await this.publicClient.getCode({ address: getAddress(safeAddress) as Address });
      if (deployedCode === undefined || deployedCode === '0x') {
        throw new Error(`Safe deployment succeeded but no code at ${safeAddress}`);
      }

      console.error(`[fleet-bootstrap] Service ${index}: Safe deployed (tx: ${deployHash})`);
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

    const agentKey = walletPrivateKeyAtIndex(mnemonic, index);
    const safeAddress = svc.safe_address!;

    const safe = await initDeployedSafe({
      rpcUrl: this.config.rpcUrl,
      signerKey: agentKey,
      safeAddress,
    });

    const configHashBytes = cidToBytes32(this.config.serviceHash) as Hex;

    const createData = encodeFunctionData({
      abi: SERVICE_MANAGER_ABI,
      functionName: 'create',
      args: [
        getAddress(safeAddress) as Address,
        this.config.olasToken as Address,
        configHashBytes,
        [this.config.agentId],
        [{ slots: 1, bond: this.config.bondAmount }],
        1,
      ],
    }) as Hex;

    console.error(`[fleet-bootstrap] Service ${index}: creating service through Safe`);
    const result = await executeSafeTxBatch(safe, [
      { to: this.config.serviceManager, value: '0', data: createData },
    ]);

    const receipt = await waitForTransactionReceiptWithRetry(this.publicClient, result.hash as Hex);
    if (receipt.status !== 'success') {
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

    const agentKey = walletPrivateKeyAtIndex(mnemonic, index);

    const safe = await initDeployedSafe({
      rpcUrl: this.config.rpcUrl,
      signerKey: agentKey,
      safeAddress: svc.safe_address!,
    });

    const approveData = encodeFunctionData({
      abi: ERC20_ABI,
      functionName: 'approve',
      args: [this.config.serviceRegistryTokenUtility as Address, this.config.bondAmount],
    }) as Hex;

    const activateData = encodeFunctionData({
      abi: SERVICE_MANAGER_ABI,
      functionName: 'activateRegistration',
      args: [BigInt(serviceId)],
    }) as Hex;

    console.error(`[fleet-bootstrap] Service ${index}: activating service ${serviceId}`);
    const result = await executeSafeTxBatch(safe, [
      { to: this.config.olasToken, value: '0', data: approveData },
      { to: this.config.serviceManager, value: '1', data: activateData },
    ]);

    const receipt = await waitForTransactionReceiptWithRetry(this.publicClient, result.hash as Hex);
    if (receipt.status !== 'success') {
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

    const agentKey = walletPrivateKeyAtIndex(mnemonic, index);

    const safe = await initDeployedSafe({
      rpcUrl: this.config.rpcUrl,
      signerKey: agentKey,
      safeAddress: svc.safe_address!,
    });

    const approveData = encodeFunctionData({
      abi: ERC20_ABI,
      functionName: 'approve',
      args: [this.config.serviceRegistryTokenUtility as Address, this.config.bondAmount],
    }) as Hex;

    const registerData = encodeFunctionData({
      abi: SERVICE_MANAGER_ABI,
      functionName: 'registerAgents',
      args: [BigInt(serviceId), [getAddress(svc.agent_address) as Address], [this.config.agentId]],
    }) as Hex;

    console.error(`[fleet-bootstrap] Service ${index}: registering agent ${svc.agent_address} for service ${serviceId}`);
    const result = await executeSafeTxBatch(safe, [
      { to: this.config.olasToken, value: '0', data: approveData },
      { to: this.config.serviceManager, value: '1', data: registerData },
    ]);

    const receipt = await waitForTransactionReceiptWithRetry(this.publicClient, result.hash as Hex);
    if (receipt.status !== 'success') {
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

    const agentKey = walletPrivateKeyAtIndex(mnemonic, index);
    const safeAddress = svc.safe_address!;

    const safe = await initDeployedSafe({
      rpcUrl: this.config.rpcUrl,
      signerKey: agentKey,
      safeAddress,
    });

    const multisigInitBytes = encodeAbiParameters(
      [{ type: 'address' }],
      [addr(safeAddress)],
    ) as Hex;

    const deployData = encodeFunctionData({
      abi: SERVICE_MANAGER_ABI,
      functionName: 'deploy',
      args: [
        BigInt(serviceId),
        addr(this.config.gnosisSafeSameAddressMultisig),
        multisigInitBytes,
      ],
    }) as Hex;

    console.error(`[fleet-bootstrap] Service ${index}: deploying service ${serviceId}`);
    const result = await executeSafeTxBatch(safe, [
      { to: this.config.serviceManager, value: '0', data: deployData },
    ]);

    const receipt = await waitForTransactionReceiptWithRetry(this.publicClient, result.hash as Hex);
    if (receipt.status !== 'success') {
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

    const agentKey = walletPrivateKeyAtIndex(mnemonic, index);
    const safeAddress = svc.safe_address!;

    const safe = await initDeployedSafe({
      rpcUrl: this.config.rpcUrl,
      signerKey: agentKey,
      safeAddress,
    });

    // Transaction 1: Approve service NFT for staking contract
    const approveData = encodeFunctionData({
      abi: SERVICE_REGISTRY_APPROVE_ABI,
      functionName: 'approve',
      args: [this.config.stakingContract as Address, BigInt(serviceId)],
    }) as Hex;

    console.error(`[fleet-bootstrap] Service ${index}: approving service ${serviceId} NFT for staking`);
    const approveResult = await executeSafeTxBatch(safe, [
      { to: this.config.serviceRegistry, value: '0', data: approveData },
    ]);

    await this.waitForSuccessfulTx(approveResult.hash, `approve service ${serviceId} NFT`);
    console.error(`[fleet-bootstrap] Service ${index}: approve tx confirmed (${approveResult.hash})`);

    // Transaction 2: Stake via executeSafeTxDirect (bypasses Safe SDK gas estimation)
    const stakeData = encodeFunctionData({
      abi: STAKING_ABI,
      functionName: 'stake',
      args: [BigInt(serviceId)],
    }) as Hex;

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

  private async getBondTokenBalance(address: string): Promise<bigint> {
    return this.publicClient.readContract({
      address: this.config.olasToken as Address,
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      args: [getAddress(address) as Address],
    });
  }

  private async getServiceState(serviceId: number): Promise<number> {
    const service = await this.publicClient.readContract({
      address: this.config.serviceRegistry as Address,
      abi: SERVICE_REGISTRY_L2_ABI,
      functionName: 'getService',
      args: [BigInt(serviceId)],
    });
    return Number(service.state);
  }

  private async waitForSuccessfulTx(txHash: string, label: string): Promise<void> {
    const receipt = await waitForTransactionReceiptWithRetry(this.publicClient, txHash as Hex);
    if (receipt.status !== 'success') throw new Error(`${label} tx reverted: ${txHash}`);
  }

  private async stolasPreflightCheck(): Promise<void> {
    if (!this.config.distributorAddress) {
      throw new Error(
        'distributorAddress not configured. Set JINN_TESTNET_STOLAS_DEPLOYMENT or use stakingMode: self-bond.',
      );
    }

    const proxyConfig = await this.publicClient.readContract({
      address: this.config.distributorAddress as Address,
      abi: STOLAS_DISTRIBUTOR_ABI,
      functionName: 'mapStakingProxyConfigs',
      args: [this.config.stakingContract as Address],
    });
    if (proxyConfig === 0n) {
      throw new Error(
        `stOLAS distributor not configured for ${this.config.stakingContract}. ` +
        `Use stakingMode: 'self-bond' or contact the stOLAS team.`,
      );
    }

    const serviceIds = await this.publicClient.readContract({
      address: this.config.stakingContract as Address,
      abi: STOLAS_STAKING_SLOTS_ABI,
      functionName: 'getServiceIds',
    });
    const maxServices = await this.publicClient.readContract({
      address: this.config.stakingContract as Address,
      abi: STOLAS_STAKING_SLOTS_ABI,
      functionName: 'maxNumServices',
    });
    const slotsRemaining = Number(maxServices) - serviceIds.length;

    if (slotsRemaining <= 0) {
      throw new Error(`All ${maxServices} staking slots occupied. Try again later.`);
    }

    console.error(`[fleet-bootstrap] Preflight passed: ${slotsRemaining} slots remaining`);
  }

  private async getStakingState(serviceId: number): Promise<number> {
    return Number(
      await this.publicClient.readContract({
        address: this.config.stakingContract as Address,
        abi: STAKING_ABI,
        functionName: 'getStakingState',
        args: [BigInt(serviceId)],
      }),
    );
  }

  private async parseServiceIdFromReceipt(receipt: TransactionReceipt): Promise<number | null> {
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
        const decoded = decodeEventLog({
          abi: SERVICE_REGISTRY_L2_ABI,
          data: log.data,
          topics: log.topics as [Hex, ...Hex[]],
          strict: false,
        });
        if (decoded.eventName === 'CreateService' && 'serviceId' in decoded.args) {
          return Number(decoded.args.serviceId);
        }
      } catch {
        // Not a matching event
      }
    }
    return null;
  }

  private parseMultisigFromReceipt(receipt: TransactionReceipt): string | null {
    const topic = EVENT_TOPICS.CreateMultisigWithAgents;
    for (const log of receipt.logs) {
      const t0 = log.topics[0];
      if (t0 === topic && log.topics.length >= 3) {
        return getAddress(('0x' + log.topics[2]!.slice(26)) as Hex);
      }
    }
    return null;
  }

  /**
   * Extract `agentId` from an `IdentityRegistry.Registered` log emitted in
   * the receipt. Filters by `(address, topic[0])` first to avoid colliding
   * with any other contract that happens to share the event signature.
   *
   * Returns the agentId as a decimal string (uint256) so it round-trips
   * cleanly through JSON-persisted EarningState.
   */
  private parseAgentIdFromReceipt(
    receipt: TransactionReceipt,
    identityRegistry: string,
  ): string | null {
    const topic = EVENT_TOPICS.Registered;
    const target = identityRegistry.toLowerCase();
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== target) continue;
      if (log.topics[0] !== topic) continue;
      try {
        const decoded = decodeEventLog({
          abi: IDENTITY_REGISTRY_ABI,
          data: log.data,
          topics: log.topics as [Hex, ...Hex[]],
          strict: false,
        });
        if (decoded.eventName === 'Registered' && 'agentId' in decoded.args) {
          return (decoded.args.agentId as bigint).toString();
        }
      } catch {
        // Not a matching event
      }
    }
    return null;
  }
}

/** @deprecated Use FleetBootstrapper */
export const EarningBootstrapper = FleetBootstrapper;
