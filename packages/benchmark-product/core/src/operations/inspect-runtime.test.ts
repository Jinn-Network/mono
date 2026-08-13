import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
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
});
