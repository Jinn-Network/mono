// SPDX-License-Identifier: Apache-2.0

/**
 * Fully synthetic judge-report rehearsal fixture for packet P8 (#2847). New surfaces live
 * here; `v4-synthetic-fixture.ts` defaults are not touched.
 *
 * Lifecycle through `report` uses production operations. Bind is the method FILE operand
 * (`selectMethod` with a binding-request path). Launch uses a stubbed in-memory venue.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { Buffer } from "node:buffer";
import { join } from "node:path";
import { buildResultEvaluationPayload } from "@jinn-network/attestation-issuer";
import {
  BENCHMARKING_METHOD_IDS,
  BENCHMARKING_METHOD_VERSION,
  parseCellKey,
  parseMatrix,
  type MatrixRecord,
} from "@jinn-network/benchmarking-records";
import { requirementsDigest } from "@jinn-network/benchmarking-local";
import type {
  AttemptUri,
  DeliveryRef,
  ObservationSnapshot,
  SubmissionAck,
  SubmissionUri,
} from "@jinn-network/task-execution-backend";
import { TaskExecutionError } from "@jinn-network/task-execution-backend";
import {
  BINARY_ACCEPT_REJECT_PARSER_IDENTITY,
  BINARY_CORRECT_WRONG_PARSER_IDENTITY,
  BINARY_JSON_VERDICT_PARSER_IDENTITY,
  BINARY_JUDGMENT_INSTRUMENT_FORMAT_URI,
  BINARY_JUDGMENT_INSTRUMENT_REQUIREMENT_KEY,
  BINARY_JUDGMENT_LABEL_RESOLUTION_MEDIA_TYPE,
  BINARY_JUDGMENT_OBSERVATION_MEDIA_TYPE,
  BINARY_JUDGMENT_RESPONSE_MEDIA_TYPE,
  BINARY_JUDGMENT_SNAPSHOT_PROBE_FORMAT_URI,
  BINARY_LABEL_IN_PROSE_PARSER_IDENTITY,
  BINARY_YES_NO_PARSER_IDENTITY,
  VERDICT_DSSE_PAYLOAD_TYPE,
  binaryJudgmentPromptTemplateDigest,
  binaryJudgmentSemanticRequestDigest,
  deriveEvaluationTask,
  JUDGE_MODEL_PROFILE_OBSERVATION_LIMITATIONS,
  JUDGE_MODEL_PROFILES,
  parseBinaryJudgmentAnalysisContext,
  parseBinaryJudgmentInstrument,
  parseBinaryJudgmentObservation,
  sealBinaryJudgmentInstrument,
  sealBinaryJudgmentObservation,
  sealBinaryJudgmentSnapshotProbe,
  type BinaryJudgmentResponseParserId,
  type BinaryJudgmentSnapshotProbe,
} from "@jinn-network/task-execution-profiles";
import {
  SubmissionRecordSchema,
  compareCodeUnitStrings,
  sealDelivery,
} from "@jinn-network/task-execution-protocol";
import {
  BINARY_JUDGMENT_LABEL_RESOLUTION_NAME,
  BINARY_JUDGMENT_MEASUREMENTS,
  binaryJudgmentEvaluationMethodDescriptor,
  selectBinaryJudgmentResponseParser,
} from "@jinn-network/task-execution-evaluator-adapters";
import {
  canonicalJsonBytes,
  dssePreAuthEncoding,
  recordDigest,
  sealDsseEnvelope,
} from "@jinn-network/trust-core";
import type { ResourceDescriptor } from "@jinn-network/task-execution-protocol";
import type { OperationContext } from "../../operations/context.js";
import { createDraft, updateDraft } from "../../operations/drafts.js";
import { admitHumanTruth } from "../../operations/human-review.js";
import { importBinaryItemBank } from "../../operations/import-item-bank.js";
import { initWorkspace } from "../../operations/init.js";
import { selectMethod } from "../../operations/method.js";
import { runCollect } from "../../operations/run-collect.js";
import { runLaunch, runResume } from "../../operations/run-launch.js";
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
import { readRunJournalEntries, type RunJournalEntry } from "../../run/journal.js";
import { readRunState } from "../../run/state.js";
import type { ProxiedBackend } from "../../run/drive.js";
import {
  INSPECT_BINARY_JUDGE_BINDING_REQUEST_SCHEMA,
  INSPECT_BINARY_JUDGE_LAUNCHER_ID,
  INSPECT_BINARY_JUDGE_SELECTION_SCHEMA,
  type InspectBinaryJudgeBindingRequest,
} from "../../runtime/inspect/binary-judge-manifest.js";
import { inspectBinaryJudgeWorkerSha256 } from "../../runtime/inspect/binary-judge.js";
import { inspectOciRunnerSha256 } from "../../runtime/inspect/oci.js";
import { INSPECT_EMBEDDED_EVALUATOR_ID } from "../../runtime/inspect/artifacts.js";
import {
  SUPPORTED_INSPECT_EVALS_VERSION,
  SUPPORTED_INSPECT_VERSION,
  SUPPORTED_OCI_PLATFORM,
  SUPPORTED_OCI_PYTHON_VERSION,
  SUPPORTED_OPENAI_SDK_VERSION,
} from "../../runtime/inspect/manifest.js";
import { getSealedBytes, putSealedBytes, sha256Hex } from "../../workspace/sealed-store.js";
import { loadOrCreateEvaluatorSigningKeys } from "../../venue/signing.js";
import type { LocalVenue } from "../../venue/venue.js";

export const JUDGE_REHEARSAL_DRAFT_ID = "judge-rehearsal";
export const JUDGE_REHEARSAL_ARM_IDS = ["alpha", "beta", "delta", "epsilon", "gamma", "zeta"] as const;
export const JUDGE_REHEARSAL_JUDGE_MODEL = "gpt-4o-mini-2024-07-18" as const;
export const JUDGE_REHEARSAL_EVIDENCE_PAIR = { declaring: "beta", twin: "alpha" } as const;
export const JUDGE_REHEARSAL_CANDIDATE_CLASSES = ["factual", "format", "reasoning"] as const;
export const JUDGE_REHEARSAL_STRATA = ["category-1", "category-2", "category-3", "category-4"] as const;

export const JUDGE_REHEARSAL_PARSER_BY_ARM = {
  alpha: BINARY_ACCEPT_REJECT_PARSER_IDENTITY,
  beta: BINARY_ACCEPT_REJECT_PARSER_IDENTITY,
  delta: BINARY_YES_NO_PARSER_IDENTITY,
  epsilon: BINARY_CORRECT_WRONG_PARSER_IDENTITY,
  gamma: BINARY_JSON_VERDICT_PARSER_IDENTITY,
  zeta: BINARY_LABEL_IN_PROSE_PARSER_IDENTITY,
} as const;

const decoder = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();
const EVALUATED_AT = "2026-08-15T12:30:00.000Z";
const JUDGE_MODEL = JUDGE_REHEARSAL_JUDGE_MODEL;

const samplingGeneration = {
  temperature: 0,
  maxOutputTokens: 512,
  store: false,
  background: false,
  stream: false,
  serviceTier: "default",
  tools: [] as [],
  fallbackModels: [] as [],
  retries: 0,
  persistedConversation: false,
  metadata: null,
  promptCacheIdentifier: null,
} as const;

const screeningGeneration = {
  reasoningEffort: "low",
  maxOutputTokens: 128,
  store: false,
  background: false,
  stream: false,
  serviceTier: "default",
  tools: [] as [],
  fallbackModels: [] as [],
  retries: 0,
  persistedConversation: false,
  metadata: null,
  promptCacheIdentifier: null,
} as const;

const SYNTHETIC_SOURCE_DIGESTS = ["a".repeat(64), "e".repeat(64), "f".repeat(64)] as const;
const SYNTHETIC_SOURCE_PUBLISHED_AT = [
  "2026-03-09T00:00:00Z",
  "2026-04-01T00:00:00Z",
  "2026-05-20T00:00:00Z",
] as const;

type CellToken = "A" | "R" | "I";
type ItemKind = "main" | "gate" | "corrupt" | "excluded";

interface RehearsalItem {
  readonly itemId: string;
  readonly question: string;
  readonly referenceAnswer: string;
  readonly candidateAnswer: string;
  readonly sourceDigestHex: string;
  readonly truthLabel: "CORRECT" | "WRONG";
  readonly candidateClass: string;
  readonly stratum: string;
  readonly kind: ItemKind;
  readonly replacesItemId?: string;
}

export interface JudgeRehearsalFixture {
  readonly workspaceDir: string;
  readonly draftId: string;
  readonly context: OperationContext;
  readonly createVenue: () => LocalVenue;
  readonly benchmarkSha256: string;
  readonly admissionManifestSha256: string;
  readonly excludedItemSha256: string;
  readonly replacementItemSha256: string;
  readonly gateProbeItemIds: readonly string[];
  readonly corruptKeyItemIds: readonly [string, string];
  readonly taskSha256s: readonly string[];
  readonly instrumentSha256s: readonly string[];
  readonly screeningRecords: {
    readonly instrumentSha256: `sha256:${string}`;
    readonly samplingScriptSha256: `sha256:${string}`;
    readonly rawOutputsSha256: `sha256:${string}`;
  };
  readonly reportSha256: string;
  readonly additionalReports: readonly { readonly method: string; readonly version: string; readonly reportSha256: string }[];
  readonly runSha256: string;
  readonly matrixSha256: string;
  readonly matrix: MatrixRecord;
  readonly journalEntries: readonly RunJournalEntry[];
  readonly items: readonly RehearsalItem[];
}

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

function parseJson(bytes: Uint8Array): Record<string, any> {
  return JSON.parse(decoder.decode(bytes)) as Record<string, any>;
}

function sourceDigestForPosition(position: number): string {
  return SYNTHETIC_SOURCE_DIGESTS[position % SYNTHETIC_SOURCE_DIGESTS.length]!;
}

function sourcePublishedAt(sourceDigestHex: string): string {
  const position = SYNTHETIC_SOURCE_DIGESTS.indexOf(sourceDigestHex as typeof SYNTHETIC_SOURCE_DIGESTS[number]);
  if (position === -1) throw new Error(`no synthetic source row for digest ${sourceDigestHex}`);
  return SYNTHETIC_SOURCE_PUBLISHED_AT[position]!;
}

function itemIdAt(index: number): string {
  return `urn:uuid:40000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
}

function buildRehearsalItems(): readonly RehearsalItem[] {
  const excluded: RehearsalItem = {
    itemId: itemIdAt(0),
    question: "Does the seeded synthetic factual category-1 statement match its reference?",
    referenceAnswer: "The seeded synthetic factual category-1 statement is correct.",
    candidateAnswer: "The seeded synthetic factual category-1 statement is correct.",
    sourceDigestHex: sourceDigestForPosition(0),
    truthLabel: "CORRECT",
    candidateClass: "factual",
    stratum: "category-1",
    kind: "excluded",
  };
  const main: RehearsalItem[] = [];
  let index = 1;
  for (const candidateClass of JUDGE_REHEARSAL_CANDIDATE_CLASSES) {
    for (const stratum of JUDGE_REHEARSAL_STRATA) {
      const truthLabel: "CORRECT" | "WRONG" = index % 2 === 1 ? "CORRECT" : "WRONG";
      const isReplacement = candidateClass === "factual" && stratum === "category-1";
      main.push({
        itemId: itemIdAt(index),
        question: `Does synthetic ${candidateClass} ${stratum} item match its reference?`,
        referenceAnswer: `Synthetic ${candidateClass} ${stratum} reference.`,
        candidateAnswer: truthLabel === "CORRECT"
          ? `Synthetic ${candidateClass} ${stratum} reference.`
          : `Deliberately different synthetic ${candidateClass} ${stratum} answer.`,
        sourceDigestHex: sourceDigestForPosition(index),
        truthLabel,
        candidateClass,
        stratum,
        kind: "main",
        ...(isReplacement ? { replacesItemId: excluded.itemId } : {}),
      });
      index += 1;
    }
  }
  const probes: RehearsalItem[] = [];
  for (let probe = 0; probe < 12; probe += 1) {
    const truthLabel: "CORRECT" | "WRONG" = probe % 2 === 0 ? "CORRECT" : "WRONG";
    probes.push({
      itemId: itemIdAt(index),
      question: `Does synthetic gate probe G${probe} match its reference?`,
      referenceAnswer: `Synthetic gate probe reference G${probe}.`,
      candidateAnswer: truthLabel === "CORRECT"
        ? `Synthetic gate probe reference G${probe}.`
        : `Deliberately different synthetic gate probe G${probe}.`,
      sourceDigestHex: sourceDigestForPosition(index),
      truthLabel,
      candidateClass: "gateProbe",
      stratum: "gate",
      kind: "gate",
    });
    index += 1;
  }
  const corruptQuestion = "Does the synthetic corrupt-key statement match its reference?";
  const corruptA: RehearsalItem = {
    itemId: itemIdAt(index),
    question: corruptQuestion,
    referenceAnswer: "Synthetic corrupt-key reference variant A.",
    candidateAnswer: "Synthetic corrupt-key reference variant A.",
    sourceDigestHex: sourceDigestForPosition(index),
    truthLabel: "CORRECT",
    candidateClass: "corruptKey",
    stratum: "corrupt",
    kind: "corrupt",
  };
  index += 1;
  const corruptB: RehearsalItem = {
    itemId: itemIdAt(index),
    question: corruptQuestion,
    referenceAnswer: "Synthetic corrupt-key reference variant B, deliberately different bytes.",
    candidateAnswer: "Synthetic corrupt-key reference variant A.",
    sourceDigestHex: sourceDigestForPosition(index),
    truthLabel: "WRONG",
    candidateClass: "corruptKey",
    stratum: "corrupt",
    kind: "corrupt",
  };
  return [excluded, ...main, ...probes, corruptA, corruptB];
}

function buildItemPayload(item: RehearsalItem) {
  return {
    itemId: item.itemId,
    question: item.question,
    referenceAnswer: item.referenceAnswer,
    candidateAnswer: item.candidateAnswer,
    evidence: `Synthetic evidence for: ${item.question}`,
    provenance: {
      sourceCommitment: prefixed(item.sourceDigestHex),
      timestamp: sourcePublishedAt(item.sourceDigestHex),
    },
    sources: [{ digest: { sha256: item.sourceDigestHex } }],
  };
}

function responseBytesFor(
  parserId: BinaryJudgmentResponseParserId,
  token: CellToken,
): Uint8Array {
  if (token === "I") {
    if (parserId === BINARY_JSON_VERDICT_PARSER_IDENTITY.id) return encoder.encode("{\"nope\":true}");
    if (parserId === BINARY_LABEL_IN_PROSE_PARSER_IDENTITY.id) return encoder.encode("the judge did not name a verdict");
    return encoder.encode("MAYBE");
  }
  const accept = token === "A";
  switch (parserId) {
    case BINARY_ACCEPT_REJECT_PARSER_IDENTITY.id:
      return encoder.encode(accept ? "ACCEPT" : "REJECT");
    case BINARY_YES_NO_PARSER_IDENTITY.id:
      return encoder.encode(accept ? "YES" : "NO");
    case BINARY_CORRECT_WRONG_PARSER_IDENTITY.id:
      return encoder.encode(accept ? "CORRECT" : "WRONG");
    case BINARY_JSON_VERDICT_PARSER_IDENTITY.id:
      return encoder.encode(accept ? "{\"verdict\":\"ACCEPT\"}" : "{\"verdict\":\"REJECT\"}");
    case BINARY_LABEL_IN_PROSE_PARSER_IDENTITY.id:
      return encoder.encode(accept ? "The verdict is ACCEPT." : "The verdict is REJECT.");
    default: {
      const _exhaustive: never = parserId;
      throw new Error(`unhandled parser ${_exhaustive}`);
    }
  }
}

function cellToken(item: RehearsalItem, armId: string, replicate: number): CellToken {
  const agrees: CellToken = item.truthLabel === "CORRECT" ? "A" : "R";
  const disagrees: CellToken = item.truthLabel === "CORRECT" ? "R" : "A";
  if (item.kind === "main" && item.candidateClass === "factual" && armId === "beta") return disagrees;
  if (item.kind === "main" && item.candidateClass === "factual" && item.stratum === "category-2" && armId === "delta") {
    return replicate === 3 ? disagrees : agrees;
  }
  if (item.kind === "main" && item.candidateClass === "format" && item.stratum === "category-1" && armId === "gamma" && replicate === 1) {
    return "I";
  }
  return agrees;
}

function instrument(
  armId: (typeof JUDGE_REHEARSAL_ARM_IDS)[number],
  options: { readonly templateArmId?: string; readonly declaresEvidence?: boolean } = {},
) {
  const templateArmId = options.templateArmId ?? armId;
  const parser = JUDGE_REHEARSAL_PARSER_BY_ARM[armId];
  const messages = [
    { role: "developer", segments: [{ literal: `Synthetic ${templateArmId} rubric. Judge only the supplied item. ` }] },
    {
      role: "user",
      segments: [
        { literal: "Question: " },
        { field: "question" },
        { literal: "\nReference: " },
        { field: "referenceAnswer" },
        { literal: "\nCandidate: " },
        { field: "candidateAnswer" },
        ...(options.declaresEvidence ? [{ literal: "\nEvidence: " }, { field: "evidence" }] : []),
      ],
    },
  ] as const;
  const descriptor = {
    uri: `https://fixtures.example.test/${templateArmId}/prompt`,
    digest: { sha256: sha256Hex(encoder.encode(`synthetic-${templateArmId}-prompt`)) },
  };
  return sealBinaryJudgmentInstrument({
    protocol: BINARY_JUDGMENT_INSTRUMENT_FORMAT_URI,
    instrumentId: armId,
    messages,
    promptTemplateSha256: binaryJudgmentPromptTemplateDigest(messages as never),
    promptSource: descriptor,
    license: {
      uri: "https://fixtures.example.test/licenses/apache-2.0.txt",
      digest: { sha256: sha256Hex(encoder.encode("Apache-2.0 fixture metadata only")) },
    },
    attribution: {
      uri: `https://fixtures.example.test/${templateArmId}/attribution`,
      digest: { sha256: sha256Hex(encoder.encode(`synthetic-${templateArmId}-attribution`)) },
    },
    model: { adapter: "jinn-openai", requested: JUDGE_MODEL, generation: samplingGeneration },
    response: {
      mediaType: BINARY_JUDGMENT_RESPONSE_MEDIA_TYPE,
      parser: { id: parser.id, version: parser.version, digest: parser.digest },
      invalidOutputDecision: "REJECT",
    },
  } as never);
}

function screeningInstrument() {
  const messages = [
    { role: "developer", segments: [{ literal: "Synthetic admission screening rubric. " }] },
    {
      role: "user",
      segments: [
        { literal: "Question: " }, { field: "question" },
        { literal: "\nReference: " }, { field: "referenceAnswer" },
        { literal: "\nCandidate: " }, { field: "candidateAnswer" },
        { literal: "\nEvidence: " }, { field: "evidence" },
      ],
    },
  ] as const;
  const descriptor = {
    uri: "https://fixtures.example.test/screening/prompt",
    digest: { sha256: sha256Hex(encoder.encode("judge-rehearsal-screening-prompt")) },
  };
  return sealBinaryJudgmentInstrument({
    protocol: BINARY_JUDGMENT_INSTRUMENT_FORMAT_URI,
    instrumentId: "screening-only",
    messages: messages as never,
    promptTemplateSha256: binaryJudgmentPromptTemplateDigest(messages as never),
    promptSource: descriptor,
    license: {
      uri: "https://fixtures.example.test/licenses/synthetic",
      digest: { sha256: sha256Hex(encoder.encode("synthetic fixture metadata only")) },
    },
    attribution: {
      uri: "https://fixtures.example.test/screening/attribution",
      digest: { sha256: sha256Hex(encoder.encode("synthetic screening attribution")) },
    },
    // The six run arms use the dated snapshot profile. The screening model deliberately uses the
    // other accepted profile, and its unique instrumentId keeps the exact bytes disjoint too.
    model: { adapter: "jinn-openai", requested: "gpt-5.6-luna", generation: screeningGeneration },
    response: {
      mediaType: BINARY_JUDGMENT_RESPONSE_MEDIA_TYPE,
      parser: BINARY_ACCEPT_REJECT_PARSER_IDENTITY,
      invalidOutputDecision: "REJECT",
    },
  } as never);
}

function makeCapabilities(instrumentSha256s: readonly string[]) {
  return {
    taskProfiles: ["https://spec.jinn.network/task-profiles/binary-judgment/2.0"],
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
        { key: "model", inventory: [JUDGE_MODEL], posture: "enforced" as const },
        { key: "isolationPolicy", inventory: ["oci-container"], posture: "enforced" as const },
        { key: BINARY_JUDGMENT_INSTRUMENT_REQUIREMENT_KEY, inventory: [...instrumentSha256s], posture: "enforced" as const },
      ],
    },
  };
}

function sourceDigest(name: "broker.py" | "model_provider.py"): string {
  return sha256Hex(new Uint8Array(readFileSync(new URL(`../../runtime/inspect/${name}`, import.meta.url))));
}

function rehearsalVenue(
  workspaceDir: string,
  instrumentSha256s: readonly string[],
  itemsById: ReadonlyMap<string, RehearsalItem>,
): LocalVenue {
  const [{ key }] = loadOrCreateEvaluatorSigningKeys(workspaceDir, [{ id: INSPECT_EMBEDDED_EVALUATOR_ID }]);
  const artifacts = new Map<string, Uint8Array>();
  const attempts = new Map<string, {
    readonly attempt: AttemptUri;
    readonly submission: SubmissionUri;
    readonly deliverySha256: string;
  }>();
  const pinning = new Map<SubmissionUri, { ready: true; checkedRequirementsDigest: `sha256:${string}` }>();
  const evaluationByTask = new Map<string, Uint8Array>();
  let counter = 0;
  let providerOutageTaskSha256: string | undefined;
  let providerOutageFailures = 0;
  const providerOutageBudget = 2;

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
      const harness = submission.requirements?.["harness"] as { readonly id?: string } | undefined;
      const isEvaluation = harness?.id === "evaluation-harness";
      if (isEvaluation) {
        const evaluationTaskSha256 = sha256Hex(taskBytes);
        if (providerOutageTaskSha256 === undefined) providerOutageTaskSha256 = evaluationTaskSha256;
        if (evaluationTaskSha256 === providerOutageTaskSha256 && providerOutageFailures < providerOutageBudget) {
          providerOutageFailures += 1;
          return {
            accepted: false,
            error: new TaskExecutionError("dependency-unavailable", {
              detail: "fixture provider temporarily unavailable",
            }),
          };
        }
        const verdictBytes = evaluationByTask.get(evaluationTaskSha256);
        if (verdictBytes === undefined) throw new Error("rehearsal venue: unknown evaluation Task");
        counter += 1;
        const attempt = `urn:uuid:50000000-0000-4000-8000-${String(counter).padStart(12, "0")}` as AttemptUri;
        const verdictHex = store(verdictBytes);
        const deliveryBytes = sealDelivery({
          protocol: "https://spec.jinn.network/profiles/task-execution/v1",
          attempt,
          task: prefixed(sha256Hex(taskBytes)),
          outputs: [{ name: "verdict", digest: { sha256: verdictHex } }],
          outcome: "fulfilled",
          createdAt: EVALUATED_AT,
        });
        const deliverySha256 = store(deliveryBytes);
        const submissionUri = submission.submission as SubmissionUri;
        const value = { attempt, submission: submissionUri, deliverySha256 };
        attempts.set(submissionUri, value);
        attempts.set(attempt, value);
        return {
          accepted: true,
          submission: submissionUri,
          digest: prefixed(sha256Hex(submissionBytes)),
        } satisfies SubmissionAck;
      }

      const taskSha256 = sha256Hex(taskBytes);
      if (submission.task.digest?.sha256 !== taskSha256) {
        throw new Error("rehearsal venue received a Submission for different Task bytes");
      }
      const nonceMatch = /^(.*):([1-9][0-9]*)$/u.exec(submission.nonce);
      if (nonceMatch === null) throw new Error("rehearsal venue received an unsupported solve nonce");
      const { cellKey, armId, replicate } = parseCellKey(nonceMatch[1]!);
      const instrumentSha256 = submission.requirements?.[BINARY_JUDGMENT_INSTRUMENT_REQUIREMENT_KEY];
      if (typeof instrumentSha256 !== "string" || !instrumentSha256s.includes(instrumentSha256)) {
        throw new Error("rehearsal venue received an unselected instrument");
      }
      const task = parseJson(taskBytes);
      const itemId = String(task.payload.itemId);
      const item = itemsById.get(itemId);
      if (item === undefined) throw new Error(`rehearsal venue has no item ${itemId}`);
      const instrumentBytes = getSealedBytes(workspaceDir, instrumentSha256.slice("sha256:".length));
      const parsedInstrument = parseBinaryJudgmentInstrument(instrumentBytes);
      const token = cellToken(item, armId, replicate);
      const parserId = parsedInstrument.response.parser.id as BinaryJudgmentResponseParserId;
      const responseBytes = responseBytesFor(parserId, token);
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
          requestedModel: parsedInstrument.model.requested,
          resolvedModel: parsedInstrument.model.requested,
          responseId: `synthetic-no-provider-${counter + 1}`,
          eventSha256: recordDigest(canonicalJsonBytes({ cellKey, source: "provider-free-fixture" })),
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        },
        call: { count: 1, retries: 0, fallbacks: 0 },
        limitations: [
          ...JUDGE_MODEL_PROFILE_OBSERVATION_LIMITATIONS[JUDGE_MODEL_PROFILES[parsedInstrument.model.requested]],
        ],
      }).bytes;
      const inspectLogBytes = encoder.encode(JSON.stringify({
        eval: "synthetic-inspect-log",
        cellKey,
        source: "provider-free-judge-rehearsal",
      }));
      const responseHex = store(responseBytes);
      const observationHex = store(observationBytes);
      const inspectLogHex = store(inspectLogBytes);
      counter += 1;
      const attempt = `urn:uuid:50000000-0000-4000-8000-${String(counter).padStart(12, "0")}` as AttemptUri;
      const deliveryBytes = sealDelivery({
        protocol: "https://spec.jinn.network/profiles/task-execution/v1",
        attempt,
        task: prefixed(taskSha256),
        outputs: [
          { name: "judge-response", digest: { sha256: responseHex } },
          { name: "judge-observation", digest: { sha256: observationHex } },
          { name: "inspect-log", digest: { sha256: inspectLogHex } },
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
      if (value === undefined) throw new Error(`rehearsal venue has no attempt for ${String(ref)}`);
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
      return value === undefined ? { classification: "absent" } : { classification: "matching" };
    },
    async deliveries(attempt) {
      const value = attempts.get(String(attempt));
      return value === undefined
        ? []
        : [{ attempt: value.attempt, digest: prefixed(value.deliverySha256) } satisfies DeliveryRef];
    },
    async fetchDelivery(ref) {
      const bytes = artifacts.get(ref.digest.slice("sha256:".length));
      if (bytes === undefined) throw new Error("rehearsal venue has no Delivery bytes");
      return bytes;
    },
    async fetchArtifact(descriptor: ResourceDescriptor) {
      const digest = descriptor.digest?.["sha256"];
      const bytes = digest === undefined ? undefined : artifacts.get(digest);
      if (bytes === undefined) throw new Error("rehearsal venue has no Result bytes");
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
    evaluationMode: "separate",
    prepareEvaluationCell(input) {
      const derived = deriveEvaluationTask({
        subjectTask: { name: "subject-task.json", digest: prefixed(sha256Hex(input.subjectTaskBytes)) },
        subjectDelivery: { name: "subject-delivery.json", digest: prefixed(sha256Hex(input.subjectDeliveryBytes)) },
        subjectResults: input.resultArtifacts.map((artifact) => ({
          name: artifact.name,
          digest: prefixed(sha256Hex(artifact.bytes)),
        })),
        evaluationSpecDigest: prefixed(sha256Hex(input.evaluationSpecBytes)),
      });
      const responseBytes = input.resultArtifacts.find((entry) => entry.name === "judge-response")?.bytes;
      const observationBytes = input.resultArtifacts.find((entry) => entry.name === "judge-observation")?.bytes;
      if (responseBytes === undefined || observationBytes === undefined) {
        throw new Error("rehearsal result omits a required judge artifact");
      }
      const observation = parseBinaryJudgmentObservation(observationBytes);
      const taskHex = observation.taskDigest.slice("sha256:".length);
      const taskBytes = getSealedBytes(workspaceDir, taskHex);
      const task = parseJson(taskBytes);
      const evaluationSpecHex = task.evaluation?.digest?.sha256 as string | undefined;
      if (evaluationSpecHex === undefined) throw new Error("rehearsal Task has no EvaluationSpec");
      const evaluationSpec = parseJson(getSealedBytes(workspaceDir, evaluationSpecHex));
      const analysisContextHex = evaluationSpec.familyBlock?.testMaterial?.[0]?.digest?.sha256 as string | undefined;
      if (analysisContextHex === undefined) throw new Error("rehearsal EvaluationSpec has no analysis context");
      const analysis = parseBinaryJudgmentAnalysisContext(getSealedBytes(workspaceDir, analysisContextHex));
      const labelBytes = getSealedBytes(workspaceDir, analysis.labelResolutionSha256.slice("sha256:".length));
      const instrumentHex = observation.instrumentSha256.slice("sha256:".length);
      const parsedInstrument = parseBinaryJudgmentInstrument(getSealedBytes(workspaceDir, instrumentHex));
      const parserId = parsedInstrument.response.parser.id as BinaryJudgmentResponseParserId;
      const response = selectBinaryJudgmentResponseParser(parserId)(responseBytes);
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
      const verdictBytes = sealDsseEnvelope({
        payloadType: VERDICT_DSSE_PAYLOAD_TYPE,
        payloadBytes,
        signatures: [{ keyid: key.keyId, signature: key.sign(preAuth) }],
      });
      evaluationByTask.set(derived.digest.slice("sha256:".length), verdictBytes);
      return { taskBytes: derived.bytes, taskSha256: derived.digest.slice("sha256:".length) };
    },
    async shutdown() {},
  };
}

function bindingRequest(
  instruments: readonly ReturnType<typeof sealBinaryJudgmentInstrument>[],
  probe: { readonly snapshotProbeSha256: `sha256:${string}`; readonly snapshotProbe: BinaryJudgmentSnapshotProbe },
): InspectBinaryJudgeBindingRequest {
  const imageDigest = `sha256:${"a".repeat(64)}` as const;
  return {
    schema: INSPECT_BINARY_JUDGE_BINDING_REQUEST_SCHEMA,
    manifest: {
      schema: INSPECT_BINARY_JUDGE_SELECTION_SCHEMA,
      runtime: {
        imageDigest,
        platform: SUPPORTED_OCI_PLATFORM,
        pythonVersion: SUPPORTED_OCI_PYTHON_VERSION,
        inspectVersion: SUPPORTED_INSPECT_VERSION,
        inspectEvalsVersion: SUPPORTED_INSPECT_EVALS_VERSION,
        openaiSdkVersion: SUPPORTED_OPENAI_SDK_VERSION,
        runtimeHostSourceSha256: inspectOciRunnerSha256(),
        workerSourceSha256: inspectBinaryJudgeWorkerSha256(),
        brokerSourceSha256: sourceDigest("broker.py"),
        modelProviderSourceSha256: sourceDigest("model_provider.py"),
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
      arms: JUDGE_REHEARSAL_ARM_IDS.map((armId, index) => ({
        armId,
        instrumentSha256: instruments[index]!.digest,
        model: JUDGE_MODEL,
        generation: samplingGeneration,
      })),
      snapshotProbeSha256: probe.snapshotProbeSha256,
    },
    host: {
      kind: "oci",
      dockerPath: "/usr/local/bin/docker",
      imageDigest,
      platform: SUPPORTED_OCI_PLATFORM,
      user: "65532:65532",
    },
    snapshotProbe: probe.snapshotProbe,
  };
}

/**
 * Drive import, screened admit with exclusion-and-replacement, method-file bind, quote, lock,
 * launch (stubbed provider with P7 two-failure eval outage), collect, and report.
 */
