// SPDX-License-Identifier: Apache-2.0

/**
 * A complete anchored public bundle (`benchmark-product-public-bundle/6`) with no network, no
 * provider, no Docker, and no real timestamp authority — the anchored counterpart of
 * `v4-synthetic-fixture.ts`.
 *
 * Two seams are deliberate, and both are narrow:
 *
 * - **Execution.** The venue below is a deterministic in-memory backend, the same shape the paired
 *   lifecycle test uses. The production driver still owns Submission, Delivery, journal, Matrix,
 *   Report, signature, and claim construction; the fixture only decides what a cell delivered.
 * - **Acquisition.** Anchors are obtained through the real `runAnchor` operation with an injected
 *   `AnchorProofSource`, so the write-once rule, the post-launch refusal, and the verify-before-
 *   store gate all run for real. Only the bytes a calendar or authority would have returned are
 *   supplied locally, by the trust conformance kit's own fixture authority and OTS builders. The
 *   kit is a devDependency and is imported only from this test-only module. The one exception is
 *   `bypassProducerGuard` (see the plan type), which writes the record and its RunState entry
 *   directly — the only way to build a bundle a conformant producer now refuses to produce.
 *
 * The authority's `genTime` is fixed at a past instant so the §8 step-4 splice-catch
 * (`genTime <= run.closeAt`) is satisfied by construction against the real clock this fixture runs
 * on; a fixture wanting the violation asks for it explicitly, and asks to bypass the producer too.
 */

import { deriveEvaluationTask } from "@jinn-network/task-execution-profiles";
import { sealDelivery, type ResourceDescriptor } from "@jinn-network/task-execution-protocol";
import type {
  AttemptUri,
  BackendCapabilities,
  DeliveryRef,
  ObservationSnapshot,
  SubmissionAck,
  SubmissionUri,
} from "@jinn-network/task-execution-backend";
import { RUN_RECORD_KIND } from "@jinn-network/benchmarking-records";
import {
  ANCHOR_EVIDENCE_KIND,
  OPENTIMESTAMPS_ANCHOR_PROFILE,
  RFC3161_TSA_ANCHOR_PROFILE,
  canonicalJsonBytes,
  sealAnchorEvidence,
} from "@jinn-network/trust-core";
import type { AnchorEvidence, AnchorProofSource } from "@jinn-network/trust-core";
import {
  createFixtureAuthority,
  createOpenTimestampsKitFixtures,
  type FixtureAuthority,
  type OpenTimestampsKitFixtures,
} from "@jinn-network/trust-testing";
import type { OperationContext } from "../../operations/context.js";
import { anchorProofMediaType, encodeAnchorProofContent } from "../../anchor/profiles.js";
import { armAdd } from "../../operations/arms.js";
import { createDraft, updateDraft } from "../../operations/drafts.js";
import { initWorkspace } from "../../operations/init.js";
import { importSweBenchRows } from "../../operations/import.js";
import { runAnchor } from "../../operations/run-anchor.js";
import { runCollect } from "../../operations/run-collect.js";
import { runLaunch } from "../../operations/run-launch.js";
import { runLock } from "../../operations/run-lock.js";
import { runQuote } from "../../operations/run-quote.js";
import { runReport } from "../../operations/report.js";
import { readRunState, writeRunState, type RunState } from "../../run/state.js";
import type { ProxiedBackend } from "../../run/drive.js";
import {
  LEGACY_VERDICT_EVALUATOR_ID,
  createVerdictDsseSigner,
  loadOrCreateVerdictSigningKey,
  sealVerdictStatement,
} from "../../venue/signing.js";
import type { LocalVenue } from "../../venue/venue.js";
import { putSealedBytes, sha256Hex } from "../../workspace/sealed-store.js";
import { materializePublicBundle, type MaterializedBundle } from "../materialize.js";

const DRAFT_ID = "anchored-publication";
const FIXTURE_HARNESS_A = "anchored-fixture-harness-a";
const FIXTURE_HARNESS_B = "anchored-fixture-harness-b";
const FIXTURE_ENDPOINT = "https://timestamp.invalid/anchor-fixture";

/** Earlier than any instant a run in this fixture can close at, so the splice-catch passes by
 * construction. Inside the kit certificate's 2026-01-01 .. 2036-01-01 validity window. */
