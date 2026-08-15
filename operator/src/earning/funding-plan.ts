/**
 * Read-only funding plan for the fleet bootstrap state machine.
 *
 * `jinn fund-requirements` (and other inspection callers) need to learn
 * "what funding gates are blocking us right now?" without mutating any
 * state. Specifically: never write to the fleet store, never request
 * faucet funds, never send any chain transactions, never advance the
 * bootstrap state machine.
 *
 * The mutating counterpart lives in `FleetBootstrapper.bootstrap()` and
 * is invoked by `jinn bootstrap`/`jinn run`.
 *
 * See: docs/reviews/2026-04-28-operator-experience-audit.md (W1).
 */
import { getAddress, type Address, type PublicClient } from 'viem';
import {
  type ChainConfig,
  applyChainGasOverrides,
  getChainConfig,
} from './contracts.js';
import { FleetStateStore } from './store.js';
import { computeRequiredMasterEth } from './bootstrap.js';
import { detectDeprecatedTestnetSetup } from './testnet-setup-migration.js';
import { decryptMnemonic, deriveMasterAddress } from './wallet.js';
import { isOperationalServiceStep, type FleetState, type FundingRequirement, type StakingMode } from './types.js';
import { createJinnPublicClient, type JinnOnchainNetwork } from './viem-clients.js';

export interface FundingPlanOptions {
  earningDir?: string;
  chain?: JinnOnchainNetwork;
  rpcUrl?: string;
  stakingMode?: StakingMode;
  targetServices?: number;
  testnetL2DeploymentPath?: string;
  testnetL2TokenDeploymentPath?: string;
  testnetMechDeploymentPath?: string;
  testnetStolasDeploymentPath?: string;
  minEoaGasWei?: string;
  minSafeEthWei?: string;
  /** Optional password — without it we cannot derive the master address from a keystore. */
  password?: string;
  /** Inject a public client (tests). Defaults to a viem client over rpcUrl. */
  publicClientFactory?: (rpcUrl: string, network: JinnOnchainNetwork) => PublicClient;
  /** Inject the fleet store (tests). */
  storeFactory?: (earningDir?: string) => FleetStateStore;
  /** Inject chain config (tests). */
  chainConfigResolver?: typeof getChainConfig;
}

/** A single per-Safe ETH gap, surfaced for runtime mech-fee paths. */
export interface SafeFundingRow {
  serviceIndex: number;
  safeAddress: string;
  haveWei: string;
  needWei: string;
  asset: 'native';
  reason: string;
}

/** Reasons the plan is partial — the answer is best-effort, not authoritative. */
export type FundingPlanPartialReason =
  | 'no_keystore'
  | 'password_missing'
  | 'password_invalid'
  | 'rpc_unreachable'
  | 'fleet_state_missing'
  | 'fleet_state_invalid';

export interface FundingPlan {
  /**
   * Best-effort assessment that no funding gate is currently blocking advancement.
   * This is `false` whenever any requirement is present OR the answer is partial.
   */
  satisfied: boolean;
  /**
   * `true` when the plan could not fully evaluate the funding state. Operators
   * (and agents) should treat the result as advisory and re-run after fixing
   * the listed reasons. The plan never mutates state.
   */
  partial: boolean;
  reasons: FundingPlanPartialReason[];
  /**
   * Master-level shortfall when the master EOA does not yet hold the
   * minimum ETH the bootstrap state machine needs to proceed.
   */
  master?: FundingRequirement;
  /** Per-Safe ETH gaps for completed services (for runtime mech-fee paths). */
  safes: SafeFundingRow[];
  /** Snapshot of the fleet state used for evaluation, when available. */
  fleetState?: FleetState;
}

const addr = (value: string): Address => getAddress(value) as Address;

async function safeGetBalance(
  client: PublicClient,
  address: Address,
): Promise<bigint | null> {
  try {
    return await client.getBalance({ address });
  } catch {
    return null;
  }
}

/**
 * Compute the read-only funding plan. Pure function over disk + chain reads.
 *
 * Guarantees (these are part of the contract relied on by `jinn fund-requirements`):
 *   - Never writes to the fleet state file or keystore.
 *   - Never requests faucet funds.
 *   - Never sends any chain transactions.
 *
 * If a password is provided and a mnemonic keystore exists, the master
 * address is derived from the keystore for funding evaluation. If the
 * password is missing, wrong, or no keystore exists, the plan still
 * returns whatever it can learn from disk + chain reads, with a partial
 * flag and machine-readable reasons.
 */
