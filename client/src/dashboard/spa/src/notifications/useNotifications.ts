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
 * Translate the real `/v1/status` + `/v1/bootstrap` responses into the deriver's
 * `DeriveInput` shape. The two shapes don't match — `DeriveInput` is the deriver's
 * *contract*, not the daemon's wire format — so this adapter does best-effort
 * field mapping and defaults every unmapped field to a non-triggering value.
 *
 * Reviewed-by-Ritsu mapping (review of PR #426):
 * - `s.fleet.services[]` (NOT top-level `services`); per-service `evicted` and
 *   `safeBoundToAgent` (NOT `safeBound`). See `client/src/api/status-build.ts`.
 * - `joinedSolverNets` comes from `/v1/bootstrap`, NOT `/v1/status`. See
 *   `client/src/api/bootstrap-endpoint.ts`.
 * - `harness` readiness and `password_rotation_due` have no `/v1/status` field
 *   today — both follow-up Issues are linked in the PR. Defaults below keep
 *   their notifications silent until the daemon surfaces the inputs.
 */
function mapStatusToDeriveInput(
  rawStatus: unknown,
  rawBootstrap: unknown,
  restartPending: boolean,
): DeriveInput['status'] {
  const s = (rawStatus ?? {}) as Record<string, any>;
  const b = (rawBootstrap ?? {}) as Record<string, any>;

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

  // Map fleet.services → DeriveInput.services. The real field is
  // `safeBoundToAgent`, not `safeBound`. Default missing flags to non-triggering
  // values (evicted=false, safeBound=true).
  const fleetServices: any[] = Array.isArray(s.fleet?.services) ? s.fleet.services : [];

  // joinedSolverNets lives on /v1/bootstrap. If empty AND bootstrap.mode is
  // 'running', no_solvernets_joined fires. The previous default of
  // `{ _unknown: {} }` suppressed the notice entirely — replaced by reading the
  // real bootstrap field, with an empty `{}` default that lets the notice fire
  // on a genuinely-empty config.
  const joinedSolverNets =
    b.joinedSolverNets && typeof b.joinedSolverNets === 'object'
      ? b.joinedSolverNets
      : {};

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
    // spuriously. Follow-up Issue: surface a rollup field on /v1/status.
    harness: { ready: true, name: 'unknown' },
    // RPC reachability is handled by the connection-state early-return above;
    // this default keeps rpc_unreachable from double-firing through the deriver.
    rpc: { reachable: true },
    restartPending,
    daemonVersion: String(s.version ?? '0.0.0'),
    latestVersion: undefined,
    services: fleetServices.map((svc: any) => ({
      evicted: Boolean(svc?.evicted),
      // safeBound defaults to true (no notice) unless safeBoundToAgent is explicitly false.
      safeBound: svc?.safeBoundToAgent !== false,
    })),
    joinedSolverNets,
    // No /v1/status field for last password rotation today; follow-up Issue
    // tracks adding it. Until then, password_rotation_due never fires.
    passwordRotatedAt: undefined,
  };
}

export function useNotifications(): OperatorNotification[] {
  const connection = useConnectionState();
  const { restartPending } = useRestartPending();
  // Share React Query cache with the existing app-level pollers (Overview's
  // ['status'] at 5s, App.tsx's ['bootstrap'] at 1.5s). Specifying our own
  // refetchInterval here would compete with those — react-query deduplicates
  // in-flight requests but per Ritsu's review of #426, declaring two intervals
  // on the same key is a latent surprise. Omit and inherit.
  const status = useQuery({
    queryKey: ['status'],
    queryFn: () => api.getStatus(),
  });
  const bootstrap = useQuery({
    queryKey: ['bootstrap'],
    queryFn: () => api.getBootstrap(),
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
      status: mapStatusToDeriveInput(status.data, bootstrap.data, restartPending),
    });
    return [...derived].sort(
      (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity],
    );
  }, [connection.status, restartPending, status.data, bootstrap.data]);
}
