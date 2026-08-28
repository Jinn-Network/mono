// SPDX-License-Identifier: MIT

/**
 * Permanent join coverage for a harness-delivered INVALID verdict (#3079).
 *
 * The delivery side (evaluator adapter → real evaluation harness) and the consumption side
 * (aggregate reduction → qualification projection) are each covered in their own package. Nothing
 * drove genuinely unparseable judge-response BYTES through BOTH, joined — which is exactly the gap
 * that let the live defect ship: on the official LoCoMo judge run, cell 535 of 4,320 (attempt
 * `218889b0-9913-47f8-a0b3-fe09e054909e`) answered with prose before a fenced JSON verdict, the
 * harness refused the evaluator's `inconclusive` delivery, and the cell terminaled
 * `could-not-grade` and was permanently lost. Every unparseable response lost its cell.
 *
 * `@colophon-claims/core` is the only package that depends on both halves, so the join lives here.
 * The bytes are checked-in fixtures under `test/fixtures/unparseable-judge-response/`; the live
 * shape is among them, byte-exact.
 *
 * The whole chain is production code: `runEvaluationHarness` over the real binary-judgment
 * evaluator registration writes the ResultEvaluation, `assembleMatrix` over `localAssemblyPorts`
 * classifies the cells, and the registered `binary-instrument@1` method reduces and projects them.
 * Nothing between the fixture bytes and the published projection is hand-authored.
 */

import { Buffer } from "node:buffer";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BINARY_INSTRUMENT_MEASUREMENT_PROFILE,
  createMethodRegistry,
  MethodInputError,
  resolveBinaryInstrumentReduction,
  validateBinaryInstrumentParameters,
  validateBinaryInstrumentQualificationProjection,
  type MethodComputeInput,
} from "@jinn-network/benchmarking-aggregate";
import { localAssemblyPorts } from "@jinn-network/benchmarking-local";
import {
  BENCHMARKING_PROTOCOL,
  cellKey,
  parseBenchmark,
  parseMatrix,
  parseRun,
  sealBenchmark,
  sealMatrix,
  sealRun,
  type BenchmarkRecord,
  type MatrixRecord,
  type RunRecord,
} from "@jinn-network/benchmarking-records";
import { assembleMatrix, type InScopeCell } from "@jinn-network/benchmarking-run";
import { runEvaluationHarness } from "@jinn-network/task-execution-evaluation-harness";
import {
  buildBinaryJudgmentEvaluationSpecification,
  createBinaryJudgmentEvaluatorRegistration,
  evaluatorAdaptersParserAllowlist,
} from "@jinn-network/task-execution-evaluator-adapters";
import {
  BINARY_JUDGMENT_ANALYSIS_CONTEXT_FORMAT_URI,
  BINARY_JUDGMENT_INSPECT_LOG_MEDIA_TYPE,
  BINARY_JUDGMENT_INSTRUMENT_FORMAT_URI,
  BINARY_JUDGMENT_LABEL_RESOLUTION_FORMAT_URI,
  BINARY_JUDGMENT_OBSERVATION_FORMAT_URI,
  BINARY_JUDGMENT_OBSERVATION_MEDIA_TYPE,
  BINARY_JUDGMENT_PROFILE_DIGEST,
  BINARY_JUDGMENT_PROFILE_URI,
  BINARY_JUDGMENT_RESPONSE_MEDIA_TYPE,
  BINARY_MEM0_JSON_LABEL_PARSER_V2_IDENTITY,
  binaryJudgmentPromptTemplateDigest,
  binaryJudgmentSemanticRequestDigest,
  deriveEvaluationTask,
  recordDigest,
  sealBinaryJudgmentAnalysisContext,
  sealBinaryJudgmentInstrument,
  sealBinaryJudgmentLabelResolution,
  sealBinaryJudgmentObservation,
  sealEvaluationSpec,
  type BinaryJudgmentInstrument,
  type EvaluationSpec,
  type MeasurementMap,
} from "@jinn-network/task-execution-profiles";
import {
  documentDigest,
  sealDelivery,
  sealTask,
} from "@jinn-network/task-execution-protocol";
import { canonicalJsonBytes, sealDsseEnvelope } from "@jinn-network/trust-core";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const FIXTURE_DIR = "../../test/fixtures/unparseable-judge-response/";
/** The evaluation-context key the binary-judgment adapter reads (`adapter.ts`). */
const BINARY_JUDGMENT_CONTEXT_KEY = "binaryJudgment";
const INSTRUMENT_KEY = "network.jinn.binary-judgment.instrument";
const ITEM_COMMITMENT_KEY = "network.jinn.binary-judgment.item-sha256";
const VERDICT_PAYLOAD_TYPE = "application/vnd.in-toto+json";
const RUN_OWNER = "urn:uuid:77777777-7777-5777-8777-777777777777";
const CLOSE_AT = "2026-08-15T01:00:00Z";
const K = 3;

