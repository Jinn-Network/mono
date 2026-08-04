/**
 * Phase D observation-window receipt (#2380) — pure computation, no I/O.
 *
 * The manifest's `zeroDefinition`s ("no production instance selects the legacy graph during the
 * approved observation window", etc.) can only be a defensible claim if the window is provably
 * continuous per instance: a durable counter file that is missing, corrupt, or was reset
 * (deleted and recreated, restarting `observationWindowStartedAt`) cannot vouch for the days it
 * didn't observe. This module encodes that rule rather than merely documenting it — see
 * `deriveInstanceEntry`.
 *
 * The window is dated, not traffic-triggered (see the issue's own framing): what's claimable is
 * the manifest's proposition — legacy use == 0 across the enumerated first-party fleet for an
 * approved window — never "traffic moved to native". `supportBoundary` on the receipt names that
 * boundary explicitly and disclaims unknown independent operators.
 *
 * The orchestrator (`scripts/phase-d-observation-collector.ts`) injects all I/O (fetching each
 * instance's current diagnostics, reading/writing the receipt file) so this module is fully
 * testable with no network or filesystem.
 */

import { readFileSync } from 'node:fs';
import type { PhaseDTransitionSignal } from '../compatibility/phase-d-transition-usage.js';

/** The five legacy-use signals the manifest's zero-use claim is about. Deliberately excludes
 *  `native-operator-composition`, which is positive presence evidence, not a legacy-use counter
 *  — a native instance recording activity there must never suppress a zero-use verdict. */
export const PHASE_D_LEGACY_SIGNALS: readonly PhaseDTransitionSignal[] = [
  'legacy-operator-composition',
  'marketplace-pipeline-invocation',
  'legacy-task-submission-synthesis',
  'legacy-evaluator-delivery-watcher-loaded',
  'legacy-wiring-config-field',
];

export interface PhaseDObservationCounterRow {
  readonly signal: string;
  readonly count: number;
}

export interface PhaseDObservationSnapshotEntry {
  /** ISO timestamp this snapshot was collected. */
  readonly at: string;
  /**
   * The durable counter file's own `observationWindowStartedAt`, or `null` when the collector
   * could not fetch or parse it this round (network failure, non-200, corrupt JSON, or the
   * upstream file itself reporting `durable: false`).
   */
  readonly observationWindowStartedAt: string | null;
  /** Whether the source reported a durable (file-backed) counter, per `PhaseDTransitionUsageDiagnostics.durable` / `NativeStatusSnapshot`. */
  readonly durable: boolean;
  readonly counters: readonly PhaseDObservationCounterRow[];
}

export interface PhaseDObservationInstanceEntry {
  readonly instanceId: string;
  readonly imageDigest: string | null;
  readonly reportedSourceSha: string | null;
  readonly snapshots: readonly PhaseDObservationSnapshotEntry[];
  /**
   * True iff every collected snapshot is durable, reports a non-null `observationWindowStartedAt`,
   * and all snapshots share the same `observationWindowStartedAt` (no reset). False for an
   * instance with zero collected snapshots — there is nothing to vouch for.
   */
  readonly complete: boolean;
  /** Count of `observationWindowStartedAt` changes between consecutive collected snapshots. */
  readonly resets: number;
}

export interface PhaseDObservationSupportBoundary {
  readonly claim: 'first-party-operational';
  readonly disclaims: readonly ['unknown-independent-operators'];
}

export interface PhaseDObservationVerdict {
  /**
   * True only when every instance in the receipt is `complete` AND every legacy signal observed
   * in each instance's latest snapshot reads zero. An incomplete instance always forces `false`
   * — a gap in coverage is never evidence of zero use.
   */
  readonly zeroUse: boolean;
  /** The legacy signals actually observed (present in at least one snapshot) across the fleet. */
  readonly signalsCovered: readonly string[];
}

export interface PhaseDObservationReceipt {
  readonly schemaVersion: 1;
  readonly kind: 'jinn.phase-d-observation-window';
  readonly windowId: string;
  readonly approvedBy: string;
  readonly startedAt: string;
  /** `null` while the window is still open (collection ongoing). */
  readonly endedAt: string | null;
  readonly supportBoundary: PhaseDObservationSupportBoundary;
  readonly instances: readonly PhaseDObservationInstanceEntry[];
  readonly verdict: PhaseDObservationVerdict;
}

