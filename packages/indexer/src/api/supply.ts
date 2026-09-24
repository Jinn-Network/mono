const BUCKET_SECONDS = 6 * 60 * 60;
const BUCKET_COUNT = 8;

export type SupplyStatus = 'available' | 'zero_supply' | 'unknown';
export type SupplyReason =
  | 'no_requestable_solver_nets'
  | 'no_recent_completed_loops'
  | 'incomplete_indexer_evidence';

export interface SupplyBucket {
  start: string;
  end: string;
}

export interface SupplyWindow {
  start: string;
  end: string;
  bucketHours: 6;
  buckets: SupplyBucket[];
}

export interface SupplyClass {
  workClass: string;
  contractId: string;
  contractVersion: string;
  acceptingSolverNets: number;
  claimingOperators: number;
  /**
   * Verdicts delivered in the window for this class — loop CLOSURE, not loop
   * success. Every `VerdictCode` counts: the on-chain code defaults to `Pass`
   * before enrichment (see `api/explorer.ts`), so filtering on it would be
   * false precision. A requester reads this as "work here reaches an
   * evaluator", never as "work here passes".
   */
  verdictDeliveries: number;
  latestAttemptAt: string;
  latestVerdictAt: string;
}

export interface CurrentSupplyResponse {
  schemaVersion: 1;
  status: SupplyStatus;
  chainId: number;
  generatedAt: string;
  window: SupplyWindow;
  classes: SupplyClass[];
  reason?: SupplyReason;
  /**
   * How many launched SolverNet rows on this chain carried incomplete manifest
   * evidence and were therefore excluded from `classes`. Absent when every
   * launched row was usable, and never present unless `status` is `available`
   * — an incomplete row can only ever downgrade a would-be zero to `unknown`
   * (see `buildCurrentSupply`), so it has nothing to mark on the other two.
   *
   * Present, it means `classes` is known-possibly-SHORT: a class whose only
   * manifest rows were the excluded ones is missing entirely. A requester must
   * therefore read a class's ABSENCE from this response as "no evidence", not
   * as "no supply"; the classes that ARE listed are still proven.
   */
  incompleteManifestRows?: number;
  /**
   * How many attempt or verdict rows on this chain had no matching task and
   * were therefore excluded from `classes`. Absent when every activity row
   * joined, and never present unless `status` is `available` — an incomplete
   * row can only ever downgrade a would-be zero to `unknown` (see
   * `buildCurrentSupply`), so it has nothing to mark on the other two.
   *
   * Present, it means `classes` is known-possibly-SHORT: a class whose only
   * activity rows were the excluded ones is missing entirely. A requester must
   * therefore read a class's ABSENCE from this response as "no evidence", not
   * as "no supply"; the classes that ARE listed are still proven.
   */
  incompleteActivityRows?: number;
}

export interface SupplyManifestRow {
  id: string;
  cidKeccak: string;
  status: string;
  chainId: number;
  openRoles: string[];
  contractId: string;
  contractVersion: string;
  manifestEnrichmentStatus: string;
}

export interface SupplyTaskRow {
  id: string;
  manifestDigest: string;
  chainId: number;
}

export interface SupplyAttemptRow {
  taskId: string;
  attemptIndex: number;
  operator: string;
  chainId: number;
  createdAtTimestamp: bigint;
}

export interface SupplyVerdictRow {
  taskId: string;
  attemptIndex: number;
  verdictIndex: number;
  verdictCode: number;
  chainId: number;
  createdAtTimestamp: bigint;
}

export interface BuildCurrentSupplyInput {
  chainId: number;
  asOfMs: number;
  /** False when the launched-SolverNet inventory query was capped. */
  manifestEvidenceComplete: boolean;
  /** False when an activity query was capped or encountered unusable event time. */
  activityEvidenceComplete: boolean;
  manifests: SupplyManifestRow[];
  tasks: SupplyTaskRow[];
  attempts: SupplyAttemptRow[];
  verdicts: SupplyVerdictRow[];
}

export type SupplyChainIdResolution =
  | { ok: true; chainId: number }
  | { ok: false; error: string; detail: string };

/**
 * Resolve the `?chainId=` a supply request may be answered for.
 *
 * A chain this deployment does not index has no rows, and "no rows" is
 * indistinguishable at the database from "this chain is genuinely empty" — so
 * answering it at all would render total absence of evidence as an
 * authoritative `zero_supply`. Refusing is the honest reply.
 */
