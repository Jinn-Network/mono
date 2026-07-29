import { compareCodeUnitStrings } from "../order.js";
import { TaskSpecificationSchema } from "@jinn-network/task-execution-protocol";
import { serializeCanonicalJson } from "../canonical.js";
import { LowercaseSha256HexSchema } from "../descriptors.js";
import { documentDigest, sha256Hex } from "../hashing.js";
import type { JsonValue } from "../json.js";
import { compareCalendarStrictRfc3339Instants, isCalendarStrictRfc3339 } from "../rfc3339.js";
import { itemTaskDigest, parseBenchmark, type BenchmarkRecord } from "./schema.js";

/** Named check `benchmark-item-distinctness` (§6.1): item Task digests must be distinct. */
export function checkItemDistinctness(
  rec: BenchmarkRecord,
): { ok: true } | { ok: false; duplicate: string } {
  const seen = new Set<string>();
  for (const item of rec.items) {
    const digest = itemTaskDigest(item);
    if (seen.has(digest)) return { ok: false, duplicate: digest };
    seen.add(digest);
  }
  return { ok: true };
}

export type TaskBytesResolver = (taskDigest: string) => Uint8Array | undefined;

/** Trusted, caller-supplied facts needed to distinguish genuinely pre-reveal material. */
export type JudgeabilityRevealContext =
  | { readonly kind: "scheduled"; readonly trustedAtTime: string }
  | { readonly kind: "after-run"; readonly trustedRunNotClosed: true };

type JudgeabilityReason = "digest-mismatch" | "invalid-task" | "missing-evaluation-digest" | "invalid-provenance";
export interface JudgeabilityInvalidItem {
  readonly taskDigest: string;
  readonly reason: JudgeabilityReason;
}

function inspectTask(taskDigest: string, taskBytes: Uint8Array): JudgeabilityReason | undefined {
  if (sha256Hex(taskBytes) !== taskDigest) return "digest-mismatch";
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(taskBytes));
  } catch {
    return "invalid-task";
  }
  const task = TaskSpecificationSchema.safeParse(parsed);
  if (!task.success) return "invalid-task";
  try {
    const sealedBytes = serializeCanonicalJson(task.data as JsonValue);
    if (
      sealedBytes.length !== taskBytes.length
      || sealedBytes.some((byte, index) => byte !== taskBytes[index])
    ) return "invalid-task";
  } catch {
    return "invalid-task";
  }
  const evaluationDigest = task.data.evaluation?.digest?.sha256;
  if (!LowercaseSha256HexSchema.safeParse(evaluationDigest).success) return "missing-evaluation-digest";
  const payload = task.data.payload;
  const provenance = typeof payload === "object" && payload !== null && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)["provenance"]
    : undefined;
  if (typeof provenance !== "object" || provenance === null || Array.isArray(provenance)) return "invalid-provenance";
  const fields = provenance as Record<string, unknown>;
  const timestamp = fields["timestamp"];
  const source = fields["source"];
  const commitment = fields["sourceCommitment"];
  const sourceOk = typeof source === "string" && source.length > 0;
  const commitmentOk = typeof commitment === "string" && /^sha256:[a-f0-9]{64}$/.test(commitment);
  const timestampOk = isCalendarStrictRfc3339(timestamp);
  if (!timestampOk || sourceOk === commitmentOk) return "invalid-provenance";
  return undefined;
}

/**
 * Named check `benchmark-judgeability` (§6.1): every referenced Task must carry a sealed
 * `evaluation` descriptor. For a committed benchmark this is executable by third parties only at
 * reveal — before reveal (or when the caller simply holds no Task bytes), the check reports
 * `unevaluated` rather than passed or failed.
 */
