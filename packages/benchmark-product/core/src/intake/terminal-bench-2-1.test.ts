import { describe, expect, test } from "vitest";
import { parseBenchmark } from "@jinn-network/benchmarking-records";
import { TaskSpecificationSchema } from "@jinn-network/task-execution-protocol";
import { BenchmarkProductError } from "../errors.js";
import {
  TERMINAL_BENCH_21_ITEM_PROFILE_URI,
  TERMINAL_BENCH_21_OFFICIAL_SLATE_EXTENSION,
  TERMINAL_BENCH_21_OFFICIAL_TASK_COUNT,
  buildTerminalBench21Tasks,
  officialTerminalBench21TaskNames,
  resolveTerminalBench21OfficialSlate,
  terminalBench21SlateDigest,
} from "./terminal-bench-2-1.js";
import {
  TERMINAL_BENCH_21_UPSTREAM_COMMIT,
  TERMINAL_BENCH_21_UPSTREAM_REPOSITORY,
} from "./terminal-bench-2-1-slate.js";
import { TERMINAL_BENCH_2_1_DATASET_ID, TERMINAL_BENCH_2_1_DATASET_REF } from "../runtime/terminal-bench-2-1/manifest.js";

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
