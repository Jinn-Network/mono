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
} from "../identifiers.js";
import { ProfilesError } from "../errors.js";
import { assertValidDocument, parseJsonDocument } from "../zod-parse.js";

const Sha256DigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const Sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const NonEmptyStringSchema = z.string().min(1);
export const BinaryJudgmentItemIdSchema = z.string().regex(
  /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
);

/**
 * RFC 3339 instant SHAPE, seconds precision, no fractional part. This is a shape pin, not a
 * calendar evaluation: calendar strictness is enforced once, on the source-manifest row that this
 * value is copied from (`verify/src/admission/intake.ts`, via `isCalendarStrictRfc3339`), and is
 * re-checked at read by `resolveBenchmarkTaskProvenance`. Fractional seconds are excluded because
 * the value is a source publication instant and because a fraction-admitting pattern fails this
 * package's own safe-regex ReDoS pre-filter (`task-profile/payload-schema.ts`).
 */
export const BINARY_JUDGMENT_TIMESTAMP_PATTERN =
  "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(Z|[+-]\\d{2}:\\d{2})$";
const Rfc3339InstantShapeSchema = z.string().regex(new RegExp(BINARY_JUDGMENT_TIMESTAMP_PATTERN, "u"));

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
 * A digest-only in-toto ResourceDescriptor projection for solver-visible provenance, carried in
 * the payload's `sources` list. Source names and locators remain in the source manifest because
 * even an innocent-looking URI can become a covert truth/class channel into the judge Task.
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
  evidence: z.string().optional(),
  provenance: z.strictObject({
    sourceCommitment: Sha256DigestSchema,
    timestamp: Rfc3339InstantShapeSchema,
  }),
  sources: z.array(BinaryJudgmentProvenanceDescriptorSchema).min(1),
});
export type BinaryJudgmentPayload = z.infer<typeof BinaryJudgmentPayloadSchema>;

