/**
 * Pure helper that rolls a HarnessReadinessSnapshot up into the single
 * boolean + name + reason shape exposed on `/v1/status.harness`.
 *
 * The SPA's `useNotifications` adapter consumes `status.harness.{ready,name,reason}`
 * to fire `harness_not_ready`; the rollup considers only harnesses joined by
 * the operator (`joinedHarnessesByCid`), so registered-but-unjoined harnesses
 * (which the registry includes for the SPA join form) cannot drive the
 * blocking notification.
 *
 * Rules:
 * - If no harnesses are joined OR the snapshot is empty (pre-first-refresh),
 *   return `{ ready: true, name: null, reason: null }` (default-ready posture).
 * - Otherwise iterate the snapshot in its existing order (which mirrors
 *   `Object.keys(harnessesByName)` insertion order in `_doRefresh`) and emit
 *   the first joined-and-unready entry as
 *   `{ ready: false, name, reason: reason ?? null }`.
 * - If no joined-and-unready entry exists, return default-ready.
 *
 * First-unready-wins keeps the surface deterministic and blames a concrete
 * harness for the operator-visible message. Fixing the named harness will
 * surface the next one on the following poll.
 */

import type {
  HarnessReadinessSnapshot,
  JoinedHarnessSpec,
} from '../harnesses/readiness-registry.js';

export interface HarnessRollup {
  ready: boolean;
  name: string | null;
  reason: string | null;
}

const DEFAULT_READY: HarnessRollup = { ready: true, name: null, reason: null };

export function buildHarnessRollup(
  snapshot: HarnessReadinessSnapshot,
  joinedHarnessesByCid: Record<string, JoinedHarnessSpec>,
): HarnessRollup {
  const joinedNames = new Set<string>();
  for (const joined of Object.values(joinedHarnessesByCid)) {
    joinedNames.add(joined.harnessName);
  }
  if (joinedNames.size === 0 || snapshot.harnesses.length === 0) {
    return { ...DEFAULT_READY };
  }

  for (const entry of snapshot.harnesses) {
    if (!entry.ready && joinedNames.has(entry.harnessName)) {
      return {
        ready: false,
        name: entry.harnessName,
        reason: entry.reason ?? null,
      };
    }
  }

  return { ...DEFAULT_READY };
}
