// SPDX-License-Identifier: Apache-2.0

import { readFile } from "node:fs/promises";
import { Buffer } from "node:buffer";
import { documentDigest, sealTask } from "@jinn-network/task-execution-protocol";
import { describe, expect, it } from "vitest";

import { canonicalJsonBytes, recordDigest } from "../bytes.js";
import {
  BINARY_JUDGMENT_ANALYSIS_CONTEXT_FORMAT_URI,
  BINARY_JUDGMENT_EVALUATION_CONTEXT_FORMAT_URI,
  BINARY_JUDGMENT_INSTRUMENT_FORMAT_URI,
  BINARY_JUDGMENT_OBSERVATION_FORMAT_URI,
  BINARY_JUDGMENT_RESPONSE_MEDIA_TYPE,
  BINARY_JUDGMENT_SNAPSHOT_PROBE_FORMAT_URI,
  EVALUATION_SPEC_FORMAT_URI,
  EVAL_SEMANTICS_VERSION,
} from "../identifiers.js";
import { sealEvaluationSpec } from "../evaluation-spec/seal.js";
import { BINARY_JUDGMENT_PROFILE_DIGEST } from "../documents/binary-judgment-2.0.js";
import { ProfilesError } from "../errors.js";
import {
  BINARY_ACCEPT_REJECT_PARSER_IDENTITY,
  BINARY_ACCEPT_REJECT_PARSER_SEALED,
  BINARY_CORRECT_WRONG_PARSER_IDENTITY,
  BINARY_CORRECT_WRONG_PARSER_SEALED,
  BINARY_JSON_VERDICT_PARSER_IDENTITY,
  BINARY_JSON_VERDICT_PARSER_SEALED,
  BINARY_JUDGMENT_EVALUATION_PARSER_IDENTITY,
  BINARY_JUDGMENT_EVALUATION_PARSER_SEALED,
  BINARY_JUDGMENT_RESPONSE_PARSER_REGISTRY,
  BINARY_LABEL_IN_PROSE_PARSER_IDENTITY,
  BINARY_LABEL_IN_PROSE_PARSER_SEALED,
  BINARY_YES_NO_PARSER_IDENTITY,
  BINARY_YES_NO_PARSER_SEALED,
  BinaryJudgmentAnalysisContextSchema,
  BinaryJudgmentEvaluationContextSchema,
  BinaryJudgmentInstrumentSchema,
  BinaryJudgmentObservationSchema,
  BinaryJudgmentPayloadSchema,
  BinaryJudgmentSemanticRequestSchema,
  BinaryJudgmentSnapshotProbeSchema,
  binaryJudgmentInstrumentDeclaresEvidence,
  binaryJudgmentPromptTemplateDigest,
  binaryJudgmentSemanticRequestDigest,
  buildBinaryJudgmentSemanticRequest,
  decodeBinaryJudgmentInlineMaterial,
  isDatedSnapshotJudgeModel,
  judgeModelProfileFor,
  parseBinaryJudgmentInstrument,
  parseBinaryJudgmentSnapshotProbe,
  renderBinaryJudgmentMessages,
  sealBinaryJudgmentAnalysisContext,
  sealBinaryJudgmentEvaluationContext,
  sealBinaryJudgmentInstrument,
  sealBinaryJudgmentObservation,
  sealBinaryJudgmentSnapshotProbe,
  type BinaryJudgmentInstrument,
  type BinaryJudgmentPayload,
  type BinaryJudgmentSamplingGeneration,
} from "./contracts.js";

const sha = (character: string): `sha256:${string}` => `sha256:${character.repeat(64)}`;
const descriptor = (name: string) => ({
  name,
  uri: `https://example.test/${name}`,
  digest: { sha256: "a".repeat(64) },
});
const opaqueProvenance = { digest: { sha256: "a".repeat(64) } };
const provenanceCommitment = {
  sourceCommitment: sha("a"),
  timestamp: "2026-03-09T00:00:00Z",
};
const inlineMaterial = (value: unknown) => {
  const bytes = canonicalJsonBytes(value);
  return {
    digest: recordDigest(bytes),
    bytesBase64: Buffer.from(bytes).toString("base64"),
  };
};

const messages = [
  {
    role: "developer" as const,
    segments: [
      { literal: "Judge exactly.\r\nQuestion:\n" },
      { field: "question" as const },
      { literal: "\nReference:\r\n" },
      { field: "referenceAnswer" as const },
    ],
  },
  {
    role: "user" as const,
    segments: [
      { literal: "Candidate:\n" },
      { field: "candidateAnswer" as const },
      { literal: "\r\nReturn ACCEPT or REJECT." },
    ],
  },
];

const instrument: BinaryJudgmentInstrument = {
  protocol: BINARY_JUDGMENT_INSTRUMENT_FORMAT_URI,
  instrumentId: "unicode-lines",
  messages,
  promptTemplateSha256: "sha256:f139ffb8bbe063959a60493bab7e2067b17686f432192e250678de0f9a63733e",
  promptSource: descriptor("prompt"),
  license: descriptor("license"),
  attribution: descriptor("attribution"),
  model: {
    adapter: "jinn-openai",
    requested: "gpt-5.6-luna",
    generation: {
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
    },
  },
  response: {
    mediaType: BINARY_JUDGMENT_RESPONSE_MEDIA_TYPE,
    parser: BINARY_ACCEPT_REJECT_PARSER_IDENTITY,
    invalidOutputDecision: "REJECT",
  },
};

