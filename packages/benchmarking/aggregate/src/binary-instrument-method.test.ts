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
import { createMethodRegistry } from "./registry.js";
import { MethodInputError } from "./resolved-inputs.js";
import type { MethodComputeInput } from "./method.js";

const INSTRUMENT_KEY = "network.jinn.binary-judgment.instrument";
const ITEM_COMMITMENT_KEY = "network.jinn.binary-judgment.item-sha256";
const INSTRUMENT_PROTOCOL = "https://spec.jinn.network/binary-judgment/judge-instrument/v1";
const ANALYSIS_PROTOCOL = "https://spec.jinn.network/binary-judgment/analysis-context/v1";
const SPEC_PROTOCOL = "https://spec.jinn.network/profiles/evaluation-spec/v1";
const PARSER_ID = "network.jinn.parser.binary-judgment-evaluation";
const PARSER_VERSION = "1.0.0";
const TASK_PROFILE_DIGEST = "sha256:ebb34d8362e2cc3135847a5ad6f3ee3d9c2d9922a2b827aa9dfcbaf440b22557" as const;
const TASK_PROFILE_URI = "https://spec.jinn.network/task-profiles/binary-judgment/2.0" as const;
// Superseded binary-judgment/1.0 identity, retained only to prove the method refuses it.
const OLD_TASK_PROFILE_DIGEST = "sha256:40f43e4ab9942f310da716e28ba2c1b8731fdf3c3837bb821573d4d8a0ec259d" as const;
const OLD_TASK_PROFILE_URI = "https://spec.jinn.network/task-profiles/binary-judgment/1.0" as const;
const RESPONSE_PARSER_DIGEST = "sha256:02aa652770de9e74415cd206c8741b6148e3ea82c21773983a6d8c66030d0073" as const;
const EVALUATION_METHOD_DIGEST = "sha256:41b36eaffbac8c78133afd2075ec32fd73ed324395fe281dee525db17653937f" as const;
const RUN_OWNER = "urn:uuid:77777777-7777-5777-8777-777777777777";
const RESPONSE_MEDIA_TYPE = "text/plain; charset=utf-8";
const OBSERVATION_MEDIA_TYPE = "application/vnd.jinn.binary-judgment.observation.v1+json";
const INSPECT_LOG_MEDIA_TYPE = "application/vnd.inspect-ai.eval-log+json";
const ANALYSIS_MEDIA_TYPE = "application/vnd.jinn.binary-judgment.analysis-context.v1+json";
const LABEL_MEDIA_TYPE = "application/vnd.jinn.binary-judgment.label-resolution.v1+json";

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

const PARAMETERS = {
  verdictRule: "sole",
  k: 3,
  reduction: "strict-majority",
  measurementProfile: "binary-instrument@1",
  candidateClasses: ["contradiction", "factual"],
  strata: ["core", "stress"],
  parserInvalidPolicy: "reject",
  truthAdmission: "two-human-unanimous",
  intervalAlpha: "0.05",
} as const;

interface ItemFixture {
  readonly taskDigest: string;
  readonly truthLabel: "CORRECT" | "WRONG";
  readonly candidateClass: "factual" | "contradiction";
  readonly stratum: "core" | "stress";
  readonly labelResolutionSha256: `sha256:${string}`;
  readonly analysisContextSha256: `sha256:${string}`;
  readonly evaluationSpecSha256: `sha256:${string}`;
  readonly payload: Readonly<Record<string, unknown>>;
}

interface Tamper {
  readonly cellKey: string;
  readonly kind:
    | "instrument"
    | "truth"
    | "spec"
    | "invalid-accept"
    | "duplicate-measurement"
    | "label-resolution"
    | "task-item"
    | "observation-arm"
    | "label-evidence"
    | "task-item-id"
    | "response-bom";
}

function sha(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function resourceDigest(value: unknown): `sha256:${string}` {
  return recordDigest(canonicalJsonBytes(value));
}

function exactUuid(value: string): string {
  return `urn:uuid:${sha(value).slice(0, 8)}-0000-5000-8000-000000000000`;
}

function agreement(decision: "ACCEPT" | "REJECT", truth: "CORRECT" | "WRONG"): boolean {
  return (decision === "ACCEPT" && truth === "CORRECT")
    || (decision === "REJECT" && truth === "WRONG");
}

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

function sourceDescriptor(seed: string) {
  return {
    uri: `https://example.test/${seed}`,
    digest: { sha256: sha(seed) },
  };
}

function makeInstrument(armId: string, parserDigest: `sha256:${string}`) {
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
    model: {
      adapter: "jinn-openai",
      requested: "gpt-5.6-luna",
      generation: GENERATION,
    },
    response: {
      mediaType: RESPONSE_MEDIA_TYPE,
      parser: {
        id: "network.jinn.parser.binary-accept-reject",
        version: "1.0.0",
        digest: parserDigest,
      },
      invalidOutputDecision: "REJECT",
    },
  };
}