export const V6_FIXTURE_GEN_TIME_DER = "20260101120000Z";
export const V6_FIXTURE_GEN_TIME = "2026-01-01T12:00:00Z";
/** Deliberately later than any instant a run in this fixture can close at (§11 family 8). */
export const V6_FIXTURE_SPLICED_GEN_TIME_DER = "20351231120000Z";

/** What the fixture asks `runAnchor` to obtain, in the order given. Lock-subject plans run between
 * `lock` and `launch`; matrix-subject plans run after `collect`. */
export type SyntheticV6AnchorPlan =
  /**
   * One conformant RFC 3161 token over the sealed Run digest.
   *
   * `bypassProducerGuard` writes the sealed AnchorEvidence record and its RunState entry directly,
   * with no producer operation in the path. It exists for exactly one case: `runAnchor` applies the
   * §8 step-4 splice-catch at acquisition (§19.5), so a `genTimeDer` after this run's `closeAt` can
   * no longer be obtained through it — and the reader-side rule that catches such a token is there
   * precisely because a producer cannot be trusted to have applied it. Simulating that producer is
   * the only way to build the bundle the reader must refuse.
   */
  | { readonly kind: "rfc3161-lock"; readonly genTimeDer?: string; readonly bypassProducerGuard?: true }
  /** One conformant RFC 3161 token over the sealed Matrix digest. */
  | { readonly kind: "rfc3161-matrix"; readonly genTimeDer?: string }
  /** A calendar-only OpenTimestamps promise over the sealed Run digest. */
  | { readonly kind: "opentimestamps-lock-pending" }
  /** The §6.2 upgraded pair: the pending promise, then its completed form. */
  | { readonly kind: "opentimestamps-lock-upgraded" }
  /** A structurally complete OpenTimestamps proof over the sealed Matrix digest. */
  | { readonly kind: "opentimestamps-matrix" }
  /** Structurally complete, self-consistent replay, invented commitment (§11 family 10). */
  | { readonly kind: "opentimestamps-lock-fabricated" };

export interface SyntheticV6BundleFixture {
  readonly workspaceDir: string;
  readonly draftId: string;
  readonly benchmarkSha256: string;
  readonly runState: RunState;
  readonly runSha256: string;
  readonly matrixSha256: string;
  readonly bundle: MaterializedBundle;
  /** The kit authority whose self-signed certificate is the only root a verifier configuration in
   * these tests ever trusts. */
  readonly authority: FixtureAuthority;
  /** The OpenTimestamps kit fixtures over the sealed Run digest, and their synthetic headers. */
  readonly lockOts: OpenTimestampsKitFixtures;
  readonly matrixOts: OpenTimestampsKitFixtures;
}

const utf8 = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));

function requireOk<T>(
  result: { readonly ok: true; readonly result: T } | { readonly ok: false; readonly error: { readonly detail: string } },
  label: string,
): T {
  if (!result.ok) throw new Error(`${label}: ${result.error.detail}`);
  return result.result;
}

function fixtureRow(index: number) {
  const suffix = index.toString(16).padStart(2, "0");
  return {
    instance_id: `anchored-fixture-${suffix}`,
    repo: "example/anchored",
    base_commit: `${"a".repeat(38)}${suffix}`,
    problem_statement: `Apply deterministic fixture change ${suffix}.`,
    language: "typescript",
    image: {
      uri: "https://example.org/images/anchored-fixture:1",
      digest: { sha256: "8".repeat(64) },
    },
    testMaterial: [{ uri: `https://example.org/tests/anchored-fixture-${suffix}.json` }],
    parser: { id: "jinn.parser.fixture", version: "1.0.0", digest: `sha256:${"9".repeat(64)}` },
    transitions: {
      failToPass: [`fixture-${suffix}::target`],
      passToPass: [`fixture-${suffix}::regression`],
    },
    timeout: 60,
  };
}

const FIXTURE_CAPABILITIES: BackendCapabilities = {
  taskProfiles: [],
  inputMediaTypes: [],
  outputMediaTypes: [],
  cancel: false,
  watch: false,
  preflight: false,
  fetchArtifact: true,
  confidentialInputs: false,
  signedObservations: false,
  signedDeliveries: false,
  evidenceCapture: "none",
  deadlineEnforcement: false,
  isolation: ["unrestricted"],
  attempts: {},
  runPinning: {
    keys: [
      { key: "harness", inventory: [FIXTURE_HARNESS_A, FIXTURE_HARNESS_B], posture: "enforced" },
      { key: "isolationPolicy", inventory: ["unrestricted"], posture: "enforced" },
    ],
  },
};

