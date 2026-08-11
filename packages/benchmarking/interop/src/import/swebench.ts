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
 * SWE-bench-shaped rows → sealed `repository-work/1.0` Tasks + a Benchmark over their digests
 * (§10.1 op 1). Content addressing kills ruler drift.
 */
export function importSweBench(
  rows: readonly SweBenchRow[],
  opts: DefineBenchmarkOptions,
): ImportedBenchmark {
  const provenanceTimestamp = opts.provenanceTimestamp ?? "2026-07-29T00:00:00Z";
  const tasks = rows.map((row) => sealRepositoryWorkTask(row, provenanceTimestamp));
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
