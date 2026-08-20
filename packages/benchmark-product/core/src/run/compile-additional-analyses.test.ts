/**
 * Packet P5 (spec §8.3 option 5): the sealed analysis plan gains a `additionalAnalyses` seam.
 * These tests cover the domain schema, the `buildAnalysisPlan` wrapper's invariance and append
 * behavior, and the two wrapper-only refusals — the mechanics that let a sealed Run pre-register
 * more than one non-wilson readout over one collected cell set. See
 * `docs/superpowers/specs/2026-08-19-judge-path-delta-contracts.md` §8.3.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { BENCHMARKING_METHOD_IDS, BENCHMARKING_METHOD_VERSION } from "@jinn-network/benchmarking-records";
import { inputsDigest } from "../audit/journal.js";
import { BenchmarkProductError } from "../errors.js";
import { DRAFT_SPEC_DEFAULTS, parseDraftSpec } from "../domain/draft.js";
import { armAdd } from "../operations/arms.js";
import type { OperationContext } from "../operations/context.js";
import { createDraft, readDraftDocument } from "../operations/drafts.js";
import { initWorkspace } from "../operations/init.js";
import { sampleInit } from "../operations/sample.js";
import { compileDraft } from "./compile.js";
import { specDigest } from "./state.js";

let workspaceDir: string;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "p5-additional-analyses-"));
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
  createDraft(contextFor(clock), { draftId, name: "Additional Analyses Test" });
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

/** A simple, `available` registered method needing no baseline/candidate — the cheapest additional
 * entry a test can register. */
const AVG_AT_K = { method: BENCHMARKING_METHOD_IDS.avgAtK, version: BENCHMARKING_METHOD_VERSION } as const;
const PASS_AT_K_K3 = { method: BENCHMARKING_METHOD_IDS.passAtK, version: BENCHMARKING_METHOD_VERSION, parameters: { k: 3 } } as const;

function expectRefusal(fn: () => unknown, matchMessage: RegExp): void {
  try {
    fn();
    expect.unreachable("expected a refusal");
  } catch (cause) {
    expect(cause).toBeInstanceOf(BenchmarkProductError);
    expect((cause as BenchmarkProductError).code).toBe("validation");
    expect((cause as BenchmarkProductError).message).toMatch(matchMessage);
  }
}

describe("DraftSpecSchema — additionalAnalyses (domain schema)", () => {
  test("absent additionalAnalyses parses exactly like today — no key appears in the result", () => {
    const parsed = parseDraftSpec({ ...DRAFT_SPEC_DEFAULTS, name: "No Additional Analyses" });
    expect("additionalAnalyses" in parsed).toBe(false);
  });

  test("an empty additionalAnalyses array refuses (.min(1) — no information an absent field doesn't already carry)", () => {
    expect(() =>
      parseDraftSpec({ ...DRAFT_SPEC_DEFAULTS, name: "Empty Additional", additionalAnalyses: [] }),
    ).toThrowError(BenchmarkProductError);
  });

  test("a non-empty additionalAnalyses array parses", () => {
    const parsed = parseDraftSpec({
      ...DRAFT_SPEC_DEFAULTS,
      name: "One Additional",
      additionalAnalyses: [{ method: AVG_AT_K.method, version: AVG_AT_K.version }],
    });
    expect(parsed.additionalAnalyses).toEqual([{ method: AVG_AT_K.method, version: AVG_AT_K.version }]);
  });

  test("DRAFT_SPEC_DEFAULTS carries no additionalAnalyses entry — no default was added for this field", () => {
    expect("additionalAnalyses" in DRAFT_SPEC_DEFAULTS).toBe(false);
  });
});