/**
 * The exact bytes preserved from the live cell-535 response, re-derived here as an inline literal
 * so the fixture file cannot drift: a tool-inserted trailing newline would change the digest, and
 * some edits would make an unparseable shape parse.
 */
const LIVE_PROSE_THEN_FENCE =
  "The generated answer refers to a car-related event in San Francisco, but it does not match "
  + "the specific activity of attending a car modification workshop mentioned in the gold "
  + 'answer, making it incorrect. \n\n```json\n{"label": "WRONG"}\n```';

const ARMS = ["arm-alpha", "arm-beta"] as const;
type ArmId = typeof ARMS[number];

const PARAMETERS = {
  verdictRule: "sole",
  k: K,
  reduction: "strict-majority",
  measurementProfile: BINARY_INSTRUMENT_MEASUREMENT_PROFILE,
  candidateClasses: ["contradiction", "factual"],
  strata: ["core", "stress"],
  parserInvalidPolicy: "abstain",
  truthAdmission: "two-human-unanimous",
  intervalAlpha: "0.05",
} as const;

const ITEMS = [
  { key: "alpha", itemId: "urn:uuid:11111111-1111-4111-8111-111111111111" },
  { key: "beta", itemId: "urn:uuid:22222222-2222-4222-8222-222222222222" },
] as const;
type ItemKey = typeof ITEMS[number]["key"];

/** `sha256:<hex>` over a repeated character, used only for opaque fixture references. */
const sha = (character: string) => `sha256:${character.repeat(64)}` as const;

function inline(bytes: Uint8Array) {
  return { digest: recordDigest(bytes), bytesBase64: Buffer.from(bytes).toString("base64") };
}

async function readFixture(name: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(new URL(`${FIXTURE_DIR}${name}.txt`, import.meta.url)));
}

const temporaryRoots: string[] = [];

interface HarnessCellResult {
  readonly cellKey: string;
  readonly itemKey: ItemKey;
  readonly armId: ArmId;
  readonly replicate: number;
  readonly taskDigestHex: string;
  readonly evaluationSpec: EvaluationSpec;
  readonly evaluationSpecDigest: `sha256:${string}`;
  readonly verdictPayloadBytes: Uint8Array;
  readonly verdictDigest: `sha256:${string}`;
  readonly predicate: Record<string, unknown>;
  readonly deliveryDigest: `sha256:${string}`;
  readonly attemptUri: string;
}

interface ItemMaterial {
  readonly taskBytes: Uint8Array;
  readonly taskDigestHex: string;
  readonly specification: EvaluationSpec;
  readonly specificationDigest: `sha256:${string}`;
  readonly payload: Record<string, unknown>;
  readonly analysisContext: { readonly digest: `sha256:${string}`; readonly bytes: Uint8Array };
  readonly labelResolution: { readonly digest: `sha256:${string}`; readonly bytes: Uint8Array };
}

/**
 * One arm's sealed instrument. `instrumentId` MUST equal the Run `armId` — `binary-instrument@1`
 * refuses any other pairing — and the two arms must seal to distinct bytes.
 */
