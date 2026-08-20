// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";
import { Buffer } from "node:buffer";

import { canonicalJsonBytes, recordDigest, sealDocument } from "../bytes.js";
import {
  BINARY_JUDGMENT_ANALYSIS_CONTEXT_FORMAT_URI,
  BINARY_JUDGMENT_EVALUATION_CONTEXT_FORMAT_URI,
  BINARY_JUDGMENT_INSTRUMENT_FORMAT_URI,
  BINARY_JUDGMENT_OBSERVATION_FORMAT_URI,
  BINARY_JUDGMENT_PARSER_SEMANTICS_FORMAT_URI,
  BINARY_JUDGMENT_RESPONSE_MEDIA_TYPE,
  BINARY_JUDGMENT_SNAPSHOT_PROBE_FORMAT_URI,
} from "../identifiers.js";
import { compareCodeUnitStrings } from "../order.js";
import { assertValidDocument, parseJsonDocument } from "../zod-parse.js";

const Sha256DigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const Sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const NonEmptyStringSchema = z.string().min(1);
export const BinaryJudgmentItemIdSchema = z.string().regex(
  /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
);

function decodeCanonicalBase64(value: string): Uint8Array | undefined {
  try {
    const decoded = Buffer.from(value, "base64");
    if (decoded.byteLength === 0 || decoded.toString("base64") !== value) return undefined;
    return new Uint8Array(decoded);
  } catch {
    return undefined;
  }
}

export const CanonicalBase64Schema = z.string().superRefine((value, ctx) => {
  if (decodeCanonicalBase64(value) === undefined) {
    ctx.addIssue({ code: "custom", message: "bytesBase64 must be non-empty canonical RFC 4648 base64" });
  }
});

export const BinaryJudgmentInlineMaterialSchema = z.strictObject({
  digest: Sha256DigestSchema,
  bytesBase64: CanonicalBase64Schema,
}).superRefine((material, ctx) => {
  const bytes = decodeCanonicalBase64(material.bytesBase64);
  if (bytes !== undefined) {
    const actual = recordDigest(bytes);
    if (actual !== material.digest) {
      ctx.addIssue({
        code: "custom",
        path: ["digest"],
        message: `material digest does not match bytesBase64 (${actual})`,
      });
    }
  }
});
export type BinaryJudgmentInlineMaterial = z.infer<typeof BinaryJudgmentInlineMaterialSchema>;

export function decodeBinaryJudgmentInlineMaterial(
  material: BinaryJudgmentInlineMaterial,
): Uint8Array {
  const validated = assertValidDocument(
    BinaryJudgmentInlineMaterialSchema,
    material,
    "BinaryJudgmentInlineMaterial",
  );
  return decodeCanonicalBase64(validated.bytesBase64)!;
}

/**
 * A digest-only in-toto ResourceDescriptor projection for solver-visible provenance. Source
 * names and locators remain in the source manifest because even an innocent-looking URI can
 * become a covert truth/class channel into the judge Task.
 */
export const BinaryJudgmentProvenanceDescriptorSchema = z.strictObject({
  digest: z.strictObject({ sha256: Sha256HexSchema }),
});
export type BinaryJudgmentProvenanceDescriptor = z.infer<
  typeof BinaryJudgmentProvenanceDescriptorSchema
>;

/** Full public source/license descriptor for instrument custody, never rendered to the model. */
export const BinaryJudgmentSourceDescriptorSchema = z.strictObject({
  name: NonEmptyStringSchema.optional(),
  uri: NonEmptyStringSchema,
  digest: z.strictObject({ sha256: Sha256HexSchema }),
  mediaType: NonEmptyStringSchema.optional(),
  downloadLocation: NonEmptyStringSchema.optional(),
});
export type BinaryJudgmentSourceDescriptor = z.infer<typeof BinaryJudgmentSourceDescriptorSchema>;

/** The complete solver-visible body. Unknown fields are truth-leak attempts and fail closed. */
export const BinaryJudgmentPayloadSchema = z.strictObject({
  itemId: BinaryJudgmentItemIdSchema,
  question: z.string(),
  referenceAnswer: z.string(),
  candidateAnswer: z.string(),
  provenance: z.array(BinaryJudgmentProvenanceDescriptorSchema).min(1),
});
export type BinaryJudgmentPayload = z.infer<typeof BinaryJudgmentPayloadSchema>;

