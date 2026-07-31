/**
 * Fleet bootstrap state machine.
 *
 * Phase 1 (master): generate mnemonic → fund master EOA
 * Phase 2 (per-service): derive agent → stake → deploy mech
 */

import {
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
import { createDefaultServiceState, isOperationalServiceStep } from './types.js';
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
import {
  DEFAULT_FAUCET_LOOP_TIMEOUT_MS,
  computeFaucetDripCap,
  requestTestnetFunding,
} from './faucet.js';
import {
  flattenErrorMessage,
  sleep,
  viemSendTransactionWithRetry,
  waitForContractCode,
  waitForTransactionReceiptWithRetry,
} from '../tx-retry.js';
import { isUnauthorizedAccountError } from '../errors/unauthorized-account.js';
import { formatKnownRevert } from '../adapters/mech/safe-revert.js';
import { createJinnPublicClient, createJinnWalletClient, type JinnOnchainNetwork } from './viem-clients.js';
import { isTransientEthReadError } from '../chain-read-errors.js';
import { nextFleetServiceIndex } from './next-service-index.js';
import { displayFleetServiceIndex } from './fleet-display-index.js';
import { DEFAULT_MASTER_ETH_DAILY_WEI } from './master-gas.js';
import { rpcHostForDisplay } from '../preflight/rpc-network.js';
import {
  detectDeprecatedTestnetSetup,
  migrateDeprecatedTestnetSetup,
} from './testnet-setup-migration.js';
import type { Account } from 'viem/accounts';
import type { StepContext } from './steps/context.js';
import {
  parseAgentIdFromReceipt as parseAgentIdFromReceiptImpl,
  parseMultisigFromReceipt as parseMultisigFromReceiptImpl,
  parseServiceIdFromReceipt as parseServiceIdFromReceiptImpl,
} from './steps/receipt-parsing.js';
import { stepFleetSafePredict as stepFleetSafePredictImpl } from './steps/fleet-safe-predict.js';
import { stepFleetSafeDeploy as stepFleetSafeDeployImpl } from './steps/fleet-safe-deploy.js';
import { stepFleetIdentityRegister as stepFleetIdentityRegisterImpl } from './steps/fleet-identity-register.js';

const addr = (value: string): Address => getAddress(value) as Address;

const SAFE_TOKEN_BOOTSTRAP_MULTIPLIER = 2n;

/**
 * 2× cold-start headroom for master ETH target on a fresh bootstrap.
 *
 * Gas accounting for a single standard-mode service on first run:
 *   ~1.3M gas for the Safe deploy + stake + mech (at 2 gwei ≈ 0.0026 ETH)
 *   + 0.002 ETH Safe seed (sent to the Safe so it can pay mech fees)
 *   ≈ 0.0046 ETH minimum; 2× gives ≈ 0.009–0.010 ETH — the bootstrap
 *   `minEoaGasEth` default.
 *
 * Used by {@link stage1MinMasterEth} to size the Stage 1 master gas budget.
 *
 * Single source of truth: imported by funding-plan.ts.
 */
export const STANDARD_MASTER_BOOTSTRAP_MULTIPLIER = 2n;

/**
 * Self-bond mode needs much more ETH per service than standard mode because
 * the master funds the agent which then pays for: Safe deploy, 5 service
 * registry txs (create, activate, register, deploy, stake), and mech deploy.
 * Roughly 15 txs at varying gas costs. 0.03 ETH per service is a safe
 * estimate. Single source of truth: imported by funding-plan.ts.
 */
export const SELF_BOND_ETH_PER_SERVICE = 30_000_000_000_000_000n; // 0.03 ETH

/**
 * Single source of truth for the master-ETH cold-start funding gate.
 *
 * Both the mutating bootstrapper ({@link FleetBootstrapper.ensureStage1And2})
 * and the read-only funding plan (`planFleetFunding` in funding-plan.ts) route
 * through this helper, so a migration-wiped fleet computes an identical
 * required-ETH gate in both views. Re-implementing the gate inline at either
 * call site is the u34i cross-module invariant-drift hazard — do not do it.
 *
 * Standard-mode gate has three branches:
 *   1. `standardFleetAlreadyComplete` — fleet already has its full target of
 *      operational services and no deprecated-setup migration is pending →
 *      `0n` (nothing to fund).
 *   2. `preStage1` — no fleet identity yet (`fleet_stage === 'none'` or no
 *      fleet state at all) → the Stage 1 gate from {@link stage1MinMasterEth},
 *      which covers the master → agent transfer plus the master's own gas
 *      reserve. See jinn-mono-u34i.
 *   3. otherwise — the Stage 2 master gas budget: `minEoaGasEth` (stake gas)
 *      plus a per-extra-service top-up transfer for services 2..N.
 *
 * Self-bond mode is a flat `SELF_BOND_ETH_PER_SERVICE × targetServices`
 * regardless of stage.
 *
 * @param services         Persisted service states
 * @param minEoaGasEth     Configured minimum EOA gas target (wei)
 * @param pendingSetupMigration  True when a deprecated testnet setup is
 *   detected — suppresses the `standardFleetAlreadyComplete` short-circuit so a
 *   migration-wiped fleet is correctly treated as needing funding. Both call
 *   sites MUST pass this so the bootstrapper gate and the funding-plan view
 *   agree for migration-wiped fleets.
 * @param targetServices   How many services the fleet is aiming for
 * @param stakingMode      `'standard'` (default) or `'self-bond'`
 * @param preStage1        True when fleet identity is not yet provisioned —
 *   selects the Stage 1 gate. The bootstrapper passes `false` here because it
 *   only computes this gate *after* `ensureStage1` succeeds.
 */
export function computeRequiredMasterEth({
  services,
  minEoaGasEth,
  pendingSetupMigration = false,
  targetServices = 1,
  stakingMode = 'standard',
  preStage1 = false,
}: {
  services: Array<{ service_id?: number | null | undefined; step?: string }>;
  minEoaGasEth: bigint;
  pendingSetupMigration?: boolean;
  targetServices?: number;
  stakingMode?: StakingMode;
  preStage1?: boolean;
}): bigint {
  if (stakingMode !== 'standard') {
    return SELF_BOND_ETH_PER_SERVICE * BigInt(targetServices);
  }

  // Reconciled `standardFleetAlreadyComplete` — a single definition replacing
  // the three historic inline variants. Adopts the strictest of them (the
  // FleetBootstrapper variant): the fleet must have at least `targetServices`
  // rows AND every row must be operational AND no deprecated-setup migration
  // may be pending. A migration-wiped fleet (which sets
  // `pendingSetupMigration`) is therefore never short-circuited to `0n`.
  const standardFleetAlreadyComplete =
    services.length >= targetServices &&
    services.every(s => s.step !== undefined && isOperationalServiceStep(s.step)) &&
    !pendingSetupMigration;
  if (standardFleetAlreadyComplete) return 0n;

  if (preStage1) {
    // Stage 1 gate: master → agent transfer (STAGE1_AGENT_ETH) + the master's
    // own gas reserve, plus per-extra-service transfers. See jinn-mono-u34i.
    return stage1MinMasterEth({ minEoaGasEth }, targetServices);
  }

  // Stage 2 master gas budget — covers distributor.stake() (~0.003 ETH at
  // typical 6 gwei Base Sepolia) plus per-extra-service top-up transfers.
  // Service 1 piggybacks on HD-1's Stage 1 funding, so the base term is a
  // single `minEoaGasEth` (not `× 2`). See jinn-mono-u34i.
  return minEoaGasEth + minEoaGasEth * BigInt(Math.max(0, targetServices - 1));
}

/** Master ETH required to FINISH the whole bootstrap from a fresh start (not
 *  just to enter Stage 1). Centralized so the daemon's ensureStage1 gate,
 *  the read-side funding-plan, gather-status, and the panel faucet target
 *  all agree on a single "one-shot fund the operator" number.
 *
 *  Components for a 1-service standard-mode bootstrap:
 *    - STAGE1_AGENT_ETH (0.010 ETH): master → HD-1 fleet-agent transfer.
 *      HD-1 pays for its own Safe deploy + register + setAgentWallet out
 *      of this; leftover covers service 1's Stage 2 work (mech deploy +
 *      rebind). May get a conditional minEoaGasEth top-up from master if
 *      Stage 1's gas eats too much of the original transfer.
 *    - minEoaGasEth × STANDARD_MASTER_BOOTSTRAP_MULTIPLIER (0.010 ETH):
 *      master gas budget across both stages. Real spend (~0.0025 ETH at
 *      typical 6 gwei Base Sepolia) leaves room for ~4× gas-spike margin
 *      plus the conditional HD-1 top-up.
 *    - minEoaGasEth × (targetServices - 1): per-extra-service top-up for
 *      services 2..N. Service 1 piggybacks on HD-1's Stage 1 funding.
 *
 *  Total for N=1: 0.010 + 0.010 = 0.020 ETH.
 *  Total for N=2: 0.025 ETH.
 *  Total for N=3: 0.030 ETH.
 *
 *  This number works ONLY when Stage 2's internal gate is `minEoaGasEth ×
 *  1n` (0.005 ETH) — not the historic `× 2n`. After Stage 1 transfers 0.010
 *  out, master sits at ~0.0099 ETH (0.020 minus transfer minus Stage 1
 *  funding-tx gas). The 0.005 gate clears that with margin; the 0.010 gate
 *  did not. See the Stage 2 gate at ensureStage1And2 line ~484.
 *
 *  Operator may see a "low runway" warning after bootstrap — that's
 *  intentional. The operator-facing 0.020 ETH covers bootstrap completion,
 *  not multi-week post-bootstrap runway. Top-up is a separate concern.
 */
export const STAGE1_AGENT_ETH = 10_000_000_000_000_000n; // 0.01 ETH (moved out of stepFleetSafeDeploy)
export function stage1MinMasterEth(
  config: { minEoaGasEth: bigint },
  targetServices: number = 1,
): bigint {
  const extraServiceTransfers =
    config.minEoaGasEth * BigInt(Math.max(0, targetServices - 1));
  return (
    STAGE1_AGENT_ETH +
    config.minEoaGasEth * STANDARD_MASTER_BOOTSTRAP_MULTIPLIER +
    extraServiceTransfers
  );
}

/** Warn when ETH above the minimum would last fewer than this many days at the daily estimate. */
const MASTER_ETH_RUNWAY_WARN_DAYS = 7n;

/**
 * Safe → ERC-8004 agent NFT binding retry (jinn-mono-h74p).
 *
 * Empirical observation against fresh Base Sepolia 1/1 Safes: the first
 * `IdentityRegistry.setAgentWallet` attempt reverts with a generic
 * "Execution reverted for an unknown reason" — but the same Safe + same
 * agentId + a freshly-signed message a few seconds later succeeds. The
 * race window is likely freshly-deployed-Safe state lag on the public RPC
 * (the simulator can't read the Safe's storage yet in the same block /
 * eventual-consistency between sibling RPC nodes). A short bounded retry
 * makes the operator-visible behaviour deterministic instead of relying on
 * the "daemon exits → operator restarts → resume at safe_binding_pending"
 * accidental safety net (which goes away when jinn-mono-vh74.2 removes the
 * Claude-auth post-bootstrap exit gate).
 *
 * Defaults: 3 attempts × 3 s delay = at most ~6 s of in-process retry budget
 * before falling through to the existing `safe_binding_pending` persisted
 * state. Real (non-transient) failures still surface — just with a slightly
 * higher latency tax for the diagnostic.
 */
const DEFAULT_SAFE_BINDING_MAX_ATTEMPTS = 3;
const DEFAULT_SAFE_BINDING_RETRY_DELAY_MS = 3_000;
const FAUCET_RATE_LIMIT_MAX_RETRIES = 3;
const DEFAULT_FAUCET_RATE_LIMIT_BACKOFF_MS = 15_000;

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
  /** Verbose errors (default: JINN_DEBUG env or false). */
  debug?: boolean;
  /** Estimated master gas per day (wei) for runway warnings. */
  masterEthDailyEstimateWei?: bigint | string;
  /** Optional bootstrap/top-up target override (wei). */
  minEoaGasWei?: string;
  /** Optional Safe ETH target override (wei). */
  minSafeEthWei?: string;
  /**
   * Daemon poll interval. Currently unused by the master-daily-estimate path
   * (the poll-based blend was removed in #288); kept on the options bag so
   * existing callers compile unchanged.
   */
  pollIntervalMs?: number;
  /**
   * Injectable faucet function — defaults to {@link requestTestnetFunding}.
   * Provided in tests to avoid hitting the real CDP endpoint.
   */
  requestFunding?: typeof requestTestnetFunding;
  /** Wall-clock cutoff for the auto-faucet loop. */
  faucetLoopTimeoutMs?: number;
  /** Now-source override for deterministic faucet-loop tests. */
  now?: () => number;
  /**
   * When true, bootstrap may request Base Sepolia faucet drips before returning
   * an awaiting-funding result. `jinn run` disables this so the panel can make
   * testnet funding an explicit operator action.
   */
  autoTestnetFaucet?: boolean;
  /**
   * Max in-process attempts for the ERC-8004 Safe-binding step (jinn-mono-h74p).
   * Defaults to 3. Tests pass small values to keep retry budgets predictable.
   */
  safeBindingMaxAttempts?: number;
  /**
   * Delay between Safe-binding retries (jinn-mono-h74p). Defaults to 3000 ms
   * (~1.5 Base Sepolia blocks). Tests pass 0 to skip the sleep entirely.
   */
  safeBindingRetryDelayMs?: number;
  /**
   * Backoff before retrying a transient CDP faucet 429 (issue #984 work unit 1).
   * Defaults to 15000 ms. Tests pass 0 to skip the sleep entirely.
   */
  faucetRateLimitBackoffMs?: number;
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
  private readonly faucetLoopTimeoutMs: number;
  private readonly now: () => number;
  private readonly autoTestnetFaucet: boolean;
  private readonly safeBindingMaxAttempts: number;
  private readonly safeBindingRetryDelayMs: number;
  private readonly faucetRateLimitBackoffMs: number;

  constructor(options: FleetBootstrapperOptions = {}) {
    this.store = new FleetStateStore(options.earningDir);
    this.chain = options.chain ?? 'base';
    this.env = options.env ?? process.env;
    this.stakingMode = options.stakingMode ?? 'standard';
    this.targetServices = options.targetServices ?? 1;
    this.debug = options.debug ?? isJinnDebug();
    this.requestFunding = options.requestFunding ?? requestTestnetFunding;
    this.faucetLoopTimeoutMs = options.faucetLoopTimeoutMs ?? DEFAULT_FAUCET_LOOP_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
    this.autoTestnetFaucet =
      options.autoTestnetFaucet ?? this.env['JINN_DISABLE_TESTNET_FAUCET'] !== '1';
    this.safeBindingMaxAttempts =
      options.safeBindingMaxAttempts ?? DEFAULT_SAFE_BINDING_MAX_ATTEMPTS;
    this.safeBindingRetryDelayMs =
      options.safeBindingRetryDelayMs ?? DEFAULT_SAFE_BINDING_RETRY_DELAY_MS;
    this.faucetRateLimitBackoffMs =
      options.faucetRateLimitBackoffMs ?? DEFAULT_FAUCET_RATE_LIMIT_BACKOFF_MS;
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
   * Run `bindAgentWalletToSafe` with the freshly-deployed-Safe race retry
   * (jinn-mono-h74p, corrected in jinn-mono-k1ng).
   *
   * The race: against a fresh 1/1 Safe on Base Sepolia, the first
   * setAgentWallet attempt reverts with "Execution reverted for an unknown
   * reason"; the same Safe + same agentId a few seconds later succeeds.
   *
   * The h74p version of the retry only wrapped the call in a try/catch.
   * In production, `bindAgentWalletToSafe` doesn't throw on revert — it
   * returns a `{ ok: false, error }` outcome — so the catch never fired
   * and the retry was dead code. The per-service path "worked" anyway
   * because it persists `safe_binding_pending` and the next bootstrap
   * resumes the bind. Stage 1 had no equivalent safety net, so a single
   * `ok: false` halted bootstrap (the 2026-05-18 canary failure).
   *
   * This wrapper:
   *   - Retries on returned `ok: false` (the way the race actually
   *     manifests in production).
   *   - Also retries on thrown exceptions (defense-in-depth in case viem
   *     error handling changes).
   *   - Returns the final outcome; callers decide whether to throw, mark
   *     pending, or proceed.
   *
   * Single attempt budget: `safeBindingMaxAttempts` × `safeBindingRetryDelayMs`
   * (defaults: 3 × 3 s = ~9 s).
   */
  private async bindAgentWalletWithRetry(
    args: Parameters<typeof bindAgentWalletToSafe>[0],
    label: string,
  ): Promise<Awaited<ReturnType<typeof bindAgentWalletToSafe>>> {
    const maxAttempts = Math.max(1, this.safeBindingMaxAttempts);
    let lastResult: Awaited<ReturnType<typeof bindAgentWalletToSafe>> | undefined;
    let lastThrowError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        lastResult = await bindAgentWalletToSafe(args);
        if (lastResult.ok) return lastResult;
        if (attempt < maxAttempts) {
          console.error(
            `[fleet-bootstrap] ${label}: setAgentWallet attempt ` +
              `${attempt}/${maxAttempts} returned ok=false (${lastResult.error.shortMessage}); ` +
              `retrying in ${this.safeBindingRetryDelayMs}ms...`,
          );
          if (this.safeBindingRetryDelayMs > 0) {
            await sleep(this.safeBindingRetryDelayMs);
          }
        }
      } catch (err) {
        lastThrowError = err;
        if (attempt < maxAttempts) {
          const reason = err instanceof Error ? err.message : String(err);
          console.error(
            `[fleet-bootstrap] ${label}: setAgentWallet attempt ` +
              `${attempt}/${maxAttempts} threw (${reason}); retrying in ` +
              `${this.safeBindingRetryDelayMs}ms...`,
          );
          if (this.safeBindingRetryDelayMs > 0) {
            await sleep(this.safeBindingRetryDelayMs);
          }
        }
      }
    }
    if (lastResult) return lastResult; // final ok:false propagated to caller
    // Only thrown all the way through — no successful response or returned outcome.
    throw lastThrowError instanceof Error
      ? lastThrowError
      : new Error(String(lastThrowError));
  }

  /**
   * Conservative daily master gas (wei). Returns the floor; operators who
   * want a more aggressive estimate can still set `JINN_MASTER_ETH_DAILY_WEI`.
   * See DEFAULT_MASTER_ETH_DAILY_WEI for rationale (#288). The
   * `pollIntervalMs` parameter is vestigial since the poll-based blend was
   * removed; kept so the constructor call site stays unchanged.
   */
  private estimateMasterDailyGasWei(_pollIntervalMs?: number): bigint {
    return DEFAULT_MASTER_ETH_DAILY_WEI;
  }

  /**
   * Snapshot of the current persisted fleet state. Reads only — no chain
   * calls. Used by the operator-app endpoint that lists services with an
   * unbound Safe so the SPA can offer a retry affordance.
   */
  async loadState(): Promise<FleetState> {
    return this.store.load(this.chain);
  }

  /**
   * Re-run the ERC-1271 bind step for a single service whose Safe is not
   * yet bound to its agent NFT. The underlying step (`stepRegisterAgent`)
   * is idempotent: if `agent_id` is already set it skips the mint, and if
   * `safe_bound_to_agent` is already true it skips the bind. So calling
   * this against a fully-bound service is a safe no-op.
   *
   * Operator-facing surface: `POST /v1/setup/agent-binding/retry` from the
   * IdentityCard's "binding pending" chip on Overview.
   */
  async retryAgentBindingFor(serviceIndex: number, password: string): Promise<FleetState> {
    const state = await this.store.load(this.chain);
    const mnemonic = await this.loadExistingMnemonic(state, password);
    return this.stepRegisterAgent(state, mnemonic, serviceIndex);
  }

  /**
   * Stage 1 — Identity (universal). Walks: wallet → predict Safe (from
   * HD-index-1 agent EOA) → ETH funding gate → deploy Safe → mint agentId
   * + setAgentWallet via ERC-1271. Idempotent and re-entrant. Does NOT
   * touch service rows or staking — those belong to Stage 2.
   *
   * Fleet-level fields written:
   *   - fleet_safe_address (after predict)
   *   - fleet_agent_id, fleet_identity_registry, fleet_stage='stage1'
   *     (after mint + bind)
   *
   * Funding gate: requires ETH on the master EOA only (no OLAS). On testnet,
   * the existing CDP faucet loop drains as usual when `autoTestnetFaucet`
   * is enabled.
   *
   * See docs/superpowers/specs/2026-05-13-plug-in-builder-entry-point-design.md §5.1.
   */
  async ensureStage1(password: string): Promise<FleetBootstrapResult> {
    // Legacy keystore migration (same as bootstrap()).
    if (!this.store.hasMnemonicKeystore() && this.store.hasLegacyKeystore()) {
      await this.store.migrateLegacyFiles();
    }

    let state = await this.store.load(this.chain);

    // Short-circuit if Stage 1 is already complete (or beyond).
    if (state.fleet_stage === 'stage1' || state.fleet_stage === 'stage1_and_2') {
      // Even when stage marker says complete, fleet identity may be empty for
      // pre-j07 operators (`stage1_and_2` is set by the migration for
      // services-complete-but-no-agent_id operators). In that case we leave
      // Stage 1 alone — the legacy backfill in main.ts handles those rows
      // and a future ensureStage1 call after backfill will promote.
      return {
        ok: true,
        fleet_state: state,
        message:
          state.fleet_agent_id !== null
            ? `Stage 1 already complete (fleet_agent_id=${state.fleet_agent_id}, fleet_safe=${state.fleet_safe_address}).`
            : 'Stage 1 marker present but fleet identity is empty (legacy operator). Skipping.',
      };
    }

    try {
      state = await this.ensureMasterWallet(state, password);

      // Stage 1 funding gate — ETH only (no OLAS). Stage 1 needs
      // STAGE1_AGENT_ETH (0.01) for the master → agent transfer plus
      // minEoaGasEth (0.005) reserved for the master's own gas to send that
      // transfer. The agent EOA then pays for Safe deploy + ERC-8004 register
      // + setAgentWallet out of the funds it just received.
      // See jinn-mono-u34i: pre-fix this gate was 2×minEoaGasEth (= 0.01 ETH),
      // which equaled the transfer amount and left no gas headroom, so a
      // master holding the gate's minimum would fail eth_estimateGas with
      // "gas required exceeds allowance (0)".
      const requiredMasterEth = stage1MinMasterEth(this.config, this.targetServices);
      const masterAddress = state.master_address!;
      const masterBalance = await this.publicClient.getBalance({
        address: masterAddress as Address,
      });

      if (masterBalance < requiredMasterEth) {
        const shortfall = requiredMasterEth - masterBalance;
        return {
          ok: false,
          fleet_state: state,
          message: `Your master wallet needs more ETH (currently ${formatEther(masterBalance)} ETH, need ${formatEther(shortfall)} ETH more) to complete Stage 1. Please send ETH to: ${masterAddress}`,
          funding: {
            master_address: masterAddress,
            eth_required: shortfall.toString(),
            eth_balance: masterBalance.toString(),
          },
        };
      }

      const mnemonic = await this.loadExistingMnemonic(state, password);

      // Step 1: predict fleet Safe from HD-index-1 agent EOA.
      if (!state.fleet_safe_address) {
        state = await this.stepFleetSafePredict(state, mnemonic);
      }

      // Step 2: deploy fleet Safe if bytecode absent.
      const safeCode = await this.publicClient.getCode({
        address: getAddress(state.fleet_safe_address!) as Address,
      });
      if (safeCode === undefined || safeCode === '0x') {
        state = await this.stepFleetSafeDeploy(state, mnemonic);
      }

      // Step 3: mint agentId + bind Safe via setAgentWallet.
      if (!state.fleet_agent_id) {
        state = await this.stepFleetIdentityRegister(state, mnemonic);
      } else if (state.fleet_stage !== 'stage1' && state.fleet_stage !== 'stage1_and_2') {
        // Identity was minted but stage marker is stale; advance it.
        state = await this.store.patchFleet({ fleet_stage: 'stage1' });
      }

      return {
        ok: true,
        fleet_state: state,
        message: `Stage 1 complete. fleet_agent_id=${state.fleet_agent_id}, fleet_safe=${state.fleet_safe_address}.`,
      };
    } catch (error) {
      const { summary, hint, rawMessage } = formatBootstrapOperatorMessage(error);
      const userMessage = hint !== undefined ? `${summary}\nHint: ${hint}` : summary;
      if (this.debug) {
        console.error(`[fleet-bootstrap] ensureStage1 failed:`, error);
      } else {
        console.error(`[fleet-bootstrap] ${summary}`);
        if (hint !== undefined) console.error(`Hint: ${hint}`);
        if (rawMessage && rawMessage !== summary) {
          console.error(`[fleet-bootstrap] raw: ${rawMessage.split('\n')[0]}`);
        }
      }
      return {
        ok: false,
        fleet_state: state,
        message: userMessage,
        rawErrorMessage: rawMessage,
      };
    }
  }

  /**
   * Stage 1 + Stage 2 — full operator bootstrap. Calls `ensureStage1`
   * first; on success, walks Stage 2 per service. Builder-only users who
   * have completed Stage 1 and call this method later begin Stage 2 from
   * `awaiting_stake` for the first service row (created lazily here).
   *
   * Two-Safe topology in standard mode: `fleet_safe_address !==
   * services[0].safe_address` because Stage 2's `distributor.stake()`
   * creates its own Safe. In self-bond mode the two converge (both
   * derived from HD-index-1).
   *
   * See docs/superpowers/specs/2026-05-13-plug-in-builder-entry-point-design.md §5.1.
   */
  async ensureStage1And2(password: string): Promise<FleetBootstrapResult> {
    // Stage 1 first — establishes fleet identity. Short-circuits if already done.
    const stage1Result = await this.ensureStage1(password);
    if (!stage1Result.ok) {
      return stage1Result;
    }

    // Original bootstrap body — copied verbatim from the previous bootstrap()
    // method, with two changes:
    //   (a) the legacy-keystore migration and master-wallet-ensure are no-ops
    //       because ensureStage1 already ran them.
    //   (b) at the end, if any service reached `complete`/`safe_binding_pending`
    //       we advance `fleet_stage` to `'stage1_and_2'`.
    let state = stage1Result.fleet_state;

    try {
      // Phase 1b: Check master funding for the full operator path.
      const masterAddress = state.master_address!;
      let masterBalance = await this.publicClient.getBalance({ address: masterAddress as Address });
      // On re-runs, include ETH already held by funded agents/safes in the
      // total for self-bond mode.
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
      const pendingSetupMigration = detectDeprecatedTestnetSetup({
        state,
        chain: this.chain,
        stakingMode: this.stakingMode,
        currentStakingContract: this.config.stakingContract,
      }).services.length > 0;
      // Single source of truth: the master-ETH gate is computed by
      // `computeRequiredMasterEth` (defined above), the same helper the
      // read-only `planFleetFunding` view routes through. Re-deriving it inline
      // here is the u34i cross-module invariant-drift hazard. `ensureStage1And2`
      // only reaches this point AFTER `ensureStage1` has succeeded, so the
      // fleet is always past Stage 1 — `preStage1` is `false`.
      const requiredMasterEth = computeRequiredMasterEth({
        services: state.services,
        minEoaGasEth: this.config.minEoaGasEth,
        pendingSetupMigration,
        targetServices: this.targetServices,
        stakingMode: this.stakingMode,
        preStage1: false,
      });
      const autoFaucetEnabled = this.autoTestnetFaucet;

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
      // CDP's drip is tiny (~0.0001 ETH) vs a 0.005-0.010 ETH bootstrap floor —
      // a single drip is never enough, and a fixed cap of 60 was below the
      // fresh-fleet target (0.010 ETH on first bootstrap), so onboarding could
      // never auto-complete. The cap is derived from the actual gap, while a
      // wall-clock timeout remains the real runaway safety rail.
      if (systemEth < requiredMasterEth && this.chain === 'base-sepolia' && autoFaucetEnabled) {
        const maxFaucetIters = computeFaucetDripCap({
          targetWei: requiredMasterEth,
          balanceWei: systemEth,
        });
        const deadline = this.now() + this.faucetLoopTimeoutMs;
        // requestFunding returns synchronously with a txHash and there is no
        // on-chain confirmation to wait for between drips, so the happy path
        // carries NO fixed inter-drip sleep (issue #984 work unit 1). A transient
        // CDP 429 backs off and retries within the session instead of ending it
        // on the first throttle; the wall-clock deadline stays the safety rail.
        let rateLimitRetries = 0;
        console.error(
          `[fleet-bootstrap] Master has ${formatEther(systemEth)} ETH; need ${formatEther(requiredMasterEth)} ETH. ` +
          `Draining CDP faucet on ${this.chain} via ${rpcHostForDisplay(this.config.rpcUrl)} ` +
          `(each drip ≈ 0.0001 ETH, up to ${maxFaucetIters} drips or ${Math.round(this.faucetLoopTimeoutMs / 1000)}s, whichever comes first).`,
        );
        for (let i = 0; i < maxFaucetIters; i++) {
          if (this.now() >= deadline) {
            console.error(
              `[fleet-bootstrap] Faucet drip loop hit ${Math.round(this.faucetLoopTimeoutMs / 1000)}s timeout after ${i} drips ` +
              `(master=${formatEther(masterBalance)} ETH; target=${formatEther(requiredMasterEth)} ETH). ` +
              'Retry later or fund manually.',
            );
            break;
          }
          const faucetResult = await this.requestFunding(masterAddress, 'base-sepolia');
          if (!faucetResult.ok) {
            if (faucetResult.rateLimited && rateLimitRetries < FAUCET_RATE_LIMIT_MAX_RETRIES) {
              rateLimitRetries++;
              console.error(
                `[fleet-bootstrap] CDP faucet rate-limited after ${i} drips: ${faucetResult.reason}. ` +
                `Backing off (retry ${rateLimitRetries}/${FAUCET_RATE_LIMIT_MAX_RETRIES}).`,
              );
              await new Promise(r => setTimeout(r, this.faucetRateLimitBackoffMs));
              continue;
            }
            if (faucetResult.rateLimited) {
              console.error(`[fleet-bootstrap] CDP faucet rate-limited after ${i} drips: ${faucetResult.reason}`);
            } else {
              console.error(`[fleet-bootstrap] CDP faucet error after ${i} drips: ${faucetResult.reason}`);
            }
            break;
          }
          // Balance is no longer read once per drip — only every 5th drip and on
          // the final iteration (issue #984 work unit 1). Target/early-exit is
          // only checked on iterations where balance was just refreshed.
          if ((i + 1) % 5 !== 0 && i !== maxFaucetIters - 1) {
            continue;
          }
          const refreshed = await refreshSystemEth();
          systemEth = refreshed.system;
          masterBalance = refreshed.master;
          console.error(
            `[fleet-bootstrap] drip ${i + 1}/${maxFaucetIters} · chain=${this.chain} · rpc=${rpcHostForDisplay(this.config.rpcUrl)} · ` +
            `master=${formatEther(masterBalance)} ETH · target=${formatEther(requiredMasterEth)} ETH`,
          );
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
      const mnemonic = await this.loadExistingMnemonic(state, password);

      if (pendingSetupMigration) {
        const masterAccount = deriveMasterSigner(mnemonic);
        const masterWallet = createJinnWalletClient(this.config.rpcUrl, this.chain, masterAccount);
        const migration = await migrateDeprecatedTestnetSetup({
          stateStore: this.store,
          state,
          chain: this.chain,
          stakingMode: this.stakingMode,
          currentStakingContract: this.config.stakingContract,
          distributorAddress: this.config.distributorAddress,
          publicClient: this.publicClient,
          masterWallet,
        });
        state = migration.state;
      }

      state = await this.reconcileFleetWithChain(state, mnemonic);

      // Resume all services. For incomplete services, this picks up where they
      // left off. For "complete" services in standard mode, this also runs the
      // eviction recovery check (since on-chain state may have changed since
      // the daemon was last running — e.g., evicted due to inactivity).
      for (const svc of state.services) {
        if (!isOperationalServiceStep(svc.step)) {
          console.error(`[fleet-bootstrap] Resuming service ${svc.index} at step '${svc.step}'`);
        } else if (svc.step === 'safe_binding_pending') {
          console.error(`[fleet-bootstrap] Resuming service ${svc.index} at step 'safe_binding_pending'`);
        }
        state = await this.resumeService(state, mnemonic, svc.index);
      }

      // Then create new services if needed
      const completedCount = state.services.filter(s => isOperationalServiceStep(s.step)).length;
      const needed = this.targetServices - completedCount;

      if (needed > 0) {
        console.error(`[fleet-bootstrap] ${completedCount}/${this.targetServices} services complete, bootstrapping ${needed} more`);
      }

      for (let i = 0; i < needed; i++) {
        const nextIndex = nextFleetServiceIndex(state.services);
        state = await this.bootstrapService(state, mnemonic, nextIndex);
      }

      // Advance fleet_stage to 'stage1_and_2' if any service is operational.
      const anyOperationalAfter = state.services.some(s => isOperationalServiceStep(s.step));
      if (anyOperationalAfter && state.fleet_stage !== 'stage1_and_2') {
        state = await this.store.patchFleet({ fleet_stage: 'stage1_and_2' });
      }

      return {
        ok: true,
        fleet_state: state,
        message: `Fleet bootstrap complete. ${state.services.filter(s => isOperationalServiceStep(s.step)).length}/${this.targetServices} services running.`,
      };
    } catch (error) {
      const { summary, hint, rawMessage, category } = formatBootstrapOperatorMessage(error);
      const userMessage = hint !== undefined ? `${summary}\nHint: ${hint}` : summary;
      if (this.debug) {
        console.error(`[fleet-bootstrap] Bootstrap failed:`, error);
      } else {
        console.error(`[fleet-bootstrap] ${summary}`);
        if (hint !== undefined) console.error(`Hint: ${hint}`);
        // Always log the raw cause once on stderr, even outside JINN_DEBUG.
        // The summary may misclassify; the raw line lets operators and
        // maintainers verify the diagnosis without flipping debug mode.
        if (rawMessage && rawMessage !== summary) {
          console.error(`[fleet-bootstrap] raw: ${rawMessage.split('\n')[0]}`);
        }
      }
      // Extract a tx hash embedded in the error message by the on-chain revert
      // paths (format: "...tx failed for service N: 0x<hash>" or
      // "...tx reverted: 0x<hash>"). Surfaced in the fatal envelope so the SPA
      // can render a block-explorer link. jinn-mono-hjex reviewer fix.
      const txHashMatch = /(0x[a-fA-F0-9]{64})/.exec(rawMessage);
      const txHash = txHashMatch ? txHashMatch[1] : null;
      return {
        ok: false,
        fleet_state: state,
        message: userMessage,
        rawErrorMessage: rawMessage,
        // Preserve the structured category so the error envelope in main.ts
        // can surface it in `details.category` for SPA consumers. jinn-mono-hjex.6
        ...(category !== undefined ? { errorCategory: category } : {}),
        ...(txHash !== null ? { txHash } : {}),
      };
    }
  }

  /**
   * Back-compat alias. Existing call sites in `client/src/cli/commands/bootstrap.ts`
   * and `client/src/cli/commands/fleet-scale.ts` continue to call `bootstrap()`;
   * forwarding to `ensureStage1And2` preserves their semantics without churn.
   */
  async bootstrap(password: string): Promise<FleetBootstrapResult> {
    return this.ensureStage1And2(password);
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
    // `jinn init` writes the mnemonic keystore but does not patch earning_state.json.
    // Hydrate master_address from the existing keystore instead of generating a new wallet.
    if (this.store.hasMnemonicKeystore()) {
      const mnemonic = await this.loadExistingMnemonic(state, password);
      if (state.master_address) {
        return state;
      }
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

  private async loadExistingMnemonic(
    state: FleetState,
    password: string,
  ): Promise<string> {
    try {
      return await decryptMnemonic(await this.store.loadMnemonicKeystore(), password);
    } catch (err) {
      if (state.master_address || state.services.length > 0) {
        throw new Error(
          `Existing mnemonic keystore could not be decrypted: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      const archivePath = await this.store.archiveMnemonicKeystore('invalid-before-wallet-init');
      console.error(
        '[fleet-bootstrap] Existing mnemonic keystore was not usable for a fresh fleet; ' +
          `archived it at ${archivePath ?? '(unknown path)'} and generating a new test wallet.`,
      );
      const freshMnemonic = generateMnemonic();
      const encrypted = await encryptMnemonic(freshMnemonic, password);
      await this.store.saveMnemonicKeystore(encrypted);
      return freshMnemonic;
    }
  }

  // ── Stage 1: fleet-level identity steps (nghf) ────────────────────────

  private async stepFleetSafePredict(state: FleetState, mnemonic: string): Promise<FleetState> {
    return stepFleetSafePredictImpl(this.stepContext(), state, mnemonic);
  }

  private async stepFleetSafeDeploy(state: FleetState, mnemonic: string): Promise<FleetState> {
    return stepFleetSafeDeployImpl(this.stepContext(), state, mnemonic);
  }

  private async stepFleetIdentityRegister(state: FleetState, mnemonic: string): Promise<FleetState> {
    return stepFleetIdentityRegisterImpl(this.stepContext(), state, mnemonic);
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
    let next = state;
    for (const svc of state.services) {
      const signals = await this.gatherChainSignals(svc);
      const ctx = {
        stakingContract: this.stakingAddressForService(svc),
        preserveExistingSetup: this.shouldPreserveExistingSetup(svc),
      };
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
    const stakingAddr = this.stakingAddressForService(svc);
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

    if (
      this.stakingMode === 'standard' &&
      svc.error &&
      this.shouldPreserveExistingSetup(svc)
    ) {
      return state;
    }

    // Eviction recovery: even for "complete" services, check if on-chain shows
    // evicted (state=2). If so, unstake and reset to awaiting_stake so the
    // bootstrap restakes fresh. Only applies to standard mode (distributor-managed).
    if (
      this.stakingMode === 'standard' &&
      svc.service_id !== null &&
      (isOperationalServiceStep(svc.step) || svc.step === 'mech_deployed' || svc.step === 'staked')
    ) {
      let onChainState: number;
      try {
        onChainState = await this.getStakingState(svc.service_id, svc.staking_address);
      } catch (error) {
        if (this.shouldPreserveExistingSetup(svc)) {
          console.error(
            `[jinn-earning] Service ${index}: existing setup staking state could not be checked automatically. Leaving local service id and wallet fields unchanged for recovery/support.`,
          );
          return state;
        }
        throw error;
      }
      if (onChainState === 2) {
        // Do NOT eagerly reStake at startup. Re-staking is orthogonal to the
        // protocol loop and to earning (OLAS staking rewards accrue from
        // delivered-work activity counts, not from re-stake liveness), and an inline reStake
        // here broadcasts from the agent EOA during boot — contending with
        // other agent-EOA work that runs in the same window (e.g. a launch's
        // IdentityRegistry.setMetadata, which then reverts and strands the
        // launch at `launching`). #773 removed the inline reStake from the
        // mech-adapter solve path with exactly this reasoning ("staking is
        // orthogonal to the loop — re-staking is handled out-of-band by the
        // background EvictionLoop"); this completes #773 for the startup-resume
        // path it missed. The throttled EvictionLoop (#917) restakes on its own
        // cadence when enabled; when staking is intentionally dropped
        // (evictionCheckIntervalMs=0) the service simply stays evicted, which
        // does not affect earning (#789).
        console.log(
          `[jinn-earning] Service ${svc.service_id} (fleet index ${index}) is evicted on-chain; ` +
          `NOT reStaking inline at startup — deferring to the background EvictionLoop ` +
          `(staking is orthogonal to earning; #773/#789/#917). Daemon launch continues.`,
        );
      }
    }

    if (isOperationalServiceStep(svc.step)) {
      // Identity binding retry: services at `safe_binding_pending` are already
      // staked and operational, but their ERC-8004 Safe→agentId link still
      // needs to be written. Older `complete` services with safe_bound=false
      // are treated the same way so legacy operators self-heal on resume.
      if (svc.agent_id && svc.safe_address && svc.safe_bound_to_agent !== true) {
        console.error(
          `[fleet-bootstrap] Service ${index}: agent_id=${svc.agent_id} with unbound Safe; running binding step.`,
        );
        state = await this.stepRegisterAgent(state, mnemonic, index);
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

    if (
      updatedSvc.step === 'mech_deployed' ||
      updatedSvc.step === 'agent_registered' ||
      updatedSvc.step === 'safe_binding_pending'
    ) {
      state = await this.stepRegisterAgent(state, mnemonic, index);
      updatedSvc = (await this.store.load(this.chain)).services.find(s => s.index === index)!;
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

    if (svc.step === 'mech_deployed' || svc.step === 'agent_registered' || svc.step === 'safe_binding_pending') {
      state = await this.stepRegisterAgent(state, mnemonic, index);
      svc = (await this.store.load(this.chain)).services.find(s => s.index === index)!;
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
      const stakingState = await this.getStakingState(svc.service_id, svc.staking_address);
      if (stakingState === 1) {
        console.error(`[fleet-bootstrap] Service ${index} already staked, skipping`);
        return this.store.updateService(index, { step: 'staked' });
      }
    }

    // Pre-stake precondition: if migration cleared service_id but kept agent_address,
    // check the EOA is not already registered on-chain as an agent instance. If it is,
    // calling stake() again would revert with AgentInstanceRegistered (selector 0x631695bd)
    // and there is nothing useful the operator can do without rotating the agent EOA.
    // Fail fast with a typed error instead of letting the contract revert.
    //
    // ServiceRegistryL2 exposes the `mapAgentInstanceOperators(address) → address` mapping:
    // it returns the operator address that registered the given agent instance, or the
    // zero address when no operator has bound that instance. A non-zero return means the
    // EOA is already bound. (There is no `mapAgentInstances(address) → uint256` getter on
    // the deployed registry — an earlier draft of this guard referenced one and was a
    // permanent no-op.)
    if (svc.agent_address && svc.service_id === null && this.config.serviceRegistry) {
      let alreadyBound = false;
      try {
        const boundOperator = (await this.publicClient.readContract({
          address: getAddress(this.config.serviceRegistry) as Address,
          abi: SERVICE_REGISTRY_L2_ABI,
          functionName: 'mapAgentInstanceOperators',
          args: [getAddress(svc.agent_address) as Address],
        })) as Address;
        alreadyBound = boundOperator !== '0x0000000000000000000000000000000000000000';
      } catch {
        // Registry read failure is non-fatal — proceed and let stake() surface
        // the error if the agent really is bound.
      }
      if (alreadyBound) {
        throw new Error(
          `agent_already_bound: agent EOA ${svc.agent_address} is already registered as an agent instance on-chain. ` +
          `The previous setup retirement may have been incomplete. ` +
          `Contact support or rotate the agent EOA to continue.`,
        );
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
    const stakingAddress = this.stakingAddressForService(svc);
    const di = displayFleetServiceIndex(svc);

    // Delegate to the standalone exported helper (shared with EvictionLoop /
    // the dashboard "Re-stake now" CTA). This eliminates the duplicate
    // implementation (jinn-mono-hjex.3).
    await recoverEvictedService({
      serviceDisplayIndex: di,
      serviceId,
      stakingAddress: stakingAddress,
      distributorAddress: this.config.distributorAddress,
      rpcUrl: this.config.rpcUrl,
      chain: this.chain,
      mnemonic,
    });

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

    const payload = encodeAbiParameters([{ type: 'uint256' }], [this.config.mechRequestPrice]);

    const createData = encodeFunctionData({
      abi: MECH_MARKETPLACE_CREATE_ABI,
      functionName: 'create',
      args: [BigInt(serviceId), this.config.mechFactory as Address, payload],
    }) as Hex;

    console.error(`[fleet-bootstrap] Service ${index}: deploying mech`);
    const result = await executeSafeTxDirect({
      rpcUrl: this.config.rpcUrl,
      signerKey: agentKey,
      safeAddress,
      to: this.config.mechMarketplace,
      data: createData,
    });

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
   * The bind is a discrete operational state (`safe_binding_pending`) because
   * the service is already staked and runnable once the mint exists. A failed
   * binding should be visible and resumable, but should not block the daemon
   * from reaching the running dashboard.
   */
  private async stepRegisterAgent(
    state: FleetState,
    mnemonic: string,
    index: number,
  ): Promise<FleetState> {
    void state;
    let svc = (await this.store.load(this.chain)).services.find(s => s.index === index);
    if (!svc) throw new Error(`Service ${index} not found in state`);

    const fleetSnapshot = await this.store.load(this.chain);

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

    // ── Sub-step A: mint NFT (skip if agent_id is already set OR fleet identity exists). ─
    let agentId: string;
    if (svc.agent_id) {
      console.error(
        `[fleet-bootstrap] Service ${index}: ERC-8004 agent already registered ` +
        `(agentId=${svc.agent_id}); skipping mint.`,
      );
      agentId = svc.agent_id;
      svc = await this.firstServiceUpdate(index, {
        identity_registry_address: svc.identity_registry_address ?? getAddress(identityRegistry),
        step: svc.step === 'safe_binding_pending' ? 'safe_binding_pending' : 'agent_registered',
      });
    } else if (fleetSnapshot.fleet_agent_id) {
      // nghf: reuse the fleet-level agentId minted by ensureStage1 instead of
      // minting a second one. This collapses the "one agentId per user"
      // invariant in spec §5.1 for the standard-mode two-Safe topology.
      console.error(
        `[fleet-bootstrap] Service ${index}: reusing fleet agentId=${fleetSnapshot.fleet_agent_id} ` +
        `(no second mint needed).`,
      );
      agentId = fleetSnapshot.fleet_agent_id;
      svc = await this.firstServiceUpdate(index, {
        agent_id: fleetSnapshot.fleet_agent_id,
        agent_uri: '',
        identity_registry_address:
          fleetSnapshot.fleet_identity_registry ?? getAddress(identityRegistry),
        agent_registered_tx: null,
        step: 'agent_registered',
        error: null,
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
        error: null,
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
      svc = await this.firstServiceUpdate(index, {
        step: 'complete',
        error: null,
      });
    } else if (!svc.safe_address) {
      console.error(
        `[fleet-bootstrap] Service ${index}: no safe_address — cannot bind agent NFT ` +
        `(agentId=${agentId}). Bootstrap will leave safe_bound_to_agent=false; this is ` +
        `unexpected for the standard staking topology.`,
      );
      svc = await this.firstServiceUpdate(index, {
        step: 'safe_binding_pending',
        error: 'safe_address_missing_for_agent_wallet_binding',
      });
    } else {
      const safeAddress = svc.safe_address;
      console.error(
        `[fleet-bootstrap] Service ${index}: binding Safe ${safeAddress} to ` +
        `agentId=${agentId} via setAgentWallet (ERC-1271).`,
      );
      svc = await this.firstServiceUpdate(index, {
        step: 'safe_binding_pending',
        error: null,
      });
      // Unified retry policy (jinn-mono-k1ng — supersedes h74p's throw-only
      // retry): retry on `ok: false` and on thrown exceptions. The h74p
      // version only caught throws, but `bindAgentWalletToSafe` returns
      // `ok: false` for the documented freshly-deployed-Safe revert race —
      // so the retry was dead code under real RPC. Per-service "worked"
      // anyway because the next bootstrap resumes from `safe_binding_pending`;
      // k1ng makes the in-process retry actually do its job so we don't
      // depend on the operator restarting the daemon.
      let bindResult: Awaited<ReturnType<typeof bindAgentWalletToSafe>> | undefined;
      let lastBindError: unknown;
      try {
        bindResult = await this.bindAgentWalletWithRetry(
          {
            identityRegistryAddress: addr(identityRegistry),
            agentId: BigInt(agentId),
            safeAddress: addr(safeAddress),
            agentEoaAccount: agentSigner,
            agentEoaWalletClient: agentWallet,
            publicClient: this.publicClient,
            chainId: this.config.chainId,
          },
          `Service ${index}`,
        );
      } catch (err) {
        lastBindError = err;
      }
      if (bindResult?.ok === true) {
        console.error(
          `[fleet-bootstrap] Service ${index}: setAgentWallet succeeded ` +
          `(tx=${bindResult.txHash}, safe=${safeAddress}).`,
        );
        svc = await this.firstServiceUpdate(index, {
          safe_bound_to_agent: true,
          step: 'complete',
          error: null,
          error_revert_reason: null,
          error_short_message: null,
        });
      } else if (bindResult && !bindResult.ok) {
        const bindErr = bindResult.error;
        console.error(
          `[fleet-bootstrap] Service ${index}: setAgentWallet failed after retries; ` +
          `continuing with safe_bound_to_agent=false (${bindErr.shortMessage}` +
          `${bindErr.revertReason ? `, revert: ${bindErr.revertReason}` : ''}).`,
        );
        svc = await this.firstServiceUpdate(index, {
          safe_bound_to_agent: false,
          step: 'safe_binding_pending',
          error: `safe_binding_failed: ${bindErr.shortMessage}`,
          error_revert_reason: bindErr.revertReason,
          error_short_message: bindErr.shortMessage,
        });
      } else {
        const reason =
          lastBindError instanceof Error ? lastBindError.message : String(lastBindError);
        console.error(
          `[fleet-bootstrap] Service ${index}: setAgentWallet threw on every attempt; ` +
          `continuing with safe_bound_to_agent=false (${reason}).`,
        );
        svc = await this.firstServiceUpdate(index, {
          safe_bound_to_agent: false,
          step: 'safe_binding_pending',
          error: `safe_binding_failed: ${reason}`,
          error_revert_reason: null,
          error_short_message: null,
        });
      }
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

      try {
        await waitForContractCode(this.publicClient, getAddress(safeAddress) as Address);
      } catch {
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

  // KNOWN LIMITATION (Base mainnet, since block 48626242 / 2026-07-14): the
  // same-address multisig implementation this step passes to
  // ServiceManager.deploy was de-whitelisted by OLAS governance, so the deploy
  // tx reverts UnauthorizedMultisig on chainId 8453. There is no whitelisted
  // same-address replacement; the whitelisted implementations create a new
  // Safe at deploy, which conflicts with this flow's premise that the
  // pre-deployed operator Safe becomes the service multisig. See the comment
  // on BASE_CONFIG.gnosisSafeSameAddressMultisig in contracts.ts. Base
  // Sepolia is unaffected.
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

  /**
   * Fresh dependency bag for an extracted step. Rebuilt on every call so a
   * spy installed after construction is honoured; the spied helper arrows
   * dispatch through `this` at call time (see plan Binding rule).
   */
  private stepContext(): StepContext {
    return {
      store: this.store,
      config: this.config,
      publicClient: this.publicClient,
      chain: this.chain,
      stakingMode: this.stakingMode,
      targetServices: this.targetServices,
      debug: this.debug,
      env: this.env,
      safeBindingMaxAttempts: this.safeBindingMaxAttempts,
      safeBindingRetryDelayMs: this.safeBindingRetryDelayMs,
      bindAgentWalletWithRetry: (args, label) => this.bindAgentWalletWithRetry(args, label),
      getServiceState: (serviceId) => this.getServiceState(serviceId),
      waitForSuccessfulTx: (txHash, label) => this.waitForSuccessfulTx(txHash, label),
      firstServiceUpdate: (index, patch) => this.firstServiceUpdate(index, patch),
      stakingAddressForService: (svc) => this.stakingAddressForService(svc),
      shouldPreserveExistingSetup: (svc) => this.shouldPreserveExistingSetup(svc),
      parseServiceIdFromReceipt: (receipt) => this.parseServiceIdFromReceipt(receipt),
      parseMultisigFromReceipt: (receipt) => this.parseMultisigFromReceipt(receipt),
      getStakingState: (serviceId, stakingAddress) => this.getStakingState(serviceId, stakingAddress),
      getBondTokenBalance: (address) => this.getBondTokenBalance(address),
      parseAgentIdFromReceipt: (receipt, identityRegistry) =>
        this.parseAgentIdFromReceipt(receipt, identityRegistry),
      stolasPreflightCheck: () => this.stolasPreflightCheck(),
      sweepAbandonedSafeForService: (state, mnemonic, serviceIndex, abandonedSafeAddress) =>
        this.sweepAbandonedSafeForService(state, mnemonic, serviceIndex, abandonedSafeAddress),
    };
  }

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

  private stakingAddressForService(svc: ServiceState): Address {
    return addr(svc.staking_address ?? this.config.stakingContract);
  }

  private shouldPreserveExistingSetup(svc: ServiceState): boolean {
    if (this.stakingMode !== 'standard' || !svc.staking_address) return false;
    try {
      return getAddress(svc.staking_address) !== getAddress(this.config.stakingContract);
    } catch {
      return true;
    }
  }

  private async getStakingState(serviceId: number, stakingAddress?: string | null): Promise<number> {
    return Number(
      await this.publicClient.readContract({
        address: addr(stakingAddress ?? this.config.stakingContract),
        abi: STAKING_ABI,
        functionName: 'getStakingState',
        args: [BigInt(serviceId)],
      }),
    );
  }

  private async parseServiceIdFromReceipt(receipt: TransactionReceipt): Promise<number | null> {
    return parseServiceIdFromReceiptImpl(receipt, this.config.serviceRegistry);
  }

  private parseMultisigFromReceipt(receipt: TransactionReceipt): string | null {
    return parseMultisigFromReceiptImpl(receipt);
  }

  private parseAgentIdFromReceipt(
    receipt: TransactionReceipt,
    identityRegistry: string,
  ): string | null {
    return parseAgentIdFromReceiptImpl(receipt, identityRegistry);
  }
}

/** @deprecated Use FleetBootstrapper */
export const EarningBootstrapper = FleetBootstrapper;

// ---------------------------------------------------------------------------
// Standalone recovery helper — callable from the eviction loop (hjex.3)
// ---------------------------------------------------------------------------

export interface RecoverEvictedServiceOptions {
  /** Display index of the service (used only for log messages). */
  serviceDisplayIndex: number;
  serviceId: number;
  stakingAddress: string;
  distributorAddress: string;
  rpcUrl: string;
  chain: JinnOnchainNetwork;
  mnemonic: string;
}

/**
 * Inspect a mined reStake receipt and log the correct outcome (#916).
 *
 * Pure + I/O-free so it can be unit-tested without a chain client. On a
 * `success` receipt it logs `reStake confirmed` at log level. On a `reverted`
 * receipt it logs `reStake reverted` at debug level (a benign substrate event —
 * the NotEnoughTimeStaked window / stale-RPC race; staking is non-load-bearing,
 * DR-2026-06-04 / #1060) with the decoded reason if the caller could obtain one,
 * and still throws so the recovery attempt re-queues (#916 control flow intact).
 */
export function handleReStakeReceipt(args: {
  receipt: { status: 'success' | 'reverted' };
  serviceDisplayIndex: number;
  reStakeHash: Hex;
  revertReason?: string;
}): void {
  const { receipt, serviceDisplayIndex, reStakeHash, revertReason } = args;
  if (receipt.status === 'success') {
    console.log(
      `[eviction-recovery] Service ${serviceDisplayIndex}: reStake confirmed (tx: ${reStakeHash})`,
    );
    return;
  }
  const msg = `[eviction-recovery] Service ${serviceDisplayIndex}: reStake reverted (tx: ${reStakeHash}, reason: ${revertReason ?? 'unavailable'})`;
  console.debug(msg);
  throw new Error(msg);
}

/**
 * Re-stake an evicted service by calling `distributor.reStake(stakingProxy, serviceId)`.
 *
 * Extracted from `FleetBootstrapper.recoverEvictedService` so it can be called
 * from the in-process `EvictionLoop` without requiring a full bootstrapper
 * context (jinn-mono-hjex.3).
 *
 * The caller is responsible for advancing the local service step back to
 * `mech_deployed` after this returns (just like the bootstrapper resume path does).
 */
export async function recoverEvictedService(
  opts: RecoverEvictedServiceOptions,
): Promise<void> {
  const {
    serviceDisplayIndex,
    serviceId,
    stakingAddress,
    distributorAddress,
    rpcUrl,
    chain,
    mnemonic,
  } = opts;

  const masterAccount = deriveMasterSigner(mnemonic);
  const publicClient = createJinnPublicClient(rpcUrl, chain);
  const masterWallet = createJinnWalletClient(rpcUrl, chain, masterAccount);

  const reStakeData = encodeFunctionData({
    abi: STOLAS_DISTRIBUTOR_ABI,
    functionName: 'reStake',
    args: [addr(stakingAddress), BigInt(serviceId)],
  }) as Hex;

  console.debug(
    `[eviction-recovery] Service ${serviceDisplayIndex}: calling distributor.reStake() for evicted service ${serviceId}`,
  );
  let reStakeHash: Hex;
  try {
    reStakeHash = await viemSendTransactionWithRetry(masterWallet, publicClient, {
      account: masterAccount as Account,
      to: addr(distributorAddress),
      data: reStakeData,
      gas: 1_500_000n,
    });
  } catch (err) {
    const message = flattenErrorMessage(err);
    if (isUnauthorizedAccountError(message)) {
      throw new Error(
        `Service ${serviceDisplayIndex} (service_id ${serviceId}) is evicted on the staking proxy, but master EOA ` +
        `${masterAccount.address} is not authorized to reStake it. ` +
        `Verify JINN_EARNING_DIR and JINN_PASSWORD derive the original master EOA for this service. ` +
        `reStake revert: ${message}`,
      );
    }
    throw err;
  }
  const receipt = await waitForTransactionReceiptWithRetry(publicClient, reStakeHash);
  let revertReason: string | undefined;
  if (receipt.status !== 'success') {
    // Best-effort: replay the call at the mined block to decode the revert.
    try {
      await publicClient.call({
        account: masterAccount,
        to: addr(distributorAddress),
        data: reStakeData,
        blockNumber: receipt.blockNumber,
      });
    } catch (err) {
      revertReason = formatKnownRevert(err) ?? flattenErrorMessage(err);
    }
  }
  handleReStakeReceipt({ receipt, serviceDisplayIndex, reStakeHash, revertReason });
}
