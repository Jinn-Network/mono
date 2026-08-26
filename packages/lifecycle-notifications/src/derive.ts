import { NOTIFICATION_KINDS, type NotificationKind, type NotificationSeverity } from "./kinds.js";

export const RUNWAY_LOW_THRESHOLD_DAYS = 3;
export const PASSWORD_ROTATION_INTERVAL_MS = 1000 * 60 * 60 * 24 * 90;
export const CLAIM_FAILED_WINDOW_MS = 30 * 60 * 1000;

export interface DerivedNotice {
  kind: NotificationKind | string;
  severity: NotificationSeverity;
  title: string;
  message: string;
  jumpTo?: string;
  details?: Record<string, unknown>;
  [key: string]: unknown;
}

const KIND_TITLES: Record<NotificationKind, string> = {
  funding_low: "Gas runway low",
  funding_empty: "Gas exhausted",
  password_rotation_due: "Password rotation due",
  harness_not_ready: "Harness not ready",
  bootstrap_blocked: "Bootstrap blocked",
  restart_required: "Restart required",
  update_available: "Update available",
  rpc_unreachable: "RPC unreachable",
  rpc_all_failed: "All RPC endpoints failed",
  rpc_primary_degraded: "Primary RPC degraded",
  no_solvernets_joined: "No SolverNets joined",
  safe_binding_pending: "Safe binding pending",
  claim_failed: "Claim failed",
  config_migrated: "Config migrated",
  unreleased_attempt: "Unreleased attempt",
  evidence_indexing_failed: "Evidence indexing failed",
};

void (NOTIFICATION_KINDS satisfies readonly string[]);

function notice(
  kind: NotificationKind,
  severity: DerivedNotice["severity"],
  message: string,
  extra?: { jumpTo?: string; details?: Record<string, unknown> },
): DerivedNotice {
  return {
    kind,
    severity,
    title: KIND_TITLES[kind],
    message,
    ...(extra?.jumpTo !== undefined ? { jumpTo: extra.jumpTo } : {}),
    ...(extra?.details !== undefined ? { details: extra.details } : {}),
  };
}

export function gasSeverity(gas: {
  balanceWei?: string;
  runwayDaysExcess?: string | number | null;
  minEthWei?: string;
}): "warning" | "blocking" | null {
  if (!gas || gas.balanceWei === undefined) return null;
  try {
    if (gas.minEthWei !== undefined && BigInt(gas.balanceWei) < BigInt(gas.minEthWei)) {
      return "blocking";
    }
  } catch {
    /* non-numeric */
  }
  const days = Number(gas.runwayDaysExcess);
  if (Number.isFinite(days) && days < RUNWAY_LOW_THRESHOLD_DAYS) return "warning";
  return null;
}

export interface FundsChain {
  chain: string;
  wallet: string | null;
  runwayDays: number;
  empty: boolean;
}

export interface GasBlockLike {
  address: string | null;
  balanceWei?: string;
  runwayDaysExcess?: string;
  minEthWei?: string;
}

export function fundsChainFromGasBlock(chain: string, gas: GasBlockLike | undefined): FundsChain | null {
  if (!gas || gas.balanceWei === undefined) return null;
  let runwayDays = Number.POSITIVE_INFINITY;
  if (gas.runwayDaysExcess !== undefined) {
    const n = Number(gas.runwayDaysExcess);
    if (Number.isFinite(n)) runwayDays = n;
  }
  const empty = gasSeverity(gas) === "blocking";
  return { chain, wallet: gas.address, runwayDays, empty };
}

export interface RpcSlotHealthLike {
  ok: boolean;
  host: string;
}

export interface NotificationsBuildInput {
  now?: number;
  bootstrapMode: "uninitialized" | "setup" | "running";
  bootstrapBlockingReason?: string;
  executionWiring: readonly unknown[];
  funds: { chains: FundsChain[] };
  harness: { ready: boolean; name: string | null; reason: string | null };
  rpc: { reachable: boolean };
  rpcSlotHealth?: readonly RpcSlotHealthLike[];
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
  evidenceIndexingFailureCount?: number;
  claimFailed?: { count: number; sinceMs: number } | null;
}

