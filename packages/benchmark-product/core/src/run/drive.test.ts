import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { CellStatusEvent } from "@jinn-network/benchmarking-run";
import { RECORD_KINDS } from "@jinn-network/record-discovery-protocol";
import {
  TaskExecutionError,
  type AttemptUri,
  type DeliveryRef,
  type ObservationSnapshot,
  type SubmissionAck,
  type SubmissionUri,
} from "@jinn-network/task-execution-backend";
import type { ResourceDescriptor } from "@jinn-network/task-execution-protocol";
import { sealDelivery, sealTask } from "@jinn-network/task-execution-protocol";
import { getSealedBytes, putSealedBytes, sealedRecordPath, sha256Hex } from "../workspace/sealed-store.js";
import {
  createRecordingProxy,
  driveCellEvents,
  driveEvaluationCatchUp,
  type ProxiedBackend,
} from "./drive.js";
import { evaluationGaps, foldRunJournal, readRunJournalEntries } from "./journal.js";
import { requireWorkspaceAuthorship } from "./publication-authority.js";
import { EVALUATOR_REQUIREMENT_KEY, type LocalVenue } from "../venue/venue.js";
import { loadOrCreateReportSigningKey } from "../report/signing.js";
import {
  parseRunPinningEvidence,
  type VerifiedRunPinningCheck,
} from "./pinning-evidence.js";

let workspaceDir: string;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "bp12-drive-"));
});

afterEach(() => {
  rmSync(workspaceDir, { recursive: true, force: true });
});

function makeClock(): () => string {
  let tick = 0;
  return () => `2026-08-05T00:00:${String(tick++).padStart(2, "0")}Z`;
}

function utf8(json: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(json));
}

function fakeDeliveryRef(attempt: string, sha256: string): DeliveryRef {
  return { attempt: attempt as AttemptUri, digest: `sha256:${sha256}` as const };
}

function fakeSnapshot(attempt: string, state: string, blame?: "task" | "infrastructure"): ObservationSnapshot {
  return {
    descriptor: {
      attempt: attempt as `urn:uuid:${string}`,
      task: `sha256:${"0".repeat(64)}`,
      submission: attempt as `urn:uuid:${string}`,
      derived: {
        state: state as never,
        terminal: true,
        contradictory: false,
        cancelRequested: false,
        executionIds: [],
        deliveries: [],
        ...(blame !== undefined ? { blame } : {}),
      },
    },
    cursor: { sequence: "0" },
    observations: [],
  };
}

/** A minimal, fully scripted ProxiedBackend: canned responses keyed by attempt/digest. */
function makeFakeBackend(options: {
  deliveriesByAttempt?: Record<string, DeliveryRef[]>;
  deliveryBytesByDigest?: Record<string, Uint8Array>;
  artifactBytesByDigest?: Record<string, Uint8Array>;
  submitResult?: SubmissionAck;
  observeResult?: ObservationSnapshot;
  hasFetchArtifact?: boolean;
  pinningEvidence?: VerifiedRunPinningCheck;
  calls?: { submits: { taskBytes: Uint8Array; submissionBytes: Uint8Array }[] };
}): ProxiedBackend {
  const calls = options.calls ?? { submits: [] };
  const backend: ProxiedBackend = {
    async capabilities() {
      throw new Error("not used by drive.ts tests");
    },
    async submit(taskBytes, submissionBytes) {
      calls.submits.push({ taskBytes, submissionBytes });
      return options.submitResult ?? { accepted: true, submission: "urn:uuid:00000000-0000-4000-8000-000000000099" as SubmissionUri, digest: `sha256:${"9".repeat(64)}` };
    },
    async observe() {
      if (options.observeResult === undefined) throw new Error("observe not scripted");
      return options.observeResult;
    },
    async recover() {
      throw new Error("not used by drive.ts tests");
    },
    async deliveries(attempt) {
      return options.deliveriesByAttempt?.[attempt] ?? [];
    },
    async fetchDelivery(ref) {
      const bytes = options.deliveryBytesByDigest?.[ref.digest];
      if (bytes === undefined) throw new Error(`fetchDelivery: no scripted bytes for ${ref.digest}`);
      return bytes;
    },
    async drain() {},
  };
  if (options.hasFetchArtifact !== false) {
    backend.fetchArtifact = async (descriptor: ResourceDescriptor) => {
      const sha256 = descriptor.digest?.["sha256"];
      const bytes = sha256 === undefined ? undefined : options.artifactBytesByDigest?.[sha256];
      if (bytes === undefined) throw new Error(`fetchArtifact: no scripted bytes for ${JSON.stringify(descriptor)}`);
      return bytes;
    };
  }
  if (options.pinningEvidence !== undefined) {
    backend.pinningEvidenceForSubmission = () => ({ ...options.pinningEvidence! });
  }
  return backend;
}

const CELL_A = `${"a".repeat(64)}/arm-a/1`;

/**
 * Stores a real sealed subject Task (bound to a real sealed EvaluationSpec) and returns the
 * Task's own actual digest — the driver derives `taskDigestHex` from the cellKey via
 * `parseCellKey`, so a test that exercises the evaluation leg must build its cellKey from this
 * digest rather than an arbitrary placeholder.
 */
function storeSubjectTaskAndSpec(): { taskSha256: string; evaluationSpecSha256: string } {
  const evaluationSpecBytes = utf8({ protocol: "https://spec.jinn.network/profiles/evaluation-spec/v1" });
  const evaluationSpecSha256 = putSealedBytes(workspaceDir, evaluationSpecBytes);
  const taskBytes = sealTask({
    protocol: "https://spec.jinn.network/profiles/task-execution/v1",
    profile: { digest: { sha256: "1".repeat(64) } },
    instructions: "predict",
    outputs: [{ name: "prediction", mediaType: "application/json", required: true }],
    evaluation: { name: "evaluation-spec.json", digest: { sha256: evaluationSpecSha256 } },
  });
  const taskSha256 = putSealedBytes(workspaceDir, taskBytes);
  return { taskSha256, evaluationSpecSha256 };
}

function evaluatorIri(index: number): string {
  return `urn:jinn:benchmark-product:local-venue:evaluator-${index}`;
}

function fakeVenue(prepared: { taskBytes: Uint8Array; taskSha256: string }, evaluatorCount = 1): LocalVenue {
  const evaluators = Array.from({ length: evaluatorCount }, (_, i) => ({
    id: evaluatorIri(i + 1),
    keyId: `fake-key-${i + 1}`,
  }));
  return {
    backend: undefined as unknown as LocalVenue["backend"],
    verdictKeyId: evaluators[0]!.keyId,
    evaluators,
    // The real venue returns the digest of its exact derived bytes. Preserve that contract in
    // this fake even when a test's descriptive placeholder passed a different taskSha256.
    prepareEvaluationCell: () => ({ taskBytes: prepared.taskBytes, taskSha256: sha256Hex(prepared.taskBytes) }),
    async shutdown() {},
  };
}

function ownedFakeVenue(prepared: { taskBytes: Uint8Array; taskSha256: string }): LocalVenue {
  return { ...fakeVenue(prepared), assertRunOwnership() {} };
}

