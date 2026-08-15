// SPDX-License-Identifier: Apache-2.0

import { buildResultEvaluationPayload } from "@jinn-network/attestation-issuer";
import {
  BENCHMARKING_METHOD_IDS,
  BENCHMARKING_METHOD_VERSION,
  parseCellKey,
} from "@jinn-network/benchmarking-records";
import { requirementsDigest } from "@jinn-network/benchmarking-local";
import type {
  AttemptUri,
  DeliveryRef,
  ObservationSnapshot,
  SubmissionAck,
  SubmissionUri,
} from "@jinn-network/task-execution-backend";
import {
  BINARY_JUDGMENT_ANALYSIS_CONTEXT_MEDIA_TYPE,
  BINARY_JUDGMENT_INSTRUMENT_FORMAT_URI,
  BINARY_JUDGMENT_INSTRUMENT_REQUIREMENT_KEY,
  BINARY_JUDGMENT_LABEL_RESOLUTION_MEDIA_TYPE,
  BINARY_JUDGMENT_OBSERVATION_MEDIA_TYPE,
  BINARY_JUDGMENT_RESPONSE_MEDIA_TYPE,
  VERDICT_DSSE_PAYLOAD_TYPE,
  binaryJudgmentPromptTemplateDigest,
  binaryJudgmentSemanticRequestDigest,
  parseBinaryJudgmentAnalysisContext,
  parseBinaryJudgmentInstrument,
  parseBinaryJudgmentLabelResolution,
  parseBinaryJudgmentObservation,
  sealBinaryJudgmentInstrument,
  sealBinaryJudgmentObservation,
} from "@jinn-network/task-execution-profiles";
import {
  SubmissionRecordSchema,
  sealDelivery,
} from "@jinn-network/task-execution-protocol";
import {
  BINARY_JUDGMENT_LABEL_RESOLUTION_NAME,
  BINARY_JUDGMENT_MEASUREMENTS,
  binaryJudgmentEvaluationMethodDescriptor,
  parseBinaryJudgmentResponse,
} from "@jinn-network/task-execution-evaluator-adapters";
import {
  canonicalJsonBytes,
  dssePreAuthEncoding,
  recordDigest,
  sealDsseEnvelope,
} from "@jinn-network/trust-core";
import type { ResourceDescriptor } from "@jinn-network/task-execution-protocol";
import type { OperationContext } from "../../operations/context.js";
import { armAdd } from "../../operations/arms.js";
import { createDraft, updateDraft } from "../../operations/drafts.js";
import {
  admitHumanTruth,
  createHumanReviewPackets,
  signHumanReviewResponse,
} from "../../operations/human-review.js";
import { importBinaryItemBank } from "../../operations/import-item-bank.js";
import { initWorkspace } from "../../operations/init.js";
import { runCollect } from "../../operations/run-collect.js";
import { runLaunch } from "../../operations/run-launch.js";
import { runLock } from "../../operations/run-lock.js";
import { runQuote } from "../../operations/run-quote.js";
import { runReport } from "../../operations/report.js";
import {
  BINARY_ADMISSION_INDEX_ENTRY_PROTOCOL,
  BINARY_ITEM_BANK_ENTRY_PROTOCOL,
  BINARY_SOURCE_MANIFEST_ENTRY_PROTOCOL,
  renderCanonicalJsonl,
} from "../../intake/binary-item-bank.js";
import { BINARY_JUDGMENT_HUMAN_REVIEW_EVALUATION_SPEC_SEALED } from "../../human-review/application.js";
import { readRunState } from "../../run/state.js";
import type { ProxiedBackend } from "../../run/drive.js";
import {
  INSPECT_BINARY_JUDGE_ADAPTER_ID,
  INSPECT_BINARY_JUDGE_LAUNCHER_ID,
  INSPECT_BINARY_JUDGE_LAUNCHER_VERSION,
  INSPECT_BINARY_JUDGE_SELECTION_SCHEMA,
  type InspectBinaryJudgeSelectionManifest,
} from "../../runtime/inspect/binary-judge-manifest.js";
import { INSPECT_EMBEDDED_EVALUATOR_ID } from "../../runtime/inspect/artifacts.js";
import {
  SUPPORTED_INSPECT_EVALS_VERSION,
  SUPPORTED_INSPECT_VERSION,
  SUPPORTED_OCI_PLATFORM,
  SUPPORTED_OCI_PYTHON_VERSION,
  SUPPORTED_OPENAI_SDK_VERSION,
} from "../../runtime/inspect/manifest.js";
import { getSealedBytes, putSealedBytes, sha256Hex } from "../../workspace/sealed-store.js";
import {
  createVerdictDsseSigner,
  loadOrCreateEvaluatorSigningKeys,
} from "../../venue/signing.js";
import type { LocalVenue } from "../../venue/venue.js";
import { materializePublicBundle, type MaterializedBundle } from "../materialize.js";

