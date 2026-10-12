import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  BENCHMARKING_METHOD_IDS,
  BENCHMARKING_METHOD_VERSION,
  BENCHMARKING_PROTOCOL,
  itemTaskDigest,
  parseBenchmark,
  sealBenchmark,
} from "@jinn-network/benchmarking-records";
import { sealTask } from "@jinn-network/task-execution-protocol";
import type { DraftDocument } from "../domain/draft.js";
import { BenchmarkProductError } from "../errors.js";
import { buildTerminalBench21Tasks } from "../intake/terminal-bench-2-1.js";
import { armAdd } from "../operations/arms.js";
import { attachBenchmarkToDraft } from "../operations/attach.js";
import type { OperationContext } from "../operations/context.js";
import { createDraft, readDraftDocument } from "../operations/drafts.js";
import { initWorkspace } from "../operations/init.js";
import { sampleInit } from "../operations/sample.js";
import { VENUE_ISOLATION_POLICY } from "../venue/venue.js";
import { getSealedBytes, putSealedBytes } from "../workspace/sealed-store.js";
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

  test("seals one infrastructure retry only when the draft explicitly opts in", async () => {
    const clock = makeClock();
    const draftId = await setUpDraftWithSample(clock);
    addTwoDistinctArms(clock, draftId);
    const document = readDraftDocument(workspaceDir, draftId);
    const compiled = compileDraft({
      workspaceDir,
      draft: {
        ...document,
        spec: {
          ...document.spec,
          assurance: { preset: "direct-check", overrides: { maxInfrastructureRetries: 1 } },
        },
      },
      owner: "urn:uuid:00000000-0000-5000-8000-000000000001",
      closeAt: "2026-08-06T00:00:00Z",
    });
    expect(compiled.plannedRun.record.policy.evaluation).toEqual({
      minVerdicts: 1,
      distinctEvaluator: false,
      maxInfrastructureRetries: 1,
    });
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

  // Each override value below is one that `validateParameters` would ACCEPT on its own, so the
  // reserved-key guard is the only thing that can refuse it. That matters: an earlier version of
  // this test used "override-attempt" for every key, which `verdictRule`'s enum rejects downstream
  // anyway (registry.ts's VERDICT_RULE_PROPERTY) — that row passed with the guard removed and so
  // proved nothing. "unanimous" is a VALID rule that merely conflicts with this draft's resolved
  // "sole", which is exactly the override that would otherwise detonate at report time.
  test.each([
    ["verdictRule", "unanimous"],
    ["baseline", "not-an-arm"],
    ["candidate", "not-an-arm"],
  ] as const)(
    "refuses analysis.parameters carrying the reserved key %s (it would silently override a validated value)",
    async (reservedKey, overrideValue) => {
      const clock = makeClock();
      const draftId = await setUpDraftWithSample(clock);
      addTwoDistinctArms(clock, draftId);
      const document = readDraftDocument(workspaceDir, draftId);
      const analysis = {
        method: "jinn.benchmarking.method/paired-delta",
        version: "1",
        baseline: "baseline",
        candidate: "sample",
        parameters: { seed: 1, resamples: 10, alpha: "0.05", [reservedKey]: overrideValue },
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
        const error = cause as BenchmarkProductError;
        expect(error.code).toBe("validation");
        // `buildAnalysisPlan` is invoked as an argument expression inside `planFromSpec`'s
        // planRun try/catch (compile.ts), so its own `refuse(..., "spec.analysis.parameters", ...)`
        // path is caught and re-wrapped under the generic "spec" path — the message is preserved
        // verbatim, which is what every other buildAnalysisPlan-refusal test in this file already
        // asserts on rather than the wrapped path.
        //
        // Match the reserved-key refusal specifically rather than merely containing the key name:
        // the refusal's own tail names all three keys, so `toContain(reservedKey)` would be
        // satisfied by any of them — and by unrelated validation errors that happen to mention it.
        expect(error.message).toMatch(
          new RegExp(`may not set reserved key\\(s\\)[^—]*\\b${reservedKey}\\b`),
        );
      }
    },
  );
});