export function resolveSupplyChainId(
  raw: string | undefined,
  servedChainIds: readonly number[],
): SupplyChainIdResolution {
  const chainId = Number(raw);
  if (raw === undefined || raw.trim() === '' || !Number.isSafeInteger(chainId) || chainId <= 0) {
    return {
      ok: false,
      error: 'invalid chainId',
      detail: `provide a positive integer ?chainId=; this indexer serves ${servedChainIds.join(', ')}`,
    };
  }
  if (!servedChainIds.includes(chainId)) {
    return {
      ok: false,
      error: 'unsupported chainId',
      detail: `this indexer serves ${servedChainIds.join(', ')}; it has no evidence about ${chainId}`,
    };
  }
  return { ok: true, chainId };
}

function isoFromSeconds(seconds: number): string {
  return new Date(seconds * 1_000).toISOString();
}

export function completedSupplyWindow(asOfMs: number): SupplyWindow {
  const asOfSeconds = Math.floor(asOfMs / 1_000);
  const endSeconds = Math.floor(asOfSeconds / BUCKET_SECONDS) * BUCKET_SECONDS;
  const startSeconds = endSeconds - BUCKET_COUNT * BUCKET_SECONDS;
  const buckets = Array.from({ length: BUCKET_COUNT }, (_, index) => {
    const start = startSeconds + index * BUCKET_SECONDS;
    return { start: isoFromSeconds(start), end: isoFromSeconds(start + BUCKET_SECONDS) };
  });
  return {
    start: isoFromSeconds(startSeconds),
    end: isoFromSeconds(endSeconds),
    bucketHours: 6,
    buckets,
  };
}

function activityKey(chainId: number, taskId: string, attemptIndex: number): string {
  return `${chainId}:${taskId}:${attemptIndex}`;
}

function baseResult(input: BuildCurrentSupplyInput): Omit<CurrentSupplyResponse, 'status' | 'classes'> {
  return {
    schemaVersion: 1,
    chainId: input.chainId,
    generatedAt: new Date(input.asOfMs).toISOString(),
    window: completedSupplyWindow(input.asOfMs),
  };
}

function unknown(input: BuildCurrentSupplyInput, because: string): {
  response: CurrentSupplyResponse;
  unknownBecause: string;
} {
  return {
    response: {
      ...baseResult(input),
      status: 'unknown',
      reason: 'incomplete_indexer_evidence',
      classes: [],
    },
    unknownBecause: because,
  };
}

/** Largest millisecond value `Date` can represent; beyond it `toISOString` throws. */
const MAX_TIME_MS = 8_640_000_000_000_000;

/** The instant to report on, or `null` when it cannot be rendered at all. */
function usableAsOfMs(value: number): number | null {
  return Number.isFinite(value) && Math.abs(value) <= MAX_TIME_MS ? value : null;
}

function validTimestamp(value: bigint): boolean {
  return value > 0n && value <= BigInt(Number.MAX_SAFE_INTEGER);
}

export interface AssembledCurrentSupply {
  response: CurrentSupplyResponse;
  /** Present only when `response.status` is `unknown`. Never part of the HTTP body. */
  unknownBecause?: string;
}

/**
 * Aggregate requestable supply from native indexed facts. Unusable event time
 * and orphaned chain tuples make the whole answer unknown — they are read as
 * index corruption, which nothing in the response can be trusted against.
 * Incomplete per-row manifest enrichment is narrower: it excludes its own row
 * and can only downgrade a would-be `zero_supply` to `unknown`, marked on the
 * result as `incompleteManifestRows`. Neither path ever turns missing evidence
 * into a false zero.
 *
 * `unknownBecause` names the first failing guard for server-side logs. It is
 * not a client field.
 */