describe("createRecordingProxy", () => {
  test("journals submission-accepted from a solve-shaped nonce (<cellKey>:<dispatch>) then delegates", async () => {
    const clock = makeClock();
    const pinningEvidence = {
      ready: true,
      checkedRequirementsDigest: `sha256:${"7".repeat(64)}` as const,
    };
    const backend = makeFakeBackend({ pinningEvidence });
    const proxy = createRecordingProxy(backend, { workspaceDir, draftId: "draft-1", liveClock: clock });

    const submissionBytes = utf8({ nonce: `${CELL_A}:1`, submission: "urn:uuid:00000000-0000-4000-8000-000000000001" });
    const ack = await proxy.submit(new Uint8Array([1]), submissionBytes);
    expect(ack.accepted).toBe(true);

    const entries = readRunJournalEntries(workspaceDir, "draft-1");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: "submission-accepted", cellKey: CELL_A, dispatch: 1, leg: "solve" });
    if (entries[0]?.kind === "submission-accepted") {
      expect(entries[0].submissionSha256).toBe(sha256Hex(submissionBytes));
      expect(entries[0].pinningEvidenceSha256).toMatch(/^[a-f0-9]{64}$/u);
      expect(parseRunPinningEvidence(
        getSealedBytes(workspaceDir, entries[0].pinningEvidenceSha256!),
      )).toEqual({ admission: pinningEvidence });
    }
  });

  test("a rejected Submission is never journaled as accepted and carries no fabricated proof", async () => {
    const backend = makeFakeBackend({
      submitResult: {
        accepted: false,
        error: new TaskExecutionError("unsupported-requirement", {
          detail: "model pin mismatch",
        }),
      },
      pinningEvidence: {
        ready: true,
        checkedRequirementsDigest: `sha256:${"7".repeat(64)}`,
      },
    });
    const proxy = createRecordingProxy(backend, {
      workspaceDir,
      draftId: "draft-1",
      liveClock: makeClock(),
    });
    const submissionBytes = utf8({
      nonce: `${CELL_A}:1`,
      submission: "urn:uuid:00000000-0000-4000-8000-000000000001",
    });

    await expect(proxy.submit(new Uint8Array([1]), submissionBytes)).resolves.toMatchObject({
      accepted: false,
    });
    expect(readRunJournalEntries(workspaceDir, "draft-1")).toEqual([]);
  });

  test("prospective solve capture keeps pinning evidence as a separate append-only enrichment", async () => {
    const pinningEvidence = {
      ready: true,
      checkedRequirementsDigest: `sha256:${"7".repeat(64)}` as const,
    };
    const backend = makeFakeBackend({ pinningEvidence });
    const proxy = createRecordingProxy(backend, {
      workspaceDir,
      draftId: "draft-1",
      liveClock: makeClock(),
      recordSolveSubmissions: false,
    });
    const submissionBytes = utf8({ nonce: `${CELL_A}:1`, submission: "urn:uuid:00000000-0000-4000-8000-000000000001" });
    await proxy.submit(new Uint8Array([1]), submissionBytes);

    const entries = readRunJournalEntries(workspaceDir, "draft-1");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      kind: "submission-pinning-evidence",
      cellKey: CELL_A,
      dispatch: 1,
      submissionSha256: sha256Hex(submissionBytes),
      pinningEvidenceSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect(entries.some((entry) => entry.kind === "submission-accepted")).toBe(false);
  });

  test("journals submission-accepted with leg 'evaluation' from an eval-shaped nonce (eval:<runSha256>:e<i>:<cellKey>:<dispatch>)", async () => {
    const clock = makeClock();
    const backend = makeFakeBackend({});
    const proxy = createRecordingProxy(backend, { workspaceDir, draftId: "draft-1", liveClock: clock });

    const nonce = `eval:${"f".repeat(64)}:e1:${CELL_A}:2`;
    const submissionBytes = utf8({ nonce, submission: "urn:uuid:00000000-0000-4000-8000-000000000002" });
    await proxy.submit(new Uint8Array([1]), submissionBytes);

    const entries = readRunJournalEntries(workspaceDir, "draft-1");
    expect(entries[0]).toMatchObject({ kind: "submission-accepted", cellKey: CELL_A, dispatch: 2, leg: "evaluation" });
  });

  test("journals leg 'evaluation' from a legacy eval nonce without the e<i> segment", async () => {
    const clock = makeClock();
    const backend = makeFakeBackend({});
    const proxy = createRecordingProxy(backend, { workspaceDir, draftId: "draft-1", liveClock: clock });

    const nonce = `eval:${"f".repeat(64)}:${CELL_A}:2`;
    const submissionBytes = utf8({ nonce, submission: "urn:uuid:00000000-0000-4000-8000-000000000002" });
    await proxy.submit(new Uint8Array([1]), submissionBytes);

    const entries = readRunJournalEntries(workspaceDir, "draft-1");
    expect(entries[0]).toMatchObject({ kind: "submission-accepted", cellKey: CELL_A, dispatch: 2, leg: "evaluation" });
  });

  test("a submission with no parseable nonce is not journaled but still delegates", async () => {
    const clock = makeClock();
    const backend = makeFakeBackend({});
    const proxy = createRecordingProxy(backend, { workspaceDir, draftId: "draft-1", liveClock: clock });

    const ack = await proxy.submit(new Uint8Array([1]), utf8({ submission: "no-nonce-here" }));
    expect(ack.accepted).toBe(true);
    expect(readRunJournalEntries(workspaceDir, "draft-1")).toEqual([]);
  });

  test("other methods (deliveries, fetchDelivery, drain, fetchArtifact) pass straight through", async () => {
    const clock = makeClock();
    const ref = fakeDeliveryRef("att-1", "b".repeat(64));
    const backend = makeFakeBackend({
      deliveriesByAttempt: { "att-1": [ref] },
      deliveryBytesByDigest: { [`sha256:${"b".repeat(64)}`]: new Uint8Array([9]) },
      artifactBytesByDigest: { [`${"c".repeat(64)}`]: new Uint8Array([7]) },
    });
    const proxy = createRecordingProxy(backend, { workspaceDir, draftId: "draft-1", liveClock: clock });

    expect(await proxy.deliveries("att-1" as never)).toEqual([ref]);
    expect(await proxy.fetchDelivery(ref)).toEqual(new Uint8Array([9]));
    expect(await proxy.fetchArtifact?.({ digest: { sha256: "c".repeat(64) } })).toEqual(new Uint8Array([7]));
    await expect(proxy.drain()).resolves.toBeUndefined();
  });
});

describe("driveCellEvents — non-terminal / non-delivered events", () => {
  test("a dispatch event is journaled with no further side effects", async () => {
    const clock = makeClock();
    const backend = makeFakeBackend({});
    const events: CellStatusEvent[] = [
      { cellKey: CELL_A, armId: "arm-a", replicate: 1, dispatch: 1, kind: "dispatch", attempt: "att-1" },
    ];
    await driveCellEvents(
      { workspaceDir, draftId: "draft-1", venue: fakeVenue({ taskBytes: new Uint8Array(), taskSha256: "0".repeat(64) }), backend, runSha256: "r".repeat(64), owner: "urn:uuid:owner", cellWindowMs: 3_600_000, minVerdicts: 1, liveClock: clock },
      (async function* () { for (const event of events) yield event; })(),
    );
    const entries = readRunJournalEntries(workspaceDir, "draft-1");
    expect(entries).toEqual([{ kind: "cell-event", at: "2026-08-05T00:00:00Z", event: events[0] }]);
  });

  test("a cancelled event is journaled with no evaluation dispatch", async () => {
    const clock = makeClock();
    const backend = makeFakeBackend({});
    const events: CellStatusEvent[] = [
      { cellKey: CELL_A, armId: "arm-a", replicate: 1, dispatch: 1, kind: "cancelled", detail: "run-cancelled" },
    ];
    await driveCellEvents(
      { workspaceDir, draftId: "draft-1", venue: fakeVenue({ taskBytes: new Uint8Array(), taskSha256: "0".repeat(64) }), backend, runSha256: "r".repeat(64), owner: "urn:uuid:owner", cellWindowMs: 3_600_000, minVerdicts: 1, liveClock: clock },
      (async function* () { for (const event of events) yield event; })(),
    );
    expect(readRunJournalEntries(workspaceDir, "draft-1")).toHaveLength(1);
  });
});

describe("driveCellEvents — blame observation (BP-22)", () => {
  test("an error event with an attempt journals the backend's observed blame", async () => {
    const clock = makeClock();
    const backend = makeFakeBackend({ observeResult: fakeSnapshot("att-err-1", "failed", "infrastructure") });
    const events: CellStatusEvent[] = [
      { cellKey: CELL_A, armId: "arm-a", replicate: 1, dispatch: 1, kind: "error", attempt: "att-err-1", replaceable: false, detail: "SIGKILL" },
    ];
    await driveCellEvents(
      { workspaceDir, draftId: "draft-1", venue: fakeVenue({ taskBytes: new Uint8Array(), taskSha256: "0".repeat(64) }), backend, runSha256: "r".repeat(64), owner: "urn:uuid:owner", cellWindowMs: 3_600_000, minVerdicts: 1, liveClock: clock },
      (async function* () { for (const event of events) yield event; })(),
    );
    const entries = readRunJournalEntries(workspaceDir, "draft-1");
    expect(entries).toEqual([{ kind: "cell-event", at: "2026-08-05T00:00:00Z", event: events[0], blame: "infrastructure" }]);
  });

  test("an error event whose observe() throws journals with no blame field, and the run is unaffected", async () => {
    const clock = makeClock();
    // No observeResult scripted -> makeFakeBackend's observe() throws.
    const backend = makeFakeBackend({});
    const events: CellStatusEvent[] = [
      { cellKey: CELL_A, armId: "arm-a", replicate: 1, dispatch: 1, kind: "error", attempt: "att-err-1", replaceable: false, detail: "exit 7" },
    ];
    await driveCellEvents(
      { workspaceDir, draftId: "draft-1", venue: fakeVenue({ taskBytes: new Uint8Array(), taskSha256: "0".repeat(64) }), backend, runSha256: "r".repeat(64), owner: "urn:uuid:owner", cellWindowMs: 3_600_000, minVerdicts: 1, liveClock: clock },
      (async function* () { for (const event of events) yield event; })(),
    );
    const entries = readRunJournalEntries(workspaceDir, "draft-1");
    expect(entries).toEqual([{ kind: "cell-event", at: "2026-08-05T00:00:00Z", event: events[0] }]);
    expect(entries[0] && "blame" in entries[0]).toBe(false);
  });

  test("an error event with no attempt reference never calls observe() and journals with no blame", async () => {
    const clock = makeClock();
    const backend = makeFakeBackend({}); // observe() would throw "observe not scripted" if reached.
    const events: CellStatusEvent[] = [
      { cellKey: CELL_A, armId: "arm-a", replicate: 1, dispatch: 1, kind: "error", replaceable: false, detail: "rejected" },
    ];
    await driveCellEvents(
      { workspaceDir, draftId: "draft-1", venue: fakeVenue({ taskBytes: new Uint8Array(), taskSha256: "0".repeat(64) }), backend, runSha256: "r".repeat(64), owner: "urn:uuid:owner", cellWindowMs: 3_600_000, minVerdicts: 1, liveClock: clock },
      (async function* () { for (const event of events) yield event; })(),
    );
    const entries = readRunJournalEntries(workspaceDir, "draft-1");
    expect(entries).toEqual([{ kind: "cell-event", at: "2026-08-05T00:00:00Z", event: events[0] }]);
  });

  test("a non-error event (e.g. dispatch) never calls observe() for blame", async () => {
    const clock = makeClock();
    const backend = makeFakeBackend({}); // observe() would throw if reached.
    const events: CellStatusEvent[] = [
      { cellKey: CELL_A, armId: "arm-a", replicate: 1, dispatch: 1, kind: "dispatch", attempt: "att-1" },
    ];
    await expect(
      driveCellEvents(
        { workspaceDir, draftId: "draft-1", venue: fakeVenue({ taskBytes: new Uint8Array(), taskSha256: "0".repeat(64) }), backend, runSha256: "r".repeat(64), owner: "urn:uuid:owner", cellWindowMs: 3_600_000, minVerdicts: 1, liveClock: clock },
        (async function* () { for (const event of events) yield event; })(),
      ),
    ).resolves.toBeUndefined();
  });
});

