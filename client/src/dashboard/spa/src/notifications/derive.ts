import type { OperatorNotification } from './taxonomy.js';
import { isWithinAutoRestakeWindow, type AutoRestakeStatus } from './auto-restake-window.js';

// Loose shape — refine to the concrete BootstrapState + StatusSnapshot types
// when wiring this up in Task 1.4. Kept loose here so the deriver can be tested
// in isolation without dragging the full status schema into the notifications module.
export interface DeriveInput {
  /** milliseconds since epoch; defaults to Date.now() if omitted */
  now?: number;
  bootstrap: { mode: string; blockingReason?: string };
  status: {
    funds: { eth: string; runwayDays: number };
    harness: { ready: boolean; name: string | null; reason: string | null };
    rpc: { reachable: boolean };
    restartPending: boolean;
    daemonVersion: string;
    latestVersion?: string;
    services: { evicted: boolean; safeBound: boolean; evictedSince?: string | null }[];
    joinedSolverNets: Record<string, unknown>;
    passwordRotatedAt?: string; // ISO
    /**
     * EvictionLoop gating mirrored from the daemon (#651). When `enabled` is
     * true, `service_evicted` is suppressed for each evicted service that has
     * been observed evicted for less than `2 × checkIntervalMs`. When absent
     * or `enabled === false`, eviction emits immediately (backwards compat).
     */
    autoRestake?: AutoRestakeStatus;
  };
}

const RUNWAY_LOW_THRESHOLD_DAYS = 3;
const PASSWORD_ROTATION_INTERVAL_MS = 1000 * 60 * 60 * 24 * 90;

export function deriveNotifications(input: DeriveInput): OperatorNotification[] {
  const out: OperatorNotification[] = [];
  const s = input.status;

  if (input.bootstrap.mode !== 'running') {
    out.push({
      kind: 'bootstrap_blocked',
      severity: 'blocking',
      message: input.bootstrap.blockingReason ?? 'Bootstrap incomplete',
      jumpTo: '/',
    });
  }

  if (s.funds.runwayDays < RUNWAY_LOW_THRESHOLD_DAYS) {
    out.push({
      kind: 'funding_low',
      severity: 'warning',
      message: `Runway is ${s.funds.runwayDays} day(s). Top up gas to keep claiming work.`,
      jumpTo: '/overview',
    });
  }

  if (!s.harness.ready) {
    const subject = s.harness.name === null ? 'A harness' : `Harness ${s.harness.name}`;
    const suffix = s.harness.reason ? `: ${s.harness.reason}` : '';
    out.push({
      kind: 'harness_not_ready',
      severity: 'blocking',
      message: `${subject} is not ready${suffix}.`,
      jumpTo: '/operator/memberships',
    });
  }

  if (!s.rpc.reachable) {
    out.push({
      kind: 'rpc_unreachable',
      severity: 'blocking',
      message: 'RPC endpoint is unreachable.',
      jumpTo: '/operator/network',
    });
  }

  if (Object.keys(s.joinedSolverNets).length === 0 && input.bootstrap.mode === 'running') {
    out.push({
      kind: 'no_solvernets_joined',
      severity: 'info',
      message: 'No SolverNets joined. Browse the registry to start earning.',
      jumpTo: '/operator/registry',
    });
  }

  // Eviction suppression window (#651): when auto-restake is enabled, hide the
  // notification for `2 × checkIntervalMs` after first observation so the
  // EvictionLoop has time to settle a restake before alarming the operator.
  // Suppress only when EVERY evicted service is still inside its window; any
  // aged-past service tips the whole notification on (one stuck restake should
  // not hide behind a healthy in-flight one). Bad data falls through to emit.
  const evictedServices = s.services.filter(svc => svc.evicted);
  if (evictedServices.length > 0) {
    const now = input.now ?? Date.now();
    const anyPastWindow = evictedServices.some(
      svc => !isWithinAutoRestakeWindow(svc, s.autoRestake, now),
    );
    if (anyPastWindow) {
      out.push({
        kind: 'service_evicted',
        severity: 'blocking',
        message: 'A service has been evicted from staking. Re-stake to resume.',
        jumpTo: '/overview',
      });
    }
  }

  if (s.services.some(svc => !svc.safeBound)) {
    out.push({
      kind: 'safe_binding_pending',
      severity: 'warning',
      message: 'Safe wallet binding is pending.',
      jumpTo: '/overview',
    });
  }

  if (s.restartPending) {
    out.push({
      kind: 'restart_required',
      severity: 'warning',
      message: 'A configuration change is pending — restart to apply.',
      // The Restart button lives on Overview (HeroStats's status tile). Per Ritsu's
      // review of #426, /operator is the wrong target — no restart UI lives there.
      jumpTo: '/overview',
    });
  }

  if (s.latestVersion && s.latestVersion !== s.daemonVersion) {
    out.push({
      kind: 'update_available',
      severity: 'info',
      message: `Daemon ${s.latestVersion} available (running ${s.daemonVersion}).`,
    });
  }

  if (s.passwordRotatedAt) {
    const now = input.now ?? Date.now();
    const age = now - new Date(s.passwordRotatedAt).getTime();
    if (age > PASSWORD_ROTATION_INTERVAL_MS) {
      out.push({
        kind: 'password_rotation_due',
        severity: 'info',
        message: 'Keystore password is over 90 days old.',
        jumpTo: '/operator/security',
      });
    }
  }

  return out;
}
