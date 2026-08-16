/**
 * Fleet response assembler.
 *
 * Contract: spec/2026-04-14-client-surface.md §4.2.
 * Slices GatheredStatusRaw (same source as /v1/status) into per-service detail.
 */

import type { GatheredStatusRaw } from './status-build.js';
import { isOperationalServiceStep, isStakedLikeServiceStep, type ServiceState } from '../earning/types.js';
import { displayFleetServiceIndex } from '../earning/fleet-display-index.js';

type AttentionKind =
  | 'none'
  | 'low_gas'
  | 'identity_binding_pending'
  | 'stake_missing'
  | 'bond_insufficient'
  | 'reconcile_needed';

export interface FleetV1Service {
  index: number;
  step: string;
  serviceId: number | null;
  wallets: {
    agent: { address: string; balances: Array<{ asset: string; amountWei: string }> };
    multisig: { address: string; balances: Array<{ asset: string; amountWei: string }> };
  };
  staking: { staked: boolean; sinceBlock: number | null };
  activity: { lastEventAt: string | null; counts: Record<string, number> };
  attention: null | {
    kind: AttentionKind;
    hint: string;
    exampleCli: string;
    /** Machine-readable category for programmatic consumers (e.g. CLI tools). */
    category?: string;
    /**
     * Decoded contract revert reason when `category === 'safe_binding_failed'`.
     * Null when the revert had no reason data; absent for other attention kinds.
     */
    revertReason?: string | null;
  };
}

export interface FleetV1Response {
  schemaVersion: 1;
  generatedAt: string;
  network: 'testnet' | 'mainnet';
  master: {
    address: string;
    balances: Array<{ asset: string; amountWei: string }>;
  };
  services: FleetV1Service[];
}

function computeAttention(
  svc: ServiceState,
  raw: GatheredStatusRaw,
  isFirstService: boolean,
): FleetV1Service['attention'] {
  if (
    isFirstService &&
    raw.minMasterEthWei &&
    raw.master.balanceWei !== undefined &&
    BigInt(raw.master.balanceWei) < BigInt(raw.minMasterEthWei)
  ) {
    return {
      kind: 'low_gas',
      hint: 'Master wallet ETH below minimum. Top it up to continue.',
      exampleCli: 'jinn fund-requirements --json',
    };
  }
  if (svc.error) {
    const hint = svc.error_short_message ?? svc.error;
    return {
      kind: 'reconcile_needed',
      hint,
      exampleCli: 'jinn status --detail',
      ...(svc.error?.startsWith('safe_binding_failed') ? { category: 'safe_binding_failed' as const } : {}),
      ...(svc.error_revert_reason !== undefined
        ? { revertReason: svc.error_revert_reason }
        : {}),
    };
  }
  if (svc.step === 'safe_binding_pending') {
    return {
      kind: 'identity_binding_pending',
      hint: 'Service is running; ERC-8004 Safe-to-agent binding is pending retry.',
      exampleCli: 'jinn bootstrap --json',
    };
  }
  if (!isOperationalServiceStep(svc.step)) {
    return {
      kind: 'reconcile_needed',
      hint: `Service ${displayFleetServiceIndex(svc)} is at step ${svc.step}. Run jinn bootstrap to advance.`,
      exampleCli: 'jinn bootstrap --json',
    };
  }
  return null;
}

export function assembleFleetV1(raw: GatheredStatusRaw): FleetV1Response {
  const fleet = raw.fleet;
  const network: 'testnet' | 'mainnet' =
    fleet?.chain === 'base' ? 'mainnet' : 'testnet';
  const masterAddress = fleet?.master_address ?? raw.master.address ?? '0x';

  const services = (fleet?.services ?? []).map((svc, i) => {
    const di = displayFleetServiceIndex(svc);
    const per = raw.perServiceActivity?.[di];
    return {
    index: di,
    step: svc.step,
    serviceId: svc.service_id,
    wallets: {
      agent: {
        address: svc.agent_address || '0x',
        balances: [{ asset: 'native', amountWei: raw.serviceBalances?.[di]?.agentNativeWei ?? '0' }],
      },
      multisig: {
        address: svc.safe_address || '0x',
        balances: [
          { asset: 'native', amountWei: raw.serviceBalances?.[di]?.safeNativeWei ?? '0' },
          { asset: 'bond', amountWei: raw.serviceBalances?.[di]?.safeBondWei ?? '0' },
        ],
      },
    },
    staking: {
      staked: isStakedLikeServiceStep(svc.step),
      sinceBlock: null,
    },
    activity: {
      lastEventAt: per?.lastEventAt ?? null,
      counts: per?.counts ?? {},
    },
    attention: computeAttention(svc, raw, i === 0),
  };
  });

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    network,
    master: {
      address: masterAddress,
      balances: [{ asset: 'native', amountWei: raw.master.balanceWei ?? '0' }],
    },
    services,
  };
}