function buildInstrument(armId: ArmId): BinaryJudgmentInstrument {
  const messages = [
    {
      role: "developer" as const,
      segments: [
        { literal: "Question: " },
        { field: "question" as const },
        { literal: "\nReference: " },
        { field: "referenceAnswer" as const },
        { literal: "\nCandidate: " },
        { field: "candidateAnswer" as const },
        { literal: "\nReturn a verdict." },
      ],
    },
    { role: "user" as const, segments: [{ literal: "Return exactly ACCEPT or REJECT." }] },
  ];
  return {
    protocol: BINARY_JUDGMENT_INSTRUMENT_FORMAT_URI,
    instrumentId: armId,
    messages,
    promptTemplateSha256: binaryJudgmentPromptTemplateDigest(messages),
    promptSource: { uri: `https://example.test/prompt/${armId}`, digest: { sha256: "1".repeat(64) } },
    license: { uri: "https://example.test/license", digest: { sha256: "2".repeat(64) } },
    attribution: { uri: "https://example.test/attribution", digest: { sha256: "3".repeat(64) } },
    model: {
      adapter: "jinn-openai" as const,
      requested: "gpt-5.6-luna" as const,
      generation: {
        reasoningEffort: "low" as const,
        maxOutputTokens: 128,
        store: false,
        background: false,
        stream: false,
        serviceTier: "default" as const,
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
      parser: BINARY_MEM0_JSON_LABEL_PARSER_V2_IDENTITY,
      // The abstain half of the sealed pair: an unparseable response becomes a neutral INVALID
      // rather than a manufactured REJECT.
      invalidOutputDecision: "INVALID" as const,
    },
  };
}

/**
 * The shared, arm-neutral item Task plus its sealed abstain EvaluationSpec, analysis context and
 * label resolution. The Task shape is the frozen binary-judgment/2.0 contract both legs enforce:
 * three output slots, a closed payload, an item commitment, and no arm-specific instrument pin.
 */
function buildItemMaterial(
  item: typeof ITEMS[number],
  put: (bytes: Uint8Array) => `sha256:${string}`,
): ItemMaterial {
  const payload = {
    itemId: item.itemId,
    question: `Where was the ${item.key} subject born?`,
    referenceAnswer: "London.",
    candidateAnswer: "London.",
    provenance: { sourceCommitment: sha("4"), timestamp: "2026-08-14T22:00:00Z" },
    sources: [{ digest: { sha256: "4".repeat(64) } }],
  };
  const itemSha256 = recordDigest(canonicalJsonBytes(payload));
  const labelResolution = sealBinaryJudgmentLabelResolution({
    protocol: BINARY_JUDGMENT_LABEL_RESOLUTION_FORMAT_URI,
    itemSha256,
    itemId: item.itemId,
    humanReviewEvaluationSpecSha256: sha("5"),
    truthLabel: "CORRECT",
    candidateClass: "factual",
    stratum: "core",
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
    itemId: item.itemId,
    labelResolutionSha256: labelResolution.digest,
    truthLabel: "CORRECT",
    candidateClass: "factual",
    stratum: "core",
  });
  const specification = buildBinaryJudgmentEvaluationSpecification(analysisContext.digest, "abstain");
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
      { name: "inspect-log", mediaType: BINARY_JUDGMENT_INSPECT_LOG_MEDIA_TYPE, required: false },
    ],
    evaluation: { digest: { sha256: sealedSpecification.digest.slice("sha256:".length) } },
    author: "did:key:z6Mksynthetic",
    [ITEM_COMMITMENT_KEY]: itemSha256,
  });
  put(taskBytes);
  put(sealedSpecification.bytes);
  put(analysisContext.bytes);
  put(labelResolution.bytes);
  return {
    taskBytes,
    taskDigestHex: documentDigest(taskBytes).slice("sha256:".length),
    specification,
    specificationDigest: sealedSpecification.digest,
    payload,
    analysisContext,
    labelResolution,
  };
}

