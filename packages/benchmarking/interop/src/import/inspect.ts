import {
  BENCHMARKING_PROTOCOL,
  checkJudgeability,
  documentDigest,
  parseBenchmark,
  sealBenchmark,
} from "@jinn-network/benchmarking-records";
import {
  EVAL_SEMANTICS_VERSION,
  EVALUATION_SPEC_FORMAT_URI,
  sealEvaluationSpec,
} from "@jinn-network/task-execution-profiles";
import {
  sealTask,
  TASK_EXECUTION_PROTOCOL_URI,
} from "@jinn-network/task-execution-protocol";
import type { DefineBenchmarkOptions, ImportedBenchmark, SealedTask } from "./swebench.js";

export type InspectEvalTask = {
  /** Inspect task id / registry name. */
  id: string;
  /** Inspect package / revision pin. */
  version: string;
  /** Human-readable instructions sealed into the Task. */
  instructions: string;
  /**
   * When true, the task is dataset + declarative scoring and can be sealed as
   * data-expressible content. When false, pin Inspect task/version/digest as an input.
   */
  dataExpressible: boolean;
  /** Dataset digest for data-expressible tasks. */
  datasetDigest?: `sha256:${string}`;
  /** Declarative scorer digest for data-expressible tasks. */
  scorerDigest?: `sha256:${string}`;
  /** Provenance timestamp for judgeability. */
  provenanceTimestamp?: string;
};

export type InspectImportOptions = DefineBenchmarkOptions & {
  /**
   * Exact honest Task profile descriptor (URI + digest) for this Inspect import.
   * Sealed unchanged — no package-default profile inventing.
   */
  profile: {
    uri: string;
    digest: `sha256:${string}`;
  };
  /** Output slots matching the pinned profile's conventions. */
  outputs: readonly {
    name: string;
    mediaType: string;
    required: boolean;
  }[];
};

function stripSha256Prefix(digest: string): string {
  return digest.startsWith("sha256:") ? digest.slice("sha256:".length) : digest;
}

function assertProfilePin(profile: InspectImportOptions["profile"]): {
  uri: string;
  digest: { sha256: string };
} {
  if (typeof profile?.uri !== "string" || profile.uri.length === 0) {
    throw new Error("importInspectEvals: options.profile.uri is required (no default profile)");
  }
  if (typeof profile.digest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(profile.digest)) {
    throw new Error(
      "importInspectEvals: options.profile.digest must be sha256:<64 hex> (no default profile)",
    );
  }
  return {
    uri: profile.uri,
    digest: { sha256: stripSha256Prefix(profile.digest) },
  };
}

