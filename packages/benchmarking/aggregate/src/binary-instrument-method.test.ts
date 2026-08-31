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
import { validateBinaryInstrumentQualificationProjection } from "./binary-instrument-method.js";
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
// A second registered response parser, used to prove the method accepts registry membership
// rather than one pinned identity.
const YES_NO_PARSER_ID = "network.jinn.parser.binary-yes-no" as const;
const YES_NO_PARSER_VERSION = "1.0.0" as const;
const YES_NO_PARSER_DIGEST = "sha256:1b99469a195fee154c27d0c3b219da7778e1b8f4210bd773350d107c459b7949" as const;
// The remaining three registered response-parser contracts, used to prove the replay oracle mirrors
// each contract's own alphabet rather than one hardcoded shape.
const ACCEPT_REJECT_PARSER_ID = "network.jinn.parser.binary-accept-reject" as const;
const CORRECT_WRONG_PARSER_ID = "network.jinn.parser.binary-correct-wrong" as const;
const CORRECT_WRONG_PARSER_VERSION = "1.0.0" as const;
const CORRECT_WRONG_PARSER_DIGEST = "sha256:2dd7e73c9ee063edb00fe7859821eee1122b483d4bd70568aebb046a6983ac4c" as const;
const JSON_VERDICT_PARSER_ID = "network.jinn.parser.binary-json-verdict" as const;
const JSON_VERDICT_PARSER_VERSION = "1.0.0" as const;
const JSON_VERDICT_PARSER_DIGEST = "sha256:543a71887f3ae95b0aede4513af3fdeadfc706c7a86f93452e3272d7ccdd2201" as const;
const LABEL_IN_PROSE_PARSER_ID = "network.jinn.parser.binary-label-in-prose" as const;
const LABEL_IN_PROSE_PARSER_VERSION = "1.0.0" as const;
const LABEL_IN_PROSE_PARSER_DIGEST = "sha256:d53d23afc8734090c8d54c39de8105ead37c3ecad0cf0f454e97a535e5937f10" as const;
const COMPLETE_JSON_LABEL_PARSER_ID = "network.jinn.parser.binary-complete-json-label" as const;
const COMPLETE_JSON_LABEL_PARSER_VERSION = "1.0.0" as const;
const COMPLETE_JSON_LABEL_PARSER_DIGEST = "sha256:db1215184eb98aec6fe26f5412e6e823fbd19f75c5c080fbb58ecd1968503f4b" as const;
const COMPLETE_JSON_LABEL_PARSER_V2_VERSION = "2.0.0" as const;
const COMPLETE_JSON_LABEL_PARSER_V2_DIGEST = "sha256:88545378ce165666102edc22393bbe87950c3a48d325fe142fab0f1c319a1916" as const;
const EVERMEM_JSON_LABEL_PARSER_ID = "network.jinn.parser.binary-evermem-json-label" as const;
const EVERMEM_JSON_LABEL_PARSER_VERSION = "1.0.0" as const;
const EVERMEM_JSON_LABEL_PARSER_DIGEST = "sha256:4834ba3e6c817c560c72afb93a4a5b56c0cf654cf6ff1012843ea7675f507942" as const;
const MEM0_JSON_LABEL_PARSER_ID = "network.jinn.parser.binary-mem0-json-label" as const;
const MEM0_JSON_LABEL_PARSER_VERSION = "1.0.0" as const;
const MEM0_JSON_LABEL_PARSER_DIGEST = "sha256:7453de03b2614395b6cd223f6bfb104d924dfcbd05006d38328307bd7a1d825a" as const;
const STRICT_JSON_LABEL_PARSER_ID = "network.jinn.parser.binary-strict-json-label" as const;
const STRICT_JSON_LABEL_PARSER_VERSION = "1.0.0" as const;
const STRICT_JSON_LABEL_PARSER_DIGEST = "sha256:e5c723c97a55d631d26a8da2badea0df755943987cd679acf7bad7653f48dca6" as const;
const EVALUATION_METHOD_DIGEST = "sha256:3568ee132ece234c15b7f9b6b4a7a954aefc2c417e17f2fde91729a7240bb343" as const;
const EVALUATION_METHOD_V2_DIGEST = "sha256:838a8e4d21893524cba10e5a282397b334a67fe9bc516d53ae20fd4f2b915038" as const;
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
    | "response-bom"
    | "wrong-limitations"
    | "resolved-model-drift";
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