export function assembleCurrentSupply(input: BuildCurrentSupplyInput): AssembledCurrentSupply {
  // An unrenderable `asOfMs` is still answered — as `unknown`, stamped with the
  // real clock. Reporting the caller's own bad value back would throw inside
  // `baseResult` and turn a guarded input into a 503.
  if (usableAsOfMs(input.asOfMs) === null) {
    return unknown({ ...input, asOfMs: Date.now() }, 'unrenderable asOfMs');
  }
  if (!Number.isSafeInteger(input.chainId) || input.chainId <= 0) {
    return unknown(input, 'invalid chainId');
  }

  const base = baseResult(input);
  if (!input.manifestEvidenceComplete) return unknown(input, 'manifest evidence capped');
  const windowStart = BigInt(Date.parse(base.window.start) / 1_000);
  const windowEnd = BigInt(Date.parse(base.window.end) / 1_000);
  const launched = input.manifests.filter(
    (row) => row.chainId === input.chainId && row.status === 'launched',
  );
  // Completeness is judged over EVERY launched row, before the role filter.
  // `manifestEnrichmentStatus: 'ok'` does not imply complete fields —
  // `parseSolverNetManifestLite` degrades a missing/oddly-shaped `roles` to
  // `[]`, and defaults an absent `contract` tuple to blank strings — so a row
  // filtered out for having no roles would otherwise leave the requestable set
  // silently short and turn missing evidence into a false
  // `no_requestable_solver_nets`.
  //
  // The consequence is deliberately MONOTONE: an unusable row invalidates a
  // claim of emptiness, never a positive finding. A single manifest whose IPFS
  // enrichment timed out — there is no retry path; the row stays degraded
  // until its next `MetadataSet` — must not black out a chain whose other
  // classes have complete evidence and real in-window loops, because nothing
  // that row could contain would subtract from them.
  const complete = launched.filter((row) => row.manifestEnrichmentStatus === 'ok'
    && row.openRoles.length > 0
    && row.contractId.trim() !== ''
    && row.contractVersion.trim() !== ''
    && Boolean(row.cidKeccak));
  const incompleteManifestRows = launched.length - complete.length;

  const requestable = complete.filter((row) => row.openRoles.includes('solver'));
  if (requestable.length === 0) {
    // An excluded row could have been the requestable one; the zero is unproven.
    if (incompleteManifestRows > 0) return unknown(input, 'incomplete launched manifest rows');
    return { response: { ...base, status: 'zero_supply', reason: 'no_requestable_solver_nets', classes: [] } };
  }
  if (!input.activityEvidenceComplete) return unknown(input, 'activity evidence capped');

  const classByDigest = new Map<string, string>();
  const classRows = new Map<string, {
    contractId: string;
    contractVersion: string;
    manifestIds: Set<string>;
    operators: Set<string>;
    verdicts: Set<string>;
    latestAttempt: bigint;
    latestVerdict: bigint;
  }>();
  for (const row of requestable) {
    const workClass = `${row.contractId}.${row.contractVersion}`;
    const digest = row.cidKeccak.toLowerCase();
    const prior = classByDigest.get(digest);
    if (prior && prior !== workClass) return unknown(input, 'contradictory manifest digest');
    classByDigest.set(digest, workClass);
    const aggregate = classRows.get(workClass) ?? {
      contractId: row.contractId,
      contractVersion: row.contractVersion,
      manifestIds: new Set<string>(),
      operators: new Set<string>(),
      verdicts: new Set<string>(),
      latestAttempt: 0n,
      latestVerdict: 0n,
    };
    aggregate.manifestIds.add(row.id);
    classRows.set(workClass, aggregate);
  }

  const taskById = new Map<string, SupplyTaskRow>();
  for (const row of input.tasks) {
    if (row.chainId !== input.chainId) continue;
    const prior = taskById.get(row.id);
    if (prior && prior.manifestDigest.toLowerCase() !== row.manifestDigest.toLowerCase()) {
      return unknown(input, 'contradictory task digest');
    }
    taskById.set(row.id, row);
  }

  // The route caller passes `attempts` as in-window rows PLUS attempts
  // referenced by an in-window verdict's task, fetched again WITHOUT the
  // window filter — so the same physical row can appear twice, and a prior
  // attempt for an orphaned task can appear out-of-window. Counting distinct
  // KEYS (rather than incrementing per row) absorbs the route's duplication;
  // scoping to the window excludes rows that were never window evidence to
  // begin with, so neither can inflate `incompleteActivityRows` beyond the
  // physical rows actually excluded from the window's answer.
  const incompleteAttemptKeys = new Set<string>();
  const incompleteVerdictKeys = new Set<string>();
  const attemptByKey = new Map<string, SupplyAttemptRow>();
  for (const row of input.attempts) {
    if (row.chainId !== input.chainId) continue;
    if (!validTimestamp(row.createdAtTimestamp) || !Number.isSafeInteger(row.attemptIndex) || row.attemptIndex < 0) {
      return unknown(input, 'unusable attempt timestamp or index');
    }
    const key = activityKey(row.chainId, row.taskId, row.attemptIndex);
    const task = taskById.get(row.taskId);
    if (!task) {
      if (row.createdAtTimestamp >= windowStart && row.createdAtTimestamp < windowEnd) {
        incompleteAttemptKeys.add(key);
      }
      continue;
    }
    const prior = attemptByKey.get(key);
    if (prior && prior.operator.toLowerCase() !== row.operator.toLowerCase()) {
      return unknown(input, 'contradictory attempt operator');
    }
    attemptByKey.set(key, row);

    const workClass = classByDigest.get(task.manifestDigest.toLowerCase());
    if (!workClass || row.createdAtTimestamp < windowStart || row.createdAtTimestamp >= windowEnd) continue;
    const aggregate = classRows.get(workClass)!;
    aggregate.operators.add(row.operator.toLowerCase());
    if (row.createdAtTimestamp > aggregate.latestAttempt) aggregate.latestAttempt = row.createdAtTimestamp;
  }

  for (const row of input.verdicts) {
    if (row.chainId !== input.chainId) continue;
    if (
      !validTimestamp(row.createdAtTimestamp)
      || !Number.isSafeInteger(row.attemptIndex)
      || row.attemptIndex < 0
      || !Number.isSafeInteger(row.verdictIndex)
      || row.verdictIndex < 0
      || !Number.isSafeInteger(row.verdictCode)
    ) return unknown(input, 'unusable verdict timestamp or index');
    if (row.createdAtTimestamp < windowStart || row.createdAtTimestamp >= windowEnd) continue;
    // The attempt must exist — a verdict with no attempt row is a broken join
    // and makes the whole answer unknown. Its AGE, however, is ordinary: a task
    // claimed before the window and delivered inside it is a healthy long loop,
    // not corruption. Callers therefore supply the attempts referenced by
    // in-window verdicts regardless of when those attempts were created, and an
    // out-of-window attempt still never counts toward `operators` below.
    // A missing task is narrower: skip the row (do not insert it as live
    // activity) and refuse only an unproven zero, same monotone rule as
    // incomplete manifests. Skip the task join BEFORE the attempt lookup so a
    // skipped attempt cannot black out the chain through the verdict join.
    const task = taskById.get(row.taskId);
    if (!task) {
      // Already window-scoped by the `continue` above; verdict identity
      // includes verdictIndex, so its key namespace cannot collide with an
      // attempt key of the same chain/task/attemptIndex.
      incompleteVerdictKeys.add(`${row.chainId}:${row.taskId}:${row.attemptIndex}:${row.verdictIndex}`);
      continue;
    }
    const attempt = attemptByKey.get(activityKey(row.chainId, row.taskId, row.attemptIndex));
    if (!attempt) return unknown(input, 'verdict with no attempt');
    const workClass = classByDigest.get(task.manifestDigest.toLowerCase());
    if (!workClass) continue;
    const aggregate = classRows.get(workClass)!;
    aggregate.verdicts.add(`${row.chainId}:${row.taskId}:${row.attemptIndex}:${row.verdictIndex}`);
    if (row.createdAtTimestamp > aggregate.latestVerdict) aggregate.latestVerdict = row.createdAtTimestamp;
  }

  const incompleteActivityRows = incompleteAttemptKeys.size + incompleteVerdictKeys.size;

  const classes = [...classRows.entries()]
    .filter(([, row]) => row.operators.size > 0 && row.verdicts.size > 0)
    .map(([workClass, row]): SupplyClass => ({
      workClass,
      contractId: row.contractId,
      contractVersion: row.contractVersion,
      acceptingSolverNets: row.manifestIds.size,
      claimingOperators: row.operators.size,
      verdictDeliveries: row.verdicts.size,
      latestAttemptAt: isoFromSeconds(Number(row.latestAttempt)),
      latestVerdictAt: isoFromSeconds(Number(row.latestVerdict)),
    }))
    .sort((a, b) => (a.workClass < b.workClass ? -1 : a.workClass > b.workClass ? 1 : 0));

  if (classes.length === 0) {
    // Same monotone rule at the activity layer: an excluded row could have
    // carried the class that IS live, so the zero stays unproven.
    if (incompleteManifestRows > 0 || incompleteActivityRows > 0) {
      return unknown(input, 'incomplete rows with no live class');
    }
    return { response: { ...base, status: 'zero_supply', reason: 'no_recent_completed_loops', classes: [] } };
  }
  return {
    response: {
      ...base,
      status: 'available',
      classes,
      ...(incompleteManifestRows > 0 ? { incompleteManifestRows } : {}),
      ...(incompleteActivityRows > 0 ? { incompleteActivityRows } : {}),
    },
  };
}

export function buildCurrentSupply(input: BuildCurrentSupplyInput): CurrentSupplyResponse {
  return assembleCurrentSupply(input).response;
}
