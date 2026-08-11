import { mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { parseMatrix } from "@jinn-network/benchmarking-records";
import { createDraft } from "../../operations/drafts.js";
import { initWorkspace } from "../../operations/init.js";
import { selectInspectEvaluation } from "../../operations/inspect-runtime.js";
import { runCollect } from "../../operations/run-collect.js";
import { runCancel } from "../../operations/run-cancel.js";
import { runLaunch } from "../../operations/run-launch.js";
import { runLock } from "../../operations/run-lock.js";
import { runPreview } from "../../operations/preview.js";
import { runQuote } from "../../operations/run-quote.js";
import type { OperationContext } from "../../operations/context.js";
import { getSealedBytes } from "../../workspace/sealed-store.js";

const imageDigest = process.env.JINN_INSPECT_OCI_IMAGE;
const datasetCacheDir = process.env.JINN_INSPECT_OCI_DATASET_CACHE;
const dockerPath = process.env.JINN_DOCKER_PATH ?? "/usr/local/bin/docker";
const fixtureDir = dirname(fileURLToPath(new URL("../../../test/fixtures/inspect-project/hermetic_eval.py", import.meta.url)));
const workspaces: string[] = [];

afterEach(() => {
  for (const workspace of workspaces.splice(0)) rmSync(workspace, { recursive: true, force: true });
});

describe.skipIf(imageDigest === undefined || datasetCacheDir === undefined)("real OCI Inspect runtime", () => {
  test("runs one exact sample across two arms through preview and the official lifecycle", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "benchmark-product-inspect-oci-"));
    workspaces.push(workspaceDir);
    const context: OperationContext = {
      workspaceDir,
      principal: "sponsor-1",
      clock: () => new Date().toISOString(),
    };
    expect(initWorkspace(context).ok).toBe(true);
    expect(createDraft(context, { draftId: "inspect-oci", name: "OCI Inspect fixture" }).ok).toBe(true);
    const selected = await selectInspectEvaluation(context, {
      draftId: "inspect-oci",
      execution: "oci",
      dockerPath,
      imageDigest: imageDigest!,
      projectDir: fixtureDir,
      datasetCacheDir: datasetCacheDir!,
      taskReference: "hermetic_eval.py@hermetic_eval",
      arms: [
        { armId: "control", model: "mockllm/model" },
        { armId: "candidate", model: "mockllm/model" },
      ],
      scorer: { name: "match", passValue: "C" },
      runOptions: { sampleId: "alpha", maxSamples: 1, retryOnError: 0 },
    });
    expect(selected.ok, JSON.stringify(selected)).toBe(true);
    expect((await runPreview(context, { draftId: "inspect-oci" })).ok).toBe(true);
    expect((await runQuote(context, { draftId: "inspect-oci" })).ok).toBe(true);
    expect(runLock(context, { draftId: "inspect-oci" }).ok).toBe(true);
    expect((await runLaunch(context, { draftId: "inspect-oci" })).ok).toBe(true);
    const collected = await runCollect(context, { draftId: "inspect-oci" });
    expect(collected.ok, JSON.stringify(collected)).toBe(true);
    if (!collected.ok) throw new Error("unreachable");
    const matrix = parseMatrix(getSealedBytes(workspaceDir, collected.result.matrixSha256));
    expect(matrix.completeness).toMatchObject({ expected: 2, judged: 2, runOutcome: "complete" });
    expect(matrix.cells).toHaveLength(2);
    expect(matrix.cells.every((cell) => cell.outcome === "judged")).toBe(true);
  }, 180_000);

  test("cancellation reaps the OCI worker without leaving a container", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "benchmark-product-inspect-oci-cancel-"));
    workspaces.push(workspaceDir);
    const context: OperationContext = {
      workspaceDir,
      principal: "sponsor-1",
      clock: () => new Date().toISOString(),
    };
    expect(initWorkspace(context).ok).toBe(true);
    expect(createDraft(context, { draftId: "inspect-oci-cancel", name: "OCI cancellation fixture" }).ok).toBe(true);
    const selected = await selectInspectEvaluation(context, {
      draftId: "inspect-oci-cancel",
      execution: "oci",
      dockerPath,
      imageDigest: imageDigest!,
      projectDir: fixtureDir,
      datasetCacheDir: datasetCacheDir!,
      taskReference: "hermetic_eval.py@cancellation_eval",
      arms: [
        { armId: "control", model: "mockllm/model" },
        { armId: "candidate", model: "mockllm/model" },
      ],
      scorer: { name: "match", passValue: "C" },
      runOptions: { sampleId: "alpha", maxSamples: 1, retryOnError: 0 },
    });
    expect(selected.ok, JSON.stringify(selected)).toBe(true);
    expect((await runQuote(context, { draftId: "inspect-oci-cancel" })).ok).toBe(true);
    expect(runLock(context, { draftId: "inspect-oci-cancel" }).ok).toBe(true);
    let cancellation: ReturnType<typeof runCancel> | undefined;
    const launched = await runLaunch(context, { draftId: "inspect-oci-cancel" }, {
      onSolveAttemptNonterminal() {
        cancellation ??= runCancel(context, { draftId: "inspect-oci-cancel" });
      },
    });
    expect(launched.ok, JSON.stringify(launched)).toBe(true);
    expect(cancellation).toBeDefined();
    if (cancellation === undefined) throw new Error("unreachable");
    expect((await cancellation).ok).toBe(true);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
    const remaining = execFileSync(dockerPath, ["ps", "--filter", "name=jinn-inspect-", "--format", "{{.Names}}"], {
      encoding: "utf8",
    }).trim();
    expect(remaining).toBe("");
  }, 180_000);
});
