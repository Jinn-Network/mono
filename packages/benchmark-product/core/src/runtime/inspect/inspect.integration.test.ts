import { appendFileSync, cpSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { parseMatrix } from "@jinn-network/benchmarking-records";
import { parseEvaluationSpec } from "@jinn-network/task-execution-profiles";
import { readAuditEntries } from "../../audit/journal.js";
import type { OperationContext } from "../../operations/context.js";
import { createDraft, updateDraft } from "../../operations/drafts.js";
import { initWorkspace } from "../../operations/init.js";
import { selectInspectEvaluation } from "../../operations/inspect-runtime.js";
import { runCollect } from "../../operations/run-collect.js";
import { runCancel } from "../../operations/run-cancel.js";
import { runLaunch } from "../../operations/run-launch.js";
import { runLock } from "../../operations/run-lock.js";
import { runQuote } from "../../operations/run-quote.js";
import { runReport } from "../../operations/report.js";
import { runResults } from "../../operations/run-results.js";
import { runPublish } from "../../operations/publish.js";
import { runPreview } from "../../operations/preview.js";
import { runVerify } from "../../operations/verify.js";
import { verifyPublicBundle } from "../../bundle/verify.js";
import { readRunJournalEntries } from "../../run/journal.js";
import { getSealedBytes, sha256Hex } from "../../workspace/sealed-store.js";
import { readInspectSelectionManifest, inspectWorkerPath } from "./host.js";
import { inspectOciRunnerPath } from "./oci.js";
// @ts-expect-error This product-private runtime is copied into dist without a public type surface.
import { createInspectLogVerifierRegistration } from "./verifier-runtime.mjs";

const pythonPath = process.env.JINN_INSPECT_PYTHON;
const fixtureDir = dirname(fileURLToPath(new URL("../../../test/fixtures/inspect-project/hermetic_eval.py", import.meta.url)));
const workspaces: string[] = [];

afterEach(() => {
  if (process.env.JINN_KEEP_INSPECT_WORKSPACE !== "1") {
    for (const workspace of workspaces.splice(0)) rmSync(workspace, { recursive: true, force: true });
  }
});

function context(workspaceDir: string): OperationContext {
  return { workspaceDir, principal: "sponsor-1", clock: () => new Date().toISOString() };
}

describe.skipIf(pythonPath === undefined)("real Inspect runtime adapter", () => {
  test.each([
    ["separate-evaluator", 1],
    ["evaluator-panel", 2],
    ["strict-agreement", 2],
  ] as const)("runs %s through separately signed native-log verifier legs", async (
    preset,
    expectedVerifiers,
  ) => {
    const workspaceDir = mkdtempSync(join(tmpdir(), `benchmark-product-inspect-${preset}-`));
    workspaces.push(workspaceDir);
    const ctx = context(workspaceDir);
    expect(initWorkspace(ctx).ok).toBe(true);
    expect(createDraft(ctx, { draftId: preset, name: `Inspect ${preset}` }).ok).toBe(true);
    expect(updateDraft(ctx, { draftId: preset, patch: { assurance: { preset } } }).ok).toBe(true);
    const selected = await selectInspectEvaluation(ctx, {
      draftId: preset,
      pythonPath: pythonPath!,
      projectDir: fixtureDir,
      taskReference: "hermetic_eval.py@multiple_scorer_eval",
      arms: [
        { armId: "control", model: "mockllm/model" },
        { armId: "candidate", model: "mockllm/model" },
      ],
      scoring: {
        projections: [
          { measurementName: "correct", scorerName: "correctness_scorer", passValue: "C" },
          { measurementName: "safe", scorerName: "policy_scorer", subScoreKey: "safe", passValue: true },
        ],
        verdictRule: {
          all: [
            { threshold: { measurement: "correct", op: "eq", value: true } },
            { threshold: { measurement: "safe", op: "eq", value: true } },
          ],
        },
      },
    });
    expect(selected.ok, JSON.stringify(selected)).toBe(true);
    if (!selected.ok) throw new Error("unreachable");
    expect(selected.result.runtimeMethod).toMatchObject({
      evaluatorRelationship: "same-execution-scorer",
      scoreSourceRelationship: "same-execution-scorer",
      officialEvaluationRelationship: "separate-log-verifier",
      officialEvaluatorCount: expectedVerifiers,
      partyIndependence: "not-established",
    });
    const previewed = await runPreview(ctx, { draftId: preset, items: 1 });
    expect(previewed.ok, JSON.stringify(previewed)).toBe(true);
    if (!previewed.ok) throw new Error("unreachable");
    expect(previewed.result.preview.scope).toBe("solve-cells-only");
    expect(previewed.result.runtimeMethod).toEqual(selected.result.runtimeMethod);
    expect((await runQuote(ctx, { draftId: preset })).ok).toBe(true);
    const locked = runLock(ctx, { draftId: preset });
    expect(locked.ok).toBe(true);
    expect((await runLaunch(ctx, { draftId: preset })).ok).toBe(true);
    const collected = await runCollect(ctx, { draftId: preset });
    expect(collected.ok, JSON.stringify(collected)).toBe(true);
    if (!collected.ok) throw new Error("unreachable");

    const matrix = parseMatrix(getSealedBytes(workspaceDir, collected.result.matrixSha256));
    expect(matrix.cells).toHaveLength(2);
    expect(
      matrix.cells.every((cell) => cell.outcome === "judged"),
      JSON.stringify({ matrix, journal: readRunJournalEntries(workspaceDir, preset) }),
    ).toBe(true);
    expect(matrix.cells.every((cell) => cell.verdicts.length === expectedVerifiers)).toBe(true);
    const deliveryEntries = readRunJournalEntries(workspaceDir, preset)
      .filter((entry) => entry.kind === "delivery");
    expect(deliveryEntries).toHaveLength(2);
    expect(deliveryEntries.every((entry) =>
      entry.outputs.map((output) => output.name).sort().join(",") === "inspect-log,inspect-summary"
    )).toBe(true);
    const evaluationEntries = readRunJournalEntries(workspaceDir, preset)
      .filter((entry) => entry.kind === "evaluation");
    expect(evaluationEntries).toHaveLength(2 * expectedVerifiers);
    expect(evaluationEntries.every((entry) =>
      entry.evalTaskSha256 !== undefined
      && entry.evalDeliverySha256 !== undefined
      && entry.evalAttempt !== undefined
      && entry.evaluator !== "urn:jinn:benchmark-product:inspect-runtime:same-execution-scorer"
    )).toBe(true);
    expect(new Set(evaluationEntries.map((entry) => entry.evaluator)).size).toBe(expectedVerifiers);

    expect((await runReport(ctx, { draftId: preset })).ok).toBe(true);
    expect((await runVerify(ctx, { draftId: preset })).ok).toBe(true);
    const published = await runPublish(ctx, { draftId: preset, includeNativeArtifacts: true });
    expect(published.ok, JSON.stringify(published)).toBe(true);
    if (!published.ok) throw new Error("unreachable");
    const detachedRoot = mkdtempSync(join(tmpdir(), `benchmark-product-inspect-${preset}-bundle-`));
    workspaces.push(detachedRoot);
    const detachedBundle = join(detachedRoot, "bundle");
    cpSync(join(workspaceDir, published.result.bundleRelativePath), detachedBundle, { recursive: true });
    rmSync(workspaceDir, { recursive: true, force: true });
    const detached = await verifyPublicBundle(detachedBundle);
    expect(detached.runtimeMethod).toMatchObject({
      officialEvaluationRelationship: "separate-log-verifier",
      officialEvaluatorCount: expectedVerifiers,
    });
  }, 180_000);

  test("rejects source drift after lock before accepting any cell submission", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "benchmark-product-inspect-drift-"));
    const projectDir = mkdtempSync(join(tmpdir(), "benchmark-product-inspect-project-"));
    workspaces.push(workspaceDir, projectDir);
    cpSync(fixtureDir, projectDir, { recursive: true });
    const ctx = context(workspaceDir);
    expect(initWorkspace(ctx).ok).toBe(true);
    expect(createDraft(ctx, { draftId: "inspect-drift", name: "Inspect drift fixture" }).ok).toBe(true);
    expect((await selectInspectEvaluation(ctx, {
      draftId: "inspect-drift",
      pythonPath: pythonPath!,
      projectDir,
      taskReference: "hermetic_eval.py@hermetic_eval",
      arms: [
        { armId: "control", model: "mockllm/model" },
        { armId: "candidate", model: "mockllm/model" },
      ],
      scorer: { name: "match", passValue: "C" },
    })).ok).toBe(true);
    expect((await runQuote(ctx, { draftId: "inspect-drift" })).ok).toBe(true);
    expect(runLock(ctx, { draftId: "inspect-drift" }).ok).toBe(true);

    appendFileSync(join(projectDir, "hermetic_eval.py"), "\n# material drift after lock\n");
    const launched = await runLaunch(ctx, { draftId: "inspect-drift" });
    expect(launched.ok).toBe(false);
    if (!launched.ok) expect(launched.error.code).toBe("venue-unavailable");
    const journal = readRunJournalEntries(workspaceDir, "inspect-drift");
    expect(journal.some((entry) => entry.kind === "driver-failed")).toBe(true);
    expect(journal.some((entry) => entry.kind === "submission-accepted")).toBe(false);
  }, 120_000);

  test("returns a typed validation error before execution for credential-shaped sealed input", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "benchmark-product-inspect-secret-"));
    workspaces.push(workspaceDir);
    const ctx = context(workspaceDir);
    expect(initWorkspace(ctx).ok).toBe(true);
    expect(createDraft(ctx, { draftId: "inspect-secret", name: "Inspect secret fixture" }).ok).toBe(true);
    const selected = await selectInspectEvaluation(ctx, {
      draftId: "inspect-secret",
      pythonPath: pythonPath!,
      projectDir: fixtureDir,
      taskReference: "hermetic_eval.py@hermetic_eval",
      taskArgs: { api_key: "must-not-be-sealed" },
      arms: [
        { armId: "control", model: "mockllm/model" },
        { armId: "candidate", model: "mockllm/model" },
      ],
      scorer: { name: "match", passValue: "C" },
    });
    expect(selected.ok).toBe(false);
    if (!selected.ok) expect(selected.error.code).toBe("validation");
  });

  test("does not reflect arbitrary task import errors into operation or audit output", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "benchmark-product-inspect-redaction-"));
    const projectDir = mkdtempSync(join(tmpdir(), "benchmark-product-inspect-redaction-project-"));
    workspaces.push(workspaceDir, projectDir);
    const sentinel = "PRIVATE_PROVIDER_PAYLOAD_8f3b2c5d";
    writeFileSync(join(projectDir, "leaky_eval.py"), `raise RuntimeError(${JSON.stringify(sentinel)})\n`);
    const ctx = context(workspaceDir);
    expect(initWorkspace(ctx).ok).toBe(true);
    expect(createDraft(ctx, { draftId: "inspect-redaction", name: "Inspect redaction fixture" }).ok).toBe(true);
    const selected = await selectInspectEvaluation(ctx, {
      draftId: "inspect-redaction",
      pythonPath: pythonPath!,
      projectDir,
      taskReference: "leaky_eval.py@leaky_eval",
      arms: [
        { armId: "control", model: "mockllm/model" },
        { armId: "candidate", model: "mockllm/model" },
      ],
      scorer: { name: "match", passValue: "C" },
    });
    expect(selected.ok).toBe(false);
    expect(JSON.stringify({ selected, audit: readAuditEntries(workspaceDir) })).not.toContain(sentinel);
  }, 120_000);

  test("refuses duplicate resolved scorer names instead of relying on Inspect's private suffixing", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "benchmark-product-inspect-multiple-scorers-"));
    workspaces.push(workspaceDir);
    const ctx = context(workspaceDir);
    expect(initWorkspace(ctx).ok).toBe(true);
    expect(createDraft(ctx, { draftId: "inspect-multiple-scorers", name: "Inspect multiple scorers" }).ok).toBe(true);
    const selected = await selectInspectEvaluation(ctx, {
      draftId: "inspect-multiple-scorers",
      pythonPath: pythonPath!,
      projectDir: fixtureDir,
      taskReference: "hermetic_eval.py@duplicate_scorer_eval",
      arms: [
        { armId: "control", model: "mockllm/model" },
        { armId: "candidate", model: "mockllm/model" },
      ],
      scorer: { name: "match", passValue: "C" },
    });
    expect(selected.ok).toBe(false);
    if (!selected.ok) expect(selected.error.code).toBe("execution");
  }, 120_000);

  test("accounts for a real Inspect scorer failure in separate verifier legs without inventing a verdict", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "benchmark-product-inspect-scorer-failure-"));
    workspaces.push(workspaceDir);
    const ctx = context(workspaceDir);
    expect(initWorkspace(ctx).ok).toBe(true);
    expect(createDraft(ctx, { draftId: "inspect-scorer-failure", name: "Inspect scorer failure" }).ok).toBe(true);
    expect(updateDraft(ctx, {
      draftId: "inspect-scorer-failure",
      patch: { assurance: { preset: "separate-evaluator" } },
    }).ok).toBe(true);
    expect((await selectInspectEvaluation(ctx, {
      draftId: "inspect-scorer-failure",
      pythonPath: pythonPath!,
      projectDir: fixtureDir,
      taskReference: "hermetic_eval.py@multiple_scorer_failure_eval",
      arms: [
        { armId: "control", model: "mockllm/model" },
        { armId: "candidate", model: "mockllm/model" },
      ],
      scoring: {
        projections: [
          { measurementName: "correct", scorerName: "correctness_scorer", passValue: "C" },
          { measurementName: "scorer-ok", scorerName: "exploding_scorer", passValue: "C" },
        ],
        verdictRule: {
          all: [
            { threshold: { measurement: "correct", op: "eq", value: true } },
            { threshold: { measurement: "scorer-ok", op: "eq", value: true } },
          ],
        },
      },
      runOptions: { retryOnError: 1 },
    })).ok).toBe(true);
    expect((await runQuote(ctx, { draftId: "inspect-scorer-failure" })).ok).toBe(true);
    expect(runLock(ctx, { draftId: "inspect-scorer-failure" }).ok).toBe(true);
    expect((await runLaunch(ctx, { draftId: "inspect-scorer-failure" })).ok).toBe(true);
    const collected = await runCollect(ctx, { draftId: "inspect-scorer-failure" });
    expect(collected.ok, JSON.stringify(collected)).toBe(true);
    if (!collected.ok) throw new Error("unreachable");
    const matrix = parseMatrix(getSealedBytes(workspaceDir, collected.result.matrixSha256));
    expect(matrix.cells).toHaveLength(2);
    expect(matrix.cells.every((cell) => cell.outcome === "unscorable")).toBe(true);
    expect(matrix.cells.every((cell) => cell.verdicts.length === 0)).toBe(true);
    const failedVerifiers = readRunJournalEntries(workspaceDir, "inspect-scorer-failure")
      .filter((entry) => entry.kind === "evaluation");
    expect(failedVerifiers).toHaveLength(2);
    expect(failedVerifiers.every((entry) =>
      entry.evaluationTerminal === "could-not-grade"
      && entry.evalTaskSha256 !== undefined
      && entry.evaluator !== "urn:jinn:benchmark-product:inspect-runtime:same-execution-scorer"
    )).toBe(true);
  }, 120_000);

  test("honors Inspect maxSamples without multiplying or omitting benchmark cells", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "benchmark-product-inspect-incomplete-"));
    workspaces.push(workspaceDir);
    const ctx = context(workspaceDir);
    expect(initWorkspace(ctx).ok).toBe(true);
    expect(createDraft(ctx, { draftId: "inspect-incomplete", name: "Inspect incomplete samples" }).ok).toBe(true);
    expect((await selectInspectEvaluation(ctx, {
      draftId: "inspect-incomplete",
      pythonPath: pythonPath!,
      projectDir: fixtureDir,
      taskReference: "hermetic_eval.py@hermetic_eval",
      arms: [
        { armId: "control", model: "mockllm/model" },
        { armId: "candidate", model: "mockllm/model" },
      ],
      scorer: { name: "match", passValue: "C" },
      runOptions: { maxSamples: 1 },
    })).ok).toBe(true);
    expect((await runQuote(ctx, { draftId: "inspect-incomplete" })).ok).toBe(true);
    expect(runLock(ctx, { draftId: "inspect-incomplete" }).ok).toBe(true);
    expect((await runLaunch(ctx, { draftId: "inspect-incomplete" })).ok).toBe(true);
    const collected = await runCollect(ctx, { draftId: "inspect-incomplete" });
    expect(collected.ok, JSON.stringify(collected)).toBe(true);
    if (!collected.ok) throw new Error("unreachable");
    const matrix = parseMatrix(getSealedBytes(workspaceDir, collected.result.matrixSha256));
    expect(matrix.cells).toHaveLength(2);
    expect(matrix.cells.every((cell) => cell.outcome === "judged")).toBe(true);
    expect(matrix.cells.every((cell) => cell.verdicts.length === 1)).toBe(true);
    const legacyDelivery = readRunJournalEntries(workspaceDir, "inspect-incomplete")
      .find((entry) => entry.kind === "delivery");
    const legacySummary = legacyDelivery?.outputs.find((output) => output.name === "inspect-summary");
    if (legacySummary === undefined) throw new Error("missing legacy Inspect summary");
    expect(JSON.parse(new TextDecoder().decode(getSealedBytes(workspaceDir, legacySummary.sha256)))).toMatchObject({
      schema: "jinn.network/benchmark-product/inspect-cell-summary/1",
      scorer: "match",
    });
  }, 120_000);

  test("cancels the supervised Inspect worker and accounts for every expected cell", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "benchmark-product-inspect-cancel-"));
    workspaces.push(workspaceDir);
    const ctx = context(workspaceDir);
    expect(initWorkspace(ctx).ok).toBe(true);
    expect(createDraft(ctx, { draftId: "inspect-cancel", name: "Inspect cancellation" }).ok).toBe(true);
    expect((await selectInspectEvaluation(ctx, {
      draftId: "inspect-cancel",
      pythonPath: pythonPath!,
      projectDir: fixtureDir,
      taskReference: "hermetic_eval.py@hermetic_eval",
      arms: [
        { armId: "control", model: "mockllm/model" },
        { armId: "candidate", model: "mockllm/model" },
      ],
      scorer: { name: "match", passValue: "C" },
    })).ok).toBe(true);
    expect((await runQuote(ctx, { draftId: "inspect-cancel" })).ok).toBe(true);
    expect(runLock(ctx, { draftId: "inspect-cancel" }).ok).toBe(true);
    let requestedPromise: ReturnType<typeof runCancel> | undefined;
    const launched = await runLaunch(ctx, { draftId: "inspect-cancel" }, {
      onSolveAttemptNonterminal() {
        requestedPromise ??= runCancel(ctx, { draftId: "inspect-cancel" });
      },
    });
    expect(launched.ok, JSON.stringify(launched)).toBe(true);
    expect(requestedPromise).toBeDefined();
    if (requestedPromise === undefined) throw new Error("unreachable");
    const requested = await requestedPromise;
    expect(requested.ok, JSON.stringify(requested)).toBe(true);
    if (!requested.ok) throw new Error("unreachable");
    expect(requested.result.phase).toBe("requested");
    const cancelled = await runCancel(ctx, { draftId: "inspect-cancel" });
    expect(cancelled.ok, JSON.stringify(cancelled)).toBe(true);
    if (!cancelled.ok || cancelled.result.phase !== "cancelled") throw new Error("unreachable");
    const matrix = parseMatrix(getSealedBytes(workspaceDir, cancelled.result.matrixSha256));
    expect(matrix.completeness).toMatchObject({ expected: 2, judged: 0, runOutcome: "cancelled" });
    expect(matrix.cells).toHaveLength(2);
  }, 120_000);

  test("runs multiple native scorers across two arms and preserves their projected evidence through detached verification", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "benchmark-product-inspect-"));
    workspaces.push(workspaceDir);
    const ctx = context(workspaceDir);
    expect(initWorkspace(ctx).ok).toBe(true);
    expect(createDraft(ctx, { draftId: "inspect-real", name: "Inspect real fixture" }).ok).toBe(true);
    expect(updateDraft(ctx, { draftId: "inspect-real", patch: { replicates: 2 } }).ok).toBe(true);

    const selected = await selectInspectEvaluation(ctx, {
      draftId: "inspect-real",
      pythonPath: pythonPath!,
      projectDir: fixtureDir,
      taskReference: "hermetic_eval.py@multiple_scorer_eval",
      arms: [
        { armId: "control", model: "mockllm/model" },
        { armId: "candidate", model: "mockllm/model" },
      ],
      scoring: {
        projections: [
          { measurementName: "correct", scorerName: "correctness_scorer", passValue: "C" },
          { measurementName: "safe", scorerName: "policy_scorer", subScoreKey: "safe", passValue: true },
        ],
        verdictRule: {
          all: [
            { threshold: { measurement: "correct", op: "eq", value: true } },
            { threshold: { measurement: "safe", op: "eq", value: true } },
          ],
        },
      },
    });
    expect(selected.ok, JSON.stringify(selected)).toBe(true);
    if (!selected.ok) throw new Error("unreachable");
    expect(selected.result.runtimeMethod).toMatchObject({
      scorerNames: ["correctness_scorer", "policy_scorer"],
      projections: [
        { measurementName: "correct", scorerName: "correctness_scorer" },
        { measurementName: "safe", scorerName: "policy_scorer", subScoreKey: "safe" },
      ],
      verdictRuleText: "all(correct eq true, safe eq true)",
      evaluatorRelationship: "same-execution-scorer",
    });
    const previewed = await runPreview(ctx, { draftId: "inspect-real", items: 1 });
    expect(previewed.ok, JSON.stringify(previewed)).toBe(true);
    if (!previewed.ok) throw new Error("unreachable");
    expect(previewed.result.preview.arms.every((arm) => arm.outcomes.delivered === 2)).toBe(true);
    expect(previewed.result.runtimeMethod).toEqual(selected.result.runtimeMethod);
    const quoted = await runQuote(ctx, { draftId: "inspect-real" });
    expect(quoted.ok, JSON.stringify(quoted)).toBe(true);
    const locked = runLock(ctx, { draftId: "inspect-real" });
    expect(locked.ok).toBe(true);
    if (!locked.ok) throw new Error("unreachable");
    expect(locked.result.runtimeMethod).toEqual(selected.result.runtimeMethod);
    expect((await runLaunch(ctx, { draftId: "inspect-real" })).ok).toBe(true);

    const collected = await runCollect(ctx, { draftId: "inspect-real" });
    expect(collected.ok).toBe(true);
    if (!collected.ok) throw new Error("unreachable");
    const matrix = parseMatrix(getSealedBytes(workspaceDir, collected.result.matrixSha256));
    expect(matrix.cells).toHaveLength(4);
    expect(matrix.cells.every((cell) => cell.verification.isolation === "match")).toBe(true);
    expect(
      matrix.cells.every((cell) => cell.verdicts.length === 1),
      JSON.stringify({ matrix, journal: readRunJournalEntries(workspaceDir, "inspect-real") }),
    ).toBe(true);

    const results = runResults(ctx, { draftId: "inspect-real" });
    expect(results.ok).toBe(true);
    if (!results.ok) throw new Error("unreachable");
    expect(results.result.runtimeMethod).toEqual(selected.result.runtimeMethod);

    const deliveries = readRunJournalEntries(workspaceDir, "inspect-real")
      .filter((entry) => entry.kind === "delivery");
    expect(deliveries).toHaveLength(4);
    for (const delivery of deliveries) {
      expect(delivery.outputs.map((output) => output.name).sort()).toEqual([
        "inspect-log",
        "inspect-summary",
        "verdict",
      ]);
      for (const output of delivery.outputs) expect(getSealedBytes(workspaceDir, output.sha256).length).toBeGreaterThan(0);
      const summaryOutput = delivery.outputs.find((output) => output.name === "inspect-summary");
      if (summaryOutput === undefined) throw new Error("missing Inspect summary");
      const summary = JSON.parse(new TextDecoder().decode(getSealedBytes(workspaceDir, summaryOutput.sha256))) as {
        schema: string;
        scorers: Array<{ name: string }>;
        measurements: Array<{ measurementName: string; value: boolean }>;
        verdict: string;
      };
      expect(summary).toMatchObject({
        schema: "jinn.network/benchmark-product/inspect-cell-summary/2",
        scorers: [{ name: "correctness_scorer" }, { name: "policy_scorer" }],
        measurements: [
          { measurementName: "correct", value: true },
          { measurementName: "safe", value: true },
        ],
        verdict: "pass",
      });
    }

    const verifiedDelivery = deliveries[0]!;
    const nativeLogOutput = verifiedDelivery.outputs.find((output) => output.name === "inspect-log")!;
    const summaryOutput = verifiedDelivery.outputs.find((output) => output.name === "inspect-summary")!;
    const manifest = readInspectSelectionManifest(workspaceDir, selected.result.selectionManifestSha256);
    const registration = createInspectLogVerifierRegistration({
      registrationId: "inspect-log-verifier-proof",
      evaluatorId: "did:key:inspect-log-verifier-proof",
      signerHandle: "inspect-log-verifier-proof.pem",
      evaluationMethod: {
        name: "benchmark-product-inspect-log-verifier",
        digest: { sha256: manifest.runtime.workerSha256 },
      },
      manifest,
      selectionManifestSha256: selected.result.selectionManifestSha256,
      workerPath: inspectWorkerPath(),
      ociRunnerPath: inspectOciRunnerPath(),
      host: { kind: "local-python", pythonPath: pythonPath! },
    });
    const separatelyVerified = await registration.adapter.evaluate(
      {
        descriptor: { name: "evaluation-task", digest: { sha256: "0".repeat(64) } },
        bytes: new Uint8Array(),
      },
      [
        {
          descriptor: {
            name: "inspect-log",
            digest: { sha256: nativeLogOutput.sha256 },
            mediaType: "application/vnd.inspect-ai.eval",
          },
          bytes: getSealedBytes(workspaceDir, nativeLogOutput.sha256),
        },
        {
          descriptor: {
            name: "inspect-summary",
            digest: { sha256: summaryOutput.sha256 },
            mediaType: "application/vnd.jinn.inspect-summary+json",
          },
          bytes: getSealedBytes(workspaceDir, summaryOutput.sha256),
        },
      ],
      parseEvaluationSpec(getSealedBytes(workspaceDir, selected.result.evaluationSpecSha256)),
      {},
      { attemptUri: "urn:jinn:attempt:inspect-log-verifier-proof" } as never,
      new AbortController().signal,
    );
    expect(separatelyVerified).toMatchObject({
      verdict: "pass",
      measurements: [
        { name: "correct", value: true },
        { name: "safe", value: true },
      ],
      detailedOutcome: {
        relationship: "separate-log-verifier",
        scoreSource: "same-execution-scorer",
      },
    });
    expect(separatelyVerified.limitations).toContain("not-independent-rescoring");

    const alteredSummary = JSON.parse(
      new TextDecoder().decode(getSealedBytes(workspaceDir, summaryOutput.sha256)),
    ) as { measurements: Array<{ value: boolean }> };
    alteredSummary.measurements[0]!.value = false;
    const alteredSummaryBytes = new TextEncoder().encode(JSON.stringify(alteredSummary));
    await expect(registration.adapter.evaluate(
      {
        descriptor: { name: "evaluation-task", digest: { sha256: "0".repeat(64) } },
        bytes: new Uint8Array(),
      },
      [
        {
          descriptor: {
            name: "inspect-log",
            digest: { sha256: nativeLogOutput.sha256 },
            mediaType: "application/vnd.inspect-ai.eval",
          },
          bytes: getSealedBytes(workspaceDir, nativeLogOutput.sha256),
        },
        {
          descriptor: {
            name: "inspect-summary",
            digest: { sha256: sha256Hex(alteredSummaryBytes) },
            mediaType: "application/vnd.jinn.inspect-summary+json",
          },
          bytes: alteredSummaryBytes,
        },
      ],
      parseEvaluationSpec(getSealedBytes(workspaceDir, selected.result.evaluationSpecSha256)),
      {},
      { attemptUri: "urn:jinn:attempt:inspect-log-verifier-tamper-proof" } as never,
      new AbortController().signal,
    )).rejects.toThrow(/projection/u);

    const reported = await runReport(ctx, { draftId: "inspect-real" });
    expect(reported.ok).toBe(true);
    if (!reported.ok) throw new Error("unreachable");
    expect(reported.result.runtimeMethod).toEqual(selected.result.runtimeMethod);
    const verified = await runVerify(ctx, { draftId: "inspect-real" });
    expect(verified.ok && verified.result.checks).toEqual([
      "matrix-rederivation",
      "report-verification",
      "claim-consistency",
    ]);
    if (!verified.ok) throw new Error("unreachable");
    expect(verified.result.runtimeMethod).toEqual(selected.result.runtimeMethod);

    const refusedPublish = await runPublish(ctx, { draftId: "inspect-real" });
    expect(refusedPublish.ok).toBe(false);
    if (!refusedPublish.ok) expect(refusedPublish.error.code).toBe("validation");
    const published = await runPublish(ctx, {
      draftId: "inspect-real",
      includeNativeArtifacts: true,
    });
    expect(published.ok, JSON.stringify(published)).toBe(true);
    if (!published.ok) throw new Error("unreachable");

    const detachedRoot = mkdtempSync(join(tmpdir(), "benchmark-product-inspect-bundle-"));
    workspaces.push(detachedRoot);
    const detachedBundle = join(detachedRoot, "bundle");
    cpSync(join(workspaceDir, published.result.bundleRelativePath), detachedBundle, { recursive: true });
    rmSync(workspaceDir, { recursive: true, force: true });
    const detachedVerification = await verifyPublicBundle(detachedBundle);
    expect(detachedVerification.checks).toEqual([
      "manifest",
      "evidence-closure",
      "trust",
      "matrix-rederivation",
      "report-verification",
      "claim-consistency",
    ]);
    expect(detachedVerification.runtimeMethod).toEqual(selected.result.runtimeMethod);
    const nativeLogs = readdirSync(join(detachedBundle, "native", "inspect"))
      .map((name) => join(detachedBundle, "native", "inspect", name));
    expect(nativeLogs).toHaveLength(4);
    for (const logPath of nativeLogs) {
      const officialRead = spawnSync(
        pythonPath!,
        ["-c", "from inspect_ai.log import read_eval_log; import sys; assert read_eval_log(sys.argv[1]).status == 'success'", logPath],
        { encoding: "utf8" },
      );
      expect(officialRead.status, officialRead.stderr).toBe(0);
    }
    const viewerBundleDir = join(detachedRoot, "inspect-view-bundle");
    const officialViewer = spawnSync(
      join(dirname(pythonPath!), "inspect"),
      ["view", "bundle", "--log-dir", join(detachedBundle, "native", "inspect"), "--output-dir", viewerBundleDir],
      { encoding: "utf8" },
    );
    expect(officialViewer.status, officialViewer.stderr).toBe(0);
    expect(readdirSync(viewerBundleDir).length).toBeGreaterThan(0);
    rmSync(nativeLogs[0]!);
    await expect(verifyPublicBundle(detachedBundle)).rejects.toThrow();
  }, 120_000);
});
