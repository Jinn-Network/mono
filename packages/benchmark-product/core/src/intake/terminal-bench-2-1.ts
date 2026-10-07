/**
 * Official Terminal-Bench 2.1 knowing-half slate (issue #3990, DR-2026-09-04 decision 5).
 *
 * The Benchmark a `method terminal-bench-2.1` bind produces is the official task list, read at a
 * named upstream commit, with each task package named by the content hash Harbor gives it and the
 * whole pinned by a digest. It is not a prediction-market fixture with a relabelled placeholder
 * payload. The commit names where the list was read; a package's bytes are identified by its
 * package ref (`terminal-bench-2-1-slate.ts`). Harbor host selection stays off this path.
 */
import { BENCHMARKING_PROTOCOL, parseBenchmark, sealBenchmark } from "@jinn-network/benchmarking-records";
import { TASK_EXECUTION_PROTOCOL_URI, sealTask } from "@jinn-network/task-execution-protocol";
import {
  EVALUATION_SPEC_FORMAT_URI,
  EVAL_SEMANTICS_VERSION,
  EXTERNAL_VERIFIER_FAMILY,
  EXTERNAL_VERIFIER_SEMANTICS_VERSION,
  TASK_PROFILE_FORMAT_URI,
  sealEvaluationSpec,
  sealTaskProfile,
  type EvaluationSpec,
  type TaskProfileDocument,
} from "@jinn-network/task-execution-profiles";
import { canonicalJsonBytes } from "@jinn-network/trust-core";
import { refuse } from "../errors.js";
import {
  coverageFromSelectedNames,
  namedSliceTaskNames,
  type SuiteCoverage,
} from "../runtime/suite-protocol/manifest.js";
import {
  TERMINAL_BENCH_2_1_DATASET_ID,
  TERMINAL_BENCH_2_1_DATASET_REF,
} from "../runtime/terminal-bench-2-1/manifest.js";
import { sha256Hex } from "../workspace/sealed-store.js";
import {
  TERMINAL_BENCH_21_OFFICIAL_TASKS,
  TERMINAL_BENCH_21_UPSTREAM_COMMIT,
  TERMINAL_BENCH_21_UPSTREAM_REPOSITORY,
} from "./terminal-bench-2-1-slate.js";
import { TERMINAL_BENCH_21_VERIFIER_PINS } from "./terminal-bench-2-1-verifier-pins.js";

export const TERMINAL_BENCH_21_ITEM_PROFILE_URI =
  "https://product.jinn.network/profiles/terminal-bench-2-1-item/1" as const;
export const TERMINAL_BENCH_21_OFFICIAL_SLATE_EXTENSION =
  "https://product.jinn.network/extensions/official-suite-slate/v1" as const;

export const TERMINAL_BENCH_21_OFFICIAL_TASK_COUNT = TERMINAL_BENCH_21_OFFICIAL_TASKS.length;

export function officialTerminalBench21TaskNames(): readonly string[] {
  return TERMINAL_BENCH_21_OFFICIAL_TASKS.map((task) => task.name);
}

export function terminalBench21SlatePinBytes(): Uint8Array {
  return canonicalJsonBytes({
    datasetId: TERMINAL_BENCH_2_1_DATASET_ID,
    datasetRevision: TERMINAL_BENCH_2_1_DATASET_REF,
    upstreamRepository: TERMINAL_BENCH_21_UPSTREAM_REPOSITORY,
    upstreamCommit: TERMINAL_BENCH_21_UPSTREAM_COMMIT,
    tasks: TERMINAL_BENCH_21_OFFICIAL_TASKS.map((task) => ({
      org: task.org,
      name: task.name,
      ref: task.ref,
    })),
  } as never);
}

export function terminalBench21SlateDigest(): `sha256:${string}` {
  return `sha256:${sha256Hex(terminalBench21SlatePinBytes())}`;
}

