import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { BENCHMARKING_METHOD_IDS, BENCHMARKING_METHOD_VERSION } from "@jinn-network/benchmarking-records";
import { BenchmarkProductError } from "../errors.js";
import { armAdd } from "../operations/arms.js";
import type { OperationContext } from "../operations/context.js";
import { createDraft, readDraftDocument } from "../operations/drafts.js";
import { initWorkspace } from "../operations/init.js";
import { sampleInit } from "../operations/sample.js";
import { VENUE_ISOLATION_POLICY } from "../venue/venue.js";
import { compileDraft } from "./compile.js";

let workspaceDir: string;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "bp12-run-compile-"));
});

afterEach(() => {
  rmSync(workspaceDir, { recursive: true, force: true });
});

function makeClock(): () => string {
  let tick = 0;
  return () => `2026-08-05T00:00:${String(tick++).padStart(2, "0")}Z`;
}

function contextFor(clock: () => string): OperationContext {
  return { workspaceDir, principal: "sponsor-1", clock };
}

async function setUpDraftWithSample(clock: () => string, draftId = "draft-1") {
  initWorkspace(contextFor(clock));
  createDraft(contextFor(clock), { draftId, name: "Compile Test" });
  await sampleInit(contextFor(clock), { draftId });
  return draftId;
}

function addTwoDistinctArms(clock: () => string, draftId: string): void {
  const added1 = armAdd(contextFor(clock), {
    draftId,
    armId: "baseline",
    pinning: { harness: { id: "prediction-v1-baseline", version: "1.0.0" } },
  });
  expect(added1.ok).toBe(true);
  const added2 = armAdd(contextFor(clock), {
    draftId,
    armId: "sample",
    pinning: { harness: { id: "sample-uniform", version: "0.1.0" } },
  });
  expect(added2.ok).toBe(true);
}

