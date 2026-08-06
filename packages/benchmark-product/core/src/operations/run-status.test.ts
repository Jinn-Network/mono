import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { AttemptUri, DeliveryRef, ObservationSnapshot, SubmissionAck, SubmissionUri } from "@jinn-network/task-execution-backend";
import type { ResourceDescriptor } from "@jinn-network/task-execution-protocol";
import { atomicWriteFileSync } from "../fs/atomic.js";
import type { ProxiedBackend } from "../run/drive.js";
import { readRunJournalEntries } from "../run/journal.js";
import { runJournalPath } from "../workspace/layout.js";
import { sha256Hex } from "../workspace/sealed-store.js";
import type { LocalVenue } from "../venue/venue.js";
import { armAdd } from "./arms.js";
import type { OperationContext } from "./context.js";
import { createDraft } from "./drafts.js";
import { initWorkspace } from "./init.js";
import { runLaunch } from "./run-launch.js";
import { runLock } from "./run-lock.js";
import { runQuote } from "./run-quote.js";
import { runStatus } from "./run-status.js";
import { sampleInit } from "./sample.js";

let workspaceDir: string;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "bp12-run-status-"));
});

afterEach(() => {
  rmSync(workspaceDir, { recursive: true, force: true });
});

function makeClock(): () => string {
  let ms = Date.parse("2026-08-05T00:00:00.000Z");
  return () => {
    const value = new Date(ms).toISOString();
    ms += 10;
    return value;
  };
}

function contextFor(clock: () => string, principal = "sponsor-1"): OperationContext {
  return { workspaceDir, principal, clock };
}

function utf8(json: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(json));
}

function makeStatefulFakeBackend(): { backend: ProxiedBackend } {
  const byUri = new Map<string, { attempt: string; submission: string; deliveryDigestHex: string }>();
  const byIdempotencyKey = new Map<string, { bytesHash: string; ack: SubmissionAck }>();
  const bytesByHex = new Map<string, Uint8Array>();
  let counter = 0;

  function store(bytes: Uint8Array): string {
    const hex = sha256Hex(bytes);
    bytesByHex.set(hex, bytes);
    return hex;
  }

  const backend: ProxiedBackend = {
    async capabilities() {
      throw new Error("not used");
    },
    async submit(_taskBytes, submissionBytes) {
      const doc = JSON.parse(new TextDecoder().decode(submissionBytes)) as {
        idempotencyKey: string;
        submission: string;
        requirements?: { harness?: { id?: string } };
      };
      const bytesHash = sha256Hex(submissionBytes);
      const prior = byIdempotencyKey.get(doc.idempotencyKey);
      if (prior !== undefined) return prior.ack;
      counter += 1;
      const attempt = `urn:uuid:00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`;
      const isEval = doc.requirements?.harness?.id === "evaluation-harness";
      const outputName = isEval ? "verdict" : "prediction";
      const artifactHex = store(utf8({ fake: true, outputName, counter }));
      const deliveryHex = store(utf8({ outputs: [{ name: outputName, digest: { sha256: artifactHex } }] }));
      byUri.set(doc.submission, { attempt, submission: doc.submission, deliveryDigestHex: deliveryHex });
      byUri.set(attempt, { attempt, submission: doc.submission, deliveryDigestHex: deliveryHex });
      const ack: SubmissionAck = { accepted: true, submission: doc.submission as SubmissionUri, digest: `sha256:${bytesHash}` };
      byIdempotencyKey.set(doc.idempotencyKey, { bytesHash, ack });
      return ack;
    },
    async observe(ref) {
      const found = byUri.get(ref as string);
      if (found === undefined) throw new Error(`fake: no attempt for ${String(ref)}`);
      const snapshot: ObservationSnapshot = {
        descriptor: {
          attempt: found.attempt as `urn:uuid:${string}`,
          task: `sha256:${"0".repeat(64)}`,
          submission: found.submission as `urn:uuid:${string}`,
          derived: { state: "delivered", terminal: true, contradictory: false, cancelRequested: false, executionIds: [], deliveries: [] },
        },
        cursor: { sequence: "0" },
        observations: [],
      };
      return snapshot;
    },
    async recover() {
      throw new Error("not used");
    },
    async deliveries(attempt) {
      const found = byUri.get(attempt as string);
      return found === undefined ? [] : [{ attempt: attempt as AttemptUri, digest: `sha256:${found.deliveryDigestHex}` } as DeliveryRef];
    },
    async fetchDelivery(ref) {
      const bytes = bytesByHex.get(ref.digest.slice("sha256:".length));
      if (bytes === undefined) throw new Error("fake: unknown delivery digest");
      return bytes;
    },
    async fetchArtifact(descriptor: ResourceDescriptor) {
      const sha256 = descriptor.digest?.["sha256"];
      const bytes = sha256 === undefined ? undefined : bytesByHex.get(sha256);
      if (bytes === undefined) throw new Error("fake: unknown artifact digest");
      return bytes;
    },
    async drain() {},
  };
  return { backend };
}

function fakeVenue(backend: ProxiedBackend): LocalVenue {
  return {
    backend: backend as unknown as LocalVenue["backend"],
    verdictKeyId: "fake-verdict-key",
    evaluators: [{ id: "urn:jinn:benchmark-product:local-venue:evaluator-1", keyId: "fake-verdict-key" }],
    prepareEvaluationCell: (input) => {
      const taskBytes = utf8({ fakeEvalTask: true, subjectDigest: sha256Hex(input.subjectTaskBytes) });
      return { taskBytes, taskSha256: sha256Hex(taskBytes) };
    },
    async shutdown() {},
  };
}