const SUPPORT_BOUNDARY: PhaseDObservationSupportBoundary = {
  claim: 'first-party-operational',
  disclaims: ['unknown-independent-operators'],
};

/**
 * Derives one instance's `complete`/`resets` from its ordered snapshot history. A missing,
 * corrupt, or reset `observationWindowStartedAt` invalidates the instance's window — this is the
 * computable encoding of that rule (issue #2380), not just a documented expectation.
 */
export function deriveInstanceEntry(input: {
  readonly instanceId: string;
  readonly imageDigest: string | null;
  readonly reportedSourceSha: string | null;
  readonly snapshots: readonly PhaseDObservationSnapshotEntry[];
}): PhaseDObservationInstanceEntry {
  const { snapshots } = input;
  let previous: string | null = null;
  let resets = 0;
  let missingOrCorrupt = false;
  for (const entry of snapshots) {
    if (!entry.durable || entry.observationWindowStartedAt === null) {
      missingOrCorrupt = true;
      continue;
    }
    if (previous !== null && entry.observationWindowStartedAt !== previous) {
      resets += 1;
    }
    previous = entry.observationWindowStartedAt;
  }
  const complete = snapshots.length > 0 && !missingOrCorrupt && resets === 0;
  return {
    instanceId: input.instanceId,
    imageDigest: input.imageDigest,
    reportedSourceSha: input.reportedSourceSha,
    snapshots,
    complete,
    resets,
  };
}

/**
 * `zeroUse` requires BOTH full coverage (every instance complete) AND every legacy signal in
 * every instance's latest snapshot reading zero. `signalsCovered` is the union of legacy signals
 * actually observed, across all instances' latest snapshots — the auditable evidence backing the
 * claim (which signals genuinely reported, as opposed to being silently absent).
 */
export function deriveVerdict(
  instances: readonly PhaseDObservationInstanceEntry[],
): PhaseDObservationVerdict {
  if (instances.length === 0) return { zeroUse: false, signalsCovered: [] };
  const legacySignals = new Set<string>(PHASE_D_LEGACY_SIGNALS);
  const covered = new Set<string>();
  let allComplete = true;
  let anyLegacyNonZero = false;
  for (const instance of instances) {
    if (!instance.complete) allComplete = false;
    const latest = instance.snapshots.at(-1);
    if (latest === undefined) continue;
    for (const counter of latest.counters) {
      if (!legacySignals.has(counter.signal)) continue;
      covered.add(counter.signal);
      if (counter.count > 0) anyLegacyNonZero = true;
    }
  }
  return {
    zeroUse: allComplete && !anyLegacyNonZero,
    signalsCovered: [...covered].sort(),
  };
}

export type PhaseDObservationFetchResult =
  | {
    readonly ok: true;
    readonly durable: boolean;
    readonly observationWindowStartedAt: string;
    readonly counters: readonly PhaseDObservationCounterRow[];
  }
  | { readonly ok: false };

export interface PhaseDObservationFetch {
  readonly instanceId: string;
  readonly imageDigest: string | null;
  readonly reportedSourceSha: string | null;
  readonly result: PhaseDObservationFetchResult;
}

/**
 * Merges today's fetch results into an existing (or brand-new) receipt. Stateful in the sense
 * that it reads `existing.instances` to append rather than overwrite each instance's snapshot
 * history — the collector runs on a daily cadence and this is what turns repeated single-day
 * fetches into a continuous multi-day window. Throws if `existing` belongs to a different window
 * — the caller (the collector CLI) is expected to start a genuinely new receipt file rather than
 * silently mixing windows.
 */
