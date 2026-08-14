/**
 * Loop heartbeat helper (#1043, follow-up to the #1038 wedge).
 *
 * Each long-running daemon loop records a standardized "last tick" heartbeat at
 * the end of every iteration. The watchdog (watchdog-loop.ts) reads these rows
 * to detect a loop whose last tick has gone stale (frozen mid-iteration / RPC
 * wedge). The heartbeat is a NEW namespaced config row written ALONGSIDE the
 * pre-existing `last_*_tick_at` rows (which other surfaces — e.g.
 * gather-status.ts — already read); nothing here renames or replaces those.
 *
 * The stored value is `Date.now()` (wall-clock ms) as a string, so the watchdog
 * can compute staleness with a single subtraction and no Date parsing.
 */
import type { Store } from '../store/store.js';
import { emitEvent } from '../observability/emit-event.js';

/** Config-key namespace for per-loop heartbeats. */
export const LOOP_HEARTBEAT_PREFIX = 'loop_heartbeat:';

/**
 * The ten canonical long-running loops the watchdog supervises, with their
 * default poll intervals and (where a loop may block on chain I/O) a staleness
 * floor. Wave-4 D6 dropped `creator`, `engine-tick`, `engine-watcher`,
 * `delivery-watcher`, and `peer-sync` after D1–D4 deleted those loops.
 * Fleet state (checkpoint txs, eviction checks) stays in FleetStateStore;
 * eviction-check, checkpoint, and harvest heartbeats use this observability
 * Store.
 *
 * This registry is the single source of truth: LOOP_NAMES, the LoopName union,
 * and the daemon's watchdog registrations are all derived from it. Order is
 * load-bearing (LOOP_NAMES preserves it).
 *
 * `admission` (#2407, spec §5) classes each loop for degrade-open boot:
 * `ready-only` loops are the claim/work path and do not tick while daemon
 * readiness is `degraded`; `always` loops are the self-healing economic
 * loops (eviction recovery, checkpoint, balance top-up, reward claim, …)
 * — they keep running so a degraded condition can clear on its own. See
 * `runLoop` below for where this is consulted.
 */
export const LOOP_REGISTRY = [
  // Native posting loop (one-swap M5, #2461). Drives the requester's
  // `posting[]` config through the marketplace binding. Opt-in — only
  // registered with the watchdog when a `PostingLoop` is actually started
  // (native mode + non-empty posting[]); a legacy boot never constructs it.
  { name: 'posting', intervalMs: 5000, admission: 'ready-only' },
  { name: 'reward-claim', intervalMs: 5000, admission: 'always' },
  { name: 'balance-topup', intervalMs: 5000, admission: 'always' },
  { name: 'eviction-check', intervalMs: 60_000, admission: 'always' },
  { name: 'checkpoint', intervalMs: 300_000, admission: 'always' },
  // Commit-echo harvest loop (task-creator v0). Interval mirrors the config
  // default (config.ts `harvest.intervalMs`); the daemon only registers it
  // with the watchdog when config.harvest is enabled with repos.
  { name: 'harvest', intervalMs: 60 * 60 * 1000, admission: 'always' },
  { name: 'projector', intervalMs: 5000, floorMs: 300_000, admission: 'always' },
  { name: 'evidence-driver', intervalMs: 30_000, floorMs: 300_000, admission: 'always' },
  { name: 'work', intervalMs: 5000, floorMs: 300_000, admission: 'ready-only' },
  // Native evaluator loop (one-swap M4a, #2461). The evaluator counterpart of `work`: it drives
  // the native evaluator composition's tick (acquire subject material → evaluate → deliver+settle
  // a verdict) and, like `work`, also reconciles in-flight settlements on every tick (the M3 N2
  // ruling). Opt-in — only registered with the watchdog when an evaluator loop is actually
  // started (native mode + a configured evaluator deployment/identity store); a legacy or
  // native-solver-only boot never constructs it. `ready-only` like `work`.
  { name: 'evaluator', intervalMs: 5000, floorMs: 300_000, admission: 'ready-only' },
] as const satisfies readonly { name: string; intervalMs: number; floorMs?: number; admission: 'always' | 'ready-only' }[];

export const LOOP_NAMES = LOOP_REGISTRY.map(r => r.name);

export type LoopName = (typeof LOOP_REGISTRY)[number]['name'];
export type LoopAdmission = 'always' | 'ready-only';

const LOOP_ADMISSION = new Map<LoopName, LoopAdmission>(
  LOOP_REGISTRY.map(r => [r.name, r.admission]),
);

/** The registered admission class for a loop. */
export function getLoopAdmission(name: LoopName): LoopAdmission {
  return LOOP_ADMISSION.get(name) ?? 'always';
}

// ── Daemon readiness (#2407, spec §5) ───────────────────────────────────────
//
// `bootstrapping` — before the fleet bootstrap machine has resolved.
// `ready`         — bootstrap completed; every loop is admitted.
// `degraded`      — bootstrap halted on an economic/degraded-class cause
//                    (funding shortfall, incomplete fleet, …); `ready-only`
//                    loops are not admitted until this returns to `ready`.
//
// A shared module-level holder, not a constructor-injected singleton: every
// `runLoop` call site already imports this module for `recordLoopTick`, and
// most loops are constructed well before the daemon knows whether it booted
// `ready` or `degraded` (main.ts's halt-recovery path in particular runs
// loops standalone, well before `Daemon` is ever instantiated). Defaults to
// `ready` so every existing caller that doesn't touch this is unaffected.
export type DaemonReadiness = 'bootstrapping' | 'ready' | 'degraded';