export function checkJudgeability(
  rec: BenchmarkRecord,
  taskBytesResolver?: TaskBytesResolver,
  revealContext?: JudgeabilityRevealContext,
):
  | { ok: true }
  | { ok: false; invalid: JudgeabilityInvalidItem[]; unresolved: string[] }
  | { status: "unevaluated"; reason: "committed-not-revealed"; unresolved?: string[]; invalid?: readonly [] } {
  const invalid: JudgeabilityInvalidItem[] = [];
  const unresolved: string[] = [];
  for (const item of rec.items) {
    const digest = itemTaskDigest(item);
    const bytes = taskBytesResolver?.(digest);
    if (bytes === undefined) {
      unresolved.push(digest);
      continue;
    }
    const reason = inspectTask(digest, bytes);
    if (reason !== undefined) invalid.push({ taskDigest: digest, reason });
  }
  if (invalid.length > 0) return { ok: false, invalid, unresolved };
  if (unresolved.length > 0) {
    const scheduledNotBefore = rec.reveal.policy === "scheduled" ? rec.reveal.notBefore : undefined;
    const scheduledComparison = scheduledNotBefore !== undefined && revealContext?.kind === "scheduled"
      ? compareCalendarStrictRfc3339Instants(revealContext.trustedAtTime, scheduledNotBefore)
      : undefined;
    const isTrustedPreReveal = rec.reveal.policy === "scheduled"
      ? scheduledComparison !== undefined && scheduledComparison < 0
      : rec.reveal.policy === "after-run"
        && revealContext?.kind === "after-run"
        && revealContext.trustedRunNotClosed === true;
    if (isTrustedPreReveal) {
      return { status: "unevaluated", reason: "committed-not-revealed", unresolved, invalid: [] };
    }
    return { ok: false, invalid: [], unresolved };
  }
  return { ok: true };
}

export type VersionBump = "patch" | "minor" | "major";

export type BenchmarkPredecessorCheck =
  | { ok: true }
  | { ok: false; reason: "missing-supersedes" }
  | { ok: false; reason: "invalid-predecessor" }
  | { ok: false; reason: "digest-mismatch"; expected: `sha256:${string}`; actual: `sha256:${string}` };

/** Bind a successor's `supersedes` descriptor to exact canonical predecessor Benchmark bytes. */
export function checkBenchmarkPredecessor(
  next: BenchmarkRecord,
  predecessorBytes: Uint8Array,
): BenchmarkPredecessorCheck {
  const sha256 = next.supersedes?.digest.sha256;
  if (sha256 === undefined) return { ok: false, reason: "missing-supersedes" };

  try {
    parseBenchmark(predecessorBytes);
  } catch {
    return { ok: false, reason: "invalid-predecessor" };
  }

  const expected = `sha256:${sha256}` as const;
  const actual = documentDigest(predecessorBytes);
  return actual === expected
    ? { ok: true }
    : { ok: false, reason: "digest-mismatch", expected, actual };
}

interface SemVer {
  readonly major: string;
  readonly minor: string;
  readonly patch: string;
  readonly prerelease: readonly string[];
}

