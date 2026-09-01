import {
  BENCHMARKING_PROTOCOL,
  checkJudgeability,
  documentDigest,
  parseBenchmark,
  sealBenchmark,
  type BenchmarkRecord,
} from "@jinn-network/benchmarking-records";
import {
  buildRepositoryWorkProfile,
  REPOSITORY_WORK_PROFILE_URI,
  sealTaskProfile,
  sweRebenchRowToTaskAndSpec,
  type SweRebenchRow,
} from "@jinn-network/task-execution-profiles";
import {
  sealTask,
  TASK_EXECUTION_PROTOCOL_URI,
} from "@jinn-network/task-execution-protocol";
import { toCalendarStrictRfc3339 } from "./rfc3339-from-source.js";

export type SweBenchRow = SweRebenchRow;

export type SealedTask = {
  bytes: Uint8Array;
  digest: `sha256:${string}`;
};

export type DefineBenchmarkOptions = {
  name: string;
  description: string;
  version: string;
  author?: string;
  reveal?: BenchmarkRecord["reveal"];
  license?: string;
  citation?: string;
  /** RFC 3339 timestamp sealed into each Task's mined provenance (required for judgeability). */
  provenanceTimestamp?: string;
  /**
   * Per-instance RFC 3339 provenance timestamps, keyed by `instance_id`, falling back to
   * `provenanceTimestamp` and then the batch default.
   *
   * A single timestamp across every row collapses `clean-subset@1`'s per-task contamination
   * predicate to one importer-chosen global boolean, with no per-instance ground truth an auditor
   * could check. Real per-row dates restore that signal.
   *
   * Keyed rather than positional so a reordered row list can never silently mis-associate a date
   * with an instance.
   */
  provenanceTimestamps?: Readonly<Record<string, string>>;
};

export type ImportedBenchmark = {
  tasks: SealedTask[];
  benchmark: {
    record: BenchmarkRecord;
    bytes: Uint8Array;
    digest: `sha256:${string}`;
  };
};

function stripSha256Prefix(digest: string): string {
  return digest.startsWith("sha256:") ? digest.slice("sha256:".length) : digest;
}

function sealRepositoryWorkTask(row: SweBenchRow, provenanceTimestamp: string): SealedTask {
  const mapped = sweRebenchRowToTaskAndSpec(row);
  const profileDigest = sealTaskProfile(buildRepositoryWorkProfile()).digest;
  const basePayload = mapped.taskPayload as Record<string, unknown>;
  const bytes = sealTask({
    protocol: TASK_EXECUTION_PROTOCOL_URI,
    profile: {
      uri: REPOSITORY_WORK_PROFILE_URI,
      digest: { sha256: stripSha256Prefix(profileDigest) },
    },
    instructions: row.problem_statement,
    payload: {
      ...basePayload,
      // Judgeability (§6.1) requires timestamp + exactly one of source|sourceCommitment.
      // The profiles mapper emits `{ kind: "mined" }` only; interop completes the cluster.
      provenance: {
        kind: "mined",
        // Repo-level, deliberately WITHOUT `@${row.base_commit}`. This string is the clustering
        // key (records/src/benchmark/checks.ts:65 uses it verbatim), so including the commit made
        // every SWE instance its own singleton cluster and silently defeated the clustered
        // bootstrap's between-repo correction. The base commit is not lost: it remains task
        // identity via `inputs[0].annotations.ref` and `payload.instance_id`.
        source: `https://github.com/${row.repo}`,
        timestamp: provenanceTimestamp,
      },
    },
    inputs: mapped.taskInputs,
    outputs: buildRepositoryWorkProfile().outputConventions.slots.map((slot) => ({
      name: slot.name,
      mediaType: slot.mediaType,
      required: slot.required,
    })),
    evaluation: { digest: { sha256: stripSha256Prefix(mapped.evaluationSpecDigest) } },
  });
  return { bytes, digest: documentDigest(bytes) };
}