export function buildNotifications(input: NotificationsBuildInput): DerivedNotice[] {
  const out: DerivedNotice[] = [];

  if (input.bootstrapMode !== "running") {
    out.push(
      notice(
        "bootstrap_blocked",
        "blocking",
        input.bootstrapBlockingReason ?? "Bootstrap incomplete",
        { jumpTo: "/" },
      ),
    );
  }

  for (const c of input.funds.chains) {
    const walletLabel = c.wallet ?? "wallet";
    if (c.empty) {
      out.push(
        notice(
          "funding_empty",
          "blocking",
          `Gas exhausted — ${walletLabel} on ${c.chain} can't cover the next transaction.`,
          { jumpTo: "/overview" },
        ),
      );
      continue;
    }
    if (c.runwayDays < RUNWAY_LOW_THRESHOLD_DAYS) {
      out.push(
        notice(
          "funding_low",
          "warning",
          `Gas runway low — ${walletLabel} on ${c.chain} below threshold; top up soon.`,
          { jumpTo: "/overview" },
        ),
      );
    }
  }

  if (!input.harness.ready) {
    const subject = input.harness.name === null ? "A harness" : `Harness ${input.harness.name}`;
    const suffix = input.harness.reason ? `: ${input.harness.reason}` : "";
    out.push(notice("harness_not_ready", "blocking", `${subject} is not ready${suffix}.`, {
        jumpTo: "/operator/claim-policy",
    }));
  }

  if (input.rpcSlotHealth && input.rpcSlotHealth.length > 0) {
    const allSlotsFailed = input.rpcSlotHealth.every((p) => !p.ok);
    const primaryFailed = !input.rpcSlotHealth[0]!.ok;
    if (allSlotsFailed) {
      if (!input.rpc.reachable) {
        const hosts = input.rpcSlotHealth.map((p) => p.host).join(", ");
        out.push(
          notice(
            "rpc_all_failed",
            "blocking",
            `Every RPC fallback slot failed: ${hosts}.`,
            { jumpTo: "/operator/network", details: { hosts: input.rpcSlotHealth.map((p) => p.host) } },
          ),
        );
      }
    } else if (primaryFailed) {
      out.push(
        notice(
          "rpc_primary_degraded",
          "info",
          `Primary RPC endpoint (${input.rpcSlotHealth[0]!.host}) degraded — a fallback slot is serving.`,
          { jumpTo: "/operator/network" },
        ),
      );
    }
  }

  if (input.executionWiring.length === 0 && input.bootstrapMode === "running") {
    out.push(
      notice("no_solvernets_joined", "info", "No execution wiring configured. Add a work kind in Claim policy.", {
        jumpTo: "/operator/claim-policy",
      }),
    );
  }

  if (input.services.some((svc) => !svc.safeBound)) {
    out.push(notice("safe_binding_pending", "warning", "Safe wallet binding is pending.", {
      jumpTo: "/overview",
    }));
  }

  if (input.restartRequired) {
    out.push(
      notice("restart_required", "warning", "A configuration change is pending — restart to apply.", {
        jumpTo: "/overview",
      }),
    );
  }

  if (input.latestVersion && input.latestVersion !== input.daemonVersion) {
    out.push(
      notice(
        "update_available",
        "info",
        `Daemon ${input.latestVersion} available (running ${input.daemonVersion}).`,
      ),
    );
  }

  if (input.configMigration !== undefined) {
    const m = input.configMigration;
    out.push(
      notice(
        "config_migrated",
        "info",
        m.capsUnset
          ? "Claim policy and execution wiring were created from your SolverNet memberships. Per-claim caps are not set; the USD spend gates remain active."
          : "Claim policy and execution wiring were created from your SolverNet memberships.",
        { jumpTo: "/operator/claim-policy", details: { wiringEntries: m.wiringEntries, postingEntries: m.postingEntries } },
      ),
    );
  }

  if (input.passwordRotatedAt) {
    const now = input.now ?? Date.now();
    const age = now - new Date(input.passwordRotatedAt).getTime();
    if (age > PASSWORD_ROTATION_INTERVAL_MS) {
      out.push(notice("password_rotation_due", "info", "Keystore password is over 90 days old.", {
        jumpTo: "/operator/security",
      }));
    }
  }

  if (input.evidenceIndexingFailureCount && input.evidenceIndexingFailureCount > 0) {
    const n = input.evidenceIndexingFailureCount;
    out.push(
      notice(
        "evidence_indexing_failed",
        "info",
        `${n} evidence record${n === 1 ? "" : "s"} failed to index. The driver retries automatically.`,
      ),
    );
  }

  if (input.claimFailed && input.claimFailed.count > 0) {
    const n = input.claimFailed.count;
    out.push(
      notice(
        "claim_failed",
        "warning",
        `${n} claim attempt${n === 1 ? "" : "s"} failed in the last 30 minutes. Check Tasks for details.`,
        { jumpTo: "/overview", details: { count: n, sinceMs: input.claimFailed.sinceMs } },
      ),
    );
  }

  return out;
}

export interface ClaimEventLike {
  kind: string;
  errorCode?: string;
  ts: string;
}

export function countRecentClaimFailures(
  events: readonly ClaimEventLike[],
  nowMs: number,
): { count: number; sinceMs: number } {
  const sinceMs = nowMs - CLAIM_FAILED_WINDOW_MS;
  let count = 0;
  for (const e of events) {
    if (e.kind !== "intent" || e.errorCode !== "claim_failed") continue;
    const eventMs = Date.parse(e.ts);
    if (Number.isNaN(eventMs) || eventMs < sinceMs) continue;
    count += 1;
  }
  return { count, sinceMs };
}