export function buildTerminalBench21ItemProfile(): TaskProfileDocument {
  return {
    protocol: TASK_PROFILE_FORMAT_URI,
    profile: TERMINAL_BENCH_21_ITEM_PROFILE_URI,
    description:
      "One official Terminal-Bench 2.1 dataset item identity. Payload names the leaderboard dataset pin, upstream commit, task name, and Harbor package ref — not a forecast and not a cloned fixture.",
    payloadSchema: {
      type: "object",
      additionalProperties: false,
      required: ["datasetId", "datasetRevision", "upstreamCommit", "taskName", "packageRef"],
      properties: {
        datasetId: { const: TERMINAL_BENCH_2_1_DATASET_ID },
        datasetRevision: { type: "string", pattern: "^sha256:[a-f0-9]{64}$" },
        upstreamCommit: { type: "string", pattern: "^[a-f0-9]{40}$" },
        taskName: { type: "string", minLength: 1, pattern: "^[^/]+$" },
        packageRef: { type: "string", pattern: "^sha256:[a-f0-9]{64}$" },
      },
    },
    inputConventions: { slots: [] },
    outputConventions: {
      slots: [{ name: "result", required: false, mediaType: "application/json" }],
    },
    evaluationFamilies: [EXTERNAL_VERIFIER_FAMILY],
    requirementKeys: [],
  };
}

export interface TerminalBench21SlateSelection {
  readonly coverage: SuiteCoverage;
  readonly selectedTaskNames: readonly string[];
}

type TerminalBench21SlateResolverInput = {
  readonly coverage?: Exclude<SuiteCoverage, "custom">;
  readonly taskNames?: readonly string[];
};

type TerminalBench21TaskNamesOrInput = readonly string[] | TerminalBench21SlateResolverInput;

function isTerminalBench21TaskNameList(
  value: TerminalBench21TaskNamesOrInput,
): value is readonly string[] {
  return Array.isArray(value);
}

export function resolveTerminalBench21OfficialSlate(
  input: TerminalBench21SlateResolverInput,
): TerminalBench21SlateSelection {
  const officialNames = officialTerminalBench21TaskNames();
  if (input.taskNames !== undefined) {
    if (input.taskNames.length === 0) {
      refuse("validation", "terminal-bench-2.1.taskNames", "Terminal-Bench 2.1 custom task list must not be empty");
    }
    const seen = new Set<string>();
    for (const name of input.taskNames) {
      if (seen.has(name)) {
        refuse("validation", "terminal-bench-2.1.taskNames", `Terminal-Bench 2.1 task ${name} is listed more than once`);
      }
      seen.add(name);
      if (!officialNames.includes(name)) {
        refuse(
          "validation",
          "terminal-bench-2.1.taskNames",
          `Terminal-Bench 2.1 task ${name} is not in the official slate at ${TERMINAL_BENCH_21_UPSTREAM_COMMIT}`,
        );
      }
    }
    const coverage = coverageFromSelectedNames(officialNames, input.taskNames);
    if (input.coverage !== undefined && coverage !== input.coverage) {
      refuse(
        "validation",
        "terminal-bench-2.1.coverage",
        "Terminal-Bench 2.1 task list does not match the named coverage slice",
      );
    }
    return { coverage, selectedTaskNames: [...input.taskNames] };
  }
  if (input.coverage === undefined) {
    refuse("validation", "terminal-bench-2.1.coverage", "Terminal-Bench 2.1 slate requires coverage or an explicit task list");
  }
  return { coverage: input.coverage, selectedTaskNames: namedSliceTaskNames(officialNames, input.coverage) };
}

export interface BuiltTerminalBench21Task {
  readonly taskName: string;
  readonly bytes: Uint8Array;
  readonly sha256: string;
  /** The sealed EvaluationSpec the Task binds by digest. A bind stores these bytes beside the
   * Task: `quote`, `lock` and every reader refuse a Task whose spec they cannot read. */
  readonly evaluationSpec: { readonly bytes: Uint8Array; readonly sha256: string };
}

export interface BuiltTerminalBench21Slate {
  readonly coverage: SuiteCoverage;
  readonly selectedTaskNames: readonly string[];
  readonly slateDigest: `sha256:${string}`;
  readonly upstreamCommit: typeof TERMINAL_BENCH_21_UPSTREAM_COMMIT;
  readonly profile: { readonly bytes: Uint8Array; readonly sha256: string };
  readonly tasks: readonly BuiltTerminalBench21Task[];
  readonly benchmark: { readonly bytes: Uint8Array; readonly sha256: string };
}