function sealInspectTask(
  task: InspectEvalTask,
  opts: InspectImportOptions,
): SealedTask {
  const profile = assertProfilePin(opts.profile);
  if (!Array.isArray(opts.outputs)) {
    throw new Error("importInspectEvals: options.outputs is required");
  }
  const timestamp = task.provenanceTimestamp ?? opts.provenanceTimestamp ?? "2026-07-29T00:00:00Z";
  const pinDigest = documentDigest(
    new TextEncoder().encode(`inspect:${task.id}@${task.version}`),
  );

  if (task.dataExpressible && (task.datasetDigest === undefined || task.scorerDigest === undefined)) {
    throw new Error("data-expressible Inspect tasks require datasetDigest + scorerDigest");
  }

  const contentDigest = task.dataExpressible ? task.datasetDigest! : pinDigest;
  const scorerDigest = task.dataExpressible ? task.scorerDigest! : pinDigest;

  const evaluationSpec = sealEvaluationSpec({
    protocol: EVALUATION_SPEC_FORMAT_URI,
    semanticsVersion: EVAL_SEMANTICS_VERSION,
    family: "deterministic-process",
    grader: {
      name: `inspect/${task.id}`,
      digest: { sha256: stripSha256Prefix(scorerDigest) },
      accessClass: "public",
    },
    familyBlock: {
      image: {
        uri: `inspect://task/${task.id}@${task.version}`,
        digest: { sha256: stripSha256Prefix(contentDigest) },
      },
      platform: "linux/amd64",
      workspace: {},
      testMaterial: task.dataExpressible
        ? [{
          uri: `inspect://dataset/${task.id}@${task.version}`,
          digest: { sha256: stripSha256Prefix(task.datasetDigest!) },
          accessClass: "public",
        }]
        : [],
      parser: {
        id: `inspect.scorer/${task.id}`,
        version: task.version,
        digest: scorerDigest,
      },
      transitions: { failToPass: [], passToPass: [] },
      timeout: 600,
    },
    measurements: [{ name: "passed", type: "boolean", required: true }],
    verdictRule: { threshold: { measurement: "passed", op: "eq", value: true } },
    unscorable: [{ name: "environment-setup-failure", disposition: "retryable-infrastructure" }],
    evidenceConventions: { requiredRefs: [] },
  });

  const inputs = task.dataExpressible
    ? [
      {
        name: "inspect-dataset",
        digest: { sha256: stripSha256Prefix(task.datasetDigest!) },
      },
      {
        name: "inspect-scorer",
        digest: { sha256: stripSha256Prefix(task.scorerDigest!) },
      },
    ]
    : [
      {
        name: "inspect-task-pin",
        digest: { sha256: stripSha256Prefix(pinDigest) },
      },
    ];

  const bytes = sealTask({
    protocol: TASK_EXECUTION_PROTOCOL_URI,
    profile,
    instructions: task.instructions,
    payload: {
      language: "python",
      provenance: {
        kind: "synthetic",
        source: `inspect://${task.id}@${task.version}`,
        timestamp,
      },
      inspect: {
        id: task.id,
        version: task.version,
        dataExpressible: task.dataExpressible,
        ...(task.dataExpressible
          ? { datasetDigest: task.datasetDigest, scorerDigest: task.scorerDigest }
          : {
            pin: `Inspect task ${task.id} at version/digest ${task.version}/${pinDigest}`,
          }),
      },
    },
    inputs,
    outputs: opts.outputs.map((slot) => ({
      name: slot.name,
      mediaType: slot.mediaType,
      required: slot.required,
    })),
    evaluation: { digest: { sha256: stripSha256Prefix(evaluationSpec.digest) } },
  });
  return { bytes, digest: documentDigest(bytes) };
}

/**
 * Inspect Evals → sealed Tasks + Benchmark (§10.2 seam 1).
 * Caller supplies the exact Task profile pin; integrity admission is Matrix-side later.
 */
export function importInspectEvals(
  tasks: readonly InspectEvalTask[],
  opts: InspectImportOptions,
): ImportedBenchmark {
  assertProfilePin(opts.profile);
  const sealedTasks = tasks.map((task) => sealInspectTask(task, opts));
  const sealedBench = sealBenchmark({
    protocol: BENCHMARKING_PROTOCOL,
    name: opts.name,
    description: opts.description,
    ...(opts.author === undefined ? {} : { author: opts.author }),
    version: opts.version,
    items: sealedTasks.map((task) => ({
      task: { digest: { sha256: stripSha256Prefix(task.digest) } },
    })),
    reveal: opts.reveal ?? { policy: "immediate" },
    ...(opts.license === undefined ? {} : { license: opts.license }),
    ...(opts.citation === undefined ? {} : { citation: opts.citation }),
  });
  const benchmark = {
    record: parseBenchmark(sealedBench.bytes),
    bytes: sealedBench.bytes,
    digest: sealedBench.digest,
  };
  const judgeability = checkJudgeability(
    benchmark.record,
    (digest) => sealedTasks.find((task) => stripSha256Prefix(task.digest) === digest)?.bytes,
  );
  if (!("ok" in judgeability) || judgeability.ok !== true) {
    throw new Error(
      `imported Inspect Benchmark failed checkJudgeability: ${JSON.stringify(judgeability)}`,
    );
  }
  return { tasks: sealedTasks, benchmark };
}