function fixtureVenue(workspaceDir: string): LocalVenue {
  const byUri = new Map<string, { attempt: string; submission: string; deliverySha256: string }>();
  const accepted = new Map<string, SubmissionAck>();
  const bytesBySha256 = new Map<string, Uint8Array>();
  const evaluationByTask = new Map<string, string>();
  let sequence = 0;

  const store = (bytes: Uint8Array): string => {
    const digest = sha256Hex(bytes);
    bytesBySha256.set(digest, bytes);
    return digest;
  };

  const verdictEnvelope = async (evaluationSpecificationSha256: string): Promise<Uint8Array> => {
    const statement = {
      _type: "https://in-toto.io/Statement/v1",
      subject: [
        { name: "subject-task.json", digest: { sha256: "a".repeat(64) } },
        { name: "patch", digest: { sha256: "b".repeat(64) } },
      ],
      predicateType: "https://spec.jinn.network/attestations/result-evaluation/v1",
      predicate: {
        evaluator: { id: LEGACY_VERDICT_EVALUATOR_ID },
        verdict: "pass",
        evaluationSpecification: { digest: { sha256: evaluationSpecificationSha256 } },
        taskSubject: "subject-task.json",
        resultSubjects: ["patch"],
        measurements: [{ name: "passed", value: true }],
        evaluatedAt: "2026-08-12T00:00:00Z",
      },
    };
    return sealVerdictStatement({
      statementBytes: canonicalJsonBytes(statement),
      evaluatorId: LEGACY_VERDICT_EVALUATOR_ID,
      expectedEvaluationSpecificationSha256: evaluationSpecificationSha256,
      signer: createVerdictDsseSigner(loadOrCreateVerdictSigningKey(workspaceDir)),
    });
  };

  const backend: ProxiedBackend = {
    async capabilities() {
      return FIXTURE_CAPABILITIES;
    },
    async submit(taskBytes, submissionBytes) {
      const submission = JSON.parse(new TextDecoder().decode(submissionBytes)) as {
        readonly idempotencyKey: string;
        readonly submission: string;
        readonly task: { readonly digest: { readonly sha256: string } };
        readonly requirements?: { readonly harness?: { readonly id?: string } };
      };
      const prior = accepted.get(submission.idempotencyKey);
      if (prior !== undefined) return prior;

      sequence += 1;
      const attempt = `urn:uuid:00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`;
      const harnessId = submission.requirements?.harness?.id;
      const isEvaluation = harnessId === "evaluation-harness";
      let outputName: string;
      let outputBytes: Uint8Array;
      if (isEvaluation) {
        const evaluationSpecificationSha256 = evaluationByTask.get(sha256Hex(taskBytes));
        if (evaluationSpecificationSha256 === undefined) {
          throw new Error("anchored fixture: unknown evaluation Task");
        }
        outputName = "verdict";
        outputBytes = await verdictEnvelope(evaluationSpecificationSha256);
      } else {
        outputName = "patch";
        outputBytes = utf8({ armId: harnessId === FIXTURE_HARNESS_B ? "armB" : "armA" });
      }

      const deliveryBytes = sealDelivery({
        protocol: "https://spec.jinn.network/profiles/task-execution/v1",
        attempt,
        task: `sha256:${submission.task.digest.sha256}`,
        outputs: [{ name: outputName, digest: { sha256: store(outputBytes) } }],
        outcome: "fulfilled",
        createdAt: "2026-08-12T00:00:00Z",
      });
      const deliverySha256 = store(deliveryBytes);
      const state = { attempt, submission: submission.submission, deliverySha256 };
      byUri.set(submission.submission, state);
      byUri.set(attempt, state);
      const ack: SubmissionAck = {
        accepted: true,
        submission: submission.submission as SubmissionUri,
        digest: `sha256:${sha256Hex(submissionBytes)}`,
      };
      accepted.set(submission.idempotencyKey, ack);
      return ack;
    },
    async observe(reference) {
      const found = byUri.get(reference as string);
      if (found === undefined) throw new Error(`anchored fixture: unknown attempt ${String(reference)}`);
      return {
        descriptor: {
          attempt: found.attempt as AttemptUri,
          task: `sha256:${"0".repeat(64)}`,
          submission: found.submission as SubmissionUri,
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
    async recover() {
      throw new Error("anchored fixture: recover is not used");
    },
    async deliveries(attempt) {
      const found = byUri.get(attempt as string);
      return found === undefined
        ? []
        : [{ attempt: attempt as AttemptUri, digest: `sha256:${found.deliverySha256}` } as DeliveryRef];
    },
    async fetchDelivery(reference) {
      const bytes = bytesBySha256.get(reference.digest.slice("sha256:".length));
      if (bytes === undefined) throw new Error("anchored fixture: unknown Delivery bytes");
      return bytes;
    },
    async fetchArtifact(descriptor: ResourceDescriptor) {
      const digest = descriptor.digest?.["sha256"];
      const bytes = digest === undefined ? undefined : bytesBySha256.get(digest);
      if (bytes === undefined) throw new Error("anchored fixture: unknown artifact bytes");
      return bytes;
    },
    async drain() {},
  };

  return {
    backend: backend as unknown as LocalVenue["backend"],
    verdictKeyId: "anchored-fixture-verdict-key",
    evaluators: [{ id: LEGACY_VERDICT_EVALUATOR_ID, keyId: "anchored-fixture-verdict-key" }],
    prepareEvaluationCell(input) {
      const derived = deriveEvaluationTask({
        subjectTask: { name: "subject-task.json", digest: `sha256:${sha256Hex(input.subjectTaskBytes)}` },
        subjectDelivery: { name: "subject-delivery.json", digest: `sha256:${sha256Hex(input.subjectDeliveryBytes)}` },
        subjectResults: input.resultArtifacts.map((artifact) => ({
          name: artifact.name,
          digest: `sha256:${sha256Hex(artifact.bytes)}`,
        })),
        evaluationSpecDigest: `sha256:${sha256Hex(input.evaluationSpecBytes)}`,
      });
      const taskSha256 = derived.digest.slice("sha256:".length);
      evaluationByTask.set(taskSha256, sha256Hex(input.evaluationSpecBytes));
      return { taskBytes: derived.bytes, taskSha256 };
    },
    async shutdown() {},
  };
}

// ---------------------------------------------------------------------------
// The injected acquisition sources
// ---------------------------------------------------------------------------

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

interface AnchorSources {
  readonly sources: Readonly<Record<string, AnchorProofSource>>;
  readonly authority: FixtureAuthority;
  otsFixturesFor(subjectSha256: string): OpenTimestampsKitFixtures;
  setGenTimeDer(value: string): void;
  setOtsMode(mode: "pending" | "complete" | "fabricated"): void;
}

function buildAnchorSources(): AnchorSources {
  const authority = createFixtureAuthority("v6-bundle-fixture");
  const otsBySubject = new Map<string, OpenTimestampsKitFixtures>();
  let genTimeDer = V6_FIXTURE_GEN_TIME_DER;
  let otsMode: "pending" | "complete" | "fabricated" = "complete";

  const otsFixturesFor = (subjectSha256: string): OpenTimestampsKitFixtures => {
    const existing = otsBySubject.get(subjectSha256);
    if (existing !== undefined) return existing;
    const built = createOpenTimestampsKitFixtures(hexToBytes(subjectSha256));
    otsBySubject.set(subjectSha256, built);
    return built;
  };

  const rfc3161Source: AnchorProofSource = {
    profile: RFC3161_TSA_ANCHOR_PROFILE,
    async obtainProof(request) {
      return authority.mintTimeStampToken({ subjectSha256: request.subjectSha256, genTime: genTimeDer }).tokenDer;
    },
  };

  const openTimestampsSource: AnchorProofSource & {
    upgradeProof(request: { readonly subjectSha256: string }): Promise<Uint8Array>;
  } = {
    profile: OPENTIMESTAMPS_ANCHOR_PROFILE,
    async obtainProof(request) {
      const fixtures = otsFixturesFor(request.subjectSha256);
      return otsMode === "pending"
        ? fixtures.pendingProof
        : otsMode === "fabricated"
          ? fixtures.fabricatedCompleteProof
          : fixtures.completeProof;
    },
    async upgradeProof(request) {
      return otsFixturesFor(request.subjectSha256).completeProof;
    },
  };

  return {
    sources: {
      [RFC3161_TSA_ANCHOR_PROFILE]: rfc3161Source,
      [OPENTIMESTAMPS_ANCHOR_PROFILE]: openTimestampsSource,
    },
    authority,
    otsFixturesFor,
    setGenTimeDer(value) {
      genTimeDer = value;
    },
    setOtsMode(mode) {
      otsMode = mode;
    },
  };
}

const LOCK_PLANS: ReadonlySet<SyntheticV6AnchorPlan["kind"]> = new Set([
  "rfc3161-lock",
  "opentimestamps-lock-pending",
  "opentimestamps-lock-upgraded",
  "opentimestamps-lock-fabricated",
]);

/**
 * Stores one lock AnchorEvidence record and its RunState entry with no producer operation in the
 * path — the whole point of `bypassProducerGuard` (see the plan type). Everything a real
 * acquisition would have written is written here, by the same helpers `runAnchor` uses: the same
 * minted token, the same record shape and media type, the same digest-addressed sealed store, and
 * the same append-only RunState write. Only the acquisition-time rules are skipped.
 */
function storeLockAnchorDirectly(context: OperationContext, anchors: AnchorSources, genTimeDer: string): void {
  const state = readRunState(context.workspaceDir, DRAFT_ID);
  if (state?.runSha256 === undefined) {
    throw new Error("anchored fixture: lock the run before writing a lock anchor");
  }
  const record: AnchorEvidence = {
    kind: ANCHOR_EVIDENCE_KIND,
    subject: { kind: RUN_RECORD_KIND, digest: { sha256: state.runSha256 } },
    provider: RFC3161_TSA_ANCHOR_PROFILE,
    proof: {
      mediaType: anchorProofMediaType(RFC3161_TSA_ANCHOR_PROFILE),
      content: encodeAnchorProofContent(
        anchors.authority.mintTimeStampToken({ subjectSha256: state.runSha256, genTime: genTimeDer }).tokenDer,
      ),
    },
  };
  const recordSha256 = putSealedBytes(context.workspaceDir, sealAnchorEvidence(record).bytes);
  writeRunState(context.workspaceDir, DRAFT_ID, {
    ...state,
    anchors: [
      ...(state.anchors ?? []),
      { subject: "lock", provider: RFC3161_TSA_ANCHOR_PROFILE, recordSha256 },
    ],
  });
}

async function applyPlan(
  context: OperationContext,
  plan: SyntheticV6AnchorPlan,
  anchors: AnchorSources,
): Promise<void> {
  const subject = LOCK_PLANS.has(plan.kind) ? "lock" as const : "matrix" as const;
  if (plan.kind === "rfc3161-lock" && plan.bypassProducerGuard === true) {
    storeLockAnchorDirectly(context, anchors, plan.genTimeDer ?? V6_FIXTURE_GEN_TIME_DER);
    return;
  }
  if (plan.kind === "rfc3161-lock" || plan.kind === "rfc3161-matrix") {
    anchors.setGenTimeDer(plan.genTimeDer ?? V6_FIXTURE_GEN_TIME_DER);
    requireOk(
      await runAnchor(
        context,
        { draftId: DRAFT_ID, subject, providerProfile: RFC3161_TSA_ANCHOR_PROFILE, endpoint: FIXTURE_ENDPOINT },
        { sources: anchors.sources },
      ),
      `anchor ${plan.kind}`,
    );
    return;
  }
  anchors.setOtsMode(
    plan.kind === "opentimestamps-lock-fabricated"
      ? "fabricated"
      : plan.kind === "opentimestamps-matrix"
        ? "complete"
        : "pending",
  );
  requireOk(
    await runAnchor(
      context,
      { draftId: DRAFT_ID, subject, providerProfile: OPENTIMESTAMPS_ANCHOR_PROFILE, endpoint: FIXTURE_ENDPOINT },
      { sources: anchors.sources },
    ),
    `anchor ${plan.kind}`,
  );
  if (plan.kind !== "opentimestamps-lock-upgraded") return;
  requireOk(
    await runAnchor(
      context,
      { draftId: DRAFT_ID, subject, providerProfile: OPENTIMESTAMPS_ANCHOR_PROFILE, endpoint: FIXTURE_ENDPOINT },
      { sources: anchors.sources },
    ),
    "anchor opentimestamps upgrade",
  );
}

/**
 * Drives the real public run path to a materialized bundle, obtaining `plans` through the real
 * `anchor` operation on the way. With no plans this produces an ordinary unanchored
 * `benchmark-product-public-bundle/2` — which is what makes the anchored/unanchored byte-difference
 * testable against one fixture. The caller owns workspace cleanup.
 */
export async function createSyntheticV6BundleFixture(input: {
  readonly workspaceDir: string;
  readonly plans?: readonly SyntheticV6AnchorPlan[];
  /** §7.3 declared intent, sealed into the Run at lock time. Declaring a profile no plan supplies
   * is how a `declared-but-absent` bundle is produced. */
  readonly declaredProviders?: readonly string[];
}): Promise<SyntheticV6BundleFixture> {
  const context: OperationContext = {
    workspaceDir: input.workspaceDir,
    principal: "synthetic-operator",
    // The real clock, so `closeAt` is always later than the fixture authority's fixed past
    // `genTime` and the splice-catch passes without the fixture pinning both ends.
    clock: () => new Date().toISOString(),
  };
  const anchors = buildAnchorSources();
  const plans = input.plans ?? [];

  requireOk(initWorkspace(context), "workspace init");
  requireOk(createDraft(context, { draftId: DRAFT_ID, name: "Anchored publication fixture" }), "draft create");
  const imported = requireOk(
    importSweBenchRows(context, {
      draftId: DRAFT_ID,
      rows: [fixtureRow(1), fixtureRow(2)],
      name: "Anchored publication fixture",
      description: "Provider-free synthetic evidence for the anchored public bundle",
    }),
    "benchmark import",
  );
  // A benchmark run compares configurations, so the product requires at least two arms.
  requireOk(
    armAdd(context, { draftId: DRAFT_ID, armId: "armA", pinning: { harness: { id: FIXTURE_HARNESS_A, version: "1" } } }),
    "arm armA",
  );
  requireOk(
    armAdd(context, { draftId: DRAFT_ID, armId: "armB", pinning: { harness: { id: FIXTURE_HARNESS_B, version: "1" } } }),
    "arm armB",
  );

  if (input.declaredProviders !== undefined) {
    requireOk(
      updateDraft(context, {
        draftId: DRAFT_ID,
        patch: { anchoring: { declaredProviders: [...input.declaredProviders] } },
      }),
      "draft anchoring intent",
    );
  }

  const venue = fixtureVenue(input.workspaceDir);
  const createVenue = () => venue;
  requireOk(await runQuote(context, { draftId: DRAFT_ID }, { createVenue }), "quote");
  requireOk(runLock(context, { draftId: DRAFT_ID }), "lock");
  for (const plan of plans.filter((entry) => LOCK_PLANS.has(entry.kind))) {
    await applyPlan(context, plan, anchors);
  }
  requireOk(await runLaunch(context, { draftId: DRAFT_ID }, { createVenue }), "launch");
  requireOk(await runCollect(context, { draftId: DRAFT_ID }), "collect");
  for (const plan of plans.filter((entry) => !LOCK_PLANS.has(entry.kind))) {
    await applyPlan(context, plan, anchors);
  }
  requireOk(await runReport(context, { draftId: DRAFT_ID }), "report");

  const runState = readRunState(input.workspaceDir, DRAFT_ID);
  if (runState?.runSha256 === undefined || runState.matrixSha256 === undefined) {
    throw new Error("reported anchored fixture has no sealed Run and Matrix identity");
  }
  const bundle = materializePublicBundle({
    workspaceDir: input.workspaceDir,
    draftId: DRAFT_ID,
    benchmarkSha256: imported.benchmarkSha256,
    runState,
  });
  return {
    workspaceDir: input.workspaceDir,
    draftId: DRAFT_ID,
    benchmarkSha256: imported.benchmarkSha256,
    runState,
    runSha256: runState.runSha256,
    matrixSha256: runState.matrixSha256,
    bundle,
    authority: anchors.authority,
    lockOts: anchors.otsFixturesFor(runState.runSha256),
    matrixOts: anchors.otsFixturesFor(runState.matrixSha256),
  };
}