describe("driveCellEvents — delivered terminal drives the evaluation leg end to end", () => {
  test("success: delivery journaled, evaluation dispatched, verdict journaled", async () => {
    const clock = makeClock();
    const { taskSha256 } = storeSubjectTaskAndSpec();
    const cellKey = `${taskSha256}/arm-a/1`;

    const solveDeliveryDigestHex = "d".repeat(64);
    const predictionArtifactHex = "e".repeat(64);
    const evalDeliveryDigestHex = "1".repeat(64);
    const verdictEnvelopeHex = "2".repeat(64);

    const solveDeliveryBytes = utf8({ outputs: [{ name: "prediction", digest: { sha256: predictionArtifactHex } }] });
    const predictionBytes = utf8({ probabilityYes: "0.5" });
    const evalDeliveryBytes = utf8({ outputs: [{ name: "verdict", digest: { sha256: verdictEnvelopeHex } }] });
    const verdictEnvelopeBytes = utf8({ envelope: true });

    const submits: { taskBytes: Uint8Array; submissionBytes: Uint8Array }[] = [];
    const backend = makeFakeBackend({
      deliveriesByAttempt: {
        "att-solve-1": [fakeDeliveryRef("att-solve-1", solveDeliveryDigestHex)],
        "att-eval-1": [fakeDeliveryRef("att-eval-1", evalDeliveryDigestHex)],
      },
      deliveryBytesByDigest: {
        [`sha256:${solveDeliveryDigestHex}`]: solveDeliveryBytes,
        [`sha256:${evalDeliveryDigestHex}`]: evalDeliveryBytes,
      },
      artifactBytesByDigest: {
        [predictionArtifactHex]: predictionBytes,
        [verdictEnvelopeHex]: verdictEnvelopeBytes,
      },
      submitResult: { accepted: true, submission: "urn:uuid:00000000-0000-4000-8000-0000000000ee" as SubmissionUri, digest: `sha256:${"f".repeat(64)}` },
      observeResult: fakeSnapshot("att-eval-1", "delivered"),
      calls: { submits },
    });

    const preparedTaskBytes = new Uint8Array([1, 2, 3]);
    const preparedTaskSha256 = sha256Hex(preparedTaskBytes);
    const venue = fakeVenue({ taskBytes: preparedTaskBytes, taskSha256: preparedTaskSha256 });

    const events: CellStatusEvent[] = [
      { cellKey, armId: "arm-a", replicate: 1, dispatch: 1, kind: "delivered", attempt: "att-solve-1" },
    ];
    await driveCellEvents(
      { workspaceDir, draftId: "draft-1", venue, backend, runSha256: "r".repeat(64), owner: "urn:uuid:owner-1", cellWindowMs: 3_600_000, minVerdicts: 1, liveClock: clock },
      (async function* () { for (const event of events) yield event; })(),
    );

    const entries = readRunJournalEntries(workspaceDir, "draft-1");
    expect(entries.map((entry) => entry.kind)).toEqual(["cell-event", "delivery", "evaluation"]);

    const deliveryEntry = entries.find((entry) => entry.kind === "delivery");
    expect(deliveryEntry).toMatchObject({ cellKey, dispatch: 1, attempt: "att-solve-1" });
    if (deliveryEntry?.kind === "delivery") {
      expect(deliveryEntry.outputs).toEqual([{ name: "prediction", sha256: sha256Hex(predictionBytes) }]);
      expect(deliveryEntry.deliverySha256).toBe(sha256Hex(solveDeliveryBytes));
    }

    const evaluationEntry = entries.find((entry) => entry.kind === "evaluation");
    expect(evaluationEntry).toMatchObject({ cellKey, evalTaskSha256: preparedTaskSha256, evalAttempt: "att-eval-1" });
    if (evaluationEntry?.kind === "evaluation") {
      expect(evaluationEntry.evalDeliverySha256).toBe(sha256Hex(evalDeliveryBytes));
      expect(evaluationEntry.verdictSha256).toBe(sha256Hex(verdictEnvelopeBytes));
      expect(evaluationEntry.evaluationTerminal).toBeUndefined();
    }

    // BP-40: future public bundles must carry the exact derived evaluation Task and its
    // evaluation Delivery without scraping the backend's mutable internal state.
    expect(getSealedBytes(workspaceDir, preparedTaskSha256)).toEqual(preparedTaskBytes);
    expect(getSealedBytes(workspaceDir, sha256Hex(evalDeliveryBytes))).toEqual(evalDeliveryBytes);

    // Exactly one Submission was sealed and submitted for the evaluation leg, pinning EVALUATION_HARNESS_PIN.
    expect(submits).toHaveLength(1);
    const submittedDoc = JSON.parse(new TextDecoder().decode(submits[0]!.submissionBytes)) as { requirements?: { harness?: unknown }; requester?: string };
    expect(submittedDoc.requirements?.harness).toEqual({ id: "evaluation-harness", version: "0.1.0" });
    expect(submittedDoc.requester).toBe("urn:uuid:owner-1");
  });

  test("owned local capture authors solve Delivery, execution evidence, eval Delivery, and verdict", async () => {
    const clock = makeClock();
    const { taskSha256 } = storeSubjectTaskAndSpec();
    const cellKey = `${taskSha256}/arm-a/1`;
    const evidenceBytes = utf8({ locallyRecordedExecution: true });
    const evidenceSha256 = putSealedBytes(workspaceDir, evidenceBytes);
    const predictionBytes = utf8({ probabilityYes: "0.5" });
    const predictionSha256 = sha256Hex(predictionBytes);
    const verdictBytes = utf8({ locallyProducedVerdict: true });
    const verdictSha256 = sha256Hex(verdictBytes);
    const solveDeliveryBytes = sealDelivery({
      protocol: "https://spec.jinn.network/profiles/task-execution/v1",
      attempt: "urn:uuid:00000000-0000-4000-8000-000000000101",
      task: `sha256:${taskSha256}`,
      outputs: [{ name: "prediction", mediaType: "application/json", digest: { sha256: predictionSha256 } }],
      outcome: "fulfilled",
      evidenceRecords: [{ family: "execution-evidence", digest: `sha256:${evidenceSha256}` }],
      createdAt: "2026-08-05T00:00:00Z",
    });
    const evalDeliveryBytes = sealDelivery({
      protocol: "https://spec.jinn.network/profiles/task-execution/v1",
      attempt: "urn:uuid:00000000-0000-4000-8000-000000000102",
      task: `sha256:${taskSha256}`,
      outputs: [{ name: "verdict", mediaType: "application/vnd.dsse.envelope.v1+json", digest: { sha256: verdictSha256 } }],
      outcome: "fulfilled",
      evidenceRecords: [{ family: "result-evaluation", digest: `sha256:${verdictSha256}` }],
      createdAt: "2026-08-05T00:00:01Z",
    });
    const solveDeliverySha256 = sha256Hex(solveDeliveryBytes);
    const evalDeliverySha256 = sha256Hex(evalDeliveryBytes);
    const preparedTaskBytes = new Uint8Array([1, 2, 3]);
    const backend = makeFakeBackend({
      deliveriesByAttempt: {
        "urn:uuid:00000000-0000-4000-8000-000000000101": [fakeDeliveryRef("urn:uuid:00000000-0000-4000-8000-000000000101", solveDeliverySha256)],
        "urn:uuid:00000000-0000-4000-8000-000000000102": [fakeDeliveryRef("urn:uuid:00000000-0000-4000-8000-000000000102", evalDeliverySha256)],
      },
      deliveryBytesByDigest: {
        [`sha256:${solveDeliverySha256}`]: solveDeliveryBytes,
        [`sha256:${evalDeliverySha256}`]: evalDeliveryBytes,
      },
      artifactBytesByDigest: { [predictionSha256]: predictionBytes, [verdictSha256]: verdictBytes },
      submitResult: { accepted: true, submission: "urn:uuid:00000000-0000-4000-8000-000000000199" as SubmissionUri, digest: `sha256:${"f".repeat(64)}` },
      observeResult: fakeSnapshot("urn:uuid:00000000-0000-4000-8000-000000000102", "delivered"),
    });
    await driveCellEvents(
      { workspaceDir, draftId: "draft-1", venue: ownedFakeVenue({ taskBytes: preparedTaskBytes, taskSha256: sha256Hex(preparedTaskBytes) }), backend, runSha256: "r".repeat(64), owner: "urn:uuid:owner-1", cellWindowMs: 3_600_000, minVerdicts: 1, liveClock: clock },
      (async function* () { yield { cellKey, armId: "arm-a", replicate: 1, dispatch: 1, kind: "delivered", attempt: "urn:uuid:00000000-0000-4000-8000-000000000101" } as CellStatusEvent; })(),
    );
    const author = loadOrCreateReportSigningKey(workspaceDir).keyId;
    for (const [recordSha256, recordKind] of [
      [solveDeliverySha256, RECORD_KINDS.delivery],
      [evidenceSha256, RECORD_KINDS.executionEvidence],
      [evalDeliverySha256, RECORD_KINDS.delivery],
      [verdictSha256, RECORD_KINDS.resultEvaluation],
    ] as const) {
      expect(requireWorkspaceAuthorship({ workspaceDir, recordSha256, recordKind, author }).digestHex).toMatch(/^[a-f0-9]{64}$/u);
    }
  });

  test.each(["missing", "tampered"] as const)("%s owned execution evidence refuses before Delivery journal", async (mode) => {
    const clock = makeClock();
    const { taskSha256 } = storeSubjectTaskAndSpec();
    const cellKey = `${taskSha256}/arm-a/1`;
    const evidenceSha256 = "a".repeat(64);
    if (mode === "tampered") writeFileSync(sealedRecordPath(workspaceDir, evidenceSha256), "wrong bytes");
    const solveDeliveryBytes = sealDelivery({
      protocol: "https://spec.jinn.network/profiles/task-execution/v1",
      attempt: "urn:uuid:00000000-0000-4000-8000-000000000201",
      task: `sha256:${taskSha256}`,
      outputs: [], outcome: "fulfilled",
      evidenceRecords: [{ family: "execution-evidence", digest: `sha256:${evidenceSha256}` }],
      createdAt: "2026-08-05T00:00:00Z",
    });
    const solveDeliverySha256 = sha256Hex(solveDeliveryBytes);
    const preparedTaskBytes = new Uint8Array([1, 2, 3]);
    const backend = makeFakeBackend({
      deliveriesByAttempt: { "urn:uuid:00000000-0000-4000-8000-000000000201": [fakeDeliveryRef("urn:uuid:00000000-0000-4000-8000-000000000201", solveDeliverySha256)] },
      deliveryBytesByDigest: { [`sha256:${solveDeliverySha256}`]: solveDeliveryBytes },
    });
    await driveCellEvents(
      { workspaceDir, draftId: "draft-1", venue: ownedFakeVenue({ taskBytes: preparedTaskBytes, taskSha256: sha256Hex(preparedTaskBytes) }), backend, runSha256: "r".repeat(64), owner: "urn:uuid:owner-1", cellWindowMs: 3_600_000, minVerdicts: 1, liveClock: clock },
      (async function* () { yield { cellKey, armId: "arm-a", replicate: 1, dispatch: 1, kind: "delivered", attempt: "urn:uuid:00000000-0000-4000-8000-000000000201" } as CellStatusEvent; })(),
    );
    const entries = readRunJournalEntries(workspaceDir, "draft-1");
    expect(entries.some((entry) => entry.kind === "delivery")).toBe(false);
    expect(entries.find((entry) => entry.kind === "evaluation")).toMatchObject({ evaluationTerminal: "could-not-grade" });
  });

  test("no attempt on the delivered event -> could-not-grade, no crash", async () => {
    const clock = makeClock();
    const backend = makeFakeBackend({});
    const events: CellStatusEvent[] = [
      { cellKey: CELL_A, armId: "arm-a", replicate: 1, dispatch: 1, kind: "delivered" },
    ];
    await driveCellEvents(
      { workspaceDir, draftId: "draft-1", venue: fakeVenue({ taskBytes: new Uint8Array(), taskSha256: "0".repeat(64) }), backend, runSha256: "r".repeat(64), owner: "urn:uuid:owner", cellWindowMs: 3_600_000, minVerdicts: 1, liveClock: clock },
      (async function* () { for (const event of events) yield event; })(),
    );
    const entries = readRunJournalEntries(workspaceDir, "draft-1");
    const evaluationEntry = entries.find((entry) => entry.kind === "evaluation");
    expect(evaluationEntry).toMatchObject({ evaluationTerminal: "could-not-grade" });
  });

  test("no Delivery recorded for the attempt -> could-not-grade", async () => {
    const clock = makeClock();
    const backend = makeFakeBackend({ deliveriesByAttempt: { "att-solve-1": [] } });
    const events: CellStatusEvent[] = [
      { cellKey: CELL_A, armId: "arm-a", replicate: 1, dispatch: 1, kind: "delivered", attempt: "att-solve-1" },
    ];
    await driveCellEvents(
      { workspaceDir, draftId: "draft-1", venue: fakeVenue({ taskBytes: new Uint8Array(), taskSha256: "0".repeat(64) }), backend, runSha256: "r".repeat(64), owner: "urn:uuid:owner", cellWindowMs: 3_600_000, minVerdicts: 1, liveClock: clock },
      (async function* () { for (const event of events) yield event; })(),
    );
    const entries = readRunJournalEntries(workspaceDir, "draft-1");
    const evaluationEntry = entries.find((entry) => entry.kind === "evaluation");
    expect(evaluationEntry).toMatchObject({ evaluationTerminal: "could-not-grade", detail: expect.stringContaining("no Delivery recorded") });
  });

  test("subject task carries no bound EvaluationSpec -> could-not-grade (no crash)", async () => {
    const clock = makeClock();
    const taskBytes = sealTask({
      protocol: "https://spec.jinn.network/profiles/task-execution/v1",
      profile: { digest: { sha256: "1".repeat(64) } },
      instructions: "predict",
      outputs: [{ name: "prediction", mediaType: "application/json", required: true }],
    });
    const taskSha256 = putSealedBytes(workspaceDir, taskBytes);
    const cellKey = `${taskSha256}/arm-a/1`;

    const solveDeliveryDigestHex = "d".repeat(64);
    const predictionArtifactHex = "e".repeat(64);
    const solveDeliveryBytes = utf8({ outputs: [{ name: "prediction", digest: { sha256: predictionArtifactHex } }] });
    const backend = makeFakeBackend({
      deliveriesByAttempt: { "att-solve-1": [fakeDeliveryRef("att-solve-1", solveDeliveryDigestHex)] },
      deliveryBytesByDigest: { [`sha256:${solveDeliveryDigestHex}`]: solveDeliveryBytes },
      artifactBytesByDigest: { [predictionArtifactHex]: utf8({ probabilityYes: "0.5" }) },
    });
    const events: CellStatusEvent[] = [
      { cellKey, armId: "arm-a", replicate: 1, dispatch: 1, kind: "delivered", attempt: "att-solve-1" },
    ];
    await driveCellEvents(
      { workspaceDir, draftId: "draft-1", venue: fakeVenue({ taskBytes: new Uint8Array(), taskSha256: "0".repeat(64) }), backend, runSha256: "r".repeat(64), owner: "urn:uuid:owner", cellWindowMs: 3_600_000, minVerdicts: 1, liveClock: clock },
      (async function* () { for (const event of events) yield event; })(),
    );
    const entries = readRunJournalEntries(workspaceDir, "draft-1");
    const evaluationEntry = entries.find((entry) => entry.kind === "evaluation");
    expect(evaluationEntry).toMatchObject({ evaluationTerminal: "could-not-grade", detail: expect.stringContaining("EvaluationSpec") });
    // The delivery WAS still journaled — only the evaluation leg failed.
    expect(entries.find((entry) => entry.kind === "delivery")).toBeDefined();
  });

  test("async evaluation preparation failure -> one could-not-grade terminal per evaluator leg", async () => {
    const clock = makeClock();
    const { taskSha256 } = storeSubjectTaskAndSpec();
    const cellKey = `${taskSha256}/arm-a/1`;
    const solveDeliveryDigestHex = "d".repeat(64);
    const predictionArtifactHex = "e".repeat(64);
    const backend = makeFakeBackend({
      deliveriesByAttempt: { "att-solve-1": [fakeDeliveryRef("att-solve-1", solveDeliveryDigestHex)] },
      deliveryBytesByDigest: {
        [`sha256:${solveDeliveryDigestHex}`]: utf8({
          outputs: [{ name: "prediction", digest: { sha256: predictionArtifactHex } }],
        }),
      },
      artifactBytesByDigest: { [predictionArtifactHex]: utf8({ probabilityYes: "0.5" }) },
    });
    const failingVenue = fakeVenue({ taskBytes: new Uint8Array(), taskSha256: "0".repeat(64) }, 2);
    failingVenue.prepareEvaluationCell = async () => {
      throw new Error("pinned grader image is unavailable");
    };

    await driveCellEvents(
      {
        workspaceDir,
        draftId: "draft-1",
        venue: failingVenue,
        backend,
        runSha256: "r".repeat(64),
        owner: "urn:uuid:owner",
        cellWindowMs: 3_600_000,
        minVerdicts: 2,
        liveClock: clock,
      },
      (async function* () {
        yield { cellKey, armId: "arm-a", replicate: 1, dispatch: 1, kind: "delivered", attempt: "att-solve-1" } as CellStatusEvent;
      })(),
    );

    expect(readRunJournalEntries(workspaceDir, "draft-1").filter((entry) => entry.kind === "evaluation"))
      .toEqual([
        expect.objectContaining({
          evaluationTerminal: "could-not-grade",
          detail: "pinned grader image is unavailable",
          evalIndex: 1,
        }),
        expect.objectContaining({
          evaluationTerminal: "could-not-grade",
          detail: "pinned grader image is unavailable",
          evalIndex: 2,
        }),
      ]);
  });

  test("evaluation submission rejected by the backend -> could-not-grade with the backend's detail", async () => {
    const clock = makeClock();
    const { taskSha256 } = storeSubjectTaskAndSpec();
    const cellKey = `${taskSha256}/arm-a/1`;
    const solveDeliveryDigestHex = "d".repeat(64);
    const predictionArtifactHex = "e".repeat(64);
    const backend = makeFakeBackend({
      deliveriesByAttempt: { "att-solve-1": [fakeDeliveryRef("att-solve-1", solveDeliveryDigestHex)] },
      deliveryBytesByDigest: { [`sha256:${solveDeliveryDigestHex}`]: utf8({ outputs: [{ name: "prediction", digest: { sha256: predictionArtifactHex } }] }) },
      artifactBytesByDigest: { [predictionArtifactHex]: utf8({ probabilityYes: "0.5" }) },
      submitResult: { accepted: false, error: { category: "unsupported-requirement", detail: "no evaluation-harness deployment" } as never },
    });
    const events: CellStatusEvent[] = [
      { cellKey, armId: "arm-a", replicate: 1, dispatch: 1, kind: "delivered", attempt: "att-solve-1" },
    ];
    await driveCellEvents(
      { workspaceDir, draftId: "draft-1", venue: fakeVenue({ taskBytes: new Uint8Array([9]), taskSha256: "9".repeat(64) }), backend, runSha256: "r".repeat(64), owner: "urn:uuid:owner", cellWindowMs: 3_600_000, minVerdicts: 1, liveClock: clock },
      (async function* () { for (const event of events) yield event; })(),
    );
    const entries = readRunJournalEntries(workspaceDir, "draft-1");
    const evaluationEntry = entries.find((entry) => entry.kind === "evaluation");
    expect(evaluationEntry).toMatchObject({ evaluationTerminal: "could-not-grade", detail: "no evaluation-harness deployment", evalTaskSha256: sha256Hex(new Uint8Array([9])) });
  });

  test("a non-retryable evaluation failure (the integrity split, spec §5.2) never retries even with budget available", async () => {
    const clock = makeClock();
    const { taskSha256 } = storeSubjectTaskAndSpec();
    const cellKey = `${taskSha256}/arm-a/1`;
    const solveDeliveryDigestHex = "d".repeat(64);
    const predictionArtifactHex = "e".repeat(64);
    const backend = makeFakeBackend({
      deliveriesByAttempt: { "att-solve-1": [fakeDeliveryRef("att-solve-1", solveDeliveryDigestHex)] },
      deliveryBytesByDigest: { [`sha256:${solveDeliveryDigestHex}`]: utf8({ outputs: [{ name: "prediction", digest: { sha256: predictionArtifactHex } }] }) },
      artifactBytesByDigest: { [predictionArtifactHex]: utf8({ probabilityYes: "0.5" }) },
      // "content-corruption" is outside RETRYABLE_EVALUATION_CATEGORY_VALUES (drive.ts) — an
      // integrity failure, not an infrastructure outage.
      submitResult: {
        accepted: false,
        error: new TaskExecutionError("content-corruption", { detail: "subject digest mismatch" }),
      },
    });
    const events: CellStatusEvent[] = [
      { cellKey, armId: "arm-a", replicate: 1, dispatch: 1, kind: "delivered", attempt: "att-solve-1" },
    ];
    await driveCellEvents(
      {
        workspaceDir,
        draftId: "draft-1",
        venue: fakeVenue({ taskBytes: new Uint8Array([9]), taskSha256: "9".repeat(64) }),
        backend,
        runSha256: "r".repeat(64),
        owner: "urn:uuid:owner",
        cellWindowMs: 3_600_000,
        minVerdicts: 1,
        // The retry budget is available — the point is it goes demonstrably unspent (§5.2: "an
        // integrity failure that gets a retry is an integrity failure that gets a second chance
        // to pass, which defeats the check").
        maxInfrastructureRetries: 1 as const,
        liveClock: clock,
      },
      (async function* () { for (const event of events) yield event; })(),
    );

    const entries = readRunJournalEntries(workspaceDir, "draft-1");
    expect(entries.filter((entry) => entry.kind === "evaluation-retryable-failure")).toHaveLength(0);
    const evaluationEntries = entries.filter((entry) => entry.kind === "evaluation");
    expect(evaluationEntries).toHaveLength(1);
    expect(evaluationEntries[0]).toMatchObject({
      cellKey,
      evaluationTerminal: "could-not-grade",
      detail: "subject digest mismatch",
    });
    // Observed spec-vs-code divergence (report, don't fix): §5.2 says a do-not-retry terminal is
    // "could-not-grade with failureCategory recorded". journalCouldNotGrade only ever sets
    // failureCategory from a RETRYABLE failure's own category (journalEvaluationFailure's
    // `retryable` branch); a category outside the retryable three carries no `retryable` value at
    // all, so failureCategory is absent here, not recorded.
    expect(evaluationEntries[0] && "failureCategory" in evaluationEntries[0]).toBe(false);

    // The leg is closed: nothing will re-attempt it, even though the retry budget was never spent.
    expect(evaluationGaps(foldRunJournal(entries), 1, 1)).toEqual([]);
  });

  test("evaluation attempt reaches a non-delivered terminal -> could-not-grade naming the state", async () => {
    const clock = makeClock();
    const { taskSha256 } = storeSubjectTaskAndSpec();
    const cellKey = `${taskSha256}/arm-a/1`;
    const solveDeliveryDigestHex = "d".repeat(64);
    const predictionArtifactHex = "e".repeat(64);
    const backend = makeFakeBackend({
      deliveriesByAttempt: { "att-solve-1": [fakeDeliveryRef("att-solve-1", solveDeliveryDigestHex)] },
      deliveryBytesByDigest: { [`sha256:${solveDeliveryDigestHex}`]: utf8({ outputs: [{ name: "prediction", digest: { sha256: predictionArtifactHex } }] }) },
      artifactBytesByDigest: { [predictionArtifactHex]: utf8({ probabilityYes: "0.5" }) },
      observeResult: fakeSnapshot("att-eval-1", "failed"),
    });
    const events: CellStatusEvent[] = [
      { cellKey, armId: "arm-a", replicate: 1, dispatch: 1, kind: "delivered", attempt: "att-solve-1" },
    ];
    await driveCellEvents(
      { workspaceDir, draftId: "draft-1", venue: fakeVenue({ taskBytes: new Uint8Array([9]), taskSha256: "9".repeat(64) }), backend, runSha256: "r".repeat(64), owner: "urn:uuid:owner", cellWindowMs: 3_600_000, minVerdicts: 1, liveClock: clock },
      (async function* () { for (const event of events) yield event; })(),
    );
    const entries = readRunJournalEntries(workspaceDir, "draft-1");
    const evaluationEntry = entries.find((entry) => entry.kind === "evaluation");
    expect(evaluationEntry).toMatchObject({ evaluationTerminal: "could-not-grade", detail: expect.stringContaining("failed"), evalAttempt: "att-eval-1" });
  });
});

