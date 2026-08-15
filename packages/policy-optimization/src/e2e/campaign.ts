// SPDX-License-Identifier: MIT

/**
 * The end-to-end campaign (program §1 C9) — one miniature campaign, whole, on the local venue.
 *
 * This module composes; it implements nothing. Every surface it drives is a shipped one:
 * `assembleEvidenceBundle`, `createReferenceProposer`, `admitCandidate`, `quoteWave`, `planWave`,
 * `executeWave`, `assembleWaveMatrix`, `produceWaveReport`, `decideAllocation`, `planPromotionRun`,
 * `deriveArchive`, and the `optimize` CLI's own `runCli`. The two roles it plays are the two the
 * product deliberately does not own — the **evaluator** (verdict envelopes) and the **C8 adapter**
 * (reading a sealed Report's results into allocator rows) — plus the **venue's** fidelity
 * observations, which on a real local backend come from the Runtime Observations the launcher
 * records.
 *
 * What separates this from `campaign-lifecycle.test.ts` (the C7b spine) is scale and reach: a
 * swe-rebench-shaped slate rather than two synthetic tasks, real admission with all eleven checks
 * exercised and four candidates refused for four different real reasons, the reference proposer
 * actually enumerating, a candidate that the shipped learner emitted, the archive derived, and the
 * CLI's adopt/rollback round-trip. The spine proves the wave engine; this proves the product.
 *
 * ## What a run here does NOT prove
 *
 * Restated at the end of every run, from product design §11, because a campaign that prints a
 * recommendation without printing this is the exact self-deception §11 exists to name:
 *
 * - v0 promotion discipline is **discipline**, not proof. On the local venue, pre-registration
 *   ordering carries no guarantee against the run's own owner.
 * - `isolation` "matches" by **vacuity** (substrate §4.3). Three axes are enforced here; the
 *   fourth asserts nothing.
 * - The claims are **operator-local**. Stranger-credible campaigns require anchored-venue
 *   execution, where the promotion Benchmark's anchor must precede the earliest dev-wave cell
 *   anchor and post-reveal third parties re-run the exclusion and lexical scans.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  documentDigest,
  itemTaskDigest,
  serializeCanonicalJson,
  BENCHMARKING_METHOD_IDS,
  BENCHMARKING_METHOD_VERSION,
  type MatrixRecord,
  type ReportRecord,
} from "@jinn-network/benchmarking-records";
import {
  axisObservationsFromRuntimeObservations,
  requirementsDigest,
  runPinningPropertyId,
} from "@jinn-network/benchmarking-local";
import type { AttemptWaitPort } from "@jinn-network/benchmarking-run";
import {
  CANDIDATE_MANIFEST_FORMAT_TOKEN,
  hashTreeLearnerPublicV1,
  sealCandidateManifest,
  tupleDigest,
  type CandidateManifest,
  type TreeEntry,
} from "@jinn-network/policy-identity";
import { createInMemoryBackend, type TestableBackend } from "@jinn-network/task-execution-testing";

import { decideAllocation } from "../allocation.js";
import { admitCandidate } from "../admission/admit.js";
import { candidateAdmittedPayload, candidateRejectedPayload } from "../admission/journal.js";
import { EMPTY_POPULATION, type Population } from "../admission/population.js";
import type { AdmissionRequest, AdmissionResult, MaterializerPort } from "../admission/types.js";
import {
  deriveArchive,
  adopt,
  adoptionConfigFragment,
  archiveLayout,
  currentAdoption,
  defaultArchiveRoot,
  frontier,
  frontierMembers,
  lineageGraph,
  readAdoptionLog,
  writeArchiveProjection,
  PRODUCT_FRONTIER_DIMENSIONS,
  type FrontierEntry,
} from "../archive/index.js";
import { checkBenchmarkDisjointness } from "../benchmark-disjointness.js";
import { runCli } from "../cli/index.js";
import { assembleWaveMatrix, executeWave, quoteWave } from "../execute.js";
import { assembleEvidenceBundle } from "../evidence-bundle/bundle.js";
import { partitionHeldOut } from "../evidence-bundle/held-out.js";
import { createReferenceProposer } from "../proposers/reference.js";
import type { PolicyProposalRequest } from "../proposers/contract.js";
import { createCampaign, type CampaignHandle } from "../journal-store.js";
import { planPromotionRun } from "../promotion.js";
import { CAMPAIGN_FORMAT_TOKEN } from "../tokens.js";
import type { CampaignDocument, JsonValue } from "../types.js";
import { committedCells, planWave } from "../wave.js";
import { produceWaveReport, type DsseSigner } from "../wave-report.js";
import {
  allocationDecidedPayload,
  appendWaveEvent,
  matrixAssembledPayload,
  promotionRunSealedPayload,
  reportRecordedPayload,
  runSealedPayload,
  wavePlannedPayload,
} from "../wave-journal.js";
import type {
  AdmittedCandidate,
  OutcomesProjectionRow,
  WaveCellEvidence,
  WavePlan,
  WaveReportRow,
} from "../wave-types.js";
import {
  AUTHOR,
  CONTAMINATED_TREE,
  DEVELOPMENT_BENCHMARK,
  DEVELOPMENT_INSTANCES,
  EVALUATOR,
  EVIDENCE_RECORDS,
  FROZEN_HARNESS,
  FROZEN_ISOLATION,
  FROZEN_MODEL,
  HELD_OUT_BOUNDARY,
  HOOK_BEARING_TREE,
  LEARNER_PROPOSER,
  OWNER,
  PROMOTION_BENCHMARK,
  PROMOTION_INSTANCES,
  PROMOTION_REVEALED,
  REFERENCE_PROPOSER_AGENT,
  SAVED_QUERY_DIGEST,
  SEED_TREE,
  SNAPSHOT_RECEIPT,
  SOLVER,
  TASK_BYTES,
  tupleForTree,
} from "./fixtures.js";
import { assertBundleProvenanceMatches } from "./learner-fixture.js";

// --- stage reporting ----------------------------------------------------------------------------

export interface StageFact {
  readonly label: string;
  readonly value: string;
}

export interface Stage {
  readonly number: number;
  readonly title: string;
  /** One sentence: what just happened, in the product's own vocabulary. */
  readonly detail: string;
  readonly facts: readonly StageFact[];
}

export type StageReporter = (stage: Stage) => void;

/** The honesty residuals every run restates (product §11). Printed, not implied. */
export const HONESTY_RESIDUALS: readonly string[] = [
  "This campaign ran on the LOCAL venue. Its recommendation is operator-local: it protects an "
  + "honest owner from self-deception and proves nothing to a stranger.",
  "v0 promotion discipline is discipline, not mechanism. The owner holds the committed gate's "
  + "bytes, so pre-registration ordering carries no guarantee against the run's own owner "
  + "(§11, §6.3's owner-equals-proposer residual).",
  "Three axes were verified per cell (harness, model, loadout). `isolation` reports `match` by "
  + "VACUITY (substrate §4.3) — it asserts nothing, and the weakest-axis rule applies.",
  "The slates are hand-authored miniatures at swe-rebench SHAPE. They are not swe-rebench "
  + "instances and the pass/fail verdicts are fixture verdicts, not measured ones.",
  "Stranger-credible campaigns require anchored-venue execution: the promotion Benchmark's "
  + "anchor must precede the earliest dev-wave cell anchor, and post-reveal third parties must "
  + "re-run the held-out exclusion and the lexical scan themselves.",
];

