import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { recordHarborDispatchMapping } from "../../venue/provisioner.js";
import { harborArmJobName } from "./launcher.js";
import {
  HarborJobConfigSchema,
  assertHarborRetryPinnedOff,
  assertHarborTrialMatchesCell,
  assertSingleHarborTrial,
  harborJobSource,
  harborSelectedTaskNames,
  harborSelectionManifestBytes,
  type HarborSelectionManifest,
} from "./manifest.js";

const manifest: HarborSelectionManifest = {
  schema: "jinn.network/benchmark-product/harbor-selection/1",
  adapter: { id: "harbor", version: "1" },
  harbor: { version: "0.21.4", executableSha256: "a".repeat(64) },
  source: {
    kind: "dataset",
    input: { name: "terminal-bench/terminal-bench-2-1", ref: `sha256:${"b".repeat(64)}` },
    jobInput: { path: ".jinn-harbor/dataset" },
    resolved: { reference: "terminal-bench/terminal-bench-2-1", revision: `sha256:${"b".repeat(64)}`, checksum: "c".repeat(64), files: [{ path: "hello-world/task.toml", sha256: "d".repeat(64), bytes: 1 }] },
    taskName: "hello-world",
    taskNames: ["hello-world"],
  },
  arms: [{
    armId: "one",
    agent: { id: "agent-one", configuration: {} },
    model: { id: "model-one", configuration: {} },
    jobAgent: { name: "agent-one", model_name: "model-one" },
  }],
  environment: { type: "docker", image: `registry.example/env@sha256:${"e".repeat(64)}`, configuration: {} },
  retryPolicy: { nAttempts: 5, nConcurrent: 2, maxRetries: 0 },
  jobGrain: "per-arm",
  outputs: [{ name: "prediction", mediaType: "application/json", artifact: { source: "/logs/artifacts/prediction.json", destination: "prediction.json" }, nativePath: "artifacts/prediction.json" }],
};

describe("Harbor planned-trial grain", () => {
  test("seals planned k attempts and refuses Harbor inner retry", () => {
    expect(() => harborSelectionManifestBytes(manifest)).not.toThrow();
    expect(harborSelectedTaskNames(manifest.source)).toEqual(["hello-world"]);
    expect(() => harborSelectionManifestBytes({ ...manifest, retryPolicy: { nAttempts: 5, nConcurrent: 2, maxRetries: 1 } } as never)).toThrow();
    const job = HarborJobConfigSchema.parse({
      job_name: "job",
      jobs_dir: "jobs",
      n_attempts: 5,
      n_concurrent_trials: 2,
      retry: { max_retries: 0 },
      environment: { type: "docker" },
      agents: [manifest.arms[0]!.jobAgent],
      artifacts: manifest.outputs.map((output) => output.artifact),
      datasets: [{ path: ".jinn-harbor/dataset", task_names: ["hello-world"], n_tasks: 1 }],
    });
    expect(job.n_attempts).toBe(5);
    expect(job.n_concurrent_trials).toBe(2);
    expect(() => HarborJobConfigSchema.parse({ ...job, retry: { max_retries: 1 } })).toThrow();
    expect(() => HarborJobConfigSchema.parse({
      ...job,
      datasets: [{ path: ".jinn-harbor/dataset", task_names: ["a", "b"], n_tasks: 1 }],
    })).toThrow();
    expect(harborJobSource(manifest)).toEqual({
      datasets: [{ path: ".jinn-harbor/dataset", task_names: ["hello-world"], n_tasks: 1 }],
    });
  });

  test("names the per-arm Job from Run identity, not Submission", () => {
    const runSha256 = "ab".repeat(32);
    expect(harborArmJobName(runSha256, "one")).toBe(`jinn-${runSha256.slice(0, 24)}-one`);
    expect(() => harborArmJobName("nope", "one")).toThrow();
    expect(() => harborArmJobName(runSha256, "bad/arm")).toThrow();
  });

  test("matches one Trial inside a k-trial Job and still pins retry off", () => {
    const job = HarborJobConfigSchema.parse({
      job_name: "job",
      jobs_dir: "jobs",
      n_attempts: 5,
      n_concurrent_trials: 2,
      retry: { max_retries: 0 },
      environment: { type: "docker" },
      agents: [manifest.arms[0]!.jobAgent],
      artifacts: manifest.outputs.map((output) => output.artifact),
      datasets: [{ path: ".jinn-harbor/dataset", task_names: ["hello-world"], n_tasks: 1 }],
    });
    const jobResult = { id: "job", n_total_trials: 5, stats: { n_retries: 0 } };
    const trial = { task: { name: "hello-world" }, attempt: 3 };
    expect(() => assertHarborRetryPinnedOff(job, trial, jobResult)).not.toThrow();
    expect(() => assertHarborTrialMatchesCell(job, trial, jobResult, { taskName: "hello-world", attempt: 3 })).not.toThrow();
    expect(() => assertHarborTrialMatchesCell(job, trial, jobResult, { taskName: "hello-world", attempt: 1 })).toThrow();
    expect(() => assertHarborTrialMatchesCell(job, { ...trial, source_trial: "prior" }, jobResult, { taskName: "hello-world", attempt: 3 })).toThrow();
    expect(() => assertHarborTrialMatchesCell(job, trial, { ...jobResult, stats: { n_retries: 1 } }, { taskName: "hello-world", attempt: 3 })).toThrow();
    expect(() => assertSingleHarborTrial(job, trial, jobResult)).toThrow(/hidden attempts/);
  });

  test("one Harbor Job may map many Trials, but a Trial cannot be remapped", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "harbor-job-grain-map-"));
    try {
      await recordHarborDispatchMapping(workspaceDir, "dispatch-a", "job-shared", "trial-1");
      await recordHarborDispatchMapping(workspaceDir, "dispatch-b", "job-shared", "trial-2");
      await expect(recordHarborDispatchMapping(workspaceDir, "dispatch-c", "job-shared", "trial-1")).rejects.toThrow(/cannot be remapped/);
      await recordHarborDispatchMapping(workspaceDir, "dispatch-d", "job-other", "trial-1");
    } finally {
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });
});
