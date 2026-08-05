/**
 * `GET /v1/notifications` (spec/2026-08-04-headless-operator-rederivation-design.md §6.5,
 * issue #2408).
 *
 * Operator-class, token-gated like its siblings (see `server.ts`'s
 * `requireOperatorToken` gate). Assembles a `NotificationsBuildInput` from the SAME internal
 * sources `/v1/status` uses — `gatherGatheredStatusRaw` + `assembleStatusV1`
 * (`gather-status.ts` / `status-build.ts`), plus the bootstrap fleet-state file, the boot-time
 * RPC slot-health probe, and the daemon's own event ring — and hands it to the pure
 * `buildNotifications` (`notifications-build.ts`). This is an in-process call graph; nothing
 * here round-trips through the serialized `/v1/status` HTTP payload.
 *
 * **Dead kind, documented (per the issue's per-kind reconciliation requirement):**
 * `unreleased_attempt` is NOT wired — no server-side state tracks "claimed on chain, occupying
 * a `maxClaims` slot, not yet reaped" anywhere in the store, claim-policy, or fleet modules.
 * Wiring it is future work once that tracking exists; see `notifications-build.ts`'s docstring
 * for the full 16-kind table.
 */
import type { Hono } from 'hono';
import { existsSync, statSync } from 'node:fs';
import type { Store } from '../store/store.js';
import {
  gatherGatheredStatusRaw,
  type StatusGatherConfig,
} from './gather-status.js';
import { assembleStatusV1 } from './status-build.js';
import { readBootstrapError } from '../errors/persisted-bootstrap-error.js';
import { isOperationalServiceStep } from '../earning/types.js';
import { getEventBuffer } from '../events/emitter.js';
import { maskUrlsInMessage } from '../rpc/transport.js';
import type { NotificationsV1Response, NotificationV1 } from './contract/notifications.js';
import {
  buildNotifications,
  countRecentClaimFailures,
  fundsChainFromGasBlock,
  type NotificationsBuildInput,
  type RpcSlotHealthLike,
} from './notifications-build.js';

const SEVERITY_ORDER: Record<NotificationV1['severity'], number> = {
  blocking: 0,
  warning: 1,
  info: 2,
};

export interface NotificationsRoutesConfig {
  store: Store;
  getStatus: () => StatusGatherConfig | undefined;
  /**
   * Same bootstrap-config surface `/v1/bootstrap` reads (`bootstrap-endpoint.ts`'s
   * `configReader`) — reused here purely for its already-computed `rpcSlotHealth`
   * (main.ts's `lastL2Probe`) and `joinedSolverNets`, never for its assembled JSON.
   */
  getBootstrapExtras?: () =>
    | { rpcSlotHealth?: readonly RpcSlotHealthLike[]; joinedSolverNets?: Record<string, unknown> }
    | undefined;
  gatherRaw?: typeof gatherGatheredStatusRaw;
  assemble?: typeof assembleStatusV1;
  now?: () => number;
}

/**
 * `bootstrap.mode` computed the same way `bootstrap-endpoint.ts` computes it (services
 * non-empty and every one `isOperationalServiceStep` ⇒ `running`), but read from `raw.fleet`
 * — the exact same `FleetState` `gatherGatheredStatusRaw` already loaded for `/v1/status` —
 * rather than re-parsing `earning_state.json` a second time.
 */
function computeBootstrapMode(
  fleet: { services: ReadonlyArray<{ step: string }> } | null,
): 'uninitialized' | 'setup' | 'running' {
  if (!fleet) return 'uninitialized';
  const allRunning = fleet.services.length > 0 && fleet.services.every((s) => isOperationalServiceStep(s.step));
  return allRunning ? 'running' : 'setup';
}

/**
 * `restart_required`'s new semantic: config-file-newer-than-boot (see
 * `notifications-build.ts`'s docstring for the full rationale/behavior-change note).
 * Best-effort — a missing config file, missing daemon-start timestamp, or a stat failure all
 * degrade to `false` (never blocks the endpoint).
 */
function computeRestartRequired(configPath: string | undefined, daemonStartedAt: string | null): boolean {
  if (!configPath || !daemonStartedAt || !existsSync(configPath)) return false;
  const bootMs = Date.parse(daemonStartedAt);
  if (Number.isNaN(bootMs)) return false;
  try {
    return statSync(configPath).mtimeMs > bootMs;
  } catch {
    return false;
  }
}

export function addNotificationsRoutes(app: Hono, deps: NotificationsRoutesConfig): void {
  const gatherRaw = deps.gatherRaw ?? gatherGatheredStatusRaw;
  const assemble = deps.assemble ?? assembleStatusV1;
  const now = deps.now ?? (() => Date.now());

  app.get('/v1/notifications', async (c) => {
    try {
      const status = deps.getStatus();
      const raw = await gatherRaw(deps.store, status);
      const assembled = assemble(raw);
      const extras = deps.getBootstrapExtras?.();

      const nowMs = now();
      const events = getEventBuffer().snapshot({ kinds: ['intent'] });
      const claimFailed = countRecentClaimFailures(events, nowMs);

      const evidenceDriver = status?.evidenceDriver?.();
      const evidenceIndexingFailureCount = evidenceDriver
        ? (await evidenceDriver.failures()).length
        : undefined;

      const chains: NotificationsBuildInput['funds']['chains'] = [];
      const l2 = fundsChainFromGasBlock('Base Sepolia', assembled.masterGas);
      if (l2) chains.push(l2);
      const l1 = fundsChainFromGasBlock('Ethereum Sepolia', assembled.l1MasterGas);
      if (l1) chains.push(l1);

      const input: NotificationsBuildInput = {
        now: nowMs,
        bootstrapMode: computeBootstrapMode(raw.fleet),
        // The persisted bootstrap-error envelope's own text field (already-sanitized
        // bootstrap-phase copy) — not a viem RPC error. This file is RPC-adjacent (imports
        // `maskUrlsInMessage` below), so the no-error-leak guard would otherwise flag this
        // read too; marked exempt on the line itself. lint:no-error-leak-allow
        bootstrapBlockingReason: status?.earningDir
          ? readBootstrapError(status.earningDir)?.message // lint:no-error-leak-allow
          : undefined,
        joinedSolverNets: extras?.joinedSolverNets ?? {},
        funds: { chains },
        harness: assembled.harness,
        rpc: { reachable: assembled.rpc.ok },
        rpcSlotHealth: extras?.rpcSlotHealth,
        restartRequired: computeRestartRequired(status?.configPath, raw.daemonStartedAt ?? null),
        daemonVersion: assembled.version,
        latestVersion: assembled.latestVersion ?? undefined,
        services: assembled.fleet.services.map((s) => ({ safeBound: s.safeBoundToAgent })),
        passwordRotatedAt: assembled.security.lastPasswordRotationAt ?? undefined,
        configMigration: assembled.configMigration,
        evidenceIndexingFailureCount,
        claimFailed,
      };

      const notifications = buildNotifications(input).sort(
        (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity],
      );

      const body: NotificationsV1Response = {
        schemaVersion: 1,
        generatedAt: new Date(nowMs).toISOString(),
        notifications,
      };
      return c.json(body);
    } catch (err) {
      const message = maskUrlsInMessage(err instanceof Error ? err.message : String(err));
      return c.json(
        { schemaVersion: 1, generatedAt: new Date().toISOString(), notifications: [], error: message },
        500,
      );
    }
  });
}
