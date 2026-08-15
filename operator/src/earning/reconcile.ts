/**
 * Pure reconciliation rules: persisted fleet service state vs on-chain signals.
 * Used by FleetBootstrapper so operators need not hand-edit earning_state.json.
 */

import { getAddress } from 'viem';
import type { ServiceState, ServiceStep } from './types.js';

const ZERO = '0x0000000000000000000000000000000000000000';

/** `revert` = call reverted (authoritative). `inconclusive` = RPC/transport — do not clear state. */
export type ChainReadFailure = 'revert' | 'missing' | 'inconclusive';

/** On-chain view gathered before applying rules (all reads best-effort). */
export interface ServiceChainSignals {
  stakingState: number | ChainReadFailure;
  /** Staking.getServiceInfo().multisig when readable */
  stakingMultisig: string | null;
  /** ServiceRegistry.getService().state when readable */
  registryState: number | ChainReadFailure;
  /** ServiceRegistry.getService().multisig when readable */
  registryMultisig: string | null;
  /** Whether bytecode exists at persisted safe_address */
  safeDeployed: boolean | null;
}

export interface ReconcilePatch {
  /** Operator-facing line (logged by bootstrap) */
  message: string;
  patch: Partial<ServiceState>;
}

const STANDARD_POST_STAKE: ReadonlySet<ServiceStep> = new Set([
  'staked',
  'mech_deployed',
  'agent_registered',
  'safe_binding_pending',
  'complete',
]);

const SELF_BOND_STAKE_STEPS: ReadonlySet<ServiceStep> = new Set([
  'service_staked',
  'staked',
  'mech_deployed',
  'agent_registered',
  'safe_binding_pending',
  'complete',
]);

/** Self-bond registry state → latest local step that must not be ahead of chain (bootstrap idempotency). */
const REGISTRY_MAX_STEP: Record<number, ServiceStep> = {
  0: 'service_created',
  1: 'service_activated',
  2: 'agents_registered',
  3: 'service_deployed',
  4: 'service_staked',
};

const STEP_ORDER: ServiceStep[] = [
  'awaiting_stake',
  'service_created',
  'service_activated',
  'agents_registered',
  'service_deployed',
  'service_staked',
  'staked',
  'mech_deployed',
  'agent_registered',
  'safe_binding_pending',
  'complete',
];

function stepIndex(step: ServiceStep): number {
  const i = STEP_ORDER.indexOf(step);
  return i === -1 ? 0 : i;
}

function isZeroishAddress(addr: string | null | undefined): boolean {
  if (!addr) return true;
  try {
    return getAddress(addr) === getAddress(ZERO);
  } catch {
    return true;
  }
}

function clearServiceIdentity(): Partial<ServiceState> {
  return {
    service_id: null,
    safe_address: null,
    mech_address: null,
    staking_address: null,
    step: 'awaiting_stake',
    error: null,
  };
}

/**
 * Standard (distributor) mode: staking proxy is source of truth for stake/eviction.
 */
export function reconcileStandardService(
  index: number,
  svc: ServiceState,
  chain: ServiceChainSignals,
  ctx: { stakingContract: string; preserveExistingSetup?: boolean },
): ReconcilePatch | null {
  if (svc.service_id === null) return null;

  const id = svc.service_id;

  if (chain.stakingState === 'inconclusive' || chain.registryState === 'inconclusive') {
    return null;
  }

  if (chain.stakingState === 'revert') {
    if (ctx.preserveExistingSetup) {
      return {
        message: `[jinn-earning] Service ${index}: existing setup could not be verified automatically. Leaving local service id and wallet fields unchanged for recovery/support.`,
        patch: {
          error: 'Existing setup could not be verified automatically; local setup was preserved.',
        },
      };
    }
    return {
      message: `[jinn-earning] Service ${index}: persisted id=${id} is unknown to the staking contract (RPC reverted). Clearing local service id and Safe/mech fields; next bootstrap will run a fresh distributor stake().`,
      patch: clearServiceIdentity(),
    };
  }

  if (chain.stakingState === 2) {
    // Eviction: resumeService runs reStake; no state patch here.
    return null;
  }

  // Crashed after assigning service_id but before stake confirmed — or stale id
  if (svc.step === 'awaiting_stake' && chain.stakingState === 0) {
    if (ctx.preserveExistingSetup) {
      return {
        message: `[jinn-earning] Service ${index}: existing setup appears inactive before bootstrap completed, but it uses a non-default setup address. Leaving local service id and wallet fields unchanged for recovery/support.`,
        patch: {
          error: 'Existing setup appears inactive; local setup was preserved for recovery.',
        },
      };
    }
    return {
      message: `[jinn-earning] Service ${index}: local step was awaiting_stake but service_id=${id} is not staked on-chain. Clearing stale id/Safe/mech; next bootstrap will call distributor stake() cleanly.`,
      patch: clearServiceIdentity(),
    };
  }

  // State file behind chain (e.g. crash after stake mined before step save)
  if (svc.step === 'awaiting_stake' && chain.stakingState === 1) {
    const safe =
      chain.stakingMultisig && !isZeroishAddress(chain.stakingMultisig)
        ? getAddress(chain.stakingMultisig)
        : svc.safe_address;
    if (!safe || isZeroishAddress(safe)) {
      return null;
    }
    return {
      message: `[jinn-earning] Service ${index}: on-chain shows id=${id} already staked; advancing local step from awaiting_stake to staked (Safe ${safe}).`,
      patch: {
        step: 'staked',
        safe_address: safe,
        staking_address: getAddress(ctx.stakingContract),
        error: null,
      },
    };
  }

  if (STANDARD_POST_STAKE.has(svc.step) && chain.stakingState === 0) {
    if (ctx.preserveExistingSetup) {
      return {
        message: `[jinn-earning] Service ${index}: existing setup appears inactive, but it uses a non-default setup address. Leaving local service id and wallet fields unchanged for recovery/support.`,
        patch: {
          error: 'Existing setup appears inactive; local setup was preserved for recovery.',
        },
      };
    }
    return {
      message: `[jinn-earning] Service ${index}: on-chain staking is unstaked for id=${id} while local step was '${svc.step}' (e.g. unstakeAndWithdraw or a crashed tx). Resetting to awaiting_stake; next bootstrap will provision a new service via the distributor.`,
      patch: clearServiceIdentity(),
    };
  }

  return null;
}