const GENERATION_REASONING = {
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

// The dated-snapshot-sampling generation block (spec §1.3): reasoningEffort is replaced by
// temperature, and maxOutputTokens widens to 512.
const GENERATION_SAMPLING = {
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

// Judge-model profile vocabulary (spec §1.1), mirrored here purely as fixture wiring — the
// production mirror lives in binary-instrument-method.ts.
const PROFILE_BY_MODEL: Record<string, "dated-snapshot-sampling" | "reasoning-2026-08"> = {
  "gpt-5.6-luna": "reasoning-2026-08",
  "gpt-4o-mini-2024-07-18": "dated-snapshot-sampling",
};
const OBSERVATION_LIMITATIONS_BY_PROFILE: Record<"dated-snapshot-sampling" | "reasoning-2026-08", readonly string[]> = {
  "reasoning-2026-08": ["mutable-model-alias"],
  "dated-snapshot-sampling": [],
};

function generationFor(modelId: string) {
  return PROFILE_BY_MODEL[modelId] === "dated-snapshot-sampling" ? GENERATION_SAMPLING : GENERATION_REASONING;
}

function limitationsFor(modelId: string): readonly string[] {
  return OBSERVATION_LIMITATIONS_BY_PROFILE[PROFILE_BY_MODEL[modelId] ?? "reasoning-2026-08"];
}

function sourceDescriptor(seed: string) {
  return {
    uri: `https://example.test/${seed}`,
    digest: { sha256: sha(seed) },
  };
}

/**
 * Encodes the response bytes a given registered response-parser contract would actually produce
 * for a decision, mirroring each contract's own alphabet rather than the bare ACCEPT/REJECT token
 * every fixture used to emit regardless of which parser identity the instrument selected. Each
 * invalid encoding is checked against its contract's own parse rule before use here: whole-token
 * contracts reject any string other than their two tokens, the JSON-verdict contract rejects a
 * `verdict` value outside its two tokens, and the label-in-prose contract requires exactly one of
 * its two tokens to appear as a delimited word.
 */
function encodeParserResponse(
  parserId: string,
  decision: "ACCEPT" | "REJECT",
  parseValid: boolean,
): string {
  switch (parserId) {
    case COMPLETE_JSON_LABEL_PARSER_ID:
      return JSON.stringify({ label: parseValid ? (decision === "ACCEPT" ? "CORRECT" : "WRONG") : 7 });
    case CORRECT_WRONG_PARSER_ID:
      if (!parseValid) return "MAYBE";
      return decision === "ACCEPT" ? "CORRECT" : "WRONG";
    case EVERMEM_JSON_LABEL_PARSER_ID:
      return parseValid
        ? `Result: \`\`\`json\n${JSON.stringify({ label: decision === "ACCEPT" ? "CORRECT" : "WRONG" })}\n\`\`\``
        : "Result: not-json";
    case JSON_VERDICT_PARSER_ID:
      return JSON.stringify({ verdict: parseValid ? decision : "MAYBE" });
    case LABEL_IN_PROSE_PARSER_ID:
      if (!parseValid) {
        return "The reviewer weighed the candidate against the reference and moved on to the next item.";
      }
      return decision === "ACCEPT"
        ? "The reviewer weighed the candidate against the reference and settled on ACCEPT."
        : "The reviewer weighed the candidate against the reference and settled on REJECT.";
    case MEM0_JSON_LABEL_PARSER_ID:
      return parseValid
        ? `\`\`\`json\n${JSON.stringify({ label: decision === "ACCEPT" ? "CORRECT" : "WRONG" })}\n\`\`\``
        : JSON.stringify({ reasoning: "missing label" });
    case STRICT_JSON_LABEL_PARSER_ID:
      return parseValid
        ? JSON.stringify({ label: decision === "ACCEPT" ? "CORRECT" : "WRONG", reasoning: "fixture" })
        : JSON.stringify({ label: decision === "ACCEPT" ? "CORRECT" : "WRONG" });
    case YES_NO_PARSER_ID:
      if (!parseValid) return "MAYBE";
      return decision === "ACCEPT" ? "YES" : "NO";
    case ACCEPT_REJECT_PARSER_ID:
    default:
      return parseValid ? decision : "MAYBE";
  }
}

// Instrument message-segment overrides used only by the evidence-template-field regression
// coverage (packet P5). `omitField` drops one of the three required segments (proving the
// required-fields assertion still refuses); `includeEvidence` adds the optional evidence segment
// (proving the widened allowlist accepts it); `unknownField` adds a segment naming a field outside
// the allowlist entirely (proving the allowlist widened by exactly one member, not into a
// free-for-all). Every default call site passes none of these and gets byte-identical segments to
// before this change.
interface InstrumentFieldOverrides {
  readonly omitField?: "question" | "referenceAnswer" | "candidateAnswer";
  readonly includeEvidence?: boolean;
  readonly unknownField?: string;
}

function makeInstrument(
  armId: string,
  parserDigest: `sha256:${string}`,
  modelId: string = "gpt-5.6-luna",
  parserId: string = "network.jinn.parser.binary-accept-reject",
  parserVersion: string = "1.0.0",
  fieldOverrides: InstrumentFieldOverrides = {},
  parserInvalidPolicy: "reject" | "abstain" = "reject",
) {
  const developerSegments: ({ readonly literal: string } | { readonly field: string })[] = [
    { literal: "Question: " },
    ...(fieldOverrides.omitField === "question" ? [] : [{ field: "question" }]),
    { literal: "\nReference: " },
    ...(fieldOverrides.omitField === "referenceAnswer" ? [] : [{ field: "referenceAnswer" }]),
    { literal: "\nCandidate: " },
    ...(fieldOverrides.omitField === "candidateAnswer" ? [] : [{ field: "candidateAnswer" }]),
    ...(fieldOverrides.includeEvidence === true ? [{ literal: "\nEvidence: " }, { field: "evidence" }] : []),
    ...(fieldOverrides.unknownField !== undefined
      ? [{ literal: "\nUnknown: " }, { field: fieldOverrides.unknownField }]
      : []),
  ];
  const messages = [
    {
      role: "developer",
      segments: developerSegments,
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
      requested: modelId,
      generation: generationFor(modelId),
    },
    response: {
      mediaType: RESPONSE_MEDIA_TYPE,
      parser: {
        id: parserId,
        version: parserVersion,
        digest: parserDigest,
      },
      invalidOutputDecision: parserInvalidPolicy === "abstain" ? "INVALID" : "REJECT",
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
    model: instrument.model.requested,
    messages: rendered,
    generation: instrument.model.generation,
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
  readonly evaluationMethodSha256?: `sha256:${string}`;
  readonly parserInvalidPolicy?: "reject" | "abstain";
  readonly tamper?: Tamper;
}): Uint8Array {
  let truthLabel: "CORRECT" | "WRONG" = input.task.truthLabel;
  let instrumentSha256: string = input.instrumentSha256;
  let evaluationSpecSha256 = input.task.evaluationSpecSha256.slice("sha256:".length);
  let decision: "ACCEPT" | "REJECT" | "INVALID" = input.parseValid || input.parserInvalidPolicy !== "abstain"
    ? input.decision
    : "INVALID";
  if (input.tamper?.cellKey === input.cellKey) {
    if (input.tamper.kind === "truth") truthLabel = truthLabel === "CORRECT" ? "WRONG" : "CORRECT";
    if (input.tamper.kind === "instrument") instrumentSha256 = `sha256:${"f".repeat(64)}`;
    if (input.tamper.kind === "spec") evaluationSpecSha256 = "f".repeat(64);
    if (input.tamper.kind === "invalid-accept") decision = "ACCEPT";
  }
  const agrees = decision === "INVALID" ? false : agreement(decision, truthLabel);
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
        digest: { sha256: (input.evaluationMethodSha256 ?? EVALUATION_METHOD_DIGEST).slice("sha256:".length) },
      },
      evaluationSpecification: {
        name: "evaluation-spec.json",
        digest: { sha256: evaluationSpecSha256 },
      },
      taskSubject: "task.json",
      resultSubjects: ["judge-response", "judge-observation"],
      verdict: decision === "INVALID" ? "inconclusive" : agrees ? "pass" : "fail",
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
  readonly truthAdmission?: "two-human-unanimous" | "operator-only" | "screened-operator-sampled";
  readonly labelTruthAdmission?: "two-human-unanimous" | "operator-only" | "screened-operator-sampled";
  readonly taskProfileDigest?: `sha256:${string}`;
  readonly taskProfileUri?: string;
  readonly responseParserDigest?: `sha256:${string}`;
  readonly responseParserId?: string;
  readonly responseParserVersion?: string;
  // Overrides only the alphabet used to encode cell response bytes, independent of the parser
  // identity the instrument declares. Defaults to responseParserId, so every other fixture keeps
  // its instrument and its response bytes speaking the same alphabet; only the negative replay
  // test deliberately pulls them apart.
  readonly responseBytesParserId?: string;
  readonly evaluationParserDigest?: `sha256:${string}`;
  readonly parserInvalidPolicy?: "reject" | "abstain";
  // Replaces the two per-item decision patterns cycled by arm index. Defaults to the frozen pair
  // below, so every existing fixture keeps its exact bytes; only a test that needs a specific
  // per-cell vote shape (an ACCEPT/REJECT/invalid split, say) supplies its own.
  readonly decisionPatterns?: readonly (readonly (readonly ["ACCEPT" | "REJECT", boolean][])[])[];
  readonly extraRunArm?: boolean;
  readonly extraTestMaterial?: boolean;
  readonly extraParserField?: boolean;
  readonly evaluationImageName?: string;
  readonly evaluationImageDigest?: string;
  readonly evaluationTimeout?: number;
  readonly taskInstructions?: string;
  readonly extraTaskField?: boolean;
  readonly extraProfileField?: boolean;
  readonly armIds?: readonly string[];
  readonly judgeModel?: string;
  readonly undeclaredModelArm?: string;
  readonly generationMismatchArm?: string;
  readonly payloadEvidence?: string;
  readonly invalidPayloadEvidence?: boolean;
  readonly arrayProvenance?: boolean;
  readonly extraPayloadField?: boolean;
  // Evidence template-field regression coverage (packet P5, aggregate-side mirror of P2's
  // BINARY_JUDGMENT_OPTIONAL_TEMPLATE_FIELDS). Setting `evidenceArmId` makes that one arm's
  // instrument interpolate `evidence` (and, unless overridden, gives the Task payload an evidence
  // string so the interpolation is representative). `missingFieldArm` and `unknownFieldArm` corrupt
  // one arm's instrument to prove the required-fields assertion and the malformed-segment refusal
  // both still fire.
  readonly evidenceArmId?: string;
  readonly missingFieldArm?: { readonly armId: string; readonly field: "question" | "referenceAnswer" | "candidateAnswer" };
  readonly unknownFieldArm?: { readonly armId: string; readonly field: string };
} = {}): {
  readonly input: MethodComputeInput;
  readonly matrix: MatrixRecord;
  readonly wrongTaskDigest: string;
  readonly parserInvalidCellKey: string;
} {
  const truthAdmission = options.truthAdmission ?? "two-human-unanimous";
  const labelTruthAdmission = options.labelTruthAdmission ?? truthAdmission;
  const parserInvalidPolicy = options.parserInvalidPolicy ?? "reject";
  const parameters = { ...PARAMETERS, truthAdmission, parserInvalidPolicy };
  const instrumentParserId = options.responseParserId
    ?? (parserInvalidPolicy === "abstain" ? COMPLETE_JSON_LABEL_PARSER_ID : ACCEPT_REJECT_PARSER_ID);
  const responseParserVersion = options.responseParserVersion
    ?? (parserInvalidPolicy === "abstain" ? COMPLETE_JSON_LABEL_PARSER_V2_VERSION : "1.0.0");
  const responseParserDigest = options.responseParserDigest
    ?? (parserInvalidPolicy === "abstain" ? COMPLETE_JSON_LABEL_PARSER_V2_DIGEST : RESPONSE_PARSER_DIGEST);
  const evaluationParserVersion = parserInvalidPolicy === "abstain" ? "2.0.0" : PARSER_VERSION;
  const evaluationParserDigest = options.evaluationParserDigest
    ?? (parserInvalidPolicy === "abstain" ? EVALUATION_METHOD_V2_DIGEST : EVALUATION_METHOD_DIGEST);
  const responseBytesParserId = options.responseBytesParserId ?? instrumentParserId;
  const records = new Map<string, Uint8Array>();
  const put = (bytes: Uint8Array): `sha256:${string}` => {
    const digest = recordDigest(bytes) as `sha256:${string}`;
    records.set(digest, bytes);
    return digest;
  };
  const matrixArmIds: readonly string[] = options.armIds ?? ["armA", "armB", "armC", "armD"];
  const instruments = new Map<string, `sha256:${string}`>();
  const instrumentDocuments = new Map<string, ReturnType<typeof makeInstrument>>();
  for (const armId of options.extraRunArm === true ? [...matrixArmIds, "armExtra"] : matrixArmIds) {
    let document = makeInstrument(
      armId,
      responseParserDigest,
      options.judgeModel,
      instrumentParserId,
      responseParserVersion,
      {
        includeEvidence: options.evidenceArmId === armId,
        omitField: options.missingFieldArm?.armId === armId ? options.missingFieldArm.field : undefined,
        unknownField: options.unknownFieldArm?.armId === armId ? options.unknownFieldArm.field : undefined,
      },
      parserInvalidPolicy,
    );
    if (options.undeclaredModelArm === armId) {
      document = { ...document, model: { ...document.model, requested: "gpt-9-undeclared" } };
    }
    if (options.generationMismatchArm === armId) {
      // Force the OTHER profile's generation shape onto this arm's declared model, producing a
      // stray-key mismatch that requireExactKeys must refuse (spec §1.3).
      const wrongGeneration = document.model.generation === GENERATION_SAMPLING
        ? GENERATION_REASONING
        : GENERATION_SAMPLING;
      document = { ...document, model: { ...document.model, generation: wrongGeneration } };
    }
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
      ...(options.payloadEvidence !== undefined ? { evidence: options.payloadEvidence }
        : options.evidenceArmId !== undefined
          ? { evidence: "Synthetic supporting evidence text for the fixture item." }
          : {}),
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
      truthLabel: labelTruth,
      candidateClass: seed.candidateClass,
      stratum: seed.stratum,
      resolvedAt: "2026-08-14T23:00:00Z",
      truthAdmission: labelTruthAdmission,
      ...(labelTruthAdmission === "two-human-unanimous" ? {
        humanReviewEvaluationSpecSha256: `sha256:${"1".repeat(64)}`,
        reviewVerdictSha256s: [`sha256:${"2".repeat(64)}`, `sha256:${"3".repeat(64)}`],
        reviewerRosterSha256: `sha256:${"4".repeat(64)}`,
        visibilityReceiptSha256s: [`sha256:${"5".repeat(64)}`, `sha256:${"6".repeat(64)}`],
        revealReceiptSha256: `sha256:${"7".repeat(64)}`,
      } : labelTruthAdmission === "operator-only" ? {
        humanReviewEvaluationSpecSha256: `sha256:${"1".repeat(64)}`,
        operatorAssertionSha256: `sha256:${"2".repeat(64)}`,
      } : {
        screeningTableSha256: `sha256:${"1".repeat(64)}`,
        screeningRevealReceiptSha256: `sha256:${"2".repeat(64)}`,
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
        digest: { sha256: evaluationParserDigest.slice("sha256:".length) },
        accessClass: "public",
      },
      familyBlock: {
        image: {
          name: options.evaluationImageName ?? "binary-judgment-evaluation-parser-semantics.json",
          digest: { sha256: options.evaluationImageDigest ?? evaluationParserDigest.slice("sha256:".length) },
        },
        platform: "linux/amd64",
        workspace: {},
        parser: {
          id: PARSER_ID,
          version: evaluationParserVersion,
          digest: evaluationParserDigest,
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
      // Mirrors the sealed builder: the abstain policy declares its recorded-inconclusive class
      // and the inconclusiveWhen node that makes an `inconclusive` delivery legal at all.
      verdictRule: parserInvalidPolicy === "abstain"
        ? {
          all: [
            {
              class: "unparseable-judge-response",
              inconclusiveWhen: { threshold: { measurement: "parseValid", op: "eq", value: false } },
            },
            { threshold: { measurement: "agreement", op: "eq", value: true } },
          ],
        }
        : { threshold: { measurement: "agreement", op: "eq", value: true } },
      unscorable: parserInvalidPolicy === "abstain"
        ? [{ name: "unparseable-judge-response", disposition: "recorded-inconclusive" }]
        : [],
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

  // Two decision patterns, cycled by arm index so any arm count reproduces the original armA-D
  // fixture byte for byte (armC repeats armA's pattern, armD repeats armB's, exactly as before).
  const DECISION_PATTERNS: readonly (readonly (readonly ["ACCEPT" | "REJECT", boolean][])[])[] = [
    [
      [["ACCEPT", true], ["ACCEPT", true], ["ACCEPT", true]],
      [["ACCEPT", true], ["ACCEPT", true], ["REJECT", false]],
    ],
    [
      [["REJECT", true], ["REJECT", true], ["ACCEPT", true]],
      [["REJECT", true], ["REJECT", true], ["REJECT", false]],
    ],
  ];
  const decisionPatterns = options.decisionPatterns ?? DECISION_PATTERNS;
  const decisions = new Map<string, readonly ["ACCEPT" | "REJECT", boolean][]>();
  matrixArmIds.forEach((armId, armIndex) => {
    const pattern = decisionPatterns[armIndex % decisionPatterns.length]!;
    decisions.set(`${items[0]!.taskDigest}/${armId}`, pattern[0]!);
    decisions.set(`${items[1]!.taskDigest}/${armId}`, pattern[1]!);
  });

  const cells = items.flatMap((item) => matrixArmIds.flatMap((armId) =>
    Array.from({ length: 3 }, (_, offset) => {
      const replicate = offset + 1;
      const key = cellKey(item.taskDigest, armId, replicate);
      const expired = key === options.expireCell;
      const [decision, parseValid] = decisions.get(`${item.taskDigest}/${armId}`)![offset]!;
      const encodedResponse = encodeParserResponse(responseBytesParserId, decision, parseValid);
      const responseText = parserInvalidPolicy === "abstain" && parseValid
        ? `\`\`\`json\n${encodedResponse}\n\`\`\``
        : encodedResponse;
      const responseBytes = new TextEncoder().encode(
        options.tamper?.cellKey === key && options.tamper.kind === "response-bom"
          ? `\ufeff${responseText}`
          : responseText,
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
          requestedModel: instrument.model.requested,
          resolvedModel: options.tamper?.cellKey === key && options.tamper.kind === "resolved-model-drift"
            ? "gpt-9-drifted"
            : instrument.model.requested,
          responseId: `resp_${sha(key).slice(0, 16)}`,
          eventSha256: `sha256:${sha(`event:${key}`)}`,
          usage: { inputTokens: 10, outputTokens: 1, totalTokens: 11 },
        },
        call: { count: 1, retries: 0, fallbacks: 0 },
        limitations: options.tamper?.cellKey === key && options.tamper.kind === "wrong-limitations"
          // The wrong tuple for this arm's own profile: swap presence for absence.
          ? (limitationsFor(instrument.model.requested).length === 0 ? ["mutable-model-alias"] : [])
          : limitationsFor(instrument.model.requested),
      }));
      const verdictBytes = expired ? undefined : resultEvaluation({
        task: item,
        instrumentSha256: instruments.get(armId)!,
        decision,
        parseValid,
        cellKey: key,
        responseSha256,
        observationSha256,
        evaluationMethodSha256: evaluationParserDigest,
        parserInvalidPolicy,
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

  // spec §6.7 (packet P6): truthAdmission widens to a third value. Existing parameter sets
  // (PARAMETERS above, at "two-human-unanimous") still validate byte-identically (§0.4).
  test("accepts the screened-operator-sampled truthAdmission value", () => {
    const method = createMethodRegistry().get("jinn.benchmarking.method/binary-instrument", "1")!;
    expect(method.validateParameters({ ...PARAMETERS, truthAdmission: "screened-operator-sampled" }))
      .toEqual({ ok: true });
    expect(method.validateParameters({ ...PARAMETERS, truthAdmission: "not-a-real-mode" }).ok).toBe(false);
  });
});

describe("binary-instrument@1 judge-model profile parameter (spec §1.4)", () => {
  test("accepts a parameter set with no judgeModelProfile — the compatibility proof", () => {
    const method = createMethodRegistry().get("jinn.benchmarking.method/binary-instrument", "1")!;
    expect(Object.hasOwn(PARAMETERS, "judgeModelProfile")).toBe(false);
    expect(method.validateParameters(PARAMETERS)).toEqual({ ok: true });
  });

  test("accepts each declared judge-model profile id", () => {
    const method = createMethodRegistry().get("jinn.benchmarking.method/binary-instrument", "1")!;
    expect(method.validateParameters({ ...PARAMETERS, judgeModelProfile: "reasoning-2026-08" }))
      .toEqual({ ok: true });
    expect(method.validateParameters({ ...PARAMETERS, judgeModelProfile: "dated-snapshot-sampling" }))
      .toEqual({ ok: true });
  });

  test("refuses an undeclared judgeModelProfile value and any other unknown key", () => {
    const method = createMethodRegistry().get("jinn.benchmarking.method/binary-instrument", "1")!;
    expect(method.validateParameters({ ...PARAMETERS, judgeModelProfile: "something-else" }).ok).toBe(false);
    expect(method.validateParameters({ ...PARAMETERS, unknownField: "x" }).ok).toBe(false);
  });
});

describe("binary-instrument@1 prompted-screening profile parameter (spec §6.11.4)", () => {
  test("keeps legacy parameters valid when the optional profile is absent", () => {
    const method = createMethodRegistry().get("jinn.benchmarking.method/binary-instrument", "1")!;
    expect(Object.hasOwn(PARAMETERS, "promptedScreeningProfile")).toBe(false);
    expect(method.validateParameters(PARAMETERS)).toEqual({ ok: true });
  });

  test("accepts only the authenticated prompted-v2 profile id", () => {
    const method = createMethodRegistry().get("jinn.benchmarking.method/binary-instrument", "1")!;
    expect(method.validateParameters({ ...PARAMETERS, promptedScreeningProfile: "prompted-codex-screening/v1" })).toEqual({ ok: true });
    expect(method.validateParameters({ ...PARAMETERS, promptedScreeningProfile: "prompted-codex-screening/v2" }).ok).toBe(false);
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

  test("replays fenced v2 JSON, preserves neutral invalid calls, and publishes only valid majorities", () => {
    const fixture = makeFixture({ parserInvalidPolicy: "abstain" });
    const method = createMethodRegistry().get("jinn.benchmarking.method/binary-instrument", "1")!;
    const result = method.compute!(fixture.input).perSubject[0]!.results as any;

    expect(result.configuration.parserInvalidPolicy).toBe("abstain");
    expect(result.itemDecisions).toHaveLength(8);
    expect(result.excluded).toEqual({ count: 0, items: [] });
    expect(Object.values(result.arms).some((arm: any) => arm.call.parseInvalid > 0)).toBe(true);
  });

  // The visible half of abstaining. A 1-1 split plus one invalid call has no valid majority, so
  // the item-arm group must leave `itemDecisions` entirely and surface in the published
  // qualification as a `no-valid-majority` exclusion -- never as a manufactured REJECT, and never
  // silently dropped. The projection validator must accept the document that carries it.
  test("publishes a no-valid-majority exclusion when an invalid call breaks the tie", () => {
    const fixture = makeFixture({
      parserInvalidPolicy: "abstain",
      decisionPatterns: [
        [
          [["ACCEPT", true], ["ACCEPT", true], ["ACCEPT", true]],
          // One ACCEPT, one REJECT, one parser-invalid: no side reaches the majority of 2.
          [["ACCEPT", true], ["REJECT", true], ["REJECT", false]],
        ],
        [
          [["REJECT", true], ["REJECT", true], ["ACCEPT", true]],
          [["REJECT", true], ["REJECT", true], ["REJECT", false]],
        ],
      ],
    });
    const method = createMethodRegistry().get("jinn.benchmarking.method/binary-instrument", "1")!;
    const result = method.compute!(fixture.input).perSubject[0]!.results as any;

    // Four arms cycle two patterns, so the split pattern lands on the two even-indexed arms.
    expect(result.itemDecisions).toHaveLength(6);
    expect(result.excluded.count).toBe(2);
    expect(result.excluded.items.map((item: any) => item.reasons)).toEqual([
      [{ reason: "no-valid-majority", cellKeys: expect.any(Array) }],
      [{ reason: "no-valid-majority", cellKeys: expect.any(Array) }],
    ]);
    for (const item of result.excluded.items) {
      expect(item.cellKeys).toHaveLength(3);
      expect(item.reasons[0].cellKeys).toEqual(item.cellKeys);
    }
    expect(validateBinaryInstrumentQualificationProjection(result)).toEqual({ ok: true });
  });

  // The sealed profiles schema ties `invalidOutputDecision` to the selected parser PAIR, so an
  // instrument pinning a v1 parser while declaring INVALID has bytes that could never have been
  // sealed. Checking it against the run-level parameter alone would have admitted exactly that
  // document under `abstain`; the aggregate mirror must refuse it the same way the schema does.
  test("refuses an instrument that declares INVALID while pinning a v1 parser pair", () => {
    const fixture = makeFixture({
      parserInvalidPolicy: "abstain",
      responseParserId: ACCEPT_REJECT_PARSER_ID,
      responseParserVersion: "1.0.0",
      responseParserDigest: RESPONSE_PARSER_DIGEST,
    });
    const method = createMethodRegistry().get("jinn.benchmarking.method/binary-instrument", "1")!;
    expect(() => method.compute!(fixture.input)).toThrow(expect.objectContaining({
      code: "binary-binding-mismatch",
      message: expect.stringContaining("instrument invalidOutputDecision does not match its registered parser pair"),
    }));
  });

  test.each([
    {
      name: "yes-no",
      responseParserId: YES_NO_PARSER_ID,
      responseParserVersion: YES_NO_PARSER_VERSION,
      responseParserDigest: YES_NO_PARSER_DIGEST,
    },
    {
      name: "complete-json-label",
      responseParserId: COMPLETE_JSON_LABEL_PARSER_ID,
      responseParserVersion: COMPLETE_JSON_LABEL_PARSER_VERSION,
      responseParserDigest: COMPLETE_JSON_LABEL_PARSER_DIGEST,
    },
    {
      name: "correct-wrong",
      responseParserId: CORRECT_WRONG_PARSER_ID,
      responseParserVersion: CORRECT_WRONG_PARSER_VERSION,
      responseParserDigest: CORRECT_WRONG_PARSER_DIGEST,
    },
    {
      name: "json-verdict",
      responseParserId: JSON_VERDICT_PARSER_ID,
      responseParserVersion: JSON_VERDICT_PARSER_VERSION,
      responseParserDigest: JSON_VERDICT_PARSER_DIGEST,
    },
    {
      name: "label-in-prose",
      responseParserId: LABEL_IN_PROSE_PARSER_ID,
      responseParserVersion: LABEL_IN_PROSE_PARSER_VERSION,
      responseParserDigest: LABEL_IN_PROSE_PARSER_DIGEST,
    },
    {
      name: "evermem-json-label",
      responseParserId: EVERMEM_JSON_LABEL_PARSER_ID,
      responseParserVersion: EVERMEM_JSON_LABEL_PARSER_VERSION,
      responseParserDigest: EVERMEM_JSON_LABEL_PARSER_DIGEST,
    },
    {
      name: "mem0-json-label",
      responseParserId: MEM0_JSON_LABEL_PARSER_ID,
      responseParserVersion: MEM0_JSON_LABEL_PARSER_VERSION,
      responseParserDigest: MEM0_JSON_LABEL_PARSER_DIGEST,
    },
    {
      name: "strict-json-label",
      responseParserId: STRICT_JSON_LABEL_PARSER_ID,
      responseParserVersion: STRICT_JSON_LABEL_PARSER_VERSION,
      responseParserDigest: STRICT_JSON_LABEL_PARSER_DIGEST,
    },
  ])(
    "accepts an instrument naming a different registered response parser, replayed against that parser's own alphabet ($name)",
    ({ responseParserId, responseParserVersion, responseParserDigest }) => {
      const fixture = makeFixture({ responseParserId, responseParserVersion, responseParserDigest });
      const method = createMethodRegistry().get("jinn.benchmarking.method/binary-instrument", "1")!;
      const result = method.compute!(fixture.input).perSubject[0]!.results as any;

      expect(result.itemDecisions).toHaveLength(8);
    },
  );

  // spec §6.7 third member (packet P6): screened by a pinned model, sampled and hand-checked by
  // the operator. No humanReviewEvaluationSpecSha256 on this branch's label resolution.
  test("accepts the exact screened-operator-sampled label-resolution variant when registered", () => {
    const fixture = makeFixture({ truthAdmission: "screened-operator-sampled" });
    const method = createMethodRegistry().get("jinn.benchmarking.method/binary-instrument", "1")!;
    const result = method.compute!(fixture.input).perSubject[0]!.results as any;

    expect(result.configuration.truthAdmission).toBe("screened-operator-sampled");
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
    { responseParserVersion: "2.0.0" },
    { responseParserId: "network.jinn.parser.binary-unregistered" },
    {
      responseParserId: YES_NO_PARSER_ID,
      responseParserVersion: YES_NO_PARSER_VERSION,
      responseParserDigest: RESPONSE_PARSER_DIGEST,
    },
  ])("rejects drift from frozen profile and parser semantics: %o", (drift) => {
    const fixture = makeFixture(drift);
    const method = createMethodRegistry().get("jinn.benchmarking.method/binary-instrument", "1")!;
    expect(() => method.compute!(fixture.input)).toThrow(expect.objectContaining({
      code: "binary-binding-mismatch",
    }));
  });

  test("refuses a yes-no instrument whose cells replay a different registered parser's response bytes", () => {
    const fixture = makeFixture({
      responseParserId: YES_NO_PARSER_ID,
      responseParserVersion: YES_NO_PARSER_VERSION,
      responseParserDigest: YES_NO_PARSER_DIGEST,
      responseBytesParserId: ACCEPT_REJECT_PARSER_ID,
    });
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
    "wrong-limitations",
    "resolved-model-drift",
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

// Regression coverage for the aggregate-side mirror of P2's BINARY_JUDGMENT_OPTIONAL_TEMPLATE_FIELDS
// (packet P5, issue #2837): an evidence-declaring arm's instrument used to pass lock and then throw
// `binary-record-malformed: instrument field segment is unsupported` at report time, in the PRIMARY
// readout, blocking the whole flagship judge run. Every test in this block drives that primary
// readout through `method.compute!`, which for this method IS `computeBinaryInstrumentQualification`
// (registry.ts wires `compute: computeBinaryInstrumentQualification` for binaryInstrumentMethod, and
// `subjectScopedMethod` calls that field directly per subject) — not one of the two newer P5
// cross-arm methods, which only run after this one succeeds.
describe("binary-instrument@1 evidence template field (packet P5, aggregate-side mirror of P2)", () => {
  test("computes for an evidence-declaring arm via computeBinaryInstrumentQualification (the primary readout)", () => {
    const fixture = makeFixture({ evidenceArmId: "armA" });
    const method = createMethodRegistry().get("jinn.benchmarking.method/binary-instrument", "1")!;

    const result = method.compute!(fixture.input).perSubject[0]!.results as any;
    expect(Object.keys(result.arms)).toEqual(["armA", "armB", "armC", "armD"]);
    expect(result.itemDecisions).toHaveLength(8);
  });

  test("still refuses an instrument missing a required solver-visible field (the trap the widening must not spring)", () => {
    const fixture = makeFixture({ missingFieldArm: { armId: "armA", field: "candidateAnswer" } });
    const method = createMethodRegistry().get("jinn.benchmarking.method/binary-instrument", "1")!;

    expect(() => method.compute!(fixture.input)).toThrow(expect.objectContaining({
      code: "binary-binding-mismatch",
      message: expect.stringContaining("instrument prompt must interpolate every solver-visible field"),
    }));
  });

  test("still rejects an instrument field segment outside the widened allowlist", () => {
    const fixture = makeFixture({ unknownFieldArm: { armId: "armA", field: "notAnAcceptedField" } });
    const method = createMethodRegistry().get("jinn.benchmarking.method/binary-instrument", "1")!;

    expect(() => method.compute!(fixture.input)).toThrow(expect.objectContaining({
      code: "binary-record-malformed",
    }));
  });
});

describe("binary-instrument@1 arm cardinality (spec §1.6, sites 4 to 6)", () => {
  test("computes a six-arm panel end to end with a derived, non-literal armCount", () => {
    const fixture = makeFixture({ armIds: ["armA", "armB", "armC", "armD", "armE", "armF"] });
    const method = createMethodRegistry().get("jinn.benchmarking.method/binary-instrument", "1")!;
    const result = method.compute!(fixture.input).perSubject[0]!.results as any;

    expect(Object.keys(result.arms)).toEqual(["armA", "armB", "armC", "armD", "armE", "armF"]);
    // armE/armF repeat armA/armB's decision pattern (DECISION_PATTERNS cycles by index), so their
    // statistics agree; only the per-arm instrumentSha256 differs (it is keyed by armId).
    const { instrumentSha256: _armAInstrument, ...armAStats } = result.arms.armA;
    const { instrumentSha256: _armEInstrument, ...armEStats } = result.arms.armE;
    const { instrumentSha256: _armBInstrument, ...armBStats } = result.arms.armB;
    const { instrumentSha256: _armFInstrument, ...armFStats } = result.arms.armF;
    expect(armEStats).toEqual(armAStats);
    expect(armFStats).toEqual(armBStats);
  });

  test("refuses a Run/Matrix panel below the two-arm floor", () => {
    const fixture = makeFixture({ armIds: ["armOnly"] });
    const method = createMethodRegistry().get("jinn.benchmarking.method/binary-instrument", "1")!;
    expect(() => method.compute!(fixture.input)).toThrow(expect.objectContaining({
      code: "binary-binding-mismatch",
    }));
  });
});

describe("binary-instrument@1 judge-model profiles end to end (spec §1.1-§1.4)", () => {
  test("computes a dated-snapshot-sampling panel end to end", () => {
    const fixture = makeFixture({ judgeModel: "gpt-4o-mini-2024-07-18" });
    const method = createMethodRegistry().get("jinn.benchmarking.method/binary-instrument", "1")!;
    const result = method.compute!(fixture.input).perSubject[0]!.results as any;

    expect(Object.keys(result.arms)).toEqual(["armA", "armB", "armC", "armD"]);
    expect(result.itemDecisions).toHaveLength(8);
  });

  test("refuses an instrument whose requested model is not a declared judge-model profile", () => {
    const fixture = makeFixture({ undeclaredModelArm: "armA" });
    const method = createMethodRegistry().get("jinn.benchmarking.method/binary-instrument", "1")!;
    expect(() => method.compute!(fixture.input)).toThrow(expect.objectContaining({
      code: "binary-binding-mismatch",
    }));
  });

  test("refuses an instrument whose generation block mismatches its declared model's profile", () => {
    const fixture = makeFixture({ generationMismatchArm: "armA" });
    const method = createMethodRegistry().get("jinn.benchmarking.method/binary-instrument", "1")!;
    expect(() => method.compute!(fixture.input)).toThrow(expect.objectContaining({
      code: "binary-record-malformed",
    }));
  });
});