function officialTask(taskName: string): (typeof TERMINAL_BENCH_21_OFFICIAL_TASKS)[number] {
  const pinned = TERMINAL_BENCH_21_OFFICIAL_TASKS.find((task) => task.name === taskName);
  if (pinned === undefined) {
    refuse(
      "validation",
      "terminal-bench-2.1.taskNames",
      `Terminal-Bench 2.1 task ${taskName} is not in the official slate at ${TERMINAL_BENCH_21_UPSTREAM_COMMIT}`,
    );
  }
  return pinned;
}

function packageRefFor(taskName: string): `sha256:${string}` {
  return officialTask(taskName).ref;
}

/** The measurement every official task declares: the `reward` key of Harbor's raw reward map. */
export const TERMINAL_BENCH_21_REWARD_MEASUREMENT = "reward" as const;
/** The unscorable class of a reward that is neither 0 nor 1. */
export const TERMINAL_BENCH_21_NON_BINARY_REWARD_CLASS = "non-binary-reward" as const;
/** The evidence name under which an imported trial carries Harbor's own `result.json`. */
export const TERMINAL_BENCH_21_TRIAL_RESULT_REF = "trial-result.json" as const;

/**
 * The EvaluationSpec of one official task (operator rulings of 2026-10-06, decision 1): an
 * `external-verifier` specification, the grader family of proposal 0002
 * (`proposals/0002-external-verifier-grader-family.md`).
 *
 * It says only what the task package states. The grader is the package, named by the content
 * hash Harbor assigns it, which is the slate's package ref. The block carries the package's own
 * `tests/` files by digest, the image reference it declares, and the verifier timeout it declares
 * (`terminal-bench-2-1-verifier-pins.ts`, read from the 89 packages). It names no image digest, no
 * platform and no parser, because no package states one.
 *
 * The one measurement is Harbor's `reward`. The rule passes at 1 and fails at 0, the only two
 * values any of the 89 verifier scripts writes, and answers inconclusive for any other value
 * instead of counting it as a fail.
 */
export function buildTerminalBench21EvaluationSpec(taskName: string): EvaluationSpec {
  const task = officialTask(taskName);
  const pin = TERMINAL_BENCH_21_VERIFIER_PINS.find((entry) => entry.name === taskName);
  if (pin === undefined) {
    refuse("record-integrity", "terminal-bench-2.1.verifierPins", `Terminal-Bench 2.1 task ${taskName} has no verifier pin`);
  }
  const rewardIs = (value: 0 | 1) => ({
    threshold: { measurement: TERMINAL_BENCH_21_REWARD_MEASUREMENT, op: "eq" as const, value },
  });
  return {
    protocol: EVALUATION_SPEC_FORMAT_URI,
    semanticsVersion: EVAL_SEMANTICS_VERSION,
    family: EXTERNAL_VERIFIER_FAMILY,
    grader: {
      name: `${task.org}/${task.name}`,
      digest: { sha256: task.ref.slice("sha256:".length) },
      accessClass: "public",
    },
    familyBlock: {
      harness: "harbor",
      verifierSemanticsVersion: EXTERNAL_VERIFIER_SEMANTICS_VERSION,
      testMaterial: pin.testMaterial.map((file) => ({
        name: file.name,
        digest: { sha256: file.sha256 },
        accessClass: "public",
      })),
      declaredImage: pin.declaredImage,
      timeout: pin.timeoutSec,
    },
    measurements: [{ name: TERMINAL_BENCH_21_REWARD_MEASUREMENT, type: "number", required: true }],
    verdictRule: {
      all: [
        {
          inconclusiveWhen: { not: { any: [rewardIs(0), rewardIs(1)] } },
          class: TERMINAL_BENCH_21_NON_BINARY_REWARD_CLASS,
        },
        rewardIs(1),
      ],
    },
    unscorable: [{ name: TERMINAL_BENCH_21_NON_BINARY_REWARD_CLASS, disposition: "recorded-inconclusive" }],
    evidenceConventions: { requiredRefs: [TERMINAL_BENCH_21_TRIAL_RESULT_REF] },
  };
}

