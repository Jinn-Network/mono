import { compareCodeUnitStrings } from "../order.js";
import { TaskSpecificationSchema } from "@jinn-network/task-execution-protocol";
import { serializeCanonicalJson } from "../canonical.js";
import { LowercaseSha256HexSchema } from "../descriptors.js";
import { documentDigest, sha256Hex } from "../hashing.js";
import type { JsonValue } from "../json.js";
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

type JudgeabilityReason = "digest-mismatch" | "invalid-task" | "missing-evaluation-digest";
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
    if (taskBytesResolver === undefined) {
      return { status: "unevaluated", reason: "committed-not-revealed" };
    }
    return { status: "unevaluated", reason: "committed-not-revealed", unresolved, invalid: [] };
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
