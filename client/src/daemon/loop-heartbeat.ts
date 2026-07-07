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

/** Config-key namespace for per-loop heartbeats. */
export const LOOP_HEARTBEAT_PREFIX = 'loop_heartbeat:';

/**
 * The eight canonical long-running loops the watchdog supervises. The two
 * for-await adapter loops (engine-watcher, delivery-watcher) heartbeat at the
 * poll-cycle tail so an idle-but-polling loop never looks stale. The
 * eviction/checkpoint loops use FleetStateStore (not this observability Store)
 * and are deliberately NOT in this set.
 */
export const LOOP_NAMES = [
  'creator',
  'engine-tick',
  'engine-watcher',
  'delivery-watcher',
  'reward-claim',
  'balance-topup',
  'peer-sync',
] as const;

export type LoopName = (typeof LOOP_NAMES)[number];

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