export type SyntheticV4TruthAdmission = "operator-only" | "two-human-unanimous";

export interface SyntheticV4BundleFixture {
  readonly workspaceDir: string;
  readonly draftId: string;
  readonly truthAdmission: SyntheticV4TruthAdmission;
  readonly publicationGrade: boolean;
  readonly benchmarkSha256: string;
  readonly admissionManifestSha256: string;
  readonly taskSha256s: readonly string[];
  readonly instrumentSha256s: readonly string[];
  readonly bundle: MaterializedBundle;
}

export interface SyntheticV4IntakeBytes {
  readonly itemBankJsonl: string;
  readonly sourceManifestJsonl: string;
  readonly admissionIndexJsonl: string;
}

const decoder = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();
const DRAFT_ID = "binary-publication";
const EVALUATED_AT = "2026-08-15T12:30:00.000Z";
const generation: InspectBinaryJudgeSelectionManifest["arms"][number]["generation"] = {
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

function requireOk<T>(
  result: { readonly ok: true; readonly result: T } | { readonly ok: false; readonly error: { readonly detail: string } },
  label: string,
): T {
  if (!result.ok) throw new Error(`${label}: ${result.error.detail}`);
  return result.result;
}

function prefixed(hex: string): `sha256:${string}` {
  return `sha256:${hex}`;
}

function fixtureItems() {
  return [
    {
      itemId: "urn:uuid:40000000-0000-4000-8000-000000000001",
      question: "Does the synthetic core statement match its reference?",
      referenceAnswer: "The synthetic core statement is correct.",
      candidateAnswer: "The synthetic core statement is correct.",
      provenance: [{ digest: { sha256: "a".repeat(64) } }],
      truthLabel: "CORRECT" as const,
      stratum: "core" as const,
    },
    {
      itemId: "urn:uuid:40000000-0000-4000-8000-000000000002",
      question: "Does the synthetic stress statement match its reference?",
      referenceAnswer: "The synthetic stress statement is correct.",
      candidateAnswer: "The synthetic stress statement is deliberately wrong.",
      provenance: [{ digest: { sha256: "a".repeat(64) } }],
      truthLabel: "WRONG" as const,
      stratum: "stress" as const,
    },
  ] as const;
}

function instrument(armId: string) {
  const messages = [
    { role: "developer", segments: [{ literal: `Synthetic ${armId} rubric. Judge only the supplied item. ` }] },
    {
      role: "user",
      segments: [
        { literal: "Question: " },
        { field: "question" },
        { literal: "\nReference: " },
        { field: "referenceAnswer" },
        { literal: "\nCandidate: " },
        { field: "candidateAnswer" },
      ],
    },
  ] as const;
  const descriptor = {
    uri: `https://fixtures.example.test/${armId}/prompt`,
    digest: { sha256: sha256Hex(encoder.encode(`synthetic-${armId}-prompt`)) },
  };
  return sealBinaryJudgmentInstrument({
    protocol: BINARY_JUDGMENT_INSTRUMENT_FORMAT_URI,
    instrumentId: armId,
    messages,
    promptTemplateSha256: binaryJudgmentPromptTemplateDigest(messages as never),
    promptSource: descriptor,
    license: {
      uri: "https://www.apache.org/licenses/LICENSE-2.0.txt",
      digest: { sha256: sha256Hex(encoder.encode("Apache-2.0 fixture metadata only")) },
    },
    attribution: {
      uri: `https://fixtures.example.test/${armId}/attribution`,
      digest: { sha256: sha256Hex(encoder.encode(`synthetic-${armId}-attribution`)) },
    },
    model: { adapter: "jinn-openai", requested: "gpt-5.6-luna", generation },
    response: {
      mediaType: BINARY_JUDGMENT_RESPONSE_MEDIA_TYPE,
      parser: {
        id: "network.jinn.parser.binary-accept-reject",
        version: "1.0.0",
        digest: "sha256:02aa652770de9e74415cd206c8741b6148e3ea82c21773983a6d8c66030d0073",
      },
      invalidOutputDecision: "REJECT",
    },
  } as never);
}

function parseJson(bytes: Uint8Array): Record<string, any> {
  return JSON.parse(decoder.decode(bytes)) as Record<string, any>;
}

function makeCapabilities(instrumentSha256s: readonly string[]) {
  return {
    taskProfiles: ["https://spec.jinn.network/task-profiles/binary-judgment/1.0"],
    inputMediaTypes: ["application/json"],
    outputMediaTypes: [BINARY_JUDGMENT_RESPONSE_MEDIA_TYPE, BINARY_JUDGMENT_OBSERVATION_MEDIA_TYPE],
    cancel: false,
    watch: false,
    preflight: false,
    fetchArtifact: true,
    confidentialInputs: false,
    signedObservations: false,
    signedDeliveries: false,
    evidenceCapture: "none" as const,
    deadlineEnforcement: false,
    isolation: ["oci-container"],
    attempts: {},
    runPinning: {
      keys: [
        { key: "harness", inventory: [INSPECT_BINARY_JUDGE_LAUNCHER_ID], posture: "enforced" as const },
        { key: "model", inventory: ["gpt-5.6-luna"], posture: "enforced" as const },
        { key: "isolationPolicy", inventory: ["oci-container"], posture: "enforced" as const },
        { key: BINARY_JUDGMENT_INSTRUMENT_REQUIREMENT_KEY, inventory: [...instrumentSha256s], posture: "enforced" as const },
      ],
    },
  };
}

/**
 * A deterministic execution-only seam. It never starts Docker, calls a provider, reads a secret,
 * or crosses the network. The production driver still owns Submission, Delivery, journal,
 * Matrix, Report, signature, and claim construction.
 */
function syntheticInspectVenue(workspaceDir: string, instrumentSha256s: readonly string[]): LocalVenue {
  const [{ key }] = loadOrCreateEvaluatorSigningKeys(workspaceDir, [{ id: INSPECT_EMBEDDED_EVALUATOR_ID }]);
  const artifacts = new Map<string, Uint8Array>();
  const attempts = new Map<string, {
    readonly attempt: AttemptUri;
    readonly submission: SubmissionUri;
    readonly deliverySha256: string;
  }>();
  const pinning = new Map<SubmissionUri, { ready: true; checkedRequirementsDigest: `sha256:${string}` }>();
  let counter = 0;

  const store = (bytes: Uint8Array): string => {
    const digest = sha256Hex(bytes);
    artifacts.set(digest, bytes);
    return digest;
  };

  const backend: ProxiedBackend = {
    async capabilities() {
      return makeCapabilities(instrumentSha256s);
    },
    async submit(taskBytes, submissionBytes) {
      const submission = SubmissionRecordSchema.parse(parseJson(submissionBytes));
      const taskSha256 = sha256Hex(taskBytes);
      if (submission.task.digest?.sha256 !== taskSha256) {
        throw new Error("synthetic venue received a Submission for different Task bytes");
      }
      const nonceMatch = /^(.*):([1-9][0-9]*)$/u.exec(submission.nonce);
      if (nonceMatch === null) throw new Error("synthetic venue received an unsupported solve nonce");
      const { cellKey, armId, replicate } = parseCellKey(nonceMatch[1]!);
      const instrumentSha256 = submission.requirements?.[BINARY_JUDGMENT_INSTRUMENT_REQUIREMENT_KEY];
      if (typeof instrumentSha256 !== "string" || !instrumentSha256s.includes(instrumentSha256)) {
        throw new Error("synthetic venue received an unselected instrument");
      }
      const task = parseJson(taskBytes);
      const instrumentBytes = getSealedBytes(workspaceDir, instrumentSha256.slice("sha256:".length));
      const parsedInstrument = parseBinaryJudgmentInstrument(instrumentBytes);
      const responseBytes = encoder.encode("ACCEPT");
      const responseSha256 = recordDigest(responseBytes);
      const observationBytes = sealBinaryJudgmentObservation({
        protocol: "https://spec.jinn.network/binary-judgment/judge-observation/v1",
        taskDigest: prefixed(taskSha256),
        armId,
        replicate,
        instrumentSha256: instrumentSha256 as `sha256:${string}`,
        requestSha256: binaryJudgmentSemanticRequestDigest(task.payload, parsedInstrument),
        response: { digest: responseSha256, mediaType: BINARY_JUDGMENT_RESPONSE_MEDIA_TYPE },
        provider: {
          requestedModel: "gpt-5.6-luna",
          resolvedModel: "gpt-5.6-luna",
          responseId: `synthetic-no-provider-${counter + 1}`,
          eventSha256: recordDigest(canonicalJsonBytes({ cellKey, source: "provider-free-fixture" })),
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        },
        call: { count: 1, retries: 0, fallbacks: 0 },
        limitations: ["mutable-model-alias"],
      }).bytes;
      const responseHex = store(responseBytes);
      const observationHex = store(observationBytes);
      counter += 1;
      const attempt = `urn:uuid:50000000-0000-4000-8000-${String(counter).padStart(12, "0")}` as AttemptUri;
      const deliveryBytes = sealDelivery({
        protocol: "https://spec.jinn.network/profiles/task-execution/v1",
        attempt,
        task: prefixed(taskSha256),
        outputs: [
          { name: "judge-response", digest: { sha256: responseHex } },
          { name: "judge-observation", digest: { sha256: observationHex } },
        ],
        outcome: "fulfilled",
        createdAt: EVALUATED_AT,
      });
      const deliverySha256 = store(deliveryBytes);
      const submissionUri = submission.submission as SubmissionUri;
      const value = { attempt, submission: submissionUri, deliverySha256 };
      attempts.set(submissionUri, value);
      attempts.set(attempt, value);
      pinning.set(submissionUri, {
        ready: true,
        checkedRequirementsDigest: requirementsDigest(submission.requirements ?? {}),
      });
      return {
        accepted: true,
        submission: submissionUri,
        digest: prefixed(sha256Hex(submissionBytes)),
      } satisfies SubmissionAck;
    },
    async observe(ref) {
      const value = attempts.get(String(ref));
      if (value === undefined) throw new Error(`synthetic venue has no attempt for ${String(ref)}`);
      return {
        descriptor: {
          attempt: value.attempt,
          task: prefixed("0".repeat(64)),
          submission: value.submission,
          derived: {
            state: "delivered",
            terminal: true,
            contradictory: false,
            cancelRequested: false,
            executionIds: [],
            deliveries: [],
          },
        },
        cursor: { sequence: "0" },
        observations: [],
      } satisfies ObservationSnapshot;
    },
    async recover(ref) {
      const value = attempts.get(String(ref));
      return value === undefined
        ? { classification: "absent" }
        : { classification: "matching" };
    },
    async deliveries(attempt) {
      const value = attempts.get(String(attempt));
      return value === undefined
        ? []
        : [{ attempt: value.attempt, digest: prefixed(value.deliverySha256) } satisfies DeliveryRef];
    },
    async fetchDelivery(ref) {
      const bytes = artifacts.get(ref.digest.slice("sha256:".length));
      if (bytes === undefined) throw new Error("synthetic venue has no Delivery bytes");
      return bytes;
    },
    async fetchArtifact(descriptor: ResourceDescriptor) {
      const digest = descriptor.digest?.["sha256"];
      const bytes = digest === undefined ? undefined : artifacts.get(digest);
      if (bytes === undefined) throw new Error("synthetic venue has no Result bytes");
      return bytes;
    },
    pinningEvidenceForSubmission(ref) {
      return pinning.get(ref);
    },
    async drain() {},
  };

  return {
    backend: backend as unknown as LocalVenue["backend"],
    verdictKeyId: key.keyId,
    evaluators: [{ id: INSPECT_EMBEDDED_EVALUATOR_ID, keyId: key.keyId }],
    evaluationMode: "embedded",
    interpretEmbeddedEvaluation(resultArtifacts) {
      const responseBytes = resultArtifacts.find((entry) => entry.name === "judge-response")?.bytes;
      const observationBytes = resultArtifacts.find((entry) => entry.name === "judge-observation")?.bytes;
      if (responseBytes === undefined || observationBytes === undefined) {
        return { kind: "could-not-grade", detail: "synthetic result omits a required judge artifact" };
      }
      const observation = parseBinaryJudgmentObservation(observationBytes);
      const taskHex = observation.taskDigest.slice("sha256:".length);
      const taskBytes = getSealedBytes(workspaceDir, taskHex);
      const task = parseJson(taskBytes);
      const evaluationSpecHex = task.evaluation?.digest?.sha256 as string | undefined;
      if (evaluationSpecHex === undefined) {
        return { kind: "could-not-grade", detail: "synthetic Task has no EvaluationSpec" };
      }
      const evaluationSpec = parseJson(getSealedBytes(workspaceDir, evaluationSpecHex));
      const analysisContextHex = evaluationSpec.familyBlock?.testMaterial?.[0]?.digest?.sha256 as string | undefined;
      if (analysisContextHex === undefined) {
        return { kind: "could-not-grade", detail: "synthetic EvaluationSpec has no analysis context" };
      }
      const analysis = parseBinaryJudgmentAnalysisContext(getSealedBytes(workspaceDir, analysisContextHex));
      const labelBytes = getSealedBytes(workspaceDir, analysis.labelResolutionSha256.slice("sha256:".length));
      const label = parseBinaryJudgmentLabelResolution(labelBytes);
      const instrumentHex = observation.instrumentSha256.slice("sha256:".length);
      const response = parseBinaryJudgmentResponse(responseBytes);
      const agreement = (response.decision === "ACCEPT" && analysis.truthLabel === "CORRECT")
        || (response.decision === "REJECT" && analysis.truthLabel === "WRONG");
      const evaluationMethod = binaryJudgmentEvaluationMethodDescriptor();
      const statementBytes = buildResultEvaluationPayload({
        task: { name: "subject-task.json", digest: prefixed(taskHex) },
        results: [
          {
            name: "judge-response",
            digest: recordDigest(responseBytes),
            mediaType: BINARY_JUDGMENT_RESPONSE_MEDIA_TYPE,
          },
          {
            name: "judge-observation",
            digest: recordDigest(observationBytes),
            mediaType: BINARY_JUDGMENT_OBSERVATION_MEDIA_TYPE,
          },
        ],
        evaluator: { id: INSPECT_EMBEDDED_EVALUATOR_ID },
        evaluatedAt: EVALUATED_AT,
        verdict: agreement ? "pass" : "fail",
        evaluationSpecification: { name: "evaluation-spec.json", digest: prefixed(evaluationSpecHex) },
        evaluationMethod: {
          name: evaluationMethod.name!,
          digest: prefixed(evaluationMethod.digest!["sha256"]!),
          ...(evaluationMethod.mediaType === undefined ? {} : { mediaType: evaluationMethod.mediaType }),
        },
        measurements: [
          { name: BINARY_JUDGMENT_MEASUREMENTS.judgeDecision, value: response.decision },
          { name: BINARY_JUDGMENT_MEASUREMENTS.truthLabel, value: analysis.truthLabel },
          { name: BINARY_JUDGMENT_MEASUREMENTS.agreement, value: agreement },
          { name: BINARY_JUDGMENT_MEASUREMENTS.parseValid, value: response.parseValid },
          { name: BINARY_JUDGMENT_MEASUREMENTS.candidateClass, value: analysis.candidateClass },
          { name: BINARY_JUDGMENT_MEASUREMENTS.stratum, value: analysis.stratum },
          { name: BINARY_JUDGMENT_MEASUREMENTS.labelResolutionSha256, value: analysis.labelResolutionSha256 },
          { name: BINARY_JUDGMENT_MEASUREMENTS.instrumentSha256, value: prefixed(instrumentHex) },
        ],
        evidence: [{
          name: BINARY_JUDGMENT_LABEL_RESOLUTION_NAME,
          digest: recordDigest(labelBytes),
          mediaType: BINARY_JUDGMENT_LABEL_RESOLUTION_MEDIA_TYPE,
        }],
        explanation: agreement
          ? "The synthetic decision agrees with the admitted label."
          : "The synthetic decision disagrees with the admitted label.",
        limitations: [...observation.limitations],
      });
      const payloadBytes = canonicalJsonBytes(JSON.parse(decoder.decode(statementBytes)));
      const preAuth = dssePreAuthEncoding(VERDICT_DSSE_PAYLOAD_TYPE, payloadBytes);
      return {
        kind: "verdict",
        evaluatorId: INSPECT_EMBEDDED_EVALUATOR_ID,
        verdictBytes: sealDsseEnvelope({
          payloadType: VERDICT_DSSE_PAYLOAD_TYPE,
          payloadBytes,
          signatures: [{ keyid: key.keyId, signature: key.sign(preAuth) }],
        }),
      };
    },
    prepareEvaluationCell() {
      throw new Error("embedded synthetic venue must not prepare a separate evaluation Task");
    },
    async shutdown() {},
  };
}

async function admitItems(
  context: OperationContext,
  truthAdmission: SyntheticV4TruthAdmission,
) {
  const items = fixtureItems();
  if (truthAdmission === "operator-only") {
    const candidates = items.map((item, index) => {
      const { truthLabel, stratum, ...payload } = item;
      const itemSha256 = recordDigest(canonicalJsonBytes(payload));
      putSealedBytes(context.workspaceDir, canonicalJsonBytes(payload));
      return {
        itemSha256,
        itemId: payload.itemId,
        humanReviewEvaluationSpecSha256: BINARY_JUDGMENT_HUMAN_REVIEW_EVALUATION_SPEC_SEALED.digest,
        candidateClass: "synthetic",
        stratum,
        poolPosition: index + 1,
        operatorTruthLabel: truthLabel,
      };
    });
    return requireOk(admitHumanTruth(context, {
      draftId: DRAFT_ID,
      truthAdmission,
      candidates,
    }), "operator admission");
  }

  const reviewers = ["urn:jinn:reviewer:a", "urn:jinn:reviewer:b"] as const;
  const reviewerRoster = [
    { evaluatorId: reviewers[0], personId: "synthetic-person-a", role: "domain-reviewer", conflicts: [] },
    { evaluatorId: reviewers[1], personId: "synthetic-person-b", role: "domain-reviewer", conflicts: [] },
  ] as const;
  const candidates = [];
  for (const [index, item] of items.entries()) {
    const { truthLabel, stratum, ...payload } = item;
    const packets = requireOk(createHumanReviewPackets(context, {
      draftId: DRAFT_ID,
      item: payload,
      evaluatorIds: reviewers,
    }), `human review packets ${index}`);
    const verdicts = [];
    for (const [reviewerIndex, packet] of packets.packets.entries()) {
      verdicts.push(requireOk(await signHumanReviewResponse(context, {
        draftId: DRAFT_ID,
        configuredEvaluatorIds: reviewers,
        activeEvaluatorId: packet.reviewerId,
        packetSha256: packet.packetSha256,
        visibilityReceiptSha256: packet.visibilityReceiptSha256,
        label: truthLabel,
        complete: true,
        completedAt: context.clock(),
      }), `human verdict ${index}/${reviewerIndex}`));
    }
    candidates.push({
      itemSha256: packets.itemSha256,
      itemId: payload.itemId,
      humanReviewEvaluationSpecSha256: packets.humanReviewEvaluationSpecSha256,
      candidateClass: "synthetic",
      stratum,
      poolPosition: index + 1,
      reviewVerdictSha256s: [verdicts[0]!.verdictSha256, verdicts[1]!.verdictSha256] as [string, string],
      reviewers: reviewerRoster,
    });
  }
  return requireOk(admitHumanTruth(context, {
    draftId: DRAFT_ID,
    truthAdmission,
    candidates,
  }), "two-human admission");
}

/**
 * Produces a complete binary public-bundle/4 with no provider, registry, Docker, Harbor, or
 * licensed-data dependency. The caller owns workspace cleanup.
 */
export async function createSyntheticV4BundleFixture(input: {
  readonly workspaceDir: string;
  readonly truthAdmission: SyntheticV4TruthAdmission;
  /** Test-only seam: corrupt the exact intake bytes before the real import operation parses them. */
  readonly mutateIntake?: (intake: SyntheticV4IntakeBytes) => SyntheticV4IntakeBytes;
}): Promise<SyntheticV4BundleFixture> {
  let tick = Date.parse("2026-08-15T11:00:00.000Z");
  const context: OperationContext = {
    workspaceDir: input.workspaceDir,
    principal: "synthetic-operator",
    clock: () => {
      const value = new Date(tick).toISOString();
      tick += 1_000;
      return value;
    },
  };
  requireOk(initWorkspace(context), "workspace init");
  requireOk(createDraft(context, { draftId: DRAFT_ID, name: "Synthetic binary publication" }), "draft create");
  const admission = await admitItems(context, input.truthAdmission);
  const items = fixtureItems();
  const exactIntake: SyntheticV4IntakeBytes = {
    itemBankJsonl: renderCanonicalJsonl(items.map(({ truthLabel: _truthLabel, stratum: _stratum, ...item }) => ({
      protocol: BINARY_ITEM_BANK_ENTRY_PROTOCOL,
      item,
    }))),
    sourceManifestJsonl: renderCanonicalJsonl([{
      protocol: BINARY_SOURCE_MANIFEST_ENTRY_PROTOCOL,
      provenanceSha256: prefixed("a".repeat(64)),
      source: {
        uri: "https://fixtures.example.test/synthetic-source.json",
        digest: { sha256: "a".repeat(64) },
      },
      license: {
        uri: "https://www.apache.org/licenses/LICENSE-2.0.txt",
        digest: { sha256: "b".repeat(64) },
      },
      attribution: {
        uri: "https://fixtures.example.test/synthetic-attribution.txt",
        digest: { sha256: "c".repeat(64) },
      },
    }]),
    admissionIndexJsonl: renderCanonicalJsonl(admission.resolutions.map((resolution) => ({
      protocol: BINARY_ADMISSION_INDEX_ENTRY_PROTOCOL,
      admissionManifestSha256: admission.admissionManifestSha256,
      itemSha256: resolution.itemSha256,
      labelResolutionSha256: resolution.labelResolutionSha256,
      analysisContextSha256: resolution.analysisContextSha256,
    }))),
  };
  const intake = input.mutateIntake?.(exactIntake) ?? exactIntake;
  const imported = requireOk(importBinaryItemBank(context, {
    profile: "binary-judgment@1",
    draftId: DRAFT_ID,
    itemBankJsonl: intake.itemBankJsonl,
    sourceManifestJsonl: intake.sourceManifestJsonl,
    admissionIndexJsonl: intake.admissionIndexJsonl,
    description: "Provider-free synthetic evidence; no benchmark dataset content.",
  }), "binary item-bank import");

  const arms = ["alpha", "beta", "delta", "gamma"] as const;
  const instruments = arms.map((armId) => instrument(armId));
  for (const sealed of instruments) putSealedBytes(input.workspaceDir, sealed.bytes);
  const selection: InspectBinaryJudgeSelectionManifest = {
    schema: INSPECT_BINARY_JUDGE_SELECTION_SCHEMA,
    runtime: {
      imageDigest: prefixed("d".repeat(64)),
      platform: SUPPORTED_OCI_PLATFORM,
      pythonVersion: SUPPORTED_OCI_PYTHON_VERSION,
      inspectVersion: SUPPORTED_INSPECT_VERSION,
      inspectEvalsVersion: SUPPORTED_INSPECT_EVALS_VERSION,
      openaiSdkVersion: SUPPORTED_OPENAI_SDK_VERSION,
      runtimeHostSourceSha256: "1".repeat(64),
      workerSourceSha256: "2".repeat(64),
      brokerSourceSha256: "3".repeat(64),
      modelProviderSourceSha256: "4".repeat(64),
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
    arms: arms.map((armId, index) => ({
      armId,
      instrumentSha256: instruments[index]!.digest,
      model: "gpt-5.6-luna",
      generation,
    })),
  };
  const selectionManifestSha256 = putSealedBytes(input.workspaceDir, canonicalJsonBytes(selection));
  for (const [index, armId] of arms.entries()) {
    requireOk(armAdd(context, {
      draftId: DRAFT_ID,
      armId,
      pinning: {
        harness: { id: INSPECT_BINARY_JUDGE_LAUNCHER_ID, version: INSPECT_BINARY_JUDGE_LAUNCHER_VERSION },
        model: { id: "gpt-5.6-luna" },
        [BINARY_JUDGMENT_INSTRUMENT_REQUIREMENT_KEY]: instruments[index]!.digest,
      },
    }), `arm ${armId}`);
  }
  requireOk(updateDraft(context, {
    draftId: DRAFT_ID,
    patch: {
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
  }), "draft binary profile");

  const instrumentSha256s = instruments.map((entry) => entry.digest);
  const createVenue = () => syntheticInspectVenue(input.workspaceDir, instrumentSha256s);
  requireOk(await runQuote(context, { draftId: DRAFT_ID }, { createVenue }), "quote");
  requireOk(runLock(context, { draftId: DRAFT_ID }), "lock");
  requireOk(await runLaunch(context, { draftId: DRAFT_ID }, { createVenue }), "launch");
  requireOk(await runCollect(context, { draftId: DRAFT_ID }), "collect");
  const reported = requireOk(await runReport(context, { draftId: DRAFT_ID }), "report");
  const runState = readRunState(input.workspaceDir, DRAFT_ID);
  if (runState === undefined) throw new Error("reported synthetic run has no RunState");
  const bundle = materializePublicBundle({
    workspaceDir: input.workspaceDir,
    draftId: DRAFT_ID,
    benchmarkSha256: reported.claimPackage.records.benchmarkSha256,
    runState,
  });
  return {
    workspaceDir: input.workspaceDir,
    draftId: DRAFT_ID,
    truthAdmission: input.truthAdmission,
    publicationGrade: imported.publicationGrade,
    benchmarkSha256: imported.benchmarkSha256,
    admissionManifestSha256: imported.admissionManifestSha256,
    taskSha256s: imported.taskSha256s,
    instrumentSha256s,
    bundle,
  };
}
