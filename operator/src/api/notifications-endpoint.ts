/**
 * `GET /v1/notifications` (spec/2026-08-04-headless-operator-rederivation-design.md §6.5,
 * issue #2408; mechanism amended per PR #2424 review).
 *
 * Operator-class, token-gated like its siblings (see `server.ts`'s `requireOperatorToken`
 * gate). Assembles a `NotificationsBuildInput` from the SAME internal sources `/v1/status`
 * uses — `gatherGatheredStatusRaw` + `assembleStatusV1` (`gather-status.ts` / `status-build.ts`),
 * shared with `/v1/status` and `/v1/rewards` behind a ~3s TTL cache
 * (`gathered-status-cache.ts`, review finding F3) — plus the bootstrap fleet-state file, the
 * boot-time RPC slot-health probe, and the daemon's own event ring. Nothing here round-trips
 * through the serialized `/v1/status` HTTP payload.
 *
 * **`restart_required` mechanism (review finding F1).** NOT config-file-mtime — that fires
 * permanently for onboarding-complete / pricing writes, which hot-apply while still bumping the
 * file's mtime. Reads the explicit `isRestartRequired()` flag (`restart-required-state.ts`),
 * set only by the three write paths the daemon never hot-applies (claim-policy, joinedSolverNets
 * join-failure-or-absent-applier / leave, rpcUrl).
 *
 * **`rpc_all_failed` / `rpc_primary_degraded` (review finding F2).** The boot-time RPC
 * fallback-chain probe is captured ONCE at startup (`retryCount: 0`) and never re-probed —
 * CLAUDE.md's RPC fallback-chain docs are explicit that a boot-time 429/5xx on a secondary slot
 * never gates anything. Treating boot-probe-only evidence as a permanent blocking signal would
 * be exactly that kind of false gate. So `rpc_all_failed` requires the LIVE read (`raw.rpc.ok`,
 * the same read `/v1/status.rpc` reports) to ALSO be failing before it fires — boot-probe-only
 * "every slot failed at boot" with a currently-healthy live read produces no notification.
 * `rpc_primary_degraded` is unchanged: the spec explicitly blesses the boot probe alone for
 * that one (a degraded-but-serving fallback is exactly the boot probe's design intent).
 *
 * **`rpc_unreachable` is NOT emitted here (review finding F4).** The daemon-offline condition is
 * a client-local overlay by construction (spec §6 composition item 5) — a server cannot report
 * its own unreachability. The kind stays in the vocabulary (`OfflineNotice` produces it
 * client-side); chain-RPC health is covered by the two RPC-health kinds above. `raw.rpc.ok` is
 * still read here, but only as the F2 live-agreement input, never to emit `rpc_unreachable`
 * itself.
 *
 * **`claim_failed`, two semantic notes (review finding F5):**
 * 1. *Restart zeroes the window.* The event ring (`../events/emitter.js`) is in-memory; a
 *    daemon restart clears it, so a failure burst immediately before a restart is invisible to
 *    this endpoint afterward. Accepted — the pre-#2408 SSE-backfill path had the identical
 *    property (the ring it read from was the same in-memory buffer).
 * 2. *Ring-capacity undercount bound.* The ring caps at 1000 events across ALL kinds, not just
 *    `claim_failed`. If more than 1000 `intent`-kind events land within the 30-minute window,
 *    older `claim_failed` events can be evicted before this endpoint counts them — an
 *    undercount, never an overcount. Not fixed here; the bound is named so a future caller
 *    doesn't assume exactness.
 *
 * **Dead kind, documented (per the issue's per-kind reconciliation requirement):**
 * `unreleased_attempt` is NOT wired — no server-side state tracks "claimed on chain, occupying
 * a `maxClaims` slot, not yet reaped" anywhere in the store, claim-policy, or fleet modules.
 * Wiring it is future work once that tracking exists; see `notifications-build.ts`'s docstring
 * for the full 16-kind table.
 */
import type { Hono } from 'hono';
import { cachePolicyHeaders } from '@jinn-network/read-plane';
import type { Store } from '../store/store.js';
import { getCachedGatheredStatus } from './gathered-status-cache.js';
import type { gatherGatheredStatusRaw, StatusGatherConfig } from './gather-status.js';
import type { assembleStatusV1 } from './status-build.js';
import { readBootstrapError } from '../errors/persisted-bootstrap-error.js';
import { isOperationalServiceStep } from '../earning/types.js';
import { getEventBuffer } from '../events/emitter.js';
import { maskUrlsInMessage } from '../rpc/transport.js';
import { isRestartRequired } from './restart-required-state.js';
import {
  notificationSchema,
  type NotificationsV1Response,
  type NotificationV1,
} from './contract/notifications.js';
import { CURRENT_CONTRACT_VERSION } from './contract/version.js';
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
    | { rpcSlotHealth?: readonly RpcSlotHealthLike[]; executionWiring?: readonly unknown[] }
    | undefined;
  /** Overrides for the shared cache's underlying gather/assemble (tests only). */
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

export function addNotificationsRoutes(app: Hono, deps: NotificationsRoutesConfig): void {
  const now = deps.now ?? (() => Date.now());

  app.get('/v1/notifications', async (c) => {
    try {
      const status = deps.getStatus();
      // Deliberately do NOT forward this endpoint's `now` (review round 2, finding N5) — the
      // cache is a process-wide singleton shared with /v1/status and /v1/rewards, so a test
      // that fakes `now` for notification-derivation reasons (password-rotation timing,
      // claim-failed window) must not also warp the shared cache's OWN TTL bookkeeping. The
      // cache gets its own clock (real `Date.now` in production; its own tests inject `now`
      // directly against `getCachedGatheredStatus`, independent of this endpoint).
      const { raw, assembled } = await getCachedGatheredStatus(deps.store, status, {
        gatherRaw: deps.gatherRaw,
        assemble: deps.assemble,
      });
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
        executionWiring: extras?.executionWiring ?? [],
        funds: { chains },
        harness: assembled.harness,
        rpc: { reachable: assembled.rpc.ok },
        rpcSlotHealth: extras?.rpcSlotHealth,
        restartRequired: isRestartRequired(),
        daemonVersion: assembled.version,
        latestVersion: assembled.latestVersion ?? undefined,
        services: assembled.fleet.services.map((s) => ({ safeBound: s.safeBoundToAgent })),
        passwordRotatedAt: assembled.security.lastPasswordRotationAt ?? undefined,
        configMigration: assembled.configMigration,
        evidenceIndexingFailureCount,
        claimFailed,
      };

      const notifications = notificationSchema.array().parse(
        buildNotifications(input).sort(
          (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity],
        ),
      );

      const body: NotificationsV1Response = {
        schemaVersion: 1,
        contractVersion: CURRENT_CONTRACT_VERSION,
        generatedAt: new Date(nowMs).toISOString(),
        notifications,
      };
      for (const [name, value] of Object.entries(cachePolicyHeaders({ generatedAt: body.generatedAt }))) {
        c.header(name, value);
      }
      return c.json(body);
    } catch (err) {
      const message = maskUrlsInMessage(err instanceof Error ? err.message : String(err));
      return c.json(
        {
          schemaVersion: 1,
          contractVersion: CURRENT_CONTRACT_VERSION,
          generatedAt: new Date().toISOString(),
          notifications: [],
          error: message,
        },
        500,
      );
    }
  });
}