function semanticRequestDigest(
  payload: ItemFixture["payload"],
  instrument: ReturnType<typeof makeInstrument>,
): `sha256:${string}` {
  const rendered = instrument.messages.map((message) => ({
    role: message.role,
    text: message.segments.map((segment) => (
      "literal" in segment
        ? segment.literal
        : payload[segment.field as "question" | "referenceAnswer" | "candidateAnswer"]
    )).join(""),
  }));
  return resourceDigest({
    model: "gpt-5.6-luna",
    messages: rendered,
    generation: GENERATION,
  });
}

function resultEvaluation(input: {
  readonly task: ItemFixture;
  readonly instrumentSha256: `sha256:${string}`;
  readonly decision: "ACCEPT" | "REJECT";
  readonly parseValid: boolean;
  readonly cellKey: string;
  readonly responseSha256: `sha256:${string}`;
  readonly observationSha256: `sha256:${string}`;
  readonly tamper?: Tamper;
}): Uint8Array {
  let truthLabel: "CORRECT" | "WRONG" = input.task.truthLabel;
  let instrumentSha256: string = input.instrumentSha256;
  let evaluationSpecSha256 = input.task.evaluationSpecSha256.slice("sha256:".length);
  let decision = input.decision;
  if (input.tamper?.cellKey === input.cellKey) {
    if (input.tamper.kind === "truth") truthLabel = truthLabel === "CORRECT" ? "WRONG" : "CORRECT";
    if (input.tamper.kind === "instrument") instrumentSha256 = `sha256:${"f".repeat(64)}`;
    if (input.tamper.kind === "spec") evaluationSpecSha256 = "f".repeat(64);
    if (input.tamper.kind === "invalid-accept") decision = "ACCEPT";
  }
  const agrees = agreement(decision, truthLabel);
  const measurements: { name: string; value: string | boolean }[] = [
    { name: "judgeDecision", value: decision },
    { name: "truthLabel", value: truthLabel },
    { name: "agreement", value: agrees },
    { name: "parseValid", value: input.parseValid },
    { name: "candidateClass", value: input.task.candidateClass },
    { name: "stratum", value: input.task.stratum },
    { name: "labelResolutionSha256", value: input.task.labelResolutionSha256 },
    { name: "instrumentSha256", value: instrumentSha256 },
  ];
  if (input.tamper?.cellKey === input.cellKey && input.tamper.kind === "duplicate-measurement") {
    measurements[7] = { ...measurements[0]! };
  }
  const statement = {
    _type: "https://in-toto.io/Statement/v1",
    subject: [
      { name: "task.json", digest: { sha256: input.task.taskDigest } },
      {
        name: "judge-response",
        digest: { sha256: input.responseSha256.slice("sha256:".length) },
        mediaType: RESPONSE_MEDIA_TYPE,
      },
      {
        name: "judge-observation",
        digest: { sha256: input.observationSha256.slice("sha256:".length) },
        mediaType: OBSERVATION_MEDIA_TYPE,
      },
    ],
    predicateType: "https://spec.jinn.network/attestations/result-evaluation/v1",
    predicate: {
      evaluatedAt: "2026-08-15T00:00:00Z",
      evaluator: { id: "did:key:zBinaryInstrumentFixture" },
      evaluationMethod: {
        name: PARSER_ID,
        digest: { sha256: EVALUATION_METHOD_DIGEST.slice("sha256:".length) },
      },
      evaluationSpecification: {
        name: "evaluation-spec.json",
        digest: { sha256: evaluationSpecSha256 },
      },
      taskSubject: "task.json",
      resultSubjects: ["judge-response", "judge-observation"],
      verdict: agrees ? "pass" : "fail",
      measurements,
      evidence: [{
        name: "label-resolution.json",
        digest: {
          sha256: (input.tamper?.cellKey === input.cellKey && input.tamper.kind === "label-evidence"
            ? "f".repeat(64)
            : input.task.labelResolutionSha256.slice("sha256:".length)),
        },
        mediaType: LABEL_MEDIA_TYPE,
      }],
    },
  };
  return sealDsseEnvelope({
    payloadBytes: canonicalJsonBytes(statement),
    payloadType: "application/vnd.in-toto+json",
    signatures: [{ keyid: "did:key:zBinaryInstrumentFixture", signature: Uint8Array.of(1) }],
  });
}