export async function planFleetFunding(
  options: FundingPlanOptions = {},
): Promise<FundingPlan> {
  const chain: JinnOnchainNetwork = options.chain ?? 'base';
  const stakingMode: StakingMode = options.stakingMode ?? 'standard';
  const targetServices = options.targetServices ?? 1;
  const reasons: FundingPlanPartialReason[] = [];

  const storeFactory = options.storeFactory ?? ((dir) => new FleetStateStore(dir));
  const store = storeFactory(options.earningDir);

  const chainConfigResolver = options.chainConfigResolver ?? getChainConfig;
  const config: ChainConfig = applyChainGasOverrides(chainConfigResolver(chain, {
    testnetL2DeploymentPath: options.testnetL2DeploymentPath,
    testnetL2TokenDeploymentPath: options.testnetL2TokenDeploymentPath,
    testnetMechDeploymentPath: options.testnetMechDeploymentPath,
    testnetStolasDeploymentPath: options.testnetStolasDeploymentPath,
  }), {
    minEoaGasWei: options.minEoaGasWei,
    minSafeEthWei: options.minSafeEthWei,
  });
  if (options.rpcUrl) {
    config.rpcUrl = options.rpcUrl;
  }

  const publicClientFactory =
    options.publicClientFactory ?? ((url, net) => createJinnPublicClient(url, net) as unknown as PublicClient);
  const publicClient = publicClientFactory(config.rpcUrl, chain);

  // Read-only fleet state probe. We deliberately call `tryLoadExisting`
  // (never `load`) — `load` writes a default file when the state is
  // missing, which would be a mutation.
  const fleetState = await store.tryLoadExisting();
  if (!fleetState) {
    reasons.push('fleet_state_missing');
  }

  // Resolve master address: prefer persisted state, then derive from
  // keystore + password if available, otherwise mark partial.
  let masterAddress: Address | null = null;
  if (fleetState?.master_address) {
    masterAddress = addr(fleetState.master_address);
  } else if (store.hasMnemonicKeystore()) {
    if (options.password) {
      try {
        const ks = await store.loadMnemonicKeystore();
        const mnemonic = await decryptMnemonic(ks, options.password);
        masterAddress = addr(deriveMasterAddress(mnemonic));
      } catch {
        reasons.push('password_invalid');
      }
    } else {
      reasons.push('password_missing');
    }
  } else {
    reasons.push('no_keystore');
  }

  // No master => no useful master-level evaluation possible.
  if (!masterAddress) {
    return {
      satisfied: false,
      partial: true,
      reasons,
      safes: [],
      fleetState: fleetState ?? undefined,
    };
  }

  // Master ETH probe.
  const masterBalance = await safeGetBalance(publicClient, masterAddress);
  if (masterBalance === null) {
    reasons.push('rpc_unreachable');
    return {
      satisfied: false,
      partial: true,
      reasons,
      safes: [],
      fleetState: fleetState ?? undefined,
    };
  }

  let systemEth = masterBalance;
  if (stakingMode === 'self-bond' && fleetState) {
    for (const svc of fleetState.services) {
      if (svc.agent_address) {
        const bal = await safeGetBalance(publicClient, addr(svc.agent_address));
        if (bal === null) {
          reasons.push('rpc_unreachable');
        } else {
          systemEth += bal;
        }
      }
      if (svc.safe_address) {
        const bal = await safeGetBalance(publicClient, addr(svc.safe_address));
        if (bal === null) {
          reasons.push('rpc_unreachable');
        } else {
          systemEth += bal;
        }
      }
    }
  }

  // Pre-Stage-1: fleet state missing or fleet_stage === 'none' (no fleet
  // identity yet). The Stage 1 gate must cover the master → agent transfer
  // (STAGE1_AGENT_ETH = 0.01 ETH) plus the master's own gas reserve
  // (minEoaGasEth). See jinn-mono-u34i.
  const isPreStage1 = !fleetState || fleetState.fleet_stage === 'none';
  // A migration-wiped fleet must be treated as needing funding rather than
  // short-circuited to 0n. Detecting the deprecated testnet setup here keeps
  // this read-only view in agreement with the mutating bootstrapper gate —
  // omitting it was the GAP-1 wiring-seam drift. `detectDeprecatedTestnetSetup`
  // is a pure function over state + config (no chain calls), so it is safe in
  // this read-only path.
  const pendingSetupMigration =
    fleetState !== null &&
    detectDeprecatedTestnetSetup({
      state: fleetState,
      chain,
      stakingMode,
      currentStakingContract: config.stakingContract,
    }).services.length > 0;
  // Single source of truth: the master-ETH gate is computed by
  // `computeRequiredMasterEth` in bootstrap.ts — the same helper the mutating
  // `FleetBootstrapper.ensureStage1And2` gate routes through. Re-deriving it
  // inline here is the u34i cross-module invariant-drift hazard.
  const requiredMasterEth = computeRequiredMasterEth({
    services: fleetState?.services ?? [],
    minEoaGasEth: config.minEoaGasEth,
    pendingSetupMigration,
    targetServices,
    stakingMode,
    preStage1: isPreStage1,
  });

  let master: FundingRequirement | undefined;
  if (systemEth < requiredMasterEth) {
    const shortfall = requiredMasterEth - systemEth;
    master = {
      master_address: masterAddress,
      eth_required: shortfall.toString(),
      eth_balance: masterBalance.toString(),
    };
  }

  // Per-Safe probes for completed services (parity with the existing
  // mech-fee runtime probe in fund-requirements). Only emitted when
  // master-level funding is satisfied — same as the prior behaviour.
  const safes: SafeFundingRow[] = [];
  if (!master && fleetState) {
    for (const svc of fleetState.services) {
      if (!isOperationalServiceStep(svc.step) || !svc.safe_address) continue;
      const safeAddr = addr(svc.safe_address);
      const bal = await safeGetBalance(publicClient, safeAddr);
      if (bal === null) {
        reasons.push('rpc_unreachable');
        continue;
      }
      if (bal >= config.minSafeEth) continue;
      safes.push({
        serviceIndex: svc.index,
        safeAddress: safeAddr,
        haveWei: bal.toString(),
        needWei: (config.minSafeEth - bal).toString(),
        asset: 'native',
        reason:
          `Service ${svc.index} Safe needs native ETH to pay mech fees (each evaluation job sends 99 wei). ` +
          `The daemon's balance-topup-loop auto-refills from master at runtime; funding it manually is ` +
          `required only when running CLI verbs (tasks submit, acceptance gate) outside the daemon.`,
      });
    }
  }

  // Deduplicate reasons (rpc_unreachable can be appended multiple times).
  const uniqueReasons = Array.from(new Set(reasons));
  const partial = uniqueReasons.length > 0;
  const satisfied = !master && safes.length === 0 && !partial;

  return {
    satisfied,
    partial,
    reasons: uniqueReasons,
    master,
    safes,
    fleetState: fleetState ?? undefined,
  };
}
