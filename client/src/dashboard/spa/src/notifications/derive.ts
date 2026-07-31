import type { OperatorNotification } from './taxonomy.js';

// Loose shape — refine to the concrete BootstrapState + StatusSnapshot types
// when wiring this up in Task 1.4. Kept loose here so the deriver can be tested
// in isolation without dragging the full status schema into the notifications module.
export interface DeriveInput {
  /** milliseconds since epoch; defaults to Date.now() if omitted */
  now?: number;
  bootstrap: { mode: string; blockingReason?: string };
  status: {
    funds: {
      eth: string;
      chains: Array<{
        chain: string;
        wallet: string | null;
        runwayDays: number;
        empty: boolean;
      }>;
    };
    harness: { ready: boolean; name: string | null; reason: string | null };
    rpc: { reachable: boolean };
    restartPending: boolean;
    daemonVersion: string;
    latestVersion?: string;
    services: { safeBound: boolean }[];
    joinedSolverNets: Record<string, unknown>;
    passwordRotatedAt?: string; // ISO
    /**
     * One-time shape-v2 config migration report — mirrors
     * `client/src/api/status-build.ts`'s `ConfigMigrationStatus`. Present
     * only on the boot where the daemon auto-migrated a legacy config.
     */
    configMigration?: {
      shapeVersion: 2;
      wiringEntries: number;
      postingEntries: number;
      backupPath?: string;
      capsUnset: boolean;
    };
  };
}

const RUNWAY_LOW_THRESHOLD_DAYS = 3;
const PASSWORD_ROTATION_INTERVAL_MS = 1000 * 60 * 60 * 24 * 90;

/**
 * Single source of the gas-runway severity rule (#1296): blocking when the
 * balance can't cover the next tx (`balanceWei < minEthWei`), warning when
 * the remaining runway is under {@link RUNWAY_LOW_THRESHOLD_DAYS}. Consumed
 * by both the notifications deriver's chain mapping (`gasChain` in
 * `useNotifications.ts`) and the Wallet card's tint on Overview — previously
 * each restated this threshold independently.
 */
export function gasSeverity(gas: {
  balanceWei?: string;
  runwayDaysExcess?: string | number | null;
  minEthWei?: string;
}): 'warning' | 'blocking' | null {
  if (!gas || gas.balanceWei === undefined) return null;
  try {
    if (gas.minEthWei !== undefined && BigInt(gas.balanceWei) < BigInt(gas.minEthWei)) {
      return 'blocking';
    }
  } catch {
    /* non-numeric */
  }
  const days = Number(gas.runwayDaysExcess);
  if (Number.isFinite(days) && days < RUNWAY_LOW_THRESHOLD_DAYS) return 'warning';
  return null;
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

  for (const c of s.funds.chains) {
    const walletLabel = c.wallet ?? 'wallet';
    if (c.empty) {
      out.push({
        kind: 'funding_empty',
        severity: 'blocking',
        message: `Gas exhausted — ${walletLabel} on ${c.chain} can't cover the next transaction.`,
        jumpTo: '/overview',
      });
      continue; // empty supersedes low for this chain
    }
    if (c.runwayDays < RUNWAY_LOW_THRESHOLD_DAYS) {
      out.push({
        kind: 'funding_low',
        severity: 'warning',
        message: `Gas runway low — ${walletLabel} on ${c.chain} below threshold; top up soon.`,
        jumpTo: '/overview',
      });
    }
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

  // Coordinator amendment 1 (F7 reversed — no claim-nothing migration): the
  // one-time shape-v2 migration message is always informational, never
  // action-required. The host's USD spend gates (spec §6.5) remain the
  // operative bound regardless of whether per-claim caps got carried over —
  // `capsUnset` only changes the message copy, never the severity.
  if (s.configMigration !== undefined) {
    const m = s.configMigration;
    out.push({
      kind: 'config_migrated',
      severity: 'info',
      message: m.capsUnset
        ? 'Claim policy and execution wiring were created from your SolverNet memberships. Per-claim caps are not set; the USD spend gates remain active.'
        : 'Claim policy and execution wiring were created from your SolverNet memberships.',
      jumpTo: '/operator/claim-policy',
      details: { wiringEntries: m.wiringEntries, postingEntries: m.postingEntries },
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