export const BINARY_JUDGMENT_TEMPLATE_FIELDS = [
  "question",
  "referenceAnswer",
  "candidateAnswer",
] as const;
export type BinaryJudgmentTemplateField = (typeof BINARY_JUDGMENT_TEMPLATE_FIELDS)[number];

export const BinaryJudgmentTemplateSegmentSchema = z.union([
  z.strictObject({ literal: z.string() }),
  z.strictObject({ field: z.enum(BINARY_JUDGMENT_TEMPLATE_FIELDS) }),
]);
export type BinaryJudgmentTemplateSegment = z.infer<typeof BinaryJudgmentTemplateSegmentSchema>;

export const BinaryJudgmentMessageTemplateSchema = z.strictObject({
  role: z.enum(["developer", "user"]),
  segments: z.array(BinaryJudgmentTemplateSegmentSchema).min(1),
});
export type BinaryJudgmentMessageTemplate = z.infer<typeof BinaryJudgmentMessageTemplateSchema>;

export const BinaryJudgmentMessageSchema = z.strictObject({
  role: z.enum(["developer", "user"]),
  text: z.string(),
});
export type BinaryJudgmentMessage = z.infer<typeof BinaryJudgmentMessageSchema>;

// The closed set of judge-model profiles (spec §1.1). A judge-model profile is a named triple
// of (accepted model.requested literal set, generation block shape, observation limitations).
export const JUDGE_MODEL_PROFILE_IDS = ["dated-snapshot-sampling", "reasoning-2026-08"] as const;
export type JudgeModelProfileId = (typeof JUDGE_MODEL_PROFILE_IDS)[number];

/** Closed literal set. Adding a member is a code change with a test, never configuration. */
export const DATED_SNAPSHOT_MODELS = ["gpt-4o-mini-2024-07-18"] as const;
export type DatedSnapshotJudgeModelId = (typeof DATED_SNAPSHOT_MODELS)[number];

/** The profile is a TOTAL FUNCTION of model.requested. The instrument gains no new field. */
export const JUDGE_MODEL_PROFILES = {
  "gpt-4o-mini-2024-07-18": "dated-snapshot-sampling",
  "gpt-5.6-luna": "reasoning-2026-08",
} as const satisfies Readonly<Record<string, JudgeModelProfileId>>;

export type AcceptedJudgeModelId = keyof typeof JUDGE_MODEL_PROFILES;
/** Code-unit sorted. */
export const ACCEPTED_JUDGE_MODEL_IDS = ["gpt-4o-mini-2024-07-18", "gpt-5.6-luna"] as const;

export function judgeModelProfileFor(model: string): JudgeModelProfileId | undefined {
  return Object.hasOwn(JUDGE_MODEL_PROFILES, model)
    ? JUDGE_MODEL_PROFILES[model as AcceptedJudgeModelId]
    : undefined;
}

export function isDatedSnapshotJudgeModel(model: string): model is DatedSnapshotJudgeModelId {
  return (DATED_SNAPSHOT_MODELS as readonly string[]).includes(model);
}

/**
 * Per-profile observation limitations. A mutable alias is a real limitation of an undated model
 * id and a false claim about a dated snapshot.
 */
export const BINARY_JUDGMENT_OBSERVATION_LIMITATIONS = ["mutable-model-alias"] as const;
export const JUDGE_MODEL_PROFILE_OBSERVATION_LIMITATIONS = {
  "dated-snapshot-sampling": [],
  "reasoning-2026-08": ["mutable-model-alias"],
} as const satisfies Readonly<Record<JudgeModelProfileId, readonly string[]>>;

export const BinaryJudgmentReasoningGenerationSchema = z.strictObject({
  reasoningEffort: z.enum(["none", "low"]),
  maxOutputTokens: z.literal(128),
  store: z.literal(false),
  background: z.literal(false),
  stream: z.literal(false),
  serviceTier: z.literal("default"),
  tools: z.tuple([]),
  fallbackModels: z.tuple([]),
  retries: z.literal(0),
  persistedConversation: z.literal(false),
  metadata: z.null(),
  promptCacheIdentifier: z.null(),
});
export type BinaryJudgmentReasoningGeneration = z.infer<
  typeof BinaryJudgmentReasoningGenerationSchema
