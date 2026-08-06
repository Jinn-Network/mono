import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { CellStatusEvent } from "@jinn-network/benchmarking-run";
import type {
  AttemptUri,
  DeliveryRef,
  ObservationSnapshot,
  SubmissionAck,
  SubmissionUri,
} from "@jinn-network/task-execution-backend";
import type { ResourceDescriptor } from "@jinn-network/task-execution-protocol";
import { sealTask } from "@jinn-network/task-execution-protocol";
import { putSealedBytes, sha256Hex } from "../workspace/sealed-store.js";
import {
  createRecordingProxy,
  driveCellEvents,
  driveEvaluationCatchUp,
  type ProxiedBackend,
} from "./drive.js";
import { readRunJournalEntries } from "./journal.js";
import type { LocalVenue } from "../venue/venue.js";

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

function fakeSnapshot(attempt: string, state: string): ObservationSnapshot {
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

function fakeVenue(prepared: { taskBytes: Uint8Array; taskSha256: string }): LocalVenue {
  return {
    backend: undefined as unknown as LocalVenue["backend"],
    verdictKeyId: "fake-key",
    prepareEvaluationCell: () => prepared,
    async shutdown() {},
  };
}

describe("createRecordingProxy", () => {
  test("journals submission-accepted from a solve-shaped nonce (<cellKey>:<dispatch>) then delegates", async () => {
    const clock = makeClock();
    const backend = makeFakeBackend({});
    const proxy = createRecordingProxy(backend, { workspaceDir, draftId: "draft-1", liveClock: clock });

    const submissionBytes = utf8({ nonce: `${CELL_A}:1`, submission: "urn:uuid:00000000-0000-4000-8000-000000000001" });
    const ack = await proxy.submit(new Uint8Array([1]), submissionBytes);
    expect(ack.accepted).toBe(true);

    const entries = readRunJournalEntries(workspaceDir, "draft-1");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: "submission-accepted", cellKey: CELL_A, dispatch: 1 });
    if (entries[0]?.kind === "submission-accepted") {
      expect(entries[0].submissionSha256).toBe(sha256Hex(submissionBytes));
    }
  });

  test("journals submission-accepted from an eval-shaped nonce (eval:<runSha256>:<cellKey>:<dispatch>)", async () => {
    const clock = makeClock();
    const backend = makeFakeBackend({});
    const proxy = createRecordingProxy(backend, { workspaceDir, draftId: "draft-1", liveClock: clock });

    const nonce = `eval:${"f".repeat(64)}:${CELL_A}:2`;
    const submissionBytes = utf8({ nonce, submission: "urn:uuid:00000000-0000-4000-8000-000000000002" });
    await proxy.submit(new Uint8Array([1]), submissionBytes);

    const entries = readRunJournalEntries(workspaceDir, "draft-1");
    expect(entries[0]).toMatchObject({ kind: "submission-accepted", cellKey: CELL_A, dispatch: 2 });
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
      { workspaceDir, draftId: "draft-1", venue: fakeVenue({ taskBytes: new Uint8Array(), taskSha256: "0".repeat(64) }), backend, runSha256: "r".repeat(64), owner: "urn:uuid:owner", cellWindowMs: 3_600_000, liveClock: clock },
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
      { workspaceDir, draftId: "draft-1", venue: fakeVenue({ taskBytes: new Uint8Array(), taskSha256: "0".repeat(64) }), backend, runSha256: "r".repeat(64), owner: "urn:uuid:owner", cellWindowMs: 3_600_000, liveClock: clock },
      (async function* () { for (const event of events) yield event; })(),
    );
    expect(readRunJournalEntries(workspaceDir, "draft-1")).toHaveLength(1);
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
      { workspaceDir, draftId: "draft-1", venue, backend, runSha256: "r".repeat(64), owner: "urn:uuid:owner-1", cellWindowMs: 3_600_000, liveClock: clock },
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
      expect(evaluationEntry.verdictSha256).toBe(sha256Hex(verdictEnvelopeBytes));
      expect(evaluationEntry.evaluationTerminal).toBeUndefined();
    }

    // Exactly one Submission was sealed and submitted for the evaluation leg, pinning EVALUATION_HARNESS_PIN.
    expect(submits).toHaveLength(1);
    const submittedDoc = JSON.parse(new TextDecoder().decode(submits[0]!.submissionBytes)) as { requirements?: { harness?: unknown }; requester?: string };
    expect(submittedDoc.requirements?.harness).toEqual({ id: "evaluation-harness", version: "0.1.0" });
    expect(submittedDoc.requester).toBe("urn:uuid:owner-1");
  });

  test("no attempt on the delivered event -> could-not-grade, no crash", async () => {
    const clock = makeClock();
    const backend = makeFakeBackend({});
    const events: CellStatusEvent[] = [
      { cellKey: CELL_A, armId: "arm-a", replicate: 1, dispatch: 1, kind: "delivered" },
    ];
    await driveCellEvents(
      { workspaceDir, draftId: "draft-1", venue: fakeVenue({ taskBytes: new Uint8Array(), taskSha256: "0".repeat(64) }), backend, runSha256: "r".repeat(64), owner: "urn:uuid:owner", cellWindowMs: 3_600_000, liveClock: clock },
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
      { workspaceDir, draftId: "draft-1", venue: fakeVenue({ taskBytes: new Uint8Array(), taskSha256: "0".repeat(64) }), backend, runSha256: "r".repeat(64), owner: "urn:uuid:owner", cellWindowMs: 3_600_000, liveClock: clock },
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
      { workspaceDir, draftId: "draft-1", venue: fakeVenue({ taskBytes: new Uint8Array(), taskSha256: "0".repeat(64) }), backend, runSha256: "r".repeat(64), owner: "urn:uuid:owner", cellWindowMs: 3_600_000, liveClock: clock },
      (async function* () { for (const event of events) yield event; })(),
    );
    const entries = readRunJournalEntries(workspaceDir, "draft-1");
    const evaluationEntry = entries.find((entry) => entry.kind === "evaluation");
    expect(evaluationEntry).toMatchObject({ evaluationTerminal: "could-not-grade", detail: expect.stringContaining("EvaluationSpec") });
    // The delivery WAS still journaled — only the evaluation leg failed.
    expect(entries.find((entry) => entry.kind === "delivery")).toBeDefined();
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
      { workspaceDir, draftId: "draft-1", venue: fakeVenue({ taskBytes: new Uint8Array([9]), taskSha256: "9".repeat(64) }), backend, runSha256: "r".repeat(64), owner: "urn:uuid:owner", cellWindowMs: 3_600_000, liveClock: clock },
      (async function* () { for (const event of events) yield event; })(),
    );
    const entries = readRunJournalEntries(workspaceDir, "draft-1");
    const evaluationEntry = entries.find((entry) => entry.kind === "evaluation");
    expect(evaluationEntry).toMatchObject({ evaluationTerminal: "could-not-grade", detail: "no evaluation-harness deployment", evalTaskSha256: "9".repeat(64) });
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
      { workspaceDir, draftId: "draft-1", venue: fakeVenue({ taskBytes: new Uint8Array([9]), taskSha256: "9".repeat(64) }), backend, runSha256: "r".repeat(64), owner: "urn:uuid:owner", cellWindowMs: 3_600_000, liveClock: clock },
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
      { workspaceDir, draftId: "draft-1", venue: fakeVenue({ taskBytes: new Uint8Array(), taskSha256: "0".repeat(64) }), backend, runSha256: "r".repeat(64), owner: "urn:uuid:owner", cellWindowMs: 3_600_000, liveClock: clock },
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
      { workspaceDir, draftId: "draft-1", venue, backend, runSha256: "r".repeat(64), owner: "urn:uuid:owner-1", cellWindowMs: 3_600_000, liveClock: clock, onProgress: (line) => lines.push(line) },
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
      { workspaceDir, draftId: "draft-1", venue: fakeVenue({ taskBytes: new Uint8Array(), taskSha256: "0".repeat(64) }), backend, runSha256: "r".repeat(64), owner: "urn:uuid:owner", cellWindowMs: 3_600_000, liveClock: clock, onProgress: (line) => lines.push(line) },
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
        { workspaceDir, draftId: "draft-1", venue, backend, runSha256: "r".repeat(64), owner: "urn:uuid:owner-1", cellWindowMs: 3_600_000, liveClock: clock, onProgress: throwingOnProgress },
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
      { workspaceDir, draftId: "draft-1", venue, backend, runSha256: "r".repeat(64), owner: "urn:uuid:owner", cellWindowMs: 3_600_000, liveClock: clock },
      [{ cellKey, lastDispatch: 1, deliverySha256, deliveryOutputs: [{ name: "prediction", sha256: predictionSha256 }] }],
    );

    const entries = readRunJournalEntries(workspaceDir, "draft-1");
    // No "delivery" entry is re-written — only the evaluation leg runs.
    expect(entries.map((entry) => entry.kind)).toEqual(["evaluation"]);
    expect(entries[0]).toMatchObject({ cellKey, evalTaskSha256: "4".repeat(64) });
  });
});