// --- the campaign document ----------------------------------------------------------------------

const OBJECTIVE_METHOD = {
  id: BENCHMARKING_METHOD_IDS.avgAtK,
  version: BENCHMARKING_METHOD_VERSION,
  parameters: { verdictRule: "sole" } as Readonly<Record<string, JsonValue>>,
};

export function campaignDocument(input: {
  readonly developmentBenchmark: string;
  readonly promotionBenchmark: string;
  readonly seedTupleDigest: string;
}): CampaignDocument {
  return {
    formatToken: CAMPAIGN_FORMAT_TOKEN,
    target: {
      taskProfile: "https://profiles.jinn.network/repository-work/1.0",
      developmentBenchmark: input.developmentBenchmark,
      promotionBenchmark: input.promotionBenchmark,
      trainingEvidence: { savedQueryDigest: SAVED_QUERY_DIGEST },
    },
    seeds: [{ kind: "tuple", digest: input.seedTupleDigest }],
    // v0: harness and model frozen per campaign; isolation excluded as vacuous (§5.1).
    mutationSurface: ["loadout"],
    frozenAxes: {
      harness: FROZEN_HARNESS,
      model: FROZEN_MODEL,
      isolationPolicy: FROZEN_ISOLATION,
    },
    objective: { methods: [OBJECTIVE_METHOD], constraints: [] },
    budgets: {
      proposal: { maxProposals: 3 },
      evaluation: { maxCells: 40 },
      hardCap: { maxCells: 60 },
    },
    allocation: {
      policyRef: "drop-bottom-k/1.0",
      parameters: { k: 1, minCandidates: 2 },
    },
    stoppingRule: { ruleRef: "max-waves/1.0", parameters: { maxWaves: 4 } },
  } as CampaignDocument;
}

// --- the evaluator's role: sealed result-evaluation Statements in DSSE envelopes -----------------

const CLOCK = { now: () => new Date("2026-08-04T09:00:00Z") };
const EVAL_SPEC_DIGEST = `sha256:${"2".repeat(64)}`;

function evaluationSpec(): NonNullable<WaveCellEvidence["evaluationSpec"]> {
  return {
    protocol: "https://spec.jinn.network/profiles/evaluation-spec/v1",
    family: "deterministic-process",
    semanticsVersion: "4",
    measurements: [{ name: "passed", type: "boolean", required: true }],
    verdictRule: { threshold: { measurement: "passed", op: "eq", value: true } },
    unscorable: [],
    evidenceConventions: { requiredRefs: [] },
    familyBlock: {
      image: { uri: "https://example.org/img", digest: { sha256: "c".repeat(64) } },
      platform: "linux/amd64",
      timeout: 60,
      workspace: {},
      transitions: { failToPass: [], passToPass: [] },
      testMaterial: [],
      parser: { id: "jinn.parser.x", version: "1.0.0", digest: `sha256:${"d".repeat(64)}` },
    },
    grader: { name: "jinn.parser.x", digest: { sha256: "d".repeat(64) }, accessClass: "public" },
  } as NonNullable<WaveCellEvidence["evaluationSpec"]>;
}

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

const VERDICT_BYTES = new Map<string, Uint8Array>();
const RUN_BYTES = new Map<string, Uint8Array>();

function verdictFor(cellKey: string, outcome: "pass" | "fail") {
  const payload = serializeCanonicalJson({
    _type: "https://in-toto.io/Statement/v1",
    subject: [{
      name: `cell/${cellKey}`,
      digest: { sha256: documentDigest(new TextEncoder().encode(cellKey)).slice("sha256:".length) },
    }],
    predicateType: "https://spec.jinn.network/attestations/result-evaluation/v1",
    predicate: {
      evaluatedAt: "2026-08-04T09:30:00Z",
      evaluator: { id: EVALUATOR },
      taskSubject: "execution/task/task.json",
      resultSubjects: ["execution/result/result.json"],
      verdict: outcome,
    },
  } as JsonValue);
  const bytes = serializeCanonicalJson({
    payloadType: "application/vnd.in-toto+json",
    payload: base64(payload),
    signatures: [{ keyid: "did:key:zC9VerdictFixture", sig: base64(Uint8Array.of(1)) }],
  } as JsonValue);
  const digest = documentDigest(bytes);
  VERDICT_BYTES.set(digest, bytes);
  return {
    digest,
    record: {
      evaluationSpecification: EVAL_SPEC_DIGEST,
      evaluator: EVALUATOR,
      verdict: outcome,
    },
    measurements: { passed: outcome === "pass" },
    evaluationSpec: evaluationSpec(),
  };
}

// --- the venue's role ---------------------------------------------------------------------------

function backend(): TestableBackend {
  return createInMemoryBackend({
    now: CLOCK.now,
    runPinning: [
      { key: "harness", inventory: ["*"], posture: "enforced" },
      { key: "model", inventory: ["*"], posture: "enforced" },
      { key: "loadout", inventory: ["*"], posture: "enforced" },
      { key: "isolationPolicy", inventory: ["*"], posture: "enforced" },
    ],
  });
}

function deliveringWaitPort(instance: TestableBackend): AttemptWaitPort {
  return {
    async waitUntilTerminal({ attempt }) {
      const snapshot = await instance.observe(attempt as never);
      if (snapshot.descriptor.derived.terminal) return snapshot;
      const engaged = snapshot.observations.find(
        (observation) => observation.type === "network.jinn.task-execution.attempt-engaged.v1",
      )!;
      await instance.drive(attempt as never, [{
        specversion: "1.0",
        id: `terminal-${attempt}`,
        source: engaged.source,
        subject: attempt,
        time: CLOCK.now().toISOString(),
        datacontenttype: "application/json",
        sequence: "0000000000000100",
        type: "network.jinn.task-execution.attempt-terminal.v1",
        data: { state: "delivered" },
      }]);
      return instance.observe(attempt as never);
    },
  };
}

/**
 * What the launcher observed about the tuple the cell actually ran under. On a real local backend
 * these are Runtime Observations; here they are constructed from the arm's own tuple, except for
 * the one cell that is deliberately handed the *seed's* tuple instead — the swap that must surface
 * as `loadout: "mismatch"` and invalidate the cell.
 */
function fidelityObservations(tuple: Record<string, unknown>) {
  return axisObservationsFromRuntimeObservations(
    (["harness", "model", "loadout"] as const).map((axis) => ({
      kind: "resource",
      propertyId: runPinningPropertyId(axis),
      value: observationValue(tuple[axis]),
    })),
  );
}

