import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { parseCellKey } from "@jinn-network/benchmarking-records";
import { artifactsDir } from "../../workspace/layout.js";
import { observeHarborArmTrials } from "./arm-job.js";
import { harborTrialAttemptNumber, harborTrialTaskName } from "./manifest.js";

const selectionManifestSha256 = "aa".repeat(32);
const runSha256 = "bb".repeat(32);
const taskDigest = "cc".repeat(32);
const armId = "oracle-a";

let root: string;

afterEach(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
});

function mappingDocs(workspaceDir: string): readonly { readonly jinnIdentity: string; readonly trialId: string }[] {
  const dir = join(artifactsDir(workspaceDir), "harbor", "mappings", "by-dispatch");
  return readdirSync(dir).map((name) => JSON.parse(readFileSync(join(dir, name), "utf8")) as {
    jinnIdentity: string;
    trialId: string;
  });
}

function identityCoord(identity: string): { readonly replicate: number; readonly dispatch: number } {
  const parts = identity.split(":");
  const coord = parseCellKey(parts[2]!);
  return { replicate: coord.replicate, dispatch: Number(parts[3]) };
}

describe("Harbor 0.21 trial identity", () => {
  test("reads exclude_defaults config: task.path and trial_name, no task.name", () => {
    const trial = {
      task: { path: "/tmp/task-material/adaptive-rejection-sampler", source: "local" },
      trial_name: "adaptive-rejection-sampler__55xttAM",
    };
    expect(harborTrialTaskName(trial)).toBe("adaptive-rejection-sampler");
    expect(harborTrialAttemptNumber(trial)).toBeUndefined();
    expect(harborTrialTaskName({ task: { name: "hello-world" }, attempt: 2 })).toBe("hello-world");
    expect(harborTrialAttemptNumber({ task: { name: "hello-world" }, attempt: 2 })).toBe(2);
  });

  test("maps five official-shaped trial directories to attempts 1-5", async () => {
    root = mkdtempSync(join(tmpdir(), "harbor-arm-observe-"));
    const jobRoot = join(root, "job");
    mkdirSync(jobRoot, { recursive: true });
    writeFileSync(join(jobRoot, "config.json"), JSON.stringify({ retry: { max_retries: 3 } }));
    const suffixes = ["aaaaaaa", "bbbbbbb", "ccccccc", "ddddddd", "eeeeeee"] as const;
    for (const suffix of suffixes) {
      const dir = `adaptive-rejection-sampler__${suffix}`;
      mkdirSync(join(jobRoot, dir));
      writeFileSync(join(jobRoot, dir, "config.json"), JSON.stringify({
        task: { path: "/material/adaptive-rejection-sampler", source: "local" },
        trial_name: dir,
      }));
      writeFileSync(join(jobRoot, dir, "result.json"), JSON.stringify({ status: "success" }));
    }
    writeFileSync(join(jobRoot, "result.json"), JSON.stringify({ id: "job", n_total_trials: 5, finished_at: "2026-01-01T00:00:00Z", stats: { n_retries: 0 } }));

    await observeHarborArmTrials({
      workspaceDir: root,
      selectionManifestSha256,
      runSha256,
      armId,
      jobName: "job",
      jobRoot,
      fallbackTaskDigest: taskDigest,
      timeoutMs: 250,
    });

    const docs = mappingDocs(root);
    expect(docs).toHaveLength(5);
    expect(docs.map((doc) => identityCoord(doc.jinnIdentity).replicate).sort((left, right) => left - right)).toEqual([1, 2, 3, 4, 5]);
    expect(docs.every((doc) => identityCoord(doc.jinnIdentity).dispatch === 1)).toBe(true);
    expect(docs.every((doc) => doc.trialId.startsWith("adaptive-rejection-sampler__") && doc.trialId.endsWith(".g1"))).toBe(true);
  });

  test("keeps observing while official Harbor result.json has finished_at null", async () => {
    root = mkdtempSync(join(tmpdir(), "harbor-arm-inflight-"));
    const jobRoot = join(root, "job");
    mkdirSync(jobRoot, { recursive: true });
    writeFileSync(join(jobRoot, "config.json"), JSON.stringify({ retry: { max_retries: 3 } }));
    writeFileSync(join(jobRoot, "result.json"), JSON.stringify({
      id: "job",
      finished_at: null,
      n_total_trials: 1,
      stats: { n_running_trials: 1, n_pending_trials: 0, n_retries: 0 },
    }));
    const observing = observeHarborArmTrials({
      workspaceDir: root,
      selectionManifestSha256,
      runSha256,
      armId,
      jobName: "job",
      jobRoot,
      fallbackTaskDigest: taskDigest,
      timeoutMs: 400,
    });
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(existsSync(join(artifactsDir(root), "harbor", "mappings", "by-dispatch"))).toBe(false);
    const dir = "adaptive-rejection-sampler__late1";
    mkdirSync(join(jobRoot, dir));
    writeFileSync(join(jobRoot, dir, "config.json"), JSON.stringify({
      task: { path: "/material/adaptive-rejection-sampler" },
      trial_name: dir,
    }));
    writeFileSync(join(jobRoot, dir, "result.json"), JSON.stringify({ status: "success" }));
    writeFileSync(join(jobRoot, "result.json"), JSON.stringify({
      id: "job",
      finished_at: "2026-01-01T00:00:02Z",
      n_total_trials: 1,
      stats: { n_retries: 0 },
    }));
    await observing;
    expect(mappingDocs(root)).toHaveLength(1);
  });

  test("wipe-and-recreate of the same directory keeps the attempt and bumps generation", async () => {
    root = mkdtempSync(join(tmpdir(), "harbor-arm-wipe-"));
    const jobRoot = join(root, "job");
    mkdirSync(jobRoot, { recursive: true });
    writeFileSync(join(jobRoot, "config.json"), JSON.stringify({ retry: { max_retries: 3 } }));
    const dir = "adaptive-rejection-sampler__wipe1";
    mkdirSync(join(jobRoot, dir));
    const configPath = join(jobRoot, dir, "config.json");
    writeFileSync(configPath, JSON.stringify({
      task: { path: "/material/adaptive-rejection-sampler" },
      trial_name: dir,
    }));
    writeFileSync(join(jobRoot, dir, "result.json"), JSON.stringify({ status: "error", exception_type: "RuntimeError" }));

    const observing = observeHarborArmTrials({
      workspaceDir: root,
      selectionManifestSha256,
      runSha256,
      armId,
      jobName: "job",
      jobRoot,
      fallbackTaskDigest: taskDigest,
      timeoutMs: 500,
    });
    await new Promise((resolve) => setTimeout(resolve, 80));
    writeFileSync(configPath, JSON.stringify({
      task: { path: "/material/adaptive-rejection-sampler" },
      trial_name: dir,
      rewritten: true,
    }));
    writeFileSync(join(jobRoot, dir, "result.json"), JSON.stringify({ status: "success" }));
    writeFileSync(join(jobRoot, "result.json"), JSON.stringify({ id: "job", finished_at: "2026-01-01T00:00:01Z", stats: { n_retries: 1 } }));
    await observing;

    const generations = mappingDocs(root).filter((doc) => doc.trialId.startsWith(dir));
    expect([...generations.map((doc) => doc.trialId)].sort()).toEqual([`${dir}.g1`, `${dir}.g2`]);
    expect(new Set(generations.map((doc) => identityCoord(doc.jinnIdentity).replicate)).size).toBe(1);
    expect([...generations.map((doc) => identityCoord(doc.jinnIdentity).dispatch)].sort((left, right) => left - right)).toEqual([1, 2]);
  });
});