describe("driveCellEvents — onProgress (BP-13, purely additive)", () => {
  test("a dispatch event with no onProgress supplied journals exactly as before (byte-identical)", async () => {
    const clock = makeClock();
    const backend = makeFakeBackend({});
    const events: CellStatusEvent[] = [
      { cellKey: CELL_A, armId: "arm-a", replicate: 1, dispatch: 1, kind: "dispatch", attempt: "att-1" },
    ];
    await driveCellEvents(
      { workspaceDir, draftId: "draft-1", venue: fakeVenue({ taskBytes: new Uint8Array(), taskSha256: "0".repeat(64) }), backend, runSha256: "r".repeat(64), owner: "urn:uuid:owner", cellWindowMs: 3_600_000, minVerdicts: 1, liveClock: clock },
      (async function* () { for (const event of events) yield event; })(),
    );
    const entries = readRunJournalEntries(workspaceDir, "draft-1");
    expect(entries).toEqual([{ kind: "cell-event", at: "2026-08-05T00:00:00Z", event: events[0] }]);
  });

  test("delivered + judged: onProgress sees exactly one line per cell-event, then one 'judged' line", async () => {
    const clock = makeClock();
    const { taskSha256 } = storeSubjectTaskAndSpec();
    const cellKey = `${taskSha256}/arm-a/1`;

    const solveDeliveryDigestHex = "d".repeat(64);
    const predictionArtifactHex = "e".repeat(64);
    const evalDeliveryDigestHex = "1".repeat(64);
    const verdictEnvelopeHex = "2".repeat(64);
    const backend = makeFakeBackend({
      deliveriesByAttempt: {
        "att-solve-1": [fakeDeliveryRef("att-solve-1", solveDeliveryDigestHex)],
        "att-eval-1": [fakeDeliveryRef("att-eval-1", evalDeliveryDigestHex)],
      },
      deliveryBytesByDigest: {
        [`sha256:${solveDeliveryDigestHex}`]: utf8({ outputs: [{ name: "prediction", digest: { sha256: predictionArtifactHex } }] }),
        [`sha256:${evalDeliveryDigestHex}`]: utf8({ outputs: [{ name: "verdict", digest: { sha256: verdictEnvelopeHex } }] }),
      },
      artifactBytesByDigest: {
        [predictionArtifactHex]: utf8({ probabilityYes: "0.5" }),
        [verdictEnvelopeHex]: utf8({ envelope: true }),
      },
      observeResult: fakeSnapshot("att-eval-1", "delivered"),
    });
    const venue = fakeVenue({ taskBytes: new Uint8Array([1, 2, 3]), taskSha256: sha256Hex(new Uint8Array([1, 2, 3])) });
    const events: CellStatusEvent[] = [
      { cellKey, armId: "arm-a", replicate: 1, dispatch: 1, kind: "delivered", attempt: "att-solve-1" },
    ];
    const lines: string[] = [];

    await driveCellEvents(
      { workspaceDir, draftId: "draft-1", venue, backend, runSha256: "r".repeat(64), owner: "urn:uuid:owner-1", cellWindowMs: 3_600_000, minVerdicts: 1, liveClock: clock, onProgress: (line) => lines.push(line) },
      (async function* () { for (const event of events) yield event; })(),
    );

    expect(lines).toEqual([`${cellKey} delivered`, `${cellKey} judged`]);
  });

  test("delivered + could-not-grade (no attempt on the event): onProgress sees the could-not-grade line", async () => {
    const clock = makeClock();
    const backend = makeFakeBackend({});
    const events: CellStatusEvent[] = [
      { cellKey: CELL_A, armId: "arm-a", replicate: 1, dispatch: 1, kind: "delivered" },
    ];
    const lines: string[] = [];

    await driveCellEvents(
      { workspaceDir, draftId: "draft-1", venue: fakeVenue({ taskBytes: new Uint8Array(), taskSha256: "0".repeat(64) }), backend, runSha256: "r".repeat(64), owner: "urn:uuid:owner", cellWindowMs: 3_600_000, minVerdicts: 1, liveClock: clock, onProgress: (line) => lines.push(line) },
      (async function* () { for (const event of events) yield event; })(),
    );

    expect(lines).toEqual([`${CELL_A} delivered`, `${CELL_A} could-not-grade`]);
  });

  test("an onProgress that always throws does not prevent the drive from completing and journaling normally", async () => {
    const clock = makeClock();
    const { taskSha256 } = storeSubjectTaskAndSpec();
    const cellKey = `${taskSha256}/arm-a/1`;

    const solveDeliveryDigestHex = "d".repeat(64);
    const predictionArtifactHex = "e".repeat(64);
    const evalDeliveryDigestHex = "1".repeat(64);
    const verdictEnvelopeHex = "2".repeat(64);
    const backend = makeFakeBackend({
      deliveriesByAttempt: {
        "att-solve-1": [fakeDeliveryRef("att-solve-1", solveDeliveryDigestHex)],
        "att-eval-1": [fakeDeliveryRef("att-eval-1", evalDeliveryDigestHex)],
      },
      deliveryBytesByDigest: {
        [`sha256:${solveDeliveryDigestHex}`]: utf8({ outputs: [{ name: "prediction", digest: { sha256: predictionArtifactHex } }] }),
        [`sha256:${evalDeliveryDigestHex}`]: utf8({ outputs: [{ name: "verdict", digest: { sha256: verdictEnvelopeHex } }] }),
      },
      artifactBytesByDigest: {
        [predictionArtifactHex]: utf8({ probabilityYes: "0.5" }),
        [verdictEnvelopeHex]: utf8({ envelope: true }),
      },
      observeResult: fakeSnapshot("att-eval-1", "delivered"),
    });
    const venue = fakeVenue({ taskBytes: new Uint8Array([1, 2, 3]), taskSha256: sha256Hex(new Uint8Array([1, 2, 3])) });
    const events: CellStatusEvent[] = [
      { cellKey, armId: "arm-a", replicate: 1, dispatch: 1, kind: "delivered", attempt: "att-solve-1" },
    ];
    let onProgressCalls = 0;
    const throwingOnProgress = (): void => {
      onProgressCalls += 1;
      throw new Error("EPIPE: simulated broken diagnostic sink");
    };

    await expect(
      driveCellEvents(
        { workspaceDir, draftId: "draft-1", venue, backend, runSha256: "r".repeat(64), owner: "urn:uuid:owner-1", cellWindowMs: 3_600_000, minVerdicts: 1, liveClock: clock, onProgress: throwingOnProgress },
        (async function* () { for (const event of events) yield event; })(),
      ),
    ).resolves.toBeUndefined();

    // The sink was actually exercised (and threw) at least twice — once for the cell-event,
    // once for the "judged" evaluation terminal — yet the drive completed and journaled as if
    // no onProgress had been supplied at all.
    expect(onProgressCalls).toBeGreaterThanOrEqual(2);

    const entries = readRunJournalEntries(workspaceDir, "draft-1");
    expect(entries.some((entry) => entry.kind === "cell-event")).toBe(true);
    expect(entries.some((entry) => entry.kind === "delivery")).toBe(true);
    expect(entries.some((entry) => entry.kind === "evaluation" && "verdictSha256" in entry)).toBe(true);
  });
});