export function appendDailyObservation(input: {
  readonly existing: PhaseDObservationReceipt | undefined;
  readonly windowId: string;
  readonly approvedBy: string;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly collectedAt: string;
  readonly fetched: readonly PhaseDObservationFetch[];
}): PhaseDObservationReceipt {
  if (input.existing !== undefined && input.existing.windowId !== input.windowId) {
    throw new Error(
      `observation receipt windowId mismatch: existing=${input.existing.windowId} requested=${input.windowId}`,
    );
  }
  const priorByInstance = new Map(
    (input.existing?.instances ?? []).map((entry) => [entry.instanceId, entry] as const),
  );
  const instances = input.fetched.map((fetch) => {
    const priorSnapshots = priorByInstance.get(fetch.instanceId)?.snapshots ?? [];
    const newSnapshot: PhaseDObservationSnapshotEntry = fetch.result.ok
      ? {
        at: input.collectedAt,
        observationWindowStartedAt: fetch.result.observationWindowStartedAt,
        durable: fetch.result.durable,
        counters: fetch.result.counters,
      }
      : { at: input.collectedAt, observationWindowStartedAt: null, durable: false, counters: [] };
    return deriveInstanceEntry({
      instanceId: fetch.instanceId,
      imageDigest: fetch.imageDigest,
      reportedSourceSha: fetch.reportedSourceSha,
      snapshots: [...priorSnapshots, newSnapshot],
    });
  });
  return {
    schemaVersion: 1,
    kind: 'jinn.phase-d-observation-window',
    windowId: input.windowId,
    approvedBy: input.approvedBy,
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    supportBoundary: SUPPORT_BOUNDARY,
    instances,
    verdict: deriveVerdict(instances),
  };
}

// ── Instance fetchers (I/O; DI'd for testability, mirrors src/monitoring/net-liveness.ts) ──────

const DEFAULT_FETCH_TIMEOUT_MS = 10_000;

function parsePhaseDTransitionUsage(value: unknown): PhaseDObservationFetchResult {
  if (typeof value !== 'object' || value === null) return { ok: false };
  const usage = value as { durable?: unknown; observationWindowStartedAt?: unknown; counters?: unknown };
  if (typeof usage.durable !== 'boolean' || typeof usage.observationWindowStartedAt !== 'string'
    || !Array.isArray(usage.counters)) {
    return { ok: false };
  }
  const counters: PhaseDObservationCounterRow[] = [];
  for (const row of usage.counters) {
    if (typeof row !== 'object' || row === null
      || typeof (row as { signal?: unknown }).signal !== 'string'
      || typeof (row as { count?: unknown }).count !== 'number') {
      return { ok: false };
    }
    counters.push({ signal: (row as { signal: string }).signal, count: (row as { count: number }).count });
  }
  return {
    ok: true,
    durable: usage.durable,
    observationWindowStartedAt: usage.observationWindowStartedAt,
    counters,
  };
}

/**
 * Fetches a legacy instance's diagnostics from its authenticated, localhost-bound `GET
 * /v1/status` (per the issue: "the documented method is a human scraping each host" — this is
 * that scrape, automated). Any failure — network error, non-2xx, malformed body, or a response
 * missing `phaseDTransitionUsage` — degrades to `{ ok: false }`, which `appendDailyObservation`
 * turns into a missing/corrupt snapshot that invalidates the instance's window for this round.
 */
export async function fetchHttpStatusSnapshot(input: {
  readonly url: string;
  readonly token?: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}): Promise<PhaseDObservationFetchResult> {
  const fetchImpl = input.fetchImpl ?? globalThis.fetch;
  try {
    const response = await fetchImpl(input.url, {
      ...(input.token === undefined ? {} : { headers: { authorization: `Bearer ${input.token}` } }),
      signal: AbortSignal.timeout(input.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return { ok: false };
    const body = await response.json() as { phaseDTransitionUsage?: unknown };
    return parsePhaseDTransitionUsage(body.phaseDTransitionUsage);
  } catch {
    return { ok: false };
  }
}

/**
 * Reads a native instance's durable status snapshot (`native-phase-d-observability.ts`'s
 * `phase-d-status-snapshot.v1.json`) from a local or mounted path — native has no `/v1/status` to
 * scrape. Same degrade-to-`{ ok: false }` contract as the HTTP fetcher.
 */
export function readFileStatusSnapshot(input: {
  readonly path: string;
  readonly readFileImpl?: (path: string) => string;
}): PhaseDObservationFetchResult {
  const readFileImpl = input.readFileImpl ?? ((path: string) => readFileSync(path, 'utf8'));
  try {
    const parsed = JSON.parse(readFileImpl(input.path)) as { phaseDTransitionUsage?: unknown };
    return parsePhaseDTransitionUsage(parsed.phaseDTransitionUsage);
  } catch {
    return { ok: false };
  }
}