/**
 * Hand-authored Benchmark over already-sealed Task digests (`bench define`).
 */
export function defineBenchmark(
  items: readonly SealedTask[],
  opts: DefineBenchmarkOptions,
): ImportedBenchmark["benchmark"] {
  const sealed = sealBenchmark({
    protocol: BENCHMARKING_PROTOCOL,
    name: opts.name,
    description: opts.description,
    ...(opts.author === undefined ? {} : { author: opts.author }),
    version: opts.version,
    items: items.map((task) => ({
      task: { digest: { sha256: stripSha256Prefix(task.digest) } },
    })),
    reveal: opts.reveal ?? { policy: "immediate" },
    ...(opts.license === undefined ? {} : { license: opts.license }),
    ...(opts.citation === undefined ? {} : { citation: opts.citation }),
  });
  return {
    record: parseBenchmark(sealed.bytes),
    bytes: sealed.bytes,
    digest: sealed.digest,
  };
}

/**
 * Converts a caller-supplied provenance timestamp, naming the option it came from.
 *
 * Left to `checkJudgeability`, a malformed date surfaces as `invalid-provenance` against a task
 * DIGEST, naming neither the option nor the bad value — a digest-hunt on a large import. Both the
 * batch `provenanceTimestamp` and each `provenanceTimestamps` entry route through here, so the
 * same input shape gets the same outcome whichever option carried it.
 */
function normalizeProvenanceTimestamp(value: string, option: string): string {
  try {
    return toCalendarStrictRfc3339(value);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`${option}: ${detail}`);
  }
}

/**
 * SWE-bench-shaped rows → sealed `repository-work/1.0` Tasks + a Benchmark over their digests
 * (§10.1 op 1). Content addressing kills ruler drift.
 */
export function importSweBench(
  rows: readonly SweBenchRow[],
  opts: DefineBenchmarkOptions,
): ImportedBenchmark {
  // The batch value takes the same edge validation as the per-instance map: same input shape,
  // same outcome. Omitting the option keeps the literal default untouched, so the no-override
  // path stays byte-deterministic.
  const provenanceTimestamp = opts.provenanceTimestamp === undefined
    ? "2026-07-29T00:00:00Z"
    : normalizeProvenanceTimestamp(opts.provenanceTimestamp, "provenanceTimestamp");
  const overrides = opts.provenanceTimestamps;
  const tasks = rows.map((row) => {
    // `hasOwnProperty` rather than a plain index: a row whose instance_id collides with an
    // Object.prototype member (`toString`) would otherwise resolve to a function, and `??` would
    // not fall back.
    const hasOverride = overrides !== undefined
      && Object.prototype.hasOwnProperty.call(overrides, row.instance_id);
    if (!hasOverride) return sealRepositoryWorkTask(row, provenanceTimestamp);
    // Normalize HERE, where the offending instance is still in hand, and OUTSIDE the seal.
    // Wrapping the seal too would prefix any row-shape failure (bad parser.digest, locator-less
    // image, negative timeout) with `provenanceTimestamps[...]`, but only for rows carrying an
    // override — pointing an operator at their timestamp file to debug a malformed row. That is
    // the same misdirection this validation exists to remove, inverted.
    const resolved = normalizeProvenanceTimestamp(
      overrides[row.instance_id] as string,
      `provenanceTimestamps["${row.instance_id}"]`,
    );
    return sealRepositoryWorkTask(row, resolved);
  });
  const benchmark = defineBenchmark(tasks, opts);
  const judgeability = checkJudgeability(
    benchmark.record,
    (digest) => tasks.find((task) => stripSha256Prefix(task.digest) === digest)?.bytes,
  );
  if (!("ok" in judgeability) || judgeability.ok !== true) {
    throw new Error(`imported SWE-bench Benchmark failed checkJudgeability: ${JSON.stringify(judgeability)}`);
  }
  return { tasks, benchmark };
}