>;

export const BinaryJudgmentSamplingGenerationSchema = z.strictObject({
  temperature: z.literal(0),
  maxOutputTokens: z.literal(512),
  store: z.literal(false),
  background: z.literal(false),
  stream: z.literal(false),
  serviceTier: z.literal("default"),
  tools: z.tuple([]),
  fallbackModels: z.tuple([]),
  retries: z.literal(0),
  persistedConversation: z.literal(false),
  metadata: z.null(),
  promptCacheIdentifier: z.null(),
});
export type BinaryJudgmentSamplingGeneration = z.infer<
  typeof BinaryJudgmentSamplingGenerationSchema
>;

// The union cannot carry its own discriminator. The sibling key that decides which variant
// applies always lives in the parent object (`model.requested` on the instrument, `model` on
// the semantic request, `model` on the verify package's arm schema), never inside the
// generation block itself. Profile agreement is therefore enforced by three parent-level
// `superRefine` checks, one per consumer, and not by this schema.
export const BinaryJudgmentGenerationSchema = z.union([
  BinaryJudgmentReasoningGenerationSchema,
  BinaryJudgmentSamplingGenerationSchema,
]);
export type BinaryJudgmentGeneration = z.infer<typeof BinaryJudgmentGenerationSchema>;

/** The profile a generation block's own shape declares; `undefined` when it declares neither. */
export function judgeGenerationProfile(generation: unknown): JudgeModelProfileId | undefined {
  if (typeof generation !== "object" || generation === null) return undefined;
  if (Object.hasOwn(generation, "reasoningEffort")) return "reasoning-2026-08";
  if (Object.hasOwn(generation, "temperature")) return "dated-snapshot-sampling";
  return undefined;
}

export const BINARY_ACCEPT_REJECT_PARSER_ID =
  "network.jinn.parser.binary-accept-reject" as const;
export const BINARY_ACCEPT_REJECT_PARSER_VERSION = "1.0.0" as const;
export const BINARY_JUDGMENT_EVALUATION_PARSER_ID =
  "network.jinn.parser.binary-judgment-evaluation" as const;
export const BINARY_JUDGMENT_EVALUATION_PARSER_VERSION = "1.0.0" as const;

/** Sealed, code-free semantics for the only response parser admitted by v1 instruments. */
export function buildBinaryAcceptRejectParserSemantics() {
  return {
    protocol: BINARY_JUDGMENT_PARSER_SEMANTICS_FORMAT_URI,
    parser: {
      id: BINARY_ACCEPT_REJECT_PARSER_ID,
      version: BINARY_ACCEPT_REJECT_PARSER_VERSION,
    },
    input: {
      mediaType: BINARY_JUDGMENT_RESPONSE_MEDIA_TYPE,
      utf8: "strict",
      trimCodePoints: ["U+0020", "U+0009", "U+000D", "U+000A"],
      normalization: "none",
    },
    accepted: ["ACCEPT", "REJECT"],
    invalidOutputDecision: "REJECT",
  } as const;
}

export const BINARY_ACCEPT_REJECT_PARSER_SEALED = sealDocument(
  buildBinaryAcceptRejectParserSemantics(),
);
export const BINARY_ACCEPT_REJECT_PARSER_IDENTITY = {
  id: BINARY_ACCEPT_REJECT_PARSER_ID,
  version: BINARY_ACCEPT_REJECT_PARSER_VERSION,
  digest: BINARY_ACCEPT_REJECT_PARSER_SEALED.digest,
} as const;

/**
 * The umbrella parser commits the complete v1 response-parser registry and the comparison map.
 * Adding a parser or changing truth semantics therefore changes this document's digest.
 */