export async function runJudgeRehearsalLifecycle(input: {
  readonly workspaceDir: string;
}): Promise<JudgeRehearsalFixture> {
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
  const items = buildRehearsalItems();
  const itemsById = new Map(items.map((item) => [item.itemId, item]));
  const excluded = items.find((item) => item.kind === "excluded")!;
  const admittedItems = items.filter((item) => item.kind !== "excluded");
  const replacement = admittedItems.find((item) => item.replacesItemId === excluded.itemId)!;
  const gateProbeItemIds = admittedItems.filter((item) => item.kind === "gate").map((item) => item.itemId);
  const corruptItems = admittedItems.filter((item) => item.kind === "corrupt");

  requireOk(initWorkspace(context), "workspace init");
  requireOk(createDraft(context, {
    draftId: JUDGE_REHEARSAL_DRAFT_ID,
    name: "Judge rehearsal",
  }), "draft create");

  const rows = items.map((item) => {
    const payload = buildItemPayload(item);
    const itemSha256 = recordDigest(canonicalJsonBytes(payload));
    putSealedBytes(context.workspaceDir, canonicalJsonBytes(payload));
    return {
      item,
      payload,
      itemSha256,
      intendedLabel: item.truthLabel,
      screeningVerdict: item.kind === "excluded" ? "WRONG" as const : item.truthLabel,
      handChecked: true,
      handVerdict: item.kind === "excluded" ? "exclude" as const : "confirm" as const,
    };
  });
  const itemSha256ById = new Map(rows.map((row) => [row.item.itemId, row.itemSha256]));
  const screeningRows = rows.map((row) => ({
    itemSha256: row.itemSha256,
    intendedLabel: row.intendedLabel,
    screeningVerdict: row.screeningVerdict,
    handChecked: row.handChecked,
    handVerdict: row.handVerdict,
  })).sort((left, right) => compareCodeUnitStrings(left.itemSha256, right.itemSha256));
  const candidates = rows.map((row, index) => ({
    itemSha256: row.itemSha256,
    itemId: row.item.itemId,
    humanReviewEvaluationSpecSha256: BINARY_JUDGMENT_HUMAN_REVIEW_EVALUATION_SPEC_SEALED.digest,
    candidateClass: row.item.candidateClass,
    stratum: row.item.stratum,
    poolPosition: index + 1,
    ...(row.item.replacesItemId === undefined
      ? {}
      : { replacesItemSha256: itemSha256ById.get(row.item.replacesItemId)! }),
  }));
  const sealedScreeningInstrument = screeningInstrument();
  const samplingScriptBytes = encoder.encode("judge-rehearsal-sampling-script/v1");
  const rawOutputsBytes = new Uint8Array([0, 255, 1, 254, 2, 253]);
  const screeningRecords = {
    instrumentSha256: sealedScreeningInstrument.digest,
    samplingScriptSha256: recordDigest(samplingScriptBytes),
    rawOutputsSha256: recordDigest(rawOutputsBytes),
  };
  const admission = requireOk(admitHumanTruth(context, {
    draftId: JUDGE_REHEARSAL_DRAFT_ID,
    truthAdmission: "screened-operator-sampled",
    candidates,
    screening: {
      screeningInstrumentSha256: screeningRecords.instrumentSha256,
      screeningInstrumentBase64: Buffer.from(sealedScreeningInstrument.bytes).toString("base64"),
      sampleSeed: "judge-rehearsal-screening-seed",
      sampleSize: rows.length,
      samplingScriptSha256: screeningRecords.samplingScriptSha256,
      samplingScriptBase64: Buffer.from(samplingScriptBytes).toString("base64"),
      rawOutputsSha256: screeningRecords.rawOutputsSha256,
      rawOutputsBase64: Buffer.from(rawOutputsBytes).toString("base64"),
      rows: screeningRows,
    },
  }), "screened admission");

  const usedSourceDigests = [...new Set(items.map((item) => item.sourceDigestHex))].sort();
  const intake = {
    itemBankJsonl: renderCanonicalJsonl(items.map((item) => ({
      protocol: BINARY_ITEM_BANK_ENTRY_PROTOCOL,
      item: buildItemPayload(item),
    }))),
    sourceManifestJsonl: renderCanonicalJsonl(usedSourceDigests.map((hex) => ({
      protocol: BINARY_SOURCE_MANIFEST_ENTRY_PROTOCOL,
      provenanceSha256: prefixed(hex),
      source: {
        uri: `https://fixtures.example.test/synthetic-source-${hex.slice(0, 8)}.json`,
        digest: { sha256: hex },
      },
      license: {
        uri: "https://fixtures.example.test/licenses/apache-2.0.txt",
        digest: { sha256: "b".repeat(64) },
      },
      attribution: {
        uri: "https://fixtures.example.test/synthetic-attribution.txt",
        digest: { sha256: "c".repeat(64) },
      },
      publishedAt: sourcePublishedAt(hex),
    }))),
    admissionIndexJsonl: renderCanonicalJsonl([...admission.resolutions]
      .sort((left, right) => left.itemSha256 < right.itemSha256 ? -1 : left.itemSha256 > right.itemSha256 ? 1 : 0)
      .map((resolution) => ({
        protocol: BINARY_ADMISSION_INDEX_ENTRY_PROTOCOL,
        admissionManifestSha256: admission.admissionManifestSha256,
        itemSha256: resolution.itemSha256,
        labelResolutionSha256: resolution.labelResolutionSha256,
        analysisContextSha256: resolution.analysisContextSha256,
      }))),
  };
  const imported = requireOk(importBinaryItemBank(context, {
    profile: "binary-judgment@2",
    draftId: JUDGE_REHEARSAL_DRAFT_ID,
    itemBankJsonl: intake.itemBankJsonl,
    sourceManifestJsonl: intake.sourceManifestJsonl,
    admissionIndexJsonl: intake.admissionIndexJsonl,
    description: "Provider-free synthetic evidence; no benchmark dataset content.",
  }), "binary item-bank import");

  const instruments = JUDGE_REHEARSAL_ARM_IDS.map((armId) => {
    if (armId === JUDGE_REHEARSAL_EVIDENCE_PAIR.declaring) {
      return instrument(armId, { templateArmId: JUDGE_REHEARSAL_EVIDENCE_PAIR.twin, declaresEvidence: true });
    }
    if (armId === JUDGE_REHEARSAL_EVIDENCE_PAIR.twin) {
      return instrument(armId, { templateArmId: JUDGE_REHEARSAL_EVIDENCE_PAIR.twin });
    }
    return instrument(armId);
  });
  for (const sealed of instruments) putSealedBytes(input.workspaceDir, sealed.bytes);

  const snapshotProbe: BinaryJudgmentSnapshotProbe = {
    protocol: BINARY_JUDGMENT_SNAPSHOT_PROBE_FORMAT_URI,
    requestedModel: JUDGE_MODEL,
    resolvedModel: JUDGE_MODEL,
    responseId: "judge-rehearsal-snapshot-probe-1",
    eventSha256: recordDigest(canonicalJsonBytes({ source: "judge-rehearsal-snapshot-probe" })),
    probedAt: context.clock(),
    outcome: "serving",
  };
  const sealedProbe = sealBinaryJudgmentSnapshotProbe(snapshotProbe);
  const bindingPath = join(input.workspaceDir, "inspect-judge-binding.json");
  writeFileSync(bindingPath, JSON.stringify(bindingRequest(instruments, {
    snapshotProbeSha256: sealedProbe.digest,
    snapshotProbe,
  })));
  requireOk(await selectMethod(context, {
    draftId: JUDGE_REHEARSAL_DRAFT_ID,
    ref: bindingPath,
    cwd: input.workspaceDir,
  }), "method file bind");

  requireOk(updateDraft(context, {
    draftId: JUDGE_REHEARSAL_DRAFT_ID,
    patch: {
      replicates: 3,
      assurance: { preset: "direct-check", overrides: { maxInfrastructureRetries: 1 } },
      analysis: {
        method: BENCHMARKING_METHOD_IDS.binaryInstrument,
        version: BENCHMARKING_METHOD_VERSION,
      },
      additionalAnalyses: [
        { method: BENCHMARKING_METHOD_IDS.pairwiseDisagreement, version: BENCHMARKING_METHOD_VERSION },
        { method: BENCHMARKING_METHOD_IDS.pairedMajorityDelta, version: BENCHMARKING_METHOD_VERSION },
      ],
    },
  }), "draft update k and analyses");

  const instrumentSha256s = instruments.map((entry) => entry.digest);
  const venue = rehearsalVenue(input.workspaceDir, instrumentSha256s, itemsById);
  const createVenue = () => venue;
  requireOk(await runQuote(context, { draftId: JUDGE_REHEARSAL_DRAFT_ID }, { createVenue }), "quote");
  requireOk(runLock(context, { draftId: JUDGE_REHEARSAL_DRAFT_ID }), "lock");
  requireOk(await runLaunch(context, { draftId: JUDGE_REHEARSAL_DRAFT_ID }, { createVenue }), "launch");
  requireOk(await runResume(context, { draftId: JUDGE_REHEARSAL_DRAFT_ID }, { createVenue }), "resume P7 retry");
  const collected = requireOk(await runCollect(context, { draftId: JUDGE_REHEARSAL_DRAFT_ID }), "collect");
  const reported = requireOk(await runReport(context, { draftId: JUDGE_REHEARSAL_DRAFT_ID }), "report");
  const runState = readRunState(input.workspaceDir, JUDGE_REHEARSAL_DRAFT_ID);
  if (runState?.runSha256 === undefined || runState.matrixSha256 === undefined) {
    throw new Error("reported rehearsal run has no RunState identities");
  }
  return {
    workspaceDir: input.workspaceDir,
    draftId: JUDGE_REHEARSAL_DRAFT_ID,
    context,
    createVenue,
    benchmarkSha256: imported.benchmarkSha256,
    admissionManifestSha256: imported.admissionManifestSha256,
    excludedItemSha256: itemSha256ById.get(excluded.itemId)!,
    replacementItemSha256: itemSha256ById.get(replacement.itemId)!,
    gateProbeItemIds,
    corruptKeyItemIds: [corruptItems[0]!.itemId, corruptItems[1]!.itemId],
    taskSha256s: imported.taskSha256s,
    instrumentSha256s,
    screeningRecords,
    reportSha256: reported.reportSha256,
    additionalReports: (reported.additionalReports ?? []).map((entry) => ({
      method: entry.method,
      version: entry.version,
      reportSha256: entry.reportSha256,
    })),
    runSha256: runState.runSha256,
    matrixSha256: collected.matrixSha256,
    matrix: parseMatrix(getSealedBytes(input.workspaceDir, collected.matrixSha256)),
    journalEntries: readRunJournalEntries(input.workspaceDir, JUDGE_REHEARSAL_DRAFT_ID),
    items,
  };
}
