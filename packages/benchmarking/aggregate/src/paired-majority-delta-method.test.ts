import { createHash } from "node:crypto";
import {
  BENCHMARKING_PROTOCOL,
  cellKey,
  compareCodeUnitStrings,
  parseMatrix,
  sealMatrix,
  sealRun,
  type MatrixRecord,
  type Outcome,
} from "@jinn-network/benchmarking-records";
import { sealTask } from "@jinn-network/task-execution-protocol";
import {
  canonicalJsonBytes,
  recordDigest,
  sealDsseEnvelope,
} from "@jinn-network/trust-core";
import { describe, expect, test } from "vitest";
import {
  computePairedMajorityDelta,
  PAIRED_MAJORITY_DELTA_ALPHA,
  PAIRED_MAJORITY_DELTA_PARAMETER_SCHEMA,
  PAIRED_MAJORITY_DELTA_RESAMPLES,
  PAIRED_MAJORITY_DELTA_SEED,
  validatePairedMajorityDeltaParameters,
} from "./paired-majority-delta-method.js";
import { createMethodRegistry } from "./registry.js";
import type { MethodComputeInput } from "./method.js";

// Synthetic fixture only (license law, spec §0.3): every id, digest, and prompt below is
// original to this test. Arms are referred to by role ("baseline"/"candidate"), never by
// publisher.

const INSTRUMENT_KEY = "network.jinn.binary-judgment.instrument";
const ITEM_COMMITMENT_KEY = "network.jinn.binary-judgment.item-sha256";
const TASK_PROTOCOL = "https://spec.jinn.network/profiles/task-execution/v1";
const TASK_PROFILE_URI = "https://spec.jinn.network/task-profiles/binary-judgment/2.0";
const TASK_PROFILE_SHA256 = "ebb34d8362e2cc3135847a5ad6f3ee3d9c2d9922a2b827aa9dfcbaf440b22557";
const INSTRUMENT_PROTOCOL = "https://spec.jinn.network/binary-judgment/judge-instrument/v1";
const OBSERVATION_PROTOCOL = "https://spec.jinn.network/binary-judgment/judge-observation/v1";
const ANALYSIS_PROTOCOL = "https://spec.jinn.network/binary-judgment/analysis-context/v1";
const LABEL_RESOLUTION_PROTOCOL = "https://spec.jinn.network/binary-judgment/label-resolution/v1";
const SPEC_PROTOCOL = "https://spec.jinn.network/profiles/evaluation-spec/v1";
const PARSER_ID = "network.jinn.parser.binary-judgment-evaluation";
const PARSER_VERSION = "1.0.0";
const EVALUATION_METHOD_DIGEST = "sha256:5a2c2d2f01c9154bb7000f3c3183d1fc27e9e9a1571445f248b56fa25f45ef0a" as const;
const RESPONSE_PARSER_ID = "network.jinn.parser.binary-accept-reject";
const RESPONSE_PARSER_VERSION = "1.0.0";
const RESPONSE_PARSER_DIGEST = "sha256:02aa652770de9e74415cd206c8741b6148e3ea82c21773983a6d8c66030d0073" as const;
const RESPONSE_MEDIA_TYPE = "text/plain; charset=utf-8";
const OBSERVATION_MEDIA_TYPE = "application/vnd.jinn.binary-judgment.observation.v1+json";
const INSPECT_LOG_MEDIA_TYPE = "application/vnd.inspect-ai.eval-log+json";
const ANALYSIS_MEDIA_TYPE = "application/vnd.jinn.binary-judgment.analysis-context.v1+json";
const LABEL_MEDIA_TYPE = "application/vnd.jinn.binary-judgment.label-resolution.v1+json";
const RUN_OWNER = "urn:uuid:77777777-7777-5777-8777-777777777777";
const JUDGE_MODEL = "gpt-5.6-luna";
const OBSERVATION_LIMITATIONS = ["mutable-model-alias"] as const;

const MEASUREMENTS = [
  ["judgeDecision", "string"],
  ["truthLabel", "string"],
  ["agreement", "boolean"],
  ["parseValid", "boolean"],
  ["candidateClass", "string"],
  ["stratum", "string"],
  ["labelResolutionSha256", "string"],
  ["instrumentSha256", "string"],
] as const;