function makeFixture(options: {
  readonly expireCell?: string;
  readonly tamper?: Tamper;
  readonly truthAdmission?: "two-human-unanimous" | "operator-only";
  readonly labelTruthAdmission?: "two-human-unanimous" | "operator-only";
  readonly taskProfileDigest?: `sha256:${string}`;
  readonly taskProfileUri?: string;
  readonly responseParserDigest?: `sha256:${string}`;
  readonly evaluationParserDigest?: `sha256:${string}`;
  readonly extraRunArm?: boolean;
  readonly extraTestMaterial?: boolean;
  readonly extraParserField?: boolean;
  readonly evaluationImageName?: string;
  readonly evaluationImageDigest?: string;
  readonly evaluationTimeout?: number;
  readonly taskInstructions?: string;
  readonly extraTaskField?: boolean;
  readonly extraProfileField?: boolean;
  readonly payloadEvidence?: string;
  readonly invalidPayloadEvidence?: boolean;
  readonly arrayProvenance?: boolean;
  readonly extraPayloadField?: boolean;
} = {}): {
  readonly input: MethodComputeInput;
  readonly matrix: MatrixRecord;
  readonly wrongTaskDigest: string;
  readonly parserInvalidCellKey: string;
} {
  const truthAdmission = options.truthAdmission ?? "two-human-unanimous";
  const labelTruthAdmission = options.labelTruthAdmission ?? truthAdmission;
  const parameters = { ...PARAMETERS, truthAdmission };
  const records = new Map<string, Uint8Array>();
  const put = (bytes: Uint8Array): `sha256:${string}` => {
    const digest = recordDigest(bytes) as `sha256:${string}`;
    records.set(digest, bytes);
    return digest;
  };
  const matrixArmIds = ["armA", "armB", "armC", "armD"] as const;
  const instruments = new Map<string, `sha256:${string}`>();
  const instrumentDocuments = new Map<string, ReturnType<typeof makeInstrument>>();
  for (const armId of options.extraRunArm === true ? [...matrixArmIds, "armExtra"] : matrixArmIds) {
    const document = makeInstrument(armId, options.responseParserDigest ?? RESPONSE_PARSER_DIGEST);
    instrumentDocuments.set(armId, document);
    instruments.set(armId, put(canonicalJsonBytes(document)));
  }

  const items: ItemFixture[] = [];
  for (const seed of [
    { id: "correct", truthLabel: "CORRECT", candidateClass: "factual", stratum: "core" },
    { id: "wrong", truthLabel: "WRONG", candidateClass: "contradiction", stratum: "stress" },
  ] as const) {
    const itemId = exactUuid(seed.id);
    const payload = {
      itemId,
      question: `What is the synthetic answer for ${seed.id}?`,
      referenceAnswer: "reference",
      candidateAnswer: seed.truthLabel === "CORRECT" ? "reference" : "different",
      ...(options.payloadEvidence !== undefined ? { evidence: options.payloadEvidence } : {}),
      ...(options.invalidPayloadEvidence === true ? { evidence: 123 } : {}),
      provenance: options.arrayProvenance === true
        ? [{ digest: { sha256: sha(`source:${seed.id}`) } }]
        : { sourceCommitment: `sha256:${sha(`source:${seed.id}`)}`, timestamp: "2026-08-14T22:00:00Z" },
      sources: [{ digest: { sha256: sha(`source:${seed.id}`) } }],
      ...(options.extraPayloadField === true ? { "https://fixtures.example.test/payload-extra": true } : {}),
    };
    const itemSha256 = resourceDigest(payload);
    const resolvedItemId = options.tamper?.kind === "task-item-id" && seed.id === "correct"
      ? exactUuid("different-item")
      : itemId;
    const labelTruth = options.tamper?.kind === "label-resolution" && seed.id === "correct"
      ? "WRONG"
      : seed.truthLabel;
    const labelResolutionSha256 = put(canonicalJsonBytes({
      protocol: "https://spec.jinn.network/binary-judgment/label-resolution/v1",
      itemSha256,
      itemId: resolvedItemId,
      humanReviewEvaluationSpecSha256: `sha256:${"1".repeat(64)}`,
      truthLabel: labelTruth,
      candidateClass: seed.candidateClass,
      stratum: seed.stratum,
      resolvedAt: "2026-08-14T23:00:00Z",
      truthAdmission: labelTruthAdmission,
      ...(labelTruthAdmission === "two-human-unanimous" ? {
        reviewVerdictSha256s: [`sha256:${"2".repeat(64)}`, `sha256:${"3".repeat(64)}`],
        reviewerRosterSha256: `sha256:${"4".repeat(64)}`,
        visibilityReceiptSha256s: [`sha256:${"5".repeat(64)}`, `sha256:${"6".repeat(64)}`],
        revealReceiptSha256: `sha256:${"7".repeat(64)}`,
      } : {
        operatorAssertionSha256: `sha256:${"2".repeat(64)}`,
      }),
    }));
    const analysisContextSha256 = put(canonicalJsonBytes({
      protocol: ANALYSIS_PROTOCOL,
      itemSha256,
      itemId: resolvedItemId,
      labelResolutionSha256,
      truthLabel: seed.truthLabel,
      candidateClass: seed.candidateClass,
      stratum: seed.stratum,
    }));
    const evaluationSpecSha256 = put(canonicalJsonBytes({
      protocol: SPEC_PROTOCOL,
      semanticsVersion: "4",
      family: "deterministic-process",
      grader: {
        name: PARSER_ID,
        digest: { sha256: (options.evaluationParserDigest ?? EVALUATION_METHOD_DIGEST).slice("sha256:".length) },
        accessClass: "public",
      },
      familyBlock: {
        image: {
          name: options.evaluationImageName ?? "binary-judgment-evaluation-parser-semantics.json",
          digest: { sha256: options.evaluationImageDigest ?? EVALUATION_METHOD_DIGEST.slice("sha256:".length) },
        },
        platform: "linux/amd64",
        workspace: {},
        parser: {
          id: PARSER_ID,
          version: PARSER_VERSION,
          digest: options.evaluationParserDigest ?? EVALUATION_METHOD_DIGEST,
          ...(options.extraParserField === true ? { source: "inline-code-is-forbidden" } : {}),
        },
        testMaterial: [
          {
            name: "analysis-context.json",
            digest: { sha256: analysisContextSha256.slice("sha256:".length) },
            mediaType: ANALYSIS_MEDIA_TYPE,
            accessClass: "private",
          },
          ...(options.extraTestMaterial === true ? [{
            name: "extra.json",
            digest: { sha256: "e".repeat(64) },
            mediaType: "application/json",
            accessClass: "private",
          }] : []),
        ],
        transitions: { failToPass: [], passToPass: [] },
        timeout: options.evaluationTimeout ?? 60,
      },
      measurements: MEASUREMENTS.map(([name, type]) => ({ name, type, required: true })),
      verdictRule: { threshold: { measurement: "agreement", op: "eq", value: true } },
      unscorable: [],
      evidenceConventions: { requiredRefs: ["label-resolution.json"] },
    }));
    const taskBytes = sealTask({
      protocol: "https://spec.jinn.network/profiles/task-execution/v1",
      profile: {
        uri: options.taskProfileUri ?? TASK_PROFILE_URI,
        digest: { sha256: (options.taskProfileDigest ?? TASK_PROFILE_DIGEST).slice("sha256:".length) },
        ...(options.extraProfileField === true ? { "https://fixtures.example.test/profile-extra": true } : {}),
      },
      instructions: options.taskInstructions ?? "Return exactly ACCEPT or REJECT.",
      payload,
      outputs: [
        { name: "judge-response", mediaType: RESPONSE_MEDIA_TYPE, required: true },
        { name: "judge-observation", mediaType: OBSERVATION_MEDIA_TYPE, required: true },
        { name: "inspect-log", mediaType: INSPECT_LOG_MEDIA_TYPE, required: false },
      ],
      evaluation: { digest: { sha256: evaluationSpecSha256.slice("sha256:".length) } },
      author: "did:key:z6Mksynthetic",
      [ITEM_COMMITMENT_KEY]: options.tamper?.kind === "task-item" && seed.id === "correct"
        ? `sha256:${"f".repeat(64)}`
        : itemSha256,
      ...(options.extraTaskField === true ? { "https://fixtures.example.test/task-extra": true } : {}),
    });
    const taskWire = put(taskBytes);
    items.push({
      ...seed,
      taskDigest: taskWire.slice("sha256:".length),
      labelResolutionSha256,
      analysisContextSha256,
      evaluationSpecSha256,
      payload,
    });
  }

  const run = sealRun({
    protocol: BENCHMARKING_PROTOCOL,
    benchmark: { digest: { sha256: "6".repeat(64) } },
    owner: RUN_OWNER,
    arms: [...instruments.entries()].map(([armId, instrument]) => ({
      armId,
      pinning: { [INSTRUMENT_KEY]: instrument },
    })),
    replicates: 3,
    policy: {
      completenessFloor: "1",
      cellWindow: 60,
      replacement: { allowed: true, maxPerCell: 1 },
      independence: "disclosed",
      evaluation: { minVerdicts: 1, distinctEvaluator: false },
      submissionBaseline: {},
    },
    analysisPlan: [{
      method: "jinn.benchmarking.method/binary-instrument",
      version: "1",
      parameters,
    }],
    closeAt: "2026-08-15T01:00:00Z",
  });
  records.set(run.digest, run.bytes);

  const decisions = new Map<string, readonly ["ACCEPT" | "REJECT", boolean][]>();
  decisions.set(`${items[0]!.taskDigest}/armA`, [["ACCEPT", true], ["ACCEPT", true], ["ACCEPT", true]]);
  decisions.set(`${items[1]!.taskDigest}/armA`, [["ACCEPT", true], ["ACCEPT", true], ["REJECT", false]]);
  decisions.set(`${items[0]!.taskDigest}/armB`, [["REJECT", true], ["REJECT", true], ["ACCEPT", true]]);
  decisions.set(`${items[1]!.taskDigest}/armB`, [["REJECT", true], ["REJECT", true], ["REJECT", false]]);
  decisions.set(`${items[0]!.taskDigest}/armC`, [["ACCEPT", true], ["ACCEPT", true], ["ACCEPT", true]]);
  decisions.set(`${items[1]!.taskDigest}/armC`, [["ACCEPT", true], ["ACCEPT", true], ["REJECT", false]]);
  decisions.set(`${items[0]!.taskDigest}/armD`, [["REJECT", true], ["REJECT", true], ["ACCEPT", true]]);
  decisions.set(`${items[1]!.taskDigest}/armD`, [["REJECT", true], ["REJECT", true], ["REJECT", false]]);

  const cells = items.flatMap((item) => matrixArmIds.flatMap((armId) =>
    Array.from({ length: 3 }, (_, offset) => {
      const replicate = offset + 1;
      const key = cellKey(item.taskDigest, armId, replicate);
      const expired = key === options.expireCell;
      const [decision, parseValid] = decisions.get(`${item.taskDigest}/${armId}`)![offset]!;
      const responseBytes = new TextEncoder().encode(
        options.tamper?.cellKey === key && options.tamper.kind === "response-bom"
          ? `\ufeff${decision}`
          : parseValid ? decision : "MAYBE",
      );
      const responseSha256 = put(responseBytes);
      const instrument = instrumentDocuments.get(armId)!;
      const observationSha256 = put(canonicalJsonBytes({
        protocol: "https://spec.jinn.network/binary-judgment/judge-observation/v1",
        taskDigest: `sha256:${item.taskDigest}`,
        armId: options.tamper?.cellKey === key && options.tamper.kind === "observation-arm"
          ? "armZ"
          : armId,
        replicate,
        instrumentSha256: instruments.get(armId)!,
        requestSha256: semanticRequestDigest(item.payload, instrument),
        response: { digest: responseSha256, mediaType: RESPONSE_MEDIA_TYPE },
        provider: {
          requestedModel: "gpt-5.6-luna",
          resolvedModel: "gpt-5.6-luna",
          responseId: `resp_${sha(key).slice(0, 16)}`,
          eventSha256: `sha256:${sha(`event:${key}`)}`,
          usage: { inputTokens: 10, outputTokens: 1, totalTokens: 11 },
        },
        call: { count: 1, retries: 0, fallbacks: 0 },
        limitations: ["mutable-model-alias"],
      }));
      const verdictBytes = expired ? undefined : resultEvaluation({
        task: item,
        instrumentSha256: instruments.get(armId)!,
        decision,
        parseValid,
        cellKey: key,
        responseSha256,
        observationSha256,
        tamper: options.tamper,
      });
      const verdictDigest = verdictBytes === undefined ? undefined : put(verdictBytes);
      return {
        cellKey: key,
        taskDigest: item.taskDigest,
        armId,
        replicate,
        dispatches: 1,
        accounted: 1,
        submission: `sha256:${sha(`submission:${key}`)}` as const,
        ...(expired ? {} : {
          attempt: exactUuid(`attempt:${key}`),
          delivery: `sha256:${sha(`delivery:${key}`)}` as const,
        }),
        verdicts: verdictDigest === undefined ? [] : [verdictDigest],
        validVerdicts: verdictDigest === undefined ? [] : [verdictDigest],
        outcome: (expired ? "expired" : "judged") as Outcome,
        verification: {
          harness: "match" as const,
          model: "match" as const,
          loadout: "match" as const,
          isolation: "match" as const,
          checksFailed: [],
        },
        integrityTier: "re-derivable" as const,
      };
    }),
  )).sort((left, right) => compareCodeUnitStrings(left.cellKey, right.cellKey));
  const perArm = Object.fromEntries(matrixArmIds.map((armId) => {
    const armCells = cells.filter((cell) => cell.armId === armId);
    const count = (outcome: Outcome): number => armCells.filter((cell) => cell.outcome === outcome).length;
    return [armId, {
      expected: armCells.length,
      judged: count("judged"),
      unjudged: count("unjudged"),
      unscorable: count("unscorable"),
      expired: count("expired"),
      invalidated: count("invalidated"),
      excluded: count("excluded"),
      replacements: 0,
    }];
  }));
  const judged = cells.filter((cell) => cell.outcome === "judged").length;
  const matrixSealed = sealMatrix({
    protocol: BENCHMARKING_PROTOCOL,
    run: { digest: { sha256: run.digest.slice("sha256:".length) } },
    closeBoundary: { at: "2026-08-15T01:00:00Z" },
    cells,
    exclusions: [],
    attrition: { perArm, asymmetryFlags: options.expireCell === undefined ? [] : ["arm-asymmetry"] },
    completeness: {
      expected: cells.length,
      judged,
      floor: "1",
      runOutcome: judged === cells.length ? "complete" : "partial",
    },
    assembly: { procedure: "jinn.benchmarking.assembly", version: "1.0" },
  });
  const matrix = parseMatrix(matrixSealed.bytes);
  const resolve = (digest: string): Uint8Array | undefined => records.get(digest);
  return {
    matrix,
    wrongTaskDigest: items[1]!.taskDigest,
    parserInvalidCellKey: cellKey(items[1]!.taskDigest, "armA", 3),
    input: {
      subjects: [{
        subjectSha256: matrixSealed.digest.slice("sha256:".length),
        matrix,
      }],
      parameters,
      verdictRule: "sole",
      resolveVerdictBytes: resolve,
      resolveRunBytes: resolve,
      resolveTaskBytes: resolve,
      resolveRecordBytes: resolve,
    },
  };
}