describe("compileDraft — explicit wilson selection", () => {
  test("an explicit wilson selection matching the registered version and carrying no parameters succeeds like the default", async () => {
    const clock = makeClock();
    const draftId = await setUpDraftWithSample(clock);
    addTwoDistinctArms(clock, draftId);
    const document = readDraftDocument(workspaceDir, draftId);
    const analysis = { method: BENCHMARKING_METHOD_IDS.wilson, version: BENCHMARKING_METHOD_VERSION };

    const compiled = compileDraft({
      workspaceDir,
      draft: { ...document, spec: { ...document.spec, analysis } },
      owner: "urn:uuid:00000000-0000-5000-8000-000000000001",
      closeAt: "2026-08-06T00:00:00Z",
    });

    expect(compiled.plannedRun.record.analysisPlan).toEqual([
      { method: BENCHMARKING_METHOD_IDS.wilson, version: BENCHMARKING_METHOD_VERSION, parameters: { verdictRule: "sole" } },
    ]);
  });

  test("refuses an explicit wilson selection whose version does not match the registry's current version", async () => {
    const clock = makeClock();
    const draftId = await setUpDraftWithSample(clock);
    addTwoDistinctArms(clock, draftId);
    const document = readDraftDocument(workspaceDir, draftId);
    const analysis = { method: BENCHMARKING_METHOD_IDS.wilson, version: "99" };

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
      const error = cause as BenchmarkProductError;
      expect(error.code).toBe("validation");
      // See the reserved-key test above: buildAnalysisPlan's own path is wrapped to "spec" by
      // planFromSpec's catch; the message is what carries the detail.
      expect(error.message).toMatch(/version/i);
    }
  });

  test("refuses an explicit wilson selection carrying a non-empty parameters object", async () => {
    const clock = makeClock();
    const draftId = await setUpDraftWithSample(clock);
    addTwoDistinctArms(clock, draftId);
    const document = readDraftDocument(workspaceDir, draftId);
    const analysis = { method: BENCHMARKING_METHOD_IDS.wilson, version: BENCHMARKING_METHOD_VERSION, parameters: { seed: 1 } };

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
      const error = cause as BenchmarkProductError;
      expect(error.code).toBe("validation");
      // See the reserved-key test above: buildAnalysisPlan's own path is wrapped to "spec" by
      // planFromSpec's catch; the message is what carries the detail.
      expect(error.message).toMatch(/parameters/i);
    }
  });

  test("a draft with no analysis block at all stays on the silent backward-compatible default", async () => {
    const clock = makeClock();
    const draftId = await setUpDraftWithSample(clock);
    addTwoDistinctArms(clock, draftId);
    const document = readDraftDocument(workspaceDir, draftId);
    expect(document.spec.analysis).toBeUndefined();

    const compiled = compileDraft({
      workspaceDir,
      draft: document,
      owner: "urn:uuid:00000000-0000-5000-8000-000000000001",
      closeAt: "2026-08-06T00:00:00Z",
    });

    expect(compiled.plannedRun.record.analysisPlan).toEqual([
      { method: BENCHMARKING_METHOD_IDS.wilson, version: BENCHMARKING_METHOD_VERSION, parameters: { verdictRule: "sole" } },
    ]);
  });
});

const OWNER = "urn:uuid:00000000-0000-5000-8000-000000000001";
const CLOSE_AT = "2026-08-06T00:00:00Z";

/** The first refusal of `compileDraft` and of `compilePreviewRun` over one draft. Both run the same
 * product-policy refusals, so every case below holds for `quote`, `lock`, and a preview alike. */
function refusalsOf(draft: DraftDocument): BenchmarkProductError[] {
  return [
    () => compileDraft({ workspaceDir, draft, owner: OWNER, closeAt: CLOSE_AT }),
    () => compilePreviewRun({ workspaceDir, draft, owner: `${OWNER}#preview`, closeAt: CLOSE_AT }),
  ].map((compile) => {
    try {
      compile();
    } catch (cause) {
      if (cause instanceof BenchmarkProductError) return cause;
      throw cause;
    }
    throw new Error("expected a refusal");
  });
}

/**
 * A Task that binds no EvaluationSpec has no verdict rule, so no result for it can be judged, and
 * every reader refuses a bundle that carries one. `quote`, `lock` and a preview therefore refuse
 * it before the run, for every benchmark and not only the official slate.
 */
