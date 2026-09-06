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
  verifiedDeliveries: number;
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
  manifests: SupplyManifestRow[];
  tasks: SupplyTaskRow[];
  attempts: SupplyAttemptRow[];
  verdicts: SupplyVerdictRow[];
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

function unknown(input: BuildCurrentSupplyInput): CurrentSupplyResponse {
  return {
    ...baseResult(input),
    status: 'unknown',
    reason: 'incomplete_indexer_evidence',
    classes: [],
  };
}

function validTimestamp(value: bigint): boolean {
  return value > 0n && value <= BigInt(Number.MAX_SAFE_INTEGER);
}

/**
 * Aggregate requestable supply from native indexed facts. Any incomplete
 * enrichment, unusable event time, or orphaned chain tuple makes the answer
 * unknown instead of turning missing evidence into a false zero.
 */
export function buildCurrentSupply(input: BuildCurrentSupplyInput): CurrentSupplyResponse {
  if (!Number.isSafeInteger(input.chainId) || input.chainId <= 0 || !Number.isFinite(input.asOfMs)) {
    return unknown(input);
  }

  const base = baseResult(input);
  const windowStart = BigInt(Date.parse(base.window.start) / 1_000);
  const windowEnd = BigInt(Date.parse(base.window.end) / 1_000);
  const launched = input.manifests.filter(
    (row) => row.chainId === input.chainId && row.status === 'launched',
  );
  if (launched.some((row) => row.manifestEnrichmentStatus !== 'ok')) return unknown(input);

  const requestable = launched.filter((row) => row.openRoles.includes('solver'));
  if (requestable.some((row) => !row.contractId.trim() || !row.contractVersion.trim() || !row.cidKeccak)) {
    return unknown(input);
  }
  if (requestable.length === 0) {
    return { ...base, status: 'zero_supply', reason: 'no_requestable_solver_nets', classes: [] };
  }

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
    if (prior && prior !== workClass) return unknown(input);
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
    if (prior && prior.manifestDigest.toLowerCase() !== row.manifestDigest.toLowerCase()) return unknown(input);
    taskById.set(row.id, row);
  }

  const attemptByKey = new Map<string, SupplyAttemptRow>();
  for (const row of input.attempts) {
    if (row.chainId !== input.chainId) continue;
    if (!validTimestamp(row.createdAtTimestamp) || !Number.isSafeInteger(row.attemptIndex) || row.attemptIndex < 0) {
      return unknown(input);
    }
    const task = taskById.get(row.taskId);
    if (!task) return unknown(input);
    const key = activityKey(row.chainId, row.taskId, row.attemptIndex);
    const prior = attemptByKey.get(key);
    if (prior && prior.operator.toLowerCase() !== row.operator.toLowerCase()) return unknown(input);
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
      || row.verdictCode < 0
      || row.verdictCode > 4
    ) return unknown(input);
    const attempt = attemptByKey.get(activityKey(row.chainId, row.taskId, row.attemptIndex));
    if (!attempt) return unknown(input);
    const task = taskById.get(row.taskId);
    if (!task) return unknown(input);
    const workClass = classByDigest.get(task.manifestDigest.toLowerCase());
    if (!workClass || row.createdAtTimestamp < windowStart || row.createdAtTimestamp >= windowEnd) continue;
    const aggregate = classRows.get(workClass)!;
    aggregate.verdicts.add(`${row.chainId}:${row.taskId}:${row.attemptIndex}:${row.verdictIndex}`);
    if (row.createdAtTimestamp > aggregate.latestVerdict) aggregate.latestVerdict = row.createdAtTimestamp;
  }

  const classes = [...classRows.entries()]
    .filter(([, row]) => row.operators.size > 0 && row.verdicts.size > 0)
    .map(([workClass, row]): SupplyClass => ({
      workClass,
      contractId: row.contractId,
      contractVersion: row.contractVersion,
      acceptingSolverNets: row.manifestIds.size,
      claimingOperators: row.operators.size,
      verifiedDeliveries: row.verdicts.size,
      latestAttemptAt: isoFromSeconds(Number(row.latestAttempt)),
      latestVerdictAt: isoFromSeconds(Number(row.latestVerdict)),
    }))
    .sort((a, b) => a.workClass.localeCompare(b.workClass));

  if (classes.length === 0) {
    return { ...base, status: 'zero_supply', reason: 'no_recent_completed_loops', classes: [] };
  }
  return { ...base, status: 'available', classes };
}