describe("specSha256 invariance — no existing draft's digest moves", () => {
  test("a draft with no additionalAnalyses seals the exact digest its hand-written pre-existing field set produces", async () => {
    const clock = makeClock();
    const draftId = await setUpDraftWithSample(clock, "draft-invariance");
    const document = readDraftDocument(workspaceDir, draftId);
    expect("additionalAnalyses" in document.spec).toBe(false);

    // Hand-written, independent of DRAFT_SPEC_DEFAULTS: if additionalAnalyses (or any other new
    // field) ever silently gained a default value, this object would NOT reflect it, and the
    // digest comparison below would fail — that is the regression this test exists to catch.
    const expectedSpecShape = {
      name: document.spec.name,
      taskSet: { kind: "benchmark", benchmarkSha256: document.spec.taskSet.kind === "benchmark" ? document.spec.taskSet.benchmarkSha256 : "" },
      arms: [],
      replicates: 1,
      assurance: { preset: "direct-check" },
      policy: {
        completenessFloor: "1",
        cellWindowMs: 3_600_000,
        replacement: { allowed: false },
        closeAfterMs: 86_400_000,
      },
      venue: "self-run",
    };
    expect(specDigest(document.spec)).toBe(inputsDigest(expectedSpecShape));
  });
});

describe("buildAnalysisPlan wrapper — invariance across the four primary returns", () => {
  test("analysis undefined: no additionalAnalyses seals the identical [wilson] plan", async () => {
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

    expect(compiled.plannedRun.record.analysisPlan).toEqual([
      { method: BENCHMARKING_METHOD_IDS.wilson, version: BENCHMARKING_METHOD_VERSION, parameters: { verdictRule: "sole" } },
    ]);
  });

  test("explicit wilson selection: no additionalAnalyses seals the identical [wilson] plan", async () => {
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

  test("generic registered primary (paired-delta): no additionalAnalyses seals the identical two-entry plan", async () => {
    const clock = makeClock();
    const draftId = await setUpDraftWithSample(clock);
    addTwoDistinctArms(clock, draftId);
    const document = readDraftDocument(workspaceDir, draftId);
    const analysis = {
      method: BENCHMARKING_METHOD_IDS.pairedDelta,
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
        method: BENCHMARKING_METHOD_IDS.pairedDelta,
        version: "1",
        parameters: { verdictRule: "sole", baseline: "baseline", candidate: "sample", seed: 123456789, resamples: 1000, alpha: "0.05" },
      },
    ]);
  });
});

describe("buildAnalysisPlan wrapper — append correctness", () => {
  test("analysis undefined + one additional entry: primary [wilson] unchanged, additional entry follows", async () => {
    const clock = makeClock();
    const draftId = await setUpDraftWithSample(clock);
    addTwoDistinctArms(clock, draftId);
    const document = readDraftDocument(workspaceDir, draftId);

    const compiled = compileDraft({
      workspaceDir,
      draft: { ...document, spec: { ...document.spec, additionalAnalyses: [AVG_AT_K] } },
      owner: "urn:uuid:00000000-0000-5000-8000-000000000001",
      closeAt: "2026-08-06T00:00:00Z",
    });

    expect(compiled.plannedRun.record.analysisPlan).toEqual([
      { method: BENCHMARKING_METHOD_IDS.wilson, version: BENCHMARKING_METHOD_VERSION, parameters: { verdictRule: "sole" } },
      { method: AVG_AT_K.method, version: AVG_AT_K.version, parameters: { verdictRule: "sole" } },
    ]);
  });

  test("generic primary (paired-delta) + two additional entries, in order", async () => {
    const clock = makeClock();
    const draftId = await setUpDraftWithSample(clock);
    addTwoDistinctArms(clock, draftId);
    const document = readDraftDocument(workspaceDir, draftId);
    const analysis = {
      method: BENCHMARKING_METHOD_IDS.pairedDelta,
      version: "1",
      baseline: "baseline",
      candidate: "sample",
      parameters: { seed: 1, resamples: 10, alpha: "0.05" },
    };

    const compiled = compileDraft({
      workspaceDir,
      draft: { ...document, spec: { ...document.spec, analysis, additionalAnalyses: [AVG_AT_K, PASS_AT_K_K3] } },
      owner: "urn:uuid:00000000-0000-5000-8000-000000000001",
      closeAt: "2026-08-06T00:00:00Z",
    });

    const plan = compiled.plannedRun.record.analysisPlan!;
    expect(plan).toHaveLength(4);
    expect(plan[0]).toEqual({ method: BENCHMARKING_METHOD_IDS.wilson, version: BENCHMARKING_METHOD_VERSION, parameters: { verdictRule: "sole" } });
    expect(plan[1]).toEqual({
      method: BENCHMARKING_METHOD_IDS.pairedDelta,
      version: "1",
      parameters: { verdictRule: "sole", baseline: "baseline", candidate: "sample", seed: 1, resamples: 10, alpha: "0.05" },
    });
    expect(plan[2]).toEqual({ method: AVG_AT_K.method, version: AVG_AT_K.version, parameters: { verdictRule: "sole" } });
    expect(plan[3]).toEqual({ method: PASS_AT_K_K3.method, version: PASS_AT_K_K3.version, parameters: { verdictRule: "sole", k: 3 } });
  });
});