export function buildBinaryJudgmentEvaluationParserSemantics() {
  return {
    protocol: BINARY_JUDGMENT_PARSER_SEMANTICS_FORMAT_URI,
    parser: {
      id: BINARY_JUDGMENT_EVALUATION_PARSER_ID,
      version: BINARY_JUDGMENT_EVALUATION_PARSER_VERSION,
    },
    responseParsers: [BINARY_ACCEPT_REJECT_PARSER_IDENTITY],
    comparison: {
      ACCEPT: "CORRECT",
      REJECT: "WRONG",
      passWhen: "agreement=true",
    },
  } as const;
}

export const BINARY_JUDGMENT_EVALUATION_PARSER_SEALED = sealDocument(
  buildBinaryJudgmentEvaluationParserSemantics(),
);
export const BINARY_JUDGMENT_EVALUATION_PARSER_IDENTITY = {
  id: BINARY_JUDGMENT_EVALUATION_PARSER_ID,
  version: BINARY_JUDGMENT_EVALUATION_PARSER_VERSION,
  digest: BINARY_JUDGMENT_EVALUATION_PARSER_SEALED.digest,
} as const;

export function binaryJudgmentPromptTemplateDigest(
  messages: readonly BinaryJudgmentMessageTemplate[],
): `sha256:${string}` {
  return recordDigest(canonicalJsonBytes(messages));
}

const ParserIdentitySchema = z.strictObject({
  id: z.literal(BINARY_ACCEPT_REJECT_PARSER_ID),
  version: z.literal(BINARY_ACCEPT_REJECT_PARSER_VERSION),
  digest: z.literal(BINARY_ACCEPT_REJECT_PARSER_IDENTITY.digest),
});

export const BinaryJudgmentInstrumentSchema = z
  .strictObject({
    protocol: z.literal(BINARY_JUDGMENT_INSTRUMENT_FORMAT_URI),
    instrumentId: NonEmptyStringSchema.regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u),
    messages: z.array(BinaryJudgmentMessageTemplateSchema).min(1),
    promptTemplateSha256: Sha256DigestSchema,
    promptSource: BinaryJudgmentSourceDescriptorSchema,
    license: BinaryJudgmentSourceDescriptorSchema,
    attribution: BinaryJudgmentSourceDescriptorSchema,
    model: z.strictObject({
      adapter: z.literal("jinn-openai"),
      requested: z.enum(ACCEPTED_JUDGE_MODEL_IDS),
      generation: BinaryJudgmentGenerationSchema,
    }),
    response: z.strictObject({
      mediaType: z.literal(BINARY_JUDGMENT_RESPONSE_MEDIA_TYPE),
      parser: ParserIdentitySchema,
      invalidOutputDecision: z.literal("REJECT"),
    }),
  })
  .superRefine((instrument, ctx) => {
    const usedFields = new Set<BinaryJudgmentTemplateField>();
    for (const message of instrument.messages) {
      for (const segment of message.segments) {
        if ("field" in segment) usedFields.add(segment.field);
      }
    }
    for (const field of BINARY_JUDGMENT_TEMPLATE_FIELDS) {
      if (!usedFields.has(field)) {
        ctx.addIssue({
          code: "custom",
          path: ["messages"],
          message: `message templates must interpolate ${field} at least once`,
        });
      }
    }
    const expected = binaryJudgmentPromptTemplateDigest(instrument.messages);
    if (instrument.promptTemplateSha256 !== expected) {
      ctx.addIssue({
        code: "custom",
        path: ["promptTemplateSha256"],
        message: `promptTemplateSha256 does not match canonical messages (${expected})`,
      });
    }
    const modelProfile = JUDGE_MODEL_PROFILES[instrument.model.requested];
    const generationProfile = judgeGenerationProfile(instrument.model.generation);
    if (generationProfile !== modelProfile) {
      ctx.addIssue({
        code: "custom",
        path: ["model", "generation"],
        message:
          `model.generation must match the ${modelProfile} profile for model.requested `
          + instrument.model.requested,
      });
    }
  });
export type BinaryJudgmentInstrument = z.infer<typeof BinaryJudgmentInstrumentSchema>;

