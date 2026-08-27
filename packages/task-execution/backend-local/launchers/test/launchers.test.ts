import { chmodSync, lstatSync, mkdtempSync, readdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { claudeCodeLauncher, codexLauncher, cursorLauncher, hermesLauncher, interpretResult, predictionV1BaselineLauncher } from "../src/index.js";
import type { LaunchPlan } from "../src/contract.js";
import type { AttemptIdentity } from "@jinn-network/task-execution-supervisor";
import {
  makeDirProvisioner,
  STAGED_DISPATCH_CONTEXT_FILENAME,
  STAGED_SEALED_TASK_FILENAME,
} from "@jinn-network/task-execution-workspace";
import type { TaskView, WorkspacePaths } from "@jinn-network/task-execution-workspace";

const view = { task: { instructions: "do the work", outputs: [] }, effectiveRequirements: {}, profile: { profile: "https://spec.jinn.network/task-profiles/repository-work/1.0" } } as unknown as TaskView;
const paths = { work: "/attempt/work", input: "/attempt/input", harnessState: "/attempt/harness-state", secrets: "/attempt/secrets", out: "/attempt/out", root: "/attempt", logs: "/attempt/logs", tmp: "/attempt/tmp", meta: "/attempt/meta" } as WorkspacePaths;
const attempt = { attemptUri: "urn:uuid:00000000-0000-0000-0000-000000000001", nonce: "n", attemptNumber: 1 } as AttemptIdentity;

const scratchRoots: string[] = [];
afterEach(() => {
  for (const root of scratchRoots.splice(0)) {
    // The provisioner seals `input/` to 0o500 with 0o400 children; unlink needs write on the dir.
    unseal(join(root, "input"));
    rmSync(root, { recursive: true, force: true });
  }
});

function unseal(directory: string): void {
  try {
    // Symlinks are skipped throughout: `chmod` FOLLOWS them, so descending into one would reach
    // outside the tree this walk owns and repermission whatever it points at. `rmSync` unlinks a
    // symlink without needing the target's permission, so skipping costs nothing. The root gets
    // its own `lstat` because nothing above this has checked it; `readdirSync(withFileTypes)` is
    // already `lstat`-based, which is what makes the loop's check meaningful.
    if (lstatSync(directory).isSymbolicLink()) return;
    chmodSync(directory, 0o700);
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const child = join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) unseal(child);
      else chmodSync(child, 0o600);
    }
  } catch {
    // A test that never provisioned has no sealed input dir to unseal.
  }
}

const goldenNativeTask = (): Buffer => readFileSync(join(
  process.cwd(), "../../../task-supply/admission/fixtures/prediction-snapshot-v1/task.json",
));

/**
 * #2538: stage the attempt through the REAL provisioner.
 *
 * The previous fixture hand-wrote `input/task.json`, which is not the name the provisioner uses.
 * A fixture that stages the input itself can disagree with production in the same direction on
 * every run, and then no test can ever catch the divergence — which is exactly what happened: the
 * launcher globbed `*.json`, the provisioner staged `task.sealed`, CI was green, and every live
 * attempt exited 2 about ten milliseconds after start. Provisioning here means the launcher and
 * the provisioner are exercised against ONE contract; move either side's filename alone and these
 * tests go red.
 */
async function provisionAttempt(sealedTaskBytes: Uint8Array): Promise<WorkspacePaths> {
  const root = mkdtempSync(join(tmpdir(), "jinn-provisioned-attempt-"));
  scratchRoots.push(root);
  const provisioned = {
    root,
    input: join(root, "input"),
    work: join(root, "work"),
    out: join(root, "out"),
    logs: join(root, "logs"),
    harnessState: join(root, "harness-state"),
    secrets: join(root, "secrets"),
    tmp: join(root, "tmp"),
    meta: join(root, "meta"),
  } as WorkspacePaths;
  await makeDirProvisioner({
    sealedTaskBytes,
    dispatchContextBytes: new TextEncoder().encode(JSON.stringify({
      taskDigest: `sha256:${"0".repeat(64)}`,
      submission: "urn:uuid:00000000-0000-0000-0000-000000000002",
      nonce: "n",
      attempt: attempt.attemptUri,
    })),
    runtime: { assertHarnessGroupEmpty: () => undefined, ensureMetaReserve: () => undefined },
  }).setup(view, provisioned, []);
  return provisioned;
}

function runPlanned(provisioned: WorkspacePaths) {
  const plan = predictionV1BaselineLauncher.plan(view, provisioned, attempt);
  return spawnSync(plan.argv[0]!, plan.argv.slice(1), {
    cwd: plan.cwd,
    env: { ...process.env, ...plan.env },
    encoding: "utf8",
  });
}

