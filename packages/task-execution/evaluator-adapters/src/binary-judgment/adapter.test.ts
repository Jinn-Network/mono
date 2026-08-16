// SPDX-License-Identifier: Apache-2.0

import { Buffer } from "node:buffer";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EVALUATION_HARNESS_EXIT_OPERATIONAL_FAILURE,
  EvaluationOperationalError,
  runEvaluationHarness,
  type EvaluationHarnessDeployment,
  type CompletedEvaluation,
  type ExactEvaluationMaterial,
} from "@jinn-network/task-execution-evaluation-harness";
import {
  BINARY_ACCEPT_REJECT_PARSER_IDENTITY,
  BINARY_JUDGMENT_ANALYSIS_CONTEXT_FORMAT_URI,
  BINARY_JUDGMENT_EVALUATION_CONTEXT_FORMAT_URI,
  BINARY_JUDGMENT_EVALUATION_PARSER_IDENTITY,
  BINARY_JUDGMENT_INSTRUMENT_FORMAT_URI,
  BINARY_JUDGMENT_LABEL_RESOLUTION_FORMAT_URI,
  BINARY_JUDGMENT_OBSERVATION_FORMAT_URI,
  BINARY_JUDGMENT_OBSERVATION_MEDIA_TYPE,
  BINARY_JUDGMENT_PROFILE_DIGEST,
  BINARY_JUDGMENT_PROFILE_URI,
  BINARY_JUDGMENT_RESPONSE_MEDIA_TYPE,
  binaryJudgmentPromptTemplateDigest,
  binaryJudgmentSemanticRequestDigest,
  canonicalJsonBytes,
  deriveEvaluationTask,
  recordDigest,
  sealBinaryJudgmentAnalysisContext,
  sealBinaryJudgmentInstrument,
  sealBinaryJudgmentLabelResolution,
  sealBinaryJudgmentObservation,
  sealEvaluationSpec,
  type BinaryJudgmentInstrument,
  type BinaryJudgmentTruthLabel,
  type EvaluationSpec,
} from "@jinn-network/task-execution-profiles";
import {
  documentDigest,
  sealDelivery,
  sealTask,
} from "@jinn-network/task-execution-protocol";
import type { AttemptIdentity } from "@jinn-network/task-execution-supervisor";
import type { WorkspacePaths } from "@jinn-network/task-execution-workspace";
import { afterEach, describe, expect, test } from "vitest";
import {
  BINARY_JUDGMENT_CONTEXT_KEY,
  BINARY_JUDGMENT_EVALUATION_OUTCOME_PROTOCOL,
  BINARY_JUDGMENT_LABEL_RESOLUTION_NAME,
  BINARY_JUDGMENT_MEASUREMENTS,
  binaryJudgmentEvaluationMethodDescriptor,
  buildBinaryJudgmentEvaluationSpecification,
  contextBinaryJudgmentMaterialSource,
  createBinaryJudgmentEvaluatorAdapter,
  isBinaryJudgmentEvaluationSpecification,
  validateBinaryJudgmentCompletedEvaluation,
} from "./adapter.js";
import { evaluatorAdaptersParserAllowlist } from "../parser-identity.js";
import { createBinaryJudgmentEvaluatorRegistration } from "../registrations.js";

const encoder = new TextEncoder();
const sha = (character: string) => `sha256:${character.repeat(64)}` as const;
const ITEM_ID = "urn:uuid:123e4567-e89b-12d3-a456-426614174000";
const ATTEMPT: AttemptIdentity = {
  attemptUri: "urn:uuid:22222222-2222-4222-8222-222222222222" as AttemptIdentity["attemptUri"],
  nonce: "binary-evaluation-nonce",
  attemptNumber: 1,
};
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })
  ));
});

function descriptorMaterial(
  name: string,
  bytes: Uint8Array,
  mediaType?: string,
): ExactEvaluationMaterial {
  return {
    descriptor: {
      name,
      digest: { sha256: recordDigest(bytes).slice("sha256:".length) },
      ...(mediaType === undefined ? {} : { mediaType }),
    },
    bytes,
  };
}

