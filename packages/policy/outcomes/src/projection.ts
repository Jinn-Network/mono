import type { JsonValue } from "@jinn-network/policy-identity";
import {
  parsePolicyOutcomeObservation,
  type Instant,
  type PerAxisStatus,
  type PolicyOutcomeInputRef,
  type PolicyOutcomeObservation,
  type Sha256Digest,
} from "./observation.js";
import {
  PolicyOutcomesInputError,
  instantValue,
  parsePolicyOutcomesRows,
  policyOutcomesRowKey,
  refDedupeKey,
} from "./schema.js";
import { denormalizeAxes, tupleDigest } from "./tuple-support.js";

/**
 * Which population a row aggregates. Benchmark-pinned attempts are hammered at one tuple by a
 * deliberate experiment, so they are not market evidence about it; they get their own row
 * instead of polluting the organic one (mirrors `@jinn-network/task-curation`).
 */
export type PolicyOutcomesBucket = "benchmark" | "organic";

/** An exact rational. There is deliberately no float on any output of this package. */
export interface Ratio {
  readonly num: number;
  readonly den: number;
}

export interface PolicyOutcomesWindow {
  readonly first: Instant;
  readonly last: Instant;
}

/** Substrate §7 -- per-axis counts of what verification established, across the row's observations. */
export interface PinningCounts {
  readonly match: number;
  readonly mismatch: number;
  readonly unverifiable: number;
}

export interface PolicyOutcomesPinning {
  readonly harness: PinningCounts;
  readonly model: PinningCounts;
  readonly loadout: PinningCounts;
  readonly isolationPolicy: PinningCounts;
}

/**
 * One `(tupleDigest, bucket)` aggregate (substrate §6.1).
 *
 * `axes` denormalizes the tuple's own values onto the row for filtering; it is not a second
 * source of truth -- every observation folded into a row is required to hash (via `tupleDigest`)
 * to this row's key, so all of them share canonically-identical tuple bytes.
 * `pinning` counts, per axis, what the observed verdicts disclosed about treatment fidelity
 * (substrate §7): a consumer may exclude rows or observations whose load-bearing axes are not
 * `match` -- that is the consumer's cohort filter, same as curation's sybil posture.
 */
export interface PolicyOutcomesRow {
  readonly tupleDigest: Sha256Digest;
  readonly axes: Readonly<Record<string, JsonValue>>;
  readonly bucket: PolicyOutcomesBucket;
  readonly attempts: number;
  readonly verdicts: number;
  readonly passRate: Ratio;
  readonly pinning: PolicyOutcomesPinning;
  readonly window: PolicyOutcomesWindow;
  readonly inputRefs: readonly PolicyOutcomeInputRef[];
}

/** Host-stored derived state. Not a record: it is never sealed, signed, or digest-addressed. */
export interface PolicyOutcomesProjection {
  readonly rows: readonly PolicyOutcomesRow[];
}

const PINNING_AXES = ["harness", "model", "loadout", "isolationPolicy"] as const;

interface RowAccumulator {
  readonly tupleDigest: Sha256Digest;
  readonly axes: Readonly<Record<string, JsonValue>>;
  readonly bucket: PolicyOutcomesBucket;
  pass: number;
  fail: number;
  inconclusive: number;
  readonly pinning: {
    harness: { match: number; mismatch: number; unverifiable: number };
    model: { match: number; mismatch: number; unverifiable: number };
    loadout: { match: number; mismatch: number; unverifiable: number };
    isolationPolicy: { match: number; mismatch: number; unverifiable: number };
  };
  first: Instant;
  last: Instant;
  readonly refs: Map<string, PolicyOutcomeInputRef>;
}

/**
 * What has already been counted for one announcement dedupe key. `observation` is present only
 * for announcements seen in THIS fold: a previous projection retains each ref but not the
 * observation behind it, so a redelivery against stored state can be checked for ref agreement
 * but not for full observation agreement.
 */
