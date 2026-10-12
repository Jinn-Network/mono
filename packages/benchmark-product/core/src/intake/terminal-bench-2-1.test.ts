import { describe, expect, test } from "vitest";
import { parseBenchmark } from "@jinn-network/benchmarking-records";
import {
  EVALUATION_SPEC_FORMAT_URI,
  EVAL_SEMANTICS_VERSION,
  EXTERNAL_VERIFIER_FAMILY,
  EXTERNAL_VERIFIER_SEMANTICS_VERSION,
  evaluateVerdictRule,
  parseEvaluationSpec,
  parseTaskProfile,
  sealEvaluationSpec,
} from "@jinn-network/task-execution-profiles";
import { TaskSpecificationSchema } from "@jinn-network/task-execution-protocol";
import {
  OFFICIAL_SUITE_SLATE_EXTENSION,
  SUITE_COVERAGE as CHECKER_SUITE_COVERAGE,
  TERMINAL_BENCH_21_PINS,
  coverageFromSelectedNames as checkerCoverageFromSelectedNames,
  deriveClaimTerminalBench21Comparability,
  namedSliceTaskNames as checkerNamedSliceTaskNames,
} from "@colophon-claims/check";
import { BenchmarkProductError } from "../errors.js";
import {
  TERMINAL_BENCH_21_ITEM_PROFILE_URI,
  TERMINAL_BENCH_21_OFFICIAL_SLATE_EXTENSION,
  TERMINAL_BENCH_21_OFFICIAL_TASK_COUNT,
  buildTerminalBench21EvaluationSpec,
  buildTerminalBench21Tasks,
  officialTerminalBench21TaskNames,
  resolveTerminalBench21OfficialSlate,
  terminalBench21SlateDigest,
} from "./terminal-bench-2-1.js";
import {
  TERMINAL_BENCH_21_OFFICIAL_TASKS,
  TERMINAL_BENCH_21_UPSTREAM_COMMIT,
  TERMINAL_BENCH_21_UPSTREAM_REPOSITORY,
} from "./terminal-bench-2-1-slate.js";
import { TERMINAL_BENCH_2_1_DATASET_ID, TERMINAL_BENCH_2_1_DATASET_REF } from "../runtime/terminal-bench-2-1/manifest.js";
import { SUITE_COVERAGE } from "../runtime/suite-protocol/comparability.js";
import { coverageFromSelectedNames, namedSliceTaskNames } from "../runtime/suite-protocol/manifest.js";

const decoder = new TextDecoder("utf-8", { fatal: true });

function parseTask(bytes: Uint8Array): Record<string, unknown> {
  return TaskSpecificationSchema.parse(JSON.parse(decoder.decode(bytes))) as Record<string, unknown>;
}

