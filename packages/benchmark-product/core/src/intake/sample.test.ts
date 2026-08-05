/**
 * Tests for `buildSampleBenchmark` (see ./sample.ts). Two concerns:
 *
 * - Determinism (spec BP-11 acceptance criteria): every digest the builder
 *   produces must be byte-reproducible across independent calls, since the
 *   product treats the bundled sample as a fixed, citable artifact.
 * - The launcher shape contract: each sample task must actually drive the
 *   platform's `prediction-v1-baseline` launcher end to end, proving the
 *   sample is a real, executable prediction-forecast task set and not just a
 *   document that happens to validate.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { predictionV1BaselineLauncher } from "@jinn-network/task-execution-launchers";
import { afterEach, describe, expect, test } from "vitest";
import { sha256Hex } from "../workspace/sealed-store.js";
import { buildSampleBenchmark } from "./sample.js";

const HEX64 = /^[a-f0-9]{64}$/;

describe("buildSampleBenchmark — determinism", () => {
  test("two independent builds produce byte-identical digests for every artifact", async () => {
    const first = await buildSampleBenchmark();
    const second = await buildSampleBenchmark();

    expect(second.benchmark.sha256).toBe(first.benchmark.sha256);
    expect(second.evaluationSpec.sha256).toBe(first.evaluationSpec.sha256);
    expect(second.tasks.map((task) => task.sha256)).toEqual(first.tasks.map((task) => task.sha256));
    expect(second.tasks.map((task) => task.receipt.sha256)).toEqual(
      first.tasks.map((task) => task.receipt.sha256),
    );
    expect(second.tasks.map((task) => task.marketId)).toEqual(first.tasks.map((task) => task.marketId));
  });
});

describe("buildSampleBenchmark — shape", () => {
  test("the benchmark record has exactly N (>= 2) items, each matching a built task's digest", async () => {
    const sample = await buildSampleBenchmark();

    expect(sample.tasks.length).toBeGreaterThanOrEqual(2);
    expect(sample.benchmark.record.items).toHaveLength(sample.tasks.length);

    const taskDigests = new Set(sample.tasks.map((task) => task.sha256));
    for (const item of sample.benchmark.record.items) {
      expect(taskDigests.has(item.task.digest.sha256)).toBe(true);
    }
  });

  test("every task binds evaluation.digest.sha256 to the evaluation spec's own digest", async () => {
    const sample = await buildSampleBenchmark();

    for (const task of sample.tasks) {
      const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(task.bytes)) as {
        evaluation: { digest: { sha256: string } };
      };
      expect(parsed.evaluation.digest.sha256).toBe(sample.evaluationSpec.sha256);
    }
  });

  test("each admission receipt envelope's bare-hex digest equals sha256Hex of its own bytes", async () => {
    const sample = await buildSampleBenchmark();

    for (const task of sample.tasks) {
      expect(task.receipt.sha256).toMatch(HEX64);
      expect(task.receipt.sha256).toBe(sha256Hex(task.receipt.envelopeBytes));
    }
  });

  test("every digest field is bare lowercase hex, and market ids are distinct", async () => {
    const sample = await buildSampleBenchmark();

    expect(sample.benchmark.sha256).toMatch(HEX64);
    expect(sample.evaluationSpec.sha256).toMatch(HEX64);
    for (const task of sample.tasks) {
      expect(task.sha256).toMatch(HEX64);
    }
    const marketIds = sample.tasks.map((task) => task.marketId);
    expect(new Set(marketIds).size).toBe(marketIds.length);
  });
});

describe("buildSampleBenchmark — launcher shape contract", () => {
  const scratchRoots: string[] = [];
  afterEach(() => {
    for (const root of scratchRoots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  test("every sample task drives prediction-v1-baseline to the exact expected prediction.json", async () => {
    const sample = await buildSampleBenchmark();

    for (const task of sample.tasks) {
      const parsedTask = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(task.bytes)) as {
        payload: { forecast: { consensusProbabilityYes: string; observedAt: string } };
      };

      const root = mkdtempSync(join(tmpdir(), "bp11-sample-launch-"));
      scratchRoots.push(root);
      const inputDir = join(root, "input");
      const outDir = join(root, "out");
      const workDir = join(root, "work");
      mkdirSync(inputDir, { recursive: true });
      mkdirSync(outDir, { recursive: true });
      mkdirSync(workDir, { recursive: true });
      writeFileSync(join(inputDir, "task.json"), task.bytes);

      const view = {
        task: { instructions: "x", outputs: [] },
        effectiveRequirements: {},
        profile: { profile: "https://spec.jinn.network/task-profiles/prediction-forecast/1.0" },
      } as unknown as Parameters<typeof predictionV1BaselineLauncher.plan>[0];
      const paths = {
        work: workDir,
        input: inputDir,
        harnessState: join(root, "hs"),
        secrets: join(root, "secrets"),
        out: outDir,
        root,
        logs: join(root, "logs"),
        tmp: join(root, "tmp"),
        meta: join(root, "meta"),
      } as Parameters<typeof predictionV1BaselineLauncher.plan>[1];
      const attempt = {
        attemptUri: "urn:uuid:00000000-0000-0000-0000-000000000001",
        nonce: "n",
        attemptNumber: 1,
      } as Parameters<typeof predictionV1BaselineLauncher.plan>[2];

      const plan = predictionV1BaselineLauncher.plan(view, paths, attempt);
      const result = spawnSync(plan.argv[0]!, plan.argv.slice(1), {
        cwd: plan.cwd,
        env: { ...process.env, ...plan.env },
        encoding: "utf8",
      });

      expect(result.status, result.stderr).toBe(0);
      const prediction = JSON.parse(readFileSync(join(outDir, "prediction.json"), "utf8"));
      expect(prediction).toStrictEqual({
        probabilityYes: parsedTask.payload.forecast.consensusProbabilityYes,
        submittedAt: parsedTask.payload.forecast.observedAt,
      });
    }
  });
});