const payload: BinaryJudgmentPayload = {
  itemId: "urn:uuid:11111111-1111-4111-8111-111111111111",
  question: "Café e\u0301 or café? 👩🏽‍💻\r\n第二行",
  referenceAnswer: "Use decomposed e\u0301.\n",
  candidateAnswer: "",
  provenance: provenanceCommitment,
  sources: [opaqueProvenance],
};

const payloadWithEvidence: BinaryJudgmentPayload = {
  ...payload,
  evidence: "Synthetic passage: the fixture's own words.",
};

const messagesWithEvidence = [
  messages[0],
  {
    role: "user" as const,
    segments: [
      { literal: "Evidence:\n" },
      { field: "evidence" as const },
      { literal: "\nCandidate:\n" },
      { field: "candidateAnswer" as const },
      { literal: "\r\nReturn ACCEPT or REJECT." },
    ],
  },
];

const instrumentWithEvidence: BinaryJudgmentInstrument = {
  ...instrument,
  instrumentId: "unicode-lines-evidence",
  messages: messagesWithEvidence,
  promptTemplateSha256: binaryJudgmentPromptTemplateDigest(messagesWithEvidence),
};

const datedSnapshotGeneration: BinaryJudgmentSamplingGeneration = {
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
};

const datedSnapshotInstrument: BinaryJudgmentInstrument = {
  ...instrument,
  instrumentId: "dated-snapshot-sampling",
  model: {
    adapter: "jinn-openai",
    requested: "gpt-4o-mini-2024-07-18",
    generation: datedSnapshotGeneration,
  },
};

const buildObservation = (fields: {
  requestedModel: string;
  resolvedModel: string;
  limitations: string[];
}) => ({
  protocol: BINARY_JUDGMENT_OBSERVATION_FORMAT_URI,
  taskDigest: sha("1"),
  armId: "strict",
  replicate: 1,
  instrumentSha256: sha("2"),
  requestSha256: sha("3"),
  response: { digest: sha("4"), mediaType: BINARY_JUDGMENT_RESPONSE_MEDIA_TYPE },
  provider: {
    requestedModel: fields.requestedModel,
    resolvedModel: fields.resolvedModel,
    responseId: "resp_synthetic",
    eventSha256: sha("5"),
    usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
  },
  call: { count: 1 as const, retries: 0 as const, fallbacks: 0 as const },
  limitations: fields.limitations,
});

const servingProbe = {
  protocol: BINARY_JUDGMENT_SNAPSHOT_PROBE_FORMAT_URI,
  requestedModel: "gpt-4o-mini-2024-07-18" as const,
  resolvedModel: "gpt-4o-mini-2024-07-18",
  responseId: "resp_probe_synthetic",
  eventSha256: sha("9"),
  probedAt: "2026-08-20T00:00:00.000Z",
  outcome: "serving" as const,
};

