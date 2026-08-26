import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  BENCHMARKING_METHOD_IDS,
  BENCHMARKING_METHOD_VERSION,
  BENCHMARKING_PROTOCOL,
  compareCodeUnitStrings,
  sealBenchmark,
} from "@jinn-network/benchmarking-records";
import {
  BINARY_INSTRUMENT_MEASUREMENT_PROFILE,
  PAIRED_MAJORITY_DELTA_ALPHA,
  PAIRED_MAJORITY_DELTA_RESAMPLES,
  PAIRED_MAJORITY_DELTA_SEED,
  validatePairedMajorityDeltaParameters,
  validatePairwiseDisagreementParameters,
} from "@jinn-network/benchmarking-aggregate";
import {
  BINARY_ACCEPT_REJECT_PARSER_IDENTITY,
  BINARY_COMPLETE_JSON_LABEL_PARSER_V2_IDENTITY,
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
  recordDigest,
  sealBinaryJudgmentInstrument,
  sealEvaluationSpec,
  type AcceptedJudgeModelId,
} from "@jinn-network/task-execution-profiles";
import { buildBinaryJudgmentEvaluationSpecification } from "@jinn-network/task-execution-evaluator-adapters";
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
  compilePairedMajorityDeltaProfile,
  compilePairwiseDisagreementProfile,
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
// The dated-snapshot-sampling generation shape (spec §1.3), for the dated-snapshot judge-model
// profile tests. Never mixed with `generation` on one arm — the two are the sibling-key-driven
// generation union's two closed variants.
const samplingGeneration = {
  temperature: 0,
  maxOutputTokens: 512,
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

interface ArmConfig {
  readonly armId: string;
  readonly model: AcceptedJudgeModelId;
  readonly generation: typeof generation | typeof samplingGeneration;
  /** Developer-message preamble (packet #2837, RULING C2). Arms sharing one preamble are
   * stripped-identical and so are twin candidates for the evidence-declaring arm; arms with
   * distinct preambles are UNRELATED and must not be paired with it. The family closure pins one
   * shared model and one shared generation across arms, so the message templates are the only axis
   * on which two arms of a legal roster can genuinely differ. */
  readonly preamble?: string;
}

const DEFAULT_ARM_CONFIGS: readonly ArmConfig[] = (["alpha", "beta", "delta", "gamma"] as const).map(
  (armId): ArmConfig => ({ armId, model: "gpt-5.6-luna", generation }),
);
const SIX_ARM_CONFIGS: readonly ArmConfig[] = (
  ["alpha", "beta", "delta", "epsilon", "gamma", "zeta"] as const
).map((armId): ArmConfig => ({ armId, model: "gpt-5.6-luna", generation }));

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

function evaluationSpec(
  analysisContextSha256: `sha256:${string}`,
  parserInvalidPolicy: "reject" | "abstain" = "reject",
) {
  if (parserInvalidPolicy === "abstain") {
    return sealEvaluationSpec(buildBinaryJudgmentEvaluationSpecification(analysisContextSha256, "abstain"));
  }
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

function instrument(
  instrumentId: string,
  options: {
    readonly model?: AcceptedJudgeModelId;
    readonly generation?: typeof generation | typeof samplingGeneration;
    readonly declaresEvidence?: boolean;
    readonly preamble?: string;
    readonly parserInvalidPolicy?: "reject" | "abstain";
  } = {},
) {
  const model = options.model ?? "gpt-5.6-luna";
  const instrumentGeneration = options.generation ?? generation;
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
    { role: "developer", segments: [{ literal: options.preamble ?? "Judge only the supplied item. " }] },
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
    model: { adapter: "jinn-openai", requested: model, generation: instrumentGeneration },
    response: {
      mediaType: BINARY_JUDGMENT_RESPONSE_MEDIA_TYPE,
      parser: options.parserInvalidPolicy === "abstain"
        ? BINARY_COMPLETE_JSON_LABEL_PARSER_V2_IDENTITY
        : BINARY_ACCEPT_REJECT_PARSER_IDENTITY,
      invalidOutputDecision: options.parserInvalidPolicy === "abstain" ? "INVALID" : "REJECT",
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

interface AdmissionItemConfig {
  readonly itemId: string;
  readonly question: string;
  readonly referenceAnswer: string;
  readonly candidateAnswer: string;
  readonly provenance: {
    readonly sourceCommitment: `sha256:${string}`;
    readonly timestamp: string;
  };
  readonly sources: readonly { readonly digest: { readonly sha256: string } }[];
  /** Injected as the payload's `evidence` field only under `withItemEvidence`. */
  readonly evidenceText: string;
  readonly truthLabel: "CORRECT" | "WRONG";
  readonly candidateClass: string;
  readonly stratum: string;
}

// Byte-for-byte today's two candidates (spec §10.2 ruling 3): this is the fixture's default, not
// a new shape.
const DEFAULT_ADMISSION_ITEMS: readonly AdmissionItemConfig[] = [
  {
    itemId: "urn:uuid:00000000-0000-4000-8000-000000000001",
    question: "Core question",
    referenceAnswer: "Core reference",
    candidateAnswer: "Core candidate",
    evidenceText: "Direct synthetic verification of the core item.",
    provenance: { sourceCommitment: sha("a"), timestamp: "2026-03-09T00:00:00Z" },
    sources: [{ digest: { sha256: "a".repeat(64) } }],
    truthLabel: "CORRECT",
    candidateClass: "zeta",
    stratum: "core",
  },
  {
    itemId: "urn:uuid:00000000-0000-4000-8000-000000000002",
    question: "Stress question",
    referenceAnswer: "Stress reference",
    candidateAnswer: "Stress candidate",
    evidenceText: "Direct synthetic verification of the stress item.",
    provenance: { sourceCommitment: sha("b"), timestamp: "2026-04-01T00:00:00Z" },
    sources: [{ digest: { sha256: "b".repeat(64) } }],
    truthLabel: "WRONG",
    candidateClass: "alpha",
    stratum: "stress",
  },
];

function setUpFixture(options: {
  readonly arms?: readonly ArmConfig[];
  readonly snapshotProbeSha256?: `sha256:${string}`;
  /** Adds an `evidence` field to every candidate item's payload. Default off. */
  readonly withItemEvidence?: boolean;
  /** Arm ids whose instrument should interpolate `evidence`. Default: none declare. */
  readonly declaringArmIds?: readonly string[];
  readonly items?: readonly AdmissionItemConfig[];
  /** Test-only screened admission whose instrument deliberately reuses this run arm. */
  readonly screeningInstrumentArmId?: string;
  readonly parserInvalidPolicy?: "reject" | "abstain";
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

  const armConfigs = options.arms ?? DEFAULT_ARM_CONFIGS;
  const instruments = armConfigs.map((armConfig) => {
    const sealed = instrument(armConfig.armId, {
      model: armConfig.model,
      generation: armConfig.generation,
      declaresEvidence: declaringArmIds.has(armConfig.armId),
      preamble: armConfig.preamble,
      parserInvalidPolicy: options.parserInvalidPolicy,
    });
    store(sealed.bytes);
    return sealed;
  });

  const candidates = (options.items ?? DEFAULT_ADMISSION_ITEMS).map((entry, index) => {
    const { truthLabel, candidateClass, stratum, evidenceText, ...rest } = entry;
    // Canonical JSON sorts keys, so appending `evidence` here is byte-identical to declaring it
    // inline: the default (evidence off) reproduces today's two payloads exactly.
    const payload = { ...rest, ...(withItemEvidence ? { evidence: evidenceText } : {}) };
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
  const screeningInstrument = options.screeningInstrumentArmId === undefined
    ? undefined
    : instruments[armConfigs.findIndex((arm) => arm.armId === options.screeningInstrumentArmId)];
  if (options.screeningInstrumentArmId !== undefined && screeningInstrument === undefined) {
    throw new Error(`unknown screening instrument arm ${options.screeningInstrumentArmId}`);
  }
  const scriptBytes = new Uint8Array([0, 255, 1]);
  const rawBytes = new Uint8Array([255, 0, 2]);
  const admittedOutcome = admitHumanTruth(context(), screeningInstrument === undefined ? {
    draftId: "draft-1",
    truthAdmission: "operator-only",
    candidates: candidates.map(({ payload: _payload, ...candidate }) => candidate),
  } : {
    draftId: "draft-1",
    truthAdmission: "screened-operator-sampled",
    candidates: candidates.map(({ payload: _payload, operatorTruthLabel: _truth, ...candidate }) => candidate),
    screening: {
      screeningInstrumentSha256: screeningInstrument.digest,
      screeningInstrumentBase64: Buffer.from(screeningInstrument.bytes).toString("base64"),
      sampleSeed: "synthetic-run-lock-screening",
      sampleSize: candidates.length,
      samplingScriptSha256: recordDigest(scriptBytes),
      samplingScriptBase64: Buffer.from(scriptBytes).toString("base64"),
      rawOutputsSha256: recordDigest(rawBytes),
      rawOutputsBase64: Buffer.from(rawBytes).toString("base64"),
      rows: candidates.map((candidate) => ({
        itemSha256: candidate.itemSha256,
        intendedLabel: candidate.operatorTruthLabel,
        screeningVerdict: candidate.operatorTruthLabel,
        handChecked: true,
        handVerdict: "confirm" as const,
      })).sort((left, right) => compareCodeUnitStrings(left.itemSha256, right.itemSha256)),
    },
  });
  if (!admittedOutcome.ok) throw new Error(admittedOutcome.error.detail);
  expect(admittedOutcome.ok).toBe(true);
  const admittedByItem = new Map(
    admittedOutcome.result.resolutions.map((entry) => [entry.itemSha256, entry]),
  );
  const admitted = candidates.map(({ payload, itemSha256 }) => {
    const resolution = admittedByItem.get(itemSha256);
    if (resolution === undefined) throw new Error(`missing admitted resolution for ${itemSha256}`);
    const evaluation = evaluationSpec(
      resolution.analysisContextSha256 as `sha256:${string}`,
      options.parserInvalidPolicy,
    );
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
    arms: armConfigs.map((armConfig, index) => ({
      armId: armConfig.armId,
      instrumentSha256: instruments[index]!.digest,
      model: armConfig.model,
      generation: armConfig.generation,
    })),
    ...(options.snapshotProbeSha256 === undefined ? {} : { snapshotProbeSha256: options.snapshotProbeSha256 }),
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
          model: { id: arm.model },
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
      // Derived from the arms' shared model.requested (spec §1.4 clause 1); this fixture's arms
      // are all gpt-5.6-luna, so the derived profile is reasoning-2026-08.
      judgeModelProfile: "reasoning-2026-08",
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

  test("derives neutral parser-invalid handling only when the sealed tasks and every arm select it", () => {
    const fixture = setUpFixture({ parserInvalidPolicy: "abstain" });
    const benchmark = JSON.parse(new TextDecoder().decode(getSealedBytes(workspaceDir, fixture.benchmarkSha256)));
    const parameters = compileBinaryInstrumentProfile({ workspaceDir, draft: fixture.draft, benchmark });

    expect(parameters.parserInvalidPolicy).toBe("abstain");
    const compiled = compileDraft({
      workspaceDir,
      draft: fixture.draft,
      owner: "urn:uuid:00000000-0000-5000-8000-000000000001",
      closeAt: "2026-08-16T09:00:00.000Z",
    });
    const binaryInstrument = compiled.plannedRun.record.analysisPlan?.find(
      (entry) => entry.method === BENCHMARKING_METHOD_IDS.binaryInstrument,
    );
    expect(binaryInstrument?.parameters).toMatchObject({ parserInvalidPolicy: "abstain" });
  });

  // Spec §3.1 site 12, the packet's headline: `deriveAdmissionProfile` used to derive
  // `candidateClasses` dynamically and re-hardcode `strata: ["core","stress"]` on the very next
  // line, discarding the four-category vocabulary it had just verified. A bank declaring four
  // categories now locks, and the derived vocabulary -- not a literal pair -- is what gets sealed
  // into the binary-instrument@1 analysis-plan parameters (§3.1 rule 3; no edit to compile.ts).
  test("locks a four-category bank and seals the declared stratum vocabulary into the analysis plan", () => {
    const fourCategoryItems: readonly AdmissionItemConfig[] = ["1", "2", "3", "4"].map((n, index) => ({
      itemId: `urn:uuid:00000000-0000-4000-8000-00000000000${n}`,
      question: `Category ${n} question`,
      referenceAnswer: `Category ${n} reference`,
      candidateAnswer: `Category ${n} candidate`,
      evidenceText: `Direct synthetic verification of the category ${n} item.`,
      provenance: {
        sourceCommitment: sha((["a", "b", "c", "d"] as const)[index]!),
        timestamp: "2026-03-09T00:00:00Z",
      },
      sources: [{ digest: { sha256: (["a", "b", "c", "d"] as const)[index]!.repeat(64) } }],
      truthLabel: index % 2 === 0 ? "CORRECT" : "WRONG",
      candidateClass: "factuality",
      stratum: `category-${n}`,
    }));
    const fixture = setUpFixture({ items: fourCategoryItems });
    const benchmark = JSON.parse(new TextDecoder().decode(getSealedBytes(workspaceDir, fixture.benchmarkSha256)));
    const parameters = compileBinaryInstrumentProfile({
      workspaceDir,
      draft: fixture.draft,
      benchmark,
    });
    expect(parameters.strata).toEqual(["category-1", "category-2", "category-3", "category-4"]);

    const compiled = compileDraft({
      workspaceDir,
      draft: fixture.draft,
      owner: "urn:uuid:00000000-0000-5000-8000-000000000001",
      closeAt: "2026-08-16T09:00:00.000Z",
    });
    const binaryInstrumentPlanEntry = compiled.plannedRun.record.analysisPlan!.find(
      (entry) => entry.method === BENCHMARKING_METHOD_IDS.binaryInstrument,
    );
    expect((binaryInstrumentPlanEntry?.parameters as { readonly strata: readonly string[] }).strata).toEqual([
      "category-1", "category-2", "category-3", "category-4",
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

  test("refuses when the authenticated screening instrument is also selected as a run judge arm", () => {
    const fixture = setUpFixture({ screeningInstrumentArmId: "alpha" });
    const benchmark = JSON.parse(new TextDecoder().decode(
      getSealedBytes(workspaceDir, fixture.benchmarkSha256),
    ));
    const error = expectProductError(() => compileBinaryInstrumentProfile({
      workspaceDir,
      draft: fixture.draft,
      benchmark,
    }));
    expect(error).toMatchObject({
      code: "conflict",
      issues: [{ path: "spec.arms.0.instrument" }],
    });
    expect(error.message).toMatch(/screening instrument cannot also be a run judge arm/u);
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

  test("fails closed on even k, non-sole assurance, and scalar instrument-pin drift", () => {
    const fixture = setUpFixture();
    const drifts: DraftDocument[] = [
      { ...fixture.draft, spec: { ...fixture.draft.spec, replicates: 2 } },
      { ...fixture.draft, spec: { ...fixture.draft.spec, assurance: { preset: "evaluator-panel" } } },
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

  // Spec §1.6 rule 1 / §10.2 ruling 4: the arm-count literal is gone. The real boundary is that
  // the Run's arm set must match the sealed selection arm-for-arm — a Run arm set that is merely
  // the wrong SIZE is one instance of that, not a special four-arm rule. This test used to slice
  // to three arms against a four-arm selection and pass "by coincidence" (spec §10.2); it now
  // names and asserts the actual boundary, and is paired with a six-arm positive case below that
  // a literal `4` would have refused.
  test("a Run arm set that does not match the sealed selection arm-for-arm refuses", () => {
    const fixture = setUpFixture();
    expect(() => compileDraft({
      workspaceDir,
      draft: { ...fixture.draft, spec: { ...fixture.draft.spec, arms: fixture.draft.spec.arms.slice(0, 3) } },
      owner: "urn:uuid:00000000-0000-5000-8000-000000000001",
      closeAt: "2026-08-16T09:00:00.000Z",
    })).toThrow(/one Run arm per sealed judge selection arm/u);
  });

  test("a Run arm set matching a six-arm sealed selection compiles with armCount six", () => {
    const fixture = setUpFixture({ arms: SIX_ARM_CONFIGS });
    const benchmark = JSON.parse(new TextDecoder().decode(getSealedBytes(workspaceDir, fixture.benchmarkSha256)));
    const parameters = compileBinaryInstrumentProfile({
      workspaceDir,
      draft: fixture.draft,
      benchmark,
    });
    expect(fixture.draft.spec.arms).toHaveLength(6);
    expect(parameters.judgeModelProfile).toBe("reasoning-2026-08");
  });

  test("a Run arm pinning the wrong model against its own selected arm refuses", () => {
    const fixture = setUpFixture();
    expect(() => compileDraft({
      workspaceDir,
      draft: {
        ...fixture.draft,
        spec: {
          ...fixture.draft.spec,
          arms: fixture.draft.spec.arms.map((arm, index) => index === 0
            ? { ...arm, pinning: { ...arm.pinning, model: { id: "gpt-4o-mini-2024-07-18" } } }
            : arm),
        },
      },
      owner: "urn:uuid:00000000-0000-5000-8000-000000000001",
      closeAt: "2026-08-16T09:00:00.000Z",
    })).toThrow(/does not exactly match the sealed Inspect binary-judge selection/u);
  });

  test("compileBinaryInstrumentProfile on a dated-snapshot draft seals judgeModelProfile: dated-snapshot-sampling", () => {
    const fixture = setUpFixture({
      arms: [
        { armId: "alpha", model: "gpt-4o-mini-2024-07-18", generation: samplingGeneration },
        { armId: "beta", model: "gpt-4o-mini-2024-07-18", generation: samplingGeneration },
      ],
      // Nothing on the compile path dereferences this digest: `validateRuntimeAndArms` only
      // requires the selection manifest to be schema-valid, and the schema only requires
      // `snapshotProbeSha256` to be PRESENT (not resolvable) when a bound arm's model is a dated
      // snapshot (spec §1.5 rule 2). Binding a real sealed probe record is round 4b's
      // (`core/src/operations/inspect-binary-judge.ts`) job.
      snapshotProbeSha256: sha("9"),
    });
    const benchmark = JSON.parse(new TextDecoder().decode(getSealedBytes(workspaceDir, fixture.benchmarkSha256)));
    const parameters = compileBinaryInstrumentProfile({
      workspaceDir,
      draft: fixture.draft,
      benchmark,
    });
    expect(parameters.judgeModelProfile).toBe("dated-snapshot-sampling");
  });

  test("a selection whose arms declare different models refuses at lock", () => {
    // Today's closed judge-model set is a bijection (one accepted model per profile), so two
    // different models always carry two different generation shapes, and the sealed selection
    // manifest's own cross-arm "one identical generation block" refinement
    // (`InspectBinaryJudgeSelectionManifestSchema`, `@colophon-claims/verify`) already refuses
    // before the schema parse can even succeed. `validateRuntimeAndArms`'s own model-uniformity
    // refusal (spec §1.6, change 1 item 5) is therefore unreachable defense-in-depth through this
    // public surface today, and only becomes independently reachable once a profile admits more
    // than one accepted model id. This test asserts the observable behavior the spec asks for —
    // different models refuse at lock — holds now, under whichever refusal actually fires first.
    const fixture = setUpFixture({
      arms: [
        { armId: "alpha", model: "gpt-5.6-luna", generation },
        { armId: "beta", model: "gpt-4o-mini-2024-07-18", generation: samplingGeneration },
      ],
    });
    const benchmark = JSON.parse(new TextDecoder().decode(getSealedBytes(workspaceDir, fixture.benchmarkSha256)));
    expect(() => compileBinaryInstrumentProfile({
      workspaceDir,
      draft: fixture.draft,
      benchmark,
    })).toThrow();
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

const OWNER = "urn:uuid:00000000-0000-5000-8000-000000000001";
const CLOSE_AT = "2026-08-16T09:00:00.000Z";

// packet #2837: `pairwise-disagreement@1` and `paired-majority-delta@1` share their whole front
// half (spec §7.5) with each other -- NOT with `compileBinaryInstrumentProfile` above, which is
// left untouched -- and are typically `additionalAnalyses` entries alongside a binary-instrument
// primary (the "real judge shape").
describe("pairwise-disagreement@1 and paired-majority-delta@1 shared derivation (packet #2837)", () => {
  function withAdditionalAnalyses(draft: DraftDocument, additionalAnalyses: DraftDocument["spec"]["additionalAnalyses"]): DraftDocument {
    return { ...draft, spec: { ...draft.spec, additionalAnalyses } };
  }

  test("compiles pairwise-disagreement@1 as an additionalAnalyses entry alongside a binary-instrument primary, sealing the shared eight-parameter closure plus intervalAlpha", () => {
    const fixture = setUpFixture();
    const draft = withAdditionalAnalyses(fixture.draft, [
      { method: BENCHMARKING_METHOD_IDS.pairwiseDisagreement, version: BENCHMARKING_METHOD_VERSION },
    ]);
    const compiled = compileDraft({ workspaceDir, draft, owner: OWNER, closeAt: CLOSE_AT });
    const plan = compiled.plannedRun.record.analysisPlan!;
    expect(plan.map((entry) => entry.method)).toEqual([
      BENCHMARKING_METHOD_IDS.wilson,
      BENCHMARKING_METHOD_IDS.binaryInstrument,
      BENCHMARKING_METHOD_IDS.pairwiseDisagreement,
    ]);
    const expectedParameters = {
      verdictRule: "sole",
      k: 3,
      reduction: "strict-majority",
      measurementProfile: BINARY_INSTRUMENT_MEASUREMENT_PROFILE,
      candidateClasses: ["alpha", "zeta"],
      strata: ["core", "stress"],
      parserInvalidPolicy: "reject",
      truthAdmission: "operator-only",
      intervalAlpha: "0.05",
    };
    expect(plan[2]!.parameters).toEqual(expectedParameters);
    expect(validatePairwiseDisagreementParameters(plan[2]!.parameters as Readonly<Record<string, unknown>>).ok).toBe(true);

    // Same derivation, called directly rather than through the compile seam.
    const benchmark = JSON.parse(new TextDecoder().decode(getSealedBytes(workspaceDir, fixture.benchmarkSha256)));
    const direct = compilePairwiseDisagreementProfile({
      workspaceDir, draft: fixture.draft, benchmark,
      analysis: { method: BENCHMARKING_METHOD_IDS.pairwiseDisagreement, version: BENCHMARKING_METHOD_VERSION },
    });
    expect(direct).toEqual(expectedParameters);
  });

  test("derives baseline (evidence-free twin) and candidate (evidence-declaring arm) for paired-majority-delta@1, sealing the three frozen constants FROM the aggregate package's own exports", () => {
    const fixture = setUpFixture({
      arms: [
        { armId: "alpha", model: "gpt-5.6-luna", generation },
        { armId: "beta", model: "gpt-5.6-luna", generation },
      ],
      withItemEvidence: true,
      declaringArmIds: ["beta"],
    });
    const draft = withAdditionalAnalyses(fixture.draft, [
      { method: BENCHMARKING_METHOD_IDS.pairedMajorityDelta, version: BENCHMARKING_METHOD_VERSION },
    ]);
    const compiled = compileDraft({ workspaceDir, draft, owner: OWNER, closeAt: CLOSE_AT });
    const plan = compiled.plannedRun.record.analysisPlan!;
    const entry = plan.find((planEntry) => planEntry.method === BENCHMARKING_METHOD_IDS.pairedMajorityDelta)!;
    expect(entry.parameters).toEqual({
      verdictRule: "sole",
      k: 3,
      reduction: "strict-majority",
      measurementProfile: BINARY_INSTRUMENT_MEASUREMENT_PROFILE,
      candidateClasses: ["alpha", "zeta"],
      strata: ["core", "stress"],
      parserInvalidPolicy: "reject",
      truthAdmission: "operator-only",
      // candidate = the evidence-declaring arm ("beta"); baseline = its evidence-free twin
      // ("alpha") -- the coordinator ruling this derivation implements.
      baseline: "alpha",
      candidate: "beta",
      seed: PAIRED_MAJORITY_DELTA_SEED,
      resamples: PAIRED_MAJORITY_DELTA_RESAMPLES,
      alpha: PAIRED_MAJORITY_DELTA_ALPHA,
    });
    expect(validatePairedMajorityDeltaParameters(entry.parameters as Readonly<Record<string, unknown>>).ok).toBe(true);
  });

  // packet #2837, RULING C2: the derivation is STRUCTURAL, never a literal arm count. §1.6's
  // no-literal-counts rule is frozen for this family, and the ratified flagship is a six-arm panel,
  // so an `arms.length !== 2` ban would have banned the flagship shape itself. The four tests below
  // pin the replacement: ambiguity refuses BY NAME, and an unambiguous six-arm roster resolves.
  test("refuses when several arms are stripped-identical to the declaring arm, naming every candidate twin", () => {
    // Default fixture: four arms sharing one preamble, "beta" declares evidence. Stripping beta's
    // evidence interpolation makes it identical to all three others, so the twin is ambiguous.
    const fixture = setUpFixture({ withItemEvidence: true, declaringArmIds: ["beta"] });
    const draft = withAdditionalAnalyses(fixture.draft, [
      { method: BENCHMARKING_METHOD_IDS.pairedMajorityDelta, version: BENCHMARKING_METHOD_VERSION },
    ]);
    expect(() => compileDraft({ workspaceDir, draft, owner: OWNER, closeAt: CLOSE_AT }))
      .toThrow(/found 3 evidence-free twins for declaring arm "beta".*"alpha".*"delta".*"gamma"/su);
  });

  test("derives the pair on a SIX-arm panel: one declaring arm, its stripped-identical twin, and four unrelated arms", () => {
    // The ratified flagship shape. "beta" declares evidence and "alpha" shares its template, so
    // stripping beta's evidence interpolation makes the two identical. The other four carry
    // distinct preambles, so none of them is a twin and the pair is unambiguous.
    const fixture = setUpFixture({
      withItemEvidence: true,
      declaringArmIds: ["beta"],
      arms: [
        { armId: "alpha", model: "gpt-5.6-luna", generation },
        { armId: "beta", model: "gpt-5.6-luna", generation },
        { armId: "delta", model: "gpt-5.6-luna", generation, preamble: "Delta rubric. " },
        { armId: "epsilon", model: "gpt-5.6-luna", generation, preamble: "Epsilon rubric. " },
        { armId: "gamma", model: "gpt-5.6-luna", generation, preamble: "Gamma rubric. " },
        { armId: "zeta", model: "gpt-5.6-luna", generation, preamble: "Zeta rubric. " },
      ],
    });
    const draft = withAdditionalAnalyses(fixture.draft, [
      { method: BENCHMARKING_METHOD_IDS.pairedMajorityDelta, version: BENCHMARKING_METHOD_VERSION },
    ]);
    const compiled = compileDraft({ workspaceDir, draft, owner: OWNER, closeAt: CLOSE_AT });
    const plan = compiled.plannedRun.record.analysisPlan!;
    const entry = plan.find((planEntry) => planEntry.method === BENCHMARKING_METHOD_IDS.pairedMajorityDelta)!;
    const parameters = entry.parameters as Readonly<Record<string, unknown>>;
    // candidate = the evidence-declaring arm; baseline = its evidence-free twin. Four unrelated
    // arms are present and none of them is named.
    expect(parameters["candidate"]).toBe("beta");
    expect(parameters["baseline"]).toBe("alpha");
    expect(validatePairedMajorityDeltaParameters(parameters).ok).toBe(true);
  });

  test("refuses a six-arm panel carrying TWO stripped-identical candidates for the declaring arm", () => {
    // "alpha" and "zeta" both share "beta"'s template, so stripping beta's evidence interpolation
    // leaves two equally good twins. The method must refuse rather than pick one.
    const fixture = setUpFixture({
      withItemEvidence: true,
      declaringArmIds: ["beta"],
      arms: [
        { armId: "alpha", model: "gpt-5.6-luna", generation },
        { armId: "beta", model: "gpt-5.6-luna", generation },
        { armId: "delta", model: "gpt-5.6-luna", generation, preamble: "Delta rubric. " },
        { armId: "epsilon", model: "gpt-5.6-luna", generation, preamble: "Epsilon rubric. " },
        { armId: "gamma", model: "gpt-5.6-luna", generation, preamble: "Gamma rubric. " },
        { armId: "zeta", model: "gpt-5.6-luna", generation },
      ],
    });
    const draft = withAdditionalAnalyses(fixture.draft, [
      { method: BENCHMARKING_METHOD_IDS.pairedMajorityDelta, version: BENCHMARKING_METHOD_VERSION },
    ]);
    expect(() => compileDraft({ workspaceDir, draft, owner: OWNER, closeAt: CLOSE_AT }))
      .toThrow(/found 2 evidence-free twins for declaring arm "beta".*"alpha".*"zeta"/su);
  });

  test("refuses when no arm is stripped-identical to the declaring arm", () => {
    // Two arms, but the non-declaring one carries a different rubric, so it is not beta's twin.
    const fixture = setUpFixture({
      withItemEvidence: true,
      declaringArmIds: ["beta"],
      arms: [
        { armId: "alpha", model: "gpt-5.6-luna", generation, preamble: "A different rubric. " },
        { armId: "beta", model: "gpt-5.6-luna", generation },
      ],
    });
    const draft = withAdditionalAnalyses(fixture.draft, [
      { method: BENCHMARKING_METHOD_IDS.pairedMajorityDelta, version: BENCHMARKING_METHOD_VERSION },
    ]);
    expect(() => compileDraft({ workspaceDir, draft, owner: OWNER, closeAt: CLOSE_AT }))
      .toThrow(/found no evidence-free twin for declaring arm "beta"/u);
  });

  test("refuses when zero arms declare evidence (the twin has no pair to name)", () => {
    const fixture = setUpFixture({
      arms: [
        { armId: "alpha", model: "gpt-5.6-luna", generation },
        { armId: "beta", model: "gpt-5.6-luna", generation },
      ],
    });
    const draft = withAdditionalAnalyses(fixture.draft, [
      { method: BENCHMARKING_METHOD_IDS.pairedMajorityDelta, version: BENCHMARKING_METHOD_VERSION },
    ]);
    expect(() => compileDraft({ workspaceDir, draft, owner: OWNER, closeAt: CLOSE_AT }))
      .toThrow(/exactly one arm whose instrument declares evidence.*found 0/u);
  });

  test("refuses when both arms declare evidence (the pair is not well formed)", () => {
    const fixture = setUpFixture({
      arms: [
        { armId: "alpha", model: "gpt-5.6-luna", generation },
        { armId: "beta", model: "gpt-5.6-luna", generation },
      ],
      withItemEvidence: true,
      declaringArmIds: ["alpha", "beta"],
    });
    const draft = withAdditionalAnalyses(fixture.draft, [
      { method: BENCHMARKING_METHOD_IDS.pairedMajorityDelta, version: BENCHMARKING_METHOD_VERSION },
    ]);
    expect(() => compileDraft({ workspaceDir, draft, owner: OWNER, closeAt: CLOSE_AT }))
      .toThrow(/exactly one arm whose instrument declares evidence.*found 2/u);
  });

  test("both derivations refuse caller-supplied analysis.parameters with the identical shared-front-half message (the front half is one function, two callers)", () => {
    const fixture = setUpFixture();
    for (const method of [BENCHMARKING_METHOD_IDS.pairwiseDisagreement, BENCHMARKING_METHOD_IDS.pairedMajorityDelta]) {
      // A non-`k` key exercises the shared front half's GENERIC "callers must not supply them"
      // refusal; `k` specifically has its own more-specific message, checked first (both shared,
      // both identical between the two callers — proven by the loop over both methods here).
      const draft = withAdditionalAnalyses(fixture.draft, [
        { method, version: BENCHMARKING_METHOD_VERSION, parameters: { candidateClasses: ["alpha"] } },
      ]);
      expect(() => compileDraft({ workspaceDir, draft, owner: OWNER, closeAt: CLOSE_AT }))
        .toThrow(/parameters are derived from the draft and sealed evidence; callers must not supply them/u);
    }
  });

  test("both derivations refuse a caller-supplied baseline/candidate at spec.additionalAnalyses.i, not spec.analysis — pairwise-disagreement because it is non-comparative, paired-majority-delta because it derives its own pair", () => {
    const fixture = setUpFixture();
    const benchmark = JSON.parse(new TextDecoder().decode(getSealedBytes(workspaceDir, fixture.benchmarkSha256)));

    const pairwiseError = expectProductError(() => compilePairwiseDisagreementProfile({
      workspaceDir,
      draft: fixture.draft,
      benchmark,
      analysis: {
        method: BENCHMARKING_METHOD_IDS.pairwiseDisagreement,
        version: BENCHMARKING_METHOD_VERSION,
        baseline: "alpha",
        candidate: "beta",
      },
      pathPrefix: "spec.additionalAnalyses.0",
    }));
    expect(pairwiseError.code).toBe("validation");
    expect(pairwiseError.issues).toEqual([{
      path: "spec.additionalAnalyses.0",
      message: "pairwise-disagreement computes all unordered arm pairs in one pass and does not accept baseline or candidate arms",
    }]);

    // Index 1, not 0: proves the refusal uses `pathPrefix` (`spec.additionalAnalyses.${i}`) rather
    // than a hardcoded additional-analyses[0] path or the primary `"spec.analysis"`.
    const pairedError = expectProductError(() => compilePairedMajorityDeltaProfile({
      workspaceDir,
      draft: fixture.draft,
      benchmark,
      analysis: {
        method: BENCHMARKING_METHOD_IDS.pairedMajorityDelta,
        version: BENCHMARKING_METHOD_VERSION,
        baseline: "alpha",
        candidate: "beta",
      },
      pathPrefix: "spec.additionalAnalyses.1",
    }));
    expect(pairedError.code).toBe("validation");
    expect(pairedError.issues).toEqual([{
      path: "spec.additionalAnalyses.1",
      message: "paired-majority-delta derives its own baseline/candidate from the evidence-declaring arm and does not accept caller-supplied baseline or candidate arms",
    }]);

    // The additionalAnalyses compile seam still refuses these entries (message preserved through
    // planFromSpec's wrap). Direct compiler calls above are what pin the pathPrefix.
    const pairwiseDraft = withAdditionalAnalyses(fixture.draft, [
      { method: BENCHMARKING_METHOD_IDS.pairwiseDisagreement, version: BENCHMARKING_METHOD_VERSION, baseline: "alpha", candidate: "beta" },
    ]);
    expect(() => compileDraft({ workspaceDir, draft: pairwiseDraft, owner: OWNER, closeAt: CLOSE_AT }))
      .toThrow(/pairwise-disagreement computes all unordered arm pairs/u);
    const pairedDraft = withAdditionalAnalyses(fixture.draft, [
      { method: BENCHMARKING_METHOD_IDS.pairedMajorityDelta, version: BENCHMARKING_METHOD_VERSION, baseline: "alpha", candidate: "beta" },
    ]);
    expect(() => compileDraft({ workspaceDir, draft: pairedDraft, owner: OWNER, closeAt: CLOSE_AT }))
      .toThrow(/paired-majority-delta derives its own baseline\/candidate/u);
  });

  test("both derivations refuse a version other than the registered shared version, with the identical shared-front-half message", () => {
    const fixture = setUpFixture();
    for (const method of [BENCHMARKING_METHOD_IDS.pairwiseDisagreement, BENCHMARKING_METHOD_IDS.pairedMajorityDelta]) {
      const draft = withAdditionalAnalyses(fixture.draft, [{ method, version: "2" }]);
      expect(() => compileDraft({ workspaceDir, draft, owner: OWNER, closeAt: CLOSE_AT }))
        .toThrow(/requires version 1/u);
    }
  });

  test("preview compilation carries the binary-judgment-intake extension for a pairwise-disagreement-only draft (no binary-instrument primary)", () => {
    // The primary is wilson, not binary-instrument -- `binaryParameters` alone would be undefined,
    // and without the widened extension gate the subset Benchmark would silently drop the
    // admission-manifest reference the shared derivation needs.
    const fixture = setUpFixture();
    const draft = withAdditionalAnalyses(
      { ...fixture.draft, spec: { ...fixture.draft.spec, analysis: undefined } },
      [{ method: BENCHMARKING_METHOD_IDS.pairwiseDisagreement, version: BENCHMARKING_METHOD_VERSION }],
    );
    const preview = compilePreviewRun({ workspaceDir, draft, owner: OWNER, closeAt: CLOSE_AT, itemLimit: 1 });
    expect(preview.previewBenchmarkRecord.items).toHaveLength(1);
    expect((preview.previewBenchmarkRecord as unknown as Record<string, unknown>)[BINARY_ITEM_BANK_INTAKE_EXTENSION])
      .toEqual((JSON.parse(new TextDecoder().decode(getSealedBytes(workspaceDir, fixture.benchmarkSha256))) as Record<string, unknown>)[BINARY_ITEM_BANK_INTAKE_EXTENSION]);
    expect(preview.plannedRun.record.analysisPlan!.map((entry) => entry.method)).toEqual([
      BENCHMARKING_METHOD_IDS.wilson,
      BENCHMARKING_METHOD_IDS.pairwiseDisagreement,
    ]);
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
    // Spec §1.4 clause 4: the two reviewer-protocol strings are claims about a two-reviewer
    // protocol and are emitted only for truthAdmission === "two-human-unanimous". An
    // operator-only run has no reviewers and no visibility receipts at all, so `operator` is no
    // longer `[...human, operatorOnly]` — it drops reviewerKeyPerson and cognitiveBlinding.
    expect(operator).toEqual([
      BINARY_INSTRUMENT_REPORT_LIMITATIONS.mutableModelAlias,
      BINARY_INSTRUMENT_REPORT_LIMITATIONS.operatorOnly,
    ]);
    expect(operator.join(" ")).not.toMatch(/\b(?:rank|ranking|select|selection|winner|loser)\b/iu);
  });

  test("mutableModelAlias is present only for the reasoning-2026-08 profile (spec §1.4 clauses 2-3)", () => {
    const datedSnapshot = binaryInstrumentReportLimitations({
      ...base,
      truthAdmission: "operator-only",
      judgeModelProfile: "dated-snapshot-sampling",
    });
    expect(datedSnapshot).toEqual([BINARY_INSTRUMENT_REPORT_LIMITATIONS.operatorOnly]);

    const reasoningExplicit = binaryInstrumentReportLimitations({
      ...base,
      truthAdmission: "operator-only",
      judgeModelProfile: "reasoning-2026-08",
    });
    const profileAbsent = binaryInstrumentReportLimitations({
      ...base,
      truthAdmission: "operator-only",
    });
    // The absent case IS the compatibility proof (spec §1.4 clause 2, §10.2 fixture ruling 1):
    // every parameter set sealed before this packet has no judgeModelProfile key, and it must
    // emit byte-identically to the explicit reasoning-2026-08 case, or the two frozen 144-cell
    // golden fixtures move.
    expect(profileAbsent).toEqual(reasoningExplicit);
    expect(profileAbsent).toEqual([
      BINARY_INSTRUMENT_REPORT_LIMITATIONS.mutableModelAlias,
      BINARY_INSTRUMENT_REPORT_LIMITATIONS.operatorOnly,
    ]);
  });
});
