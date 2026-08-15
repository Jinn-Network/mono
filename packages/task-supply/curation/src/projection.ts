import {
  parseCurationObservation,
  type CurationInputRef,
  type CurationObservation,
  type Instant,
  type Sha256Digest,
} from "./observation.js";
import {
  CurationInputError,
  curationRowKey,
  instantValue,
  parseCurationRows,
  refDedupeKey,
} from "./schema.js";

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

/**
 * What has already been counted for one announcement dedupe key. `observation` is present only
 * for announcements seen in THIS fold: a previous projection retains each ref but not the
 * verdict behind it, so a redelivery against stored state can be checked for ref agreement but
 * not for verdict agreement. That is the closure the fold buys, stated rather than hidden.
 */
interface SeenAnnouncement {
  readonly rowKey: string;
  readonly ref: CurationInputRef;
  readonly observation?: CurationObservation;
}

function bucketOf(observation: CurationObservation): CurationBucket {
  return observation.benchmarkRun === undefined ? "organic" : "benchmark";
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

function sameRef(a: CurationInputRef, b: CurationInputRef): boolean {
  return (
    a.source.agent === b.source.agent &&
    a.source.name === b.source.name &&
    a.entry === b.entry &&
    a.announcementId === b.announcementId &&
    a.record === b.record &&
    a.attemptUri === b.attemptUri
  );
}

/**
 * Two observations sharing a dedupe key must be the same observation. Dropping the second one
 * silently would make the projection depend on arrival order and would leave the discarded
 * announcement out of `inputRefs` entirely -- invisible in the published inputs, which is the
 * one thing design F6 makes this unit responsible for. So it fails closed instead.
 */
function assertNoConflict(
  seen: SeenAnnouncement,
  rowKey: string,
  observation: CurationObservation,
): void {
  const reject = (field: string): never => {
    throw new CurationInputError(
      `conflicting observations share the announcement dedupe key ` +
        `(source ${observation.ref.source.agent}/${observation.ref.source.name}, ` +
        `announcement ${observation.ref.announcementId}): ${field} differs`,
    );
  };
  if (seen.rowKey !== rowKey) reject("the task or bucket it feeds");
  if (!sameRef(seen.ref, observation.ref)) reject("the input ref");
  const previous = seen.observation;
  if (previous === undefined) return;
  if (previous.verdict !== observation.verdict) reject("verdict");
  if (previous.observedAt !== observation.observedAt) reject("observedAt");
  if (previous.attribution !== observation.attribution) reject("attribution");
  if (previous.benchmarkRun !== observation.benchmarkRun) reject("benchmarkRun");
}

function apply(accumulator: RowAccumulator, observation: CurationObservation): void {
  accumulator.refs.set(refDedupeKey(observation.ref), observation.ref);
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
    const left = refDedupeKey(a);
    const right = refDedupeKey(b);
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
  const left = curationRowKey(a.taskDigest, a.bucket);
  const right = curationRowKey(b.taskDigest, b.bucket);
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Fold observations into a previous projection. Idempotent: an exact redelivery of an
 * announcement already counted is a no-op, so the subscribe plane's at-least-once delivery
 * cannot double-count. A redelivery that DISAGREES with what was counted is not a redelivery
 * and is refused (`CurationInputError`), because silently keeping the first one would make the
 * published rate depend on arrival order.
 *
 * `previous` is validated exactly as strictly as an observation is: it is stored state, which
 * is to say untrusted input, and a row whose counters outrun its `inputRefs` is a rate with no
 * attribution-preserving inputs behind it.
 */
export function foldCuration(
  previous: CurationProjection | undefined,
  observations: readonly CurationObservation[],
): CurationProjection {
  const accumulators = new Map<string, RowAccumulator>();
  const seen = new Map<string, SeenAnnouncement>();
  for (const row of previous === undefined ? [] : parseCurationRows(previous.rows)) {
    const key = curationRowKey(row.taskDigest, row.bucket);
    accumulators.set(key, {
      taskDigest: row.taskDigest,
      bucket: row.bucket,
      pass: row.passRate.num,
      fail: row.passRate.den - row.passRate.num,
      inconclusive: row.verdicts - row.passRate.den,
      first: row.window.first,
      last: row.window.last,
      refs: new Map(row.inputRefs.map((ref) => [refDedupeKey(ref), ref])),
    });
    for (const ref of row.inputRefs) seen.set(refDedupeKey(ref), { rowKey: key, ref });
  }
  for (const raw of observations) {
    const observation = parseCurationObservation(raw);
    const key = curationRowKey(observation.taskDigest, bucketOf(observation));
    const dedupeKey = refDedupeKey(observation.ref);
    const already = seen.get(dedupeKey);
    if (already !== undefined) {
      assertNoConflict(already, key, observation);
      continue; // an exact redelivery, and therefore a no-op
    }
    seen.set(dedupeKey, { rowKey: key, ref: observation.ref, observation });
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