function sealOfficialItem(
  taskName: string,
  profileSha256: string,
): BuiltTerminalBench21Task {
  const sealedSpec = sealEvaluationSpec(buildTerminalBench21EvaluationSpec(taskName));
  const evaluationSpecSha256 = sealedSpec.digest.slice("sha256:".length);
  const bytes = sealTask({
    protocol: TASK_EXECUTION_PROTOCOL_URI,
    profile: {
      uri: TERMINAL_BENCH_21_ITEM_PROFILE_URI,
      digest: { sha256: profileSha256 },
    },
    instructions: `Terminal-Bench 2.1 task ${taskName} at dataset ${TERMINAL_BENCH_2_1_DATASET_ID}@${TERMINAL_BENCH_2_1_DATASET_REF}.`,
    payload: {
      datasetId: TERMINAL_BENCH_2_1_DATASET_ID,
      datasetRevision: TERMINAL_BENCH_2_1_DATASET_REF,
      upstreamCommit: TERMINAL_BENCH_21_UPSTREAM_COMMIT,
      taskName,
      packageRef: packageRefFor(taskName),
    },
    outputs: [{ name: "result", mediaType: "application/json", required: false }],
    evaluation: { digest: { sha256: evaluationSpecSha256 } },
    author: "urn:jinn:benchmark-product:terminal-bench-2.1-official-slate",
  });
  return {
    taskName,
    bytes,
    sha256: sha256Hex(bytes),
    evaluationSpec: { bytes: sealedSpec.bytes, sha256: evaluationSpecSha256 },
  };
}

/**
 * Seals the official Terminal-Bench 2.1 slate, or a declared subset of it.
 *
 * `taskNames` must be official names. Callers that still drive Harbor select with a test-double
 * inventory must not use this builder for unofficial names — bind is the product path.
 */
export function buildTerminalBench21Tasks(
  taskNamesOrInput: TerminalBench21TaskNamesOrInput,
): BuiltTerminalBench21Slate {
  const resolved = isTerminalBench21TaskNameList(taskNamesOrInput)
    ? resolveTerminalBench21OfficialSlate({ taskNames: taskNamesOrInput })
    : resolveTerminalBench21OfficialSlate(taskNamesOrInput);
  const sealedProfile = sealTaskProfile(buildTerminalBench21ItemProfile());
  const profileSha256 = sealedProfile.digest.slice("sha256:".length);
  const tasks = resolved.selectedTaskNames.map((taskName) => sealOfficialItem(taskName, profileSha256));
  const slateDigest = terminalBench21SlateDigest();
  const sealed = sealBenchmark({
    protocol: BENCHMARKING_PROTOCOL,
    name: "terminal-bench-2.1",
    // The commit names where the task list was read and nothing more. It does not identify a
    // package's bytes: one published package differs from the repository at that commit
    // (`terminal-bench-2-1-slate.ts`), so this text never says the tasks are "at" the commit.
    description:
      `${
        resolved.coverage === "full"
          ? "Official Terminal-Bench 2.1 task list, read at the sealed upstream commit."
          : `Official Terminal-Bench 2.1 ${resolved.coverage} slice of the task list read at the sealed upstream commit.`
      } Each task package is identified by its sealed Harbor package ref, not by that commit.`,
    version: "2.1.0",
    items: tasks.map((task) => ({ task: { digest: { sha256: task.sha256 } } })),
    reveal: { policy: "immediate" },
    [TERMINAL_BENCH_21_OFFICIAL_SLATE_EXTENSION]: {
      protocol: "terminal-bench-2.1",
      datasetId: TERMINAL_BENCH_2_1_DATASET_ID,
      datasetRevision: TERMINAL_BENCH_2_1_DATASET_REF,
      upstreamRepository: TERMINAL_BENCH_21_UPSTREAM_REPOSITORY,
      upstreamCommit: TERMINAL_BENCH_21_UPSTREAM_COMMIT,
      slateDigest,
      coverage: resolved.coverage,
      selectedTaskNames: [...resolved.selectedTaskNames],
      datasetTaskCount: TERMINAL_BENCH_21_OFFICIAL_TASK_COUNT,
    },
  });
  const benchmarkSha256 = sealed.digest.slice("sha256:".length);
  parseBenchmark(sealed.bytes);
  return {
    coverage: resolved.coverage,
    selectedTaskNames: resolved.selectedTaskNames,
    slateDigest,
    upstreamCommit: TERMINAL_BENCH_21_UPSTREAM_COMMIT,
    profile: { bytes: sealedProfile.bytes, sha256: profileSha256 },
    tasks,
    benchmark: { bytes: sealed.bytes, sha256: benchmarkSha256 },
  };
}