describe("Terminal-Bench 2.1 official slate pin", () => {
  test("pins 89 official names at the hub.py commit and a stable digest", () => {
    const names = officialTerminalBench21TaskNames();
    expect(names).toHaveLength(89);
    expect(new Set(names).size).toBe(89);
    expect(TERMINAL_BENCH_21_OFFICIAL_TASK_COUNT).toBe(89);
    expect(names[0]).toBe("adaptive-rejection-sampler");
    expect(TERMINAL_BENCH_21_UPSTREAM_REPOSITORY).toBe("https://github.com/harbor-framework/terminal-bench-2-1");
    expect(TERMINAL_BENCH_21_UPSTREAM_COMMIT).toBe("a596ecb7db827a855b867be1f815ca6769d2a77c");
    expect(terminalBench21SlateDigest()).toBe(
      "sha256:0192806b9856af79819833c8cacd409a52f8ae56352936b0d392c3c463ec504d",
    );
  });

  test("named slices are the lexicographic first 1 / 10 / all official names", () => {
    const names = officialTerminalBench21TaskNames();
    expect(resolveTerminalBench21OfficialSlate({ coverage: "one_task" }).selectedTaskNames).toEqual([names[0]]);
    expect(resolveTerminalBench21OfficialSlate({ coverage: "ten_task" }).selectedTaskNames).toEqual(names.slice(0, 10));
    expect(resolveTerminalBench21OfficialSlate({ coverage: "full" }).selectedTaskNames).toEqual([...names]);
  });

  test("full coverage seals 89 honest tasks and the official slate extension, with no forecast payload", () => {
    const built = buildTerminalBench21Tasks({ coverage: "full" });
    expect(built.coverage).toBe("full");
    expect(built.tasks).toHaveLength(89);
    expect(built.selectedTaskNames).toEqual(officialTerminalBench21TaskNames());
    expect(built.slateDigest).toBe(terminalBench21SlateDigest());
    expect(built.upstreamCommit).toBe(TERMINAL_BENCH_21_UPSTREAM_COMMIT);

    const first = parseTask(built.tasks[0]!.bytes);
    expect(first.profile).toMatchObject({ uri: TERMINAL_BENCH_21_ITEM_PROFILE_URI });
    expect(first.payload).toEqual({
      datasetId: TERMINAL_BENCH_2_1_DATASET_ID,
      datasetRevision: TERMINAL_BENCH_2_1_DATASET_REF,
      upstreamCommit: TERMINAL_BENCH_21_UPSTREAM_COMMIT,
      taskName: "adaptive-rejection-sampler",
      packageRef: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
    });
    expect(JSON.stringify(first.payload)).not.toMatch(/forecast|consensusProbabilityYes/u);

    const benchmark = parseBenchmark(built.benchmark.bytes);
    expect(benchmark.items).toHaveLength(89);
    expect(benchmark.name).toBe("terminal-bench-2.1");
    const slate = benchmark[TERMINAL_BENCH_21_OFFICIAL_SLATE_EXTENSION] as {
      coverage: string;
      selectedTaskNames: string[];
      datasetTaskCount: number;
      slateDigest: string;
      upstreamCommit: string;
    };
    expect(slate).toMatchObject({
      protocol: "terminal-bench-2.1",
      datasetId: TERMINAL_BENCH_2_1_DATASET_ID,
      datasetRevision: TERMINAL_BENCH_2_1_DATASET_REF,
      upstreamCommit: TERMINAL_BENCH_21_UPSTREAM_COMMIT,
      slateDigest: terminalBench21SlateDigest(),
      coverage: "full",
      datasetTaskCount: 89,
    });
    expect(slate.selectedTaskNames).toEqual(officialTerminalBench21TaskNames());
  });

  test("one_task and custom subsets declare which official names they carry", () => {
    const one = buildTerminalBench21Tasks({ coverage: "one_task" });
    expect(one.tasks).toHaveLength(1);
    expect(one.coverage).toBe("one_task");
    expect(one.selectedTaskNames).toEqual(["adaptive-rejection-sampler"]);
    const oneSlate = parseBenchmark(one.benchmark.bytes)[TERMINAL_BENCH_21_OFFICIAL_SLATE_EXTENSION] as {
      coverage: string;
      selectedTaskNames: string[];
    };
    expect(oneSlate).toMatchObject({ coverage: "one_task", selectedTaskNames: ["adaptive-rejection-sampler"] });

    const custom = buildTerminalBench21Tasks({ taskNames: ["write-compressor", "qemu-startup"] });
    expect(custom.coverage).toBe("custom");
    expect(custom.selectedTaskNames).toEqual(["write-compressor", "qemu-startup"]);
    const customSlate = parseBenchmark(custom.benchmark.bytes)[TERMINAL_BENCH_21_OFFICIAL_SLATE_EXTENSION] as {
      coverage: string;
      selectedTaskNames: string[];
    };
    expect(customSlate.selectedTaskNames).toEqual(["write-compressor", "qemu-startup"]);
  });

  test("refuses a name that is not on the official slate", () => {
    try {
      buildTerminalBench21Tasks(["not-a-terminal-bench-2-1-task"]);
      throw new Error("expected refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(BenchmarkProductError);
      expect((error as BenchmarkProductError).code).toBe("validation");
      expect((error as BenchmarkProductError).message).toMatch(/not in the official slate/u);
    }
  });
});

/**
 * Each official Task binds one `external-verifier` EvaluationSpec (operator rulings of 2026-10-06,
 * decision 1; the family is proposal 0002, `proposals/0002-external-verifier-grader-family.md`).
 * The spec states what the task package states and nothing else: the package as the grader, its
 * own `tests/` files by digest, the image reference and the verifier timeout it declares.
 */
describe("the EvaluationSpec of an official Terminal-Bench 2.1 task", () => {
  test("the first task's spec is the ruled document, with the block's own semantics version", () => {
    // Spelled out, not rebuilt from the constants: this is the JSON the operator ruled, and the
    // one member the ruling left to the protocol proposal, `verifierSemanticsVersion`.
    expect(buildTerminalBench21EvaluationSpec("adaptive-rejection-sampler")).toEqual({
      protocol: "https://spec.jinn.network/profiles/evaluation-spec/v1",
      semanticsVersion: "4",
      family: "external-verifier",
      grader: {
        name: "terminal-bench/adaptive-rejection-sampler",
        digest: { sha256: "bcaa2399985cd57666018025846289ab25e193ae0dd8fb7f0ffab2410c24d4de" },
        accessClass: "public",
      },
      familyBlock: {
        harness: "harbor",
        verifierSemanticsVersion: "1",
        testMaterial: [
          {
            name: "tests/test.sh",
            digest: { sha256: "38b43560d173cc2b952c3a3e17b8a480216d84e33450515e047bcb0d806b1e0a" },
            accessClass: "public",
          },
          {
            name: "tests/test_outputs.py",
            digest: { sha256: "547dc6e107f034f41703722aeceb6d0236e3fb69116fc3f2fbaba11884de352f" },
            accessClass: "public",
          },
        ],
        declaredImage: "alexgshaw/adaptive-rejection-sampler:20251031",
        timeout: 900,
      },
      measurements: [{ name: "reward", type: "number", required: true }],
      verdictRule: {
        all: [
          {
            inconclusiveWhen: {
              not: {
                any: [
                  { threshold: { measurement: "reward", op: "eq", value: 0 } },
                  { threshold: { measurement: "reward", op: "eq", value: 1 } },
                ],
              },
            },
            class: "non-binary-reward",
          },
          { threshold: { measurement: "reward", op: "eq", value: 1 } },
        ],
      },
      unscorable: [{ name: "non-binary-reward", disposition: "recorded-inconclusive" }],
      evidenceConventions: { requiredRefs: ["trial-result.json"] },
    });
  });

  test("takes the family name and both semantics versions from the profiles package", () => {
    const spec = buildTerminalBench21EvaluationSpec("adaptive-rejection-sampler");
    expect(spec.protocol).toBe(EVALUATION_SPEC_FORMAT_URI);
    expect(spec.semanticsVersion).toBe(EVAL_SEMANTICS_VERSION);
    expect(spec.family).toBe(EXTERNAL_VERIFIER_FAMILY);
    expect((spec.familyBlock as { verifierSemanticsVersion: string }).verifierSemanticsVersion)
      .toBe(EXTERNAL_VERIFIER_SEMANTICS_VERSION);
  });

  test("every official task seals its own spec, and names its own package as the grader", () => {
    const built = buildTerminalBench21Tasks(officialTerminalBench21TaskNames());
    expect(new Set(built.tasks.map((task) => task.evaluationSpec.sha256)).size).toBe(89);
    for (const [index, task] of built.tasks.entries()) {
      const pinned = TERMINAL_BENCH_21_OFFICIAL_TASKS[index]!;
      // The stored bytes are the sealed spec, and they parse under the family's own rules.
      expect(sealEvaluationSpec(buildTerminalBench21EvaluationSpec(task.taskName)).digest, task.taskName)
        .toBe(`sha256:${task.evaluationSpec.sha256}`);
      const spec = parseEvaluationSpec(task.evaluationSpec.bytes);
      expect(spec.family, task.taskName).toBe("external-verifier");
      // The grader digest is the slate's package ref: the value a Harbor trial records for the
      // task, and the one the Harbor reader compares a trial against.
      expect(spec.grader, task.taskName).toEqual({
        name: `terminal-bench/${task.taskName}`,
        digest: { sha256: pinned.ref.slice("sha256:".length) },
        accessClass: "public",
      });
      expect(spec.measurements, task.taskName).toEqual([{ name: "reward", type: "number", required: true }]);
    }
  });

  test("a reward of 1 passes, 0 fails, and any other value is inconclusive, never a fail", () => {
    const { verdictRule } = buildTerminalBench21EvaluationSpec("adaptive-rejection-sampler");
    const verdictAt = (reward: number | string) => evaluateVerdictRule(verdictRule, { reward });
    expect(verdictAt(1)).toEqual({ verdict: "pass" });
    expect(verdictAt(0)).toEqual({ verdict: "fail" });
    // A decimal string is compared as an exact decimal, so a whole value written with a point
    // is the same reward.
    expect(verdictAt("1.0")).toEqual({ verdict: "pass" });
    for (const reward of [2, -1, "0.5"]) {
      expect(verdictAt(reward), String(reward)).toEqual({ verdict: "inconclusive", inconclusiveClass: "non-binary-reward" });
    }
  });

  test("each sealed Task binds its spec by digest, and the item profile names the family", () => {
    const built = buildTerminalBench21Tasks({ coverage: "ten_task" });
    for (const task of built.tasks) {
      expect(parseTask(task.bytes).evaluation, task.taskName).toEqual({ digest: { sha256: task.evaluationSpec.sha256 } });
    }
    expect(parseTaskProfile(built.profile.bytes).evaluationFamilies).toEqual(["external-verifier"]);
  });

  test("pins the digests the change that bound the specs moved", () => {
    // Literal on purpose. Binding a spec moves the item profile, every Task, and every Benchmark
    // built on them; a later change that moves any of these again must say so here, and must
    // regenerate the checker's pin table in the same change (the parity tests below).
    const built = buildTerminalBench21Tasks(officialTerminalBench21TaskNames());
    expect(built.profile.sha256).toBe("be35444162406ef9b2720be2e49c30570a2b1bd49af2bd88855c867a14e2574b");
    expect(built.tasks[0]!.evaluationSpec.sha256).toBe("f8a23fcec481a0bc9382b2e820a0dbbf574c324bd454d35f82ad0acc8eef1b59");
    expect(built.tasks[0]!.sha256).toBe("8c5e35f7096a5c2e3b7f4a8c4fc3d9a2c9134c6980ca5a01789bfddadc6af916");
    expect(built.benchmark.sha256).toBe("738b5bca6c8e455b101153c5628048d629069000fe09874a41028c82c9cc67a0");
    // The slate digest covers names and package refs only, so it does not move.
    expect(built.slateDigest).toBe("sha256:0192806b9856af79819833c8cacd409a52f8ae56352936b0d392c3c463ec504d");
  });
});

/**
 * The checker carries a generated copy of this slate (`check/src/profile/terminal-bench-2-1-pins.ts`,
 * written by `core/scripts/generate-terminal-bench-2-1-pins.mjs`), and a bundle that declares
 * `terminal-bench-2-1-comparability` is held to it. The builder stays here, so this is where the
 * two are compared: any change that moves a Task digest fails here until the table is regenerated
 * in the same change.
 */
describe("the checker's pinned copy of the official slate", () => {
  test("names the same dataset, upstream commit, and slate digest as the builder", () => {
    expect(OFFICIAL_SUITE_SLATE_EXTENSION).toBe(TERMINAL_BENCH_21_OFFICIAL_SLATE_EXTENSION);
    expect({ ...TERMINAL_BENCH_21_PINS, tasks: undefined }).toEqual({
      protocol: "terminal-bench-2.1",
      datasetId: TERMINAL_BENCH_2_1_DATASET_ID,
      datasetRevision: TERMINAL_BENCH_2_1_DATASET_REF,
      upstreamRepository: TERMINAL_BENCH_21_UPSTREAM_REPOSITORY,
      upstreamCommit: TERMINAL_BENCH_21_UPSTREAM_COMMIT,
      slateDigest: terminalBench21SlateDigest(),
      datasetTaskCount: TERMINAL_BENCH_21_OFFICIAL_TASK_COUNT,
      tasks: undefined,
    });
  });

  test("pins every official task, in slate order, at the Task digest the builder seals", () => {
    const built = buildTerminalBench21Tasks(officialTerminalBench21TaskNames());
    expect(TERMINAL_BENCH_21_PINS.tasks).toEqual(
      built.tasks.map((task) => ({ name: task.taskName, taskSha256: task.sha256 })),
    );
  });

  test("every Benchmark the builder seals projects through the checker's pin", () => {
    for (const input of [
      { coverage: "one_task" },
      { coverage: "ten_task" },
      { coverage: "full" },
      { taskNames: ["write-compressor", "qemu-startup"] },
    ] as const) {
      const built = buildTerminalBench21Tasks(input);
      expect(deriveClaimTerminalBench21Comparability({
        benchmarkRecord: parseBenchmark(built.benchmark.bytes),
        importSourceHarness: "harbor",
      })).toMatchObject({
        coverage: built.coverage,
        selectedTaskCount: built.selectedTaskNames.length,
        datasetTaskCount: 89,
        slateDigest: built.slateDigest,
      });
    }
  });

  test("the coverage helpers are the checker's, re-exported, and the coverage words agree", () => {
    expect(namedSliceTaskNames).toBe(checkerNamedSliceTaskNames);
    expect(coverageFromSelectedNames).toBe(checkerCoverageFromSelectedNames);
    expect(SUITE_COVERAGE).toEqual(CHECKER_SUITE_COVERAGE);
  });
});
