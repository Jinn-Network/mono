/**
 * Phase D observation-window receipt (#2380) — pure computation, no I/O.
 *
 * The manifest's `zeroDefinition`s ("no production instance selects the legacy graph during the
 * approved observation window", etc.) can only be a defensible claim if the window is provably
 * continuous per instance: a durable counter file that is missing, corrupt, was reset (deleted and
 * recreated, restarting `observationWindowStartedAt`), regressed (a count that decreased or a
 * previously-reported signal that disappeared — impossible under legitimate monotonic persistence,
 * see `phase-d-transition-usage.ts`), or went stale (a native snapshot file whose writer stopped
 * ticking) cannot vouch for the days it didn't genuinely observe. Nor can a fleet that shrank
 * mid-window, or a verdict issued before the window even closed. This module encodes all of that
 * as computed rules — see `deriveInstanceEntry`, `deriveVerdict`, `appendDailyObservation` — not
 * documentation an operator has to remember.
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
   * could not fetch or parse it this round (network failure, non-200, corrupt JSON, a response
   * missing `phaseDTransitionUsage`, a stale native snapshot file, or the instance having been
   * absent from the fleet manifest this round — see `appendDailyObservation`).
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
   * all snapshots share the same `observationWindowStartedAt` (no reset), and no signal's count
   * ever decreased or disappeared after being present (no regression). False for an instance with
   * zero collected snapshots — there is nothing to vouch for.
   */
  readonly complete: boolean;
  /** Count of `observationWindowStartedAt` changes between consecutive collected snapshots. */
  readonly resets: number;
  /**
   * Count of per-signal monotonicity violations across consecutive collected snapshots — a count
   * that decreased, or a signal present in an earlier snapshot that is absent from a later one.
   * The durable counter file is append-only/monotonic by construction
   * (`compatibility/phase-d-transition-usage.ts`); either violation means the source lied or was
   * tampered with, not that legacy use genuinely dropped.
   */
  readonly regressions: number;
}

export interface PhaseDObservationSupportBoundary {
  readonly claim: 'first-party-operational';
  readonly disclaims: readonly ['unknown-independent-operators'];
}

