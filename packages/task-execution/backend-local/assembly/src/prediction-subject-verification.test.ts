// SPDX-License-Identifier: Apache-2.0
//
// Gate-round-23 defect #39, pinned end to end with real components on both sides of the join.
//
// The FIRST-ever live evaluation harness run refused its subject with
// `subject Delivery output prediction.json is not declared by the Task.` The requester's Task
// declares exactly one output, `prediction` -- the logical name the sealed
// `prediction-forecast/1.0` profile's `outputConventions.slots[0].name` carries. The solver's
// Delivery declared two outputs named by FILENAME (`prediction.json`, `structured-output.json`).
//
// Nothing in the repository mediated between the two, so this test is the mediator: the REAL
// profile-derived Task, the REAL `prediction-v1-baseline` launcher's own `LaunchPlan` spawned as
// the backend spawns it, the REAL workspace harvest, the REAL delivery-output derivation the
// backend seals with, and the REAL `verifyEvaluationSubject` the evaluator refuses with.
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { predictionV1BaselineLauncher } from "@jinn-network/task-execution-launchers";
import {
  buildPredictionForecastProfile,
  PREDICTION_FORECAST_PROFILE_URI,
  sealTaskProfile,
  verifyEvaluationSubject,
} from "@jinn-network/task-execution-profiles";
import {
  documentDigest,
  sealDelivery,
  sealTask,
  type TaskSpecification,
} from "@jinn-network/task-execution-protocol";
import {
  harvest as workspaceHarvest,
  type WorkspacePaths,
} from "@jinn-network/task-execution-workspace";
import { readFileSync, writeFileSync } from "node:fs";
import { STAGED_SEALED_TASK_FILENAME } from "@jinn-network/task-execution-workspace";
import { afterEach, describe, expect, test } from "vitest";
import { deliveryOutputsFromHarvest } from "./delivery-outputs.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/**
 * The Task exactly as the requester builds it: outputs derived from the sealed profile's
 * `outputConventions.slots`, never from any filename. `packages/task-supply/derivation`'s
 * `buildSealedTask` and `packages/task-supply/admission`'s `prediction-snapshot` admission policy
 * both do precisely this, and the launcher's own inline `isNativeTask` guard re-checks it.
 */
function requesterTask(): TaskSpecification {
  const profile = buildPredictionForecastProfile();
  const sealed = sealTaskProfile(profile);
  const outputs = profile.outputConventions.slots.map((slot) => {
    const content = slot.schema?.content;
    if (slot.mediaType === undefined || content === undefined) {
      throw new Error(`prediction-forecast output slot ${slot.name} is under-specified`);
    }
    return {
      name: slot.name,
      mediaType: slot.mediaType,
      required: slot.required,
      schema: JSON.parse(content) as Record<string, unknown>,
    };
  });
  return {
    protocol: "https://spec.jinn.network/profiles/task-execution/v1",
    profile: {
      uri: PREDICTION_FORECAST_PROFILE_URI,
      digest: { sha256: sealed.digest.slice("sha256:".length) },
    },
    instructions: "Forecast the pinned market snapshot.",
    payload: {
      forecast: {
        marketId: "market-39",
        question: "Does the delivery declare what the Task asked for?",
        consensusProbabilityYes: "0.5",
        observedAt: "2026-08-12T00:00:00Z",
        resolvesAt: "2026-09-12T00:00:00Z",
      },
    },
    outputs,
    evaluation: { name: "evaluation-spec.json", digest: { sha256: "a".repeat(64) } },
  } as unknown as TaskSpecification;
}

async function workspace(): Promise<WorkspacePaths> {
  const root = await mkdtemp(join(tmpdir(), "jinn-39-subject-"));
  roots.push(root);
  const paths: WorkspacePaths = {
    root,
    input: join(root, "input"),
    work: join(root, "work"),
    out: join(root, "out"),
    logs: join(root, "logs"),
    harnessState: join(root, "harness-state"),
    secrets: join(root, "secrets"),
    tmp: join(root, "tmp"),
    meta: join(root, "meta"),
  };
  for (const path of Object.values(paths)) await mkdir(path, { recursive: true });
  return paths;
}

