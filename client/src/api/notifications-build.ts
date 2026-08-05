/**
 * Pure server-side notification derivation (spec/2026-08-04-headless-operator-rederivation-design.md
 * §6.5, issue #2408).
 *
 * Ports `client/src/dashboard/spa/src/notifications/derive.ts`'s `deriveNotifications` — a pure
 * function over receipts + the live-health class — to the daemon, plus the two RPC-health kinds
 * the browser bundle could never implement (no access to the boot-time RPC probe) and the
 * evidence-indexing kind (server-side driver state exists; the browser never had it either).
 *
 * `claim_failed` is event-driven (the SSE ring, not a snapshot) — kept pure here by accepting
 * an already-computed `{ count, sinceMs }` summary; `notifications-endpoint.ts` reads the ring
 * buffer and calls {@link countRecentClaimFailures} to produce it.
 *
 * **Per-kind reconciliation (16 canonical kinds, OPERATOR-APP-SPEC §2.10):**
 * - 14 ported unchanged in spirit from the browser deriver: `funding_low`, `funding_empty`,
 *   `password_rotation_due`, `harness_not_ready`, `bootstrap_blocked`, `restart_required`
 *   (semantic CHANGE — see below), `update_available`, `rpc_unreachable`, `no_solvernets_joined`,
 *   `safe_binding_pending`, `claim_failed` (moved from the SSE-ring hook to here),
 *   `config_migrated`, `unreleased_attempt`, `evidence_indexing_failed`.
 * - 2 newly implemented here: `rpc_all_failed`, `rpc_primary_degraded` — derivable only from the
 *   live-health class's RPC slot health, which the browser bundle never had.
 * - `unreleased_attempt` stays a **dead kind**: no server-side producer tracks "claimed on chain,
 *   occupying a `maxClaims` slot, not yet reaped" (verified — no such state exists in the store,
 *   claim-policy, or fleet modules). `NotificationsBuildInput` carries no field for it; wiring it
 *   is future work once that tracking exists.
 * - `evidence_indexing_failed` IS wired here (unlike the browser, which never had one) — the
 *   `EvidenceDriverLoop`'s cached failure list (`StatusGatherConfig.evidenceDriver`, already
 *   threaded for `/v1/status`) is a real server-side producer.
 *
 * **`restart_required` semantic change (flagged per the issue):** the browser derived this from
 * a `restartPending` boolean set by a same-session UI gesture (editing a restart-required config
 * field in the SPA) — session-local, lost on reload. Server-side it is
 * *config-file-newer-than-boot*: the operator's config file's mtime is compared against the
 * daemon's recorded start time (`notifications-endpoint.ts` does the `fs.statSync` + compare;
 * this module just takes the resulting boolean). This is a genuine behavior change: an operator
 * who edits `config.json` directly (not through the SPA) now sees the notice, and a same-session
 * SPA edit that the daemon hot-applies without needing a restart no longer clears the notice
 * until the config file's mtime naturally predates a later boot. All consumers (SPA, any future
 * CLI/console reader of this endpoint) see the same server-computed answer.
 */
import { NOTIFICATION_KINDS, type NotificationKind, type NotificationV1 } from './contract/notifications.js';

export const RUNWAY_LOW_THRESHOLD_DAYS = 3;
export const PASSWORD_ROTATION_INTERVAL_MS = 1000 * 60 * 60 * 24 * 90;
/** Wall-clock window for the event-driven `claim_failed` kind (issue #442's server-side home). */
export const CLAIM_FAILED_WINDOW_MS = 30 * 60 * 1000;

const KIND_TITLES: Record<NotificationKind, string> = {
  funding_low: 'Gas runway low',
  funding_empty: 'Gas exhausted',
  password_rotation_due: 'Password rotation due',
  harness_not_ready: 'Harness not ready',
  bootstrap_blocked: 'Bootstrap blocked',
  restart_required: 'Restart required',
  update_available: 'Update available',
  rpc_unreachable: 'RPC unreachable',
  rpc_all_failed: 'All RPC endpoints failed',
  rpc_primary_degraded: 'Primary RPC degraded',
  no_solvernets_joined: 'No SolverNets joined',
  safe_binding_pending: 'Safe binding pending',
  claim_failed: 'Claim failed',
  config_migrated: 'Config migrated',
  unreleased_attempt: 'Unreleased attempt',
  evidence_indexing_failed: 'Evidence indexing failed',
};

// Referenced so the exhaustiveness of KIND_TITLES against the canonical vocabulary
// is checked at compile time (a missing entry is a TS error on the Record type above);
// this line only guards against KIND_TITLES silently growing an extra, non-canonical key.
void (NOTIFICATION_KINDS satisfies readonly string[]);

function notice(
  kind: NotificationKind,
  severity: NotificationV1['severity'],
  message: string,
  extra?: { jumpTo?: string; details?: Record<string, unknown> },
): NotificationV1 {
  return {
    kind,
    severity,
    title: KIND_TITLES[kind],
    message,
    ...(extra?.jumpTo !== undefined ? { jumpTo: extra.jumpTo } : {}),
    ...(extra?.details !== undefined ? { details: extra.details } : {}),
  };
}

