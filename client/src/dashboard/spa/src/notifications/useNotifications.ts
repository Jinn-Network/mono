import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client.js';
import { useConnectionState } from '../api/connection-state.js';
import { useRestartPending } from '../shell/RestartPendingContext.js';
import { deriveNotifications, type DeriveInput } from './derive.js';
import type { OperatorNotification } from './taxonomy.js';

const SEVERITY_ORDER: Record<OperatorNotification['severity'], number> = {
  blocking: 0,
  warning: 1,
  info: 2,
};

/**
 * Translate the real `/v1/status` response into the deriver's `DeriveInput.status`
 * shape. The two shapes don't match — `DeriveInput` is the deriver's *contract*,
 * not the daemon's wire format — so this adapter does best-effort field mapping
 * and defaults every unmapped field to a non-triggering value.
 *
 * As `/v1/status` grows fields that match deriver inputs (per follow-up issues
 * for per-role balances, harness-readiness rollup, etc.), replace the defaults
 * with the real values one at a time.
 */
function mapStatusToDeriveInput(raw: unknown, restartPending: boolean): DeriveInput['status'] {
  const s = (raw ?? {}) as Record<string, any>;

  const masterEthWei = String(s.masterGas?.balanceWei ?? '0');
  let masterEth = '0';
  let masterRunwayDays = Number.POSITIVE_INFINITY;
  try {
    const wei = BigInt(masterEthWei);
    masterEth = wei.toString();
    // Crude runway proxy: if there's any ETH, treat runway as not-low until the
    // daemon exposes a real estimate. A real `funds.runwayDays` field on /v1/status
    // would replace this. Zero balance still maps to 0 runway so funding_low fires.
    masterRunwayDays = wei > 0n ? Number.POSITIVE_INFINITY : 0;
  } catch {
    // Non-numeric balance — leave the safe defaults in place.
  }

  return {
    funds: {
      eth: masterEth,
      runwayDays: masterRunwayDays,
    },
    rewards: {
      claimableWei: String(s.rewards?.pendingStakingRewardsWei ?? '0'),
    },
    // Harness readiness is its own endpoint (`/v1/harnesses/readiness`) — not on
    // /v1/status today. Default to ready=true so harness_not_ready doesn't fire
    // spuriously. A follow-up rollup field on /v1/status would unlock this.
    harness: { ready: true, name: 'unknown' },
    // RPC reachability is handled by the connection-state early-return above;
    // this default keeps rpc_unreachable from double-firing.
    rpc: { reachable: true },
    restartPending,
    daemonVersion: String(s.version ?? '0.0.0'),
    latestVersion: undefined,
    services: Array.isArray(s.services)
      ? s.services.map((svc: any) => ({
          evicted: Boolean(svc?.evicted),
          // safeBound defaults to true (no notice) unless the daemon explicitly says false
          safeBound: svc?.safeBound !== false,
        }))
      : [],
    // If the daemon doesn't surface joinedSolverNets on /v1/status, default to a
    // non-empty placeholder so no_solvernets_joined doesn't fire on every page load.
    // The real signal lives in the SolverNets config; surfacing it here is a
    // separate follow-up.
    joinedSolverNets:
      s.joinedSolverNets && typeof s.joinedSolverNets === 'object'
        ? s.joinedSolverNets
        : { _unknown: {} },
    passwordRotatedAt: s.security?.lastPasswordRotationAt,
  };
}

export function useNotifications(): OperatorNotification[] {
  const connection = useConnectionState();
  const { restartPending } = useRestartPending();
  const status = useQuery({
    queryKey: ['status'],
    queryFn: () => api.getStatus(),
    refetchInterval: 5000,
  });
  const bootstrap = useQuery({
    queryKey: ['bootstrap'],
    queryFn: () => api.getBootstrap(),
    refetchInterval: 5000,
  });

  return useMemo(() => {
    // When the SPA can't reach the daemon, surface a blocking notification
    // immediately without waiting for (stale) status/bootstrap data.
    if (connection.status === 'disconnected') {
      return [
        {
          kind: 'rpc_unreachable' as const,
          severity: 'blocking' as const,
          message: 'Daemon offline. What you see may be stale. Reconnecting automatically…',
        },
      ];
    }

    if (!status.data || !bootstrap.data) return [];

    const derived = deriveNotifications({
      bootstrap: bootstrap.data as DeriveInput['bootstrap'],
      status: mapStatusToDeriveInput(status.data, restartPending),
    });
    return [...derived].sort(
      (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity],
    );
  }, [connection.status, restartPending, status.data, bootstrap.data]);
}