describe("binary-instrument@1 registration and parameters", () => {
  test("registers the exact method metadata and closed analysis parameters", () => {
    const method = createMethodRegistry().get("jinn.benchmarking.method/binary-instrument", "1")!;
    expect(method).toMatchObject({
      computeAvailability: "available",
      deterministic: true,
      referenceSet: "v1-reference",
      versionRobust: false,
    });
    expect(method.validateParameters(PARAMETERS)).toEqual({ ok: true });
    expect(method.validateParameters({ ...PARAMETERS, k: 2 }).ok).toBe(false);
    expect(method.validateParameters({
      ...PARAMETERS,
      candidateClasses: ["factual", "contradiction"],
    }).ok).toBe(false);
    expect(method.validateParameters({ ...PARAMETERS, instrument: "armA" }).ok).toBe(false);
  });
});

describe("binary-instrument@1 qualification oracle", () => {
  test("derives item-majority confusion, Wilson rates, parser failures, instability, and slices", () => {
    const fixture = makeFixture();
    const method = createMethodRegistry().get("jinn.benchmarking.method/binary-instrument", "1")!;
    const result = method.compute!(fixture.input).perSubject[0]!.results as any;

    expect(Object.keys(result.arms)).toEqual(["armA", "armB", "armC", "armD"]);
    expect(result.arms.armA).toMatchObject({
      item: { expected: 2, complete: 2, excluded: 0, unstable: 1 },
      call: { expected: 6, evaluated: 6, parseInvalid: 1 },
      confusion: {
        correctAccepted: 1,
        correctRejected: 0,
        wrongAccepted: 1,
        wrongRejected: 0,
      },
      agreement: { numerator: 1, denominator: 2, estimate: "0.5000" },
      falseAccept: { numerator: 1, denominator: 1, estimate: "1.0000" },
      falseReject: { numerator: 0, denominator: 1, estimate: "0.0000" },
      instability: { numerator: 1, denominator: 2, estimate: "0.5000" },
      parserInvalid: { numerator: 1, denominator: 6, estimate: "0.1667" },
    });
    expect(result.arms.armA.agreement.wilsonInterval).toEqual({ low: "0.0945", high: "0.9055" });
    expect(result.arms.armB.confusion).toEqual({
      correctAccepted: 0,
      correctRejected: 1,
      wrongAccepted: 0,
      wrongRejected: 1,
    });
    expect(result.arms.armA.byCandidateClass.factual.falseAccept).toEqual({
      numerator: 0,
      denominator: 0,
      estimate: null,
      wilsonInterval: null,
      withheldReason: "zero-denominator",
    });
    expect(result.arms.armA.byStratum.stress.falseAccept.estimate).toBe("1.0000");
    expect(result.itemDecisions).toHaveLength(8);
    expect(result.itemDecisions.filter((item: any) => item.unstable)).toHaveLength(4);
    expect(result.excluded).toEqual({ count: 0, items: [] });
    expect(result).not.toHaveProperty("ranking");
    expect(result).not.toHaveProperty("selectedInstrument");
  });

  test("keeps transport attrition as an exact item-arm exclusion and withholds zero denominators", () => {
    const preview = makeFixture();
    const expired = cellKey(preview.wrongTaskDigest, "armB", 2);
    const fixture = makeFixture({ expireCell: expired });
    const method = createMethodRegistry().get("jinn.benchmarking.method/binary-instrument", "1")!;
    const result = method.compute!(fixture.input).perSubject[0]!.results as any;

    expect(result.arms.armB).toMatchObject({
      item: { expected: 2, complete: 1, excluded: 1, unstable: 1 },
      call: { expected: 6, evaluated: 5, parseInvalid: 1 },
      falseAccept: {
        numerator: 0,
        denominator: 0,
        estimate: null,
        wilsonInterval: null,
        withheldReason: "zero-denominator",
      },
    });
    expect(result.excluded.count).toBe(1);
    expect(result.excluded.items[0]).toMatchObject({
      armId: "armB",
      reasons: [{ reason: "cell-not-judged", cellKeys: [expired] }],
    });
  });

  test("accepts the exact operator-only label-resolution variant when registered", () => {
    const fixture = makeFixture({ truthAdmission: "operator-only" });
    const method = createMethodRegistry().get("jinn.benchmarking.method/binary-instrument", "1")!;
    const result = method.compute!(fixture.input).perSubject[0]!.results as any;

    expect(result.configuration.truthAdmission).toBe("operator-only");
    expect(result.itemDecisions).toHaveLength(8);
  });
});