/**
 * Single source of the gas-runway severity rule (#1296): blocking when the balance can't cover
 * the next tx (`balanceWei < minEthWei`), warning when the remaining runway is under
 * {@link RUNWAY_LOW_THRESHOLD_DAYS}. Server-side twin of the SPA's
 * `notifications/gas-severity.ts` (kept there too for the WalletCard tint, which reads
 * `/v1/status` directly and has no reason to round-trip through this endpoint).
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

export interface FundsChain {
  chain: string;
  wallet: string | null;
  runwayDays: number;
  empty: boolean;
}

/** The subset of `StatusV1Response`'s `masterGas` / `l1MasterGas` gas blocks this module needs. */
export interface GasBlockLike {
  address: string | null;
  balanceWei?: string;
  runwayDaysExcess?: string;
  minEthWei?: string;
}

/**
 * Server-side twin of `useNotifications.ts`'s (pre-#2408) `gasChain` adapter: turns one gas
 * block into a `funds.chains` entry, or `null` when the block carries no balance (older
 * daemons / partial responses, or L1 simply absent on mainnet). `runwayDays` is
 * `Number.POSITIVE_INFINITY` when not computable, so `funding_low` stays silent; `empty` is the
 * stronger "can't cover the next tx" signal (`balanceWei < minEthWei`), matching
 * {@link gasSeverity}'s `'blocking'` case exactly.
 */
export function fundsChainFromGasBlock(chain: string, gas: GasBlockLike | undefined): FundsChain | null {
  if (!gas || gas.balanceWei === undefined) return null;
  let runwayDays = Number.POSITIVE_INFINITY;
  if (gas.runwayDaysExcess !== undefined) {
    const n = Number(gas.runwayDaysExcess);
    if (Number.isFinite(n)) runwayDays = n;
  }
  const empty = gasSeverity(gas) === 'blocking';
  return { chain, wallet: gas.address, runwayDays, empty };
}

/** Per-slot boot-probe health, reduced to the two fields this deriver needs. */
export interface RpcSlotHealthLike {
  ok: boolean;
  /** Already masked by the daemon before this point (see `bootstrap-endpoint.ts`). */
  host: string;
}

export interface NotificationsBuildInput {
  /** milliseconds since epoch; defaults to Date.now() if omitted */
  now?: number;
  bootstrapMode: 'uninitialized' | 'setup' | 'running';
  bootstrapBlockingReason?: string;
  joinedSolverNets: Record<string, unknown>;
  funds: { chains: FundsChain[] };
  harness: { ready: boolean; name: string | null; reason: string | null };
  rpc: { reachable: boolean };
  /** Boot-time RPC fallback-chain probe (main.ts's `lastL2Probe`) — absent ⇒ neither
   *  `rpc_all_failed` nor `rpc_primary_degraded` can fire. */
  rpcSlotHealth?: readonly RpcSlotHealthLike[];
  /** config-file-mtime-newer-than-daemon-start-time — see module docstring. */
  restartRequired: boolean;
  daemonVersion: string;
  latestVersion?: string;
  services: { safeBound: boolean }[];
  passwordRotatedAt?: string;
  configMigration?: {
    shapeVersion: 2;
    wiringEntries: number;
    postingEntries: number;
    capsUnset: boolean;
  };
  /** Count of currently-failing evidence-indexing records (`EvidenceDriverLoop`). */
  evidenceIndexingFailureCount?: number;
  /** Pre-computed event-ring summary for the last {@link CLAIM_FAILED_WINDOW_MS} — see
   *  {@link countRecentClaimFailures}. */
  claimFailed?: { count: number; sinceMs: number } | null;
}