export const BINARY_JUDGMENT_REQUIRED_TEMPLATE_FIELDS = [
  "question",
  "referenceAnswer",
  "candidateAnswer",
] as const;
export const BINARY_JUDGMENT_OPTIONAL_TEMPLATE_FIELDS = ["evidence"] as const;
export const BINARY_JUDGMENT_TEMPLATE_FIELDS = [
  ...BINARY_JUDGMENT_REQUIRED_TEMPLATE_FIELDS,
  ...BINARY_JUDGMENT_OPTIONAL_TEMPLATE_FIELDS,
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

export const BinaryJudgmentGenerationSchema = z.strictObject({
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
export type BinaryJudgmentGeneration = z.infer<typeof BinaryJudgmentGenerationSchema>;

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

export const BINARY_YES_NO_PARSER_ID = "network.jinn.parser.binary-yes-no" as const;
export const BINARY_YES_NO_PARSER_VERSION = "1.0.0" as const;

/** Sealed, code-free semantics: PC-1's discipline over the YES/NO alphabet. */
export function buildBinaryYesNoParserSemantics() {
  return {
    protocol: BINARY_JUDGMENT_PARSER_SEMANTICS_FORMAT_URI,
    parser: {
      id: BINARY_YES_NO_PARSER_ID,
      version: BINARY_YES_NO_PARSER_VERSION,
    },
    input: {
      mediaType: BINARY_JUDGMENT_RESPONSE_MEDIA_TYPE,
      utf8: "strict",
      trimCodePoints: ["U+0020", "U+0009", "U+000D", "U+000A"],
      normalization: "none",
    },
    rule: {
      kind: "whole-output-token",
      caseSensitive: true,
      tokens: { ACCEPT: "YES", REJECT: "NO" },
    },
    invalidOutputDecision: "REJECT",
  } as const;
}

export const BINARY_YES_NO_PARSER_SEALED = sealDocument(buildBinaryYesNoParserSemantics());
export const BINARY_YES_NO_PARSER_IDENTITY = {
  id: BINARY_YES_NO_PARSER_ID,
  version: BINARY_YES_NO_PARSER_VERSION,
  digest: BINARY_YES_NO_PARSER_SEALED.digest,
} as const;

export const BINARY_CORRECT_WRONG_PARSER_ID =
  "network.jinn.parser.binary-correct-wrong" as const;
export const BINARY_CORRECT_WRONG_PARSER_VERSION = "1.0.0" as const;

/** Sealed, code-free semantics: PC-1's discipline over the CORRECT/WRONG alphabet. */
export function buildBinaryCorrectWrongParserSemantics() {
  return {
    protocol: BINARY_JUDGMENT_PARSER_SEMANTICS_FORMAT_URI,
    parser: {
      id: BINARY_CORRECT_WRONG_PARSER_ID,
      version: BINARY_CORRECT_WRONG_PARSER_VERSION,
    },
    input: {
      mediaType: BINARY_JUDGMENT_RESPONSE_MEDIA_TYPE,
      utf8: "strict",
      trimCodePoints: ["U+0020", "U+0009", "U+000D", "U+000A"],
      normalization: "none",
    },
    rule: {
      kind: "whole-output-token",
      caseSensitive: true,
      tokens: { ACCEPT: "CORRECT", REJECT: "WRONG" },
    },
    invalidOutputDecision: "REJECT",
  } as const;
}

export const BINARY_CORRECT_WRONG_PARSER_SEALED = sealDocument(
  buildBinaryCorrectWrongParserSemantics(),
);
export const BINARY_CORRECT_WRONG_PARSER_IDENTITY = {
  id: BINARY_CORRECT_WRONG_PARSER_ID,
  version: BINARY_CORRECT_WRONG_PARSER_VERSION,
  digest: BINARY_CORRECT_WRONG_PARSER_SEALED.digest,
} as const;

export const BINARY_JSON_VERDICT_PARSER_ID =
  "network.jinn.parser.binary-json-verdict" as const;
export const BINARY_JSON_VERDICT_PARSER_VERSION = "1.0.0" as const;

/**
 * Sealed, code-free semantics for the JSON-wrapped verdict contract: a single strict RFC 8259
 * object root carrying a `verdict` string member, edge-trimmed to exactly ACCEPT or REJECT.
 * Deliberately intolerant of code fences, surrounding prose, or a duplicate `verdict` member.
 */
export function buildBinaryJsonVerdictParserSemantics() {
  return {
    protocol: BINARY_JUDGMENT_PARSER_SEMANTICS_FORMAT_URI,
    parser: {
      id: BINARY_JSON_VERDICT_PARSER_ID,
      version: BINARY_JSON_VERDICT_PARSER_VERSION,
    },
    input: {
      mediaType: BINARY_JUDGMENT_RESPONSE_MEDIA_TYPE,
      utf8: "strict",
      trimCodePoints: ["U+0020", "U+0009", "U+000D", "U+000A"],
      normalization: "none",
    },
    rule: {
      kind: "json-member-token",
      caseSensitive: true,
      tokens: { ACCEPT: "ACCEPT", REJECT: "REJECT" },
      json: {
        standard: "RFC 8259",
        text: "exactly one JSON value after the edge trim, with no leading or trailing content",
        root: "object",
        member: "verdict",
        memberType: "string",
        memberTrimCodePoints: ["U+0020", "U+0009", "U+000D", "U+000A"],
        duplicateMember: "refused",
        otherMembers: "ignored",
      },
    },
    invalidOutputDecision: "REJECT",
  } as const;
}

export const BINARY_JSON_VERDICT_PARSER_SEALED = sealDocument(
  buildBinaryJsonVerdictParserSemantics(),
);
export const BINARY_JSON_VERDICT_PARSER_IDENTITY = {
  id: BINARY_JSON_VERDICT_PARSER_ID,
  version: BINARY_JSON_VERDICT_PARSER_VERSION,
  digest: BINARY_JSON_VERDICT_PARSER_SEALED.digest,
} as const;

export const BINARY_LABEL_IN_PROSE_PARSER_ID =
  "network.jinn.parser.binary-label-in-prose" as const;
export const BINARY_LABEL_IN_PROSE_PARSER_VERSION = "1.0.0" as const;

/**
 * Sealed, code-free semantics for the label-in-prose contract: an untrimmed, delimited
 * exact-ASCII-token scan for ACCEPT/REJECT. Invalid when both or neither token is present, with
 * no stemming, case folding, synonyms, or positional preference.
 */
export function buildBinaryLabelInProseParserSemantics() {
  return {
    protocol: BINARY_JUDGMENT_PARSER_SEMANTICS_FORMAT_URI,
    parser: {
      id: BINARY_LABEL_IN_PROSE_PARSER_ID,
      version: BINARY_LABEL_IN_PROSE_PARSER_VERSION,
    },
    input: {
      mediaType: BINARY_JUDGMENT_RESPONSE_MEDIA_TYPE,
      utf8: "strict",
      trimCodePoints: [],
      normalization: "none",
    },
    rule: {
      kind: "delimited-token-scan",
      caseSensitive: true,
      tokens: { ACCEPT: "ACCEPT", REJECT: "REJECT" },
      delimiter:
        "the code point immediately before and immediately after an occurrence, where one exists, "
        + "must not be an ASCII letter, an ASCII digit, or U+005F",
      repeatedToken: "permitted",
      bothTokens: "invalid",
      neitherToken: "invalid",
      positionalPreference: "none",
    },
    invalidOutputDecision: "REJECT",
  } as const;
}

export const BINARY_LABEL_IN_PROSE_PARSER_SEALED = sealDocument(
  buildBinaryLabelInProseParserSemantics(),
);
export const BINARY_LABEL_IN_PROSE_PARSER_IDENTITY = {
  id: BINARY_LABEL_IN_PROSE_PARSER_ID,
  version: BINARY_LABEL_IN_PROSE_PARSER_VERSION,
  digest: BINARY_LABEL_IN_PROSE_PARSER_SEALED.digest,
} as const;

/**
 * The complete v1 response-parser registry, code-unit sorted by (id, version). An instrument
 * SELECTS one member; it never supplies parser configuration. Adding a member changes the
 * umbrella digest by construction, and that tripwire is the point.
 */
export const BINARY_JUDGMENT_RESPONSE_PARSER_REGISTRY = [
  BINARY_ACCEPT_REJECT_PARSER_IDENTITY,
  BINARY_CORRECT_WRONG_PARSER_IDENTITY,
  BINARY_JSON_VERDICT_PARSER_IDENTITY,
  BINARY_LABEL_IN_PROSE_PARSER_IDENTITY,
  BINARY_YES_NO_PARSER_IDENTITY,
] as const;
export type BinaryJudgmentResponseParserId =
  (typeof BINARY_JUDGMENT_RESPONSE_PARSER_REGISTRY)[number]["id"];

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
    responseParsers: [...BINARY_JUDGMENT_RESPONSE_PARSER_REGISTRY],
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

const REGISTERED_PARSER_IDS = BINARY_JUDGMENT_RESPONSE_PARSER_REGISTRY.map(
  (parser) => parser.id,
) as [BinaryJudgmentResponseParserId, ...BinaryJudgmentResponseParserId[]];

/**
 * Closed-registry membership (§4.1 rule 3): `id` must be one of the five registered parsers, and
 * `version`/`digest` must be exactly that parser's registered pair. An instrument names one
 * registered identity; it never supplies parser configuration.
 */
const ParserIdentitySchema = z.strictObject({
  id: z.enum(REGISTERED_PARSER_IDS),
  version: NonEmptyStringSchema,
  digest: Sha256DigestSchema,
}).superRefine((identity, ctx) => {
  const registered = BINARY_JUDGMENT_RESPONSE_PARSER_REGISTRY
    .find((parser) => parser.id === identity.id);
  if (registered === undefined) return; // the enum member check already refused this id
  if (identity.version !== registered.version) {
    ctx.addIssue({
      code: "custom",
      path: ["version"],
      message: `version does not match the registered ${identity.id} pair (${registered.version})`,
    });
  }
  if (identity.digest !== registered.digest) {
    ctx.addIssue({
      code: "custom",
      path: ["digest"],
      message: `digest does not match the registered ${identity.id} pair (${registered.digest})`,
    });
  }
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
      requested: z.literal("gpt-5.6-luna"),
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
    for (const field of BINARY_JUDGMENT_REQUIRED_TEMPLATE_FIELDS) {
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
  });
export type BinaryJudgmentInstrument = z.infer<typeof BinaryJudgmentInstrumentSchema>;

/**
 * The one declaration mechanism (program §2.2): an instrument declares evidence iff at least one
 * message segment names the `evidence` field. There is deliberately no second mechanism (no
 * boolean flag, no enum) — callers that need to know whether evidence is in play scan the
 * segments themselves via this helper rather than trusting a parallel, driftable signal.
 */
export function binaryJudgmentInstrumentDeclaresEvidence(
  instrument: BinaryJudgmentInstrument,
): boolean {
  return instrument.messages.some((message) => (
    message.segments.some((segment) => "field" in segment && segment.field === "evidence")
  ));
}

export const BinaryJudgmentSemanticRequestSchema = z.strictObject({
  model: z.literal("gpt-5.6-luna"),
  messages: z.array(BinaryJudgmentMessageSchema).min(1),
  generation: BinaryJudgmentGenerationSchema,
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
  const payloadFields: Partial<Record<BinaryJudgmentTemplateField, string>> = payload;
  // Total-function guarantee: `evidence` became optional on the payload, so a renderer that
  // blindly interpolated could silently emit the literal string "undefined" into a judge prompt.
  // Refuse before any concatenation instead, through the same ProfilesError shape
  // `assertValidDocument` produces — this is what makes `preview` refuse rather than rehearsing a
  // prompt containing "undefined". This is NOT a second enforcement point for the arm-to-bank
  // evidence rule, which is enforced at lock in another package.
  for (const message of instrument.messages) {
    for (const segment of message.segments) {
      if ("field" in segment && payloadFields[segment.field] === undefined) {
        throw new ProfilesError(
          "invalid-document",
          `BinaryJudgmentPayload failed schema validation: ${segment.field}: instrument segment `
            + `interpolates ${segment.field} but the payload does not carry it`,
        );
      }
    }
  }
  return instrument.messages.map((message) => ({
    role: message.role,
    text: message.segments.map((segment) => (
      "literal" in segment ? segment.literal : payloadFields[segment.field]!
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
    requestedModel: z.literal("gpt-5.6-luna"),
    resolvedModel: z.literal("gpt-5.6-luna"),
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
  limitations: z.tuple([z.literal("mutable-model-alias")]),
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
});
export type BinaryJudgmentObservation = z.infer<typeof BinaryJudgmentObservationSchema>;

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