describe("compileDraft and compilePreviewRun: an item Task must bind an EvaluationSpec that can be read", () => {
  /** The sample draft with its first item swapped for `replacement(sample Task document)`. */
  async function draftWithFirstTask(
    clock: () => string,
    replacement: (task: Record<string, unknown>) => Record<string, unknown>,
  ): Promise<{ readonly draft: DraftDocument; readonly taskSha256: string }> {
    const draftId = await setUpDraftWithSample(clock);
    addTwoDistinctArms(clock, draftId);
    const sample = readDraftDocument(workspaceDir, draftId);
    if (sample.spec.taskSet.kind !== "benchmark") throw new Error("unreachable");
    const benchmark = parseBenchmark(getSealedBytes(workspaceDir, sample.spec.taskSet.benchmarkSha256));
    const first = JSON.parse(new TextDecoder().decode(getSealedBytes(workspaceDir, itemTaskDigest(benchmark.items[0]!)))) as Record<string, unknown>;
    const taskSha256 = putSealedBytes(workspaceDir, sealTask(replacement(first)));
    const resealed = sealBenchmark({
      protocol: BENCHMARKING_PROTOCOL,
      name: benchmark.name,
      description: benchmark.description,
      version: benchmark.version,
      reveal: benchmark.reveal,
      items: [{ task: { digest: { sha256: taskSha256 } } }, ...benchmark.items.slice(1)],
    });
    const benchmarkSha256 = putSealedBytes(workspaceDir, resealed.bytes);
    // The compile functions take the draft document, so the edited task set is passed directly: a
    // draft's attached Benchmark cannot be replaced once set.
    return {
      draft: { ...sample, spec: { ...sample.spec, taskSet: { kind: "benchmark", benchmarkSha256 } } },
      taskSha256,
    };
  }

  test("a Task with no evaluation digest is refused, naming the Task and its item", async () => {
    const { draft, taskSha256 } = await draftWithFirstTask(makeClock(), ({ evaluation: _dropped, ...task }) => task);
    for (const refusal of refusalsOf(draft)) {
      expect(refusal.code).toBe("validation");
      expect(refusal.issues[0]?.path).toBe("spec.taskSet.items.0");
      expect(refusal.message).toBe(`Task ${taskSha256} binds no EvaluationSpec, so no result for it could be judged`);
    }
  });

  test("a Task whose spec bytes are not in the workspace is refused", async () => {
    const missing = "e".repeat(64);
    const { draft, taskSha256 } = await draftWithFirstTask(makeClock(), (task) => ({ ...task, evaluation: { digest: { sha256: missing } } }));
    for (const refusal of refusalsOf(draft)) {
      expect(refusal.code).toBe("validation");
      expect(refusal.issues[0]?.path).toBe("spec.taskSet.items.0");
      expect(refusal.message).toContain(`Task ${taskSha256} binds EvaluationSpec ${missing}, which cannot be read`);
    }
  });

  test("a Task whose bound bytes are not an EvaluationSpec is refused", async () => {
    const clock = makeClock();
    // Bytes that are stored and sealed, and are not a specification: another Task.
    let notASpec = "";
    const { draft } = await draftWithFirstTask(clock, (task) => {
      notASpec = putSealedBytes(workspaceDir, sealTask({ ...task, instructions: "not an EvaluationSpec" }));
      return { ...task, evaluation: { digest: { sha256: notASpec } } };
    });
    for (const refusal of refusalsOf(draft)) {
      expect(refusal.code).toBe("validation");
      expect(refusal.message).toContain(`binds EvaluationSpec ${notASpec}, which cannot be read`);
    }
  });

  test("the sample draft, whose Tasks all bind a spec, still compiles", async () => {
    const clock = makeClock();
    const draftId = await setUpDraftWithSample(clock);
    addTwoDistinctArms(clock, draftId);
    const draft = readDraftDocument(workspaceDir, draftId);
    expect(() => compileDraft({ workspaceDir, draft, owner: OWNER, closeAt: CLOSE_AT })).not.toThrow();
    expect(() => compilePreviewRun({ workspaceDir, draft, owner: `${OWNER}#preview`, closeAt: CLOSE_AT })).not.toThrow();
  });
});

/**
 * A run on the official Terminal-Bench 2.1 slate is reported with the per-arm pass rate only
 * (operator rulings of 2026-10-06). The official Tasks carry no task provenance, which the paired
 * methods read, and the sentence a brought slate run seals describes a per-arm rate. So another
 * analysis is refused before the Run is sealed.
 */