export function buildNotifications(input: NotificationsBuildInput): NotificationV1[] {
  const out: NotificationV1[] = [];

  if (input.bootstrapMode !== 'running') {
    out.push(
      notice(
        'bootstrap_blocked',
        'blocking',
        input.bootstrapBlockingReason ?? 'Bootstrap incomplete',
        { jumpTo: '/' },
      ),
    );
  }

  for (const c of input.funds.chains) {
    const walletLabel = c.wallet ?? 'wallet';
    if (c.empty) {
      out.push(
        notice(
          'funding_empty',
          'blocking',
          `Gas exhausted — ${walletLabel} on ${c.chain} can't cover the next transaction.`,
          { jumpTo: '/overview' },
        ),
      );
      continue; // empty supersedes low for this chain
    }
    if (c.runwayDays < RUNWAY_LOW_THRESHOLD_DAYS) {
      out.push(
        notice(
          'funding_low',
          'warning',
          `Gas runway low — ${walletLabel} on ${c.chain} below threshold; top up soon.`,
          { jumpTo: '/overview' },
        ),
      );
    }
  }

  if (!input.harness.ready) {
    const subject = input.harness.name === null ? 'A harness' : `Harness ${input.harness.name}`;
    const suffix = input.harness.reason ? `: ${input.harness.reason}` : '';
    out.push(
      notice('harness_not_ready', 'blocking', `${subject} is not ready${suffix}.`, {
        jumpTo: '/operator/memberships',
      }),
    );
  }

  if (!input.rpc.reachable) {
    out.push(notice('rpc_unreachable', 'blocking', 'RPC endpoint is unreachable.', {
      jumpTo: '/operator/network',
    }));
  }

  if (input.rpcSlotHealth && input.rpcSlotHealth.length > 0) {
    const allFailed = input.rpcSlotHealth.every((p) => !p.ok);
    if (allFailed) {
      const hosts = input.rpcSlotHealth.map((p) => p.host).join(', ');
      out.push(
        notice(
          'rpc_all_failed',
          'blocking',
          `Every RPC fallback slot failed: ${hosts}.`,
          { jumpTo: '/operator/network', details: { hosts: input.rpcSlotHealth.map((p) => p.host) } },
        ),
      );
    } else if (!input.rpcSlotHealth[0]!.ok) {
      out.push(
        notice(
          'rpc_primary_degraded',
          'info',
          `Primary RPC endpoint (${input.rpcSlotHealth[0]!.host}) degraded — a fallback slot is serving.`,
          { jumpTo: '/operator/network' },
        ),
      );
    }
  }

  if (Object.keys(input.joinedSolverNets).length === 0 && input.bootstrapMode === 'running') {
    out.push(
      notice('no_solvernets_joined', 'info', 'No SolverNets joined. Browse the registry to start earning.', {
        jumpTo: '/operator/registry',
      }),
    );
  }

  if (input.services.some((svc) => !svc.safeBound)) {
    out.push(notice('safe_binding_pending', 'warning', 'Safe wallet binding is pending.', {
      jumpTo: '/overview',
    }));
  }

  if (input.restartRequired) {
    out.push(
      notice('restart_required', 'warning', 'A configuration change is pending — restart to apply.', {
        jumpTo: '/overview',
      }),
    );
  }

  if (input.latestVersion && input.latestVersion !== input.daemonVersion) {
    out.push(
      notice(
        'update_available',
        'info',
        `Daemon ${input.latestVersion} available (running ${input.daemonVersion}).`,
      ),
    );
  }

  // Coordinator amendment 1 (F7 reversed — no claim-nothing migration): the one-time
  // shape-v2 migration message is always informational, never action-required. The
  // host's USD spend gates remain the operative bound regardless of whether per-claim
  // caps were carried over — `capsUnset` only changes the message copy, never the severity.
  if (input.configMigration !== undefined) {
    const m = input.configMigration;
    out.push(
      notice(
        'config_migrated',
        'info',
        m.capsUnset
          ? 'Claim policy and execution wiring were created from your SolverNet memberships. Per-claim caps are not set; the USD spend gates remain active.'
          : 'Claim policy and execution wiring were created from your SolverNet memberships.',
        { jumpTo: '/operator/claim-policy', details: { wiringEntries: m.wiringEntries, postingEntries: m.postingEntries } },
      ),
    );
  }

  if (input.passwordRotatedAt) {
    const now = input.now ?? Date.now();
    const age = now - new Date(input.passwordRotatedAt).getTime();
    if (age > PASSWORD_ROTATION_INTERVAL_MS) {
      out.push(notice('password_rotation_due', 'info', 'Keystore password is over 90 days old.', {
        jumpTo: '/operator/security',
      }));
    }
  }

  if (input.evidenceIndexingFailureCount && input.evidenceIndexingFailureCount > 0) {
    const n = input.evidenceIndexingFailureCount;
    out.push(
      notice(
        'evidence_indexing_failed',
        'info',
        `${n} evidence record${n === 1 ? '' : 's'} failed to index. The driver retries automatically.`,
      ),
    );
  }

  if (input.claimFailed && input.claimFailed.count > 0) {
    const n = input.claimFailed.count;
    out.push(
      notice(
        'claim_failed',
        'warning',
        `${n} claim attempt${n === 1 ? '' : 's'} failed in the last 30 minutes. Check Tasks for details.`,
        { jumpTo: '/overview', details: { count: n, sinceMs: input.claimFailed.sinceMs } },
      ),
    );
  }

  return out;
}

/** Minimal shape this module needs from a `StructuredEvent` (`src/events/types.ts`). */
export interface ClaimEventLike {
  kind: string;
  errorCode?: string;
  ts: string;
}

/**
 * Server-side home of the `claim_failed` 30-min window (moved from
 * `useNotifications.ts:187-217`). Reads the daemon's own event ring — see
 * `notifications-endpoint.ts` — rather than an SSE replay, so there is no reconnect-replay
 * duplication to dedupe (the ring never repeats an id to this reader).
 */
export function countRecentClaimFailures(
  events: readonly ClaimEventLike[],
  nowMs: number,
): { count: number; sinceMs: number } {
  const sinceMs = nowMs - CLAIM_FAILED_WINDOW_MS;
  let count = 0;
  for (const e of events) {
    if (e.kind !== 'intent' || e.errorCode !== 'claim_failed') continue;
    const eventMs = Date.parse(e.ts);
    if (Number.isNaN(eventMs) || eventMs < sinceMs) continue;
    count += 1;
  }
  return { count, sinceMs };
}