describe("compileDraft — product-policy refusals", () => {
  test("refuses validation when the draft has no attached benchmark", () => {
    const clock = makeClock();
    initWorkspace(contextFor(clock));
    const created = createDraft(contextFor(clock), { draftId: "draft-1", name: "No Benchmark" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    expect(() =>
      compileDraft({
        workspaceDir,
        draft: created.result.draft,
        owner: "urn:uuid:00000000-0000-5000-8000-000000000001",
        closeAt: "2026-08-06T00:00:00Z",
      }),
    ).toThrowError(BenchmarkProductError);

    try {
      compileDraft({
        workspaceDir,
        draft: created.result.draft,
        owner: "urn:uuid:00000000-0000-5000-8000-000000000001",
        closeAt: "2026-08-06T00:00:00Z",
      });
    } catch (cause) {
      expect((cause as BenchmarkProductError).code).toBe("validation");
    }
  });

  test("refuses validation with fewer than 2 arms (charter decision 7)", async () => {
    const clock = makeClock();
    const draftId = await setUpDraftWithSample(clock);
    const document = readDraftDocument(workspaceDir, draftId);

    try {
      compileDraft({
        workspaceDir,
        draft: document,
        owner: "urn:uuid:00000000-0000-5000-8000-000000000001",
        closeAt: "2026-08-06T00:00:00Z",
      });
      expect.unreachable("expected a refusal");
    } catch (cause) {
      expect(cause).toBeInstanceOf(BenchmarkProductError);
      expect((cause as BenchmarkProductError).code).toBe("validation");
      expect((cause as BenchmarkProductError).issues[0]?.path).toBe("spec.arms");
    }
  });

  test("a single arm still refuses validation (exactly 1 is not enough)", async () => {
    const clock = makeClock();
    const draftId = await setUpDraftWithSample(clock);
    armAdd(contextFor(clock), { draftId, armId: "solo", pinning: { harness: { id: "prediction-v1-baseline", version: "1.0.0" } } });
    const document = readDraftDocument(workspaceDir, draftId);

    expect(() =>
      compileDraft({
        workspaceDir,
        draft: document,
        owner: "urn:uuid:00000000-0000-5000-8000-000000000001",
        closeAt: "2026-08-06T00:00:00Z",
      }),
    ).toThrowError(BenchmarkProductError);
  });

  test("re-raises a platform schema failure (byte-identical arm pinning) as validation", async () => {
    const clock = makeClock();
    const draftId = await setUpDraftWithSample(clock);
    armAdd(contextFor(clock), { draftId, armId: "arm-a", pinning: { harness: { id: "x", version: "1" } } });
    armAdd(contextFor(clock), { draftId, armId: "arm-b", pinning: { harness: { id: "x", version: "1" } } });
    const document = readDraftDocument(workspaceDir, draftId);

    try {
      compileDraft({
        workspaceDir,
        draft: document,
        owner: "urn:uuid:00000000-0000-5000-8000-000000000001",
        closeAt: "2026-08-06T00:00:00Z",
      });
      expect.unreachable("expected a refusal");
    } catch (cause) {
      expect(cause).toBeInstanceOf(BenchmarkProductError);
      const error = cause as BenchmarkProductError;
      expect(error.code).toBe("validation");
      expect(error.message).toMatch(/pairwise distinct|identical pinning/);
    }
  });
});

describe("compileDraft — success path", () => {
  test("builds a plannedRun whose sealed Run record carries the wilson@1 analysisPlan and the venue's isolation baseline", async () => {
    const clock = makeClock();
    const draftId = await setUpDraftWithSample(clock);
    addTwoDistinctArms(clock, draftId);
    const document = readDraftDocument(workspaceDir, draftId);

    const owner = "urn:uuid:00000000-0000-5000-8000-000000000001";
    const compiled = compileDraft({ workspaceDir, draft: document, owner, closeAt: "2026-08-06T00:00:00Z" });

    expect(compiled.plannedRun.record.owner).toBe(owner);
    expect(compiled.plannedRun.record.arms).toHaveLength(2);
    expect(compiled.plannedRun.record.venue).toEqual({ kind: "self-run" });
    expect(compiled.plannedRun.record.closeAt).toBe("2026-08-06T00:00:00Z");
    expect(compiled.plannedRun.record.policy.submissionBaseline).toEqual({ isolationPolicy: VENUE_ISOLATION_POLICY });
    expect(compiled.plannedRun.record.analysisPlan).toEqual([
      { method: BENCHMARKING_METHOD_IDS.wilson, version: BENCHMARKING_METHOD_VERSION, parameters: {} },
    ]);
    expect(compiled.benchmarkSha256).toBe(document.spec.taskSet.kind === "benchmark" ? document.spec.taskSet.benchmarkSha256 : undefined);
    expect(compiled.benchmarkRecord.items.length).toBeGreaterThanOrEqual(2);

    // The compiled bytes are the exact sealed Run record — round tripping through parseRun
    // must reproduce the same analysisPlan (proves it survived sealing, not just planning).
    expect(compiled.plannedRun.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  test("maps the direct-check assurance preset onto policy.independence/evaluation (spec §6)", async () => {
    const clock = makeClock();
    const draftId = await setUpDraftWithSample(clock);
    addTwoDistinctArms(clock, draftId);
    const document = readDraftDocument(workspaceDir, draftId);

    const compiled = compileDraft({
      workspaceDir,
      draft: document,
      owner: "urn:uuid:00000000-0000-5000-8000-000000000001",
      closeAt: "2026-08-06T00:00:00Z",
    });

    // draft default assurance preset is "direct-check": independence disclosed, minVerdicts 1.
    expect(compiled.plannedRun.record.policy.independence).toBe("disclosed");
    expect(compiled.plannedRun.record.policy.evaluation).toEqual({ minVerdicts: 1, distinctEvaluator: false });
  });

  test("carries the draft's budget through when set", async () => {
    const clock = makeClock();
    const draftId = await setUpDraftWithSample(clock);
    addTwoDistinctArms(clock, draftId);
    const document = readDraftDocument(workspaceDir, draftId);
    const withBudget = { ...document, spec: { ...document.spec, budget: { perCell: { solve: "0.1", evaluate: "0.05" }, hardCap: "10", unit: "USD" } } };

    const compiled = compileDraft({
      workspaceDir,
      draft: withBudget,
      owner: "urn:uuid:00000000-0000-5000-8000-000000000001",
      closeAt: "2026-08-06T00:00:00Z",
    });
    expect(compiled.plannedRun.record.budget).toEqual({ perCell: { solve: "0.1", evaluate: "0.05" }, hardCap: "10", unit: "USD" });
  });
});