describe("v1 launchers", () => {
  for (const launcher of [claudeCodeLauncher, codexLauncher, hermesLauncher, cursorLauncher, predictionV1BaselineLauncher]) {
    it(`${launcher.id} plans deterministically and hermetically`, () => {
      const first = launcher.plan(view, paths, attempt);
      process.env.OPENROUTER_API_KEY = "ambient-secret";
      expect(launcher.plan(view, paths, attempt)).toEqual(first);
      expect(Object.values(first.env).join(" ")).not.toContain("ambient-secret");
      expect(first.cwd).toBe(paths.work);
    });
  }

  it("declares every plan's secret forwards statically", () => {
    expect(hermesLauncher.capabilities().secretForwards).toEqual([
      { grantKey: "openrouter-api-key", target: "openrouter-api-key" },
    ]);
    expect(hermesLauncher.plan(view, paths, attempt).secretForwards).toEqual(
      hermesLauncher.capabilities().secretForwards,
    );
    for (const launcher of [claudeCodeLauncher, codexLauncher, cursorLauncher, predictionV1BaselineLauncher]) {
      expect(launcher.capabilities().secretForwards).toEqual([]);
      expect(launcher.plan(view, paths, attempt).secretForwards).toEqual([]);
    }
  });

  it("uses the exit record over a lying success envelope and preserves resumable limits", () => {
    const plan = claudeCodeLauncher.plan(view, paths, attempt);
    expect(interpretResult(plan, { exitCode: 1 }, { subtype: "success" }).state).toBe("failed");
    expect(interpretResult(plan, { exitCode: 0 }, { subtype: "error_max_turns" })).toMatchObject({ state: "delivered", outcome: "partial", recoveryAdvice: "resume-with-session" });
    expect(interpretResult(plan, { exitCode: 0 }).outcome).toBe("fulfilled");
  });

  // #2538 regression. Fails before the fix (the launcher globbed `*.json` and never saw the
  // provisioner's `task.sealed`, so it exited 2); passes after.
  it("executes the provisioner-staged native golden forecast and emits only its closed prediction output", async () => {
    const provisioned = await provisionAttempt(goldenNativeTask());

    // The divergence pin: the provisioner stages exactly the contracted names, and the launcher
    // reads the same constant. Changing either side alone breaks this file.
    expect(readdirSync(provisioned.input).sort()).toStrictEqual(
      [STAGED_DISPATCH_CONTEXT_FILENAME, STAGED_SEALED_TASK_FILENAME].sort(),
    );

    const first = runPlanned(provisioned);
    expect(first.status, first.stderr).toBe(0);

    // #39 divergence pin: the output file is named for the Task's DECLARATION, read out of the
    // staged Task itself rather than written as a literal here. The workspace harvest binds each
    // declared output to `out/<name>`, so a launcher writing any other name puts a filename into
    // the sealed Delivery's `outputs` -- which the evaluator's `verifyEvaluationSubject` refuses.
    // Asserting against a literal is exactly what let `prediction.json` survive eight live rounds.
    const declaredOutput = JSON.parse(goldenNativeTask().toString("utf8")).outputs[0].name;
    expect(declaredOutput).toBe("prediction");
    const prediction = JSON.parse(readFileSync(join(provisioned.out, declaredOutput), "utf8"));
    expect(prediction).toStrictEqual({ probabilityYes: "0.750000", submittedAt: "2026-08-02T00:00:00Z" });

    // The structured envelope is backend metadata: present for `readResultEnvelope`, and never a
    // name the Task declares.
    expect(readdirSync(provisioned.out).sort())
      .toStrictEqual([declaredOutput, "structured-output.json"].sort());
  });

  it("accepts a native forecast with a self-declared author and namespaced derivation metadata", async () => {
    const authored = JSON.parse(goldenNativeTask().toString("utf8"));
    authored.author = "did:key:z6MkiFixture";
    authored["https://product.example/extensions/derivation/v1"] = {
      sourceTask: { digest: { sha256: "a".repeat(64) } },
    };
    const provisioned = await provisionAttempt(new TextEncoder().encode(JSON.stringify(authored)));
    const result = runPlanned(provisioned);
    expect(result.status, result.stderr).toBe(0);
  });

  it("prediction-v1-baseline refuses a legacy SignedTaskV1 staged as the sealed Task", async () => {
    const provisioned = await provisionAttempt(new TextEncoder().encode(JSON.stringify({
      schemaVersion: "task.v1",
      spec: {
        consensusSnapshot: { probabilityYes: "0.75", source: "polymarket-clob" },
        source: { url: "https://polymarket.com/event/fixture" },
      },
    })));
    const result = runPlanned(provisioned);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain(`input/${STAGED_SEALED_TASK_FILENAME} is not a native prediction-forecast Task`);
  });

  it("refuses when the contracted staged Task is absent", async () => {
    const provisioned = await provisionAttempt(goldenNativeTask());
    unseal(provisioned.input);
    rmSync(join(provisioned.input, STAGED_SEALED_TASK_FILENAME));
    const result = runPlanned(provisioned);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain(`cannot read the staged native Task at input/${STAGED_SEALED_TASK_FILENAME}`);
  });

  // The glob this replaced would have taken a materialized input as the Task whenever it was the
  // only `*.json` that parsed — and the sealed Task never was one. Reading the contracted path
  // removes that substitution surface entirely: a shadow document is simply not consulted.
  it("reads the contracted staged Task, never a shadow document sitting beside it", async () => {
    const golden = JSON.parse(goldenNativeTask().toString("utf8"));
    const provisioned = await provisionAttempt(goldenNativeTask());
    unseal(provisioned.input);
    writeFileSync(join(provisioned.input, "shadow.json"), JSON.stringify({
      ...golden,
      payload: { forecast: { ...golden.payload.forecast, consensusProbabilityYes: "0.250000" } },
    }));

    const result = runPlanned(provisioned);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(readFileSync(join(provisioned.out, golden.outputs[0].name), "utf8")))
      .toStrictEqual({ probabilityYes: "0.750000", submittedAt: "2026-08-02T00:00:00Z" });
  });

  it("does not treat an unspecified blame-rule signal as matching every exit", () => {
    const plan = {
      validExitCodes: [0],
      blameExitCodes: [
        { match: { exitCode: 65 }, blame: "task", reasonCode: "invalid-evaluation-input" },
        { match: { signal: "SIGKILL" }, blame: "infrastructure", reasonCode: "killed" },
      ],
    } as unknown as LaunchPlan;
    expect(interpretResult(plan, { exitCode: 1 }).reasonCode).toBe("invalid-exit");
    expect(interpretResult(plan, { signal: "SIGKILL" }).reasonCode).toBe("killed");
  });
});