/** Scripts a backend where BOTH evaluation legs deliver the same verdict envelope — enough to
 * exercise the per-leg dispatch bookkeeping (keys, evaluator requirements, journal entries)
 * without a stateful fake. */
function makeTwoLegBackend(submits: { taskBytes: Uint8Array; submissionBytes: Uint8Array }[]): ProxiedBackend {
  const solveDeliveryDigestHex = "d".repeat(64);
  const predictionArtifactHex = "e".repeat(64);
  const evalDeliveryDigestHex = "1".repeat(64);
  const verdictEnvelopeHex = "2".repeat(64);
  return makeFakeBackend({
    deliveriesByAttempt: {
      "att-solve-1": [fakeDeliveryRef("att-solve-1", solveDeliveryDigestHex)],
      "att-eval-1": [fakeDeliveryRef("att-eval-1", evalDeliveryDigestHex)],
    },
    deliveryBytesByDigest: {
      [`sha256:${solveDeliveryDigestHex}`]: utf8({ outputs: [{ name: "prediction", digest: { sha256: predictionArtifactHex } }] }),
      [`sha256:${evalDeliveryDigestHex}`]: utf8({ outputs: [{ name: "verdict", digest: { sha256: verdictEnvelopeHex } }] }),
    },
    artifactBytesByDigest: {
      [predictionArtifactHex]: utf8({ probabilityYes: "0.5" }),
      [verdictEnvelopeHex]: utf8({ envelope: true }),
    },
    observeResult: fakeSnapshot("att-eval-1", "delivered"),
    calls: { submits },
  });
}