describe("compileDraft and compilePreviewRun: analyses on the official Terminal-Bench 2.1 slate", () => {
  /** A draft bound to the official ten-task slice the way `method terminal-bench-2.1` binds it. */
  function slateDraft(clock: () => string): DraftDocument {
    initWorkspace(contextFor(clock));
    createDraft(contextFor(clock), { draftId: "draft-1", name: "Official slate" });
    const built = buildTerminalBench21Tasks({ coverage: "ten_task" });
    putSealedBytes(workspaceDir, built.profile.bytes);
    for (const task of built.tasks) {
      putSealedBytes(workspaceDir, task.evaluationSpec.bytes);
      putSealedBytes(workspaceDir, task.bytes);
    }
    attachBenchmarkToDraft(workspaceDir, "draft-1", putSealedBytes(workspaceDir, built.benchmark.bytes), clock());
    armAdd(contextFor(clock), { draftId: "draft-1", armId: "oracle", pinning: { harness: { id: "harbor", version: "0.21.0" }, agent: { id: "oracle" } } });
    armAdd(contextFor(clock), { draftId: "draft-1", armId: "terminus-2", pinning: { harness: { id: "harbor", version: "0.21.0" }, agent: { id: "terminus-2" } } });
    return readDraftDocument(workspaceDir, "draft-1");
  }

  const PAIRED_DELTA = {
    method: BENCHMARKING_METHOD_IDS.pairedDelta,
    version: BENCHMARKING_METHOD_VERSION,
    baseline: "oracle",
    candidate: "terminus-2",
    parameters: { seed: 123456789, resamples: 1000, alpha: "0.05" },
  };

  test("with no analysis the slate draft compiles to the per-arm rate alone", () => {
    const draft = slateDraft(makeClock());
    const compiled = compileDraft({ workspaceDir, draft, owner: OWNER, closeAt: CLOSE_AT });
    expect(compiled.plannedRun.record.analysisPlan).toEqual([
      { method: BENCHMARKING_METHOD_IDS.wilson, version: BENCHMARKING_METHOD_VERSION, parameters: { verdictRule: "sole" } },
    ]);
    expect(() => compilePreviewRun({ workspaceDir, draft, owner: `${OWNER}#preview`, closeAt: CLOSE_AT, itemLimit: 2 })).not.toThrow();
  });

  test("a paired analysis is refused, saying the slate is reported with the per-arm rate only", () => {
    const draft = slateDraft(makeClock());
    for (const refusal of refusalsOf({ ...draft, spec: { ...draft.spec, analysis: PAIRED_DELTA } })) {
      expect(refusal.code).toBe("validation");
      expect(refusal.issues[0]?.path).toBe("spec.analysis");
      // The remedy is the explicit per-arm selection: `draft update` overwrites a field and cannot
      // remove one.
      expect(refusal.message).toBe(
        "this version reports a run on the official Terminal-Bench 2.1 slate with the per-arm pass rate only, "
        + `and this draft selects "${BENCHMARKING_METHOD_IDS.pairedDelta}"; set the draft's analysis to `
        + '"jinn.benchmarking.method/wilson" version "1", which is the per-arm rate',
      );
    }
  });

  test("an additional analysis is refused the same way, naming its entry", () => {
    const draft = slateDraft(makeClock());
    for (const refusal of refusalsOf({ ...draft, spec: { ...draft.spec, additionalAnalyses: [PAIRED_DELTA] } })) {
      expect(refusal.code).toBe("validation");
      expect(refusal.issues[0]?.path).toBe("spec.additionalAnalyses.0");
      expect(refusal.message).toBe(
        "this version reports a run on the official Terminal-Bench 2.1 slate with the per-arm pass rate only, "
        + `and this draft adds "${BENCHMARKING_METHOD_IDS.pairedDelta}"; a draft cannot drop an additional `
        + "analysis once it is set, so start a new draft without one",
      );
    }
  });

  test("a binary-instrument analysis is refused by this rule, before its own derivation runs", () => {
    const draft = slateDraft(makeClock());
    const analysis = { method: BENCHMARKING_METHOD_IDS.binaryInstrument, version: BENCHMARKING_METHOD_VERSION };
    for (const refusal of refusalsOf({ ...draft, spec: { ...draft.spec, analysis } })) {
      expect(refusal.issues[0]?.path).toBe("spec.analysis");
      expect(refusal.message).toContain("with the per-arm pass rate only");
    }
  });

  test("an explicit wilson selection is the per-arm rate itself, and seals the same plan", () => {
    const draft = slateDraft(makeClock());
    const analysis = { method: BENCHMARKING_METHOD_IDS.wilson, version: BENCHMARKING_METHOD_VERSION };
    const implicit = compileDraft({ workspaceDir, draft, owner: OWNER, closeAt: CLOSE_AT });
    const explicit = compileDraft({ workspaceDir, draft: { ...draft, spec: { ...draft.spec, analysis } }, owner: OWNER, closeAt: CLOSE_AT });
    expect(explicit.plannedRun.record.analysisPlan).toEqual(implicit.plannedRun.record.analysisPlan);
  });

  test("the same paired analysis on a benchmark that is not the official slate still compiles", async () => {
    const clock = makeClock();
    const draftId = await setUpDraftWithSample(clock, "draft-2");
    addTwoDistinctArms(clock, draftId);
    const draft = readDraftDocument(workspaceDir, draftId);
    const analysis = { ...PAIRED_DELTA, baseline: "baseline", candidate: "sample" };
    expect(() => compileDraft({ workspaceDir, draft: { ...draft, spec: { ...draft.spec, analysis } }, owner: OWNER, closeAt: CLOSE_AT }))
      .not.toThrow();
  });
});