export const BinaryJudgmentSemanticRequestSchema = z.strictObject({
  model: z.enum(ACCEPTED_JUDGE_MODEL_IDS),
  messages: z.array(BinaryJudgmentMessageSchema).min(1),
  generation: BinaryJudgmentGenerationSchema,
}).superRefine((request, ctx) => {
  const modelProfile = JUDGE_MODEL_PROFILES[request.model];
  const generationProfile = judgeGenerationProfile(request.generation);
  if (generationProfile !== modelProfile) {
    ctx.addIssue({
      code: "custom",
      path: ["generation"],
      message: `generation must match the ${modelProfile} profile for model ${request.model}`,
    });
  }
});
export type BinaryJudgmentSemanticRequest = z.infer<typeof BinaryJudgmentSemanticRequestSchema>;

export function renderBinaryJudgmentMessages(
  payloadInput: BinaryJudgmentPayload,
  instrumentInput: BinaryJudgmentInstrument,
): BinaryJudgmentMessage[] {
  const payload = assertValidDocument(
    BinaryJudgmentPayloadSchema,
    payloadInput,
    "BinaryJudgmentPayload",
  );
  const instrument = assertValidDocument(
    BinaryJudgmentInstrumentSchema,
    instrumentInput,
    "BinaryJudgmentInstrument",
  );
  return instrument.messages.map((message) => ({
    role: message.role,
    text: message.segments.map((segment) => (
      "literal" in segment ? segment.literal : payload[segment.field]
    )).join(""),
  }));
}

/**
 * Reconstructs the digestable scientific request. Capability tokens, correlations, clocks, and
 * backend transport envelopes are intentionally absent because they are ambient execution data.
 */
export function buildBinaryJudgmentSemanticRequest(
  payload: BinaryJudgmentPayload,
  instrument: BinaryJudgmentInstrument,
): BinaryJudgmentSemanticRequest {
  return {
    model: instrument.model.requested,
    messages: renderBinaryJudgmentMessages(payload, instrument),
    generation: instrument.model.generation,
  };
}

export function binaryJudgmentSemanticRequestDigest(
  payload: BinaryJudgmentPayload,
  instrument: BinaryJudgmentInstrument,
): `sha256:${string}` {
  return recordDigest(canonicalJsonBytes(buildBinaryJudgmentSemanticRequest(payload, instrument)));
}

function isSortedUniqueArray(values: readonly string[]): boolean {
  for (let index = 1; index < values.length; index += 1) {
    if (compareCodeUnitStrings(values[index - 1]!, values[index]!) >= 0) return false;
  }
  return true;
}

export const BinaryJudgmentObservationSchema = z.strictObject({
  protocol: z.literal(BINARY_JUDGMENT_OBSERVATION_FORMAT_URI),
  taskDigest: Sha256DigestSchema,
  armId: NonEmptyStringSchema,
  replicate: z.number().int().positive(),
  instrumentSha256: Sha256DigestSchema,
  requestSha256: Sha256DigestSchema,
  response: z.strictObject({
    digest: Sha256DigestSchema,
    mediaType: z.literal(BINARY_JUDGMENT_RESPONSE_MEDIA_TYPE),
  }),
  provider: z.strictObject({
    requestedModel: z.enum(ACCEPTED_JUDGE_MODEL_IDS),
    resolvedModel: z.enum(ACCEPTED_JUDGE_MODEL_IDS),
    responseId: NonEmptyStringSchema,
    eventSha256: Sha256DigestSchema,
    usage: z.strictObject({
      inputTokens: z.number().int().nonnegative(),
      outputTokens: z.number().int().nonnegative(),
      totalTokens: z.number().int().nonnegative(),
    }),
  }),
  call: z.strictObject({
    count: z.literal(1),
    retries: z.literal(0),
    fallbacks: z.literal(0),
  }),
  limitations: z.array(z.enum(BINARY_JUDGMENT_OBSERVATION_LIMITATIONS)),
}).superRefine((observation, ctx) => {
  if (
    observation.provider.usage.totalTokens
    !== observation.provider.usage.inputTokens + observation.provider.usage.outputTokens
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["provider", "usage", "totalTokens"],
      message: "totalTokens must equal inputTokens + outputTokens",
    });
  }
  if (!isSortedUniqueArray(observation.limitations)) {
    ctx.addIssue({
      code: "custom",
      path: ["limitations"],
      message: "limitations must be code-unit sorted and unique",
    });
  }
  const profile = JUDGE_MODEL_PROFILES[observation.provider.requestedModel];
  const expectedLimitations = JUDGE_MODEL_PROFILE_OBSERVATION_LIMITATIONS[profile];
  const matchesProfile = observation.limitations.length === expectedLimitations.length
    && observation.limitations.every((value, index) => value === expectedLimitations[index]);
  if (!matchesProfile) {
    ctx.addIssue({
      code: "custom",
      path: ["limitations"],
      message:
        `limitations must be exactly ${JSON.stringify(expectedLimitations)} for the ${profile} profile`,
    });
  }
  // Both fields are pinned to a single literal today. Widening them to a closed set without
  // this check would start accepting a mismatched (requestedModel, resolvedModel) pair that
  // refuses today, for both profiles alike. This is the evidence that stands in for the
  // mutable-alias limitation on a dated snapshot: the recorded resolvedModel proves the
  // provider actually served the requested id.
  if (observation.provider.resolvedModel !== observation.provider.requestedModel) {
    ctx.addIssue({
      code: "custom",
      path: ["provider", "resolvedModel"],
      message: "provider.resolvedModel must equal provider.requestedModel",
    });
  }
});
export type BinaryJudgmentObservation = z.infer<typeof BinaryJudgmentObservationSchema>;