/** The exact `WorkspacePaths` layout the evaluation harness reads. No launcher, no container. */
async function buildHarnessWorkspace(input: {
  readonly material: ItemMaterial;
  readonly responseBytes: Uint8Array;
  readonly observationBytes: Uint8Array;
  readonly evaluationContext: Record<string, unknown>;
  readonly attemptUri: string;
}) {
  const root = await mkdtemp(join(tmpdir(), "jinn-unparseable-judge-join-"));
  temporaryRoots.push(root);
  const paths = {
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
  const results = [
    {
      name: "judge-response",
      bytes: input.responseBytes,
      mediaType: BINARY_JUDGMENT_RESPONSE_MEDIA_TYPE,
    },
    {
      name: "judge-observation",
      bytes: input.observationBytes,
      mediaType: BINARY_JUDGMENT_OBSERVATION_MEDIA_TYPE,
    },
  ];
  const deliveryBytes = sealDelivery({
    protocol: "https://spec.jinn.network/profiles/task-execution/v1",
    attempt: input.attemptUri,
    task: documentDigest(input.material.taskBytes),
    outputs: results.map((result) => ({
      name: result.name,
      mediaType: result.mediaType,
      digest: { sha256: recordDigest(result.bytes).slice("sha256:".length) },
    })),
    outcome: "fulfilled",
    createdAt: "2026-08-15T10:00:00.000Z",
  });
  const sealedSpecification = sealEvaluationSpec(input.material.specification);
  const evaluationTask = deriveEvaluationTask({
    subjectTask: { name: "subject-task.json", digest: documentDigest(input.material.taskBytes) },
    subjectDelivery: { name: "subject-delivery.json", digest: documentDigest(deliveryBytes) },
    subjectResults: results.map((result) => ({
      name: result.name,
      digest: recordDigest(result.bytes),
    })),
    evaluationSpecDigest: sealedSpecification.digest,
  });
  await Promise.all([
    writeFile(join(paths.input, "task.sealed"), evaluationTask.bytes),
    writeFile(join(paths.input, "subject-task.json"), input.material.taskBytes),
    writeFile(join(paths.input, "subject-delivery.json"), deliveryBytes),
    ...results.map((result) => writeFile(join(paths.input, result.name), result.bytes)),
    writeFile(join(paths.input, "evaluation-spec.json"), sealedSpecification.bytes),
    writeFile(
      join(paths.input, "evaluation-context.json"),
      JSON.stringify({ [BINARY_JUDGMENT_CONTEXT_KEY]: input.evaluationContext }),
    ),
    writeFile(join(paths.input, "dispatch-context.json"), JSON.stringify({
      taskDigest: evaluationTask.digest,
      submission: "urn:uuid:11111111-1111-4111-8111-111111111111",
      nonce: "binary-evaluation-nonce",
      attempt: input.attemptUri,
    })),
    writeFile(join(paths.meta, "attempt.json"), "{}"),
    writeFile(join(paths.logs, "harness.ndjson"), ""),
  ]);
  return { paths, deliveryDigest: documentDigest(deliveryBytes) };
}

function harnessDeployment() {
  return {
    registrations: [createBinaryJudgmentEvaluatorRegistration({
      evaluatorId: "did:key:z6MkBinaryJudgmentEvaluator",
      signerHandle: "evaluator-agent-key.pem",
    })],
    parserAllowlist: evaluatorAdaptersParserAllowlist(),
    maxClaimEvidenceBytes: 1024 * 1024,
    evidenceWriter: {
      async putClaimEvidence({ name, bytes, mediaType }: {
        name: string;
        bytes: Uint8Array;
        mediaType?: string;
      }) {
        return {
          name,
          digest: { sha256: recordDigest(bytes).slice("sha256:".length) },
          ...(mediaType === undefined ? {} : { mediaType }),
        };
      },
    },
  };
}

/** The plan of what each of the twelve scientific cells delivers. */
const CELL_RESPONSES: Readonly<Record<ItemKey, Readonly<Record<ArmId, readonly string[]>>>> = {
  // Three genuinely unparseable shapes, the live one first: no side reaches the majority of two,
  // so this item-arm group must leave `itemDecisions` and surface as `no-valid-majority`.
  alpha: {
    "arm-alpha": ["live-prose-then-fence", "double-fence", "bare-prose"],
    "arm-beta": ["parseable-correct", "parseable-correct", "parseable-correct"],
  },
  beta: {
    "arm-alpha": ["parseable-correct", "parseable-correct", "parseable-correct"],
    "arm-beta": ["parseable-correct", "parseable-correct", "parseable-correct"],
  },
};

interface JoinFixture {
  readonly cells: readonly HarnessCellResult[];
  readonly records: Map<string, Uint8Array>;
  readonly bench: BenchmarkRecord;
  readonly run: RunRecord;
  readonly matrix: MatrixRecord;
  readonly input: MethodComputeInput;
}

let fixture: JoinFixture;

async function buildJoinFixture(): Promise<JoinFixture> {
  const records = new Map<string, Uint8Array>();
  const put = (bytes: Uint8Array): `sha256:${string}` => {
    const digest = recordDigest(bytes);
    records.set(digest, bytes);
    return digest;
  };

  const instruments = Object.fromEntries(ARMS.map((armId) => {
    const sealed = sealBinaryJudgmentInstrument(buildInstrument(armId));
    put(sealed.bytes);
    return [armId, sealed];
  })) as Record<ArmId, ReturnType<typeof sealBinaryJudgmentInstrument>>;
  const instrumentDigests = Object.fromEntries(
    ARMS.map((armId) => [armId, instruments[armId].digest]),
  ) as Record<ArmId, `sha256:${string}`>;

  const materials = Object.fromEntries(
    ITEMS.map((item) => [item.key, buildItemMaterial(item, put)]),
  ) as Record<ItemKey, ItemMaterial>;

  const responseBytesByName = new Map<string, Uint8Array>();
  const responseNames = new Set(
    Object.values(CELL_RESPONSES).flatMap((byArm) => Object.values(byArm).flat()),
  );
  for (const name of responseNames) {
    responseBytesByName.set(name, await readFixture(name));
  }

  const cells: HarnessCellResult[] = [];
  for (const item of ITEMS) {
    const material = materials[item.key];
    for (const armId of ARMS) {
      const responses = CELL_RESPONSES[item.key][armId];
      for (const [offset, responseName] of responses.entries()) {
        const replicate = offset + 1;
        const responseBytes = responseBytesByName.get(responseName)!;
        const responseDigest = recordDigest(responseBytes);
        const observation = sealBinaryJudgmentObservation({
          protocol: BINARY_JUDGMENT_OBSERVATION_FORMAT_URI,
          taskDigest: documentDigest(material.taskBytes),
          armId,
          replicate,
          instrumentSha256: instruments[armId].digest,
          requestSha256: binaryJudgmentSemanticRequestDigest(
            material.payload as never,
            buildInstrument(armId),
          ),
          response: { digest: responseDigest, mediaType: BINARY_JUDGMENT_RESPONSE_MEDIA_TYPE },
          provider: {
            requestedModel: "gpt-5.6-luna",
            resolvedModel: "gpt-5.6-luna",
            responseId: `resp_${item.key}_${armId}_${replicate}`,
            eventSha256: sha("d"),
            usage: { inputTokens: 100, outputTokens: 1, totalTokens: 101 },
          },
          call: { count: 1, retries: 0, fallbacks: 0 },
          limitations: ["mutable-model-alias"],
        });
        put(responseBytes);
        put(observation.bytes);

        const key = cellKey(material.taskDigestHex, armId, replicate);
        const attemptUri = `urn:uuid:33333333-3333-4333-8333-${
          Buffer.from(key).toString("hex").slice(0, 12).padEnd(12, "0")
        }`;
        const { paths, deliveryDigest } = await buildHarnessWorkspace({
          material,
          responseBytes,
          observationBytes: observation.bytes,
          attemptUri,
          evaluationContext: {
            protocol: "https://spec.jinn.network/binary-judgment/evaluation-context/v1",
            evaluationSpecSha256: material.specificationDigest,
            taskDigest: documentDigest(material.taskBytes),
            armId,
            replicate,
            judgeObservationSha256: observation.digest,
            responseSha256: responseDigest,
            material: {
              instrument: inline(instruments[armId].bytes),
              labelResolution: inline(material.labelResolution.bytes),
              analysisContext: inline(material.analysisContext.bytes),
            },
          },
        });
        const exitCode = await runEvaluationHarness(paths, harnessDeployment());
        expect(exitCode, `harness refused ${item.key}/${armId}/${replicate}`).toBe(0);
        const verdictPayloadBytes = new Uint8Array(await readFile(join(paths.out, "verdict")));
        const statement = JSON.parse(Buffer.from(verdictPayloadBytes).toString("utf8")) as
          Record<string, unknown>;
        const envelopeBytes = sealDsseEnvelope({
          payloadBytes: verdictPayloadBytes,
          payloadType: VERDICT_PAYLOAD_TYPE,
          signatures: [{ keyid: "did:key:z6MkBinaryJudgmentEvaluator", signature: Uint8Array.of(1) }],
        });
        const verdictDigest = put(envelopeBytes);
        cells.push({
          cellKey: key,
          itemKey: item.key,
          armId,
          replicate,
          taskDigestHex: material.taskDigestHex,
          evaluationSpec: material.specification,
          evaluationSpecDigest: material.specificationDigest,
          verdictPayloadBytes,
          verdictDigest,
          predicate: statement["predicate"] as Record<string, unknown>,
          deliveryDigest,
          attemptUri,
        });
      }
    }
  }

  const sealedBench = sealBenchmark({
    protocol: BENCHMARKING_PROTOCOL,
    name: "unparseable-judge-join",
    description: "Two binary-judgment items driven through the real evaluation harness.",
    version: "1.0.0",
    items: ITEMS.map((item) => ({
      task: { digest: { sha256: materials[item.key].taskDigestHex } },
    })),
    reveal: { policy: "immediate" },
  });
  const bench = parseBenchmark(sealedBench.bytes);

  const sealedRun = sealRun({
    protocol: BENCHMARKING_PROTOCOL,
    benchmark: { digest: { sha256: sealedBench.digest.slice("sha256:".length) } },
    owner: RUN_OWNER,
    arms: ARMS.map((armId) => ({ armId, pinning: { [INSTRUMENT_KEY]: instrumentDigests[armId] } })),
    replicates: K,
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
      parameters: PARAMETERS,
    }],
    closeAt: CLOSE_AT,
  });
  records.set(sealedRun.digest, sealedRun.bytes);
  const run = parseRun(sealedRun.bytes);

  const assembled = await assembleMatrix(bench, run, assemblyPorts(cells));
  return {
    cells,
    records,
    bench,
    run,
    matrix: assembled.record,
    input: computeInput(assembled.digest, assembled.record, records),
  };
}

