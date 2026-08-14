import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { createDefaultBenchmarkRuntimeHost } from "../runtime/host-port.js";
import type { OperationContext } from "./context.js";
import { createDraft } from "./drafts.js";
import { initWorkspace } from "./init.js";
import { selectInspectEvaluation, type SelectInspectEvaluationInput } from "./inspect-runtime.js";

const workspaces: string[] = [];

afterEach(() => {
  for (const workspace of workspaces.splice(0)) rmSync(workspace, { recursive: true, force: true });
});

function setup(): OperationContext {
  const workspaceDir = mkdtempSync(join(tmpdir(), "benchmark-product-inspect-request-"));
  workspaces.push(workspaceDir);
  const context = { workspaceDir, principal: "sponsor-1", clock: () => "2026-08-13T12:00:00.000Z" };
  expect(initWorkspace(context).ok).toBe(true);
  expect(createDraft(context, { draftId: "inspect", name: "Inspect request" }).ok).toBe(true);
  return context;
}

const base = {
  draftId: "inspect",
  pythonPath: "/not-reached/python",
  projectDir: "/not-reached/project",
  taskReference: "task.py@task",
  arms: [
    { armId: "control", model: "mockllm/model" },
    { armId: "candidate", model: "mockllm/model" },
  ],
};

describe("selectInspectEvaluation scoring forms", () => {
  test.each([
    ["neither", base],
    ["both", {
      ...base,
      scorer: { name: "match", passValue: "C" },
      scoring: {
        projections: [{ measurementName: "correct", scorerName: "match", passValue: "C" }],
        verdictRule: { threshold: { measurement: "correct", op: "eq", value: true } },
      },
    }],
  ])("rejects %s scoring form before invoking the runtime host", async (_name, input) => {
    const selected = await selectInspectEvaluation(setup(), input as unknown as SelectInspectEvaluationInput);
    expect(selected.ok).toBe(false);
    if (!selected.ok) expect(selected.error).toMatchObject({ code: "validation" });
  });

  test("reports missing Docker as an actionable venue preflight refusal", async () => {
    const context = setup();
    const fixtureRoot = mkdtempSync(join(tmpdir(), "benchmark-product-missing-docker-"));
    workspaces.push(fixtureRoot);
    const projectDir = join(fixtureRoot, "project");
    const datasetCacheDir = join(fixtureRoot, "dataset-cache");
    mkdirSync(projectDir);
    mkdirSync(datasetCacheDir);
    const selected = await selectInspectEvaluation(context, {
      draftId: "inspect",
      execution: "oci",
      dockerPath: join(fixtureRoot, "docker-does-not-exist"),
      imageDigest: `sha256:${"a".repeat(64)}`,
      projectDir,
      datasetCacheDir,
      taskReference: "task.py@task",
      arms: [
        { armId: "control", model: "mockllm/model" },
        { armId: "candidate", model: "mockllm/model" },
      ],
      scorer: { name: "match", passValue: "C" },
      runOptions: { sampleId: "alpha", maxSamples: 1, retryOnError: 0 },
    });
    expect(selected).toMatchObject({
      ok: false,
      error: {
        code: "venue-unavailable",
        detail: expect.stringContaining("Docker is required"),
        issues: [{ path: "inspect.selection.runtime" }],
      },
    });
  });

  test("does not recategorize a semantic Inspect selection failure as a venue outage", async () => {
    const runtimeHost = createDefaultBenchmarkRuntimeHost();
    const selected = await selectInspectEvaluation({
      ...setup(),
      runtimeHost: {
        ...runtimeHost,
        resolveInspectSelection: async () => {
          throw new Error("selected Inspect task has duplicate resolved scorer names");
        },
      },
    }, {
      ...base,
      scorer: { name: "match", passValue: "C" },
    });
    expect(selected).toMatchObject({ ok: false, error: { code: "execution" } });
  });
});
