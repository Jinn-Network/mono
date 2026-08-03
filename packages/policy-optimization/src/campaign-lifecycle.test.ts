// SPDX-License-Identifier: MIT

/**
 * The unit's spine: a miniature end-to-end campaign against the in-memory fake backend.
 *
 * `DRAFT` → a seed and two candidates admitted → one development wave (Run sealed, cells executed,
 * Matrix assembled with per-axis verification through the local bridge, Report produced) → an
 * allocation decision journaled with the rows it consumed → `CONFIRMING` (the single promotion Run
 * against a committed-then-revealed gate) → `CLOSED`, and a journal that replays to the same
 * lifecycle.
 *
 * Nothing here is mocked at a seam this unit owns. The backend is the TEP conformance kit's own
 * reference implementation, the Run/Matrix/Report are the real records, and the per-axis
 * verification is `benchmarking-local`'s bridge. The two things the test plays are the two roles
 * the product deliberately does not own: the **evaluator** (verdict envelopes) and the **C8
 * adapter** (reading a sealed Report's results into allocator rows).
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  documentDigest,
  itemTaskDigest,
  serializeCanonicalJson,
  type MatrixRecord,
} from "@jinn-network/benchmarking-records";
import {
  axisObservationsFromRuntimeObservations,
  runPinningPropertyId,
} from "@jinn-network/benchmarking-local";
import type { AttemptWaitPort } from "@jinn-network/benchmarking-run";
import { createInMemoryBackend, type TestableBackend } from "@jinn-network/task-execution-testing";
import { afterAll, describe, expect, test } from "vitest";
import { decideAllocation } from "./allocation.js";
import { assembleWaveMatrix, executeWave } from "./execute.js";
import { createCampaign, openCampaign, type CampaignHandle } from "./journal-store.js";
import { journalEntryText } from "./journal-entry.js";
import { planPromotionRun } from "./promotion.js";
import { CAMPAIGN_JOURNAL_FILENAME } from "./tokens.js";
import {
  AUTHOR,
  CANDIDATE,
  EVALUATOR,
  OBJECTIVE_METHOD,
  PARENT,
  SOLVER,
  benchmarkFor,
  campaignFor,
  candidateFor,
  runSettings,
  tasksFor,
} from "./testing/wave-fixtures.js";
import type { JsonValue } from "./types.js";
import { committedCells, planWave } from "./wave.js";
import { produceWaveReport, type DsseSigner } from "./wave-report.js";
import {
  allocationDecidedPayload,
  appendWaveEvent,
  matrixAssembledPayload,
  promotionRunSealedPayload,
  reportRecordedPayload,
  runSealedPayload,
  wavePlannedPayload,
} from "./wave-journal.js";
import type {
  AdmittedCandidate,
  WaveCellEvidence,
  WavePlan,
  WaveReportRow,
} from "./wave-types.js";

const THIRD = candidateFor("third", "repo-work-third", "3");
const POPULATION = [PARENT, CANDIDATE, THIRD] as readonly AdmittedCandidate[];

const DEV_TASKS = tasksFor(["dev alpha", "dev beta"]);
const HELD_OUT_TASKS = tasksFor(["gate one", "gate two"]);
const DEV = benchmarkFor({ name: "dev slate", tasks: DEV_TASKS, reveal: { policy: "immediate" } });
const GATE = benchmarkFor({
  name: "promotion gate",
  tasks: HELD_OUT_TASKS,
  reveal: { policy: "after-run" },
});

const CAMPAIGN = campaignFor({
  developmentBenchmark: DEV.digest,
  promotionBenchmark: GATE.digest,
  seeds: [PARENT],
  allocation: { policyRef: "drop-bottom-k/1.0", parameters: { k: 1, minCandidates: 2 } },
  evaluationCells: 24,
  hardCapCells: 40,
});

const TASK_BYTES = new Map(
  [...DEV_TASKS, ...HELD_OUT_TASKS].map((task) => [task.digest, task.bytes] as const),
);

const CLOCK = { now: () => new Date("2026-08-04T09:00:00Z") };
const EVAL_SPEC_DIGEST = `sha256:${"2".repeat(64)}`;

/** The EvaluationSpec the verdicts are consistent against; contextually typed by the evidence. */
function evaluationSpec(): NonNullable<WaveCellEvidence["evaluationSpec"]> {
  return {
    protocol: "https://jinn.network/profiles/evaluation-spec/1.0",
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

// --- the evaluator's role: sealed result-evaluation Statements in a DSSE envelope ---------------

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function verdictEnvelope(verdict: "pass" | "fail", cellKey: string): Uint8Array {
  const payload = serializeCanonicalJson({
    _type: "https://in-toto.io/Statement/v1",
    subject: [{
      name: `cell/${cellKey}`,
      digest: { sha256: documentDigest(new TextEncoder().encode(cellKey)).slice("sha256:".length) },
    }],
    predicateType: "https://jinn.network/attestations/result-evaluation/v1",
    predicate: {
      evaluatedAt: "2026-08-04T09:30:00Z",
      evaluator: { id: EVALUATOR },
      taskSubject: "execution/task/task.json",
      resultSubjects: ["execution/result/result.json"],
      verdict,
    },
  } as JsonValue);
  return serializeCanonicalJson({
    payloadType: "application/vnd.in-toto+json",
    payload: base64(payload),
    signatures: [{ keyid: "did:key:zVerdictFixture", sig: base64(Uint8Array.of(1)) }],
  } as JsonValue);
}

const VERDICT_BYTES = new Map<string, Uint8Array>();

function verdictFor(cellKey: string, outcome: "pass" | "fail") {
  const bytes = verdictEnvelope(outcome, cellKey);
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

// --- the venue's role: dispatch, and what it recorded about fidelity ----------------------------

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

/** Observations naming exactly what the arm pinned — or, for the swapped cell, what did not. */
function fidelityObservations(candidate: AdmittedCandidate) {
  const tuple = candidate.tuple as unknown as Record<string, unknown>;
  return axisObservationsFromRuntimeObservations([
    { kind: "resource", propertyId: runPinningPropertyId("harness"), value: JSON.stringify(tuple["harness"]) },
    { kind: "resource", propertyId: runPinningPropertyId("model"), value: JSON.stringify(tuple["model"]) },
    { kind: "resource", propertyId: runPinningPropertyId("loadout"), value: JSON.stringify(tuple["loadout"]) },
  ]);
}

/** `third` on the second dev task actually ran the parent's loadout. */
function swappedCellKey(): string {
  return `${itemTaskDigest(DEV.record.items[1]!)}/${THIRD.armId}/1`;
}

const DEV_OUTCOMES: Readonly<Record<string, "pass" | "fail">> = {
  [PARENT.armId]: "pass",
  [CANDIDATE.armId]: "pass",
  [THIRD.armId]: "fail",
};

function devVerdict(armId: string, taskIndex: number): "pass" | "fail" {
  // parent: pass, fail  |  candidate: pass, pass  |  third: fail, (swapped cell)
  if (armId === PARENT.armId) return taskIndex === 0 ? "pass" : "fail";
  return DEV_OUTCOMES[armId]!;
}

function evidencePort(plan: WavePlan, options: { readonly swap?: boolean } = {}) {
  const byArm = new Map(POPULATION.map((candidate) => [candidate.armId, candidate] as const));
  const taskOrder = plan.benchmark.record.items.map(itemTaskDigest);
  return {
    evidenceFor(cellKey: string): WaveCellEvidence | undefined {
      const [taskDigest, armId] = cellKey.split("/");
      const candidate = byArm.get(armId!)!;
      const taskIndex = taskOrder.indexOf(taskDigest!);
      const swapped = options.swap === true && cellKey === swappedCellKey();
      const outcome = plan.kind === "promotion"
        ? (armId === CANDIDATE.armId ? "pass" : taskIndex === 0 ? "pass" : "fail")
        : devVerdict(armId!, taskIndex);
      return {
        deliveryDigest: documentDigest(new TextEncoder().encode(`delivery/${cellKey}`)),
        evaluationSpecDigest: EVAL_SPEC_DIGEST,
        evaluationSpec: evaluationSpec(),
        verdicts: [verdictFor(cellKey, outcome)],
        pinning: {
          dispatches: 1,
          admission: { ready: true },
          observations: fidelityObservations(swapped ? PARENT : candidate),
        },
        cost: { value: "0.25", unit: "USD" },
        latencyMs: 4200,
      };
    },
  };
}

const VENUE = {
  isolationInventory: ["unrestricted"],
  admissionReceiptFor: () => ({ zeroReplayVariance: true, externalCapabilities: false }),
  trust: {
    async resolveAgent(evidence: unknown) {
      return (evidence as { role?: string }).role === "evaluator" ? EVALUATOR : SOLVER;
    },
  },
};

// --- the Report's role: a signer and the resolvers the method registry reads through -------------

const RUN_BYTES = new Map<string, Uint8Array>();

function reportPorts() {
  return {
    resolveVerdictBytes: (digest: string) => VERDICT_BYTES.get(digest),
    resolveRunBytes: (digest: string) => RUN_BYTES.get(digest),
    resolveTaskBytes: (digest: string) => TASK_BYTES.get(digest.replace(/^sha256:/, "")),
  };
}

const fixtureSigner: DsseSigner = async (input) => {
  const digest = new TextEncoder().encode(documentDigest(input.preAuthEncoding));
  return [{ keyid: "did:key:zReportFixture", signature: digest }];
};

/** The C8 adapter's role: read a sealed Report's per-arm means into allocator rows. */
function reportRows(
  plan: WavePlan,
  report: { readonly digest: string; readonly record: { readonly results: unknown } },
): readonly WaveReportRow[] {
  const perSubject = (report.record.results as { perSubject: { results: { arms: Record<string, { mean: string }> } }[] }).perSubject;
  const arms = perSubject[0]!.results.arms;
  return plan.arms.map((arm) => ({
    reportDigest: report.digest,
    waveNumber: plan.waveNumber,
    tupleDigest: arm.tupleDigest,
    method: { id: OBJECTIVE_METHOD.id, version: OBJECTIVE_METHOD.version },
    value: arms[arm.armId]!.mean,
  }));
}

// --- the campaign ------------------------------------------------------------------------------

const directories: string[] = [];

function scratchDirectory(): string {
  const directory = join(mkdtempSync(join(tmpdir(), "jinn-policy-campaign-")), "campaign");
  directories.push(directory);
  return directory;
}

afterAll(() => {
  for (const directory of directories) rmSync(join(directory, ".."), { recursive: true, force: true });
});

interface RunOutcome {
  readonly handle: CampaignHandle;
  readonly devPlan: WavePlan;
  readonly devMatrix: MatrixRecord;
  readonly promotionPlan: WavePlan;
  readonly devPreregistered: boolean;
  readonly promotionPreregistered: boolean;
  readonly pruned: readonly string[];
  readonly directory: string;
}

async function runMiniatureCampaign(): Promise<RunOutcome> {
  const directory = scratchDirectory();
  let handle = createCampaign({
    directory,
    campaign: CAMPAIGN,
    seedResolutions: [{ kind: "tuple", digest: PARENT.tupleDigest, tuple: PARENT.tuple }],
    createdAt: "2026-08-04T08:00:00Z",
  });

  // DRAFT: the seed and two candidates enter the population. Admission itself is C7c's; the
  // journal entry is the product decision this unit's ordering has to preserve.
  for (const candidate of POPULATION) {
    handle = appendWaveEvent(handle, {
      type: "candidate-admitted",
      recordedAt: "2026-08-04T08:10:00Z",
      payload: { tupleDigest: candidate.tupleDigest, armId: candidate.armId },
    });
  }
  expect(handle.state.phase).toBe("DRAFT");

  // --- development wave 1 ---
  const firstAllocation = decideAllocation({
    campaign: CAMPAIGN,
    waveNumber: 1,
    population: POPULATION,
    taskDigests: DEV.record.items.map(itemTaskDigest),
  });
  const devPlan = planWave({
    campaign: CAMPAIGN,
    campaignDigest: handle.digest,
    waveNumber: 1,
    candidates: POPULATION,
    allocation: firstAllocation,
    developmentBenchmarkBytes: DEV.bytes,
    settings: runSettings(),
    committed: committedCells(handle.entries),
  });
  RUN_BYTES.set(devPlan.run.digest, devPlan.run.bytes);

  handle = appendWaveEvent(handle, {
    type: "wave-planned",
    recordedAt: "2026-08-04T09:00:00Z",
    payload: wavePlannedPayload(devPlan),
  }, {
    exploringEntry: {
      benchmarkBytes: GATE.bytes,
      revealContext: { kind: "after-run", trustedRunNotClosed: true },
    },
  });
  expect(handle.state.phase).toBe("EXPLORING");

  handle = appendWaveEvent(handle, {
    type: "run-sealed",
    recordedAt: "2026-08-04T09:00:01Z",
    payload: runSealedPayload(devPlan),
  });

  const devBackend = backend();
  const devExecution = await executeWave({
    plan: devPlan,
    backend: devBackend,
    taskBytesFor: (digest) => TASK_BYTES.get(digest)!,
    launch: { clock: CLOCK, waitForTerminal: deliveringWaitPort(devBackend) },
  });
  const devMatrix = await assembleWaveMatrix({
    plan: devPlan,
    execution: devExecution,
    evidence: evidencePort(devPlan, { swap: true }),
    venue: VENUE,
  });
  handle = appendWaveEvent(handle, {
    type: "matrix-assembled",
    recordedAt: "2026-08-04T10:00:00Z",
    payload: matrixAssembledPayload(devPlan, devMatrix),
  });

  const devReport = await produceWaveReport({
    campaign: CAMPAIGN,
    method: OBJECTIVE_METHOD,
    subjects: [devMatrix.bytes],
    verdictRule: "sole",
    author: AUTHOR,
    resolve: reportPorts(),
  }, fixtureSigner);
  const devReportDigest = documentDigest(devReport.bytes);
  handle = appendWaveEvent(handle, {
    type: "report-recorded",
    recordedAt: "2026-08-04T10:05:00Z",
    payload: reportRecordedPayload(devPlan, { digest: devReportDigest, record: devReport.record }),
  });

  // --- the allocation decision the wave paid for ---
  const secondAllocation = decideAllocation({
    campaign: CAMPAIGN,
    waveNumber: 2,
    population: POPULATION,
    taskDigests: DEV.record.items.map(itemTaskDigest),
    reports: reportRows(devPlan, { digest: devReportDigest, record: devReport.record }),
    outcomes: POPULATION.map((candidate) => ({
      inputRefs: [`sha256:${candidate.tupleDigest.slice(-64)}`],
      tupleDigest: candidate.tupleDigest,
      bucket: "organic" as const,
      passRate: { num: 1, den: 2 },
    })),
  });
  handle = appendWaveEvent(handle, {
    type: "allocation-decided",
    recordedAt: "2026-08-04T10:10:00Z",
    payload: allocationDecidedPayload(secondAllocation),
  });

  // --- CONFIRMING: the single promotion Run, against the revealed gate ---
  const survivors = POPULATION.filter(
    (candidate) => secondAllocation.retained.includes(candidate.tupleDigest),
  );
  const { plan: promotionPlan, admission } = planPromotionRun({
    campaign: CAMPAIGN,
    campaignDigest: handle.digest,
    phase: handle.state.phase,
    candidates: survivors,
    reveal: {
      benchmarkBytes: GATE.bytes,
      revealed: new Map(HELD_OUT_TASKS.map((task) => [task.digest, task.bytes])),
    },
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
  expect(handle.state.phase).toBe("CONFIRMING");

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
    evidence: evidencePort(promotionPlan),
    venue: VENUE,
  });
  handle = appendWaveEvent(handle, {
    type: "matrix-assembled",
    recordedAt: "2026-08-04T12:00:00Z",
    payload: matrixAssembledPayload(promotionPlan, promotionMatrix),
  });

  const promotionReport = await produceWaveReport({
    campaign: CAMPAIGN,
    method: OBJECTIVE_METHOD,
    subjects: [promotionMatrix.bytes],
    verdictRule: "sole",
    author: AUTHOR,
    resolve: reportPorts(),
  }, fixtureSigner);
  handle = appendWaveEvent(handle, {
    type: "report-recorded",
    recordedAt: "2026-08-04T12:05:00Z",
    payload: reportRecordedPayload(promotionPlan, {
      digest: documentDigest(promotionReport.bytes),
      record: promotionReport.record,
    }),
  });

  handle = appendWaveEvent(handle, {
    type: "closed",
    recordedAt: "2026-08-04T12:10:00Z",
    payload: { recommendation: promotionPlan.arms.map((arm) => arm.tupleDigest) },
  });

  return {
    handle,
    devPlan,
    devMatrix: devMatrix.record,
    promotionPlan,
    devPreregistered: devReport.record.preregistered ?? false,
    promotionPreregistered: promotionReport.record.preregistered ?? false,
    pruned: secondAllocation.pruned.map((entry) => entry.tupleDigest),
    directory,
  };
}

const outcome = await runMiniatureCampaign();

describe("a miniature campaign runs the whole loop on the local venue", () => {
  test("the lifecycle walks DRAFT -> EXPLORING -> CONFIRMING -> CLOSED", () => {
    expect(outcome.handle.state.phase).toBe("CLOSED");
    expect(outcome.handle.entries.map((entry) => entry.type)).toEqual([
      "created",
      "candidate-admitted", "candidate-admitted", "candidate-admitted",
      "wave-planned", "run-sealed", "matrix-assembled", "report-recorded",
      "allocation-decided",
      "promotion-run-sealed", "matrix-assembled", "report-recorded",
      "closed",
    ]);
  });

  test("the development wave ran every admitted candidate over the whole dev slate", () => {
    expect(outcome.devPlan.arms.map((arm) => arm.armId)).toEqual(["candidate", "parent", "third"]);
    expect(outcome.devPlan.cells).toBe(DEV_TASKS.length * 3);
    expect(outcome.devMatrix.cells).toHaveLength(DEV_TASKS.length * 3);
  });

  test("per-axis verification comes from the local bridge, honest cell by honest cell", () => {
    const swapped = outcome.devMatrix.cells.find((cell) => cell.cellKey === swappedCellKey())!;
    expect(swapped.verification.loadout).toBe("mismatch");
    expect(swapped.verification.checksFailed).toContain("pinning-observation");
    // Outcome precedence: a pinning mismatch invalidates the cell even with a valid verdict.
    expect(swapped.outcome).toBe("invalidated");

    for (const cell of outcome.devMatrix.cells) {
      if (cell.cellKey === swappedCellKey()) continue;
      expect(cell.verification, cell.cellKey).toEqual({
        harness: "match",
        model: "match",
        loadout: "match",
        // Vacuous, and disclosed as such by the identity design's per-axis strength, not by the
        // Matrix tri-state (which answers whether the pin was honored).
        isolation: "match",
        checksFailed: [],
      });
      expect(cell.outcome, cell.cellKey).toBe("judged");
      expect(cell.integrityTier, cell.cellKey).toBe("re-derivable");
    }
    expect(outcome.devMatrix.completeness.runOutcome).toBe("complete");
  });

  test("the promotion Run is preregistered and the development wave is not (§6.2/§6.3)", () => {
    expect(outcome.devPreregistered).toBe(false);
    expect(outcome.promotionPreregistered).toBe(true);
    expect(outcome.devPlan.run.record.analysisPlan).toBeUndefined();
    expect(outcome.promotionPlan.run.record.analysisPlan).toHaveLength(1);
  });

  test("the allocation pruned the worst arm and journaled what it read", () => {
    expect(outcome.pruned).toEqual([THIRD.tupleDigest]);
    expect(outcome.promotionPlan.arms.map((arm) => arm.armId)).toEqual(["candidate", "parent"]);
    const decided = outcome.handle.entries.find((entry) => entry.type === "allocation-decided")!;
    const inputs = decided.payload["inputs"] as { reports: string[]; outcomes: string[] };
    expect(inputs.reports).toHaveLength(1);
    expect(inputs.outcomes).toHaveLength(3);
    expect((decided.payload["pruned"] as { tupleDigest: string }[])[0]!.tupleDigest)
      .toBe(THIRD.tupleDigest);
  });

  test("the promotion Run ran the revealed gate, flat, exactly once", () => {
    expect(outcome.promotionPlan.kind).toBe("promotion");
    expect(outcome.promotionPlan.allocation).toBeUndefined();
    expect(outcome.promotionPlan.benchmark.digest).toBe(GATE.digest);
    const sealed = outcome.handle.entries.filter((entry) => entry.type === "promotion-run-sealed");
    expect(sealed).toHaveLength(1);
    expect(sealed[0]!.payload["revealedItems"]).toBe(HELD_OUT_TASKS.length);
  });

  test("the campaign's spend is reconstructable from its own journal", () => {
    expect(committedCells(outcome.handle.entries)).toEqual({
      development: DEV_TASKS.length * 3,
      promotion: HELD_OUT_TASKS.length * 2,
      total: DEV_TASKS.length * 3 + HELD_OUT_TASKS.length * 2,
    });
  });
});

describe("replaying the journal reconstructs the same lifecycle", () => {
  test("openCampaign returns entries byte-identical to the ones that were appended", () => {
    const reopened = openCampaign(outcome.directory);
    expect(reopened.entries.map(journalEntryText))
      .toEqual(outcome.handle.entries.map(journalEntryText));
    expect(reopened.state).toEqual(outcome.handle.state);
    expect(reopened.digest).toBe(outcome.handle.digest);
  });

  test("the replayed handle derives the same terminal phase and the same spend", () => {
    const reopened = openCampaign(outcome.directory);
    expect(reopened.state.phase).toBe("CLOSED");
    expect(committedCells(reopened.entries)).toEqual(committedCells(outcome.handle.entries));
  });

  test("the file on disk is exactly the canonical lines, one per entry", () => {
    const text = readFileSync(join(outcome.directory, CAMPAIGN_JOURNAL_FILENAME), "utf8");
    expect(text.split("\n").filter((line) => line !== ""))
      .toEqual(outcome.handle.entries.map(journalEntryText));
  });
});