describe("#39 prediction Task/Delivery output declarations", () => {
  test("the real launcher's own outputs verify as an exact evaluation subject", async () => {
    const task = requesterTask();
    const taskBytes = sealTask(task);
    const paths = await workspace();
    writeFileSync(join(paths.input, STAGED_SEALED_TASK_FILENAME), taskBytes);

    // The launcher plans; the backend spawns exactly this argv/env. Nothing here reinterprets
    // what the launcher decided to write, which is the whole point.
    const plan = predictionV1BaselineLauncher.plan(
      {
        task,
        profile: { profile: PREDICTION_FORECAST_PROFILE_URI },
        effectiveRequirements: {
          harness: { id: "prediction-v1-baseline" },
          isolationPolicy: "unrestricted",
        },
      } as never,
      paths,
      { attemptUri: "urn:uuid:00000000-0000-4000-8000-000000000039" } as never,
    );
    const spawned = spawnSync(plan.argv[0]!, plan.argv.slice(1), {
      cwd: plan.cwd,
      env: {
        ...plan.env,
        JINN_ATTEMPT_INPUT: paths.input,
        JINN_ATTEMPT_OUT: paths.out,
      },
      encoding: "utf8",
    });
    expect(spawned.status, spawned.stderr).toBe(0);

    const harvested = await workspaceHarvest(paths, task.outputs);
    const outputs = deliveryOutputsFromHarvest(harvested.manifest, task.outputs);
    const deliveryBytes = sealDelivery({
      protocol: "https://spec.jinn.network/profiles/task-execution/v1",
      attempt: "urn:uuid:00000000-0000-4000-8000-000000000039",
      task: documentDigest(taskBytes),
      outputs,
      outcome: "fulfilled",
      createdAt: "2026-08-12T00:00:00.000Z",
    } as never);

    // The evaluator's exact-subject admission, unmodified. The Result material is what the
    // published Delivery names -- so a Delivery naming a file the Task never declared cannot be
    // rescued by supplying that file.
    const results = outputs.map((output) => ({
      name: output.name,
      bytes: new Uint8Array(readFileSync(join(paths.out, output.name))),
    }));
    const verified = verifyEvaluationSubject({ taskBytes, deliveryBytes, results });
    expect(verified.results.map(({ name }) => name)).toEqual(["prediction"]);
    expect(verified.results[0]!.mediaType).toBe("application/json");
    expect(JSON.parse(new TextDecoder().decode(verified.results[0]!.bytes))).toEqual({
      probabilityYes: "0.5",
      submittedAt: "2026-08-12T00:00:00Z",
    });

    // The backend's structured-output envelope still exists for `readResultEnvelope`; it is just
    // never a Task output.
    expect(readdirSync(paths.out).sort()).toEqual(["prediction", "structured-output.json"]);
  });

  test("an undeclared harvested file is never declared as a Delivery output", () => {
    const task = requesterTask();
    const outputs = deliveryOutputsFromHarvest(
      [
        { path: "prediction", sizeBytes: 1, sha256: `sha256:${"a".repeat(64)}`, mediaType: "application/json" },
        { path: "structured-output.json", sizeBytes: 1, sha256: `sha256:${"b".repeat(64)}` },
        { path: "logs/harness.ndjson", sizeBytes: 1, sha256: `sha256:${"c".repeat(64)}` },
      ],
      task.outputs,
    );
    expect(outputs.map(({ name }) => name)).toEqual(["prediction"]);
  });

  test("a genuinely missing required output yields no output, never a substitute", () => {
    const task = requesterTask();
    const outputs = deliveryOutputsFromHarvest(
      [{ path: "structured-output.json", sizeBytes: 1, sha256: `sha256:${"b".repeat(64)}` }],
      task.outputs,
    );
    expect(outputs).toEqual([]);
  });
});
