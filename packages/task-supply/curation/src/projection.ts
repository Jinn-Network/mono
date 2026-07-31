import {
  CurationInputError,
  inputRefKey,
  parseCurationObservation,
  type CurationInputRef,
  type CurationObservation,
  type Instant,
  type Sha256Digest,
} from "./observation.js";

/**
 * Which population a row aggregates. Benchmark-pinned attempts are hammered at one task by a
 * deliberate experiment, so they are not market evidence about it (design section 9,
 * "Relation to benchmarking"); they get their own row instead of polluting the organic one.
 */
export type CurationBucket = "benchmark" | "organic";

/** An exact rational. There is deliberately no float on any output of this package. */
export interface Ratio {
  readonly num: number;
  readonly den: number;
}

export interface CurationWindow {
  readonly first: Instant;
  readonly last: Instant;
}

/**
 * One `(task, bucket)` aggregate.
 *
 * `attempts` is the number of DISTINCT attempts among the observed verdicts -- not attempts
 * posted, claimed, or in flight, none of which this package can see.
 * `verdicts` counts every observed verdict, inconclusive included.
 * `passRate` is the OBSERVED pass rate over decision-grade verdicts: `num` = pass,
 * `den` = pass + fail. `verdicts - den` recovers inconclusive; `den - num` recovers fail.
 * `inputRefs` lists every announcement that fed the row -- mandatory, per design finding F6:
 * manipulation cannot be prevented here, so it is made visible and the row re-derivable.
 */
export interface CurationRow {
  readonly taskDigest: Sha256Digest;
  readonly bucket: CurationBucket;
  readonly attempts: number;
  readonly verdicts: number;
  readonly passRate: Ratio;
  readonly window: CurationWindow;
  readonly inputRefs: readonly CurationInputRef[];
}

/** Host-stored derived state. Not a record: it is never sealed, signed, or digest-addressed. */
export interface CurationProjection {
  readonly rows: readonly CurationRow[];
}

interface RowAccumulator {
  readonly taskDigest: Sha256Digest;
  readonly bucket: CurationBucket;
  pass: number;
  fail: number;
  inconclusive: number;
  first: Instant;
  last: Instant;
  readonly refs: Map<string, CurationInputRef>;
}

const ROW_KEY_SEPARATOR = "\u001f";

function rowKey(taskDigest: string, bucket: CurationBucket): string {
  return `${taskDigest}${ROW_KEY_SEPARATOR}${bucket}`;
}

function bucketOf(observation: CurationObservation): CurationBucket {
  return observation.benchmarkRun === undefined ? "organic" : "benchmark";
}

/** `Date.parse` is the one time primitive here, and it is pure. */
function instantValue(value: Instant): number {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw new CurationInputError(`observedAt is not an RFC 3339 instant: ${value}`);
  }
  return parsed;
}

/** `<` on strings is UTF-16 code-unit order -- the tie-break that keeps equal instants stable. */
function earlier(a: Instant, b: Instant): Instant {
  const av = instantValue(a);
  const bv = instantValue(b);
  if (av !== bv) return av < bv ? a : b;
  return a < b ? a : b;
}

function later(a: Instant, b: Instant): Instant {
  const av = instantValue(a);
  const bv = instantValue(b);
  if (av !== bv) return av > bv ? a : b;
  return a > b ? a : b;
}

function apply(accumulator: RowAccumulator, observation: CurationObservation): void {
  const key = inputRefKey(observation.ref);
  if (accumulator.refs.has(key)) return; // at-least-once redelivery is a no-op
  accumulator.refs.set(key, observation.ref);
  if (observation.verdict === "pass") accumulator.pass += 1;
  else if (observation.verdict === "fail") accumulator.fail += 1;
  else accumulator.inconclusive += 1;
  accumulator.first = earlier(accumulator.first, observation.observedAt);
  accumulator.last = later(accumulator.last, observation.observedAt);
}

function seed(observation: CurationObservation): RowAccumulator {
  return {
    taskDigest: observation.taskDigest,
    bucket: bucketOf(observation),
    pass: 0,
    fail: 0,
    inconclusive: 0,
    first: observation.observedAt,
    last: observation.observedAt,
    refs: new Map(),
  };
}

function finalize(accumulator: RowAccumulator): CurationRow {
  const inputRefs = [...accumulator.refs.values()].sort((a, b) => {
    const left = inputRefKey(a);
    const right = inputRefKey(b);
    return left < right ? -1 : left > right ? 1 : 0;
  });
  const attempts = new Set(inputRefs.map((ref) => ref.attemptUri)).size;
  return {
    taskDigest: accumulator.taskDigest,
    bucket: accumulator.bucket,
    attempts,
    verdicts: accumulator.pass + accumulator.fail + accumulator.inconclusive,
    passRate: { num: accumulator.pass, den: accumulator.pass + accumulator.fail },
    window: { first: accumulator.first, last: accumulator.last },
    inputRefs,
  };
}

function compareRows(a: CurationRow, b: CurationRow): number {
  const left = rowKey(a.taskDigest, a.bucket);
  const right = rowKey(b.taskDigest, b.bucket);
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Fold observations into a previous projection. Idempotent: an observation whose
 * `inputRefKey` is already present in the target row is dropped, so the subscribe plane's
 * at-least-once delivery cannot double-count. Task 6 pins that property.
 */
export function foldCuration(
  previous: CurationProjection | undefined,
  observations: readonly CurationObservation[],
): CurationProjection {
  const accumulators = new Map<string, RowAccumulator>();
  for (const row of previous?.rows ?? []) {
    accumulators.set(rowKey(row.taskDigest, row.bucket), {
      taskDigest: row.taskDigest,
      bucket: row.bucket,
      pass: row.passRate.num,
      fail: row.passRate.den - row.passRate.num,
      inconclusive: row.verdicts - row.passRate.den,
      first: row.window.first,
      last: row.window.last,
      refs: new Map(row.inputRefs.map((ref) => [inputRefKey(ref), ref])),
    });
  }
  for (const raw of observations) {
    const observation = parseCurationObservation(raw);
    const key = rowKey(observation.taskDigest, bucketOf(observation));
    let accumulator = accumulators.get(key);
    if (accumulator === undefined) {
      accumulator = seed(observation);
      accumulators.set(key, accumulator);
    }
    apply(accumulator, observation);
  }
  return { rows: [...accumulators.values()].map(finalize).sort(compareRows) };
}

/**
 * The projection, from scratch. Pure and re-derivable: the same observation multiset always
 * yields the same projection, in any order, on any machine, with no clock and no I/O.
 * Identical to `foldCuration(undefined, observations)`.
 */
export function projectCuration(
  observations: readonly CurationObservation[],
): CurationProjection {
  return foldCuration(undefined, observations);
}