const GENERATION = {
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

const K = 1;
const ARM_IDS = ["baseline", "candidate"] as const;
const PARAMETERS = {
  verdictRule: "sole",
  k: K,
  reduction: "strict-majority",
  measurementProfile: "binary-instrument@1",
  // Declared vocabulary is a superset of what the items actually use ("borderline" and "outlier"
  // never appear), so both slice families exercise the empty-slice path.
  candidateClasses: ["borderline", "contradiction", "factual"],
  strata: ["core", "outlier", "stress"],
  parserInvalidPolicy: "reject",
  truthAdmission: "two-human-unanimous",
  baseline: "baseline",
  candidate: "candidate",
  seed: PAIRED_MAJORITY_DELTA_SEED,
  resamples: PAIRED_MAJORITY_DELTA_RESAMPLES,
  alpha: PAIRED_MAJORITY_DELTA_ALPHA,
} as const;

function sha(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function resourceDigest(value: unknown): `sha256:${string}` {
  return recordDigest(canonicalJsonBytes(value));
}

function exactUuid(value: string): string {
  return `urn:uuid:${sha(value).slice(0, 8)}-0000-5000-8000-000000000000`;
}

function agrees(decision: "ACCEPT" | "REJECT", truthLabel: "CORRECT" | "WRONG"): boolean {
  return (decision === "ACCEPT" && truthLabel === "CORRECT")
    || (decision === "REJECT" && truthLabel === "WRONG");
}

function sourceDescriptor(seed: string) {
  return { uri: `https://example.test/${seed}`, digest: { sha256: sha(seed) } };
}

function makeInstrument(armId: string) {
  const messages = [
    {
      role: "developer",
      segments: [
        { literal: "Question: " },
        { field: "question" },
        { literal: "\nReference: " },
        { field: "referenceAnswer" },
        { literal: "\nCandidate: " },
        { field: "candidateAnswer" },
      ],
    },
    { role: "user", segments: [{ literal: "Return exactly ACCEPT or REJECT." }] },
  ];
  return {
    protocol: INSTRUMENT_PROTOCOL,
    instrumentId: armId,
    messages,
    promptTemplateSha256: resourceDigest(messages),
    promptSource: sourceDescriptor(`prompt-${armId}`),
    license: sourceDescriptor(`license-${armId}`),
    attribution: sourceDescriptor(`attribution-${armId}`),
    model: { adapter: "jinn-openai", requested: JUDGE_MODEL, generation: GENERATION },
    response: {
      mediaType: RESPONSE_MEDIA_TYPE,
      parser: { id: RESPONSE_PARSER_ID, version: RESPONSE_PARSER_VERSION, digest: RESPONSE_PARSER_DIGEST },
      invalidOutputDecision: "REJECT",
    },
  };
}

function semanticRequestDigest(
  payload: Record<string, unknown>,
  instrument: ReturnType<typeof makeInstrument>,
): `sha256:${string}` {
  const rendered = instrument.messages.map((message) => ({
    role: message.role,
    text: message.segments.map((segment) => (
      "literal" in segment ? segment.literal : payload[(segment as { field: string }).field]
    )).join(""),
  }));
  return resourceDigest({ model: instrument.model.requested, messages: rendered, generation: instrument.model.generation });
}

type Decision = "ACCEPT" | "REJECT" | "EXCLUDED";

interface ItemSpec {
  readonly id: string;
  readonly truthLabel: "CORRECT" | "WRONG";
  readonly candidateClass: string;
  readonly stratum: string;
  /** Provenance source key: items sharing a key land in the same source cluster. */
  readonly source: string;
  readonly decisions: Readonly<Record<(typeof ARM_IDS)[number], Decision>>;
}

// Six paired items across two source clusters (A: i1-i3, B: i5-i7), one excluded item (i4, on
// the candidate arm), and per-task deltas spanning the full {-1, 0, +1} unit:
//   i1: 0   i2: +1   i3: -1   i4: (excluded, not paired)   i5: +1   i6: +1   i7: 0
// n=6, clusters=2 -> both withholding gates clear at top level, so the interval computes.
// Sum=2, mean=2/6=0.3333: candidate agrees more overall (the direction case).
const ITEMS: readonly ItemSpec[] = [
  { id: "i1", truthLabel: "CORRECT", candidateClass: "factual", stratum: "core", source: "source-a", decisions: { baseline: "ACCEPT", candidate: "ACCEPT" } },
  { id: "i2", truthLabel: "WRONG", candidateClass: "factual", stratum: "stress", source: "source-a", decisions: { baseline: "REJECT", candidate: "ACCEPT" } },
  { id: "i3", truthLabel: "CORRECT", candidateClass: "contradiction", stratum: "core", source: "source-a", decisions: { baseline: "ACCEPT", candidate: "REJECT" } },
  { id: "i4", truthLabel: "WRONG", candidateClass: "contradiction", stratum: "stress", source: "source-b", decisions: { baseline: "ACCEPT", candidate: "EXCLUDED" } },
  { id: "i5", truthLabel: "WRONG", candidateClass: "factual", stratum: "core", source: "source-b", decisions: { baseline: "REJECT", candidate: "ACCEPT" } },
  { id: "i6", truthLabel: "WRONG", candidateClass: "contradiction", stratum: "stress", source: "source-b", decisions: { baseline: "REJECT", candidate: "ACCEPT" } },
  { id: "i7", truthLabel: "CORRECT", candidateClass: "factual", stratum: "core", source: "source-b", decisions: { baseline: "ACCEPT", candidate: "ACCEPT" } },
];

interface Closure {
  readonly input: MethodComputeInput;
  readonly matrix: MatrixRecord;
  readonly subjectSha256: string;
  readonly taskDigestById: Readonly<Record<string, string>>;
}

/** Builds a full digest-bound closure (Run, Tasks, EvaluationSpecs, analysis contexts, label
 * resolutions, judge observations, DSSE-sealed Result Evaluations) for an arbitrary item list,
 * mirroring pairwise-disagreement-method.test.ts's harness but keyed to the two named arms
 * `baseline`/`candidate` and to a per-item provenance `source` (spec §7.2a's reshaped
 * `Task.payload.provenance`, so `resolveTaskProvenance` admits every Task). */
function buildClosure(items: readonly ItemSpec[], parameters: Readonly<Record<string, unknown>> = PARAMETERS): Closure {
  const records = new Map<string, Uint8Array>();
  const put = (bytes: Uint8Array): `sha256:${string}` => {
    const digest = recordDigest(bytes) as `sha256:${string}`;
    records.set(digest, bytes);
    return digest;
  };

  const instruments = new Map<string, `sha256:${string}`>();
  const instrumentDocuments = new Map<string, ReturnType<typeof makeInstrument>>();
  for (const armId of ARM_IDS) {
    const document = makeInstrument(armId);
    instrumentDocuments.set(armId, document);
    instruments.set(armId, put(canonicalJsonBytes(document)));
  }

  const taskDigestById: Record<string, string> = {};
  const cells: MatrixRecord["cells"][number][] = [];

  for (const item of items) {
    const itemId = exactUuid(item.id);
    const payload = {
      itemId,
      question: `What is the synthetic answer for ${item.id}?`,
      referenceAnswer: "reference",
      candidateAnswer: item.truthLabel === "CORRECT" ? "reference" : "different",
      provenance: { sourceCommitment: `sha256:${sha(item.source)}`, timestamp: "2026-08-14T22:00:00Z" },
      sources: [{ digest: { sha256: sha(item.source) } }],
    };
    const itemSha256 = resourceDigest(payload);
    const labelResolutionSha256 = put(canonicalJsonBytes({
      protocol: LABEL_RESOLUTION_PROTOCOL,
      itemSha256,
      itemId,
      truthLabel: item.truthLabel,
      candidateClass: item.candidateClass,
      stratum: item.stratum,
      resolvedAt: "2026-08-14T23:00:00Z",
      truthAdmission: "two-human-unanimous",
      humanReviewEvaluationSpecSha256: `sha256:${"1".repeat(64)}`,
      reviewVerdictSha256s: [`sha256:${"2".repeat(64)}`, `sha256:${"3".repeat(64)}`],
      reviewerRosterSha256: `sha256:${"4".repeat(64)}`,
      visibilityReceiptSha256s: [`sha256:${"5".repeat(64)}`, `sha256:${"6".repeat(64)}`],
      revealReceiptSha256: `sha256:${"7".repeat(64)}`,
    }));
    const analysisContextSha256 = put(canonicalJsonBytes({
      protocol: ANALYSIS_PROTOCOL,
      itemSha256,
      itemId,
      labelResolutionSha256,
      truthLabel: item.truthLabel,
      candidateClass: item.candidateClass,
      stratum: item.stratum,
    }));
    const evaluationSpecSha256 = put(canonicalJsonBytes({
      protocol: SPEC_PROTOCOL,
      semanticsVersion: "4",
      family: "deterministic-process",
      grader: { name: PARSER_ID, digest: { sha256: EVALUATION_METHOD_DIGEST.slice("sha256:".length) }, accessClass: "public" },
      familyBlock: {
        image: { name: "binary-judgment-evaluation-parser-semantics.json", digest: { sha256: EVALUATION_METHOD_DIGEST.slice("sha256:".length) } },
        platform: "linux/amd64",
        workspace: {},
        testMaterial: [{
          name: "analysis-context.json",
          digest: { sha256: analysisContextSha256.slice("sha256:".length) },
          mediaType: ANALYSIS_MEDIA_TYPE,
          accessClass: "private",
        }],
        parser: { id: PARSER_ID, version: PARSER_VERSION, digest: EVALUATION_METHOD_DIGEST },
        transitions: { failToPass: [], passToPass: [] },
        timeout: 60,
      },
      measurements: MEASUREMENTS.map(([name, type]) => ({ name, type, required: true })),
      verdictRule: { threshold: { measurement: "agreement", op: "eq", value: true } },
      unscorable: [],
      evidenceConventions: { requiredRefs: ["label-resolution.json"] },
    }));
    const taskBytes = sealTask({
      protocol: TASK_PROTOCOL,
      profile: { uri: TASK_PROFILE_URI, digest: { sha256: TASK_PROFILE_SHA256 } },
      instructions: "Return exactly ACCEPT or REJECT.",
      payload,
      outputs: [
        { name: "judge-response", mediaType: RESPONSE_MEDIA_TYPE, required: true },
        { name: "judge-observation", mediaType: OBSERVATION_MEDIA_TYPE, required: true },
        { name: "inspect-log", mediaType: INSPECT_LOG_MEDIA_TYPE, required: false },
      ],
      evaluation: { digest: { sha256: evaluationSpecSha256.slice("sha256:".length) } },
      author: "did:key:z6Mksynthetic",
      [ITEM_COMMITMENT_KEY]: itemSha256,
    });
    const taskWire = put(taskBytes);
    const taskHex = taskWire.slice("sha256:".length);
    taskDigestById[item.id] = taskHex;

    for (const armId of ARM_IDS) {
      const decision = item.decisions[armId];
      const key = cellKey(taskHex, armId, 1);
      const instrument = instrumentDocuments.get(armId)!;
      if (decision === "EXCLUDED") {
        cells.push({
          cellKey: key,
          taskDigest: taskHex,
          armId,
          replicate: 1,
          dispatches: 1,
          accounted: 1,
          submission: `sha256:${sha(`submission:${key}`)}` as const,
          verdicts: [],
          validVerdicts: [],
          outcome: "expired" as Outcome,
          verification: { harness: "match" as const, model: "match" as const, loadout: "match" as const, isolation: "match" as const, checksFailed: [] },
          integrityTier: "re-derivable" as const,
        });
        continue;
      }
      const parseValid = true;
      const responseBytes = new TextEncoder().encode(decision);
      const responseSha256 = put(responseBytes);
      const observationSha256 = put(canonicalJsonBytes({
        protocol: OBSERVATION_PROTOCOL,
        taskDigest: `sha256:${taskHex}`,
        armId,
        replicate: 1,
        instrumentSha256: instruments.get(armId)!,
        requestSha256: semanticRequestDigest(payload, instrument),
        response: { digest: responseSha256, mediaType: RESPONSE_MEDIA_TYPE },
        provider: {
          requestedModel: JUDGE_MODEL,
          resolvedModel: JUDGE_MODEL,
          responseId: `resp_${sha(key).slice(0, 16)}`,
          eventSha256: `sha256:${sha(`event:${key}`)}`,
          usage: { inputTokens: 10, outputTokens: 1, totalTokens: 11 },
        },
        call: { count: 1, retries: 0, fallbacks: 0 },
        limitations: [...OBSERVATION_LIMITATIONS],
      }));
      const agreement = agrees(decision, item.truthLabel);
      const measurements = [
        { name: "judgeDecision", value: decision },
        { name: "truthLabel", value: item.truthLabel },
        { name: "agreement", value: agreement },
        { name: "parseValid", value: parseValid },
        { name: "candidateClass", value: item.candidateClass },
        { name: "stratum", value: item.stratum },
        { name: "labelResolutionSha256", value: labelResolutionSha256 },
        { name: "instrumentSha256", value: instruments.get(armId)! },
      ];
      const statement = {
        _type: "https://in-toto.io/Statement/v1",
        subject: [
          { name: "task.json", digest: { sha256: taskHex } },
          { name: "judge-response", digest: { sha256: responseSha256.slice("sha256:".length) }, mediaType: RESPONSE_MEDIA_TYPE },
          { name: "judge-observation", digest: { sha256: observationSha256.slice("sha256:".length) }, mediaType: OBSERVATION_MEDIA_TYPE },
        ],
        predicateType: "https://spec.jinn.network/attestations/result-evaluation/v1",
        predicate: {
          evaluatedAt: "2026-08-15T00:00:00Z",
          evaluator: { id: "did:key:zPairedMajorityDeltaFixture" },
          evaluationMethod: { name: PARSER_ID, digest: { sha256: EVALUATION_METHOD_DIGEST.slice("sha256:".length) } },
          evaluationSpecification: { name: "evaluation-spec.json", digest: { sha256: evaluationSpecSha256.slice("sha256:".length) } },
          taskSubject: "task.json",
          resultSubjects: ["judge-response", "judge-observation"],
          verdict: agreement ? "pass" : "fail",
          measurements,
          evidence: [{ name: "label-resolution.json", digest: { sha256: labelResolutionSha256.slice("sha256:".length) }, mediaType: LABEL_MEDIA_TYPE }],
        },
      };
      const verdictBytes = sealDsseEnvelope({
        payloadBytes: canonicalJsonBytes(statement),
        payloadType: "application/vnd.in-toto+json",
        signatures: [{ keyid: "did:key:zPairedMajorityDeltaFixture", signature: Uint8Array.of(1) }],
      });
      const verdictDigest = put(verdictBytes);
      cells.push({
        cellKey: key,
        taskDigest: taskHex,
        armId,
        replicate: 1,
        dispatches: 1,
        accounted: 1,
        submission: `sha256:${sha(`submission:${key}`)}` as const,
        attempt: exactUuid(`attempt:${key}`),
        delivery: `sha256:${sha(`delivery:${key}`)}` as const,
        verdicts: [verdictDigest],
        validVerdicts: [verdictDigest],
        outcome: "judged" as Outcome,
        verification: { harness: "match" as const, model: "match" as const, loadout: "match" as const, isolation: "match" as const, checksFailed: [] },
        integrityTier: "re-derivable" as const,
      });
    }
  }
  cells.sort((left, right) => compareCodeUnitStrings(left.cellKey, right.cellKey));

  const run = sealRun({
    protocol: BENCHMARKING_PROTOCOL,
    benchmark: { digest: { sha256: "6".repeat(64) } },
    owner: RUN_OWNER,
    arms: [...instruments.entries()].map(([armId, instrument]) => ({ armId, pinning: { [INSTRUMENT_KEY]: instrument } })),
    replicates: K,
    policy: {
      completenessFloor: "1",
      cellWindow: 60,
      replacement: { allowed: true, maxPerCell: 1 },
      independence: "disclosed",
      evaluation: { minVerdicts: 1, distinctEvaluator: false },
      submissionBaseline: {},
    },
    analysisPlan: [{ method: "jinn.benchmarking.method/paired-majority-delta", version: "1", parameters }],
    closeAt: "2026-08-15T01:00:00Z",
  });
  records.set(run.digest, run.bytes);

  const perArm = Object.fromEntries(ARM_IDS.map((armId) => {
    const armCells = cells.filter((cell) => cell.armId === armId);
    const count = (outcome: Outcome): number => armCells.filter((cell) => cell.outcome === outcome).length;
    return [armId, {
      expected: armCells.length, judged: count("judged"), unjudged: count("unjudged"),
      unscorable: count("unscorable"), expired: count("expired"), invalidated: count("invalidated"),
      excluded: count("excluded"), replacements: 0,
    }];
  }));
  const judged = cells.filter((cell) => cell.outcome === "judged").length;
  const matrixSealed = sealMatrix({
    protocol: BENCHMARKING_PROTOCOL,
    run: { digest: { sha256: run.digest.slice("sha256:".length) } },
    closeBoundary: { at: "2026-08-15T01:00:00Z" },
    cells,
    exclusions: [],
    attrition: { perArm, asymmetryFlags: judged === cells.length ? [] : ["arm-asymmetry"] },
    completeness: { expected: cells.length, judged, floor: "1", runOutcome: judged === cells.length ? "complete" : "partial" },
    assembly: { procedure: "jinn.benchmarking.assembly", version: "1.0" },
  });
  const matrix = parseMatrix(matrixSealed.bytes);
  const resolve = (digest: string): Uint8Array | undefined => records.get(digest);
  const subjectSha256 = matrixSealed.digest.slice("sha256:".length);
  return {
    matrix,
    subjectSha256,
    taskDigestById,
    input: {
      subjects: [{ subjectSha256, matrix }],
      parameters,
      verdictRule: "sole",
      resolveVerdictBytes: resolve,
      resolveRunBytes: resolve,
      resolveTaskBytes: resolve,
      resolveRecordBytes: resolve,
    },
  };
}

function subjectScopedInput(closure: Closure) {
  return {
    ...closure.input,
    subjects: undefined,
    subjectSha256: closure.subjectSha256,
    matrices: [closure.matrix] as const,
  } as Omit<MethodComputeInput, "subjects"> & { readonly subjectSha256: string; readonly matrices: readonly [MatrixRecord] };
}

function computeDirect(closure: Closure): Record<string, unknown> {
  return computePairedMajorityDelta(subjectScopedInput(closure)) as Record<string, unknown>;
}

describe("paired-majority-delta@1 registration", () => {
  test("is registered at version 1 with the frozen registry row", () => {
    const registry = createMethodRegistry();
    const method = registry.get("jinn.benchmarking.method/paired-majority-delta", "1")!;
    expect(method).toBeDefined();
    expect(method.version).toBe("1");
    expect(method.versionRobust).toBe(false);
    expect(method.deterministic).toBe(true);
    expect(method.computeAvailability).toBe("available");
    expect(method.referenceSet).toBe("registered-non-reference");
    expect(method.requiredInputs).toEqual([
      "matrix.cells",
      "referenced-result-evaluations",
      "exact-run-bytes",
      "exact-task-bytes",
      "exact-evaluation-specification-bytes",
      "exact-analysis-context-bytes",
      "exact-label-resolution-bytes",
      "exact-instrument-bytes",
      "task-provenance-source",
    ]);
    expect(method.outputShape).toBe(
      "paired item-majority rate difference + two-sided clustered BCa interval, per-candidate-class and per-stratum slices, source-cluster manifest, and exclusions",
    );
    expect(method.exclusionRule).toBe(
      "exact k-cell Task/arm groups only, in both arms of the pair; an item excluded for either arm is excluded from the pair, with exact cells",
    );
    expect(method.clusteringRule).toBe("task-provenance-source");
    expect(method.resamplingProcedure).toBe(
      "xorshift32-v1; sample whole source clusters with replacement; one uint32 draw per cluster position; cluster jackknife acceleration; two passes at alpha/2 and 1-alpha/2 over one seed",
    );
  });

  test("requiredInputs is binary-instrument@1's own eight, in the same order, plus task-provenance-source", () => {
    const registry = createMethodRegistry();
    const binaryInstrument = registry.get("jinn.benchmarking.method/binary-instrument", "1")!;
    const pairedMajorityDelta = registry.get("jinn.benchmarking.method/paired-majority-delta", "1")!;
    expect(pairedMajorityDelta.requiredInputs.slice(0, -1)).toEqual(binaryInstrument.requiredInputs);
    expect(pairedMajorityDelta.requiredInputs.at(-1)).toBe("task-provenance-source");
  });

  test("shares binary-instrument@1's own property definitions for the eight carried-over keys (same object, not retyped)", () => {
    const registry = createMethodRegistry();
    const binaryInstrument = registry.get("jinn.benchmarking.method/binary-instrument", "1")!;
    const pairedMajorityDelta = registry.get("jinn.benchmarking.method/paired-majority-delta", "1")!;
    for (const key of ["verdictRule", "k", "reduction", "measurementProfile", "candidateClasses", "strata", "parserInvalidPolicy", "truthAdmission"]) {
      expect(pairedMajorityDelta.parameterSchema.properties[key]).toBe(binaryInstrument.parameterSchema.properties[key]);
    }
  });
});

describe("paired-majority-delta@1 parameter validation", () => {
  const VALID = PARAMETERS;

  test("accepts the full thirteen-key parameter set", () => {
    expect(validatePairedMajorityDeltaParameters(VALID)).toEqual({ ok: true });
  });

  test("required is exactly thirteen keys, in the spec's own order", () => {
    expect(PAIRED_MAJORITY_DELTA_PARAMETER_SCHEMA.required).toEqual([
      "verdictRule", "k", "reduction", "measurementProfile", "candidateClasses",
      "strata", "parserInvalidPolicy", "truthAdmission",
      "baseline", "candidate", "seed", "resamples", "alpha",
    ]);
    expect(PAIRED_MAJORITY_DELTA_PARAMETER_SCHEMA.additionalProperties).toBe(false);
  });

  test("does not declare intervalAlpha or the optional judgeModelProfile", () => {
    expect(PAIRED_MAJORITY_DELTA_PARAMETER_SCHEMA.properties).not.toHaveProperty("intervalAlpha");
    expect(PAIRED_MAJORITY_DELTA_PARAMETER_SCHEMA.properties).not.toHaveProperty("judgeModelProfile");
  });

  test("refuses a parameter set that adds intervalAlpha", () => {
    const result = validatePairedMajorityDeltaParameters({ ...VALID, intervalAlpha: "0.05" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues).toContain('unknown parameter "intervalAlpha"');
  });

  test("refuses a parameter set that adds judgeModelProfile", () => {
    const result = validatePairedMajorityDeltaParameters({ ...VALID, judgeModelProfile: "reasoning-2026-08" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues).toContain('unknown parameter "judgeModelProfile"');
  });

  for (const key of PAIRED_MAJORITY_DELTA_PARAMETER_SCHEMA.required) {
    test(`refuses a missing "${key}"`, () => {
      const { [key]: _dropped, ...rest } = VALID as Record<string, unknown>;
      const result = validatePairedMajorityDeltaParameters(rest);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.issues).toContain(`missing required parameter "${key}"`);
    });
  }

  test("refuses an unknown extra key", () => {
    const result = validatePairedMajorityDeltaParameters({ ...VALID, vendor: "acme" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues).toContain('unknown parameter "vendor"');
  });

  test("refuses enum violations (reduction, parserInvalidPolicy, truthAdmission, measurementProfile, verdictRule, alpha)", () => {
    expect(validatePairedMajorityDeltaParameters({ ...VALID, reduction: "loose-majority" }).ok).toBe(false);
    expect(validatePairedMajorityDeltaParameters({ ...VALID, parserInvalidPolicy: "accept" }).ok).toBe(false);
    expect(validatePairedMajorityDeltaParameters({ ...VALID, truthAdmission: "vibes" }).ok).toBe(false);
    expect(validatePairedMajorityDeltaParameters({ ...VALID, measurementProfile: "binary-instrument@2" }).ok).toBe(false);
    expect(validatePairedMajorityDeltaParameters({ ...VALID, verdictRule: "unanimous" }).ok).toBe(false);
    expect(validatePairedMajorityDeltaParameters({ ...VALID, alpha: "0.20" }).ok).toBe(false);
  });

  test("accepts the three-member truthAdmission enum widened by §6.8", () => {
    for (const truthAdmission of ["two-human-unanimous", "operator-only", "screened-operator-sampled"]) {
      expect(validatePairedMajorityDeltaParameters({ ...VALID, truthAdmission })).toEqual({ ok: true });
    }
  });

  test("accepts the three-member alpha enum", () => {
    for (const alpha of ["0.10", "0.05", "0.01"]) {
      expect(validatePairedMajorityDeltaParameters({ ...VALID, alpha })).toEqual({ ok: true });
    }
  });

  test("refuses a non-odd or non-positive k", () => {
    expect(validatePairedMajorityDeltaParameters({ ...VALID, k: 2 }).ok).toBe(false);
    expect(validatePairedMajorityDeltaParameters({ ...VALID, k: 0 }).ok).toBe(false);
    expect(validatePairedMajorityDeltaParameters({ ...VALID, k: -1 }).ok).toBe(false);
  });

  test("refuses unsorted or duplicate candidateClasses without weakening the check", () => {
    expect(validatePairedMajorityDeltaParameters({ ...VALID, candidateClasses: ["factual", "contradiction"] }).ok).toBe(false);
    expect(validatePairedMajorityDeltaParameters({ ...VALID, candidateClasses: ["factual", "factual"] }).ok).toBe(false);
    expect(validatePairedMajorityDeltaParameters({ ...VALID, candidateClasses: [] }).ok).toBe(false);
  });

  test("refuses unsorted or duplicate strata without weakening the check", () => {
    expect(validatePairedMajorityDeltaParameters({ ...VALID, strata: ["stress", "core"] }).ok).toBe(false);
    expect(validatePairedMajorityDeltaParameters({ ...VALID, strata: ["core", "core"] }).ok).toBe(false);
    expect(validatePairedMajorityDeltaParameters({ ...VALID, strata: [] }).ok).toBe(false);
  });

  test("refuses baseline and candidate naming the same arm", () => {
    const result = validatePairedMajorityDeltaParameters({ ...VALID, candidate: VALID.baseline });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues).toContain('parameters "baseline" and "candidate" must name distinct arms');
  });

  test("refuses seed and resamples out of range", () => {
    expect(validatePairedMajorityDeltaParameters({ ...VALID, seed: 0 }).ok).toBe(false);
    expect(validatePairedMajorityDeltaParameters({ ...VALID, seed: 4_294_967_296 }).ok).toBe(false);
    expect(validatePairedMajorityDeltaParameters({ ...VALID, resamples: 0 }).ok).toBe(false);
    expect(validatePairedMajorityDeltaParameters({ ...VALID, resamples: 100_001 }).ok).toBe(false);
  });

  test("the registry wires this exact validator, not the generic array-blind one", () => {
    const registry = createMethodRegistry();
    const method = registry.get("jinn.benchmarking.method/paired-majority-delta", "1")!;
    expect(method.validateParameters({ ...VALID, candidateClasses: ["z", "a"] }).ok).toBe(false);
  });
});

describe("paired-majority-delta@1 compute", () => {
  test("the unit is the item-majority decision, {-1, 0, +1} per Task, and the sign is candidate minus baseline", () => {
    const closure = buildClosure(ITEMS);
    const result = computeDirect(closure);
    // i1: ACCEPT/ACCEPT -> 0; i2: REJECT/ACCEPT -> +1; i3: ACCEPT/REJECT -> -1; i5/i6: -> +1 each;
    // i7: ACCEPT/ACCEPT -> 0. Sum = 2 over n = 6 paired tasks.
    expect(result["n"]).toBe(6);
    expect(result["delta"]).toBe((2 / 6).toFixed(4));
  });

  test("direction: when the candidate arm agrees more, delta is positive", () => {
    const closure = buildClosure(ITEMS);
    const result = computeDirect(closure);
    expect(Number(result["delta"])).toBeGreaterThan(0);
  });

  test("both withholding gates clear at n=6 paired tasks over 2 clusters: interval computes and reasons is empty", () => {
    const closure = buildClosure(ITEMS);
    const result = computeDirect(closure);
    expect(result["reasons"]).toEqual([]);
    expect(result["interval"]).not.toBeNull();
    const interval = result["interval"] as { lower: string; upper: string; alpha: string };
    expect(interval.alpha).toBe("0.05");
    expect(Number(interval.lower)).toBeLessThanOrEqual(Number(result["delta"]));
    expect(Number(interval.upper)).toBeGreaterThanOrEqual(Number(result["delta"]));
    const clusters = result["clusters"] as { count: number; manifest: unknown[] };
    expect(clusters.count).toBe(2);
    expect(clusters.manifest).toHaveLength(2);
  });

  test("exclusions compose: an item excluded on the candidate arm is excluded from the pair, with the exact reason", () => {
    const closure = buildClosure(ITEMS);
    const result = computeDirect(closure);
    const i4 = closure.taskDigestById["i4"]!;
    expect(result["exclusions"]).toEqual([{ taskDigest: i4, armId: "candidate", reason: "cell-not-judged" }]);
  });

  test("byCandidateClass and byStratum cover the full declared vocabulary, sorted, every declared name emitted", () => {
    const result = computeDirect(buildClosure(ITEMS));
    expect((result["byCandidateClass"] as Record<string, unknown>[]).map((slice) => slice["candidateClass"]))
      .toEqual(["borderline", "contradiction", "factual"]);
    expect((result["byStratum"] as Record<string, unknown>[]).map((slice) => slice["stratum"]))
      .toEqual(["core", "outlier", "stress"]);
  });

  test("a zero-denominator slice is emitted with its counts, both withholding reasons, and no manufactured interval", () => {
    const result = computeDirect(buildClosure(ITEMS));
    const borderline = (result["byCandidateClass"] as Record<string, unknown>[])
      .find((slice) => slice["candidateClass"] === "borderline")!;
    expect(borderline).toEqual({
      candidateClass: "borderline", n: 0, delta: null, interval: null,
      reasons: ["fewer than minN=5 paired tasks (got 0)", "fewer than two source clusters (got 0)"],
    });
    const outlier = (result["byStratum"] as Record<string, unknown>[])
      .find((slice) => slice["stratum"] === "outlier")!;
    expect(outlier).toEqual({
      stratum: "outlier", n: 0, delta: null, interval: null,
      reasons: ["fewer than minN=5 paired tasks (got 0)", "fewer than two source clusters (got 0)"],
    });
  });

  test("slice withholding is computed within the slice: n<5 withholds even though the top level clears both gates", () => {
    const result = computeDirect(buildClosure(ITEMS));
    const factual = (result["byCandidateClass"] as Record<string, unknown>[])
      .find((slice) => slice["candidateClass"] === "factual")!;
    // i1, i2, i5, i7 -> n=4, across both clusters -> only the minN gate fires.
    expect(factual["n"]).toBe(4);
    expect(factual["interval"]).toBeNull();
    expect(factual["reasons"]).toEqual(["fewer than minN=5 paired tasks (got 4)"]);
    expect(factual["delta"]).not.toBeNull();

    const stress = (result["byStratum"] as Record<string, unknown>[])
      .find((slice) => slice["stratum"] === "stress")!;
    // i2, i6 -> n=2, across both clusters -> only the minN gate fires.
    expect(stress["n"]).toBe(2);
    expect(stress["interval"]).toBeNull();
    expect(stress["reasons"]).toEqual(["fewer than minN=5 paired tasks (got 2)"]);
  });

  test("carries a top-level conflicted envelope sourced from the shared reduction", () => {
    const result = computeDirect(buildClosure(ITEMS));
    expect(result["conflicted"]).toEqual({ count: 0, cellKeys: [] });
    expect(result).not.toHaveProperty("conflictedCells");
  });

  test("is byte-stable on recompute (spec §7.2a determinism claim)", () => {
    const closure = buildClosure(ITEMS);
    const first = JSON.stringify(computeDirect(closure));
    const second = JSON.stringify(computeDirect(closure));
    expect(first).toBe(second);
  });

  test("reachable and byte-identical through the full method registry (subject-scoped dispatch)", () => {
    const closure = buildClosure(ITEMS);
    const registry = createMethodRegistry();
    const method = registry.get("jinn.benchmarking.method/paired-majority-delta", "1")!;
    const viaRegistry = method.compute!(closure.input).perSubject[0]!.results;
    const direct = computeDirect(closure);
    expect(viaRegistry).toEqual(direct);
  });
});

describe("paired-majority-delta@1 withholding gates", () => {
  // Both items share one source cluster, giving n=3 < 5 and clusters=1 < 2: both reasons fire,
  // in the pinned order, and a point estimate still publishes.
  const BOTH_GATES_ITEMS: readonly ItemSpec[] = [
    { id: "b1", truthLabel: "CORRECT", candidateClass: "factual", stratum: "core", source: "only-source", decisions: { baseline: "ACCEPT", candidate: "ACCEPT" } },
    { id: "b2", truthLabel: "WRONG", candidateClass: "factual", stratum: "core", source: "only-source", decisions: { baseline: "REJECT", candidate: "ACCEPT" } },
    { id: "b3", truthLabel: "CORRECT", candidateClass: "factual", stratum: "core", source: "only-source", decisions: { baseline: "ACCEPT", candidate: "ACCEPT" } },
  ];

  test("both gates fail together: interval is null, both reasons present verbatim and in order, point estimate still emitted", () => {
    const result = computeDirect(buildClosure(BOTH_GATES_ITEMS));
    expect(result["n"]).toBe(3);
    expect(result["interval"]).toBeNull();
    expect(result["reasons"]).toEqual([
      "fewer than minN=5 paired tasks (got 3)",
      "fewer than two source clusters (got 1)",
    ]);
    // (0 + 1 + 0) / 3
    expect(result["delta"]).toBe((1 / 3).toFixed(4));
  });

  // Four paired tasks (< 5) drawn from two distinct source clusters (>= 2): only the minN gate
  // fires.
  const N_ONLY_ITEMS: readonly ItemSpec[] = [
    { id: "n1", truthLabel: "CORRECT", candidateClass: "factual", stratum: "core", source: "cluster-a", decisions: { baseline: "ACCEPT", candidate: "ACCEPT" } },
    { id: "n2", truthLabel: "WRONG", candidateClass: "factual", stratum: "core", source: "cluster-a", decisions: { baseline: "REJECT", candidate: "ACCEPT" } },
    { id: "n3", truthLabel: "CORRECT", candidateClass: "factual", stratum: "core", source: "cluster-b", decisions: { baseline: "ACCEPT", candidate: "ACCEPT" } },
    { id: "n4", truthLabel: "WRONG", candidateClass: "factual", stratum: "core", source: "cluster-b", decisions: { baseline: "REJECT", candidate: "ACCEPT" } },
  ];

  test("only the minN gate fails: n=4 with 2 clusters withholds on that reason alone", () => {
    const result = computeDirect(buildClosure(N_ONLY_ITEMS));
    expect(result["n"]).toBe(4);
    expect(result["interval"]).toBeNull();
    expect(result["reasons"]).toEqual(["fewer than minN=5 paired tasks (got 4)"]);
    expect(result["delta"]).not.toBeNull();
    const clusters = result["clusters"] as { count: number };
    expect(clusters.count).toBe(2);
  });

  // Five paired tasks (>= 5) all drawn from one source cluster: only the cluster gate fires.
  const CLUSTER_ONLY_ITEMS: readonly ItemSpec[] = [
    { id: "c1", truthLabel: "CORRECT", candidateClass: "factual", stratum: "core", source: "single-source", decisions: { baseline: "ACCEPT", candidate: "ACCEPT" } },
    { id: "c2", truthLabel: "WRONG", candidateClass: "factual", stratum: "core", source: "single-source", decisions: { baseline: "REJECT", candidate: "ACCEPT" } },
    { id: "c3", truthLabel: "CORRECT", candidateClass: "factual", stratum: "core", source: "single-source", decisions: { baseline: "ACCEPT", candidate: "REJECT" } },
    { id: "c4", truthLabel: "WRONG", candidateClass: "factual", stratum: "core", source: "single-source", decisions: { baseline: "REJECT", candidate: "ACCEPT" } },
    { id: "c5", truthLabel: "CORRECT", candidateClass: "factual", stratum: "core", source: "single-source", decisions: { baseline: "ACCEPT", candidate: "ACCEPT" } },
  ];

  test("only the cluster gate fails: n=5 in a single cluster withholds on that reason alone", () => {
    const result = computeDirect(buildClosure(CLUSTER_ONLY_ITEMS));
    expect(result["n"]).toBe(5);
    expect(result["interval"]).toBeNull();
    expect(result["reasons"]).toEqual(["fewer than two source clusters (got 1)"]);
    expect(result["delta"]).not.toBeNull();
    const clusters = result["clusters"] as { count: number };
    expect(clusters.count).toBe(1);
  });

  // Every item excluded on the candidate arm: n=0, delta is null (not merely withheld), and the
  // cluster manifest is empty.
  const ZERO_PAIRED_ITEMS: readonly ItemSpec[] = [
    { id: "z1", truthLabel: "CORRECT", candidateClass: "factual", stratum: "core", source: "source-only", decisions: { baseline: "ACCEPT", candidate: "EXCLUDED" } },
    { id: "z2", truthLabel: "WRONG", candidateClass: "factual", stratum: "core", source: "source-only", decisions: { baseline: "REJECT", candidate: "EXCLUDED" } },
  ];

  test("n=0 (nothing paired): delta is null, interval is null, both reasons fire, and the manifest is empty", () => {
    const closure = buildClosure(ZERO_PAIRED_ITEMS);
    const result = computeDirect(closure);
    expect(result["n"]).toBe(0);
    expect(result["delta"]).toBeNull();
    expect(result["interval"]).toBeNull();
    expect(result["reasons"]).toEqual([
      "fewer than minN=5 paired tasks (got 0)",
      "fewer than two source clusters (got 0)",
    ]);
    const clusters = result["clusters"] as { count: number; manifest: unknown[] };
    expect(clusters.count).toBe(0);
    expect(clusters.manifest).toEqual([]);
    const expectedDigests = [closure.taskDigestById["z1"]!, closure.taskDigestById["z2"]!].sort(compareCodeUnitStrings);
    expect(result["exclusions"]).toEqual(
      expectedDigests.map((taskDigest) => ({ taskDigest, armId: "candidate", reason: "cell-not-judged" })),
    );
  });
});
