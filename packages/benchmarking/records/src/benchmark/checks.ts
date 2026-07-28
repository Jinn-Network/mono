import { compareCodeUnitStrings } from "../order.js";
import { itemTaskDigest, type BenchmarkRecord } from "./schema.js";

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

function hasEvaluationDescriptor(taskBytes: Uint8Array): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(taskBytes));
  } catch {
    return false;
  }
  return (
    typeof parsed === "object"
    && parsed !== null
    && "evaluation" in parsed
    && (parsed as { evaluation?: unknown }).evaluation !== undefined
  );
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
  | { ok: false; unevaluated: string[] }
  | { status: "unevaluated"; reason: "committed-not-revealed" } {
  const missingEvaluation: string[] = [];
  let anyBytesMissing = false;
  for (const item of rec.items) {
    const digest = itemTaskDigest(item);
    const bytes = taskBytesResolver?.(digest);
    if (bytes === undefined) {
      anyBytesMissing = true;
      continue;
    }
    if (!hasEvaluationDescriptor(bytes)) missingEvaluation.push(digest);
  }
  if (anyBytesMissing) return { status: "unevaluated", reason: "committed-not-revealed" };
  return missingEvaluation.length > 0 ? { ok: false, unevaluated: missingEvaluation } : { ok: true };
}

export type VersionBump = "patch" | "minor" | "major";

/**
 * §6.2 versioning classifier: patch (metadata-only, item list byte-identical by digest set),
 * minor (items added only), major (items removed or changed — a changed item's Task digest
 * differs, which is indistinguishable here from removal-plus-addition).
 */
export function classifyVersionBump(prev: BenchmarkRecord, next: BenchmarkRecord): VersionBump {
  const prevDigests = prev.items.map(itemTaskDigest);
  const nextDigests = next.items.map(itemTaskDigest);
  const nextSet = new Set(nextDigests);
  const prevSet = new Set(prevDigests);
  if (prevDigests.some((digest) => !nextSet.has(digest))) return "major";
  if (nextDigests.some((digest) => !prevSet.has(digest))) return "minor";
  return "patch";
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