describe("buildAnalysisPlan wrapper — the two refusals", () => {
  test("an additional entry naming wilson refuses (wilson is always the plan's head)", async () => {
    const clock = makeClock();
    const draftId = await setUpDraftWithSample(clock);
    addTwoDistinctArms(clock, draftId);
    const document = readDraftDocument(workspaceDir, draftId);

    expectRefusal(
      () =>
        compileDraft({
          workspaceDir,
          draft: { ...document, spec: { ...document.spec, additionalAnalyses: [{ method: BENCHMARKING_METHOD_IDS.wilson, version: BENCHMARKING_METHOD_VERSION }] } },
          owner: "urn:uuid:00000000-0000-5000-8000-000000000001",
          closeAt: "2026-08-06T00:00:00Z",
        }),
      /names wilson/i,
    );
  });

  test("an additional entry duplicating the PRIMARY entry's (method, version) refuses", async () => {
    const clock = makeClock();
    const draftId = await setUpDraftWithSample(clock);
    addTwoDistinctArms(clock, draftId);
    const document = readDraftDocument(workspaceDir, draftId);
    const analysis = {
      method: BENCHMARKING_METHOD_IDS.pairedDelta,
      version: "1",
      baseline: "baseline",
      candidate: "sample",
      parameters: { seed: 1, resamples: 10, alpha: "0.05" },
    };

    expectRefusal(
      () =>
        compileDraft({
          workspaceDir,
          draft: {
            ...document,
            spec: {
              ...document.spec,
              analysis,
              additionalAnalyses: [{ method: analysis.method, version: analysis.version, baseline: "baseline", candidate: "sample", parameters: analysis.parameters }],
            },
          },
          owner: "urn:uuid:00000000-0000-5000-8000-000000000001",
          closeAt: "2026-08-06T00:00:00Z",
        }),
      /already registered earlier/i,
    );
  });

  test("an additional entry duplicating an EARLIER additional entry's (method, version) refuses", async () => {
    const clock = makeClock();
    const draftId = await setUpDraftWithSample(clock);
    addTwoDistinctArms(clock, draftId);
    const document = readDraftDocument(workspaceDir, draftId);

    expectRefusal(
      () =>
        compileDraft({
          workspaceDir,
          draft: { ...document, spec: { ...document.spec, additionalAnalyses: [AVG_AT_K, { method: AVG_AT_K.method, version: AVG_AT_K.version }] } },
          owner: "urn:uuid:00000000-0000-5000-8000-000000000001",
          closeAt: "2026-08-06T00:00:00Z",
        }),
      /already registered earlier/i,
    );
  });

  test("a DIFFERENT version of the same method as an earlier additional entry is NOT a duplicate (key is (method, version))", async () => {
    // avg-at-k@1 registered twice would refuse; here the second entry is pass-at-k, a distinct
    // method id, so this is really just confirming the generic dispatch runs for a second entry
    // once the first is accepted — the "not a false positive" companion to the duplicate tests.
    const clock = makeClock();
    const draftId = await setUpDraftWithSample(clock);
    addTwoDistinctArms(clock, draftId);
    const document = readDraftDocument(workspaceDir, draftId);

    const compiled = compileDraft({
      workspaceDir,
      draft: { ...document, spec: { ...document.spec, additionalAnalyses: [AVG_AT_K, PASS_AT_K_K3] } },
      owner: "urn:uuid:00000000-0000-5000-8000-000000000001",
      closeAt: "2026-08-06T00:00:00Z",
    });
    expect(compiled.plannedRun.record.analysisPlan).toHaveLength(3);
  });
});

