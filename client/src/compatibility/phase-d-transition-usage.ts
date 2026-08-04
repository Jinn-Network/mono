import { existsSync, readFileSync } from 'node:fs';

import { writeObservation } from '../observability/write-observation.js';

/**
 * Durable, monotonic compatibility diagnostics for Phase D deletion gates.
 *
 * These counters are observations, never authorization: they cannot select a product graph,
 * change a claim decision, or permit deletion. Phase D still requires the manifest's external
 * observation window and exact closure evidence. Production configures a file beside the daemon
 * database, and `/v1/status` exposes the snapshot for collection by the operator control plane.
 *
 * `native-operator-composition` (#2380) is the one exception to the "legacy deletion gate"
 * framing above: it is positive evidence that a native-v1 instance is up, recorded once per boot
 * at `client/src/daemon/native-phase-d-observability.ts`. Native mode has no `/v1/status`, so its
 * durable file lives under the operator's `stateDir` instead and is shipped by the periodic
 * status-snapshot loop (see that module) rather than an HTTP GET.
 */
export type PhaseDTransitionSignal =
  | 'legacy-operator-composition'
  | 'marketplace-pipeline-invocation'
  | 'legacy-task-submission-synthesis'
  | 'legacy-evaluator-delivery-watcher-loaded'
  | 'legacy-wiring-config-field'
  | 'native-operator-composition';

export interface PhaseDTransitionUsageCounter {
  readonly signal: PhaseDTransitionSignal;
  readonly count: number;
  readonly firstObservedAt: string;
  readonly lastObservedAt: string;
}

interface PhaseDTransitionUsageState {
  readonly schemaVersion: 1;
  readonly observationWindowStartedAt: string;
  readonly counters: readonly PhaseDTransitionUsageCounter[];
}

export interface PhaseDTransitionUsageDiagnostics {
  readonly schemaVersion: 1;
  readonly durable: boolean;
  readonly observationWindowStartedAt: string;
  readonly counters: readonly PhaseDTransitionUsageCounter[];
}

const counters = new Map<PhaseDTransitionSignal, PhaseDTransitionUsageCounter>();
let storagePath: string | undefined;
let observationWindowStartedAt = new Date().toISOString();

function parseState(path: string): PhaseDTransitionUsageState | undefined {
  if (!existsSync(path)) return undefined;
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<PhaseDTransitionUsageState>;
  if (parsed.schemaVersion !== 1 || typeof parsed.observationWindowStartedAt !== 'string'
    || !Array.isArray(parsed.counters)) {
    throw new Error(`invalid Phase D transition usage state: ${path}`);
  }
  for (const row of parsed.counters) {
    if (typeof row !== 'object' || row === null
      || typeof row.signal !== 'string' || typeof row.count !== 'number'
      || !Number.isSafeInteger(row.count) || row.count < 1
      || typeof row.firstObservedAt !== 'string' || typeof row.lastObservedAt !== 'string') {
      throw new Error(`invalid Phase D transition usage counter: ${path}`);
    }
  }
  return parsed as PhaseDTransitionUsageState;
}

function persist(): void {
  if (storagePath === undefined) return;
  writeObservation(storagePath, `${JSON.stringify({
    schemaVersion: 1,
    observationWindowStartedAt,
    counters: phaseDTransitionUsageSnapshot(),
  } satisfies PhaseDTransitionUsageState, null, 2)}\n`);
}

/** Configure (or reload) the durable observation window used by this process. */
export function configurePhaseDTransitionUsage(
  nextStoragePath: string | undefined,
  now = new Date(),
): void {
  if (storagePath === nextStoragePath) return;
  const pending = storagePath === undefined && nextStoragePath !== undefined
    ? phaseDTransitionUsageSnapshot()
    : [];
  storagePath = nextStoragePath;
  counters.clear();
  observationWindowStartedAt = now.toISOString();
  if (storagePath !== undefined) {
    const state = parseState(storagePath);
    if (state !== undefined) {
      observationWindowStartedAt = state.observationWindowStartedAt;
      for (const row of state.counters) counters.set(row.signal, { ...row });
    }
    for (const row of pending) {
      const current = counters.get(row.signal);
      counters.set(row.signal, current === undefined ? { ...row } : {
        signal: row.signal,
        count: current.count + row.count,
        firstObservedAt: current.firstObservedAt < row.firstObservedAt
          ? current.firstObservedAt
          : row.firstObservedAt,
        lastObservedAt: current.lastObservedAt > row.lastObservedAt
          ? current.lastObservedAt
          : row.lastObservedAt,
      });
    }
    if (state === undefined || pending.length > 0) persist();
  }
}

export function recordPhaseDTransitionUse(
  signal: PhaseDTransitionSignal,
  observedAt = new Date(),
): void {
  const timestamp = observedAt.toISOString();
  const current = counters.get(signal);
  counters.set(signal, current === undefined
    ? { signal, count: 1, firstObservedAt: timestamp, lastObservedAt: timestamp }
    : { ...current, count: current.count + 1, lastObservedAt: timestamp });
  persist();
}

export function phaseDTransitionUsageSnapshot(): readonly PhaseDTransitionUsageCounter[] {
  return [...counters.values()]
    .sort((left, right) => left.signal < right.signal ? -1 : left.signal > right.signal ? 1 : 0)
    .map((counter) => ({ ...counter }));
}

export function phaseDTransitionUsageDiagnostics(): PhaseDTransitionUsageDiagnostics {
  return {
    schemaVersion: 1,
    durable: storagePath !== undefined,
    observationWindowStartedAt,
    counters: phaseDTransitionUsageSnapshot(),
  };
}