describe("driveCellEvents — minVerdicts > 1 dispatches one evaluation leg per evaluator (BP-21)", () => {
  test("two legs: distinct idempotency keys, distinct evaluator requirements, both verdicts journaled with evaluator + evalIndex", async () => {
    const clock = makeClock();
    const { taskSha256 } = storeSubjectTaskAndSpec();
    const cellKey = `${taskSha256}/arm-a/1`;
    const submits: { taskBytes: Uint8Array; submissionBytes: Uint8Array }[] = [];
    const backend = makeTwoLegBackend(submits);
    const venue = fakeVenue({ taskBytes: new Uint8Array([1, 2, 3]), taskSha256: sha256Hex(new Uint8Array([1, 2, 3])) }, 2);
    const runSha256 = "r".repeat(64);
    const lines: string[] = [];

    const events: CellStatusEvent[] = [
      { cellKey, armId: "arm-a", replicate: 1, dispatch: 1, kind: "delivered", attempt: "att-solve-1" },
    ];
    await driveCellEvents(
      { workspaceDir, draftId: "draft-1", venue, backend, runSha256, owner: "urn:uuid:owner-1", cellWindowMs: 3_600_000, minVerdicts: 2, liveClock: clock, onProgress: (line) => lines.push(line) },
      (async function* () { for (const event of events) yield event; })(),
    );

    // Exactly two evaluation Submissions, one per leg, with leg-distinct keys and evaluators.
    expect(submits).toHaveLength(2);
    const docs = submits.map((call) => JSON.parse(new TextDecoder().decode(call.submissionBytes)) as {
      idempotencyKey?: string;
      nonce?: string;
      requirements?: Record<string, unknown>;
    });
    expect(docs.map((doc) => doc.idempotencyKey)).toEqual([
      `eval:${runSha256}:e1:${cellKey}:1`,
      `eval:${runSha256}:e2:${cellKey}:1`,
    ]);
    expect(docs.map((doc) => doc.nonce)).toEqual(docs.map((doc) => doc.idempotencyKey));
    expect(docs.map((doc) => doc.requirements?.[EVALUATOR_REQUIREMENT_KEY])).toEqual([
      evaluatorIri(1),
      evaluatorIri(2),
    ]);
    for (const doc of docs) {
      expect(doc.requirements?.["harness"]).toEqual({ id: "evaluation-harness", version: "0.1.0" });
    }

    const entries = readRunJournalEntries(workspaceDir, "draft-1");
    const evaluationEntries = entries.filter((entry) => entry.kind === "evaluation");
    expect(evaluationEntries).toHaveLength(2);
    expect(evaluationEntries[0]).toMatchObject({ cellKey, evaluator: evaluatorIri(1), evalIndex: 1 });
    expect(evaluationEntries[1]).toMatchObject({ cellKey, evaluator: evaluatorIri(2), evalIndex: 2 });
    expect(evaluationEntries.every((entry) => entry.kind === "evaluation" && entry.verdictSha256 !== undefined)).toBe(true);

    // Per-leg progress lines carry the e<i>/<n> suffix when minVerdicts > 1.
    expect(lines).toEqual([`${cellKey} delivered`, `${cellKey} judged e1/2`, `${cellKey} judged e2/2`]);
  });

  test("a failing leg journals could-not-grade for that leg only; the other leg still completes", async () => {
    const clock = makeClock();
    const { taskSha256 } = storeSubjectTaskAndSpec();
    const cellKey = `${taskSha256}/arm-a/1`;
    const submits: { taskBytes: Uint8Array; submissionBytes: Uint8Array }[] = [];
    const inner = makeTwoLegBackend(submits);
    let evalSubmitCount = 0;
    const backend: ProxiedBackend = {
      ...inner,
      submit: async (taskBytes, submissionBytes) => {
        evalSubmitCount += 1;
        if (evalSubmitCount === 1) {
          submits.push({ taskBytes, submissionBytes });
          return { accepted: false, error: { category: "execution", detail: "leg-1 rejected" } as never };
        }
        return inner.submit(taskBytes, submissionBytes);
      },
    };
    const venue = fakeVenue({ taskBytes: new Uint8Array([1, 2, 3]), taskSha256: sha256Hex(new Uint8Array([1, 2, 3])) }, 2);
    const lines: string[] = [];

    const events: CellStatusEvent[] = [
      { cellKey, armId: "arm-a", replicate: 1, dispatch: 1, kind: "delivered", attempt: "att-solve-1" },
    ];
    await driveCellEvents(
      { workspaceDir, draftId: "draft-1", venue, backend, runSha256: "r".repeat(64), owner: "urn:uuid:owner-1", cellWindowMs: 3_600_000, minVerdicts: 2, liveClock: clock, onProgress: (line) => lines.push(line) },
      (async function* () { for (const event of events) yield event; })(),
    );

    const entries = readRunJournalEntries(workspaceDir, "draft-1");
    const evaluationEntries = entries.filter((entry) => entry.kind === "evaluation");
    expect(evaluationEntries).toHaveLength(2);
    expect(evaluationEntries[0]).toMatchObject({
      cellKey,
      evaluationTerminal: "could-not-grade",
      detail: "leg-1 rejected",
      evaluator: evaluatorIri(1),
      evalIndex: 1,
    });
    expect(evaluationEntries[1]).toMatchObject({ cellKey, evaluator: evaluatorIri(2), evalIndex: 2 });
    expect(evaluationEntries[1]?.kind === "evaluation" && evaluationEntries[1].verdictSha256 !== undefined).toBe(true);

    expect(lines).toEqual([`${cellKey} delivered`, `${cellKey} could-not-grade e1/2`, `${cellKey} judged e2/2`]);
  });

  test("refuses loudly when the venue has fewer evaluator identities than minVerdicts (wiring bug)", async () => {
    const clock = makeClock();
    const backend = makeFakeBackend({});
    const venue = fakeVenue({ taskBytes: new Uint8Array(), taskSha256: "0".repeat(64) }, 1);

    await expect(
      driveCellEvents(
        { workspaceDir, draftId: "draft-1", venue, backend, runSha256: "r".repeat(64), owner: "urn:uuid:owner", cellWindowMs: 3_600_000, minVerdicts: 2, liveClock: clock },
        (async function* () {})(),
      ),
    ).rejects.toThrow(/evaluator/);
  });
});