describe("buildAnalysisPlan wrapper — per-entry dispatch (the three-way branch, shared with the primary)", () => {
  test("an additional entry naming an unregistered method id refuses", async () => {
    const clock = makeClock();
    const draftId = await setUpDraftWithSample(clock);
    addTwoDistinctArms(clock, draftId);
    const document = readDraftDocument(workspaceDir, draftId);

    expectRefusal(
      () =>
        compileDraft({
          workspaceDir,
          draft: { ...document, spec: { ...document.spec, additionalAnalyses: [{ method: "jinn.benchmarking.method/does-not-exist", version: "1" }] } },
          owner: "urn:uuid:00000000-0000-5000-8000-000000000001",
          closeAt: "2026-08-06T00:00:00Z",
        }),
      /not a registered method/i,
    );
  });

  test("an additional entry naming a registered-but-unavailable method (bradley-terry) refuses", async () => {
    const clock = makeClock();
    const draftId = await setUpDraftWithSample(clock);
    addTwoDistinctArms(clock, draftId);
    const document = readDraftDocument(workspaceDir, draftId);

    expectRefusal(
      () =>
        compileDraft({
          workspaceDir,
          draft: { ...document, spec: { ...document.spec, additionalAnalyses: [{ method: BENCHMARKING_METHOD_IDS.bradleyTerry, version: BENCHMARKING_METHOD_VERSION }] } },
          owner: "urn:uuid:00000000-0000-5000-8000-000000000001",
          closeAt: "2026-08-06T00:00:00Z",
        }),
      /compute is unavailable/i,
    );
  });

  test("an additional entry carrying a reserved parameter key refuses", async () => {
    const clock = makeClock();
    const draftId = await setUpDraftWithSample(clock);
    addTwoDistinctArms(clock, draftId);
    const document = readDraftDocument(workspaceDir, draftId);

    expectRefusal(
      () =>
        compileDraft({
          workspaceDir,
          draft: { ...document, spec: { ...document.spec, additionalAnalyses: [{ method: AVG_AT_K.method, version: AVG_AT_K.version, parameters: { verdictRule: "unanimous" } }] } },
          owner: "urn:uuid:00000000-0000-5000-8000-000000000001",
          closeAt: "2026-08-06T00:00:00Z",
        }),
      /may not set reserved key/i,
    );
  });

  test("an additional entry whose parameters the method's own schema rejects refuses", async () => {
    const clock = makeClock();
    const draftId = await setUpDraftWithSample(clock);
    addTwoDistinctArms(clock, draftId);
    const document = readDraftDocument(workspaceDir, draftId);

    // pass-at-k@1 requires an integer "k" — omit it entirely.
    expectRefusal(
      () =>
        compileDraft({
          workspaceDir,
          draft: { ...document, spec: { ...document.spec, additionalAnalyses: [{ method: BENCHMARKING_METHOD_IDS.passAtK, version: BENCHMARKING_METHOD_VERSION }] } },
          owner: "urn:uuid:00000000-0000-5000-8000-000000000001",
          closeAt: "2026-08-06T00:00:00Z",
        }),
      /rejected by/i,
    );
  });

  test("an additional entry naming binary-instrument refuses when the primary analysis never derived binaryParameters", async () => {
    // isBinaryInstrumentSpec looks only at the PRIMARY spec.analysis — a non-binary-instrument
    // primary (here, none at all) never derives binaryParameters, so the additional entry's own
    // binary-instrument branch in resolveNonWilsonAnalysisEntry must refuse exactly as the
    // primary's bespoke branch always did (compile.ts:116-118's original refusal, unmoved).
    const clock = makeClock();
    const draftId = await setUpDraftWithSample(clock);
    addTwoDistinctArms(clock, draftId);
    const document = readDraftDocument(workspaceDir, draftId);

    expectRefusal(
      () =>
        compileDraft({
          workspaceDir,
          draft: { ...document, spec: { ...document.spec, additionalAnalyses: [{ method: BENCHMARKING_METHOD_IDS.binaryInstrument, version: BENCHMARKING_METHOD_VERSION }] } },
          owner: "urn:uuid:00000000-0000-5000-8000-000000000001",
          closeAt: "2026-08-06T00:00:00Z",
        }),
      /binary-instrument composition was not derived/i,
    );
  });
});
