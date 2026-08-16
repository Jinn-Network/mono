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
  EVALUATION_SPEC_FORMAT_URI,
  EVAL_SEMANTICS_VERSION,
} from "../identifiers.js";
import { sealEvaluationSpec } from "../evaluation-spec/seal.js";
import { BINARY_JUDGMENT_PROFILE_DIGEST } from "../documents/binary-judgment-1.0.js";
import {
  BINARY_ACCEPT_REJECT_PARSER_IDENTITY,
  BINARY_ACCEPT_REJECT_PARSER_SEALED,
  BINARY_JUDGMENT_EVALUATION_PARSER_IDENTITY,
  BINARY_JUDGMENT_EVALUATION_PARSER_SEALED,
  BinaryJudgmentAnalysisContextSchema,
  BinaryJudgmentEvaluationContextSchema,
  BinaryJudgmentInstrumentSchema,
  BinaryJudgmentObservationSchema,
  BinaryJudgmentPayloadSchema,
  binaryJudgmentPromptTemplateDigest,
  binaryJudgmentSemanticRequestDigest,
  buildBinaryJudgmentSemanticRequest,
  decodeBinaryJudgmentInlineMaterial,
  renderBinaryJudgmentMessages,
  sealBinaryJudgmentAnalysisContext,
  sealBinaryJudgmentEvaluationContext,
  sealBinaryJudgmentInstrument,
  sealBinaryJudgmentObservation,
  type BinaryJudgmentInstrument,
  type BinaryJudgmentPayload,
} from "./contracts.js";

const sha = (character: string): `sha256:${string}` => `sha256:${character.repeat(64)}`;
const descriptor = (name: string) => ({
  name,
  uri: `https://example.test/${name}`,
  digest: { sha256: "a".repeat(64) },
});
const opaqueProvenance = { digest: { sha256: "a".repeat(64) } };
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
  provenance: [opaqueProvenance],
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
      provenance: [{ ...payload.provenance[0], annotations: { truthLabel: "CORRECT" } }],
    }).success).toBe(false);
    for (const identifyingField of [
      { name: "wrong" },
      { uri: "https://example.test/stress/wrong" },
      { downloadLocation: "https://example.test/labeled-source" },
    ]) {
      expect(BinaryJudgmentPayloadSchema.safeParse({
        ...payload,
        provenance: [{ ...payload.provenance[0], ...identifyingField }],
      }).success).toBe(false);
    }
    expect(BinaryJudgmentPayloadSchema.safeParse({ ...payload, itemId: "wrong-stress-17" }).success)
      .toBe(false);
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
      "../../fixtures/binary-judgment-request/golden/unicode-line-endings.json",
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

  it("pins the strict ACCEPT/REJECT and umbrella registry identities to exact on-disk bytes", async () => {
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
});