describe("driveEvaluationCatchUp — resumes only the evaluation leg from stored delivery bytes", () => {
  test("re-derives and dispatches evaluation from an already-journaled delivery, no backend delivery re-fetch", async () => {
    const clock = makeClock();
    const { taskSha256 } = storeSubjectTaskAndSpec();
    const cellKey = `${taskSha256}/arm-a/1`;

    const solveDeliveryBytes = utf8({ outputs: [{ name: "prediction", digest: { sha256: "e".repeat(64) } }] });
    const deliverySha256 = putSealedBytes(workspaceDir, solveDeliveryBytes);
    const predictionBytes = utf8({ probabilityYes: "0.5" });
    const predictionSha256 = putSealedBytes(workspaceDir, predictionBytes);

    const evalDeliveryDigestHex = "1".repeat(64);
    const verdictEnvelopeHex = "2".repeat(64);
    const backend = makeFakeBackend({
      deliveriesByAttempt: { "att-eval-1": [fakeDeliveryRef("att-eval-1", evalDeliveryDigestHex)] },
      deliveryBytesByDigest: { [`sha256:${evalDeliveryDigestHex}`]: utf8({ outputs: [{ name: "verdict", digest: { sha256: verdictEnvelopeHex } }] }) },
      artifactBytesByDigest: { [verdictEnvelopeHex]: utf8({ envelope: true }) },
      observeResult: fakeSnapshot("att-eval-1", "delivered"),
    });
    const venue = fakeVenue({ taskBytes: new Uint8Array([4, 5]), taskSha256: "4".repeat(64) });

    await driveEvaluationCatchUp(
      { workspaceDir, draftId: "draft-1", venue, backend, runSha256: "r".repeat(64), owner: "urn:uuid:owner", cellWindowMs: 3_600_000, minVerdicts: 1, liveClock: clock },
      [{ cellKey, lastDispatch: 1, deliverySha256, deliveryOutputs: [{ name: "prediction", sha256: predictionSha256 }], missingEvalIndexes: [1] }],
    );

    const entries = readRunJournalEntries(workspaceDir, "draft-1");
    // No "delivery" entry is re-written — only the evaluation leg runs.
    expect(entries.map((entry) => entry.kind)).toEqual(["evaluation"]);
    expect(entries[0]).toMatchObject({ cellKey, evalTaskSha256: sha256Hex(new Uint8Array([4, 5])) });
  });

  test("heals a gap whose delivery entry was lost by re-harvesting the attempt, byte-exactly (#3081)", async () => {
    const clock = makeClock();
    const { taskSha256 } = storeSubjectTaskAndSpec();
    const cellKey = `${taskSha256}/arm-a/1`;

    const predictionDigestHex = "e".repeat(64);
    const predictionBytes = utf8({ probabilityYes: "0.5" });
    const solveDeliveryBytes = utf8({ outputs: [{ name: "prediction", digest: { sha256: predictionDigestHex } }] });
    const solveDeliveryDigestHex = "d".repeat(64);
    const evalDeliveryDigestHex = "1".repeat(64);
    const verdictEnvelopeHex = "2".repeat(64);
    const backend = makeFakeBackend({
      deliveriesByAttempt: {
        "att-solve-1": [fakeDeliveryRef("att-solve-1", solveDeliveryDigestHex)],
        "att-eval-1": [fakeDeliveryRef("att-eval-1", evalDeliveryDigestHex)],
      },
      deliveryBytesByDigest: {
        [`sha256:${solveDeliveryDigestHex}`]: solveDeliveryBytes,
        [`sha256:${evalDeliveryDigestHex}`]: utf8({ outputs: [{ name: "verdict", digest: { sha256: verdictEnvelopeHex } }] }),
      },
      artifactBytesByDigest: {
        [predictionDigestHex]: predictionBytes,
        [verdictEnvelopeHex]: utf8({ envelope: true }),
      },
      observeResult: fakeSnapshot("att-eval-1", "delivered"),
    });
    const venue = fakeVenue({ taskBytes: new Uint8Array([4, 5]), taskSha256: "4".repeat(64) });

    // The stranded shape: the cell's `delivered` cell-event named this attempt, and the crash
    // took the `delivery` entry that would have carried deliverySha256.
    await driveEvaluationCatchUp(
      { workspaceDir, draftId: "draft-1", venue, backend, runSha256: "r".repeat(64), owner: "urn:uuid:owner", cellWindowMs: 3_600_000, minVerdicts: 1, liveClock: clock },
      [{ cellKey, lastDispatch: 1, attempt: "att-solve-1", missingEvalIndexes: [1] }],
    );

    const entries = readRunJournalEntries(workspaceDir, "draft-1");
    // The lost delivery entry is written back FIRST, then the evaluation leg runs.
    expect(entries.map((entry) => entry.kind)).toEqual(["delivery", "evaluation"]);
    expect(entries[0]).toMatchObject({
      cellKey,
      dispatch: 1,
      attempt: "att-solve-1",
      // The attempt's own bytes, re-read and re-stored content-addressed — never re-minted.
      deliverySha256: sha256Hex(solveDeliveryBytes),
      outputs: [{ name: "prediction", sha256: sha256Hex(predictionBytes) }],
    });
    expect(getSealedBytes(workspaceDir, sha256Hex(solveDeliveryBytes))).toEqual(solveDeliveryBytes);
    expect(entries[1]).toMatchObject({ kind: "evaluation", cellKey, evalIndex: 1 });
    // A second catch-up now takes the ordinary already-journaled path: healing converges.
    expect(evaluationGaps(foldRunJournal(entries), 1)).toEqual([]);
  });

  test("a gap with neither a journaled delivery nor an attempt terminals could-not-grade (#3081)", async () => {
    const clock = makeClock();
    const { taskSha256 } = storeSubjectTaskAndSpec();
    const cellKey = `${taskSha256}/arm-a/1`;
    const backend = makeFakeBackend({});
    const venue = fakeVenue({ taskBytes: new Uint8Array([4, 5]), taskSha256: "4".repeat(64) });

    await driveEvaluationCatchUp(
      { workspaceDir, draftId: "draft-1", venue, backend, runSha256: "r".repeat(64), owner: "urn:uuid:owner", cellWindowMs: 3_600_000, minVerdicts: 1, liveClock: clock },
      [{ cellKey, lastDispatch: 1, missingEvalIndexes: [1] }],
    );

    // Accounted, not skipped — resume and collect must never disagree about what is outstanding.
    const entries = readRunJournalEntries(workspaceDir, "draft-1");
    expect(entries).toEqual([
      expect.objectContaining({
        kind: "evaluation",
        cellKey,
        evaluationTerminal: "could-not-grade",
        detail: "delivered cell has neither a journaled Delivery nor an attempt reference",
      }),
    ]);
  });

  test("catch-up with missingEvalIndexes [2] re-runs exactly leg 2 (BP-21)", async () => {
    const clock = makeClock();
    const { taskSha256 } = storeSubjectTaskAndSpec();
    const cellKey = `${taskSha256}/arm-a/1`;

    const solveDeliveryBytes = utf8({ outputs: [{ name: "prediction", digest: { sha256: "e".repeat(64) } }] });
    const deliverySha256 = putSealedBytes(workspaceDir, solveDeliveryBytes);
    const predictionBytes = utf8({ probabilityYes: "0.5" });
    const predictionSha256 = putSealedBytes(workspaceDir, predictionBytes);

    const evalDeliveryDigestHex = "1".repeat(64);
    const verdictEnvelopeHex = "2".repeat(64);
    const submits: { taskBytes: Uint8Array; submissionBytes: Uint8Array }[] = [];
    const backend = makeFakeBackend({
      deliveriesByAttempt: { "att-eval-1": [fakeDeliveryRef("att-eval-1", evalDeliveryDigestHex)] },
      deliveryBytesByDigest: { [`sha256:${evalDeliveryDigestHex}`]: utf8({ outputs: [{ name: "verdict", digest: { sha256: verdictEnvelopeHex } }] }) },
      artifactBytesByDigest: { [verdictEnvelopeHex]: utf8({ envelope: true }) },
      observeResult: fakeSnapshot("att-eval-1", "delivered"),
      calls: { submits },
    });
    const venue = fakeVenue({ taskBytes: new Uint8Array([4, 5]), taskSha256: "4".repeat(64) }, 2);
    const runSha256 = "r".repeat(64);

    await driveEvaluationCatchUp(
      { workspaceDir, draftId: "draft-1", venue, backend, runSha256, owner: "urn:uuid:owner", cellWindowMs: 3_600_000, minVerdicts: 2, liveClock: clock },
      [{ cellKey, lastDispatch: 1, deliverySha256, deliveryOutputs: [{ name: "prediction", sha256: predictionSha256 }], missingEvalIndexes: [2] }],
    );

    // Exactly ONE evaluation Submission — leg 2's, keyed and evaluator-pinned for leg 2.
    expect(submits).toHaveLength(1);
    const doc = JSON.parse(new TextDecoder().decode(submits[0]!.submissionBytes)) as {
      idempotencyKey?: string;
      requirements?: Record<string, unknown>;
    };
    expect(doc.idempotencyKey).toBe(`eval:${runSha256}:e2:${cellKey}:1`);
    expect(doc.requirements?.[EVALUATOR_REQUIREMENT_KEY]).toBe(evaluatorIri(2));

    const entries = readRunJournalEntries(workspaceDir, "draft-1");
    expect(entries.map((entry) => entry.kind)).toEqual(["evaluation"]);
    expect(entries[0]).toMatchObject({ cellKey, evaluator: evaluatorIri(2), evalIndex: 2 });
  });

  test("the same retryable failure terminalizes immediately at attempt 1 when maxInfrastructureRetries is 0 (the pin is load-bearing, spec §5.3's control)", async () => {
    const clock = makeClock();
    const { taskSha256 } = storeSubjectTaskAndSpec();
    const cellKey = `${taskSha256}/arm-a/1`;
    const solveDeliveryBytes = utf8({ outputs: [{ name: "prediction", digest: { sha256: "e".repeat(64) } }] });
    const deliverySha256 = putSealedBytes(workspaceDir, solveDeliveryBytes);
    const predictionBytes = utf8({ probabilityYes: "0.5" });
    const predictionSha256 = putSealedBytes(workspaceDir, predictionBytes);
    const backend = makeFakeBackend({
      submitResult: {
        accepted: false,
        error: new TaskExecutionError("dependency-unavailable", {
          detail: "pinned image provider unavailable",
        }),
      },
    });
    const preparedTaskBytes = new Uint8Array([4, 5]);
    const venue = fakeVenue({ taskBytes: preparedTaskBytes, taskSha256: sha256Hex(preparedTaskBytes) });
    const deps = {
      workspaceDir,
      draftId: "draft-1",
      venue,
      backend,
      runSha256: "r".repeat(64),
      owner: "urn:uuid:owner",
      cellWindowMs: 3_600_000,
      minVerdicts: 1,
      // No maxInfrastructureRetries — the unpinned default (0). Everything else below — the
      // cell, the category, the detail, the backend script — is identical to the retry test
      // right after this one; the pinned value is the ONLY difference, which is what proves the
      // pin is load-bearing (§5.3) rather than cosmetic.
      liveClock: clock,
    };
    const gap = {
      cellKey,
      lastDispatch: 1,
      deliverySha256,
      deliveryOutputs: [{ name: "prediction", sha256: predictionSha256 }],
      missingEvalIndexes: [1],
    };

    await driveEvaluationCatchUp(deps, [gap]);

    const entries = readRunJournalEntries(workspaceDir, "draft-1");
    expect(entries.some((entry) => entry.kind === "evaluation-retryable-failure")).toBe(false);
    expect(entries).toEqual([
      expect.objectContaining({
        kind: "evaluation",
        cellKey,
        evaluationTerminal: "could-not-grade",
        failureCategory: "dependency-unavailable",
      }),
    ]);
    // evaluationAttempt is only journaled when > 1 — this terminalized on attempt 1.
    expect(entries[0] && "evaluationAttempt" in entries[0]).toBe(false);
  });

  test("a typed provider outage retries the same derived Task once without re-running solve", async () => {
    const clock = makeClock();
    const { taskSha256 } = storeSubjectTaskAndSpec();
    const cellKey = `${taskSha256}/arm-a/1`;
    const solveDeliveryBytes = utf8({ outputs: [{ name: "prediction", digest: { sha256: "e".repeat(64) } }] });
    const deliverySha256 = putSealedBytes(workspaceDir, solveDeliveryBytes);
    const predictionBytes = utf8({ probabilityYes: "0.5" });
    const predictionSha256 = putSealedBytes(workspaceDir, predictionBytes);
    const evalDeliveryDigestHex = "1".repeat(64);
    const verdictEnvelopeHex = "2".repeat(64);
    const submits: { taskBytes: Uint8Array; submissionBytes: Uint8Array }[] = [];
    const backend = makeFakeBackend({
      deliveriesByAttempt: { "att-eval-2": [fakeDeliveryRef("att-eval-2", evalDeliveryDigestHex)] },
      deliveryBytesByDigest: {
        [`sha256:${evalDeliveryDigestHex}`]: utf8({ outputs: [{ name: "verdict", digest: { sha256: verdictEnvelopeHex } }] }),
      },
      artifactBytesByDigest: { [verdictEnvelopeHex]: utf8({ envelope: true }) },
      observeResult: fakeSnapshot("att-eval-2", "delivered"),
      calls: { submits },
    });
    let submissionAttempt = 0;
    backend.submit = async (taskBytes, submissionBytes) => {
      submits.push({ taskBytes, submissionBytes });
      submissionAttempt += 1;
      return submissionAttempt === 1
        ? {
            accepted: false,
            error: new TaskExecutionError("dependency-unavailable", {
              detail: "pinned image provider unavailable",
            }),
          }
        : {
            accepted: true,
            submission: "urn:uuid:00000000-0000-4000-8000-000000000099" as SubmissionUri,
            digest: `sha256:${"9".repeat(64)}` as const,
          };
    };
    const preparedTaskBytes = new Uint8Array([4, 5]);
    const venue = fakeVenue({ taskBytes: preparedTaskBytes, taskSha256: sha256Hex(preparedTaskBytes) });
    const deps = {
      workspaceDir,
      draftId: "draft-1",
      venue,
      backend,
      runSha256: "r".repeat(64),
      owner: "urn:uuid:owner",
      cellWindowMs: 3_600_000,
      minVerdicts: 1,
      maxInfrastructureRetries: 1 as const,
      liveClock: clock,
    };
    const gap = {
      cellKey,
      lastDispatch: 1,
      deliverySha256,
      deliveryOutputs: [{ name: "prediction", sha256: predictionSha256 }],
      missingEvalIndexes: [1],
    };

    await driveEvaluationCatchUp(deps, [gap]);
    expect(readRunJournalEntries(workspaceDir, "draft-1")).toEqual([
      expect.objectContaining({
        kind: "evaluation-retryable-failure",
        cellKey,
        dispatch: 1,
        evalIndex: 1,
        evaluationAttempt: 1,
        category: "dependency-unavailable",
      }),
    ]);

    await driveEvaluationCatchUp(deps, [{
      ...gap,
      nextEvaluationAttempts: { 1: 2 },
    }]);

    expect(submits).toHaveLength(2);
    expect(submits[0]?.taskBytes).toEqual(preparedTaskBytes);
    expect(submits[1]?.taskBytes).toEqual(preparedTaskBytes);
    const first = JSON.parse(new TextDecoder().decode(submits[0]!.submissionBytes));
    const second = JSON.parse(new TextDecoder().decode(submits[1]!.submissionBytes));
    expect(first.nonce).toBe(`eval:${deps.runSha256}:e1:${cellKey}:1`);
    expect(second.nonce).toBe(`eval:${deps.runSha256}:e1:r2:${cellKey}:1`);
    expect(readRunJournalEntries(workspaceDir, "draft-1").at(-1)).toMatchObject({
      kind: "evaluation",
      cellKey,
      evalIndex: 1,
      evaluationAttempt: 2,
      verdictSha256: sha256Hex(utf8({ envelope: true })),
    });
  });

  test("a second retryable failure on the same leg terminalizes as could-not-grade at attempt 2, closing the leg (spec §5.3's far end)", async () => {
    const clock = makeClock();
    const { taskSha256 } = storeSubjectTaskAndSpec();
    const cellKey = `${taskSha256}/arm-a/1`;
    const solveDeliveryDigestHex = "d".repeat(64);
    const predictionArtifactHex = "e".repeat(64);
    const solveDeliveryBytes = utf8({ outputs: [{ name: "prediction", digest: { sha256: predictionArtifactHex } }] });
    const predictionBytes = utf8({ probabilityYes: "0.5" });
    const backend = makeFakeBackend({
      deliveriesByAttempt: { "att-solve-1": [fakeDeliveryRef("att-solve-1", solveDeliveryDigestHex)] },
      deliveryBytesByDigest: { [`sha256:${solveDeliveryDigestHex}`]: solveDeliveryBytes },
      artifactBytesByDigest: { [predictionArtifactHex]: predictionBytes },
      // Every submit rejects the same way — unlike the retry test above, the outage never clears.
      submitResult: {
        accepted: false,
        error: new TaskExecutionError("dependency-unavailable", { detail: "pinned image provider unavailable" }),
      },
    });
    const deps = {
      workspaceDir,
      draftId: "draft-1",
      venue: fakeVenue({ taskBytes: new Uint8Array([9]), taskSha256: "9".repeat(64) }),
      backend,
      runSha256: "r".repeat(64),
      owner: "urn:uuid:owner",
      cellWindowMs: 3_600_000,
      minVerdicts: 1,
      maxInfrastructureRetries: 1 as const,
      liveClock: clock,
    };
    const events: CellStatusEvent[] = [
      { cellKey, armId: "arm-a", replicate: 1, dispatch: 1, kind: "delivered", attempt: "att-solve-1" },
    ];

    // Attempt 1 (via a real delivered cell-event, so the fold's status is genuinely "delivered"
    // rather than trivially skipped by evaluationGaps's status filter below) spends the single
    // allowed retry.
    await driveCellEvents(deps, (async function* () { for (const event of events) yield event; })());
    expect(readRunJournalEntries(workspaceDir, "draft-1").filter((entry) => entry.kind === "evaluation-retryable-failure"))
      .toHaveLength(1);

    // Attempt 2, resumed exactly as a crash-safe catch-up would run it, also fails.
    await driveEvaluationCatchUp(deps, [{
      cellKey,
      lastDispatch: 1,
      deliverySha256: sha256Hex(solveDeliveryBytes),
      deliveryOutputs: [{ name: "prediction", sha256: sha256Hex(predictionBytes) }],
      missingEvalIndexes: [1],
      nextEvaluationAttempts: { 1: 2 },
    }]);

    const entries = readRunJournalEntries(workspaceDir, "draft-1");
    const evaluationEntries = entries.filter((entry) => entry.kind === "evaluation");
    expect(evaluationEntries).toHaveLength(1);
    expect(evaluationEntries[0]).toMatchObject({
      cellKey,
      evaluationTerminal: "could-not-grade",
      evaluationAttempt: 2,
      failureCategory: "dependency-unavailable",
    });

    // The accounted unscorable cell: no third attempt is offered.
    expect(evaluationGaps(foldRunJournal(entries), deps.minVerdicts, 1)).toEqual([]);
  });
});