/**
 * The `binary-instrument@1` compute input for one subject Matrix. Every `resolve*` port reads the
 * same record map, so the method walks the exact bytes the harness and assemble produced.
 */
function computeInput(
  subjectDigest: `sha256:${string}`,
  matrix: MatrixRecord,
  records: ReadonlyMap<string, Uint8Array>,
): MethodComputeInput {
  const resolve = (digest: string): Uint8Array | undefined => records.get(digest);
  return {
    subjects: [{ subjectSha256: subjectDigest.slice("sha256:".length), matrix }],
    parameters: PARAMETERS,
    verdictRule: "sole",
    resolveVerdictBytes: resolve,
    resolveRunBytes: resolve,
    resolveTaskBytes: resolve,
    resolveRecordBytes: resolve,
  } as unknown as MethodComputeInput;
}

/** The registered production method under test. */
function binaryInstrumentMethod() {
  return createMethodRegistry().get("jinn.benchmarking.method/binary-instrument", "1")!;
}

/** The three cells whose judge response is genuinely unparseable (item alpha, arm arm-alpha). */
function unparseableCells(): readonly HarnessCellResult[] {
  return fixture.cells.filter((cell) => cell.itemKey === "alpha" && cell.armId === "arm-alpha");
}

function firstUnparseableCell(): HarnessCellResult {
  return unparseableCells().find((cell) => cell.replicate === 1)!;
}

