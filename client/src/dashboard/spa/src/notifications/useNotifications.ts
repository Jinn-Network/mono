import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client.js';
import { useConnectionState } from '../api/connection-state.js';
import { useEventStream } from '../api/events.js';
import { useRestartPending } from '../shell/RestartPendingContext.js';
import { deriveNotifications, gasSeverity, type DeriveInput } from './derive.js';
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
 * - `s.fleet.services[]` (NOT top-level `services`); per-service
 *   `safeBoundToAgent` (NOT `safeBound`). See `client/src/api/status-build.ts`.
 * - `joinedSolverNets` comes from `/v1/bootstrap`, NOT `/v1/status`. See
 *   `client/src/api/bootstrap-endpoint.ts`.
 * - `harness` readiness is now populated by the daemon on `/v1/status.harness`
 *   (#440) — a single boolean + name + reason rollup over the joined SolverNets'
 *   harnesses. Older daemons / partial responses default to ready.
 * - `password_rotation_due` reads `s.security.lastPasswordRotationAt` (#441) —
 *   the keystore-password file's ISO mtime, or null when env-sourced/missing.
 */
/**
 * Translate one daemon gas block (`masterGas` / `l1MasterGas` from
 * `client/src/api/status-build.ts`) into a `funds.chains` entry for the deriver
 * (#1296). Returns null when the block is absent or has no balance — the chain
 * simply doesn't appear (correct on mainnet / older daemons that omit L1).
 *
 * `runwayDays` carries the real `runwayDaysExcess`; `Number.POSITIVE_INFINITY`
 * when not computable (so `funding_low` stays silent). `empty` is the stronger
 * "can't cover the next tx" signal: `balanceWei < minEthWei`.
 */
function gasChain(
  chain: string,
  gas:
    | {
        address?: string | null;
        balanceWei?: string;
        runwayDaysExcess?: string | number | null;
        minEthWei?: string;
      }
    | undefined,
): DeriveInput['status']['funds']['chains'][number] | null {
  if (!gas || gas.balanceWei === undefined) return null;
  let runwayDays = Number.POSITIVE_INFINITY;
  if (gas.runwayDaysExcess !== undefined && gas.runwayDaysExcess !== null) {
    const n = Number(gas.runwayDaysExcess);
    if (Number.isFinite(n)) runwayDays = n;
  }
  // Blocking-threshold math (balanceWei < minEthWei) is owned by gasSeverity
  // (#1296) — reuse it here instead of restating the BigInt comparison.
  const empty = gasSeverity(gas) === 'blocking';
  return { chain, wallet: gas.address ?? null, runwayDays, empty };
}

export function mapStatusToDeriveInput(
  rawStatus: unknown,
  rawBootstrap: unknown,
  restartPending: boolean,
): DeriveInput['status'] {
  const s = (rawStatus ?? {}) as Record<string, any>;
  const b = (rawBootstrap ?? {}) as Record<string, any>;

  // Per-chain gas runway (#1296). The L2 (Base Sepolia) master and the L1
  // (Ethereum Sepolia) master each carry their own threshold; the daemon emits
  // `masterGas` always and `l1MasterGas` on testnet only.
  const chains: DeriveInput['status']['funds']['chains'] = [];
  const l2 = gasChain('Base Sepolia', s.masterGas);
  if (l2) chains.push(l2);
  const l1 = gasChain('Ethereum Sepolia', s.l1MasterGas);
  if (l1) chains.push(l1);

  // Map fleet.services → DeriveInput.services. The real field is
  // `safeBoundToAgent`, not `safeBound`. Default missing safeBound to true.
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
      eth: String(s.masterGas?.balanceWei ?? '0'),
      chains,
    },
    // Staking / OLAS collector-queue values are substrate infrastructure, not
    // operator-facing notifications (the daemon no longer emits them on
    // /v1/status as of #992). OLAS staking rewards accumulate automatically
    // via the stOLAS curating-agent rail.
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
    // `version` + `latestVersion` are now populated by the daemon's start-time
    // npm-registry check (#641). A `string` latestVersion that differs from
    // daemonVersion fires the `update_available` banner via the deriver; a
    // null/absent value maps to undefined so the banner stays silent.
    daemonVersion: String(s.version ?? '0.0.0'),
    latestVersion: typeof s.latestVersion === 'string' ? s.latestVersion : undefined,
    services: fleetServices.map((svc: any) => ({
      safeBound: svc?.safeBoundToAgent !== false,
    })),
    joinedSolverNets,
    // `security.lastPasswordRotationAt` is the ISO mtime of the keystore-password
    // file (issue #441); null/absent ⇒ password_rotation_due stays silent.
    passwordRotatedAt:
      typeof s.security?.lastPasswordRotationAt === 'string'
        ? s.security.lastPasswordRotationAt
        : undefined,
    // One-time shape-v2 migration report — copied straight through from
    // `/v1/status.configMigration` (see `status-build.ts`). Absent on every
    // boot after the first, so `config_migrated` fires at most once.
    configMigration: s.configMigration,
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

  // Event-driven source for the `claim_failed` notification kind (per
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
