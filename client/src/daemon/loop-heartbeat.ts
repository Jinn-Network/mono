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
 * The twelve canonical long-running loops the watchdog supervises, with their
 * default poll intervals and (for the for-await polling loops) a staleness
 * floor. The two for-await adapter loops (engine-watcher, delivery-watcher)
 * heartbeat at the poll-cycle tail inside the mech adapter so an
 * idle-but-polling loop never looks stale. Fleet state (checkpoint txs,
 * eviction checks) stays in FleetStateStore; eviction-check, checkpoint, and
 * harvest heartbeats use this observability Store.
 *
 * This registry is the single source of truth: LOOP_NAMES, the LoopName union,
 * and the daemon's watchdog registrations are all derived from it. Order is
 * load-bearing (LOOP_NAMES preserves it).
 */
export const LOOP_REGISTRY = [
  { name: 'creator', intervalMs: 5000 },
  { name: 'engine-tick', intervalMs: 5000 },
  { name: 'engine-watcher', intervalMs: 5000, floorMs: 5 * 60_000 },
  { name: 'delivery-watcher', intervalMs: 5000, floorMs: 5 * 60_000 },
  { name: 'reward-claim', intervalMs: 5000 },
  { name: 'balance-topup', intervalMs: 5000 },
  { name: 'eviction-check', intervalMs: 60_000 },
  { name: 'checkpoint', intervalMs: 300_000 },
  // Commit-echo harvest loop (task-creator v0). Interval mirrors the config
  // default (config.ts `harvest.intervalMs`); the daemon only registers it
  // with the watchdog when config.harvest is enabled with repos.
  { name: 'harvest', intervalMs: 60 * 60 * 1000 },
  { name: 'peer-sync', intervalMs: 60_000 },
  { name: 'projector', intervalMs: 5000, floorMs: 300_000 },
  { name: 'evidence-driver', intervalMs: 30_000, floorMs: 300_000 },
] as const;

export const LOOP_NAMES = LOOP_REGISTRY.map(r => r.name);

export type LoopName = (typeof LOOP_REGISTRY)[number]['name'];

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
 * Shared tick/heartbeat/error/stop skeleton for the supervised while+sleep
 * loops (#1578). Reproduces the per-loop body that each loop previously
 * inlined: run tick, route any throw (custom onError or a default
 * `tick_error`/`failed` event), run afterTick, stamp the heartbeat, then sleep
 * — plain or raced against a stopPromise.
 *
 * The two for-await polling loops (engine-watcher, delivery-watcher) are NOT
 * routed through here: their heartbeat is stamped inside the mech adapter so an
 * idle-but-polling loop stays fresh. They only carry a LOOP_REGISTRY entry.
 *
 * The `intervalMs <= 0` disable guard is intentionally NOT here — it stays in
 * each caller's run() (reward-claim / balance-topup).
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
}

export async function runLoop(opts: RunLoopOptions): Promise<void> {
  while (!opts.stopSignal()) {
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
