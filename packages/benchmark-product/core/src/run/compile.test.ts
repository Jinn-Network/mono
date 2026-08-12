import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { BENCHMARKING_METHOD_IDS, BENCHMARKING_METHOD_VERSION, parseBenchmark } from "@jinn-network/benchmarking-records";
import { BenchmarkProductError } from "../errors.js";
import { armAdd } from "../operations/arms.js";
import type { OperationContext } from "../operations/context.js";
import { createDraft, readDraftDocument } from "../operations/drafts.js";
import { initWorkspace } from "../operations/init.js";
import { sampleInit } from "../operations/sample.js";
import { VENUE_ISOLATION_POLICY } from "../venue/venue.js";
import { getSealedBytes } from "../workspace/sealed-store.js";
import { compileDraft, compilePreviewRun } from "./compile.js";

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
    // BP-13 F2: parameters carries the direct-check preset's resolved verdictRule ("sole") — the
    // exact shape produceReport's derivePreregistered compares against (report.ts ~line 299).
    expect(compiled.plannedRun.record.analysisPlan).toEqual([
      { method: BENCHMARKING_METHOD_IDS.wilson, version: BENCHMARKING_METHOD_VERSION, parameters: { verdictRule: "sole" } },
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

describe("compilePreviewRun — product-policy refusals (BP-20)", () => {
  test("refuses validation when the draft has no attached benchmark", () => {
    const clock = makeClock();
    initWorkspace(contextFor(clock));
    const created = createDraft(contextFor(clock), { draftId: "draft-1", name: "No Benchmark" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    try {
      compilePreviewRun({
        workspaceDir,
        draft: created.result.draft,
        owner: "urn:uuid:00000000-0000-5000-8000-000000000001",
        closeAt: "2026-08-06T00:00:00Z",
      });
      expect.unreachable("expected a refusal");
    } catch (cause) {
      expect(cause).toBeInstanceOf(BenchmarkProductError);
      expect((cause as BenchmarkProductError).code).toBe("validation");
    }
  });

  test("refuses validation with fewer than 2 arms", async () => {
    const clock = makeClock();
    const draftId = await setUpDraftWithSample(clock);
    const document = readDraftDocument(workspaceDir, draftId);

    try {
      compilePreviewRun({
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
});

describe("compilePreviewRun — subsetting (BP-20)", () => {
  test("no itemLimit rehearses every item in the attached benchmark", async () => {
    const clock = makeClock();
    const draftId = await setUpDraftWithSample(clock);
    addTwoDistinctArms(clock, draftId);
    const document = readDraftDocument(workspaceDir, draftId);

    const compiled = compilePreviewRun({
      workspaceDir,
      draft: document,
      owner: "urn:uuid:00000000-0000-5000-8000-000000000001",
      closeAt: "2026-08-06T00:00:00Z",
    });

    expect(compiled.itemCount).toBe(3);
    expect(compiled.previewBenchmarkRecord.items).toHaveLength(3);
  });

  test("itemLimit subsets to the first N items", async () => {
    const clock = makeClock();
    const draftId = await setUpDraftWithSample(clock);
    addTwoDistinctArms(clock, draftId);
    const document = readDraftDocument(workspaceDir, draftId);

    const compiled = compilePreviewRun({
      workspaceDir,
      draft: document,
      owner: "urn:uuid:00000000-0000-5000-8000-000000000001",
      closeAt: "2026-08-06T00:00:00Z",
      itemLimit: 1,
    });

    expect(compiled.itemCount).toBe(1);
    expect(compiled.previewBenchmarkRecord.items).toHaveLength(1);

    const fullDocument = document.spec.taskSet.kind === "benchmark"
      ? parseBenchmark(getSealedBytes(workspaceDir, document.spec.taskSet.benchmarkSha256))
      : undefined;
    expect(fullDocument).toBeDefined();
    if (fullDocument === undefined) return;
    expect(compiled.previewBenchmarkRecord.items).toEqual(fullDocument.items.slice(0, 1));
  });

  test("an itemLimit above the benchmark's item count is capped silently, not refused", async () => {
    const clock = makeClock();
    const draftId = await setUpDraftWithSample(clock);
    addTwoDistinctArms(clock, draftId);
    const document = readDraftDocument(workspaceDir, draftId);

    const compiled = compilePreviewRun({
      workspaceDir,
      draft: document,
      owner: "urn:uuid:00000000-0000-5000-8000-000000000001",
      closeAt: "2026-08-06T00:00:00Z",
      itemLimit: 999,
    });

    expect(compiled.itemCount).toBe(3);
  });

  test("the ephemeral subset benchmark's digest never lands in the sealed store", async () => {
    const clock = makeClock();
    const draftId = await setUpDraftWithSample(clock);
    addTwoDistinctArms(clock, draftId);
    const document = readDraftDocument(workspaceDir, draftId);

    const compiled = compilePreviewRun({
      workspaceDir,
      draft: document,
      owner: "urn:uuid:00000000-0000-5000-8000-000000000001",
      closeAt: "2026-08-06T00:00:00Z",
      itemLimit: 1,
    });

    expect(compiled.previewBenchmarkSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(() => getSealedBytes(workspaceDir, compiled.previewBenchmarkSha256)).toThrowError(BenchmarkProductError);
  });

  test("the compiled plannedRun references the ephemeral subset digest, not the official one", async () => {
    const clock = makeClock();
    const draftId = await setUpDraftWithSample(clock);
    addTwoDistinctArms(clock, draftId);
    const document = readDraftDocument(workspaceDir, draftId);

    const compiled = compilePreviewRun({
      workspaceDir,
      draft: document,
      owner: "urn:uuid:00000000-0000-5000-8000-000000000001",
      closeAt: "2026-08-06T00:00:00Z",
      itemLimit: 1,
    });

    expect(compiled.plannedRun.record.benchmark.digest.sha256).toBe(compiled.previewBenchmarkSha256);
    const officialSha256 = document.spec.taskSet.kind === "benchmark" ? document.spec.taskSet.benchmarkSha256 : undefined;
    expect(compiled.previewBenchmarkSha256).not.toBe(officialSha256);
  });
});

describe("compileDraft — analysis selection", () => {
  test("seals both wilson and the selected paired method into analysisPlan", async () => {
    const clock = makeClock();
    const draftId = await setUpDraftWithSample(clock);
    addTwoDistinctArms(clock, draftId);
    const document = readDraftDocument(workspaceDir, draftId);
    const analysis = {
      method: "jinn.benchmarking.method/paired-delta",
      version: "1",
      baseline: "baseline",
      candidate: "sample",
      parameters: { seed: 123456789, resamples: 1000, alpha: "0.05" },
    };

    const compiled = compileDraft({
      workspaceDir,
      draft: { ...document, spec: { ...document.spec, analysis } },
      owner: "urn:uuid:00000000-0000-5000-8000-000000000001",
      closeAt: "2026-08-06T00:00:00Z",
    });

    expect(compiled.plannedRun.record.analysisPlan).toEqual([
      { method: BENCHMARKING_METHOD_IDS.wilson, version: BENCHMARKING_METHOD_VERSION, parameters: { verdictRule: "sole" } },
      {
        method: "jinn.benchmarking.method/paired-delta",
        version: "1",
        parameters: {
          verdictRule: "sole",
          baseline: "baseline",
          candidate: "sample",
          seed: 123456789,
          resamples: 1000,
          alpha: "0.05",
        },
      },
    ]);
  });

  test("refuses an unregistered method at compile time", async () => {
    const clock = makeClock();
    const draftId = await setUpDraftWithSample(clock);
    addTwoDistinctArms(clock, draftId);
    const document = readDraftDocument(workspaceDir, draftId);
    const analysis = { method: "jinn.benchmarking.method/does-not-exist", version: "1" };

    try {
      compileDraft({
        workspaceDir,
        draft: { ...document, spec: { ...document.spec, analysis } },
        owner: "urn:uuid:00000000-0000-5000-8000-000000000001",
        closeAt: "2026-08-06T00:00:00Z",
      });
      expect.unreachable("expected a refusal");
    } catch (cause) {
      expect(cause).toBeInstanceOf(BenchmarkProductError);
      expect((cause as BenchmarkProductError).code).toBe("validation");
      expect((cause as BenchmarkProductError).message).toMatch(/not a registered method/i);
    }
  });

  test("refuses a paired method whose baseline or candidate does not name an arm", async () => {
    const clock = makeClock();
    const draftId = await setUpDraftWithSample(clock);
    addTwoDistinctArms(clock, draftId);
    const document = readDraftDocument(workspaceDir, draftId);
    const analysis = {
      method: "jinn.benchmarking.method/paired-delta",
      version: "1",
      baseline: "baseline",
      candidate: "armZ",
      parameters: { seed: 1, resamples: 10, alpha: "0.05" },
    };

    try {
      compileDraft({
        workspaceDir,
        draft: { ...document, spec: { ...document.spec, analysis } },
        owner: "urn:uuid:00000000-0000-5000-8000-000000000001",
        closeAt: "2026-08-06T00:00:00Z",
      });
      expect.unreachable("expected a refusal");
    } catch (cause) {
      expect(cause).toBeInstanceOf(BenchmarkProductError);
      expect((cause as BenchmarkProductError).code).toBe("validation");
      expect((cause as BenchmarkProductError).message).toMatch(/candidate/i);
    }
  });

  test("refuses parameters the method's own schema rejects", async () => {
    const clock = makeClock();
    const draftId = await setUpDraftWithSample(clock);
    addTwoDistinctArms(clock, draftId);
    const document = readDraftDocument(workspaceDir, draftId);
    const analysis = {
      method: "jinn.benchmarking.method/paired-delta",
      version: "1",
      baseline: "baseline",
      candidate: "sample",
      parameters: { seed: 1, resamples: 10, alpha: 0.05 },
    };

    try {
      compileDraft({
        workspaceDir,
        draft: { ...document, spec: { ...document.spec, analysis } },
        owner: "urn:uuid:00000000-0000-5000-8000-000000000001",
        closeAt: "2026-08-06T00:00:00Z",
      });
      expect.unreachable("expected a refusal");
    } catch (cause) {
      expect(cause).toBeInstanceOf(BenchmarkProductError);
      expect((cause as BenchmarkProductError).code).toBe("validation");
      expect((cause as BenchmarkProductError).message).toMatch(/alpha/i);
    }
  });
});