function inline(bytes: Uint8Array) {
  return {
    digest: recordDigest(bytes),
    bytesBase64: Buffer.from(bytes).toString("base64"),
  };
}

function makeInstrument(): BinaryJudgmentInstrument {
  const messages = [{
    role: "developer" as const,
    segments: [
      { literal: "Question: " },
      { field: "question" as const },
      { literal: "\nReference: " },
      { field: "referenceAnswer" as const },
      { literal: "\nCandidate: " },
      { field: "candidateAnswer" as const },
      { literal: "\nReturn ACCEPT or REJECT." },
    ],
  }];
  const source = { uri: "https://example.test/prompt", digest: { sha256: "1".repeat(64) } };
  return {
    protocol: BINARY_JUDGMENT_INSTRUMENT_FORMAT_URI,
    instrumentId: "strict-public-prompt",
    messages,
    promptTemplateSha256: binaryJudgmentPromptTemplateDigest(messages),
    promptSource: source,
    license: { uri: "https://example.test/license", digest: { sha256: "2".repeat(64) } },
    attribution: { uri: "https://example.test/attribution", digest: { sha256: "3".repeat(64) } },
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
}

interface Fixture {
  readonly task: ExactEvaluationMaterial;
  readonly results: readonly ExactEvaluationMaterial[];
  readonly specification: EvaluationSpec;
  readonly context: Record<string, unknown>;
}

function makeFixture(options: {
  readonly truthLabel: BinaryJudgmentTruthLabel;
  readonly response: Uint8Array;
  readonly candidateClass?: string;
  readonly stratum?: "core" | "stress";
  readonly taskInstrumentPin?: boolean;
}): Fixture {
  const candidateClass = options.candidateClass ?? "factual";
  const stratum = options.stratum ?? "core";
  const payload = {
    itemId: ITEM_ID,
    question: "Where was Ada born?",
    referenceAnswer: "London.",
    candidateAnswer: options.truthLabel === "CORRECT" ? "London." : "Paris.",
    provenance: [{ digest: { sha256: "4".repeat(64) } }],
  };
  const itemSha256 = recordDigest(canonicalJsonBytes(payload));
  const instrument = makeInstrument();
  const sealedInstrument = sealBinaryJudgmentInstrument(instrument);
  const labelResolution = sealBinaryJudgmentLabelResolution({
    protocol: BINARY_JUDGMENT_LABEL_RESOLUTION_FORMAT_URI,
    itemSha256,
    itemId: ITEM_ID,
    humanReviewEvaluationSpecSha256: sha("5"),
    truthLabel: options.truthLabel,
    candidateClass,
    stratum,
    truthAdmission: "two-human-unanimous",
    reviewVerdictSha256s: [sha("6"), sha("7")],
    reviewerRosterSha256: sha("8"),
    visibilityReceiptSha256s: [sha("9"), sha("a")],
    revealReceiptSha256: sha("b"),
    resolvedAt: "2026-08-15T09:00:00.000Z",
  });
  const analysisContext = sealBinaryJudgmentAnalysisContext({
    protocol: BINARY_JUDGMENT_ANALYSIS_CONTEXT_FORMAT_URI,
    itemSha256,
    itemId: ITEM_ID,
    labelResolutionSha256: labelResolution.digest,
    truthLabel: options.truthLabel,
    candidateClass,
    stratum,
  });
  const specification = buildBinaryJudgmentEvaluationSpecification(analysisContext.digest);
  const sealedSpecification = sealEvaluationSpec(specification);
  const taskBytes = sealTask({
    protocol: "https://spec.jinn.network/profiles/task-execution/v1",
    profile: {
      uri: BINARY_JUDGMENT_PROFILE_URI,
      digest: { sha256: BINARY_JUDGMENT_PROFILE_DIGEST.slice("sha256:".length) },
    },
    instructions: "Return exactly ACCEPT or REJECT.",
    payload,
    outputs: [
      { name: "judge-response", mediaType: BINARY_JUDGMENT_RESPONSE_MEDIA_TYPE, required: true },
      { name: "judge-observation", mediaType: BINARY_JUDGMENT_OBSERVATION_MEDIA_TYPE, required: true },
    ],
    evaluation: {
      name: "evaluation-spec.json",
      digest: { sha256: sealedSpecification.digest.slice("sha256:".length) },
    },
    ...(options.taskInstrumentPin === true
      ? { requirements: { "network.jinn.binary-judgment.instrument": sealedInstrument.digest } }
      : {}),
    "network.jinn.binary-judgment.item-sha256": itemSha256,
  });
  const responseDigest = recordDigest(options.response);
  const observation = sealBinaryJudgmentObservation({
    protocol: BINARY_JUDGMENT_OBSERVATION_FORMAT_URI,
    taskDigest: documentDigest(taskBytes),
    armId: "strict-public-prompt",
    replicate: 1,
    instrumentSha256: sealedInstrument.digest,
    requestSha256: binaryJudgmentSemanticRequestDigest(payload, instrument),
    response: { digest: responseDigest, mediaType: BINARY_JUDGMENT_RESPONSE_MEDIA_TYPE },
    provider: {
      requestedModel: "gpt-5.6-luna",
      resolvedModel: "gpt-5.6-luna",
      responseId: "resp_fixture",
      eventSha256: sha("d"),
      usage: { inputTokens: 100, outputTokens: 1, totalTokens: 101 },
    },
    call: { count: 1, retries: 0, fallbacks: 0 },
    limitations: ["mutable-model-alias"],
  });
  const evaluationContext = {
    protocol: BINARY_JUDGMENT_EVALUATION_CONTEXT_FORMAT_URI,
    evaluationSpecSha256: sealedSpecification.digest,
    taskDigest: documentDigest(taskBytes),
    armId: "strict-public-prompt",
    replicate: 1,
    judgeObservationSha256: observation.digest,
    responseSha256: responseDigest,
    material: {
      instrument: inline(sealedInstrument.bytes),
      labelResolution: inline(labelResolution.bytes),
      analysisContext: inline(analysisContext.bytes),
    },
  };
  return {
    task: descriptorMaterial("subject-task.json", taskBytes),
    results: [
      descriptorMaterial("judge-response", options.response, BINARY_JUDGMENT_RESPONSE_MEDIA_TYPE),
      descriptorMaterial("judge-observation", observation.bytes, BINARY_JUDGMENT_OBSERVATION_MEDIA_TYPE),
    ],
    specification,
    context: { [BINARY_JUDGMENT_CONTEXT_KEY]: evaluationContext },
  };
}

function adapter() {
  return createBinaryJudgmentEvaluatorAdapter({
    materialSource: contextBinaryJudgmentMaterialSource(),
    now: () => new Date("2026-08-15T10:00:00.000Z"),
  });
}

async function evaluate(fixture: Fixture, signal = new AbortController().signal) {
  return adapter().evaluate(
    fixture.task,
    fixture.results,
    fixture.specification,
    fixture.context,
    ATTEMPT,
    signal,
  );
}

function mutateSpecification(
  specification: EvaluationSpec,
  path: readonly (string | number)[],
  value: unknown,
): EvaluationSpec {
  const clone = structuredClone(specification) as unknown;
  let cursor = clone;
  for (const segment of path.slice(0, -1)) {
    if (typeof segment === "number") {
      if (!Array.isArray(cursor)) throw new TypeError("tamper path expected an array");
      cursor = cursor[segment];
    } else {
      if (typeof cursor !== "object" || cursor === null || Array.isArray(cursor)) {
        throw new TypeError("tamper path expected an object");
      }
      cursor = (cursor as Record<string, unknown>)[segment];
    }
  }
  const final = path.at(-1);
  if (typeof final === "number") {
    if (!Array.isArray(cursor)) throw new TypeError("tamper path expected an array");
    cursor[final] = value;
  } else if (final !== undefined) {
    if (typeof cursor !== "object" || cursor === null || Array.isArray(cursor)) {
      throw new TypeError("tamper path expected an object");
    }
    (cursor as Record<string, unknown>)[final] = value;
  }
  return clone as EvaluationSpec;
}

async function buildHarnessWorkspace(fixture: Fixture): Promise<WorkspacePaths> {
  const root = await mkdtemp(join(tmpdir(), "jinn-binary-evaluator-conformance-"));
  temporaryRoots.push(root);
  const paths: WorkspacePaths = {
    root,
    input: join(root, "input"),
    work: join(root, "work"),
    out: join(root, "out"),
    logs: join(root, "logs"),
    harnessState: join(root, "harness-state"),
    secrets: join(root, "secrets"),
    tmp: join(root, "tmp"),
    meta: join(root, "meta"),
  };
  await Promise.all(Object.values(paths).map((path) => mkdir(path, { recursive: true })));
  const specification = sealEvaluationSpec(fixture.specification);
  const deliveryBytes = sealDelivery({
    protocol: "https://spec.jinn.network/profiles/task-execution/v1",
    attempt: "urn:uuid:33333333-3333-4333-8333-333333333333",
    task: documentDigest(fixture.task.bytes),
    outputs: fixture.results.map((result) => ({
      name: result.descriptor.name,
      mediaType: result.descriptor.mediaType,
      digest: { sha256: recordDigest(result.bytes).slice("sha256:".length) },
    })),
    outcome: "fulfilled",
    createdAt: "2026-08-15T10:00:00.000Z",
  });
  const evaluationTask = deriveEvaluationTask({
    subjectTask: { name: "subject-task.json", digest: documentDigest(fixture.task.bytes) },
    subjectDelivery: { name: "subject-delivery.json", digest: documentDigest(deliveryBytes) },
    subjectResults: fixture.results.map((result) => ({
      name: result.descriptor.name!,
      digest: recordDigest(result.bytes),
    })),
    evaluationSpecDigest: specification.digest,
  });
  await Promise.all([
    writeFile(join(paths.input, "task.sealed"), evaluationTask.bytes),
    writeFile(join(paths.input, "subject-task.json"), fixture.task.bytes),
    writeFile(join(paths.input, "subject-delivery.json"), deliveryBytes),
    ...fixture.results.map((result) =>
      writeFile(join(paths.input, result.descriptor.name!), result.bytes)
    ),
    writeFile(join(paths.input, "evaluation-spec.json"), specification.bytes),
    writeFile(join(paths.input, "evaluation-context.json"), JSON.stringify(fixture.context)),
    writeFile(join(paths.input, "dispatch-context.json"), JSON.stringify({
      taskDigest: evaluationTask.digest,
      submission: "urn:uuid:11111111-1111-4111-8111-111111111111",
      nonce: ATTEMPT.nonce,
      attempt: ATTEMPT.attemptUri,
    })),
    writeFile(join(paths.meta, "attempt.json"), "{}"),
    writeFile(join(paths.logs, "harness.ndjson"), ""),
  ]);
  return paths;
}

function harnessDeployment(): EvaluationHarnessDeployment {
  return {
    registrations: [createBinaryJudgmentEvaluatorRegistration({
      evaluatorId: "did:key:z6MkBinaryJudgmentEvaluator",
      signerHandle: "evaluator-agent-key.pem",
    })],
    parserAllowlist: evaluatorAdaptersParserAllowlist(),
    maxClaimEvidenceBytes: 1024 * 1024,
    evidenceWriter: {
      async putClaimEvidence({ name, bytes, mediaType }) {
        return {
          name,
          digest: { sha256: recordDigest(bytes).slice("sha256:".length) },
          ...(mediaType === undefined ? {} : { mediaType }),
        };
      },
    },
  };
}

async function runHarnessFixture(
  fixture: Fixture,
  deployment = harnessDeployment(),
) {
  const paths = await buildHarnessWorkspace(fixture);
  const exitCode = await runEvaluationHarness(paths, deployment);
  const statement = exitCode === 0
    ? JSON.parse((await readFile(join(paths.out, "verdict"))).toString("utf8")) as {
      predicate: {
        verdict: string;
        measurements: readonly { name: string; value: unknown }[];
      };
    }
    : undefined;
  return { exitCode, paths, statement };
}

describe("binary judgment evaluator", () => {
  test.each([
    ["CORRECT", "ACCEPT", "pass", true],
    ["CORRECT", "REJECT", "fail", false],
    ["WRONG", "ACCEPT", "fail", false],
    ["WRONG", "REJECT", "pass", true],
  ] as const)(
    "%s truth and %s decision produces %s",
    async (truthLabel, response, verdict, agreement) => {
      const completed = await evaluate(makeFixture({
        truthLabel,
        response: encoder.encode(response),
      }));
      expect(completed.verdict).toBe(verdict);
      expect(completed.evaluatedAt).toBe("2026-08-15T10:00:00.000Z");
      expect(completed.detailedOutcome).toMatchObject({
        protocol: BINARY_JUDGMENT_EVALUATION_OUTCOME_PROTOCOL,
        judgeDecision: response,
        truthLabel,
        agreement,
        parseValid: true,
      });
      expect(() => validateBinaryJudgmentCompletedEvaluation(completed)).not.toThrow();
    },
  );

  test("a delivered malformed response is completed and scored, not operational", async () => {
    const completed = await evaluate(makeFixture({
      truthLabel: "WRONG",
      response: new Uint8Array([0xff]),
    }));
    expect(completed.verdict).toBe("pass");
    expect(completed.detailedOutcome).toMatchObject({
      judgeDecision: "REJECT",
      parseValid: false,
      invalidReason: "invalid-utf8",
      agreement: true,
    });
    expect(completed.measurements).toContainEqual({
      name: BINARY_JUDGMENT_MEASUREMENTS.parseValid,
      value: false,
    });
  });

  test("digest drift is an operational no-verdict", async () => {
    const fixture = makeFixture({ truthLabel: "WRONG", response: encoder.encode("REJECT") });
    const binary = fixture.context[BINARY_JUDGMENT_CONTEXT_KEY] as Record<string, unknown>;
    const error = await evaluate({
      ...fixture,
      context: { ...fixture.context, [BINARY_JUDGMENT_CONTEXT_KEY]: { ...binary, responseSha256: sha("e") } },
    }).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(EvaluationOperationalError);
    expect((error as EvaluationOperationalError).reason).toBe("subject-digest-mismatch");
  });

  test("refuses an arm-specific instrument pin in the shared item Task", async () => {
    const error = await evaluate(makeFixture({
      truthLabel: "WRONG",
      response: encoder.encode("REJECT"),
      taskInstrumentPin: true,
    })).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(EvaluationOperationalError);
    expect((error as EvaluationOperationalError).reason).toBe("invalid-evaluator-output");
  });

  test("missing evaluator context is an operational no-verdict", async () => {
    const fixture = makeFixture({ truthLabel: "CORRECT", response: encoder.encode("ACCEPT") });
    const error = await evaluate({ ...fixture, context: {} }).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(EvaluationOperationalError);
    expect((error as EvaluationOperationalError).reason).toBe("subject-not-found");
  });

  test("malformed embedded bytes are an operational no-verdict", async () => {
    const fixture = makeFixture({ truthLabel: "CORRECT", response: encoder.encode("ACCEPT") });
    const binary = fixture.context[BINARY_JUDGMENT_CONTEXT_KEY] as {
      material: { instrument: { digest: string; bytesBase64: string } };
    };
    const error = await evaluate({
      ...fixture,
      context: {
        [BINARY_JUDGMENT_CONTEXT_KEY]: {
          ...binary,
          material: {
            ...binary.material,
            instrument: { ...binary.material.instrument, bytesBase64: Buffer.from("{}").toString("base64") },
          },
        },
      },
    }).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(EvaluationOperationalError);
    expect((error as EvaluationOperationalError).reason).toBe("invalid-evaluator-output");
  });

  test("a pre-aborted attempt is an operational no-verdict", async () => {
    const fixture = makeFixture({ truthLabel: "CORRECT", response: encoder.encode("ACCEPT") });
    const controller = new AbortController();
    controller.abort();
    const error = await evaluate(fixture, controller.signal).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(EvaluationOperationalError);
    expect((error as EvaluationOperationalError).canonicalCode).toBe("CANCELLED");
  });

  test("cancellation while material is resolving remains a no-verdict", async () => {
    const fixture = makeFixture({ truthLabel: "CORRECT", response: encoder.encode("ACCEPT") });
    const controller = new AbortController();
    const contextSource = contextBinaryJudgmentMaterialSource();
    const evaluator = createBinaryJudgmentEvaluatorAdapter({
      materialSource: {
        async read(request) {
          const inputs = await contextSource.read(request);
          controller.abort();
          return inputs;
        },
      },
    });
    const error = await evaluator.evaluate(
      fixture.task,
      fixture.results,
      fixture.specification,
      fixture.context,
      ATTEMPT,
      controller.signal,
    ).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(EvaluationOperationalError);
    expect((error as EvaluationOperationalError).canonicalCode).toBe("CANCELLED");
  });

  test("the shared builder emits the exact admitted specification", () => {
    const fixture = makeFixture({ truthLabel: "CORRECT", response: encoder.encode("ACCEPT") });
    expect(isBinaryJudgmentEvaluationSpecification(fixture.specification)).toBe(true);
    expect(() => buildBinaryJudgmentEvaluationSpecification("sha256:short"))
      .toThrow("binary judgment analysis context must be a canonical sha256 digest");
  });

  test.each([
    ["protocol", ["protocol"], "https://example.test/evaluation-spec"],
    ["semantics version", ["semanticsVersion"], "drifted"],
    ["family", ["family"], "model-graded"],
    ["grader name", ["grader", "name"], "drifted-grader"],
    ["grader digest", ["grader", "digest", "sha256"], "f".repeat(64)],
    ["grader access class", ["grader", "accessClass"], "private"],
    ["grader extra field", ["grader", "https://example.test/extra"], true],
    ["image name", ["familyBlock", "image", "name"], "binary-evaluator-image"],
    ["image digest", ["familyBlock", "image", "digest", "sha256"], "f".repeat(64)],
    ["image extra field", ["familyBlock", "image", "mediaType"], "application/json"],
    ["platform", ["familyBlock", "platform"], "linux/arm64"],
    ["workspace", ["familyBlock", "workspace", "unexpected"], true],
    ["extra test material", ["familyBlock", "testMaterial", 1], {
      name: "extra.json",
      digest: { sha256: "f".repeat(64) },
      accessClass: "private",
    }],
    ["analysis-context name", ["familyBlock", "testMaterial", 0, "name"], "context.json"],
    ["analysis-context digest syntax", ["familyBlock", "testMaterial", 0, "digest", "sha256"], "F".repeat(64)],
    ["analysis-context media type", ["familyBlock", "testMaterial", 0, "mediaType"], "application/json"],
    ["analysis-context access class", ["familyBlock", "testMaterial", 0, "accessClass"], "public"],
    ["analysis-context descriptor extra field", ["familyBlock", "testMaterial", 0, "uri"], "file:///context.json"],
    ["analysis-context digest extra field", ["familyBlock", "testMaterial", 0, "digest", "sha512"], "f".repeat(128)],
    ["parser id", ["familyBlock", "parser", "id"], "drifted-parser"],
    ["parser version", ["familyBlock", "parser", "version"], "2.0.0"],
    ["parser digest", ["familyBlock", "parser", "digest"], sha("f")],
    ["parser extra field", ["familyBlock", "parser", "source"], "inline"],
    ["fail-to-pass transition", ["familyBlock", "transitions", "failToPass"], ["test"]],
    ["pass-to-pass transition", ["familyBlock", "transitions", "passToPass"], ["test"]],
    ["transitions extra field", ["familyBlock", "transitions", "https://example.test/extra"], []],
    ["timeout", ["familyBlock", "timeout"], 61],
    ["setup policy", ["familyBlock", "setupPolicy"], {}],
    ["family-block extra field", ["familyBlock", "https://example.test/extra"], true],
    ["measurements", ["measurements"], [{ name: "agreement", type: "boolean", required: true }]],
    ["measurement extra field", ["measurements", 0, "direction"], "none"],
    ["verdict measurement", ["verdictRule", "threshold", "measurement"], "parseValid"],
    ["verdict operation", ["verdictRule", "threshold", "op"], "neq"],
    ["verdict value", ["verdictRule", "threshold", "value"], false],
    ["threshold extra field", ["verdictRule", "threshold", "https://example.test/extra"], true],
    ["verdict extra field", ["verdictRule", "https://example.test/extra"], true],
    ["unscorable policy", ["unscorable"], [{ when: "always" }]],
    ["evidence references", ["evidenceConventions", "requiredRefs"], []],
    ["evidence-conventions extra field", ["evidenceConventions", "https://example.test/extra"], true],
    ["top-level extra field", ["https://example.test/extra"], true],
  ] as const)("the exact specification gate rejects drift in %s", (_label, path, value) => {
    const fixture = makeFixture({ truthLabel: "CORRECT", response: encoder.encode("ACCEPT") });
    expect(isBinaryJudgmentEvaluationSpecification(
      mutateSpecification(fixture.specification, path, value),
    )).toBe(false);
  });

  test("method descriptor is generated from the profiles-owned umbrella bytes", () => {
    const method = binaryJudgmentEvaluationMethodDescriptor();
    expect(method.digest?.["sha256"]).toBe(
      BINARY_JUDGMENT_EVALUATION_PARSER_IDENTITY.digest.slice("sha256:".length),
    );
  });

  test("outcome validation refuses a self-inconsistent adapter result", async () => {
    const completed = await evaluate(makeFixture({
      truthLabel: "CORRECT",
      response: encoder.encode("ACCEPT"),
    }));
    const drifted: CompletedEvaluation = { ...completed, verdict: "fail" };
    expect(() => validateBinaryJudgmentCompletedEvaluation(drifted))
      .toThrow(EvaluationOperationalError);
  });

  test("outcome validation preserves the sealed invalid-output fallback", async () => {
    const completed = await evaluate(makeFixture({
      truthLabel: "WRONG",
      response: encoder.encode("not-a-token"),
    }));
    const outcome = completed.detailedOutcome as Record<string, unknown>;
    const measurements = completed.measurements!.map((measurement) =>
      measurement.name === BINARY_JUDGMENT_MEASUREMENTS.judgeDecision
        ? { ...measurement, value: "ACCEPT" }
        : measurement.name === BINARY_JUDGMENT_MEASUREMENTS.agreement
        ? { ...measurement, value: false }
        : measurement
    );
    expect(() => validateBinaryJudgmentCompletedEvaluation({
      ...completed,
      verdict: "fail",
      detailedOutcome: { ...outcome, judgeDecision: "ACCEPT", agreement: false },
      measurements,
    })).toThrow(EvaluationOperationalError);
  });

  test.each([
    ["itemId", "not-an-opaque-uuid", undefined],
    ["candidateClass", "not a closed class", BINARY_JUDGMENT_MEASUREMENTS.candidateClass],
    ["labelResolutionSha256", `sha256:${"A".repeat(64)}`, BINARY_JUDGMENT_MEASUREMENTS.labelResolutionSha256],
    ["instrumentSha256", "sha256:short", BINARY_JUDGMENT_MEASUREMENTS.instrumentSha256],
  ] as const)(
    "outcome validation refuses an invalid %s",
    async (field, value, measurementName) => {
      const completed = await evaluate(makeFixture({
        truthLabel: "CORRECT",
        response: encoder.encode("ACCEPT"),
      }));
      const outcome = completed.detailedOutcome as Record<string, unknown>;
      const measurements = completed.measurements!.map((measurement) =>
        measurement.name === measurementName ? { ...measurement, value } : measurement
      );
      expect(() => validateBinaryJudgmentCompletedEvaluation({
        ...completed,
        detailedOutcome: { ...outcome, [field]: value },
        measurements,
      })).toThrow(EvaluationOperationalError);
    },
  );
});

describe("binary judgment evaluator through the real evaluation harness", () => {
  test.each([
    ["CORRECT", "ACCEPT", "pass"],
    ["CORRECT", "REJECT", "fail"],
    ["WRONG", "ACCEPT", "fail"],
    ["WRONG", "REJECT", "pass"],
  ] as const)(
    "seals %s truth / %s decision as a %s ResultEvaluation",
    async (truthLabel, response, verdict) => {
      const run = await runHarnessFixture(makeFixture({
        truthLabel,
        response: encoder.encode(response),
      }));
      expect(run.exitCode).toBe(0);
      expect(run.statement?.predicate.verdict).toBe(verdict);
      expect(run.statement?.predicate.measurements).toContainEqual({
        name: BINARY_JUDGMENT_MEASUREMENTS.parseValid,
        value: true,
      });
    },
  );

  test("seals malformed delivered output as a completed invalid parse", async () => {
    const run = await runHarnessFixture(makeFixture({
      truthLabel: "WRONG",
      response: encoder.encode("REJECT."),
    }));
    expect(run.exitCode).toBe(0);
    expect(run.statement?.predicate.verdict).toBe("pass");
    expect(run.statement?.predicate.measurements).toContainEqual({
      name: BINARY_JUDGMENT_MEASUREMENTS.parseValid,
      value: false,
    });
  });

  test("writes no verdict when evaluator context is missing", async () => {
    const fixture = makeFixture({ truthLabel: "CORRECT", response: encoder.encode("ACCEPT") });
    const run = await runHarnessFixture({ ...fixture, context: {} });
    expect(run.exitCode).toBe(EVALUATION_HARNESS_EXIT_OPERATIONAL_FAILURE);
    await expect(readFile(join(run.paths.out, "verdict"))).rejects.toThrow();
  });

  test("writes no verdict when a cross-document digest drifts", async () => {
    const fixture = makeFixture({ truthLabel: "CORRECT", response: encoder.encode("ACCEPT") });
    const binary = fixture.context[BINARY_JUDGMENT_CONTEXT_KEY] as Record<string, unknown>;
    const run = await runHarnessFixture({
      ...fixture,
      context: {
        [BINARY_JUDGMENT_CONTEXT_KEY]: {
          ...binary,
          judgeObservationSha256: sha("e"),
        },
      },
    });
    expect(run.exitCode).toBe(EVALUATION_HARNESS_EXIT_OPERATIONAL_FAILURE);
    await expect(readFile(join(run.paths.out, "verdict"))).rejects.toThrow();
  });

  test("writes no verdict when material resolution is cancelled", async () => {
    const fixture = makeFixture({ truthLabel: "CORRECT", response: encoder.encode("ACCEPT") });
    const deployment = harnessDeployment();
    const cancelledRegistration = createBinaryJudgmentEvaluatorRegistration({
      evaluatorId: "did:key:z6MkBinaryJudgmentEvaluator",
      signerHandle: "evaluator-agent-key.pem",
      materialSource: {
        async read() {
          throw new EvaluationOperationalError({
            canonicalCode: "CANCELLED",
            reason: "provider-unavailable",
            recoveryAdvice: "resume-attempt",
            safeDetail: "binary judgment material resolution was cancelled",
          });
        },
      },
    });
    const run = await runHarnessFixture(fixture, {
      ...deployment,
      registrations: [cancelledRegistration],
    });
    expect(run.exitCode).toBe(EVALUATION_HARNESS_EXIT_OPERATIONAL_FAILURE);
    await expect(readFile(join(run.paths.out, "verdict"))).rejects.toThrow();
  });
});