function maxStepForRegistryState(registryState: number): ServiceStep {
  if (registryState >= 4) return 'service_staked';
  return REGISTRY_MAX_STEP[registryState] ?? 'service_created';
}

/**
 * Self-bond mode: registry + Safe bytecode + staking.
 */
export function reconcileSelfBondService(
  index: number,
  svc: ServiceState,
  chain: ServiceChainSignals,
): ReconcilePatch | null {
  const step = svc.step;

  if (chain.stakingState === 'inconclusive' || chain.registryState === 'inconclusive') {
    return null;
  }

  // Safe predicted or required but not deployed while we think we passed setup
  if (
    step !== 'awaiting_stake' &&
    svc.safe_address &&
    chain.safeDeployed === false
  ) {
    return {
      message: `[jinn-earning] Service ${index}: Safe ${svc.safe_address} has no bytecode on-chain but local step was '${step}'. Rewinding to awaiting_stake to re-run Safe prediction and deployment.`,
      patch: clearServiceIdentity(),
    };
  }

  if (svc.service_id !== null) {
    const id = svc.service_id;

    if (chain.registryState === 'revert') {
      return {
        message: `[jinn-earning] Service ${index}: could not read service ${id} from the registry (RPC reverted). Clearing service id; bootstrap will recreate the service when you re-run.`,
        patch: {
          service_id: null,
          mech_address: null,
          staking_address: null,
          step: chain.safeDeployed === true ? 'service_created' : 'awaiting_stake',
          error: null,
        },
      };
    }

    const reg = chain.registryState;
    const multisigMissing =
      chain.registryMultisig === null || isZeroishAddress(chain.registryMultisig);

    if (typeof reg === 'number' && reg === 0 && multisigMissing) {
      return {
        message: `[jinn-earning] Service ${index}: registry shows no service at id=${id} (evicted / terminated / wrong id). Clearing local service id; next bootstrap will create a new service from step '${chain.safeDeployed === true ? 'service_created' : 'awaiting_stake'}'.`,
        patch: {
          service_id: null,
          mech_address: null,
          staking_address: null,
          step: chain.safeDeployed === true ? 'service_created' : 'awaiting_stake',
          error: null,
        },
      };
    }

    // Staking beats registry-order heuristics (eviction / unstaked while registry still "deployed")
    if (chain.stakingState !== 'revert' && SELF_BOND_STAKE_STEPS.has(step)) {
      if (chain.stakingState === 2) {
        return {
          message: `[jinn-earning] Service ${index}: service ${id} is evicted on-chain (staking state 2). Rewinding to service_staked to re-stake when you re-run.`,
          patch: {
            step: 'service_staked',
            mech_address: null,
            error: null,
          },
        };
      }
      if (chain.stakingState === 0) {
        return {
          message: `[jinn-earning] Service ${index}: service ${id} is not staked on-chain while local step was '${step}' (e.g. partial stake or unstake). Rewinding to service_staked to retry staking.`,
          patch: {
            step: 'service_staked',
            mech_address: null,
            error: null,
          },
        };
      }
    }

    // Local step ahead of chain (e.g. tx never mined after state save)
    if (typeof reg === 'number' && reg > 0) {
      const maxStep = maxStepForRegistryState(reg);
      if (stepIndex(step) > stepIndex(maxStep)) {
        const patch: Partial<ServiceState> = {
          step: maxStep,
          error: null,
        };
        if (stepIndex(maxStep) < stepIndex('staked')) {
          patch.mech_address = null;
        }
        if (stepIndex(maxStep) < stepIndex('service_staked')) {
          patch.staking_address = null;
        }
        return {
          message: `[jinn-earning] Service ${index}: local step '${step}' was ahead of registry state (${reg}) for id=${id}. Rewinding to '${maxStep}' so bootstrap can resubmit the correct on-chain steps.`,
          patch,
        };
      }
    }
  }

  return null;
}

export function reconcileServiceAgainstChain(
  stakingMode: 'standard' | 'self-bond',
  svc: ServiceState,
  chain: ServiceChainSignals,
  ctx: { stakingContract: string; preserveExistingSetup?: boolean },
): ReconcilePatch | null {
  if (stakingMode === 'standard') {
    return reconcileStandardService(svc.index, svc, chain, ctx);
  }
  return reconcileSelfBondService(svc.index, svc, chain);
}