async function setUpLockedDraft(clock: () => string, draftId = "draft-1"): Promise<void> {
  initWorkspace(contextFor(clock));
  createDraft(contextFor(clock), { draftId, name: "Status Test" });
  await sampleInit(contextFor(clock), { draftId });
  armAdd(contextFor(clock), { draftId, armId: "baseline", pinning: { harness: { id: "prediction-v1-baseline", version: "1.0.0" } } });
  armAdd(contextFor(clock), { draftId, armId: "sample", pinning: { harness: { id: "sample-uniform", version: "0.1.0" } } });
  const quoted = await runQuote(contextFor(clock), { draftId });
  expect(quoted.ok).toBe(true);
  const locked = runLock(contextFor(clock), { draftId });
  expect(locked.ok).toBe(true);
}

describe("runStatus — guards", () => {
  test("refuses not-found before the draft has ever been quoted (no RunState at all)", async () => {
    const clock = makeClock();
    initWorkspace(contextFor(clock));
    createDraft(contextFor(clock), { draftId: "draft-1", name: "Never Locked" });

    const outcome = runStatus(contextFor(clock), { draftId: "draft-1" });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("not-found");
  });

  test("refuses conflict once quoted but before the draft has been locked (RunState exists, no runSha256)", async () => {
    const clock = makeClock();
    initWorkspace(contextFor(clock));
    createDraft(contextFor(clock), { draftId: "draft-1", name: "Quoted Only" });
    await sampleInit(contextFor(clock), { draftId: "draft-1" });
    armAdd(contextFor(clock), { draftId: "draft-1", armId: "baseline", pinning: { harness: { id: "prediction-v1-baseline", version: "1.0.0" } } });
    armAdd(contextFor(clock), { draftId: "draft-1", armId: "sample", pinning: { harness: { id: "sample-uniform", version: "0.1.0" } } });
    const quoted = await runQuote(contextFor(clock), { draftId: "draft-1" });
    expect(quoted.ok).toBe(true);

    const outcome = runStatus(contextFor(clock), { draftId: "draft-1" });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("conflict");
  });

  test("is a read: available (and ungated) once locked, before launch", async () => {
    const clock = makeClock();
    await setUpLockedDraft(clock);

    const outcome = runStatus(contextFor(clock), { draftId: "draft-1" });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.state).toBe("locked");
    // Every expected cell is "pending" — nothing has been dispatched yet.
    expect(outcome.result.cells).toHaveLength(6);
    expect(outcome.result.cells.every((cell) => cell.status === "pending" && cell.dispatches === 0)).toBe(true);
    expect(outcome.result.counts).toEqual({ expected: 6, dispatched: 0, delivered: 0, judged: 0, failed: 0 });
  });
});

describe("runStatus — reflects a driven run", () => {
  test("every cell reports delivered+judged status with digests after a full launch", async () => {
    const clock = makeClock();
    await setUpLockedDraft(clock);
    const { backend } = makeStatefulFakeBackend();
    const launched = await runLaunch(contextFor(clock), { draftId: "draft-1" }, { createVenue: () => fakeVenue(backend) });
    expect(launched.ok).toBe(true);

    const outcome = runStatus(contextFor(clock), { draftId: "draft-1" });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.state).toBe("running");
    expect(outcome.result.cells).toHaveLength(6);
    for (const cell of outcome.result.cells) {
      expect(cell.status, cell.cellKey).toBe("judged");
      expect(cell.dispatches, cell.cellKey).toBe(1);
      expect(cell.attempt, cell.cellKey).toBeDefined();
      expect(cell.deliverySha256, cell.cellKey).toMatch(/^[a-f0-9]{64}$/);
      expect(cell.verdictSha256, cell.cellKey).toMatch(/^[a-f0-9]{64}$/);
    }
    expect(outcome.result.counts).toEqual({ expected: 6, dispatched: 6, delivered: 6, judged: 6, failed: 0 });
  }, 30_000);

  test("a cell with no journal activity at all reports 'pending' among otherwise-complete cells", async () => {
    const clock = makeClock();
    await setUpLockedDraft(clock);
    const { backend } = makeStatefulFakeBackend();
    const launched = await runLaunch(contextFor(clock), { draftId: "draft-1" }, { createVenue: () => fakeVenue(backend) });
    expect(launched.ok).toBe(true);

    const fullEntries = readRunJournalEntries(workspaceDir, "draft-1");
    const deliveredCells = fullEntries
      .filter((entry) => entry.kind === "cell-event" && entry.event.kind === "delivered")
      .map((entry) => (entry.kind === "cell-event" ? entry.event.cellKey : ""));
    const [droppedCellKey] = deliveredCells;
    const truncated = fullEntries.filter((entry) => {
      if (entry.kind === "cell-event") return entry.event.cellKey !== droppedCellKey;
      if (entry.kind === "submission-accepted" || entry.kind === "delivery" || entry.kind === "evaluation") {
        return entry.cellKey !== droppedCellKey;
      }
      return true;
    });
    atomicWriteFileSync(runJournalPath(workspaceDir, "draft-1"), `${truncated.map((entry) => JSON.stringify(entry)).join("\n")}\n`);

    const outcome = runStatus(contextFor(clock), { draftId: "draft-1" });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const pendingCell = outcome.result.cells.find((cell) => cell.cellKey === droppedCellKey);
    expect(pendingCell).toMatchObject({ status: "pending", dispatches: 0 });
    expect(pendingCell?.attempt).toBeUndefined();
    expect(outcome.result.counts).toEqual({ expected: 6, dispatched: 5, delivered: 5, judged: 5, failed: 0 });
  }, 30_000);
});