let sharedDaemonReadiness: DaemonReadiness = 'ready';

export function setDaemonReadiness(readiness: DaemonReadiness): void {
  sharedDaemonReadiness = readiness;
}

export function getDaemonReadiness(): DaemonReadiness {
  return sharedDaemonReadiness;
}

/** The config-row key for a given loop's heartbeat. */
export function loopHeartbeatKey(name: LoopName): string {
  return `${LOOP_HEARTBEAT_PREFIX}${name}`;
}

/** Stamp the loop's heartbeat with the current wall-clock ms. */
export function recordLoopTick(store: Store, name: LoopName): void {
  store.setConfigValue(loopHeartbeatKey(name), Date.now().toString());
}

/**
 * Read a loop's last heartbeat as wall-clock ms, or `null` if it has never
 * ticked or the stored value is not a finite number.
 */
export function getLoopTick(store: Store, name: LoopName): number | null {
  const raw = store.getConfigValue(loopHeartbeatKey(name));
  if (raw === null) return null;
  const ms = Number(raw);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * One `LOOP_REGISTRY` entry's resolved metrics view (spec §5/§6.2, issue #2404).
 * Structurally mirrors `api/metrics-endpoint.ts`'s `MetricsLoopEntry` — kept in sync by
 * shape, not by import: `client/src/api/` must never import `client/src/daemon/`
 * (architecture boundary, #1584 — `test/architecture/api-daemon-boundary.test.ts`).
 */
export interface LoopMetricsSnapshotEntry {
  name: string;
  lastTickSeconds: number | null;
  admitted: boolean;
}

/**
 * Builds the per-loop snapshot `GET /metrics` needs. Single source of truth for the
 * admission expression (`getLoopAdmission(name) === 'always' || getDaemonReadiness() ===
 * 'ready'`) — main.ts, `daemon.ts`'s self-start branch, and the metrics-endpoint test all
 * call this rather than each restating the expression inline (review finding N5: three
 * verbatim copies must not drift).
 */
export function buildLoopMetricsSnapshot(store: Store): LoopMetricsSnapshotEntry[] {
  return LOOP_REGISTRY.map((loop) => {
    const tickMs = getLoopTick(store, loop.name);
    return {
      name: loop.name,
      lastTickSeconds: tickMs !== null ? tickMs / 1000 : null,
      admitted: getLoopAdmission(loop.name) === 'always' || getDaemonReadiness() === 'ready',
    };
  });
}

/**
 * Shared tick/heartbeat/error/stop skeleton for the supervised while+sleep
 * loops (#1578). Reproduces the per-loop body that each loop previously
 * inlined: run tick, route any throw (custom onError or a default
 * `tick_error`/`failed` event), run afterTick, stamp the heartbeat, then sleep
 * — plain or raced against a stopPromise.
 *
 * Wave-4 D6 removed the for-await adapter loops (`engine-watcher`,
 * `delivery-watcher`) from this registry. Their leftover generators on
 * `MechAdapter` (stage 5 / `legacy-operator-composition`) no longer stamp
 * a heartbeat.
 *
 * The `intervalMs <= 0` disable guard is intentionally NOT here — it stays in
 * each caller's run() (reward-claim / balance-topup). That precedent is
 * deliberately NOT extended to admission (#2407 caveat ii): the disable guard
 * is a per-caller static config decision made once at construction, while
 * admission is a dynamic, shared, cross-cutting readiness signal every loop
 * must observe the same way — so it is centralized here rather than
 * duplicated into each caller's run().
 */
export interface RunLoopOptions {
  name: LoopName;
  store: Store;
  tick: () => Promise<void>;
  intervalMs: number | (() => number);
  stopSignal: () => boolean;
  stopPromise?: Promise<void>;
  onError?: (err: unknown) => void;
  emitSource: string;
  afterTick?: () => void;
  /**
   * Readiness getter consulted against this loop's registered admission
   * (#2407, spec §5). Defaults to the shared `getDaemonReadiness` holder so
   * existing callers need no change — most loops run in a daemon that is
   * simply `ready`, and the shared holder's default is `ready`.
   */
  getReadiness?: () => DaemonReadiness;
}

export async function runLoop(opts: RunLoopOptions): Promise<void> {
  const admission = getLoopAdmission(opts.name);
  const getReadiness = opts.getReadiness ?? getDaemonReadiness;
  while (!opts.stopSignal()) {
    const admitted = admission === 'always' || getReadiness() === 'ready';
    if (admitted) {
      try {
        await opts.tick();
      } catch (err) {
        if (opts.onError) {
          opts.onError(err);
        } else {
          emitEvent(opts.store, {
            kind: 'tick_error',
            outcome: 'failed',
            detail: err instanceof Error ? err.message : String(err),
          }, opts.emitSource);
        }
      }
      opts.afterTick?.();
    }
    // Heartbeat stamps regardless of admission: a ready-only loop sitting
    // out a degraded window is intentionally paused, not stale, and must
    // not trip the watchdog.
    recordLoopTick(opts.store, opts.name);
    if (opts.stopSignal()) break;
    const delay = typeof opts.intervalMs === 'function' ? opts.intervalMs() : opts.intervalMs;
    if (opts.stopPromise) {
      await Promise.race([new Promise(r => setTimeout(r, delay)), opts.stopPromise]);
    } else {
      await new Promise(r => setTimeout(r, delay));
    }
  }
}
