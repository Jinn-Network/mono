import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  BENCHMARKING_METHOD_IDS,
  BENCHMARKING_METHOD_VERSION,
  BENCHMARKING_PROTOCOL,
  sealBenchmark,
} from "@jinn-network/benchmarking-records";
import { BINARY_INSTRUMENT_MEASUREMENT_PROFILE } from "@jinn-network/benchmarking-aggregate";
import {
  BINARY_ACCEPT_REJECT_PARSER_IDENTITY,
  BINARY_JUDGMENT_ANALYSIS_CONTEXT_MEDIA_TYPE,
  BINARY_JUDGMENT_EVALUATION_PARSER_IDENTITY,
  BINARY_JUDGMENT_INSPECT_LOG_MEDIA_TYPE,
  BINARY_JUDGMENT_INSTRUMENT_FORMAT_URI,
  BINARY_JUDGMENT_INSTRUMENT_REQUIREMENT_KEY,
  BINARY_JUDGMENT_OBSERVATION_MEDIA_TYPE,
  BINARY_JUDGMENT_PROFILE_DIGEST,
  BINARY_JUDGMENT_PROFILE_URI,
  BINARY_JUDGMENT_RESPONSE_MEDIA_TYPE,
  EVALUATION_SPEC_FORMAT_URI,
  EVAL_SEMANTICS_VERSION,
  binaryJudgmentPromptTemplateDigest,
  sealBinaryJudgmentInstrument,
  sealEvaluationSpec,
} from "@jinn-network/task-execution-profiles";
import {
  TASK_EXECUTION_PROTOCOL_URI,
  documentDigest,
  sealTask,
} from "@jinn-network/task-execution-protocol";
import { canonicalJsonBytes } from "@jinn-network/trust-core";
import { BenchmarkProductError } from "../errors.js";
import { BINARY_JUDGMENT_HUMAN_REVIEW_EVALUATION_SPEC_SEALED } from "../human-review/application.js";
import type { OperationContext } from "../operations/context.js";
import { createDraft, readDraftDocument } from "../operations/drafts.js";
import { admitHumanTruth } from "../operations/human-review.js";
import { initWorkspace } from "../operations/init.js";
import { runLock } from "../operations/run-lock.js";
import { runQuote } from "../operations/run-quote.js";
import { atomicWriteFileSync } from "../fs/atomic.js";
import { specDigest, writeRunState } from "./state.js";
import { draftPath } from "../workspace/layout.js";
import { getSealedBytes, putSealedBytes, sealedRecordPath } from "../workspace/sealed-store.js";
import type { DraftDocument } from "../domain/draft.js";
import {
  SUPPORTED_INSPECT_EVALS_VERSION,
  SUPPORTED_INSPECT_VERSION,
  SUPPORTED_OCI_PLATFORM,
  SUPPORTED_OCI_PYTHON_VERSION,
  SUPPORTED_OPENAI_SDK_VERSION,
} from "../runtime/inspect/manifest.js";
import {
  BINARY_INSTRUMENT_REPORT_LIMITATIONS,
  BINARY_ITEM_BANK_INTAKE_EXTENSION,
  INSPECT_BINARY_JUDGE_ADAPTER_ID,
  INSPECT_BINARY_JUDGE_LAUNCHER_ID,
  INSPECT_BINARY_JUDGE_LAUNCHER_VERSION,
  INSPECT_BINARY_JUDGE_SELECTION_SCHEMA,
  binaryInstrumentReportLimitations,
  compileBinaryInstrumentProfile,
} from "./binary-instrument-profile.js";
import { compileDraft, compilePreviewRun } from "./compile.js";

// C1 composes against F3's frozen adapter contract without importing its independently landing
// registry edit. Keep the test oracle narrow: only the submission baseline that compile needs is
// supplied here; the production adapter registry remains F3-owned.
vi.mock("../runtime/adapter.js", () => ({
  runtimeSubmissionBaseline(binding: { readonly isolationPolicy?: string } | undefined) {
    return { isolationPolicy: binding?.isolationPolicy ?? "unrestricted" };
  },
  runtimeRegistrationArtifacts() {
    return [];
  },
  createRuntimeVenue() {
    throw new Error("the test must inject a venue");
  },
}));

