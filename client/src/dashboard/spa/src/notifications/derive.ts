import type { OperatorNotification } from './taxonomy.js';

// Loose shape — refine to the concrete BootstrapState + StatusSnapshot types
// when wiring this up in Task 1.4. Kept loose here so the deriver can be tested
// in isolation without dragging the full status schema into the notifications module.
export interface DeriveInput {
  /** milliseconds since epoch; defaults to Date.now() if omitted */
  now?: number;
  bootstrap: { mode: string; blockingReason?: string };
  status: {
    funds: { eth: string; runwayDays: number };
    rewards: { claimableWei: string };
    harness: { ready: boolean; name: string; reason?: string };
    rpc: { reachable: boolean };
    restartPending: boolean;
    daemonVersion: string;
    latestVersion?: string;
    services: { evicted: boolean; safeBound: boolean }[];
    joinedSolverNets: Record<string, unknown>;
    passwordRotatedAt?: string; // ISO
  };
}

const RUNWAY_LOW_THRESHOLD_DAYS = 3;
const PASSWORD_ROTATION_INTERVAL_MS = 1000 * 60 * 60 * 24 * 90;

function safeBigInt(s: string | undefined): bigint {
  if (!s) return 0n;
  try {
    return BigInt(s);
  } catch {
    return 0n;
  }
}

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
    out.push({
      kind: 'harness_not_ready',
      severity: 'blocking',
      message: `Harness ${s.harness.name} is not ready${s.harness.reason ? `: ${s.harness.reason}` : ''}.`,
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

  if (s.services.some(svc => svc.evicted)) {
    out.push({
      kind: 'service_evicted',
      severity: 'blocking',
      message: 'A service has been evicted from staking. Re-stake to resume.',
      jumpTo: '/overview',
    });
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

  if (safeBigInt(s.rewards.claimableWei) > 0n) {
    out.push({
      kind: 'claim_available',
      severity: 'info',
      message: 'JINN rewards are claimable.',
      jumpTo: '/overview',
    });
  }

  return out;
}