/** Freshness bound for a snapshot-serving probe (spec §1.5 rule 3): frozen at 24 hours. */
export const SNAPSHOT_PROBE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** A pre-run check confirming a dated snapshot is actually served, sealed as a lock input. */
export const BinaryJudgmentSnapshotProbeSchema = z.strictObject({
  protocol: z.literal(BINARY_JUDGMENT_SNAPSHOT_PROBE_FORMAT_URI),
  requestedModel: z.enum(DATED_SNAPSHOT_MODELS),
  resolvedModel: NonEmptyStringSchema,
  responseId: NonEmptyStringSchema,
  eventSha256: Sha256DigestSchema,
  probedAt: z.string().datetime({ offset: true }),
  outcome: z.enum(["serving", "not-serving"]),
}).superRefine((probe, ctx) => {
  const expectedOutcome = probe.resolvedModel === probe.requestedModel ? "serving" : "not-serving";
  if (probe.outcome !== expectedOutcome) {
    ctx.addIssue({
      code: "custom",
      path: ["outcome"],
      message: `outcome must be "${expectedOutcome}" given the recorded requestedModel/resolvedModel pair`,
    });
  }
});
export type BinaryJudgmentSnapshotProbe = z.infer<typeof BinaryJudgmentSnapshotProbeSchema>;

export const BinaryJudgmentTruthLabelSchema = z.enum(["CORRECT", "WRONG"]);
export type BinaryJudgmentTruthLabel = z.infer<typeof BinaryJudgmentTruthLabelSchema>;
export const BinaryJudgmentStratumSchema = z.enum(["core", "stress"]);
export type BinaryJudgmentStratum = z.infer<typeof BinaryJudgmentStratumSchema>;

/** Evaluator-only admitted analysis attributes. This document must never be a Task input. */
export const BinaryJudgmentAnalysisContextSchema = z.strictObject({
  protocol: z.literal(BINARY_JUDGMENT_ANALYSIS_CONTEXT_FORMAT_URI),
  // This is the canonical imported item/payload commitment, sealed before EvaluationSpec/Task.
  // Referencing taskDigest here would form Task -> EvaluationSpec -> context -> Task.
  itemSha256: Sha256DigestSchema,
  itemId: BinaryJudgmentItemIdSchema,
  labelResolutionSha256: Sha256DigestSchema,
  truthLabel: BinaryJudgmentTruthLabelSchema,
  candidateClass: NonEmptyStringSchema.regex(/^[A-Za-z][A-Za-z0-9._-]{0,63}$/u),
  stratum: BinaryJudgmentStratumSchema,
});
export type BinaryJudgmentAnalysisContext = z.infer<typeof BinaryJudgmentAnalysisContextSchema>;