function assemblyPorts(cells: readonly HarnessCellResult[]) {
  const inScope: InScopeCell[] = cells.map((cell) => ({
    cellKey: cell.cellKey,
    armId: cell.armId,
    replicate: cell.replicate,
    taskDigest: cell.taskDigestHex,
    dispatches: 1,
    accounted: 1,
    submissionDigest: recordDigest(new TextEncoder().encode(cell.cellKey)),
    attempt: cell.attemptUri,
    deliveryDigest: cell.deliveryDigest,
    evaluationSpecDigest: cell.evaluationSpecDigest,
    evaluationSpec: cell.evaluationSpec,
    verdicts: [inScopeVerdict(cell)],
  }));
  return localAssemblyPorts({
    inputScope: { cellsForRun: () => inScope },
    pinning: { isolationInventory: ["unrestricted"], evidenceFor: () => undefined },
  });
}

function inScopeVerdict(cell: HarnessCellResult) {
  const measurements: MeasurementMap = Object.fromEntries(
    (cell.predicate["measurements"] as readonly { name: string; value: string | boolean }[])
      .map((measurement) => [measurement.name, measurement.value] as const),
  );
  return {
    digest: cell.verdictDigest,
    record: {
      evaluationSpecification: cell.evaluationSpecDigest,
      evaluator: "did:key:z6MkBinaryJudgmentEvaluator",
      verdict: cell.predicate["verdict"] as string,
    },
    measurements,
    evaluationSpec: cell.evaluationSpec,
    delivered: { verdict: cell.predicate["verdict"] as "pass" | "fail" | "inconclusive" },
  };
}

beforeAll(async () => {
  fixture = await buildJoinFixture();
}, 120_000);

