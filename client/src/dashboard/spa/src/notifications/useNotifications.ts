import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client.js';
import { useConnectionState } from '../api/connection-state.js';
import { useEventStream } from '../api/events.js';
import { useRestartPending } from '../shell/RestartPendingContext.js';
import { deriveNotifications, type DeriveInput } from './derive.js';
import type { AutoRestakeStatus } from './auto-restake-window.js';
import type { OperatorNotification } from './taxonomy.js';

const SEVERITY_ORDER: Record<OperatorNotification['severity'], number> = {
  blocking: 0,
  warning: 1,
  info: 2,
};

/**
 * Recent-window for the event-driven `claim_failed` notification (issue #442).
 *
 * 30 minutes is wall-clock measured against the event's own `ts`, not against
 * SPA mount. An operator who refreshes the dashboard 25 minutes after a burst
 * of claim failures should still see the warning; an operator who opens the
 * dashboard a week later should not. The 60s re-render tick (see below) ages
 * stale events out on an otherwise-idle dashboard.
 */
const CLAIM_FAILED_WINDOW_MS = 30 * 60 * 1000;
const CLAIM_FAILED_TICK_MS = 60 * 1000;

// `useEventStream` re-uses its EventSource per join-key (filterKinds.join(',')).
// Hoisting the kinds array keeps the join-key identity stable across renders.
const INTENT_KINDS: ['intent'] = ['intent'];

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
 * - `harness` readiness is now populated by the daemon on `/v1/status.harness`
 *   (#440) — a single boolean + name + reason rollup over the joined SolverNets'
 *   harnesses. Older daemons / partial responses default to ready.
 * - `password_rotation_due` has no `/v1/status` field today; the default below
 *   keeps it silent until the daemon surfaces the input.
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

  // Forward the `autoRestake` block when the daemon emits it (#651). Older
  // daemons predate the field, in which case it's undefined and the deriver
  // falls through to the immediate-emit branch (backwards compat).
  const autoRestake: AutoRestakeStatus | undefined =
    s.autoRestake && typeof s.autoRestake === 'object'
      ? {
          enabled: Boolean(s.autoRestake.enabled),
          checkIntervalMs: Number.isFinite(s.autoRestake.checkIntervalMs)
            ? Number(s.autoRestake.checkIntervalMs)
            : 0,
        }
      : undefined;

  return {
    funds: {
      eth: masterEth,
      runwayDays: masterRunwayDays,
    },
    // Do not map `/v1/status.rewards.pendingStakingRewardsWei` into
    // notifications. That field is the OLAS/staking collector queue, not real
    // operator tJINN earning, and tJINN claims are automatic via the daemon
    // emit loop plus standing relayer.
    // Harness readiness rollup comes from `/v1/status.harness` (#440).
    // `ready !== false` preserves default-ready when the field is absent
    // (older daemons / partial responses); `name`/`reason` accept the
    // daemon's `string | null` shape and reject anything else.
    harness: {
      ready: s.harness?.ready !== false,
      name: typeof s.harness?.name === 'string' ? s.harness.name : null,
      reason: typeof s.harness?.reason === 'string' ? s.harness.reason : null,
    },
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
      // ISO timestamp the daemon attaches once it observes the eviction (#651).
      // Absent on older daemons / non-evicted services — null lets the deriver
      // fall through to immediate-emit when the suppression window can't be
      // computed.
      evictedSince: typeof svc?.evictedSince === 'string' ? svc.evictedSince : null,
    })),
    joinedSolverNets,
    // No /v1/status field for last password rotation today; follow-up Issue
    // tracks adding it. Until then, password_rotation_due never fires.
    passwordRotatedAt: undefined,
    autoRestake,
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

  // Event-driven source for the 12th notification kind (`claim_failed`, per
  // OPERATOR-APP-SPEC §2.10 + issue #442). Subscribes to `kind: 'intent'` only
  // so the hook does not re-render on every `log` event the daemon emits.
  // SSE backfill replays the last 50 events on connect, so a page reload that
  // happens within the recent window re-surfaces the burst for free.
  const { events } = useEventStream(INTENT_KINDS);

  // Wall-clock tick: re-evaluate the recent-window filter every 60s so a
  // notification ages out even on an otherwise-idle dashboard with no new SSE
  // traffic. The filter is honest against the event's own `ts`, not mount time.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), CLAIM_FAILED_TICK_MS);
    return () => clearInterval(id);
  }, []);

  const claimFailedNotice = useMemo<OperatorNotification | null>(() => {
    const cutoffMs = nowMs - CLAIM_FAILED_WINDOW_MS;
    // Dedup by event `id`. `useEventStream` accumulates SSE messages into a
    // React state array; on reconnect (network hiccup, daemon restart, tab
    // resume) the server replays the last 50 events from its ring buffer
    // (events-endpoint.ts §/v1/events backfill) with their original ids. The
    // server ignores Last-Event-ID and the client does not deduplicate at the
    // EventSource layer, so the same event can appear N times here after N
    // reconnects. Without this set, the `n` in the notification message would
    // inflate on every reconnect — exactly the failure mode issue #442's
    // dogfood operator already encountered (26 failures must not read "52"
    // after one reconnect).
    const seen = new Set<string>();
    const recentFailures = events.filter((e) => {
      if (e.kind !== 'intent' || e.errorCode !== 'claim_failed') return false;
      const eventMs = Date.parse(e.ts);
      if (Number.isNaN(eventMs)) return false;
      if (eventMs < cutoffMs) return false;
      if (seen.has(e.id)) return false;
      seen.add(e.id);
      return true;
    });
    if (recentFailures.length === 0) return null;
    const n = recentFailures.length;
    return {
      kind: 'claim_failed',
      severity: 'warning',
      message: `${n} claim attempt${n === 1 ? '' : 's'} failed in the last 30 minutes. Check Tasks for details.`,
      jumpTo: '/overview',
      details: { count: n, sinceMs: cutoffMs },
    };
  }, [events, nowMs]);

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
    const combined = claimFailedNotice ? [...derived, claimFailedNotice] : [...derived];
    return combined.sort(
      (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity],
    );
  }, [connection.status, restartPending, status.data, bootstrap.data, claimFailedNotice]);
}
