import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';

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
// The single source of truth for the signal vocabulary: both the TS union below and the Zod
// enum used to validate every write derive from this array, so they cannot drift apart.
const PHASE_D_TRANSITION_SIGNALS = [
  'legacy-operator-composition',
  'marketplace-pipeline-invocation',
  'legacy-task-submission-synthesis',
  'legacy-evaluator-delivery-watcher-loaded',
  'legacy-wiring-config-field',
  'native-operator-composition',
] as const;

export type PhaseDTransitionSignal = typeof PHASE_D_TRANSITION_SIGNALS[number];

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

// Versioned-Zod-strict container profile (spec §7): the shape a durable state file must satisfy
// before writeObservation will write it. z.strictObject (not z.object, which silently strips
// unrecognized keys) so a future field added to the TS interface without a matching schema update
// throws at write time instead of silently vanishing from the durable file (N2).
const phaseDTransitionUsageCounterSchema = z.strictObject({
  signal: z.enum(PHASE_D_TRANSITION_SIGNALS),
  count: z.number().int().min(1),
  firstObservedAt: z.string().min(1),
  lastObservedAt: z.string().min(1),
});

const phaseDTransitionUsageStateSchema = z.strictObject({
  schemaVersion: z.literal(1),
  observationWindowStartedAt: z.string().min(1),
  counters: z.array(phaseDTransitionUsageCounterSchema).readonly(),
});

export interface PhaseDTransitionUsageDiagnostics {
  readonly schemaVersion: 1;
  readonly durable: boolean;
  readonly observationWindowStartedAt: string;
  readonly counters: readonly PhaseDTransitionUsageCounter[];
}

// Exported so a container embedding these diagnostics as a subtree (e.g. the native status
// snapshot) can compose it into its own writeObservation schema without duplicating the shape.
export const phaseDTransitionUsageDiagnosticsSchema = z.strictObject({
  schemaVersion: z.literal(1),
  durable: z.boolean(),
  observationWindowStartedAt: z.string().min(1),
  counters: z.array(phaseDTransitionUsageCounterSchema).readonly(),
});

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
  writeObservation(storagePath, phaseDTransitionUsageStateSchema, {
    schemaVersion: 1,
    observationWindowStartedAt,
    counters: phaseDTransitionUsageSnapshot(),
  } satisfies PhaseDTransitionUsageState);
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