interface SeenAnnouncement {
  readonly rowKey: string;
  readonly ref: PolicyOutcomeInputRef;
  readonly observation?: PolicyOutcomeObservation;
}

function bucketOf(observation: PolicyOutcomeObservation): PolicyOutcomesBucket {
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

function sameRef(a: PolicyOutcomeInputRef, b: PolicyOutcomeInputRef): boolean {
  return (
    a.source.agent === b.source.agent &&
    a.source.name === b.source.name &&
    a.entry === b.entry &&
    a.announcementId === b.announcementId &&
    a.record === b.record &&
    a.attemptUri === b.attemptUri
  );
}

function samePerAxisStatus(a: PerAxisStatus, b: PerAxisStatus): boolean {
  return (
    a.harness === b.harness &&
    a.model === b.model &&
    a.loadout === b.loadout &&
    a.isolationPolicy === b.isolationPolicy
  );
}

/**
 * Two observations sharing a dedupe key must be the same observation. Dropping the second one
 * silently would make the projection depend on arrival order and would leave the discarded
 * announcement out of `inputRefs` -- invisible in the published inputs. So it fails closed
 * instead (mirrors curation's `assertNoConflict`, extended with the policy-specific fields).
 */
function assertNoConflict(
  seen: SeenAnnouncement,
  rowKey: string,
  observation: PolicyOutcomeObservation,
): void {
  const reject = (field: string): never => {
    throw new PolicyOutcomesInputError(
      `conflicting observations share the announcement dedupe key ` +
        `(source ${observation.ref.source.agent}/${observation.ref.source.name}, ` +
        `announcement ${observation.ref.announcementId}): ${field} differs`,
    );
  };
  if (seen.rowKey !== rowKey) reject("the tuple or bucket it feeds");
  if (!sameRef(seen.ref, observation.ref)) reject("the input ref");
  const previous = seen.observation;
  if (previous === undefined) return;
  if (previous.verdict !== observation.verdict) reject("verdict");
  if (previous.observedAt !== observation.observedAt) reject("observedAt");
  if (previous.attribution !== observation.attribution) reject("attribution");
  if (previous.benchmarkRun !== observation.benchmarkRun) reject("benchmarkRun");
  if (previous.taskDigest !== observation.taskDigest) reject("taskDigest");
  if (!samePerAxisStatus(previous.perAxisStatus, observation.perAxisStatus)) reject("perAxisStatus");
}

function apply(accumulator: RowAccumulator, observation: PolicyOutcomeObservation): void {
  accumulator.refs.set(refDedupeKey(observation.ref), observation.ref);
  if (observation.verdict === "pass") accumulator.pass += 1;
  else if (observation.verdict === "fail") accumulator.fail += 1;
  else accumulator.inconclusive += 1;
  for (const axis of PINNING_AXES) {
    accumulator.pinning[axis][observation.perAxisStatus[axis]] += 1;
  }
  accumulator.first = earlier(accumulator.first, observation.observedAt);
  accumulator.last = later(accumulator.last, observation.observedAt);
}

function seed(observation: PolicyOutcomeObservation, digest: Sha256Digest): RowAccumulator {
  return {
    tupleDigest: digest,
    axes: denormalizeAxes(observation.tuple),
    bucket: bucketOf(observation),
    pass: 0,
    fail: 0,
    inconclusive: 0,
    pinning: {
      harness: { match: 0, mismatch: 0, unverifiable: 0 },
      model: { match: 0, mismatch: 0, unverifiable: 0 },
      loadout: { match: 0, mismatch: 0, unverifiable: 0 },
      isolationPolicy: { match: 0, mismatch: 0, unverifiable: 0 },
    },
    first: observation.observedAt,
    last: observation.observedAt,
    refs: new Map(),
  };
}

function finalize(accumulator: RowAccumulator): PolicyOutcomesRow {
  const inputRefs = [...accumulator.refs.values()].sort((a, b) => {
    const left = refDedupeKey(a);
    const right = refDedupeKey(b);
    return left < right ? -1 : left > right ? 1 : 0;
  });
  const attempts = new Set(inputRefs.map((ref) => ref.attemptUri)).size;
  return {
    tupleDigest: accumulator.tupleDigest,
    axes: accumulator.axes,
    bucket: accumulator.bucket,
    attempts,
    verdicts: accumulator.pass + accumulator.fail + accumulator.inconclusive,
    passRate: { num: accumulator.pass, den: accumulator.pass + accumulator.fail },
    pinning: {
      harness: { ...accumulator.pinning.harness },
      model: { ...accumulator.pinning.model },
      loadout: { ...accumulator.pinning.loadout },
      isolationPolicy: { ...accumulator.pinning.isolationPolicy },
    },
    window: { first: accumulator.first, last: accumulator.last },
    inputRefs,
  };
}

function compareRows(a: PolicyOutcomesRow, b: PolicyOutcomesRow): number {
  const left = policyOutcomesRowKey(a.tupleDigest, a.bucket);
  const right = policyOutcomesRowKey(b.tupleDigest, b.bucket);
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Fold observations into a previous projection. Idempotent: an exact redelivery of an
 * announcement already counted is a no-op. A redelivery that DISAGREES with what was counted is
 * refused (`PolicyOutcomesInputError`), never silently kept-first.
 *
 * `previous` is stored state, which is to say untrusted input: it is validated exactly as
 * strictly as an observation, and rows are reconstructed, not passed through.
 */
export function foldPolicyOutcomes(
  previous: PolicyOutcomesProjection | undefined,
  observations: readonly PolicyOutcomeObservation[],
): PolicyOutcomesProjection {
  const accumulators = new Map<string, RowAccumulator>();
  const seen = new Map<string, SeenAnnouncement>();
  for (const row of previous === undefined ? [] : parsePolicyOutcomesRows(previous.rows)) {
    const key = policyOutcomesRowKey(row.tupleDigest, row.bucket);
    accumulators.set(key, {
      tupleDigest: row.tupleDigest,
      axes: row.axes,
      bucket: row.bucket,
      pass: row.passRate.num,
      fail: row.passRate.den - row.passRate.num,
      inconclusive: row.verdicts - row.passRate.den,
      pinning: {
        harness: { ...row.pinning.harness },
        model: { ...row.pinning.model },
        loadout: { ...row.pinning.loadout },
        isolationPolicy: { ...row.pinning.isolationPolicy },
      },
      first: row.window.first,
      last: row.window.last,
      refs: new Map(row.inputRefs.map((ref) => [refDedupeKey(ref), ref])),
    });
    for (const ref of row.inputRefs) seen.set(refDedupeKey(ref), { rowKey: key, ref });
  }
  for (const raw of observations) {
    const observation = parsePolicyOutcomeObservation(raw);
    const digest = tupleDigest(observation.tuple) as Sha256Digest;
    const key = policyOutcomesRowKey(digest, bucketOf(observation));
    const dedupeKey = refDedupeKey(observation.ref);
    const already = seen.get(dedupeKey);
    if (already !== undefined) {
      assertNoConflict(already, key, observation);
      continue; // an exact redelivery, and therefore a no-op
    }
    seen.set(dedupeKey, { rowKey: key, ref: observation.ref, observation });
    let accumulator = accumulators.get(key);
    if (accumulator === undefined) {
      accumulator = seed(observation, digest);
      accumulators.set(key, accumulator);
    }
    apply(accumulator, observation);
  }
  return { rows: [...accumulators.values()].map(finalize).sort(compareRows) };
}

/**
 * The projection, from scratch. Pure and re-derivable: the same observation multiset always
 * yields the same projection, in any order, on any machine, with no clock and no I/O. Identical
 * to `foldPolicyOutcomes(undefined, observations)`.
 */
export function projectPolicyOutcomes(
  observations: readonly PolicyOutcomeObservation[],
): PolicyOutcomesProjection {
  return foldPolicyOutcomes(undefined, observations);
}