/** Complete SemVer 2.0.0 parser. Build metadata is deliberately excluded from precedence. */
function parseSemVer(value: string): SemVer | undefined {
  const match = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-((?:0|[0-9]*[A-Za-z-][0-9A-Za-z-]*|[1-9][0-9]*)(?:\.(?:0|[0-9]*[A-Za-z-][0-9A-Za-z-]*|[1-9][0-9]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(value);
  if (match === null) return undefined;
  return {
    major: match[1]!,
    minor: match[2]!,
    patch: match[3]!,
    prerelease: match[4] === undefined ? [] : match[4].split("."),
  };
}

function comparePrerelease(left: readonly string[], right: readonly string[]): number {
  if (left.length === 0 || right.length === 0) return left.length === right.length ? 0 : left.length === 0 ? 1 : -1;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const a = left[index];
    const b = right[index];
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    if (a === b) continue;
    const aNumeric = /^[0-9]+$/.test(a);
    const bNumeric = /^[0-9]+$/.test(b);
    if (aNumeric && bNumeric) return compareDecimal(a, b);
    if (aNumeric) return -1;
    if (bNumeric) return 1;
    return compareCodeUnitStrings(a, b);
  }
  return 0;
}

/** SemVer numeric identifiers are unbounded; compare decimal strings without Number loss. */
function compareDecimal(left: string, right: string): number {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  return compareCodeUnitStrings(left, right);
}

function compareSemVer(left: SemVer, right: SemVer): number {
  for (const key of ["major", "minor", "patch"] as const) {
    if (left[key] !== right[key]) return compareDecimal(left[key], right[key]);
  }
  return comparePrerelease(left.prerelease, right.prerelease);
}

export type BenchmarkTransitionCheck =
  | { ok: true; bump: VersionBump }
  | { ok: false; reason: "missing-supersedes" | "invalid-predecessor" | "digest-mismatch" | "invalid-version" | "version-not-increasing" | "wrong-bump" };

/**
 * Cross-record §6.2 transition check. It first binds exact predecessor bytes, then requires a
 * strictly increasing SemVer 2 precedence and a content-class-consistent version bump.
 */
export function checkBenchmarkTransition(
  next: BenchmarkRecord,
  predecessorBytes: Uint8Array,
): BenchmarkTransitionCheck {
  const predecessor = checkBenchmarkPredecessor(next, predecessorBytes);
  if (!predecessor.ok) return { ok: false, reason: predecessor.reason };
  let previous: BenchmarkRecord;
  try {
    previous = parseBenchmark(predecessorBytes);
  } catch {
    return { ok: false, reason: "invalid-predecessor" };
  }
  const from = parseSemVer(previous.version);
  const to = parseSemVer(next.version);
  if (from === undefined || to === undefined) return { ok: false, reason: "invalid-version" };
  if (compareSemVer(to, from) <= 0) return { ok: false, reason: "version-not-increasing" };
  const bump = classifyVersionBump(previous, next);
  const core = bump === "major" ? compareDecimal(to.major, from.major) > 0
    : bump === "minor" ? to.major === from.major && compareDecimal(to.minor, from.minor) > 0
      : to.major === from.major && to.minor === from.minor && to.patch === from.patch
        ? true
        : to.major === from.major && to.minor === from.minor && compareDecimal(to.patch, from.patch) > 0;
  return core ? { ok: true, bump } : { ok: false, reason: "wrong-bump" };
}

/**
 * §6.2 versioning classifier: patch only when the ordered item list is byte-identical; minor
 * only when new entries are appended after the exact existing ordered prefix; otherwise major.
 */
export function classifyVersionBump(prev: BenchmarkRecord, next: BenchmarkRecord): VersionBump {
  const prevItems = prev.items.map((item) => serializeCanonicalJson(item as JsonValue));
  const nextItems = next.items.map((item) => serializeCanonicalJson(item as JsonValue));
  const sharedPrefixIsIdentical = prevItems.every((bytes, index) => {
    const candidate = nextItems[index];
    return candidate !== undefined
      && bytes.length === candidate.length
      && bytes.every((byte, offset) => byte === candidate[offset]);
  });
  if (!sharedPrefixIsIdentical || nextItems.length < prevItems.length) return "major";
  return nextItems.length === prevItems.length ? "patch" : "minor";
}

/**
 * Named check `benchmark-comparability` (§6.2/§9/§12.1): scores are comparable only within one
 * Benchmark record digest, unless the method declares itself version-robust (pairs on shared
 * Task digests instead).
 */
export function checkComparability(
  subjects: readonly { benchmarkDigest: string }[],
  opts?: { versionRobust?: boolean },
): { ok: true } | { ok: false; digests: string[] } {
  const digests = [...new Set(subjects.map((subject) => subject.benchmarkDigest))];
  if (digests.length <= 1 || opts?.versionRobust) return { ok: true };
  return { ok: false, digests: digests.sort(compareCodeUnitStrings) };
}
