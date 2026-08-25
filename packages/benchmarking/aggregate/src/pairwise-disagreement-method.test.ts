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
  computeBinaryInstrumentQualification,
  projectBinaryInstrumentQualification,
  resolveBinaryInstrumentReduction,
} from "./binary-instrument-method.js";
import {
  computePairwiseDisagreement,
  PAIRWISE_DISAGREEMENT_PARAMETER_SCHEMA,
  validatePairwiseDisagreementParameters,
} from "./pairwise-disagreement-method.js";
import { createMethodRegistry } from "./registry.js";
import { wilsonInterval } from "./stats/wilson.js";
import type { MethodComputeInput } from "./method.js";

// Synthetic fixture only (license law, spec §0.3): every id, digest, and prompt below is
// original to this test. Arms are referred to by role ("armA"/"armB"/"armC"), never by publisher.

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
const EVALUATION_METHOD_DIGEST = "sha256:3568ee132ece234c15b7f9b6b4a7a954aefc2c417e17f2fde91729a7240bb343" as const;
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
// reasoning-2026-08 profile's frozen limitations disclosure (spec §1.1).
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
const PARAMETERS = {
  verdictRule: "sole",
  k: K,
  reduction: "strict-majority",
  measurementProfile: "binary-instrument@1",
  // Declared vocabulary is a superset of what the items actually use ("borderline" and "outlier"
  // never appear), so both slice families exercise the empty-slice path (spec §7.1: "every
  // declared name emitted even when empty").
  candidateClasses: ["borderline", "contradiction", "factual"],
  strata: ["core", "outlier", "stress"],
  parserInvalidPolicy: "reject",
  truthAdmission: "two-human-unanimous",
  intervalAlpha: "0.05",
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
  readonly decisions: Readonly<Record<string, Decision>>;
}

// Four items x three arms, chosen so every pair of arms shows a different disagreement pattern
// and armB carries one excluded (expired) cell on item "i4" — the shared exclusion fixture for
// both the "empty exclusions" and "an item excluded for one arm is excluded from every pair
// containing that arm" assertions below.
const ITEMS: readonly ItemSpec[] = [
  { id: "i1", truthLabel: "CORRECT", candidateClass: "factual", stratum: "core", decisions: { armA: "ACCEPT", armB: "ACCEPT", armC: "REJECT" } },
  { id: "i2", truthLabel: "WRONG", candidateClass: "factual", stratum: "stress", decisions: { armA: "ACCEPT", armB: "REJECT", armC: "REJECT" } },
  { id: "i3", truthLabel: "CORRECT", candidateClass: "contradiction", stratum: "core", decisions: { armA: "REJECT", armB: "REJECT", armC: "REJECT" } },
  { id: "i4", truthLabel: "WRONG", candidateClass: "contradiction", stratum: "stress", decisions: { armA: "ACCEPT", armB: "EXCLUDED", armC: "REJECT" } },
];
const ARM_IDS = ["armA", "armB", "armC"] as const;

interface Closure {
  readonly input: MethodComputeInput;
  readonly matrix: MatrixRecord;
  readonly subjectSha256: string;
  readonly taskDigestById: Readonly<Record<string, string>>;
}