/** Exact digest joins staged by the evaluation harness; bytes still require independent hashing. */
export const BinaryJudgmentEvaluationContextSchema = z.strictObject({
  protocol: z.literal(BINARY_JUDGMENT_EVALUATION_CONTEXT_FORMAT_URI),
  evaluationSpecSha256: Sha256DigestSchema,
  taskDigest: Sha256DigestSchema,
  armId: NonEmptyStringSchema,
  replicate: z.number().int().positive(),
  judgeObservationSha256: Sha256DigestSchema,
  responseSha256: Sha256DigestSchema,
  material: z.strictObject({
    instrument: BinaryJudgmentInlineMaterialSchema,
    labelResolution: BinaryJudgmentInlineMaterialSchema,
    analysisContext: BinaryJudgmentInlineMaterialSchema,
  }),
});
export type BinaryJudgmentEvaluationContext = z.infer<
  typeof BinaryJudgmentEvaluationContextSchema
>;

export function parseBinaryJudgmentPayload(bytes: Uint8Array): BinaryJudgmentPayload {
  return parseJsonDocument(BinaryJudgmentPayloadSchema, bytes, "BinaryJudgmentPayload");
}

export function parseBinaryJudgmentInstrument(bytes: Uint8Array): BinaryJudgmentInstrument {
  return parseJsonDocument(BinaryJudgmentInstrumentSchema, bytes, "BinaryJudgmentInstrument");
}

export function sealBinaryJudgmentInstrument(
  value: BinaryJudgmentInstrument,
): { bytes: Uint8Array; digest: `sha256:${string}` } {
  return sealDocument(assertValidDocument(
    BinaryJudgmentInstrumentSchema,
    value,
    "BinaryJudgmentInstrument",
  ));
}

export function parseBinaryJudgmentObservation(bytes: Uint8Array): BinaryJudgmentObservation {
  return parseJsonDocument(BinaryJudgmentObservationSchema, bytes, "BinaryJudgmentObservation");
}

export function sealBinaryJudgmentObservation(
  value: BinaryJudgmentObservation,
): { bytes: Uint8Array; digest: `sha256:${string}` } {
  return sealDocument(assertValidDocument(
    BinaryJudgmentObservationSchema,
    value,
    "BinaryJudgmentObservation",
  ));
}

export function parseBinaryJudgmentSnapshotProbe(bytes: Uint8Array): BinaryJudgmentSnapshotProbe {
  return parseJsonDocument(
    BinaryJudgmentSnapshotProbeSchema,
    bytes,
    "BinaryJudgmentSnapshotProbe",
  );
}

export function sealBinaryJudgmentSnapshotProbe(
  value: BinaryJudgmentSnapshotProbe,
): { bytes: Uint8Array; digest: `sha256:${string}` } {
  return sealDocument(assertValidDocument(
    BinaryJudgmentSnapshotProbeSchema,
    value,
    "BinaryJudgmentSnapshotProbe",
  ));
}

export function parseBinaryJudgmentAnalysisContext(
  bytes: Uint8Array,
): BinaryJudgmentAnalysisContext {
  return parseJsonDocument(
    BinaryJudgmentAnalysisContextSchema,
    bytes,
    "BinaryJudgmentAnalysisContext",
  );
}

export function sealBinaryJudgmentAnalysisContext(
  value: BinaryJudgmentAnalysisContext,
): { bytes: Uint8Array; digest: `sha256:${string}` } {
  return sealDocument(assertValidDocument(
    BinaryJudgmentAnalysisContextSchema,
    value,
    "BinaryJudgmentAnalysisContext",
  ));
}

export function parseBinaryJudgmentEvaluationContext(
  bytes: Uint8Array,
): BinaryJudgmentEvaluationContext {
  return parseJsonDocument(
    BinaryJudgmentEvaluationContextSchema,
    bytes,
    "BinaryJudgmentEvaluationContext",
  );
}

export function sealBinaryJudgmentEvaluationContext(
  value: BinaryJudgmentEvaluationContext,
): { bytes: Uint8Array; digest: `sha256:${string}` } {
  return sealDocument(assertValidDocument(
    BinaryJudgmentEvaluationContextSchema,
    value,
    "BinaryJudgmentEvaluationContext",
  ));
}