describe("binary-judgment closed contracts", () => {
  it("accepts the complete solver payload and rejects direct or descriptor-based truth channels", () => {
    expect(BinaryJudgmentPayloadSchema.parse(payload)).toStrictEqual(payload);
    expect(BinaryJudgmentPayloadSchema.safeParse({ ...payload, truthLabel: "CORRECT" }).success)
      .toBe(false);
    expect(BinaryJudgmentPayloadSchema.safeParse({ ...payload, candidateClass: "temporal" }).success)
      .toBe(false);
    expect(BinaryJudgmentPayloadSchema.safeParse({
      ...payload,
      sources: [{ ...payload.sources[0], annotations: { truthLabel: "CORRECT" } }],
    }).success).toBe(false);
    for (const identifyingField of [
      { name: "wrong" },
      { uri: "https://example.test/stress/wrong" },
      { downloadLocation: "https://example.test/labeled-source" },
    ]) {
      expect(BinaryJudgmentPayloadSchema.safeParse({
        ...payload,
        sources: [{ ...payload.sources[0], ...identifyingField }],
      }).success).toBe(false);
    }
    expect(BinaryJudgmentPayloadSchema.safeParse({ ...payload, itemId: "wrong-stress-17" }).success)
      .toBe(false);
  });

  it("treats evidence as an optional string that imposes nothing when absent", () => {
    expect(BinaryJudgmentPayloadSchema.parse(payload)).not.toHaveProperty("evidence");
    expect(BinaryJudgmentPayloadSchema.safeParse(payloadWithEvidence).success).toBe(true);
    expect(BinaryJudgmentPayloadSchema.safeParse({ ...payload, evidence: 42 }).success).toBe(false);
  });

  it("fails closed on an unknown top-level payload key", () => {
    expect(BinaryJudgmentPayloadSchema.safeParse({ ...payload, extraField: "leak" }).success)
      .toBe(false);
  });

  it("rejects the superseded 1.0 array-shaped provenance and requires the 2.0 commitment object", () => {
    expect(BinaryJudgmentPayloadSchema.safeParse({
      ...payload,
      provenance: [opaqueProvenance],
    }).success).toBe(false);
    expect(BinaryJudgmentPayloadSchema.safeParse({
      ...payload,
      provenance: { ...provenanceCommitment, extra: "leak" },
    }).success).toBe(false);
  });

  it("pins provenance.timestamp to a fractional-second-free RFC 3339 shape", () => {
    expect(BinaryJudgmentPayloadSchema.safeParse({
      ...payload,
      provenance: { ...provenanceCommitment, timestamp: "2026-03-09T00:00:00.5Z" },
    }).success).toBe(false);
    expect(BinaryJudgmentPayloadSchema.safeParse({
      ...payload,
      provenance: { ...provenanceCommitment, timestamp: "2026-03-09T00:00:00Z" },
    }).success).toBe(true);
    expect(BinaryJudgmentPayloadSchema.safeParse({
      ...payload,
      provenance: { ...provenanceCommitment, timestamp: "2026-03-09T00:00:00+02:00" },
    }).success).toBe(true);
  });

  it("pins every input field, parser identity, generation control, and prompt-template digest", () => {
    expect(BinaryJudgmentInstrumentSchema.parse(instrument)).toStrictEqual(instrument);
    expect(binaryJudgmentPromptTemplateDigest(messages)).toBe(instrument.promptTemplateSha256);
    expect(BinaryJudgmentInstrumentSchema.safeParse({
      ...instrument,
      messages: [{ role: "user", segments: [{ field: "question" }] }],
      promptTemplateSha256: binaryJudgmentPromptTemplateDigest([
        { role: "user", segments: [{ field: "question" }] },
      ]),
    }).success).toBe(false);
    expect(BinaryJudgmentInstrumentSchema.safeParse({
      ...instrument,
      promptTemplateSha256: sha("0"),
    }).success).toBe(false);
    expect(BinaryJudgmentInstrumentSchema.safeParse({
      ...instrument,
      response: {
        ...instrument.response,
        parser: { ...instrument.response.parser, code: "return ACCEPT" },
      },
    }).success).toBe(false);
    expect(BinaryJudgmentInstrumentSchema.safeParse({
      ...instrument,
      model: { ...instrument.model, generation: { ...instrument.model.generation, retries: 1 } },
    }).success).toBe(false);
  });

  it("validates an instrument that interpolates only the three required fields, and one that also declares evidence", () => {
    expect(BinaryJudgmentInstrumentSchema.safeParse(instrument).success).toBe(true);
    expect(BinaryJudgmentInstrumentSchema.safeParse(instrumentWithEvidence).success).toBe(true);
    expect(binaryJudgmentInstrumentDeclaresEvidence(instrument)).toBe(false);
    expect(binaryJudgmentInstrumentDeclaresEvidence(instrumentWithEvidence)).toBe(true);
  });

  it("renders identical message bytes and digest regardless of an unreferenced evidence field (P2 acceptance 2 leak test)", () => {
    const withoutEvidence = renderBinaryJudgmentMessages(payload, instrument);
    const withEvidence = renderBinaryJudgmentMessages(payloadWithEvidence, instrument);
    expect(withEvidence).toStrictEqual(withoutEvidence);
    expect(canonicalJsonBytes(withEvidence)).toStrictEqual(canonicalJsonBytes(withoutEvidence));
    expect(binaryJudgmentSemanticRequestDigest(payloadWithEvidence, instrument))
      .toBe(binaryJudgmentSemanticRequestDigest(payload, instrument));
  });

  it("refuses to render a declaring instrument over an evidence-free payload instead of interpolating undefined", () => {
    expect(() => renderBinaryJudgmentMessages(payload, instrumentWithEvidence)).toThrow(ProfilesError);
    expect(() => renderBinaryJudgmentMessages(payload, instrumentWithEvidence)).toThrow(
      /interpolates evidence but the payload does not carry it/,
    );
    let thrown: unknown;
    try {
      renderBinaryJudgmentMessages(payload, instrumentWithEvidence);
    } catch (error) {
      thrown = error;
    }
    expect(String((thrown as Error).message)).not.toContain("undefined");
  });

  it("renders the evidence text in place for a declaring instrument over an evidence-carrying payload", () => {
    const rendered = renderBinaryJudgmentMessages(payloadWithEvidence, instrumentWithEvidence);
    expect(rendered[1]).toStrictEqual({
      role: "user",
      text: `Evidence:\n${payloadWithEvidence.evidence}\nCandidate:\n\r\nReturn ACCEPT or REJECT.`,
    });
  });

  it("renders Unicode and mixed line endings byte-for-byte with no normalization or separator", () => {
    expect(renderBinaryJudgmentMessages(payload, instrument)).toStrictEqual([
      {
        role: "developer",
        text: "Judge exactly.\r\nQuestion:\nCafé e\u0301 or café? 👩🏽‍💻\r\n第二行"
          + "\nReference:\r\nUse decomposed e\u0301.\n",
      },
      { role: "user", text: "Candidate:\n\r\nReturn ACCEPT or REJECT." },
    ]);
    expect(binaryJudgmentSemanticRequestDigest(payload, instrument))
      .toBe("sha256:9655fa9e54a9e19b9c24d9ea43ee546bd0e57ff1f15474dc80c326b36c65865e");
    expect(buildBinaryJudgmentSemanticRequest(payload, instrument)).not.toHaveProperty("capability");
    expect(buildBinaryJudgmentSemanticRequest(payload, instrument)).not.toHaveProperty("correlationId");
  });

  it("matches the published cross-runtime Unicode and line-ending request oracle", async () => {
    const fixture = JSON.parse(await readFile(new URL(
      "../../fixtures/binary-judgment-request/golden/unicode-line-endings-profile-2.json",
      import.meta.url,
    ), "utf8")) as {
      input: { payload: BinaryJudgmentPayload; instrument: BinaryJudgmentInstrument };
      expect: {
        renderedMessages: unknown;
        semanticRequest: unknown;
        canonicalBytesBase64: string;
        semanticRequestSha256: string;
      };
    };
    const rendered = renderBinaryJudgmentMessages(
      fixture.input.payload,
      fixture.input.instrument,
    );
    const request = buildBinaryJudgmentSemanticRequest(
      fixture.input.payload,
      fixture.input.instrument,
    );
    expect(rendered).toStrictEqual(fixture.expect.renderedMessages);
    expect(request).toStrictEqual(fixture.expect.semanticRequest);
    expect(Buffer.from(canonicalJsonBytes(request)).toString("base64"))
      .toBe(fixture.expect.canonicalBytesBase64);
    expect(binaryJudgmentSemanticRequestDigest(
      fixture.input.payload,
      fixture.input.instrument,
    )).toBe(fixture.expect.semanticRequestSha256);
  });

  it("keeps observation evidence closed and refuses launcher-authored verdicts", () => {
    const observation = {
      protocol: BINARY_JUDGMENT_OBSERVATION_FORMAT_URI,
      taskDigest: sha("1"),
      armId: "strict",
      replicate: 1,
      instrumentSha256: sha("2"),
      requestSha256: sha("3"),
      response: { digest: sha("4"), mediaType: BINARY_JUDGMENT_RESPONSE_MEDIA_TYPE },
      provider: {
        requestedModel: "gpt-5.6-luna" as const,
        resolvedModel: "gpt-5.6-luna" as const,
        responseId: "resp_synthetic",
        eventSha256: sha("5"),
        usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
      },
      call: { count: 1 as const, retries: 0 as const, fallbacks: 0 as const },
      limitations: ["mutable-model-alias"] as ["mutable-model-alias"],
    };
    expect(BinaryJudgmentObservationSchema.parse(observation)).toStrictEqual(observation);
    expect(sealBinaryJudgmentObservation(observation).digest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(BinaryJudgmentObservationSchema.safeParse({
      ...observation,
      judgeDecision: "ACCEPT",
    }).success).toBe(false);
    expect(BinaryJudgmentObservationSchema.safeParse({
      ...observation,
      provider: { ...observation.provider, usage: { inputTokens: 10, outputTokens: 2, totalTokens: 13 } },
    }).success).toBe(false);
  });

  it("seals strict evaluator-only analysis and digest-join contexts", () => {
    const itemSha256 = recordDigest(canonicalJsonBytes(payload));
    const analysisContext = {
      protocol: BINARY_JUDGMENT_ANALYSIS_CONTEXT_FORMAT_URI,
      itemSha256,
      itemId: payload.itemId,
      labelResolutionSha256: sha("6"),
      truthLabel: "WRONG" as const,
      candidateClass: "temporal",
      stratum: "stress" as const,
    };
    const evaluationContext = {
      protocol: BINARY_JUDGMENT_EVALUATION_CONTEXT_FORMAT_URI,
      evaluationSpecSha256: sha("7"),
      taskDigest: sha("1"),
      armId: "strict",
      replicate: 1,
      judgeObservationSha256: sha("8"),
      responseSha256: sha("4"),
      material: {
        instrument: inlineMaterial({ instrument: "synthetic" }),
        labelResolution: inlineMaterial({ resolution: "synthetic" }),
        analysisContext: inlineMaterial(analysisContext),
      },
    };
    expect(BinaryJudgmentAnalysisContextSchema.parse(analysisContext)).toStrictEqual(analysisContext);
    expect(BinaryJudgmentEvaluationContextSchema.parse(evaluationContext)).toStrictEqual(evaluationContext);
    expect(sealBinaryJudgmentAnalysisContext(analysisContext).digest).toMatch(/^sha256:/u);
    expect(sealBinaryJudgmentEvaluationContext(evaluationContext).digest).toMatch(/^sha256:/u);
    expect(new TextDecoder().decode(
      decodeBinaryJudgmentInlineMaterial(evaluationContext.material.analysisContext),
    )).toBe(new TextDecoder().decode(canonicalJsonBytes(analysisContext)));
    expect(BinaryJudgmentAnalysisContextSchema.safeParse({
      ...analysisContext,
      reviewerName: "synthetic",
    }).success).toBe(false);
    expect(BinaryJudgmentEvaluationContextSchema.safeParse({
      ...evaluationContext,
      truthLabel: "WRONG",
    }).success).toBe(false);
    expect(BinaryJudgmentEvaluationContextSchema.safeParse({
      ...evaluationContext,
      material: {
        ...evaluationContext.material,
        instrument: { ...evaluationContext.material.instrument, bytesBase64: "not base64" },
      },
    }).success).toBe(false);
    const corruptedBytes = canonicalJsonBytes({ instrument: "corrupted" });
    expect(BinaryJudgmentEvaluationContextSchema.safeParse({
      ...evaluationContext,
      material: {
        ...evaluationContext.material,
        instrument: {
          ...evaluationContext.material.instrument,
          bytesBase64: Buffer.from(corruptedBytes).toString("base64"),
        },
      },
    }).success).toBe(false);
  });

  it("supports a cycle-free item -> analysis context -> EvaluationSpec -> Task seal order", () => {
    const itemSha256 = recordDigest(canonicalJsonBytes(payload));
    const analysisContext = sealBinaryJudgmentAnalysisContext({
      protocol: BINARY_JUDGMENT_ANALYSIS_CONTEXT_FORMAT_URI,
      itemSha256,
      itemId: payload.itemId,
      labelResolutionSha256: sha("6"),
      truthLabel: "WRONG",
      candidateClass: "temporal",
      stratum: "stress",
    });
    const evaluationSpec = sealEvaluationSpec({
      protocol: EVALUATION_SPEC_FORMAT_URI,
      semanticsVersion: EVAL_SEMANTICS_VERSION,
      family: "deterministic-process",
      grader: {
        name: BINARY_JUDGMENT_EVALUATION_PARSER_IDENTITY.id,
        digest: {
          sha256: BINARY_JUDGMENT_EVALUATION_PARSER_IDENTITY.digest.slice("sha256:".length),
        },
        accessClass: "public",
      },
      familyBlock: {
        image: { uri: "oci://example.test/binary-evaluator@sha256:synthetic" },
        platform: "linux/amd64",
        workspace: {},
        testMaterial: [{
          name: "analysis-context.json",
          digest: { sha256: analysisContext.digest.slice("sha256:".length) },
          accessClass: "private",
        }],
        parser: BINARY_JUDGMENT_EVALUATION_PARSER_IDENTITY,
        transitions: { failToPass: [], passToPass: [] },
        timeout: 60,
      },
      measurements: [{ name: "agreement", type: "boolean", required: true }],
      verdictRule: { threshold: { measurement: "agreement", op: "eq", value: true } },
      unscorable: [],
      evidenceConventions: { requiredRefs: [] },
    });
    const taskBytes = sealTask({
      protocol: "https://spec.jinn.network/profiles/task-execution/v1",
      profile: { digest: { sha256: BINARY_JUDGMENT_PROFILE_DIGEST.slice("sha256:".length) } },
      instructions: "Return one binary judgment.",
      payload,
      outputs: [
        { name: "judge-response", mediaType: BINARY_JUDGMENT_RESPONSE_MEDIA_TYPE, required: true },
        {
          name: "judge-observation",
          mediaType: "application/vnd.jinn.binary-judgment.observation.v1+json",
          required: true,
        },
      ],
      evaluation: { digest: { sha256: evaluationSpec.digest.slice("sha256:".length) } },
      "network.jinn.binary-judgment.item-sha256": itemSha256,
    });

    expect(analysisContext.digest).toMatch(/^sha256:/u);
    expect(evaluationSpec.digest).toMatch(/^sha256:/u);
    expect(documentDigest(taskBytes)).toMatch(/^sha256:/u);
    expect(new TextDecoder().decode(analysisContext.bytes)).toContain(itemSha256);
    expect(new TextDecoder().decode(analysisContext.bytes)).not.toContain(documentDigest(taskBytes));
    expect(new TextDecoder().decode(evaluationSpec.bytes)).toContain(
      analysisContext.digest.slice("sha256:".length),
    );
  });

  it("seals and parses an instrument without silently stripping unknown keys", () => {
    const sealed = sealBinaryJudgmentInstrument(instrument);
    expect(sealed.digest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(canonicalJsonBytes(instrument)).toEqual(sealed.bytes);
  });

  it("keeps sealing the PC-1-selecting instrument fixture to its pre-registry digest (compatible widening)", () => {
    // Adding four sibling parser identities to the closed registry must not move a single byte of
    // an instrument that already validated and sealed under the single-parser schema. This pins
    // the exact pre-change digest so any accidental reordering, renaming, or shape drift in the
    // registry machinery fails loudly here rather than only in a downstream digest join.
    expect(sealBinaryJudgmentInstrument(instrument).digest).toBe(
      "sha256:c219dea01080475f573778e8a88bd58166bc5ec57a29f3a7679cb77df733a9a0",
    );
  });
});

describe("judge model profiles", () => {
  it("maps every accepted judge model id to its profile and returns undefined otherwise", () => {
    expect(judgeModelProfileFor("gpt-5.6-luna")).toBe("reasoning-2026-08");
    expect(judgeModelProfileFor("gpt-4o-mini-2024-07-18")).toBe("dated-snapshot-sampling");
    expect(judgeModelProfileFor("gpt-4o-mini")).toBeUndefined();
    expect(judgeModelProfileFor("")).toBeUndefined();
    expect(isDatedSnapshotJudgeModel("gpt-4o-mini-2024-07-18")).toBe(true);
    expect(isDatedSnapshotJudgeModel("gpt-5.6-luna")).toBe(false);
  });

  it("parses and seals a dated-snapshot instrument using the sampling generation shape", () => {
    expect(BinaryJudgmentInstrumentSchema.parse(datedSnapshotInstrument))
      .toStrictEqual(datedSnapshotInstrument);
    const sealed = sealBinaryJudgmentInstrument(datedSnapshotInstrument);
    expect(sealed.digest).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  it("refuses an undeclared model id at both parse and seal (P1 acceptance 5)", () => {
    const undeclared = {
      ...datedSnapshotInstrument,
      model: { ...datedSnapshotInstrument.model, requested: "gpt-4o-mini" },
    };
    expect(() => parseBinaryJudgmentInstrument(canonicalJsonBytes(undeclared))).toThrow();
    expect(() => sealBinaryJudgmentInstrument(undeclared as BinaryJudgmentInstrument)).toThrow();
  });

  it("refuses generation blocks whose shape disagrees with the model's own profile", () => {
    expect(BinaryJudgmentInstrumentSchema.safeParse({
      ...datedSnapshotInstrument,
      model: { ...datedSnapshotInstrument.model, generation: instrument.model.generation },
    }).success).toBe(false);
    expect(BinaryJudgmentInstrumentSchema.safeParse({
      ...instrument,
      model: { ...instrument.model, generation: datedSnapshotGeneration },
    }).success).toBe(false);
    expect(BinaryJudgmentInstrumentSchema.safeParse({
      ...instrument,
      model: {
        ...instrument.model,
        generation: { ...instrument.model.generation, temperature: 0 },
      },
    }).success).toBe(false);
    expect(BinaryJudgmentInstrumentSchema.safeParse({
      ...datedSnapshotInstrument,
      model: {
        ...datedSnapshotInstrument.model,
        generation: { ...datedSnapshotGeneration, temperature: 0.5 },
      },
    }).success).toBe(false);
    expect(BinaryJudgmentInstrumentSchema.safeParse({
      ...datedSnapshotInstrument,
      model: {
        ...datedSnapshotInstrument.model,
        generation: { ...datedSnapshotGeneration, maxOutputTokens: 128 },
      },
    }).success).toBe(false);
  });

  it("refuses a BinaryJudgmentSemanticRequest whose generation does not match its model", () => {
    const request = buildBinaryJudgmentSemanticRequest(payload, instrument);
    expect(BinaryJudgmentSemanticRequestSchema.parse(request)).toStrictEqual(request);
    expect(BinaryJudgmentSemanticRequestSchema.safeParse({
      ...request,
      model: "gpt-4o-mini-2024-07-18",
    }).success).toBe(false);
  });

  it("requires observation limitations to match the model's profile exactly", () => {
    const datedSnapshotEmpty = buildObservation({
      requestedModel: "gpt-4o-mini-2024-07-18",
      resolvedModel: "gpt-4o-mini-2024-07-18",
      limitations: [],
    });
    expect(BinaryJudgmentObservationSchema.parse(datedSnapshotEmpty))
      .toStrictEqual(datedSnapshotEmpty);

    const datedSnapshotWithAlias = buildObservation({
      requestedModel: "gpt-4o-mini-2024-07-18",
      resolvedModel: "gpt-4o-mini-2024-07-18",
      limitations: ["mutable-model-alias"],
    });
    expect(BinaryJudgmentObservationSchema.safeParse(datedSnapshotWithAlias).success).toBe(false);

    const reasoningEmpty = buildObservation({
      requestedModel: "gpt-5.6-luna",
      resolvedModel: "gpt-5.6-luna",
      limitations: [],
    });
    expect(BinaryJudgmentObservationSchema.safeParse(reasoningEmpty).success).toBe(false);

    const reasoningWithAlias = buildObservation({
      requestedModel: "gpt-5.6-luna",
      resolvedModel: "gpt-5.6-luna",
      limitations: ["mutable-model-alias"],
    });
    expect(BinaryJudgmentObservationSchema.parse(reasoningWithAlias))
      .toStrictEqual(reasoningWithAlias);
  });

  it("refuses an observation whose resolvedModel differs from its requestedModel (P1 acceptance 5)", () => {
    const mismatched = buildObservation({
      requestedModel: "gpt-4o-mini-2024-07-18",
      resolvedModel: "gpt-5.6-luna",
      limitations: [],
    });
    expect(BinaryJudgmentObservationSchema.safeParse(mismatched).success).toBe(false);
  });

  it("parses and seals a serving snapshot-serving probe, and enforces outcome derivation", () => {
    expect(BinaryJudgmentSnapshotProbeSchema.parse(servingProbe)).toStrictEqual(servingProbe);
    const sealed = sealBinaryJudgmentSnapshotProbe(servingProbe);
    expect(sealed.digest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(parseBinaryJudgmentSnapshotProbe(sealed.bytes)).toStrictEqual(servingProbe);

    expect(BinaryJudgmentSnapshotProbeSchema.safeParse({
      ...servingProbe,
      outcome: "not-serving",
    }).success).toBe(false);

    expect(BinaryJudgmentSnapshotProbeSchema.safeParse({
      ...servingProbe,
      resolvedModel: "gpt-4o-mini-2024-07-18-preview",
    }).success).toBe(false);

    const notServingProbe = {
      ...servingProbe,
      resolvedModel: "gpt-4o-mini-2024-07-18-preview",
      outcome: "not-serving" as const,
    };
    expect(BinaryJudgmentSnapshotProbeSchema.parse(notServingProbe)).toStrictEqual(notServingProbe);

    expect(BinaryJudgmentSnapshotProbeSchema.safeParse({
      ...servingProbe,
      requestedModel: "gpt-5.6-luna",
    }).success).toBe(false);
  });
});

describe("binary-judgment parser semantics goldens", () => {
  it("freezes strict UTF-8, ASCII-edge trimming, no normalization, and invalid-to-REJECT", () => {
    expect(JSON.parse(new TextDecoder().decode(BINARY_ACCEPT_REJECT_PARSER_SEALED.bytes)))
      .toStrictEqual({
        protocol: "https://spec.jinn.network/binary-judgment/parser-semantics/v1",
        parser: {
          id: "network.jinn.parser.binary-accept-reject",
          version: "1.0.0",
        },
        input: {
          mediaType: "text/plain; charset=utf-8",
          utf8: "strict",
          trimCodePoints: ["U+0020", "U+0009", "U+000D", "U+000A"],
          normalization: "none",
        },
        accepted: ["ACCEPT", "REJECT"],
        invalidOutputDecision: "REJECT",
      });
  });

  it("pins all six sealed parser documents (the five contracts plus the umbrella) to exact on-disk bytes", async () => {
    const cases = [
      {
        root: new URL(
          "../../profiles/binary-judgment/parsers/binary-accept-reject/1.0.0/",
          import.meta.url,
        ),
        sealed: BINARY_ACCEPT_REJECT_PARSER_SEALED,
        identity: BINARY_ACCEPT_REJECT_PARSER_IDENTITY,
      },
      {
        root: new URL(
          "../../profiles/binary-judgment/parsers/binary-correct-wrong/1.0.0/",
          import.meta.url,
        ),
        sealed: BINARY_CORRECT_WRONG_PARSER_SEALED,
        identity: BINARY_CORRECT_WRONG_PARSER_IDENTITY,
      },
      {
        root: new URL(
          "../../profiles/binary-judgment/parsers/binary-json-verdict/1.0.0/",
          import.meta.url,
        ),
        sealed: BINARY_JSON_VERDICT_PARSER_SEALED,
        identity: BINARY_JSON_VERDICT_PARSER_IDENTITY,
      },
      {
        root: new URL(
          "../../profiles/binary-judgment/parsers/binary-label-in-prose/1.0.0/",
          import.meta.url,
        ),
        sealed: BINARY_LABEL_IN_PROSE_PARSER_SEALED,
        identity: BINARY_LABEL_IN_PROSE_PARSER_IDENTITY,
      },
      {
        root: new URL(
          "../../profiles/binary-judgment/parsers/binary-yes-no/1.0.0/",
          import.meta.url,
        ),
        sealed: BINARY_YES_NO_PARSER_SEALED,
        identity: BINARY_YES_NO_PARSER_IDENTITY,
      },
      {
        root: new URL(
          "../../profiles/binary-judgment/parsers/binary-judgment-evaluation/1.0.0/",
          import.meta.url,
        ),
        sealed: BINARY_JUDGMENT_EVALUATION_PARSER_SEALED,
        identity: BINARY_JUDGMENT_EVALUATION_PARSER_IDENTITY,
      },
    ];
    for (const vector of cases) {
      const bytes = await readFile(new URL("semantics.json", vector.root));
      const digest = (await readFile(new URL("semantics.sha256", vector.root), "utf8")).trim();
      expect(new Uint8Array(bytes)).toEqual(vector.sealed.bytes);
      expect(digest).toBe(vector.sealed.digest);
      expect(vector.identity.digest).toBe(digest);
    }
  });

  it("keeps PC-1's own sealed semantics document and digest byte-frozen (§4.5: PC-1 does not move)", () => {
    expect(BINARY_ACCEPT_REJECT_PARSER_SEALED.digest).toBe(
      "sha256:02aa652770de9e74415cd206c8741b6148e3ea82c21773983a6d8c66030d0073",
    );
    expect(BINARY_ACCEPT_REJECT_PARSER_IDENTITY.digest).toBe(
      "sha256:02aa652770de9e74415cd206c8741b6148e3ea82c21773983a6d8c66030d0073",
    );
  });

  it("freezes the YES/NO parser semantics document (PC-2)", () => {
    expect(JSON.parse(new TextDecoder().decode(BINARY_YES_NO_PARSER_SEALED.bytes)))
      .toStrictEqual({
        protocol: "https://spec.jinn.network/binary-judgment/parser-semantics/v1",
        parser: {
          id: "network.jinn.parser.binary-yes-no",
          version: "1.0.0",
        },
        input: {
          mediaType: "text/plain; charset=utf-8",
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
      });
  });

  it("freezes the CORRECT/WRONG parser semantics document (PC-3)", () => {
    expect(JSON.parse(new TextDecoder().decode(BINARY_CORRECT_WRONG_PARSER_SEALED.bytes)))
      .toStrictEqual({
        protocol: "https://spec.jinn.network/binary-judgment/parser-semantics/v1",
        parser: {
          id: "network.jinn.parser.binary-correct-wrong",
          version: "1.0.0",
        },
        input: {
          mediaType: "text/plain; charset=utf-8",
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
      });
  });

  it("freezes the JSON-verdict parser semantics document (PC-4)", () => {
    expect(JSON.parse(new TextDecoder().decode(BINARY_JSON_VERDICT_PARSER_SEALED.bytes)))
      .toStrictEqual({
        protocol: "https://spec.jinn.network/binary-judgment/parser-semantics/v1",
        parser: {
          id: "network.jinn.parser.binary-json-verdict",
          version: "1.0.0",
        },
        input: {
          mediaType: "text/plain; charset=utf-8",
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
      });
  });

  it("freezes the label-in-prose parser semantics document, with no trim codepoints (PC-5)", () => {
    expect(JSON.parse(new TextDecoder().decode(BINARY_LABEL_IN_PROSE_PARSER_SEALED.bytes)))
      .toStrictEqual({
        protocol: "https://spec.jinn.network/binary-judgment/parser-semantics/v1",
        parser: {
          id: "network.jinn.parser.binary-label-in-prose",
          version: "1.0.0",
        },
        input: {
          mediaType: "text/plain; charset=utf-8",
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
      });
  });

  it("code-unit sorts the response-parser registry by (id, version)", () => {
    const ids = BINARY_JUDGMENT_RESPONSE_PARSER_REGISTRY.map((parser) => parser.id);
    const sorted = [...ids].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
    expect(ids).toStrictEqual(sorted);
    expect(ids).toStrictEqual([
      "network.jinn.parser.binary-accept-reject",
      "network.jinn.parser.binary-correct-wrong",
      "network.jinn.parser.binary-json-verdict",
      "network.jinn.parser.binary-label-in-prose",
      "network.jinn.parser.binary-yes-no",
    ]);
  });

  it("carries the umbrella document's responseParsers as exactly the registry", () => {
    const umbrella = JSON.parse(
      new TextDecoder().decode(BINARY_JUDGMENT_EVALUATION_PARSER_SEALED.bytes),
    ) as { responseParsers: unknown };
    expect(umbrella.responseParsers).toStrictEqual(BINARY_JUDGMENT_RESPONSE_PARSER_REGISTRY);
  });
});

describe("binary-judgment instrument seal against the closed parser registry", () => {
  const withParser = (parser: unknown) => ({
    ...instrument,
    response: { ...instrument.response, parser },
  });

  it("seals an instrument naming each of the five registered parser identities", () => {
    for (const identity of BINARY_JUDGMENT_RESPONSE_PARSER_REGISTRY) {
      const candidate = withParser(identity);
      expect(BinaryJudgmentInstrumentSchema.safeParse(candidate).success).toBe(true);
      expect(() => sealBinaryJudgmentInstrument(candidate as never)).not.toThrow();
    }
  });

  it("refuses a registered id paired with the wrong version", () => {
    const candidate = withParser({
      ...BINARY_ACCEPT_REJECT_PARSER_IDENTITY,
      version: "1.0.1",
    });
    expect(BinaryJudgmentInstrumentSchema.safeParse(candidate).success).toBe(false);
  });

  it("refuses a registered id paired with the wrong digest", () => {
    const candidate = withParser({
      ...BINARY_YES_NO_PARSER_IDENTITY,
      digest: `sha256:${"0".repeat(64)}`,
    });
    expect(BinaryJudgmentInstrumentSchema.safeParse(candidate).success).toBe(false);
    expect(() => sealBinaryJudgmentInstrument(candidate as never)).toThrow();
  });

  it("refuses an id that is not a member of the closed registry", () => {
    const candidate = withParser({
      id: "network.jinn.parser.binary-unregistered",
      version: "1.0.0",
      digest: `sha256:${"0".repeat(64)}`,
    });
    expect(BinaryJudgmentInstrumentSchema.safeParse(candidate).success).toBe(false);
  });
});