export interface PhaseDObservationVerdict {
  /**
   * True only when: the window is closed (`endedAt !== null`); every instance is `complete`;
   * every instance's collected snapshots continuously cover `[startedAt, endedAt]` with no gap
   * wider than the coverage tolerance (default ~2 days) — a single lucky reading can never stand
   * in for a whole window; and every legacy signal observed in each instance's latest snapshot
   * reads zero. Any failure of any of these forces `false` — a coverage gap, an open window, or a
   * shrunk fleet is never evidence of zero use.
   */
  readonly zeroUse: boolean;
  /**
   * The legacy signals for which durable, live instrumentation was confirmed (at least one
   * instance's latest snapshot reported `durable: true`) — regardless of whether that signal ever
   * fired. The durable counter file never persists an explicit zero-count row (a signal that never
   * fires simply never appears in its counters array — see `phase-d-transition-usage.ts`), so
   * presence-in-counters cannot be the coverage signal: it would be structurally empty exactly
   * when `zeroUse` is true, the one case this field exists to back up. `durable: true` instead
   * confirms the counter mechanism itself was live and would have shown these signals had they
   * fired.
   */
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
 * Derives one instance's `complete`/`resets`/`regressions` from its ordered snapshot history. A
 * missing, corrupt, reset, or regressed `observationWindowStartedAt`/counter invalidates the
 * instance's window — this is the computable encoding of that rule (issue #2380), not just a
 * documented expectation.
 */
export function deriveInstanceEntry(input: {
  readonly instanceId: string;
  readonly imageDigest: string | null;
  readonly reportedSourceSha: string | null;
  readonly snapshots: readonly PhaseDObservationSnapshotEntry[];
}): PhaseDObservationInstanceEntry {
  const { snapshots } = input;
  let previousWindowStart: string | null = null;
  let resets = 0;
  let regressions = 0;
  let missingOrCorrupt = false;
  const lastCountBySignal = new Map<string, number>();
  for (const entry of snapshots) {
    if (!entry.durable || entry.observationWindowStartedAt === null) {
      missingOrCorrupt = true;
      continue;
    }
    if (previousWindowStart !== null && entry.observationWindowStartedAt !== previousWindowStart) {
      resets += 1;
    }
    previousWindowStart = entry.observationWindowStartedAt;

    const presentThisRound = new Set(entry.counters.map((counter) => counter.signal));
    for (const signal of lastCountBySignal.keys()) {
      if (!presentThisRound.has(signal)) regressions += 1; // disappeared after being present
    }
    for (const counter of entry.counters) {
      const last = lastCountBySignal.get(counter.signal);
      if (last !== undefined && counter.count < last) regressions += 1; // count decreased
      lastCountBySignal.set(counter.signal, Math.max(last ?? 0, counter.count));
    }
  }
  const complete = snapshots.length > 0 && !missingOrCorrupt && resets === 0 && regressions === 0;
  return {
    instanceId: input.instanceId,
    imageDigest: input.imageDigest,
    reportedSourceSha: input.reportedSourceSha,
    snapshots,
    complete,
    resets,
    regressions,
  };
}

/** Default tolerance for a gap between consecutive collections (or between window open/close and
 *  the nearest collection) before an instance's coverage of the approved window is rejected. The
 *  collector runs daily; ~2 days gives slack for one missed cron tick without silently accepting
 *  a fleet that was scraped once and never again. */
export const DEFAULT_MAX_COVERAGE_GAP_MS = 2 * 24 * 60 * 60 * 1000;

/** A real approved observation window must span at least a full day — the collector runs daily,
 *  so anything shorter can never have even one legitimate collection cycle. Below this (including
 *  a zero-length or inverted `startedAt >= endedAt` window), `hasCoverageGap` refuses to certify
 *  coverage regardless of how many snapshots exist — review #2380 rereview: a single lucky reading
 *  against a degenerate window must not be able to certify it. */
export const MIN_WINDOW_SPAN_MS = 24 * 60 * 60 * 1000;

/**
 * True when `snapshotTimes` (unsorted) leaves any gap wider than `maxGapMs` — before the first
 * collection (relative to `startedAt`), between two consecutive collections, or after the last
 * collection (relative to `endedAt`). An instance with zero snapshots is always a total gap.
 *
 * Fails closed (returns `true`, i.e. "there is a gap") on anything that can't be trusted as a real
 * window or a real timestamp: an unparseable `startedAt`/`endedAt` (`Date.parse` yields `NaN`,
 * and every `NaN > x` comparison is silently `false` — the bug this guards against), a window
 * shorter than `MIN_WINDOW_SPAN_MS` or inverted, or any unparseable snapshot `at`. The gate must
 * be safe regardless of whether its caller validated its inputs first.
 */
function hasCoverageGap(input: {
  readonly snapshotTimes: readonly string[];
  readonly startedAt: string;
  readonly endedAt: string;
  readonly maxGapMs: number;
}): boolean {
  const started = Date.parse(input.startedAt);
  const ended = Date.parse(input.endedAt);
  if (!Number.isFinite(started) || !Number.isFinite(ended) || ended - started < MIN_WINDOW_SPAN_MS) {
    return true;
  }
  const parsedTimes = input.snapshotTimes.map((iso) => Date.parse(iso));
  if (parsedTimes.length === 0 || parsedTimes.some((t) => !Number.isFinite(t))) return true;
  const times = [...parsedTimes].sort((a, b) => a - b);
  if (times[0]! - started > input.maxGapMs) return true;
  if (ended - times.at(-1)! > input.maxGapMs) return true;
  for (let i = 1; i < times.length; i += 1) {
    if (times[i]! - times[i - 1]! > input.maxGapMs) return true;
  }
  return false;
}

/**
 * `signalsCovered` is satisfied by any single instance's latest snapshot reporting
 * `durable: true` — a per-fleet "was the mechanism confirmed live anywhere" signal, not a
 * per-instance one. Review #2380 rereview flagged this as arguably surprising (1-of-8 durable
 * reports full coverage) and suggested requiring every instance instead, explicitly as a
 * non-blocking, "your call" note — it cannot inflate `zeroUse`, which already independently
 * requires every instance `complete` (a stronger, coverage-gated condition than mere durability).
 * Left as "any" to match the existing verified contract; revisit if `signalsCovered` grows a use
 * beyond backing `zeroUse`.
 */
function computeSignalsCovered(instances: readonly PhaseDObservationInstanceEntry[]): readonly string[] {
  const covered = new Set<string>();
  for (const instance of instances) {
    if (instance.snapshots.at(-1)?.durable === true) {
      for (const signal of PHASE_D_LEGACY_SIGNALS) covered.add(signal);
    }
  }
  return [...covered].sort();
}

/**
 * `zeroUse` requires the window to be explicitly closed, every instance complete, every
 * instance's collections to continuously cover `[startedAt, endedAt]`, and every legacy signal in
 * every instance's latest snapshot to read zero. `signalsCovered` — see
 * `PhaseDObservationVerdict.signalsCovered` — is computed independently of `zeroUse` so it still
 * shows what instrumentation was confirmed live even when the verdict itself is `false`.
 */
export function deriveVerdict(input: {
  readonly instances: readonly PhaseDObservationInstanceEntry[];
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly maxCoverageGapMs?: number;
}): PhaseDObservationVerdict {
  const { instances } = input;
  const signalsCovered = computeSignalsCovered(instances);
  if (instances.length === 0 || input.endedAt === null) {
    return { zeroUse: false, signalsCovered };
  }
  const endedAt = input.endedAt;
  const maxGapMs = input.maxCoverageGapMs ?? DEFAULT_MAX_COVERAGE_GAP_MS;
  const legacySignals = new Set<string>(PHASE_D_LEGACY_SIGNALS);
  let allComplete = true;
  let allCovered = true;
  let anyLegacyNonZero = false;
  for (const instance of instances) {
    if (!instance.complete) allComplete = false;
    if (hasCoverageGap({
      snapshotTimes: instance.snapshots.map((entry) => entry.at),
      startedAt: input.startedAt,
      endedAt,
      maxGapMs,
    })) {
      allCovered = false;
    }
    const latest = instance.snapshots.at(-1);
    if (latest === undefined) continue;
    for (const counter of latest.counters) {
      if (legacySignals.has(counter.signal) && counter.count > 0) anyLegacyNonZero = true;
    }
  }
  return {
    zeroUse: allComplete && allCovered && !anyLegacyNonZero,
    signalsCovered,
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

const MISSING_SNAPSHOT = (at: string): PhaseDObservationSnapshotEntry => (
  { at, observationWindowStartedAt: null, durable: false, counters: [] }
);

/**
 * Conservatively merges duplicate fetch results for the same `instanceId` within one collection
 * round (a copy-pasted fleet-manifest entry, most plausibly). "Refuse to overwrite" rather than
 * "last write wins": any `ok: false` among the duplicates, or duplicates that disagree about
 * `observationWindowStartedAt` (an unresolvable ambiguity — which one is real?), makes the whole
 * merge untrustworthy. Otherwise each signal's count is the MAX across the duplicates — the
 * durable counter file is monotonic, so the higher reading is never less true than the lower one,
 * and this can never silently drop non-zero evidence the way a naive last-write-wins Map would
 * (review #2380 rereview P1c).
 */
function mergeDuplicateFetches(duplicates: readonly PhaseDObservationFetch[]): PhaseDObservationFetch {
  const [first, ...rest] = duplicates;
  const instanceId = first!.instanceId;
  if (duplicates.length === 1) return first!;
  const results = duplicates.map((entry) => entry.result);
  const merged: PhaseDObservationFetchResult = (() => {
    if (results.some((result) => !result.ok)) return { ok: false };
    const oks = results as Extract<PhaseDObservationFetchResult, { ok: true }>[];
    const windowStarts = new Set(oks.map((result) => result.observationWindowStartedAt));
    if (windowStarts.size > 1) return { ok: false };
    const countsBySignal = new Map<string, number>();
    for (const result of oks) {
      for (const counter of result.counters) {
        countsBySignal.set(counter.signal, Math.max(countsBySignal.get(counter.signal) ?? 0, counter.count));
      }
    }
    return {
      ok: true,
      durable: oks.every((result) => result.durable),
      observationWindowStartedAt: [...windowStarts][0]!,
      counters: [...countsBySignal.entries()]
        .map(([signal, count]) => ({ signal, count }))
        .sort((a, b) => (a.signal < b.signal ? -1 : a.signal > b.signal ? 1 : 0)),
    };
  })();
  return {
    instanceId,
    imageDigest: first!.imageDigest ?? rest.find((entry) => entry.imageDigest !== null)?.imageDigest ?? null,
    reportedSourceSha: first!.reportedSourceSha
      ?? rest.find((entry) => entry.reportedSourceSha !== null)?.reportedSourceSha ?? null,
    result: merged,
  };
}

/**
 * Merges today's fetch results into an existing (or brand-new) receipt. Stateful in the sense
 * that it reads `existing.instances` to append rather than overwrite each instance's snapshot
 * history — the collector runs on a daily cadence and this is what turns repeated single-day
 * fetches into a continuous multi-day window.
 *
 * Every instance that has EVER appeared in the receipt's history stays represented in every
 * subsequent call, even if it is absent from `fetched` (dropped from the fleet manifest, host
 * decommissioned, etc.) — it is carried forward with a missing-observation snapshot for today,
 * which invalidates its completeness exactly like a fetch failure would. Shrinking the population
 * must never improve the verdict: if it did, decommissioning a legacy host mid-window would erase
 * its recorded legacy use instead of leaving a gap. Starting over honestly requires a new window
 * (a new `windowId`), not a shrunk fetch list against an old receipt.
 *
 * Throws if `existing` belongs to a different window (`windowId`, `approvedBy`, or `startedAt`
 * differs) — the caller (the collector CLI) is expected to start a genuinely new receipt file
 * rather than silently mixing windows or relabeling who approved one.
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
  if (input.existing !== undefined) {
    if (input.existing.windowId !== input.windowId) {
      throw new Error(
        `observation receipt windowId mismatch: existing=${input.existing.windowId} requested=${input.windowId}`,
      );
    }
    if (input.existing.approvedBy !== input.approvedBy) {
      throw new Error(
        `observation receipt approvedBy mismatch: existing=${input.existing.approvedBy} requested=${input.approvedBy}`,
      );
    }
    if (input.existing.startedAt !== input.startedAt) {
      throw new Error(
        `observation receipt startedAt mismatch: existing=${input.existing.startedAt} requested=${input.startedAt}`,
      );
    }
  }

  const priorByInstance = new Map(
    (input.existing?.instances ?? []).map((entry) => [entry.instanceId, entry] as const),
  );
  // Group before building the lookup Map: a naive `new Map(fetched.map(...))` silently keeps only
  // the last entry for a duplicate instanceId (a copy-pasted fleet-manifest entry), which can drop
  // real non-zero evidence exactly like the fleet-shrinkage hazard this module otherwise defends
  // against (review #2380 rereview P1c) — merge conservatively instead, see mergeDuplicateFetches.
  const fetchGroups = new Map<string, PhaseDObservationFetch[]>();
  for (const fetch of input.fetched) {
    const group = fetchGroups.get(fetch.instanceId);
    if (group === undefined) fetchGroups.set(fetch.instanceId, [fetch]);
    else group.push(fetch);
  }
  const fetchedByInstance = new Map(
    [...fetchGroups.entries()].map(([instanceId, group]) => [instanceId, mergeDuplicateFetches(group)] as const),
  );
  // Union, not just today's fetch: an instance that has ever appeared stays represented forever
  // within this window, even once it drops out of the fleet manifest — see the docstring above.
  const allInstanceIds = [...new Set([...priorByInstance.keys(), ...fetchedByInstance.keys()])].sort();

  const instances = allInstanceIds.map((instanceId) => {
    const prior = priorByInstance.get(instanceId);
    const fetch = fetchedByInstance.get(instanceId);
    const priorSnapshots = prior?.snapshots ?? [];
    const newSnapshot: PhaseDObservationSnapshotEntry = fetch?.result.ok === true
      ? {
        at: input.collectedAt,
        observationWindowStartedAt: fetch.result.observationWindowStartedAt,
        durable: fetch.result.durable,
        counters: fetch.result.counters,
      }
      : MISSING_SNAPSHOT(input.collectedAt);
    return deriveInstanceEntry({
      instanceId,
      imageDigest: fetch?.imageDigest ?? prior?.imageDigest ?? null,
      reportedSourceSha: fetch?.reportedSourceSha ?? prior?.reportedSourceSha ?? null,
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
    verdict: deriveVerdict({ instances, startedAt: input.startedAt, endedAt: input.endedAt }),
  };
}

function isValidSnapshotEntry(value: unknown): value is PhaseDObservationSnapshotEntry {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Partial<PhaseDObservationSnapshotEntry>;
  return typeof entry.at === 'string'
    && (entry.observationWindowStartedAt === null || typeof entry.observationWindowStartedAt === 'string')
    && typeof entry.durable === 'boolean'
    && Array.isArray(entry.counters);
}

function isValidInstanceEntry(value: unknown): value is PhaseDObservationInstanceEntry {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Partial<PhaseDObservationInstanceEntry>;
  return typeof entry.instanceId === 'string' && entry.instanceId.length > 0
    && (entry.imageDigest === null || typeof entry.imageDigest === 'string')
    && (entry.reportedSourceSha === null || typeof entry.reportedSourceSha === 'string')
    && Array.isArray(entry.snapshots) && entry.snapshots.every(isValidSnapshotEntry)
    && typeof entry.complete === 'boolean'
    && typeof entry.resets === 'number'
    && typeof entry.regressions === 'number';
}

/**
 * Validates a JSON value loaded from disk is a well-formed `PhaseDObservationReceipt` before the
 * collector trusts it as the window's history. A structurally valid but wrong-shaped file (right
 * `windowId`, an empty or junk-entry `instances` array) must never be silently accepted as "the
 * existing receipt" — that would discard or fabricate history exactly like the fleet-shrinkage
 * hazard this module otherwise defends against. Requires at least one well-formed instance entry
 * (each validated down to its snapshot shape, not just `Array.isArray`) — a receipt that has
 * genuinely observed nothing yet should not exist as a file; `existing` should be `undefined`.
 */
export function parseExistingReceipt(raw: unknown): PhaseDObservationReceipt {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('observation receipt is not a JSON object');
  }
  const candidate = raw as Partial<PhaseDObservationReceipt>;
  if (candidate.schemaVersion !== 1
    || candidate.kind !== 'jinn.phase-d-observation-window'
    || typeof candidate.windowId !== 'string' || candidate.windowId.length === 0
    || typeof candidate.approvedBy !== 'string' || candidate.approvedBy.length === 0
    || typeof candidate.startedAt !== 'string'
    || !Array.isArray(candidate.instances) || candidate.instances.length === 0
    || !candidate.instances.every(isValidInstanceEntry)) {
    throw new Error('observation receipt has an invalid or unrecognized shape');
  }
  return candidate as PhaseDObservationReceipt;
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
    const signal = (row as { signal?: unknown } | null)?.signal;
    const count = (row as { count?: unknown } | null)?.count;
    // The writer (compatibility/phase-d-transition-usage.ts) starts a counter at 1 and only
    // increments — it never persists an explicit zero or negative row. A row outside that range
    // did not come from the real mechanism; treat the whole snapshot as corrupt rather than
    // silently accepting a value more permissive than the source that's supposed to produce it.
    if (typeof row !== 'object' || row === null
      || typeof signal !== 'string'
      || typeof count !== 'number' || !Number.isSafeInteger(count) || count < 1) {
      return { ok: false };
    }
    counters.push({ signal, count });
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

/** ~3x native's 5-minute status-snapshot-loop interval (`native-phase-d-observability.ts`'s
 *  `DEFAULT_NATIVE_STATUS_SNAPSHOT_INTERVAL_MS`) — enough slack for one slow tick, still catches a
 *  writer that has stopped ticking entirely (dead/wedged process, or a box quietly flipped back to
 *  legacy while its old native snapshot file lingers on the volume). */
export const DEFAULT_NATIVE_SNAPSHOT_MAX_AGE_MS = 15 * 60_000;

/**
 * Reads a native instance's durable status snapshot (`native-phase-d-observability.ts`'s
 * `phase-d-status-snapshot.v1.json`) from a local or mounted path — native has no `/v1/status` to
 * scrape. Unlike the HTTP path (which fails closed the moment the process stops answering), a
 * frozen file on disk looks identical to a live one unless its own `generatedAt` is checked
 * against how stale it's allowed to be relative to `collectedAt` — so a dead writer degrades to
 * `{ ok: false }` rather than silently repeating the same evidence forever.
 */
export function readFileStatusSnapshot(input: {
  readonly path: string;
  readonly collectedAt: string;
  readonly maxAgeMs?: number;
  readonly readFileImpl?: (path: string) => string;
}): PhaseDObservationFetchResult {
  const readFileImpl = input.readFileImpl ?? ((path: string) => readFileSync(path, 'utf8'));
  try {
    const parsed = JSON.parse(readFileImpl(input.path)) as { generatedAt?: unknown; phaseDTransitionUsage?: unknown };
    if (typeof parsed.generatedAt !== 'string') return { ok: false };
    const generatedAtMs = Date.parse(parsed.generatedAt);
    const collectedAtMs = Date.parse(input.collectedAt);
    if (!Number.isFinite(generatedAtMs) || !Number.isFinite(collectedAtMs)) return { ok: false };
    const ageMs = collectedAtMs - generatedAtMs;
    const maxAgeMs = input.maxAgeMs ?? DEFAULT_NATIVE_SNAPSHOT_MAX_AGE_MS;
    if (ageMs < 0 || ageMs > maxAgeMs) return { ok: false };
    return parsePhaseDTransitionUsage(parsed.phaseDTransitionUsage);
  } catch {
    return { ok: false };
  }
}