/**
 * A Runtime Observation carries `string | number | boolean`, so an object-shaped axis value
 * travels as its JSON text and a scalar one travels literally.
 *
 * The literal case is load-bearing, not stylistic: the bridge's `decodeValue` only re-parses text
 * that begins `{` or `[`, so a scalar sent through `JSON.stringify` arrives as a string *with its
 * quote characters in it* and contradicts the pin. That is what a producer emitting the bare
 * string avoids, and what this reproduces. See FINDING F-C9-4.
 */
function observationValue(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

const VENUE = {
  isolationInventory: [FROZEN_ISOLATION],
  admissionReceiptFor: () => ({ zeroReplayVariance: true, externalCapabilities: false }),
  trust: {
    async resolveAgent(evidence: unknown) {
      return (evidence as { role?: string }).role === "evaluator" ? EVALUATOR : SOLVER;
    },
  },
};

const fixtureSigner: DsseSigner = async (input) => {
  const digest = new TextEncoder().encode(documentDigest(input.preAuthEncoding));
  return [{ keyid: "did:key:zC9ReportFixture", signature: digest }];
};

function reportPorts() {
  return {
    resolveVerdictBytes: (digest: string) => VERDICT_BYTES.get(digest),
    resolveRunBytes: (digest: string) => RUN_BYTES.get(digest),
    resolveTaskBytes: (digest: string) => TASK_BYTES.get(digest.replace(/^sha256:/, "")),
  };
}

// --- participants -------------------------------------------------------------------------------

/** One member of the population, with the label this run narrates it under. */
export interface Participant {
  readonly label: string;
  readonly proposer: string;
  readonly candidate: AdmittedCandidate;
  readonly manifestDigest: string;
  readonly tree: readonly TreeEntry[];
  /** Development-wave pass count out of the four development instances. */
  readonly devPasses: number;
  /** Promotion pass count out of the three held-out instances. */
  readonly gatePasses: number;
}

/**
 * The C6 candidate this campaign admits: the sealed manifest bytes and the materialized tree the
 * shipped learner emitted, as committed fixtures.
 *
 * See FINDING F-C9-1 — `client/` cannot import this package (release-group `transitional-or-private`
 * is outside `legacy-product-lines`' allowed set) and this package's source boundary denies
 * `@jinn-network/client` by name, so the seam between the two is the sealed bytes and nothing else.
 * The client-side integration test emits these and asserts byte-equality with the committed copies;
 * this side admits them through the unmodified gate.
 */
export interface LearnerCandidateFixture {
  readonly manifestBytes: Uint8Array;
  readonly tree: readonly TreeEntry[];
}

// --- the run ------------------------------------------------------------------------------------

export interface RejectionOutcome {
  readonly label: string;
  readonly reason: string;
  readonly failedCheck: string;
  readonly checks: number;
}

export interface E2ECampaignResult {
  readonly directory: string;
  readonly handle: CampaignHandle;
  readonly campaign: CampaignDocument;
  readonly participants: readonly Participant[];
  readonly seed: Participant;
  readonly learner: Participant | undefined;
  readonly rejections: readonly RejectionOutcome[];
  /** Every admission check name that reported `pass` at least once across the accepted candidates. */
  readonly checksPassed: readonly string[];
  readonly devPlan: WavePlan;
  readonly devMatrix: MatrixRecord;
  readonly devQuote: { readonly cells: number; readonly requiredKeys: readonly string[] };
  readonly devReport: { readonly digest: string; readonly record: ReportRecord };
  readonly devPreregistered: boolean;
  readonly promotionPlan: WavePlan;
  readonly promotionMatrix: MatrixRecord;
  readonly promotionReport: { readonly digest: string; readonly record: ReportRecord };
  readonly promotionPreregistered: boolean;
  readonly swappedCellKey: string;
  readonly pruned: readonly string[];
  readonly recommendation: { readonly tupleDigest: string; readonly value: string };
  readonly frontier: readonly string[];
  readonly lineageNodes: number;
  readonly adoption: {
    readonly baselineFragment: string;
    readonly adoptedTuple: string;
    readonly afterRollbackTuple: string;
    readonly afterRollbackFragment: string;
    readonly byteIdentical: boolean;
    readonly cliStdout: readonly string[];
  };
  readonly stages: readonly Stage[];
}

export interface RunE2ECampaignOptions {
  /** Campaign directory. Created if absent; must be empty or a prior run of this same campaign. */
  readonly directory: string;
  readonly report?: StageReporter;
  /** The C6-emitted candidate. Absent → the campaign runs with the reference proposer only. */
  readonly learnerCandidate?: LearnerCandidateFixture;
}

export async function runE2ECampaign(
  options: RunE2ECampaignOptions,
): Promise<E2ECampaignResult> {
  const stages: Stage[] = [];
  const emit = (title: string, detail: string, facts: readonly StageFact[] = []): void => {
    const stage: Stage = { number: stages.length + 1, title, detail, facts };
    stages.push(stage);
    options.report?.(stage);
  };

  // === 1. the slates ============================================================================
  const disjointness = checkBenchmarkDisjointness(
    {
      developmentBenchmark: DEVELOPMENT_BENCHMARK.digest,
      promotionBenchmark: PROMOTION_BENCHMARK.digest,
    },
    { development: DEVELOPMENT_BENCHMARK.bytes, promotion: PROMOTION_BENCHMARK.bytes },
  );
  if (!disjointness.ok) {
    throw new Error(`the two slates are not item-disjoint: ${disjointness.detail}`);
  }
  emit(
    "Slates sealed",
    "A development Benchmark and a committed promotion Benchmark, checked item-disjoint before "
    + "either is used (§5.1, C7b review M4).",
    [
      { label: "development", value: `${DEVELOPMENT_BENCHMARK.digest} — ${DEVELOPMENT_INSTANCES.length} instances, revealed` },
      { label: "promotion", value: `${PROMOTION_BENCHMARK.digest} — ${PROMOTION_INSTANCES.length} instances, COMMITTED` },
      { label: "item-disjoint", value: "yes — no instance appears on both slates" },
    ],
  );

  // === 2. the seed policy and the campaign document ==============================================
  const seedTuple = tupleForTree(SEED_TREE);
  const seedTupleDigest = tupleDigest(seedTuple);
  const campaign = campaignDocument({
    developmentBenchmark: DEVELOPMENT_BENCHMARK.digest,
    promotionBenchmark: PROMOTION_BENCHMARK.digest,
    seedTupleDigest,
  });

  let handle = createCampaign({
    directory: options.directory,
    campaign,
    seedResolutions: [{ kind: "tuple", digest: seedTupleDigest, tuple: seedTuple }],
    benchmarks: { development: DEVELOPMENT_BENCHMARK.bytes, promotion: PROMOTION_BENCHMARK.bytes },
    createdAt: "2026-08-04T08:00:00Z",
  });
  emit(
    "Campaign sealed — DRAFT",
    "The campaign document fixes what is optimized, what counts as better, and the budget. It "
    + "never fixes how candidates are made (§5.1).",
    [
      { label: "campaign", value: handle.digest },
      { label: "mutation surface", value: campaign.mutationSurface.join(", ") },
      { label: "frozen axes", value: Object.keys(campaign.frozenAxes).sort().join(", ") },
      { label: "objective", value: `${OBJECTIVE_METHOD.id}@${OBJECTIVE_METHOD.version}` },
      { label: "journal", value: `${options.directory}/journal.jsonl` },
    ],
  );

  // === 3. the evidence bundle ====================================================================
  const partition = partitionHeldOut(EVIDENCE_RECORDS, HELD_OUT_BOUNDARY);
  // R5: assembly REFUSES the unfiltered list. A filter the caller may skip is a passthrough.
  let refusedUnfiltered = false;
  try {
    assembleEvidenceBundle({
      savedQueryDigest: SAVED_QUERY_DIGEST,
      snapshotReceipt: SNAPSHOT_RECEIPT,
      records: EVIDENCE_RECORDS,
      boundary: HELD_OUT_BOUNDARY,
    });
  } catch {
    refusedUnfiltered = true;
  }
  if (!refusedUnfiltered) {
    throw new Error("assembleEvidenceBundle accepted a contaminated record list (ruling R5)");
  }
  const bundle = assembleEvidenceBundle({
    savedQueryDigest: SAVED_QUERY_DIGEST,
    snapshotReceipt: SNAPSHOT_RECEIPT,
    records: partition.kept,
    boundary: HELD_OUT_BOUNDARY,
  });
  // The learner candidate was sealed against this bundle's provenance. Drift here would otherwise
  // surface four stages later as an admission refusal that reads like a product defect.
  if (options.learnerCandidate) {
    assertBundleProvenanceMatches(bundle.provenance as unknown as Record<string, unknown>);
  }
  emit(
    "Evidence bundle assembled — held-out excluded",
    "The proposer's input is frozen and exclusion-filtered on instance, repo, and "
    + "`unattributable`. Assembly refuses a contaminated list rather than quietly dropping rows "
    + "(ruling R5).",
    [
      { label: "supplied", value: `${EVIDENCE_RECORDS.length} records` },
      { label: "kept", value: `${partition.kept.length} records` },
      {
        label: "excluded",
        value: partition.excluded.map((hit) => `${hit.axis}:${hit.value}`).join(", "),
      },
      { label: "bundle", value: bundle.digest },
      { label: "boundary", value: bundle.bundle.heldOutBoundary.digest },
    ],
  );

  // === 4. the reference proposer =================================================================
  const proposalRequest: PolicyProposalRequest = {
    parents: [{ kind: "tuple", digest: seedTupleDigest }],
    evidence: { digest: bundle.digest, provenance: bundle.provenance },
    objective: campaign.objective,
    mutationSurface: campaign.mutationSurface,
    budget: { maxProposals: campaign.budgets.proposal.maxProposals },
  };
  const reference = createReferenceProposer({
    parentTree: SEED_TREE,
    parentTuple: seedTuple,
    proposerAgentIri: REFERENCE_PROPOSER_AGENT,
  });
  const proposals = reference.enumerate(proposalRequest);
  if (proposals.length < 2) {
    throw new Error(`the reference proposer produced ${proposals.length} candidates; expected 2+`);
  }
  emit(
    "Reference proposer enumerated",
    "Deterministic skill ablation over the parent loadout. No model call, no network, no clock. "
    + "It is the architectural falsifier, not a baseline anyone should beat (§7.2).",
    [
      { label: "proposer", value: reference.id },
      { label: "candidates", value: String(proposals.length) },
      ...proposals.map((proposal, index) => ({
        label: `candidate ${index + 1}`,
        value: `ablates ${proposal.removed.join(" + ")} — tuple ${proposal.tupleDigest}`,
      })),
    ],
  );

  // === 5. admission ==============================================================================
  const packages = new Map<string, readonly TreeEntry[]>();
  const registerPackage = (tree: readonly TreeEntry[]): void => {
    packages.set(`sha256:${hashTreeLearnerPublicV1(tree)}`, tree);
  };
  registerPackage(SEED_TREE);
  for (const proposal of proposals) registerPackage(proposal.tree);
  registerPackage(CONTAMINATED_TREE);
  registerPackage(HOOK_BEARING_TREE);
  if (options.learnerCandidate) registerPackage(options.learnerCandidate.tree);

  const materializer: MaterializerPort = {
    materialize: ({ loadout }) => {
      const entries = packages.get(String((loadout as Record<string, unknown>)["digest"]));
      if (entries === undefined) throw new Error("no package is published for this loadout pin");
      return entries;
    },
  };

  let population: Population = EMPTY_POPULATION;
  const admissionRequest = (
    manifestBytes: Uint8Array,
    overrides: Partial<AdmissionRequest> = {},
  ): AdmissionRequest => ({
    campaign,
    manifestBytes,
    issuedBundles: [bundle.bundle],
    boundary: HELD_OUT_BOUNDARY,
    population,
    materializer,
    // Every optional port is supplied, so all eleven checks run for real rather than reporting
    // `skipped`. `crossOperator` is the owner's declaration that these proposals came from a party
    // other than the campaign owner, which is what puts checks 2 and 9 in play.
    consent: {
      crossOperator: true,
      approvedPayloadClasses: ["prompt", "skill"],
    },
    signature: {
      verify: ({ manifestDigest }) => ({
        verified: true,
        detail: `fixture signature over ${manifestDigest}`,
      }),
    },
    smokeCanary: {
      run: ({ tupleDigest: digest }) => ({
        completed: true,
        detail: `canary completed for ${digest}; asserts usable, never better`,
      }),
    },
    // Ruling R2's additive per-file check: every path whose bytes differ from the parent tree
    // must sit under a declared prefix.
    mutablePaths: { parentTree: SEED_TREE, prefixes: ["skills/"] },
    ...overrides,
  });

  const checksPassed = new Set<string>();
  const accepted: {
    label: string;
    proposer: string;
    result: Extract<AdmissionResult, { ok: true }>;
    tree: readonly TreeEntry[];
  }[] = [];

  const admitOne = async (
    label: string,
    proposer: string,
    manifestBytes: Uint8Array,
    tree: readonly TreeEntry[],
  ): Promise<void> => {
    const result = await admitCandidate(admissionRequest(manifestBytes));
    if (!result.ok) {
      throw new Error(
        `${label} was refused (${result.reason}): ${result.errors.map((e) => e.message).join("; ")}`,
      );
    }
    for (const check of result.checks) if (check.status === "pass") checksPassed.add(check.name);
    population = result.population;
    accepted.push({ label, proposer, result, tree });
    handle = appendWaveEvent(handle, {
      type: "candidate-admitted",
      recordedAt: "2026-08-04T08:20:00Z",
      payload: candidateAdmittedPayload(result, proposer),
    });
  };

  // The seed enters the population as an arm like any other: it is the policy every candidate is
  // being compared against, and a comparison needs it measured under the same Run.
  const seedManifest: CandidateManifest = sealedManifest({
    tree: SEED_TREE,
    tuple: seedTuple,
    parents: [{ kind: "tuple", digest: seedTupleDigest }],
    proposer: REFERENCE_PROPOSER_AGENT,
    provenance: bundle.provenance,
    summary: "The seed policy, entered as the comparison arm.",
    touched: [],
  });
  const seedSealed = sealCandidateManifest(seedManifest);
  await admitOne("seed", REFERENCE_PROPOSER_AGENT, seedSealed.bytes, SEED_TREE);

  for (const proposal of proposals) {
    await admitOne(
      `ablate ${proposal.removed.join("+")}`,
      reference.id,
      proposal.sealed.bytes,
      proposal.tree,
    );
  }

  if (options.learnerCandidate) {
    await admitOne(
      "learner",
      LEARNER_PROPOSER,
      options.learnerCandidate.manifestBytes,
      options.learnerCandidate.tree,
    );
  }

  // --- the gate has to bite, or it is decoration ---
  const rejections: RejectionOutcome[] = [];
  const rejectOne = async (
    label: string,
    manifestBytes: Uint8Array,
    overrides: Partial<AdmissionRequest> = {},
  ): Promise<void> => {
    const result = await admitCandidate(admissionRequest(manifestBytes, overrides));
    if (result.ok) throw new Error(`${label} was admitted; the gate did not bite`);
    const failed = result.checks.find((check) => check.status === "fail");
    rejections.push({
      label,
      reason: result.reason,
      failedCheck: failed?.name ?? "unknown",
      checks: result.checks.length,
    });
    handle = appendWaveEvent(handle, {
      type: "candidate-rejected",
      recordedAt: "2026-08-04T08:25:00Z",
      payload: candidateRejectedPayload(result, "did:jinn:hostile", documentDigest(manifestBytes)),
    });
  };

  // 1. A body naming a held-out repository — caught by the lexical scan, after materialization.
  await rejectOne(
    "names a held-out repository",
    sealCandidateManifest(sealedManifest({
      tree: CONTAMINATED_TREE,
      tuple: tupleForTree(CONTAMINATED_TREE),
      parents: [{ kind: "tuple", digest: seedTupleDigest }],
      proposer: "did:jinn:hostile",
      provenance: bundle.provenance,
      summary: "Adds a scheduler shortcut skill.",
      touched: ["skills/scheduler-shortcut"],
    })).bytes,
  );

  // 2. An executable hook from a cross-operator proposer the owner never approved for that class.
  await rejectOne(
    "carries an unapproved executable hook",
    sealCandidateManifest(sealedManifest({
      tree: HOOK_BEARING_TREE,
      tuple: tupleForTree(HOOK_BEARING_TREE),
      parents: [{ kind: "tuple", digest: seedTupleDigest }],
      proposer: "did:jinn:hostile",
      provenance: bundle.provenance,
      summary: "Adds a post-solve hook.",
      touched: ["hooks/post-solve.sh"],
    })).bytes,
    { mutablePaths: { parentTree: SEED_TREE, prefixes: ["skills/", "hooks/"] } },
  );

  // 3. A tuple that quietly changes a frozen axis — the confound a Run could never see.
  // A well-formed exact pin on a *different* model, so the refusal is unambiguously "you changed
  // a frozen axis" rather than "your pin was malformed".
  const driftedTuple = {
    ...tupleForTree(proposals[0]!.tree),
    model: { id: "anthropic/some-other-model" },
  };
  await rejectOne(
    "silently changes the frozen model axis",
    sealCandidateManifest(sealedManifest({
      tree: proposals[0]!.tree,
      tuple: driftedTuple as typeof seedTuple,
      parents: [{ kind: "tuple", digest: seedTupleDigest }],
      proposer: "did:jinn:hostile",
      provenance: bundle.provenance,
      summary: "Ablates a skill and swaps the model.",
      touched: ["skills"],
    })).bytes,
  );

  // 4. Provenance naming a bundle this campaign never issued.
  await rejectOne(
    "names an evidence bundle the campaign never issued",
    sealCandidateManifest(sealedManifest({
      tree: proposals[1]!.tree,
      tuple: tupleForTree(proposals[1]!.tree),
      parents: [{ kind: "tuple", digest: seedTupleDigest }],
      proposer: "did:jinn:hostile",
      provenance: {
        ...bundle.provenance,
        recordListDigest: `sha256:${"0".repeat(64)}`,
      },
      summary: "Ablates a skill against unfrozen evidence.",
      touched: ["skills"],
    })).bytes,
  );

  emit(
    "Admission — the gate ran, and it bit",
    "Eleven checks per candidate, every one reported whatever the outcome. Admission asserts "
    + "usable, never better (§7.3).",
    [
      { label: "admitted", value: accepted.map((entry) => entry.label).join(", ") },
      { label: "checks passing", value: [...checksPassed].sort().join(", ") },
      ...rejections.map((rejection) => ({
        label: `refused: ${rejection.label}`,
        value: `${rejection.reason} at check '${rejection.failedCheck}' (${rejection.checks} checks reported)`,
      })),
      { label: "population", value: `${population.entries.length} arms, keyed by tupleDigest` },
    ],
  );

  // --- the labelled population -------------------------------------------------------------------
  // A pass profile per arm, so the allocator and the gate have something to separate. These are
  // FIXTURE verdicts: the campaign machinery is under test, not the policies.
  const devProfile: Readonly<Record<string, number>> = {
    seed: 2,
    learner: 4,
    [accepted[1]!.label]: 1,
    [accepted[2]!.label]: 2,
    [accepted[3]!.label]: 3,
  };
  const gateProfile: Readonly<Record<string, number>> = {
    seed: 1,
    learner: 3,
    [accepted[1]!.label]: 0,
    [accepted[2]!.label]: 1,
    [accepted[3]!.label]: 2,
  };

  const participants: Participant[] = accepted.map((entry) => ({
    label: entry.label,
    proposer: entry.proposer,
    candidate: entry.result.candidate,
    manifestDigest: entry.result.manifestDigest,
    tree: entry.tree,
    devPasses: devProfile[entry.label] ?? 0,
    gatePasses: gateProfile[entry.label] ?? 0,
  }));
  const byArm = new Map(participants.map((entry) => [entry.candidate.armId, entry] as const));
  const seed = participants.find((entry) => entry.label === "seed")!;
  const learner = participants.find((entry) => entry.label === "learner");

  // === 6. the development wave ===================================================================
  const devTaskDigests = DEVELOPMENT_BENCHMARK.record.items.map(itemTaskDigest);
  const firstAllocation = decideAllocation({
    campaign,
    waveNumber: 1,
    population: participants.map((entry) => entry.candidate),
    taskDigests: devTaskDigests,
  });
  const devPlan = planWave({
    campaign,
    campaignDigest: handle.digest,
    waveNumber: 1,
    candidates: participants.map((entry) => entry.candidate),
    allocation: firstAllocation,
    developmentBenchmarkBytes: DEVELOPMENT_BENCHMARK.bytes,
    settings: runSettings(),
    committed: committedCells(handle.entries),
  });
  RUN_BYTES.set(devPlan.run.digest, devPlan.run.bytes);

  handle = appendWaveEvent(handle, {
    type: "wave-planned",
    recordedAt: "2026-08-04T09:00:00Z",
    payload: wavePlannedPayload(devPlan),
  }, {
    // The DRAFT -> EXPLORING transition is legal only against a committed, unrevealed gate (§6.3).
    exploringEntry: {
      benchmarkBytes: PROMOTION_BENCHMARK.bytes,
      developmentBenchmarkBytes: DEVELOPMENT_BENCHMARK.bytes,
      revealContext: { kind: "after-run", trustedRunNotClosed: true },
    },
  });
  handle = appendWaveEvent(handle, {
    type: "run-sealed",
    recordedAt: "2026-08-04T09:00:01Z",
    payload: runSealedPayload(devPlan),
  });

  const devBackend = backend();
  const devQuote = await quoteWave(devPlan, devBackend);
  const swappedCellKey = `${devTaskDigests[2]}/${participants[2]!.candidate.armId}/1`;

  const devExecution = await executeWave({
    plan: devPlan,
    backend: devBackend,
    taskBytesFor: (digest) => TASK_BYTES.get(digest)!,
    launch: { clock: CLOCK, waitForTerminal: deliveringWaitPort(devBackend) },
  });
  const devMatrix = await assembleWaveMatrix({
    plan: devPlan,
    execution: devExecution,
    evidence: {
      evidenceFor(cellKey: string): WaveCellEvidence {
        const [taskDigest, armId] = cellKey.split("/");
        const participant = byArm.get(armId!)!;
        const plannedArm = devPlan.arms.find((arm) => arm.armId === armId)!;
        const taskIndex = devTaskDigests.indexOf(taskDigest!);
        const swapped = cellKey === swappedCellKey;
        return {
          deliveryDigest: documentDigest(new TextEncoder().encode(`delivery/${cellKey}`)),
          evaluationSpecDigest: EVAL_SPEC_DIGEST,
          evaluationSpec: evaluationSpec(),
          verdicts: [verdictFor(cellKey, taskIndex < participant.devPasses ? "pass" : "fail")],
          pinning: {
            dispatches: 1,
            admission: {
              ready: true,
              checkedRequirementsDigest: requirementsDigest(plannedArm.pinning),
            },
            // The swapped cell reports the SEED's loadout, whatever arm it belonged to.
            observations: fidelityObservations(
              (swapped ? seed.candidate.tuple : participant.candidate.tuple) as unknown as Record<string, unknown>,
            ),
          },
          cost: { value: "0.25", unit: "USD" },
          latencyMs: 4200,
        };
      },
    },
    venue: VENUE,
  });
  handle = appendWaveEvent(handle, {
    type: "matrix-assembled",
    recordedAt: "2026-08-04T10:00:00Z",
    payload: matrixAssembledPayload(devPlan, devMatrix),
  });

  const devReportProduced = await produceWaveReport({
    campaign,
    method: OBJECTIVE_METHOD,
    subjects: [devMatrix.bytes],
    verdictRule: "sole",
    author: AUTHOR,
    resolve: reportPorts(),
  }, fixtureSigner);
  const devReport = {
    digest: documentDigest(devReportProduced.bytes),
    record: devReportProduced.record,
  };
  handle = appendWaveEvent(handle, {
    type: "report-recorded",
    recordedAt: "2026-08-04T10:05:00Z",
    payload: reportRecordedPayload(devPlan, devReport),
  });

  const swapped = devMatrix.record.cells.find((cell) => cell.cellKey === swappedCellKey);
  emit(
    "Development wave — quoted, dispatched, assembled, reported",
    "One preregistered-free exploratory Run. Per-axis verification comes from the local pinning "
    + "bridge, cell by honest cell (§6.1, §11 item 2).",
    [
      { label: "quote", value: `${devQuote.cells} cells; venue requires ${devQuote.requiredKeys.join(", ")}` },
      { label: "arms", value: `${devPlan.arms.length} (${participants.map((p) => p.label).join(", ")})` },
      { label: "run", value: devPlan.run.digest },
      { label: "matrix", value: `${devMatrix.digest} — ${devMatrix.record.cells.length} cells, ${devMatrix.record.completeness.runOutcome}` },
      {
        label: "swapped cell",
        value: `${swappedCellKey} -> loadout=${swapped?.verification.loadout}, outcome=${swapped?.outcome}`,
      },
      { label: "report", value: `${devReport.digest} (preregistered=${devReportProduced.record.preregistered ?? false})` },
    ],
  );

  // === 7. the allocation decision the wave paid for ==============================================
  const reportRows = (plan: WavePlan, report: { digest: string; record: ReportRecord }): readonly WaveReportRow[] => {
    const perSubject = (report.record.results as {
      perSubject: { results: { arms: Record<string, { mean: string }> } }[];
    }).perSubject;
    const arms = perSubject[0]!.results.arms;
    return plan.arms.map((arm) => ({
      reportDigest: report.digest,
      waveNumber: plan.waveNumber,
      tupleDigest: arm.tupleDigest,
      method: { id: OBJECTIVE_METHOD.id, version: OBJECTIVE_METHOD.version },
      value: arms[arm.armId]!.mean,
    }));
  };
  const devRows = reportRows(devPlan, devReport);
  const outcomes: readonly OutcomesProjectionRow[] = participants.map((entry) => ({
    inputRefs: [`sha256:${entry.candidate.tupleDigest.slice(-64)}`],
    tupleDigest: entry.candidate.tupleDigest,
    bucket: "organic" as const,
    passRate: { num: entry.devPasses, den: DEVELOPMENT_INSTANCES.length },
  }));

  const secondAllocation = decideAllocation({
    campaign,
    waveNumber: 2,
    population: participants.map((entry) => entry.candidate),
    taskDigests: devTaskDigests,
    reports: devRows,
    outcomes,
  });
  handle = appendWaveEvent(handle, {
    type: "allocation-decided",
    recordedAt: "2026-08-04T10:10:00Z",
    payload: allocationDecidedPayload(secondAllocation),
  });
  const prunedLabels = secondAllocation.pruned.map(
    (entry) => participants.find((p) => p.candidate.tupleDigest === entry.tupleDigest)?.label ?? entry.tupleDigest,
  );
  emit(
    "Allocation decided — and journaled with what it read",
    "Pruning is legal at dev waves and illegal at promotion. Every decision is journaled with the "
    + "rows and Reports it consumed, so survivorship stays post-hoc auditable (§6.2).",
    [
      { label: "policy", value: secondAllocation.policyRef },
      { label: "retained", value: String(secondAllocation.retained.length) },
      { label: "pruned", value: prunedLabels.join(", ") || "none" },
      { label: "inputs", value: `${devRows.length} report rows, ${outcomes.length} organic outcome rows` },
    ],
  );

  // === 8. CONFIRMING: the single promotion Run ===================================================
  const survivors = participants.filter(
    (entry) => secondAllocation.retained.includes(entry.candidate.tupleDigest),
  );
  const { plan: promotionPlan, admission } = planPromotionRun({
    campaign,
    campaignDigest: handle.digest,
    phase: handle.state.phase,
    candidates: survivors.map((entry) => entry.candidate),
    reveal: { benchmarkBytes: PROMOTION_BENCHMARK.bytes, revealed: PROMOTION_REVEALED },
    settings: runSettings(),
    committed: committedCells(handle.entries),
    waveNumber: 2,
  });
  RUN_BYTES.set(promotionPlan.run.digest, promotionPlan.run.bytes);
  handle = appendWaveEvent(handle, {
    type: "promotion-run-sealed",
    recordedAt: "2026-08-04T11:00:00Z",
    payload: promotionRunSealedPayload(promotionPlan, admission),
  });

  const gateTaskDigests = PROMOTION_BENCHMARK.record.items.map(itemTaskDigest);
  const gateBackend = backend();
  const promotionExecution = await executeWave({
    plan: promotionPlan,
    backend: gateBackend,
    taskBytesFor: (digest) => TASK_BYTES.get(digest)!,
    launch: { clock: CLOCK, waitForTerminal: deliveringWaitPort(gateBackend) },
  });
  const promotionMatrix = await assembleWaveMatrix({
    plan: promotionPlan,
    execution: promotionExecution,
    evidence: {
      evidenceFor(cellKey: string): WaveCellEvidence {
        const [taskDigest, armId] = cellKey.split("/");
        const participant = byArm.get(armId!)!;
        const plannedArm = promotionPlan.arms.find((arm) => arm.armId === armId)!;
        const taskIndex = gateTaskDigests.indexOf(taskDigest!);
        return {
          deliveryDigest: documentDigest(new TextEncoder().encode(`delivery/${cellKey}`)),
          evaluationSpecDigest: EVAL_SPEC_DIGEST,
          evaluationSpec: evaluationSpec(),
          verdicts: [verdictFor(cellKey, taskIndex < participant.gatePasses ? "pass" : "fail")],
          pinning: {
            dispatches: 1,
            admission: {
              ready: true,
              checkedRequirementsDigest: requirementsDigest(plannedArm.pinning),
            },
            observations: fidelityObservations(
              participant.candidate.tuple as unknown as Record<string, unknown>,
            ),
          },
          cost: { value: "0.25", unit: "USD" },
          latencyMs: 4200,
        };
      },
    },
    venue: VENUE,
  });
  handle = appendWaveEvent(handle, {
    type: "matrix-assembled",
    recordedAt: "2026-08-04T12:00:00Z",
    payload: matrixAssembledPayload(promotionPlan, promotionMatrix),
  });

  const promotionReportProduced = await produceWaveReport({
    campaign,
    method: OBJECTIVE_METHOD,
    subjects: [promotionMatrix.bytes],
    verdictRule: "sole",
    author: AUTHOR,
    resolve: reportPorts(),
  }, fixtureSigner);
  const promotionReport = {
    digest: documentDigest(promotionReportProduced.bytes),
    record: promotionReportProduced.record,
  };
  handle = appendWaveEvent(handle, {
    type: "report-recorded",
    recordedAt: "2026-08-04T12:05:00Z",
    payload: reportRecordedPayload(promotionPlan, promotionReport),
  });

  emit(
    "Promotion run — the gate revealed, run flat, exactly once",
    "The committed Benchmark is revealed at CONFIRMING and is single-use. No informativeness "
    + "weighting, no pruning, one Run (§6.3).",
    [
      { label: "gate", value: promotionPlan.benchmark.digest },
      { label: "revealed", value: `${admission.revealedItems} of ${admission.committedItems} committed items` },
      { label: "arms", value: survivors.map((entry) => entry.label).join(", ") },
      { label: "run", value: `${promotionPlan.run.digest} (preregistered=${promotionReportProduced.record.preregistered ?? false})` },
      { label: "matrix", value: promotionMatrix.digest },
      { label: "signed report", value: promotionReport.digest },
    ],
  );

  // === 9. the recommendation =====================================================================
  const gateRows = reportRows(promotionPlan, promotionReport);
  const best = [...gateRows].sort((left, right) =>
    Number(right.value) - Number(left.value)
    || (left.tupleDigest < right.tupleDigest ? -1 : 1))[0]!;
  const recommendation = { tupleDigest: best.tupleDigest, value: best.value };
  const recommendedLabel =
    participants.find((entry) => entry.candidate.tupleDigest === best.tupleDigest)?.label ?? "unknown";

  // === 10. the archive ===========================================================================
  // Derived *before* the close, because `closed` is terminal: §5.2's CLOSED campaign has published
  // its outputs and stopped spending, and `frontier-updated` is legal only at EXPLORING or
  // CONFIRMING (`journal-lifecycle.ts`). The projection under `derived/` could be rebuilt at any
  // later time; the journal line saying which policies were non-dominated when the campaign ended
  // could not, so it has to be written while the campaign is still open. See FINDING F-C9-3.
  const frontierEntries: readonly FrontierEntry[] = gateRows.map((row) => {
    const participant = participants.find((entry) => entry.candidate.tupleDigest === row.tupleDigest)!;
    return {
      tupleDigest: row.tupleDigest,
      values: {
        quality: row.value,
        // Cost and latency are the venue's, per cell, identical across these arms by construction —
        // so quality alone separates them and the frontier is not silently a leaderboard.
        cost: "0.25",
        latency: `${4200 + participant.tree.length}`,
      },
    };
  });
  const manifestBytesList = accepted.map((entry) =>
    entry.label === "seed"
      ? seedSealed.bytes
      : entry.label === "learner"
        ? options.learnerCandidate!.manifestBytes
        : proposals.find((proposal) => proposal.tree === entry.tree)!.sealed.bytes,
  );
  const projection = deriveArchive({
    manifests: manifestBytesList,
    reports: [...devRows, ...gateRows],
    outcomes,
    frontierEntries,
    dimensions: PRODUCT_FRONTIER_DIMENSIONS,
  });
  const layout = archiveLayout(defaultArchiveRoot(options.directory));
  writeArchiveProjection(layout, projection);
  const frontierSet = frontierMembers(frontier(frontierEntries, PRODUCT_FRONTIER_DIMENSIONS));
  const lineage = lineageGraph(manifestBytesList);
  handle = appendWaveEvent(handle, {
    type: "frontier-updated",
    recordedAt: "2026-08-04T12:15:00Z",
    payload: { members: [...frontierSet], dimensions: PRODUCT_FRONTIER_DIMENSIONS.map((d) => d.key) },
  });
  emit(
    "Archive derived — lineage, history, frontier",
    "A derived local projection. Re-derivable, never authoritative, never published as a ranking: "
    + "the frontier is a SET, and where bytes are needed its members sort by digest (§8.3).",
    [
      { label: "lineage", value: `${lineage.nodes.length} nodes, ${lineage.roots.length} root(s), ${lineage.leaves.length} leaf/leaves` },
      { label: "histories", value: `${projection.histories.length} policies with measured history` },
      { label: "frontier", value: `${frontierSet.length} non-dominated member(s)` },
      { label: "written", value: `${layout.projectionPath} (derived: safe to delete)` },
    ],
  );

  // === 11. the close =============================================================================
  handle = appendWaveEvent(handle, {
    type: "closed",
    recordedAt: "2026-08-04T12:20:00Z",
    payload: {
      recommendation: recommendation.tupleDigest,
      basis: promotionReport.digest,
      // §6.3: the campaign's output is a signed Report plus a recommendation. Never an activation.
      note: "a recommendation, not an activation; every operator decides adoption locally (§9)",
    },
  });
  emit(
    "Campaign CLOSED — a recommendation, not an activation",
    "The campaign recommends; every operator decides adoption against their own thresholds. There "
    + "is no network-level current-best policy (§4, §9).",
    [
      { label: "recommended", value: `${recommendedLabel} — ${recommendation.tupleDigest}` },
      { label: "objective value", value: recommendation.value },
      { label: "basis", value: promotionReport.digest },
      { label: "spend", value: JSON.stringify(committedCells(handle.entries)) },
    ],
  );

  // === 12. adopt -> rollback, through the shipped CLI =============================================
  const cliStdout: string[] = [];
  const context = { cwd: options.directory, now: () => "2026-08-04T13:00:00Z" };
  const archiveDir = defaultArchiveRoot(options.directory);
  const tuplePath = writeJson(options.directory, "seed-tuple.json", seedTuple as unknown as JsonValue);
  const bestParticipant = participants.find(
    (entry) => entry.candidate.tupleDigest === recommendation.tupleDigest,
  )!;
  const bestTuplePath = writeJson(
    options.directory,
    "recommended-tuple.json",
    bestParticipant.candidate.tuple as unknown as JsonValue,
  );
  const taskProfile = campaign.target.taskProfile;

  const cli = (argv: readonly string[]): void => {
    const result = runCli(argv, context);
    if (result.exitCode !== 0) {
      throw new Error(`\`${argv.join(" ")}\` exited ${result.exitCode}: ${result.stderr}`);
    }
    cliStdout.push(result.stdout);
  };

  // The baseline: the operator is already running the seed policy on this route.
  cli([
    "optimize", "policy", "adopt",
    "--archive-dir", archiveDir,
    "--candidate", tuplePath,
    "--task-profile", taskProfile,
    "--approve-payload-class=prompt",
    "--approve-payload-class=skill",
  ]);
  const baselineLog = readAdoptionLog(layout);
  const baselineRecord = currentAdoption(baselineLog, { taskProfile })!;
  const baselineFragment = canonicalText(
    adoptionConfigFragment(baselineRecord, seedTuple) as unknown as JsonValue,
  );

  // The decision the campaign supports — and, being local, the operator's alone to make.
  cli([
    "optimize", "policy", "adopt",
    "--archive-dir", archiveDir,
    "--candidate", bestTuplePath,
    "--task-profile", taskProfile,
    "--approve-payload-class=prompt",
    "--approve-payload-class=skill",
  ]);
  const adoptedTuple = currentAdoption(readAdoptionLog(layout), { taskProfile })!.tupleDigest;

  // The safety net: rollback restores what was actually displaced, read from the log rather than
  // from the caller.
  cli(["optimize", "policy", "rollback", "--archive-dir", archiveDir, "--task-profile", taskProfile]);
  const afterLog = readAdoptionLog(layout);
  const afterRecord = currentAdoption(afterLog, { taskProfile })!;
  const afterFragment = canonicalText(
    adoptionConfigFragment(afterRecord, seedTuple) as unknown as JsonValue,
  );

  const byteIdentical =
    afterRecord.tupleDigest === seed.candidate.tupleDigest && afterFragment === baselineFragment;
  emit(
    "Adopt -> rollback — the operator ends where they started",
    "Adoption records a decision; pinning the tuple into task routes stays the operator config's "
    + "business, so `adopt` prints the fragment and changes nothing else. Rollback is appended as "
    + "an ordinary adoption of the displaced prior — the log is append-only because a retreat is "
    + "itself a decision (§9).",
    [
      { label: "baseline", value: seed.candidate.tupleDigest },
      { label: "adopted", value: `${recommendedLabel} — ${adoptedTuple}` },
      { label: "after rollback", value: afterRecord.tupleDigest },
      { label: "run pinning byte-identical", value: byteIdentical ? "yes" : "NO" },
      { label: "adoption log", value: `${layout.adoptionPath} (${afterLog.records.length} records, non-derivable)` },
    ],
  );

  if (!byteIdentical) {
    throw new Error("adopt -> rollback did not return the operator to the original policy");
  }

  return {
    directory: options.directory,
    handle,
    campaign,
    participants,
    seed,
    learner,
    rejections,
    checksPassed: [...checksPassed].sort(),
    devPlan,
    devMatrix: devMatrix.record,
    devQuote: { cells: devQuote.cells, requiredKeys: devQuote.requiredKeys },
    devReport,
    devPreregistered: devReportProduced.record.preregistered ?? false,
    promotionPlan,
    promotionMatrix: promotionMatrix.record,
    promotionReport,
    promotionPreregistered: promotionReportProduced.record.preregistered ?? false,
    swappedCellKey,
    pruned: secondAllocation.pruned.map((entry) => entry.tupleDigest),
    recommendation,
    frontier: frontierSet,
    lineageNodes: lineage.nodes.length,
    adoption: {
      baselineFragment,
      adoptedTuple,
      afterRollbackTuple: afterRecord.tupleDigest,
      afterRollbackFragment: afterFragment,
      byteIdentical,
      cliStdout,
    },
    stages,
  };
}

// --- small local helpers ------------------------------------------------------------------------

function runSettings() {
  return {
    owner: OWNER,
    closeAt: "2026-09-01T00:00:00Z",
    cellWindowMs: 3_600_000,
    completenessFloor: "0.5",
    independence: "disclosed" as const,
    replacement: { allowed: false },
    evaluation: { minVerdicts: 1, distinctEvaluator: false },
    venue: { kind: "self-run" as const, note: "local backend" },
  };
}

function sealedManifest(input: {
  readonly tree: readonly TreeEntry[];
  readonly tuple: ReturnType<typeof tupleForTree>;
  readonly parents: readonly { readonly kind: "tuple" | "candidate"; readonly digest: string }[];
  readonly proposer: string;
  readonly provenance: unknown;
  readonly summary: string;
  readonly touched: readonly string[];
}): CandidateManifest {
  return {
    formatToken: CANDIDATE_MANIFEST_FORMAT_TOKEN,
    policy: input.tuple,
    parents: input.parents,
    proposer: input.proposer,
    evidenceProvenance: input.provenance,
    declaredChanges: { summary: input.summary, touchedComponents: input.touched },
    compatibility: { harnesses: [FROZEN_HARNESS] },
  } as unknown as CandidateManifest;
}

function canonicalText(value: JsonValue): string {
  return new TextDecoder().decode(serializeCanonicalJson(value));
}

/** The CLI reads seeds and adoption targets as documents, so the tuples have to land on disk. */
function writeJson(directory: string, name: string, value: JsonValue): string {
  mkdirSync(directory, { recursive: true });
  const path = join(directory, name);
  writeFileSync(path, serializeCanonicalJson(value));
  return path;
}