const sha = (character: string): `sha256:${string}` => `sha256:${character.repeat(64)}`;
const bare = (digest: string): string => digest.slice("sha256:".length);
const generation = {
  reasoningEffort: "low",
  maxOutputTokens: 128,
  store: false,
  background: false,
  stream: false,
  serviceTier: "default",
  tools: [],
  fallbackModels: [],
  retries: 0,
  persistedConversation: false,
  metadata: null,
  promptCacheIdentifier: null,
} as const;

let workspaceDir: string;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "binary-instrument-composition-"));
});

afterEach(() => {
  rmSync(workspaceDir, { recursive: true, force: true });
});

function context(): OperationContext {
  return {
    workspaceDir,
    principal: "sponsor-1",
    clock: () => "2026-08-15T09:00:00.000Z",
  };
}

function store(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${putSealedBytes(workspaceDir, bytes)}`;
}

function evaluationSpec(analysisContextSha256: `sha256:${string}`) {
  return sealEvaluationSpec({
    protocol: EVALUATION_SPEC_FORMAT_URI,
    semanticsVersion: EVAL_SEMANTICS_VERSION,
    family: "deterministic-process",
    grader: {
      name: BINARY_JUDGMENT_EVALUATION_PARSER_IDENTITY.id,
      digest: { sha256: bare(BINARY_JUDGMENT_EVALUATION_PARSER_IDENTITY.digest) },
      accessClass: "public",
    },
    familyBlock: {
      image: {
        name: "binary-judgment-evaluation-parser-semantics.json",
        digest: { sha256: bare(BINARY_JUDGMENT_EVALUATION_PARSER_IDENTITY.digest) },
      },
      platform: "linux/amd64",
      workspace: {},
      testMaterial: [{
        name: "analysis-context.json",
        digest: { sha256: bare(analysisContextSha256) },
        mediaType: BINARY_JUDGMENT_ANALYSIS_CONTEXT_MEDIA_TYPE,
        accessClass: "private",
      }],
      parser: BINARY_JUDGMENT_EVALUATION_PARSER_IDENTITY,
      transitions: { failToPass: [], passToPass: [] },
      timeout: 60,
    },
    measurements: [
      { name: "judgeDecision", type: "string", required: true },
      { name: "truthLabel", type: "string", required: true },
      { name: "agreement", type: "boolean", required: true },
      { name: "parseValid", type: "boolean", required: true },
      { name: "candidateClass", type: "string", required: true },
      { name: "stratum", type: "string", required: true },
      { name: "labelResolutionSha256", type: "string", required: true },
      { name: "instrumentSha256", type: "string", required: true },
    ],
    verdictRule: { threshold: { measurement: "agreement", op: "eq", value: true } },
    unscorable: [],
    evidenceConventions: { requiredRefs: ["label-resolution.json"] },
  });
}

function instrument(instrumentId: string, options: { readonly declaresEvidence?: boolean } = {}) {
  const userSegments = [
    { literal: "Question: " },
    { field: "question" },
    { literal: "\nReference: " },
    { field: "referenceAnswer" },
    { literal: "\nCandidate: " },
    { field: "candidateAnswer" },
    ...(options.declaresEvidence ? [{ literal: "\nEvidence: " }, { field: "evidence" }] : []),
  ];
  const messages = [
    { role: "developer", segments: [{ literal: "Judge only the supplied item. " }] },
    { role: "user", segments: userSegments },
  ];
  const descriptor = {
    uri: "https://fixtures.example.test/judge-prompt",
    digest: { sha256: "a".repeat(64) },
  };
  return sealBinaryJudgmentInstrument({
    protocol: BINARY_JUDGMENT_INSTRUMENT_FORMAT_URI,
    instrumentId,
    messages,
    promptTemplateSha256: binaryJudgmentPromptTemplateDigest(messages as never),
    promptSource: descriptor,
    license: { ...descriptor, uri: "https://www.apache.org/licenses/LICENSE-2.0.txt" },
    attribution: { ...descriptor, uri: "https://fixtures.example.test/attribution" },
    model: { adapter: "jinn-openai", requested: "gpt-5.6-luna", generation },
    response: {
      mediaType: BINARY_JUDGMENT_RESPONSE_MEDIA_TYPE,
      parser: BINARY_ACCEPT_REJECT_PARSER_IDENTITY,
      invalidOutputDecision: "REJECT",
    },
  } as never);
}

interface Fixture {
  readonly draft: DraftDocument;
  readonly benchmarkSha256: string;
  readonly admissionManifestSha256: `sha256:${string}`;
  readonly selectionManifestSha256: string;
  readonly taskSha256s: readonly string[];
}

function setUpFixture(options: {
  /** Adds an `evidence` field to every candidate item's payload. Default off. */
  readonly withItemEvidence?: boolean;
  /** Arm ids whose instrument should interpolate `evidence`. Default: none declare. */
  readonly declaringArmIds?: readonly string[];
} = {}): Fixture {
  const withItemEvidence = options.withItemEvidence ?? false;
  const declaringArmIds = new Set(options.declaringArmIds ?? []);
  expect(initWorkspace(context()).ok).toBe(true);
  const initial = createDraft(context(), {
    draftId: "draft-1",
    name: "Binary instrument fixture",
  });
  expect(initial.ok).toBe(true);
  if (!initial.ok) throw new Error(initial.error.detail);

  const candidates = [
    {
      itemId: "urn:uuid:00000000-0000-4000-8000-000000000001",
      question: "Core question",
      referenceAnswer: "Core reference",
      candidateAnswer: "Core candidate",
      ...(withItemEvidence ? { evidence: "Direct synthetic verification of the core item." } : {}),
      provenance: { sourceCommitment: sha("a"), timestamp: "2026-03-09T00:00:00Z" },
      sources: [{ digest: { sha256: "a".repeat(64) } }],
      truthLabel: "CORRECT" as const,
      candidateClass: "zeta",
      stratum: "core" as const,
    },
    {
      itemId: "urn:uuid:00000000-0000-4000-8000-000000000002",
      question: "Stress question",
      referenceAnswer: "Stress reference",
      candidateAnswer: "Stress candidate",
      ...(withItemEvidence ? { evidence: "Direct synthetic verification of the stress item." } : {}),
      provenance: { sourceCommitment: sha("b"), timestamp: "2026-04-01T00:00:00Z" },
      sources: [{ digest: { sha256: "b".repeat(64) } }],
      truthLabel: "WRONG" as const,
      candidateClass: "alpha",
      stratum: "stress" as const,
    },
  ].map((entry, index) => {
    const { truthLabel, candidateClass, stratum, ...payload } = entry;
    const itemSha256 = store(canonicalJsonBytes(payload));
    return {
      payload,
      itemSha256,
      itemId: payload.itemId,
      humanReviewEvaluationSpecSha256: BINARY_JUDGMENT_HUMAN_REVIEW_EVALUATION_SPEC_SEALED.digest,
      candidateClass,
      stratum,
      poolPosition: index + 1,
      operatorTruthLabel: truthLabel,
    };
  });
  const admittedOutcome = admitHumanTruth(context(), {
    draftId: "draft-1",
    truthAdmission: "operator-only",
    candidates: candidates.map(({ payload: _payload, ...candidate }) => candidate),
  });
  if (!admittedOutcome.ok) throw new Error(admittedOutcome.error.detail);
  expect(admittedOutcome.ok).toBe(true);
  const admittedByItem = new Map(
    admittedOutcome.result.resolutions.map((entry) => [entry.itemSha256, entry]),
  );
  const admitted = candidates.map(({ payload, itemSha256 }) => {
    const resolution = admittedByItem.get(itemSha256);
    if (resolution === undefined) throw new Error(`missing admitted resolution for ${itemSha256}`);
    const evaluation = evaluationSpec(resolution.analysisContextSha256 as `sha256:${string}`);
    store(evaluation.bytes);
    const taskBytes = sealTask({
      protocol: TASK_EXECUTION_PROTOCOL_URI,
      profile: {
        uri: BINARY_JUDGMENT_PROFILE_URI,
        digest: { sha256: bare(BINARY_JUDGMENT_PROFILE_DIGEST) },
      },
      instructions: "Return exactly ACCEPT or REJECT.",
      payload,
      outputs: [
        { name: "judge-response", mediaType: BINARY_JUDGMENT_RESPONSE_MEDIA_TYPE, required: true },
        { name: "judge-observation", mediaType: BINARY_JUDGMENT_OBSERVATION_MEDIA_TYPE, required: true },
        { name: "inspect-log", mediaType: BINARY_JUDGMENT_INSPECT_LOG_MEDIA_TYPE, required: false },
      ],
      evaluation: { digest: { sha256: bare(evaluation.digest) } },
      author: "did:key:z6Mksynthetic",
      "network.jinn.binary-judgment.item-sha256": itemSha256,
    });
    const taskSha256 = documentDigest(taskBytes);
    store(taskBytes);
    return { ...resolution, taskSha256 };
  });

  const benchmark = sealBenchmark({
    protocol: BENCHMARKING_PROTOCOL,
    name: "Binary instrument fixture",
    description: "Synthetic evidence only.",
    author: "did:key:z6Mksynthetic",
    version: "1.0.0",
    reveal: { policy: "immediate" },
    items: admitted.map((entry) => ({ task: { digest: { sha256: bare(entry.taskSha256) } } })),
    [BINARY_ITEM_BANK_INTAKE_EXTENSION]: {
      profile: BINARY_JUDGMENT_PROFILE_URI,
      itemBankSha256: sha("1"),
      sourceManifestSha256: sha("2"),
      admissionIndexSha256: sha("3"),
      admissionManifestSha256: admittedOutcome.result.admissionManifestSha256,
      replacementLedgerSha256: admittedOutcome.result.replacementLedgerSha256,
    },
  });
  const benchmarkSha256 = bare(store(benchmark.bytes));

  const armIds = ["alpha", "beta", "delta", "gamma"] as const;
  const instruments = armIds.map((armId) => {
    const sealed = instrument(armId, { declaresEvidence: declaringArmIds.has(armId) });
    store(sealed.bytes);
    return sealed;
  });
  const selection = {
    schema: INSPECT_BINARY_JUDGE_SELECTION_SCHEMA,
    runtime: {
      imageDigest: sha("4"),
      platform: SUPPORTED_OCI_PLATFORM,
      pythonVersion: SUPPORTED_OCI_PYTHON_VERSION,
      inspectVersion: SUPPORTED_INSPECT_VERSION,
      inspectEvalsVersion: SUPPORTED_INSPECT_EVALS_VERSION,
      openaiSdkVersion: SUPPORTED_OPENAI_SDK_VERSION,
      runtimeHostSourceSha256: "5".repeat(64),
      workerSourceSha256: "6".repeat(64),
      brokerSourceSha256: "7".repeat(64),
      modelProviderSourceSha256: "8".repeat(64),
    },
    execution: {
      callsPerCell: 1,
      epochs: 1,
      inspectScorer: false,
      retries: 0,
      fallbacks: 0,
      tools: [],
      storage: false,
    },
    requirement: {
      key: BINARY_JUDGMENT_INSTRUMENT_REQUIREMENT_KEY,
      valueShape: "sha256:<64-lowercase-hex>",
      comparison: "exact",
      location: "submission-effective-requirements",
    },
    arms: armIds.map((armId, index) => ({
      armId,
      instrumentSha256: instruments[index]!.digest,
      model: "gpt-5.6-luna",
      generation,
    })),
  } as const;
  const selectionManifestSha256 = putSealedBytes(workspaceDir, canonicalJsonBytes(selection as never));

  const baseDraft = readDraftDocument(workspaceDir, "draft-1");
  const draft: DraftDocument = {
    ...baseDraft,
    spec: {
      ...baseDraft.spec,
      taskSet: { kind: "benchmark", benchmarkSha256 },
      arms: selection.arms.map((arm) => ({
        armId: arm.armId,
        pinning: {
          harness: { id: INSPECT_BINARY_JUDGE_LAUNCHER_ID, version: INSPECT_BINARY_JUDGE_LAUNCHER_VERSION },
          model: { id: "gpt-5.6-luna" },
          [BINARY_JUDGMENT_INSTRUMENT_REQUIREMENT_KEY]: arm.instrumentSha256,
        },
      })),
      replicates: 3,
      assurance: { preset: "direct-check" },
      evaluationRuntime: {
        adapterId: INSPECT_BINARY_JUDGE_ADAPTER_ID,
        selectionManifestSha256,
        isolationPolicy: "oci-container",
      },
      analysis: {
        method: BENCHMARKING_METHOD_IDS.binaryInstrument,
        version: BENCHMARKING_METHOD_VERSION,
      },
    },
  };
  atomicWriteFileSync(draftPath(workspaceDir, "draft-1"), JSON.stringify(draft, null, 2));
  return {
    draft,
    benchmarkSha256,
    admissionManifestSha256: admittedOutcome.result.admissionManifestSha256 as `sha256:${string}`,
    selectionManifestSha256,
    taskSha256s: admitted.map((entry) => bare(entry.taskSha256)),
  };
}

function rewriteDraft(transform: (draft: DraftDocument) => DraftDocument): DraftDocument {
  const next = transform(readDraftDocument(workspaceDir, "draft-1"));
  atomicWriteFileSync(draftPath(workspaceDir, "draft-1"), JSON.stringify(next, null, 2));
  return next;
}

function expectProductError(run: () => unknown): BenchmarkProductError {
  try {
    run();
    throw new Error("expected refusal");
  } catch (cause) {
    expect(cause).toBeInstanceOf(BenchmarkProductError);
    return cause as BenchmarkProductError;
  }
}

describe("binary-instrument@1 lock-time composition", () => {
  test("derives and seals the frozen method parameters after Wilson, including exact k from replicates", () => {
    const fixture = setUpFixture();
    const benchmark = JSON.parse(new TextDecoder().decode(getSealedBytes(workspaceDir, fixture.benchmarkSha256)));
    const parameters = compileBinaryInstrumentProfile({
      workspaceDir,
      draft: fixture.draft,
      benchmark,
    });
    expect(parameters).toEqual({
      verdictRule: "sole",
      k: 3,
      reduction: "strict-majority",
      measurementProfile: BINARY_INSTRUMENT_MEASUREMENT_PROFILE,
      candidateClasses: ["alpha", "zeta"],
      strata: ["core", "stress"],
      parserInvalidPolicy: "reject",
      truthAdmission: "operator-only",
      intervalAlpha: "0.05",
    });

    const compiled = compileDraft({
      workspaceDir,
      draft: fixture.draft,
      owner: "urn:uuid:00000000-0000-5000-8000-000000000001",
      closeAt: "2026-08-16T09:00:00.000Z",
    });
    expect(compiled.plannedRun.record.analysisPlan).toEqual([
      { method: BENCHMARKING_METHOD_IDS.wilson, version: BENCHMARKING_METHOD_VERSION, parameters: { verdictRule: "sole" } },
      { method: BENCHMARKING_METHOD_IDS.binaryInstrument, version: BENCHMARKING_METHOD_VERSION, parameters },
    ]);
  });

  test("preserves the authority-bearing intake locator on a binary preview subset", () => {
    const fixture = setUpFixture();
    const preview = compilePreviewRun({
      workspaceDir,
      draft: fixture.draft,
      owner: "urn:uuid:00000000-0000-5000-8000-000000000001",
      closeAt: "2026-08-16T09:00:00.000Z",
      itemLimit: 1,
    });
    expect(preview.previewBenchmarkRecord.items).toHaveLength(1);
    expect((preview.previewBenchmarkRecord as unknown as Record<string, unknown>)[BINARY_ITEM_BANK_INTAKE_EXTENSION])
      .toEqual((JSON.parse(new TextDecoder().decode(getSealedBytes(workspaceDir, fixture.benchmarkSha256))) as Record<string, unknown>)[BINARY_ITEM_BANK_INTAKE_EXTENSION]);
  });

  test("refuses lock-time composition when the authenticated admission closure is unavailable", () => {
    const fixture = setUpFixture();
    rmSync(sealedRecordPath(workspaceDir, bare(fixture.admissionManifestSha256)));
    const benchmark = JSON.parse(new TextDecoder().decode(
      getSealedBytes(workspaceDir, fixture.benchmarkSha256),
    ));
    expect(() => compileBinaryInstrumentProfile({
      workspaceDir,
      draft: fixture.draft,
      benchmark,
    })).toThrow(/admission closure is not authenticated/u);
  });

  test("rejects every caller-supplied derived parameter, even when its value happens to match", () => {
    const fixture = setUpFixture();
    for (const parameters of [
      { k: 3 },
      { candidateClasses: ["alpha", "zeta"] },
      { truthAdmission: "operator-only" },
    ]) {
      expect(() => compileDraft({
        workspaceDir,
        draft: {
          ...fixture.draft,
          spec: { ...fixture.draft.spec, analysis: { ...fixture.draft.spec.analysis!, parameters } },
        },
        owner: "urn:uuid:00000000-0000-5000-8000-000000000001",
        closeAt: "2026-08-16T09:00:00.000Z",
      })).toThrow(/derived|caller-supplied/u);
    }
  });

  test("fails closed on even k, non-sole assurance, arm-count, and scalar instrument-pin drift", () => {
    const fixture = setUpFixture();
    const drifts: DraftDocument[] = [
      { ...fixture.draft, spec: { ...fixture.draft.spec, replicates: 2 } },
      { ...fixture.draft, spec: { ...fixture.draft.spec, assurance: { preset: "evaluator-panel" } } },
      { ...fixture.draft, spec: { ...fixture.draft.spec, arms: fixture.draft.spec.arms.slice(0, 3) } },
      {
        ...fixture.draft,
        spec: {
          ...fixture.draft.spec,
          arms: fixture.draft.spec.arms.map((arm, index) => index === 0
            ? { ...arm, pinning: { ...arm.pinning, [BINARY_JUDGMENT_INSTRUMENT_REQUIREMENT_KEY]: { digest: arm.pinning[BINARY_JUDGMENT_INSTRUMENT_REQUIREMENT_KEY] } } }
            : arm),
        },
      },
    ];
    for (const draft of drifts) {
      expect(() => compileDraft({
        workspaceDir,
        draft,
        owner: "urn:uuid:00000000-0000-5000-8000-000000000001",
        closeAt: "2026-08-16T09:00:00.000Z",
      })).toThrow();
    }
  });

  test("the shared Tasks remain arm-neutral", () => {
    const fixture = setUpFixture();
    for (const taskSha256 of fixture.taskSha256s) {
      const text = new TextDecoder().decode(getSealedBytes(workspaceDir, taskSha256));
      expect(text).not.toContain(BINARY_JUDGMENT_INSTRUMENT_REQUIREMENT_KEY);
      for (const armId of ["alpha", "beta", "delta", "gamma"]) expect(text).not.toContain(armId);
    }
  });

  // §2.3 (frozen): "Arms constrain items; items never constrain arms." The two rows of the table
  // are both proven here, not just the refusing row -- a paired contrast needs its twin verified,
  // not assumed to work by omission.
  describe("§2.3 lock-time evidence direction rule", () => {
    test("a declaring arm over an evidence-free bank refuses at lock with the exact frozen message", () => {
      const fixture = setUpFixture({ declaringArmIds: ["beta"] });
      const benchmark = JSON.parse(new TextDecoder().decode(getSealedBytes(workspaceDir, fixture.benchmarkSha256)));
      const error = expectProductError(() => compileBinaryInstrumentProfile({
        workspaceDir,
        draft: fixture.draft,
        benchmark,
      }));
      expect(error.code).toBe("conflict");
      expect(error.issues).toEqual([{
        path: "spec.arms.1.instrument",
        message: "instrument interpolates evidence but the bound bank carries none",
      }]);
    });

    test("an evidence-carrying bank with non-declaring arms locks cleanly", () => {
      const fixture = setUpFixture({ withItemEvidence: true });
      const benchmark = JSON.parse(new TextDecoder().decode(getSealedBytes(workspaceDir, fixture.benchmarkSha256)));
      expect(() => compileBinaryInstrumentProfile({
        workspaceDir,
        draft: fixture.draft,
        benchmark,
      })).not.toThrow();
    });

    // The flagship's actual path: the evidence-declaring arm and its evidence-free twins bound to
    // one evidence-carrying bank. Proven at lock, not only at the launcher seam, because lock is
    // where the arm set and the item set are both frozen and both in scope.
    test("a declaring arm over an evidence-carrying bank locks cleanly alongside its evidence-free twins", () => {
      const fixture = setUpFixture({ withItemEvidence: true, declaringArmIds: ["beta"] });
      const benchmark = JSON.parse(new TextDecoder().decode(getSealedBytes(workspaceDir, fixture.benchmarkSha256)));
      const parameters = compileBinaryInstrumentProfile({
        workspaceDir,
        draft: fixture.draft,
        benchmark,
      });
      expect(parameters.strata).toStrictEqual(["core", "stress"]);
    });
  });
});

describe("binary composition lifecycle refusals", () => {
  test("quote refuses caller-supplied k before venue construction", async () => {
    setUpFixture();
    rewriteDraft((draft) => ({
      ...draft,
      spec: { ...draft.spec, analysis: { ...draft.spec.analysis!, parameters: { k: 3 } } },
    }));
    let venueConstructions = 0;
    const outcome = await runQuote(context(), { draftId: "draft-1" }, {
      createVenue: () => {
        venueConstructions += 1;
        throw new Error("must not construct a venue for invalid composition");
      },
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("validation");
    expect(outcome.error.detail).toMatch(/caller-supplied/u);
    expect(venueConstructions).toBe(0);
  });

  test("lock revalidates sealed-evidence-derived fields and leaves the quoted draft untouched", () => {
    setUpFixture();
    const drifted = rewriteDraft((draft) => ({
      ...draft,
      state: "quoted",
      spec: {
        ...draft.spec,
        analysis: { ...draft.spec.analysis!, parameters: { truthAdmission: "operator-only" } },
      },
    }));
    writeRunState(workspaceDir, "draft-1", {
      draftId: "draft-1",
      specSha256: specDigest(drifted.spec),
      owner: "urn:uuid:00000000-0000-5000-8000-000000000001",
    });
    const outcome = runLock(context(), { draftId: "draft-1" });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("validation");
    expect(readDraftDocument(workspaceDir, "draft-1").state).toBe("quoted");
  });
});

describe("binary report limitations", () => {
  const base = {
    verdictRule: "sole",
    k: 3,
    reduction: "strict-majority",
    measurementProfile: BINARY_INSTRUMENT_MEASUREMENT_PROFILE,
    candidateClasses: ["alpha", "zeta"],
    strata: ["core", "stress"],
    parserInvalidPolicy: "reject",
    intervalAlpha: "0.05",
  } as const;

  test("emits only the exact method limitations and adds operator-only truth when selected", () => {
    const human = binaryInstrumentReportLimitations({ ...base, truthAdmission: "two-human-unanimous" });
    const operator = binaryInstrumentReportLimitations({ ...base, truthAdmission: "operator-only" });
    expect(human).toEqual([
      BINARY_INSTRUMENT_REPORT_LIMITATIONS.mutableModelAlias,
      BINARY_INSTRUMENT_REPORT_LIMITATIONS.reviewerKeyPerson,
      BINARY_INSTRUMENT_REPORT_LIMITATIONS.cognitiveBlinding,
    ]);
    expect(operator).toEqual([...human, BINARY_INSTRUMENT_REPORT_LIMITATIONS.operatorOnly]);
    expect(operator.join(" ")).not.toMatch(/\b(?:rank|ranking|select|selection|winner|loser)\b/iu);
  });
});