function buildClosure(): Closure {
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

  for (const item of ITEMS) {
    const itemId = exactUuid(item.id);
    const payload = {
      itemId,
      question: `What is the synthetic answer for ${item.id}?`,
      referenceAnswer: "reference",
      candidateAnswer: item.truthLabel === "CORRECT" ? "reference" : "different",
      provenance: { sourceCommitment: `sha256:${sha(`source:${item.id}`)}`, timestamp: "2026-08-14T22:00:00Z" },
      sources: [{ digest: { sha256: sha(`source:${item.id}`) } }],
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
      const decision = item.decisions[armId]!;
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
          evaluator: { id: "did:key:zPairwiseDisagreementFixture" },
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
        signatures: [{ keyid: "did:key:zPairwiseDisagreementFixture", signature: Uint8Array.of(1) }],
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
    analysisPlan: [{ method: "jinn.benchmarking.method/pairwise-disagreement", version: "1", parameters: PARAMETERS }],
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
    attrition: { perArm, asymmetryFlags: ["arm-asymmetry"] },
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
      parameters: PARAMETERS,
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

describe("pairwise-disagreement@1 registration", () => {
  test("is registered at version 1 with the frozen registry row", () => {
    const registry = createMethodRegistry();
    const method = registry.get("jinn.benchmarking.method/pairwise-disagreement", "1")!;
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
    ]);
    expect(method.outputShape).toBe(
      "per-arm-pair item-majority disagreement counts, rate, Wilson interval, per-candidate-class and per-stratum slices, and exclusions",
    );
    expect(method.exclusionRule).toBe(
      "exact k-cell Task/arm groups only; an item excluded for either arm of a pair is excluded from that pair, with exact cells",
    );
    expect(method.clusteringRule).toBe("Task digest plus arm pair; strict majority over registered scientific replicates");
    expect(method).not.toHaveProperty("resamplingProcedure");
  });

  test("requiredInputs is exactly binary-instrument@1's own eight, in the same order", () => {
    const registry = createMethodRegistry();
    const binaryInstrument = registry.get("jinn.benchmarking.method/binary-instrument", "1")!;
    const pairwiseDisagreement = registry.get("jinn.benchmarking.method/pairwise-disagreement", "1")!;
    expect(pairwiseDisagreement.requiredInputs).toEqual(binaryInstrument.requiredInputs);
  });
});

describe("pairwise-disagreement@1 parameter validation", () => {
  const VALID = PARAMETERS;

  test("accepts the full nine-key parameter set", () => {
    expect(validatePairwiseDisagreementParameters(VALID)).toEqual({ ok: true });
  });

  test("required is exactly nine keys, including truthAdmission (the coordinator ruling)", () => {
    expect(PAIRWISE_DISAGREEMENT_PARAMETER_SCHEMA.required).toEqual([
      "verdictRule", "k", "reduction", "measurementProfile", "candidateClasses",
      "strata", "parserInvalidPolicy", "truthAdmission", "intervalAlpha",
    ]);
    expect(PAIRWISE_DISAGREEMENT_PARAMETER_SCHEMA.additionalProperties).toBe(false);
  });

  test("does not declare the optional judgeModelProfile parameter", () => {
    expect(PAIRWISE_DISAGREEMENT_PARAMETER_SCHEMA.properties).not.toHaveProperty("judgeModelProfile");
  });

  test("refuses a parameter set that adds judgeModelProfile", () => {
    const result = validatePairwiseDisagreementParameters({ ...VALID, judgeModelProfile: "reasoning-2026-08" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues).toContain('unknown parameter "judgeModelProfile"');
  });

  for (const key of PAIRWISE_DISAGREEMENT_PARAMETER_SCHEMA.required) {
    test(`refuses a missing "${key}"`, () => {
      const { [key]: _dropped, ...rest } = VALID as Record<string, unknown>;
      const result = validatePairwiseDisagreementParameters(rest);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.issues).toContain(`missing required parameter "${key}"`);
    });
  }

  test("refuses an unknown extra key", () => {
    const result = validatePairwiseDisagreementParameters({ ...VALID, vendor: "acme" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues).toContain('unknown parameter "vendor"');
  });

  test("refuses enum violations (reduction, parserInvalidPolicy, truthAdmission, intervalAlpha, measurementProfile, verdictRule)", () => {
    expect(validatePairwiseDisagreementParameters({ ...VALID, reduction: "loose-majority" }).ok).toBe(false);
    expect(validatePairwiseDisagreementParameters({ ...VALID, parserInvalidPolicy: "accept" }).ok).toBe(false);
    expect(validatePairwiseDisagreementParameters({ ...VALID, truthAdmission: "vibes" }).ok).toBe(false);
    expect(validatePairwiseDisagreementParameters({ ...VALID, intervalAlpha: "0.10" }).ok).toBe(false);
    expect(validatePairwiseDisagreementParameters({ ...VALID, measurementProfile: "binary-instrument@2" }).ok).toBe(false);
    expect(validatePairwiseDisagreementParameters({ ...VALID, verdictRule: "unanimous" }).ok).toBe(false);
  });

  test("accepts the three-member truthAdmission enum widened by §6.8", () => {
    for (const truthAdmission of ["two-human-unanimous", "operator-only", "screened-operator-sampled"]) {
      expect(validatePairwiseDisagreementParameters({ ...VALID, truthAdmission })).toEqual({ ok: true });
    }
  });

  test("refuses a non-odd or non-positive k", () => {
    expect(validatePairwiseDisagreementParameters({ ...VALID, k: 2 }).ok).toBe(false);
    expect(validatePairwiseDisagreementParameters({ ...VALID, k: 0 }).ok).toBe(false);
    expect(validatePairwiseDisagreementParameters({ ...VALID, k: -1 }).ok).toBe(false);
  });

  test("refuses unsorted or duplicate candidateClasses without weakening the check", () => {
    expect(validatePairwiseDisagreementParameters({ ...VALID, candidateClasses: ["factual", "contradiction"] }).ok).toBe(false);
    expect(validatePairwiseDisagreementParameters({ ...VALID, candidateClasses: ["factual", "factual"] }).ok).toBe(false);
    expect(validatePairwiseDisagreementParameters({ ...VALID, candidateClasses: [] }).ok).toBe(false);
  });

  test("refuses unsorted or duplicate strata without weakening the check", () => {
    expect(validatePairwiseDisagreementParameters({ ...VALID, strata: ["stress", "core"] }).ok).toBe(false);
    expect(validatePairwiseDisagreementParameters({ ...VALID, strata: ["core", "core"] }).ok).toBe(false);
    expect(validatePairwiseDisagreementParameters({ ...VALID, strata: [] }).ok).toBe(false);
  });

  test("the registry wires this exact validator, not the generic array-blind one", () => {
    const registry = createMethodRegistry();
    const method = registry.get("jinn.benchmarking.method/pairwise-disagreement", "1")!;
    expect(method.validateParameters({ ...VALID, candidateClasses: ["z", "a"] }).ok).toBe(false);
  });
});

describe("the front-half extraction (resolveBinaryInstrumentReduction)", () => {
  test("agrees byte for byte with computeBinaryInstrumentQualification on the same input", () => {
    const closure = buildClosure();
    // binary-instrument@1's own parameters (has intervalAlpha; distinct from PARAMETERS only in
    // that it is validated by validateBinaryInstrumentParameters, not this method's validator).
    const binaryInstrumentParameters = { ...PARAMETERS };
    const input = { ...closure.input, parameters: binaryInstrumentParameters };
    const subjectInput = subjectScopedInput({ ...closure, input });

    const direct = computeBinaryInstrumentQualification(subjectInput);
    const { reduction, instruments } = resolveBinaryInstrumentReduction(subjectInput, {
      k: PARAMETERS.k,
      candidateClasses: PARAMETERS.candidateClasses,
      strata: PARAMETERS.strata,
      truthAdmission: PARAMETERS.truthAdmission,
    });
    const viaExtraction = projectBinaryInstrumentQualification({
      parameters: binaryInstrumentParameters,
      reduction,
      instruments,
    });

    expect(viaExtraction).toEqual(direct);
    // And the reduction itself carries the exact item/exclusion facts the fixture encodes.
    expect(reduction.items).toHaveLength(ARM_IDS.length * ITEMS.length - 1);
    expect(reduction.excluded).toHaveLength(1);
    expect(reduction.excluded[0]).toMatchObject({ armId: "armB", taskDigest: closure.taskDigestById["i4"] });
  });
});

describe("pairwise-disagreement@1 compute", () => {
  function computeDirect(closure: Closure): { readonly pairs: readonly Record<string, unknown>[]; readonly conflicted: unknown } {
    return computePairwiseDisagreement(subjectScopedInput(closure)) as {
      readonly pairs: readonly Record<string, unknown>[];
      readonly conflicted: unknown;
    };
  }

  test("enumerates all unordered pairs sorted by (armA, armB) with armA < armB", () => {
    const result = computeDirect(buildClosure());
    expect(result.pairs.map((pair) => [pair["armA"], pair["armB"]])).toEqual([
      ["armA", "armB"],
      ["armA", "armC"],
      ["armB", "armC"],
    ]);
    for (const pair of result.pairs) {
      expect(compareCodeUnitStrings(pair["armA"] as string, pair["armB"] as string)).toBeLessThan(0);
    }
  });

  test("counts n, disagreements, and the Wilson interval per pair", () => {
    const closure = buildClosure();
    const result = computeDirect(closure);
    const [ab, ac, bc] = result.pairs;

    expect(ab).toMatchObject({ armA: "armA", armB: "armB", n: 3, disagreements: 1 });
    const abWilson = wilsonInterval(1, 3);
    expect(ab!["rate"]).toBe(abWilson.p.toFixed(4));
    expect(ab!["interval"]).toEqual({ lower: abWilson.lo.toFixed(4), upper: abWilson.hi.toFixed(4), alpha: "0.0500" });

    expect(ac).toMatchObject({ armA: "armA", armB: "armC", n: 4, disagreements: 3 });
    const acWilson = wilsonInterval(3, 4);
    expect(ac!["rate"]).toBe(acWilson.p.toFixed(4));

    expect(bc).toMatchObject({ armA: "armB", armB: "armC", n: 3, disagreements: 1 });
  });

  test("exclusions compose: an item excluded for one arm is excluded from every pair containing that arm, and only those", () => {
    const closure = buildClosure();
    const result = computeDirect(closure);
    const [ab, ac, bc] = result.pairs;
    const i4 = closure.taskDigestById["i4"]!;

    expect(ab!["exclusions"]).toEqual([{ taskDigest: i4, armId: "armB", reason: "cell-not-judged" }]);
    expect(bc!["exclusions"]).toEqual([{ taskDigest: i4, armId: "armB", reason: "cell-not-judged" }]);
    // armA/armC pair carries neither pair arm as the excluded one, so it stays empty even though
    // the same task is excluded for a THIRD arm elsewhere in the panel.
    expect(ac!["exclusions"]).toEqual([]);
  });

  test("byCandidateClass and byStratum cover the full declared vocabulary, including an empty slice", () => {
    const result = computeDirect(buildClosure());
    const ab = result.pairs[0]!;

    expect((ab["byCandidateClass"] as unknown[]).map((slice) => (slice as Record<string, unknown>)["candidateClass"]))
      .toEqual(["borderline", "contradiction", "factual"]);
    expect((ab["byStratum"] as unknown[]).map((slice) => (slice as Record<string, unknown>)["stratum"]))
      .toEqual(["core", "outlier", "stress"]);

    const borderline = (ab["byCandidateClass"] as Record<string, unknown>[]).find((slice) => slice["candidateClass"] === "borderline")!;
    expect(borderline).toEqual({ candidateClass: "borderline", n: 0, disagreements: 0, rate: null, interval: null });

    const outlier = (ab["byStratum"] as Record<string, unknown>[]).find((slice) => slice["stratum"] === "outlier")!;
    expect(outlier).toEqual({ stratum: "outlier", n: 0, disagreements: 0, rate: null, interval: null });

    const factual = (ab["byCandidateClass"] as Record<string, unknown>[]).find((slice) => slice["candidateClass"] === "factual")!;
    expect(factual).toMatchObject({ candidateClass: "factual", n: 2, disagreements: 1 });

    const core = (ab["byStratum"] as Record<string, unknown>[]).find((slice) => slice["stratum"] === "core")!;
    expect(core).toMatchObject({ stratum: "core", n: 2, disagreements: 0 });
  });

  test("no ranking: the output carries no order, score, or winner field anywhere", () => {
    const result = computeDirect(buildClosure());
    const serialized = JSON.stringify(result);
    for (const forbidden of ["ranking", "winner", "score", "preferred"]) {
      expect(serialized.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });

  test("carries a top-level conflicted envelope sourced from the shared reduction", () => {
    const closure = buildClosure();
    const result = computeDirect(closure);
    expect(result.conflicted).toEqual({ count: 0, cellKeys: [] });
  });

  test("is byte-stable on recompute (spec §7.1 determinism claim)", () => {
    const closure = buildClosure();
    const first = JSON.stringify(computeDirect(closure));
    const second = JSON.stringify(computeDirect(closure));
    expect(first).toBe(second);
  });

  test("reachable and byte-identical through the full method registry (subject-scoped dispatch)", () => {
    const closure = buildClosure();
    const registry = createMethodRegistry();
    const method = registry.get("jinn.benchmarking.method/pairwise-disagreement", "1")!;
    const viaRegistry = method.compute!(closure.input).perSubject[0]!.results;
    const direct = computeDirect(closure);
    expect(viaRegistry).toEqual(direct);
  });
});