describe("binary-instrument@1 tamper refusals", () => {
  test.each([
    { taskProfileDigest: `sha256:${"f".repeat(64)}` as const },
    { responseParserDigest: `sha256:${"f".repeat(64)}` as const },
    { evaluationParserDigest: `sha256:${"f".repeat(64)}` as const },
    { taskProfileDigest: OLD_TASK_PROFILE_DIGEST },
    { taskProfileUri: OLD_TASK_PROFILE_URI },
  ])("rejects drift from frozen profile and parser semantics: %o", (drift) => {
    const fixture = makeFixture(drift);
    const method = createMethodRegistry().get("jinn.benchmarking.method/binary-instrument", "1")!;
    expect(() => method.compute!(fixture.input)).toThrow(expect.objectContaining({
      code: "binary-binding-mismatch",
    }));
  });

  test.each([
    { evaluationImageName: "binary-evaluator-image" },
    { evaluationImageDigest: "c".repeat(64) },
    { evaluationTimeout: 61 },
    { taskInstructions: "Return one binary decision." },
    { extraTaskField: true },
    { extraProfileField: true },
  ])("rejects non-producible frozen Task/EvaluationSpec drift: %o", (drift) => {
    const fixture = makeFixture(drift);
    const method = createMethodRegistry().get("jinn.benchmarking.method/binary-instrument", "1")!;
    expect(() => method.compute!(fixture.input)).toThrow(MethodInputError);
  });

  test.each([
    "instrument",
    "truth",
    "spec",
    "invalid-accept",
    "duplicate-measurement",
    "label-resolution",
    "task-item",
    "observation-arm",
    "label-evidence",
    "task-item-id",
    "response-bom",
  ] as const)("rejects %s drift before aggregation", (kind) => {
    const preview = makeFixture();
    const target = kind === "invalid-accept"
      ? preview.parserInvalidCellKey
      : preview.matrix.cells[0]!.cellKey;
    const fixture = makeFixture({ tamper: { cellKey: target, kind } });
    const method = createMethodRegistry().get("jinn.benchmarking.method/binary-instrument", "1")!;
    expect(() => method.compute!(fixture.input)).toThrow(MethodInputError);
  });

  test("rejects extra EvaluationSpec test material", () => {
    const fixture = makeFixture({ extraTestMaterial: true });
    const method = createMethodRegistry().get("jinn.benchmarking.method/binary-instrument", "1")!;
    expect(() => method.compute!(fixture.input)).toThrow(expect.objectContaining({
      code: "binary-record-malformed",
    }));
  });

  test("rejects extra EvaluationSpec parser fields", () => {
    const fixture = makeFixture({ extraParserField: true });
    const method = createMethodRegistry().get("jinn.benchmarking.method/binary-instrument", "1")!;
    expect(() => method.compute!(fixture.input)).toThrow(expect.objectContaining({
      code: "binary-record-malformed",
    }));
  });

  test("rejects a Run arm omitted from the Matrix", () => {
    const fixture = makeFixture({ extraRunArm: true });
    const method = createMethodRegistry().get("jinn.benchmarking.method/binary-instrument", "1")!;
    expect(() => method.compute!(fixture.input)).toThrow(expect.objectContaining({
      code: "binary-binding-mismatch",
    }));
  });

  test("requires the generic exact-record resolver without affecting legacy method inputs", () => {
    const fixture = makeFixture();
    const method = createMethodRegistry().get("jinn.benchmarking.method/binary-instrument", "1")!;
    const { resolveRecordBytes: _resolveRecordBytes, ...withoutRecordResolver } = fixture.input;
    expect(() => method.compute!(withoutRecordResolver)).toThrow(expect.objectContaining({
      code: "binary-record-unavailable",
    }));
  });

  test("rejects an exact label-resolution whose truth admission drifts from method parameters", () => {
    const fixture = makeFixture({ labelTruthAdmission: "operator-only" });
    const method = createMethodRegistry().get("jinn.benchmarking.method/binary-instrument", "1")!;

    expect(() => method.compute!(fixture.input)).toThrow(expect.objectContaining({
      code: "binary-binding-mismatch",
    }));
  });

  test("rejects reuse of one signed Result Evaluation across scientific replicate cells", () => {
    const fixture = makeFixture();
    const source = fixture.matrix.cells[0]!;
    const target = fixture.matrix.cells.find((cell) =>
      cell.taskDigest === source.taskDigest
      && cell.armId === source.armId
      && cell.cellKey !== source.cellKey)!;
    const duplicateDigest = source.validVerdicts[0]!;
    const resealed = sealMatrix({
      ...fixture.matrix,
      cells: fixture.matrix.cells.map((cell) => cell.cellKey === target.cellKey
        ? { ...cell, verdicts: [duplicateDigest], validVerdicts: [duplicateDigest] }
        : cell),
    });
    const matrix = parseMatrix(resealed.bytes);
    const input: MethodComputeInput = {
      ...fixture.input,
      subjects: [{
        subjectSha256: resealed.digest.slice("sha256:".length),
        matrix,
      }],
    };
    const method = createMethodRegistry().get("jinn.benchmarking.method/binary-instrument", "1")!;
    expect(() => method.compute!(input)).toThrow(expect.objectContaining({
      code: "binary-binding-mismatch",
    }));
  });

  test("accepts a Task payload carrying an evidence string", () => {
    const fixture = makeFixture({ payloadEvidence: "Synthetic supporting evidence text for the fixture item." });
    const method = createMethodRegistry().get("jinn.benchmarking.method/binary-instrument", "1")!;
    expect(() => method.compute!(fixture.input)).not.toThrow();
  });

  test("rejects a Task payload whose evidence is not a string", () => {
    const fixture = makeFixture({ invalidPayloadEvidence: true });
    const method = createMethodRegistry().get("jinn.benchmarking.method/binary-instrument", "1")!;
    expect(() => method.compute!(fixture.input)).toThrow(expect.objectContaining({
      code: "binary-record-malformed",
    }));
  });

  test("rejects a Task payload carrying an unknown extra key", () => {
    const fixture = makeFixture({ extraPayloadField: true });
    const method = createMethodRegistry().get("jinn.benchmarking.method/binary-instrument", "1")!;
    expect(() => method.compute!(fixture.input)).toThrow(expect.objectContaining({
      code: "binary-record-malformed",
    }));
  });

  test("rejects a Task payload whose provenance is the superseded array form", () => {
    const fixture = makeFixture({ arrayProvenance: true });
    const method = createMethodRegistry().get("jinn.benchmarking.method/binary-instrument", "1")!;
    expect(() => method.compute!(fixture.input)).toThrow(expect.objectContaining({
      code: "binary-record-malformed",
    }));
  });
});