afterAll(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("unparseable judge response, delivery joined to aggregate consumption", () => {
  test("the checked-in fixtures are the exact live bytes and stay unparseable", async () => {
    const live = await readFixture("live-prose-then-fence");
    expect(Buffer.from(live).toString("utf8")).toBe(LIVE_PROSE_THEN_FENCE);
    expect(live.byteLength).toBe(Buffer.byteLength(LIVE_PROSE_THEN_FENCE, "utf8"));
  });

  test("the hand-authored parameters are the registered method's own admitted set", () => {
    expect(validateBinaryInstrumentParameters(PARAMETERS)).toEqual({ ok: true });
    expect(binaryInstrumentMethod().validateParameters(PARAMETERS)).toEqual({ ok: true });
  });

  test("the harness delivers a counted inconclusive verdict for every unparseable shape", () => {
    const invalid = unparseableCells();
    expect(invalid).toHaveLength(3);
    for (const cell of invalid) {
      expect(cell.predicate["verdict"]).toBe("inconclusive");
      expect(cell.predicate["measurements"]).toContainEqual({ name: "judgeDecision", value: "INVALID" });
      expect(cell.predicate["measurements"]).toContainEqual({ name: "parseValid", value: false });
      expect(cell.predicate["measurements"]).toContainEqual({ name: "agreement", value: false });
    }
  });

  test("assemble classifies every unparseable cell as judged, never could-not-grade", () => {
    for (const cell of fixture.cells) {
      const matrixCell = fixture.matrix.cells.find((candidate) => candidate.cellKey === cell.cellKey)!;
      expect(matrixCell.outcome).toBe("judged");
      expect(matrixCell.validVerdicts).toEqual([cell.verdictDigest]);
      expect(matrixCell.verification.checksFailed).not.toContain("verdict-consistency");
    }
    expect(fixture.matrix.completeness.runOutcome).toBe("complete");
  });

  test("aggregate reduction derives inconclusive and surfaces the no-valid-majority exclusion", () => {
    const invalidKeys = unparseableCells().map((cell) => cell.cellKey).sort();
    // The reduction half, asserted directly: an abstained call is ADMITTED (it counts toward k)
    // and carries the neutral inconclusive verdict with no decision — never a manufactured REJECT
    // and never silently dropped.
    const { reduction } = resolveBinaryInstrumentReduction(
      {
        subjectSha256: fixture.input.subjects[0]!.subjectSha256,
        matrices: [fixture.matrix],
        parameters: PARAMETERS,
        verdictRule: "sole",
        resolveVerdictBytes: fixture.input.resolveVerdictBytes,
        resolveRunBytes: fixture.input.resolveRunBytes,
        resolveTaskBytes: fixture.input.resolveTaskBytes,
        resolveRecordBytes: fixture.input.resolveRecordBytes,
      } as never,
      {
        k: K,
        candidateClasses: PARAMETERS.candidateClasses,
        strata: PARAMETERS.strata,
        truthAdmission: PARAMETERS.truthAdmission,
        parserInvalidPolicy: PARAMETERS.parserInvalidPolicy,
      },
    );
    const invalidCalls = reduction.evaluatedCalls.filter((call) => invalidKeys.includes(call.cellKey));
    expect(invalidCalls).toHaveLength(3);
    for (const call of invalidCalls) {
      expect(call.verdict).toBe("inconclusive");
      expect(call.judgeDecision).toBeNull();
      expect(call.parseValid).toBe(false);
    }

    const result = binaryInstrumentMethod().compute!(fixture.input).perSubject[0]!.results as {
      configuration: { parserInvalidPolicy: string };
      arms: Record<string, { call: { evaluated: number; parseInvalid: number } }>;
      itemDecisions: readonly unknown[];
      excluded: { count: number; items: readonly { armId: string; cellKeys: readonly string[]; reasons: readonly { reason: string; cellKeys: readonly string[] }[] }[] };
    };

    expect(result.configuration.parserInvalidPolicy).toBe("abstain");
    expect(result.excluded.count).toBe(1);
    const excluded = result.excluded.items[0]!;
    expect(excluded.armId).toBe("arm-alpha");
    expect(excluded.reasons).toEqual([{ reason: "no-valid-majority", cellKeys: invalidKeys }]);
    // The three abstained calls are counted, not dropped: they are admitted replicates that
    // simply produced no majority.
    expect(result.arms["arm-alpha"]!.call.parseInvalid).toBe(3);
    // Three decided item-arm groups remain, so the projection below is not vacuous.
    expect(result.itemDecisions).toHaveLength(3);
    expect(validateBinaryInstrumentQualificationProjection(result)).toEqual({ ok: true });
  });
});

describe("consistency-violating verdicts are refused at both boundaries", () => {
  function tamperedEnvelope(mutate: (predicate: Record<string, unknown>) => void): {
    bytes: Uint8Array;
    digest: `sha256:${string}`;
  } {
    const cell = firstUnparseableCell();
    const statement = JSON.parse(Buffer.from(cell.verdictPayloadBytes).toString("utf8")) as
      Record<string, unknown>;
    mutate(statement["predicate"] as Record<string, unknown>);
    const bytes = sealDsseEnvelope({
      payloadBytes: canonicalJsonBytes(statement),
      payloadType: VERDICT_PAYLOAD_TYPE,
      signatures: [{ keyid: "did:key:z6MkBinaryJudgmentEvaluator", signature: Uint8Array.of(1) }],
    });
    return { bytes, digest: recordDigest(bytes) };
  }

  /**
   * Builds a Matrix that NAMES the tampered verdict as a sole valid verdict. Assemble would drop
   * it (see the assemble-leg test below), so the tampered bytes would never reach the aggregate at
   * all — the aggregate boundary has to be exercised directly for the refusal to mean anything.
   */
  function tamperedInput(bytes: Uint8Array, digest: `sha256:${string}`): MethodComputeInput {
    const target = firstUnparseableCell();
    const mutated = {
      ...(structuredClone(fixture.matrix) as MatrixRecord),
      cells: fixture.matrix.cells.map((cell) =>
        cell.cellKey === target.cellKey
          ? { ...cell, verdicts: [digest], validVerdicts: [digest] }
          : cell
      ),
    };
    const sealed = sealMatrix(mutated);
    const records = new Map(fixture.records);
    records.set(digest, bytes);
    return computeInput(sealed.digest, parseMatrix(sealed.bytes), records);
  }

  /** The `invalid-accept` tamper: an unparseable call re-signed as an agreeing ACCEPT pass. */
  function invalidSignedAsAcceptPass(predicate: Record<string, unknown>): void {
    predicate["verdict"] = "pass";
    predicate["measurements"] = (predicate["measurements"] as { name: string; value: unknown }[])
      .map((measurement) =>
        measurement.name === "judgeDecision"
          ? { ...measurement, value: "ACCEPT" }
          : measurement.name === "agreement"
          ? { ...measurement, value: true }
          : measurement
      );
  }

  test("an INVALID parse signed as an ACCEPT pass is refused at the aggregate boundary", () => {
    const { bytes, digest } = tamperedEnvelope(invalidSignedAsAcceptPass);
    const compute = () => binaryInstrumentMethod().compute!(tamperedInput(bytes, digest));
    expect(compute).toThrow(MethodInputError);
    expect(compute).toThrow(expect.objectContaining({
      code: "binary-binding-mismatch",
      message: expect.stringContaining(
        "signed response measurements do not replay from exact judge-response bytes",
      ),
    }));
  });

  test("an INVALID decision signed as a pass verdict is refused at the aggregate boundary", () => {
    const { bytes, digest } = tamperedEnvelope((predicate) => {
      predicate["verdict"] = "pass";
    });
    expect(() => binaryInstrumentMethod().compute!(tamperedInput(bytes, digest)))
      .toThrow(expect.objectContaining({
        code: "binary-binding-mismatch",
        message: expect.stringContaining("Result Evaluation verdict contradicts signed agreement"),
      }));
  });

  test("assemble refuses the same tamper before it can reach the aggregate", async () => {
    const { digest } = tamperedEnvelope(invalidSignedAsAcceptPass);
    const target = firstUnparseableCell();
    const tamperedCells = fixture.cells.map((cell) => {
      if (cell !== target) return cell;
      // The identical tamper the aggregate leg refuses, applied to the cell assemble sees.
      const predicate = { ...cell.predicate };
      invalidSignedAsAcceptPass(predicate);
      return { ...cell, verdictDigest: digest, predicate };
    });
    const assembled = await assembleMatrix(
      fixture.bench,
      fixture.run,
      assemblyPorts(tamperedCells),
    );
    const matrixCell = assembled.record.cells.find((cell) => cell.cellKey === target.cellKey)!;
    expect(matrixCell.outcome).not.toBe("judged");
    expect(matrixCell.verification.checksFailed).toContain("verdict-consistency");
    expect(matrixCell.validVerdicts).toEqual([]);
  });
});
