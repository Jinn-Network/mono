import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type {
  AttemptUri,
  DeliveryRef,
  ObservationSnapshot,
  SubmissionAck,
  SubmissionUri,
} from "@jinn-network/task-execution-backend";
import type { ResourceDescriptor } from "@jinn-network/task-execution-protocol";
import { readAuditEntries } from "../audit/journal.js";
import { atomicWriteFileSync } from "../fs/atomic.js";
import { writeCancelMarker } from "../run/cancel-marker.js";
import type { ProxiedBackend } from "../run/drive.js";
import { readRunJournalEntries, type RunJournalEntry } from "../run/journal.js";
import { readRunState, writeRunState } from "../run/state.js";
import { createWorkspacePublicationHttpHandler, createWorkspacePublicationSource } from "../run/publication-source.js";
import { runJournalPath } from "../workspace/layout.js";
import { getSealedBytes, sha256Hex } from "../workspace/sealed-store.js";
import type { LocalVenue } from "../venue/venue.js";
import { armAdd } from "./arms.js";
import { authorityGrant } from "./authority-ops.js";
import type { OperationContext } from "./context.js";
import { createDraft, readDraftDocument, updateDraft } from "./drafts.js";
import { initWorkspace } from "./init.js";
import { runLaunch, runResume } from "./run-launch.js";
import { publicationConfigure, publicationRegister } from "./publication-register.js";
import { publicationStatus } from "./publication-status.js";
import { runLock } from "./run-lock.js";
import { runQuote } from "./run-quote.js";
import { runStatus } from "./run-status.js";
import { sampleInit } from "./sample.js";

let workspaceDir: string;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "bp12-run-launch-"));
});

afterEach(() => {
  rmSync(workspaceDir, { recursive: true, force: true });
});

/**
 * A driven run's clock ticks far more often than a single operation's (`launchAndWatch` reads
 * `opts.clock.now()` repeatedly per cell, and every journal entry stamps its own `at`) — a
 * two-digit-seconds counter overflows past a full multi-cell run. Real `Date` arithmetic
 * sidesteps that by construction: minute/hour/day rollover is handled for free.
 */
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

async function setUpLockedDraft(
  clock: () => string,
  draftId = "draft-1",
  assurance?: { preset: string; overrides?: Record<string, unknown> },
): Promise<void> {
  initWorkspace(contextFor(clock));
  const created = createDraft(contextFor(clock), { draftId, name: "Launch Test" });
  expect(created.ok).toBe(true);
  await sampleInit(contextFor(clock), { draftId });
  armAdd(contextFor(clock), { draftId, armId: "baseline", pinning: { harness: { id: "prediction-v1-baseline", version: "1.0.0" } } });
  armAdd(contextFor(clock), { draftId, armId: "sample", pinning: { harness: { id: "sample-uniform", version: "0.1.0" } } });
  if (assurance !== undefined) {
    const updated = updateDraft(contextFor(clock), { draftId, patch: { assurance } });
    expect(updated.ok).toBe(true);
  }
  const quoted = await runQuote(contextFor(clock), { draftId });
  expect(quoted.ok).toBe(true);
  const locked = runLock(contextFor(clock), { draftId });
  expect(locked.ok).toBe(true);
}

// ── a small stateful in-memory fake backend + venue (no subprocess, always-immediate-terminal) ──

interface FakeAttempt {
  readonly attempt: string;
  readonly submission: string;
  readonly deliveryDigestHex: string;
}

function utf8(json: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(json));
}

/**
 * Every submit() immediately produces a "delivered" terminal — no watch loop, no
 * `capabilities()` call (`launchAndWatch` only calls `capabilities()` inside
 * `waitForAttemptTerminal`, which this fake never reaches because `observe()` already reports
 * `terminal: true` on the very first call).
 */
function makeStatefulFakeBackend(): {
  backend: ProxiedBackend;
  submits: { taskBytes: Uint8Array; submissionBytes: Uint8Array }[];
  recoveries: string[];
} {
  const byUri = new Map<string, FakeAttempt>();
  const byIdempotencyKey = new Map<string, { bytesHash: string; ack: SubmissionAck }>();
  const bytesByHex = new Map<string, Uint8Array>();
  let counter = 0;
  const submits: { taskBytes: Uint8Array; submissionBytes: Uint8Array }[] = [];
  const recoveries: string[] = [];

  function store(bytes: Uint8Array): string {
    const hex = sha256Hex(bytes);
    bytesByHex.set(hex, bytes);
    return hex;
  }

  const backend: ProxiedBackend = {
    async capabilities() {
      throw new Error("fake backend: capabilities() should not be reached (always-terminal fake)");
    },
    async submit(taskBytes, submissionBytes) {
      submits.push({ taskBytes, submissionBytes });
      const doc = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(submissionBytes)) as {
        idempotencyKey: string;
        submission: string;
        requirements?: { harness?: { id?: string } };
      };
      const bytesHash = sha256Hex(submissionBytes);
      const prior = byIdempotencyKey.get(doc.idempotencyKey);
      if (prior !== undefined) {
        if (prior.bytesHash !== bytesHash) {
          return { accepted: false, error: { category: "submission-conflict", detail: "idempotency key reused with different bytes" } as never };
        }
        return prior.ack;
      }
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
      if (found === undefined) throw new Error(`fake backend: no attempt for ref ${String(ref)}`);
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
    async recover(ref) {
      recoveries.push(ref);
      return { classification: "absent" };
    },
    async deliveries(attempt) {
      const found = byUri.get(attempt as string);
      return found === undefined ? [] : [{ attempt: attempt as AttemptUri, digest: `sha256:${found.deliveryDigestHex}` } as DeliveryRef];
    },
    async fetchDelivery(ref) {
      const bytes = bytesByHex.get(ref.digest.slice("sha256:".length));
      if (bytes === undefined) throw new Error("fake backend: unknown delivery digest");
      return bytes;
    },
    async fetchArtifact(descriptor: ResourceDescriptor) {
      const sha256 = descriptor.digest?.["sha256"];
      const bytes = sha256 === undefined ? undefined : bytesByHex.get(sha256);
      if (bytes === undefined) throw new Error("fake backend: unknown artifact digest");
      return bytes;
    },
    async drain() {},
  };
  return { backend, submits, recoveries };
}

function fakeVenue(backend: ProxiedBackend, evaluatorCount = 1): LocalVenue {
  const evaluators = Array.from({ length: evaluatorCount }, (_, i) => ({
    id: `urn:jinn:benchmark-product:local-venue:evaluator-${i + 1}`,
    keyId: `fake-verdict-key-${i + 1}`,
  }));
  return {
    backend: backend as unknown as LocalVenue["backend"],
    verdictKeyId: evaluators[0]!.keyId,
    evaluators,
    prepareEvaluationCell: (input) => {
      const taskBytes = utf8({
        fakeEvalTask: true,
        subjectDigest: sha256Hex(input.subjectTaskBytes),
        specDigest: sha256Hex(input.evaluationSpecBytes),
      });
      return { taskBytes, taskSha256: sha256Hex(taskBytes) };
    },
    async shutdown() {},
  };
}

describe("runLaunch — lifecycle guard", () => {
  test("refuses concurrency outside the public 1-32 bound before changing run state", async () => {
    const clock = makeClock();
    await setUpLockedDraft(clock);
    let venueCalls = 0;
    const outcome = await runLaunch(contextFor(clock), {
      draftId: "draft-1",
      maxConcurrentCells: 33,
    }, {
      createVenue: () => {
        venueCalls += 1;
        throw new Error("must not construct venue");
      },
    });
    expect(outcome).toMatchObject({
      ok: false,
      error: { code: "validation", issues: [{ path: "maxConcurrentCells" }] },
    });
    expect(venueCalls).toBe(0);
    expect(readDraftDocument(workspaceDir, "draft-1").state).toBe("locked");
  });

  test("refuses illegal-transition when the draft is not locked", async () => {
    const clock = makeClock();
    initWorkspace(contextFor(clock));
    createDraft(contextFor(clock), { draftId: "draft-1", name: "Never Locked" });

    const outcome = await runLaunch(contextFor(clock), { draftId: "draft-1" });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("illegal-transition");
  });

  test("venue construction failure surfaces as venue-unavailable", async () => {
    const clock = makeClock();
    await setUpLockedDraft(clock);

    const outcome = await runLaunch(contextFor(clock), { draftId: "draft-1" }, {
      createVenue: () => {
        throw new Error("boom");
      },
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("venue-unavailable");

    // The draft was NOT advanced to running — venue construction failed before any drive work,
    // but AFTER the state was already written per this operation's own "advance first" design.
    // Document the actual behavior rather than assume: launch stamps state before booting the
    // venue, so a venue failure still leaves the draft "running" with an empty journal.
    const document = readDraftDocument(workspaceDir, "draft-1");
    expect(document.state).toBe("running");
  }, 30_000);
});

describe("runLaunch — gating (authority-denied / grant)", () => {
  test("an ungranted delegated agent is refused, audited under the denied principal", async () => {
    const clock = makeClock();
    await setUpLockedDraft(clock);
    authorityGrant(contextFor(clock), { principalId: "agent-1", operations: [] });

    const denied = await runLaunch(contextFor(clock, "agent-1"), { draftId: "draft-1" });
    expect(denied.ok).toBe(false);
    if (denied.ok) return;
    expect(denied.error.code).toBe("authority-denied");

    const entries = readAuditEntries(workspaceDir);
    expect(entries[entries.length - 1]).toMatchObject({ action: "launch", actor: "agent-1", outcome: "authority-denied" });

    // Denial happens before any state mutation.
    expect(readDraftDocument(workspaceDir, "draft-1").state).toBe("locked");
  }, 30_000);

  test("a granted principal can launch (drives via the injected fake venue)", async () => {
    const clock = makeClock();
    await setUpLockedDraft(clock);
    authorityGrant(contextFor(clock), { principalId: "agent-1", operations: ["launch"] });
    const { backend } = makeStatefulFakeBackend();

    const outcome = await runLaunch(contextFor(clock, "agent-1"), { draftId: "draft-1" }, { createVenue: () => fakeVenue(backend) });
    expect(outcome.ok).toBe(true);
  }, 30_000);
});

describe("runLaunch — prospective mounted publication", () => {
  test("refuses dispatch when complete registration has no durable receipt and reports resumable verification", async () => {
    const clock = makeClock();
    await setUpLockedDraft(clock);
    expect((await publicationConfigure(contextFor(clock), {
      draftId: "draft-1",
      publicBaseUrl: "https://public.example/publication",
    })).ok).toBe(true);
    const current = readRunState(workspaceDir, "draft-1");
    if (current?.publication === undefined) throw new Error("configured publication state missing");
    writeRunState(workspaceDir, "draft-1", {
      ...current,
      publication: {
        ...current.publication,
        registration: {
          state: "complete",
          announcedAt: "2026-08-05T00:00:00.000Z",
          postHoc: false,
          digests: { run: current.runSha256! },
        },
      },
    });

    let venueCalls = 0;
    const outcome = await runLaunch(contextFor(clock), { draftId: "draft-1" }, {
      createVenue: () => { venueCalls += 1; throw new Error("backend must not be constructed"); },
    });
    expect(outcome).toMatchObject({
      ok: false,
      error: { code: "conflict", detail: expect.stringMatching(/pending\/unverified.*durable receipt.*retry registration/i) },
    });
    expect(venueCalls).toBe(0);
    expect(readDraftDocument(workspaceDir, "draft-1").state).toBe("locked");
    expect(readRunState(workspaceDir, "draft-1")?.launchedAt).toBeUndefined();

    const status = publicationStatus(contextFor(clock), { draftId: "draft-1" });
    expect(status).toMatchObject({
      ok: true,
      result: {
        registrationTiming: "pending-verification",
        recovery: { resumable: true, guidance: expect.stringMatching(/durable receipt.*retry/i) },
      },
    });
  }, 30_000);

  test("registers and probes every prospective Submission beneath the exact nested archive mount", async () => {
    const clock = makeClock();
    await setUpLockedDraft(clock);
    const handler = createWorkspacePublicationHttpHandler(workspaceDir);
    const requested: string[] = [];
    const server = createServer(async (request, response) => {
      const externalPath = request.url ?? "/";
      requested.push(externalPath);
      if (!externalPath.startsWith("/publication/")) { response.writeHead(404).end(); return; }
      const result = await handler(new Request(`http://127.0.0.1${externalPath.slice("/publication".length)}`, { method: request.method }));
      response.writeHead(result.status, Object.fromEntries(result.headers));
      response.end(Buffer.from(await result.arrayBuffer()));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("test server address unavailable");
      const base = `http://127.0.0.1:${address.port}/publication`;
      expect((await publicationConfigure(contextFor(clock), { draftId: "draft-1", publicBaseUrl: base })).ok).toBe(true);
      expect((await publicationRegister(contextFor(clock), { draftId: "draft-1" })).ok).toBe(true);
      const { backend, submits } = makeStatefulFakeBackend();
      const outcome = await runLaunch(contextFor(clock), { draftId: "draft-1" }, { createVenue: () => fakeVenue(backend) });
      expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
      expect(submits.length).toBeGreaterThan(0);
      expect(requested.length).toBeGreaterThan(submits.length);
      expect(requested.every((path) => path.startsWith("/publication/"))).toBe(true);
      expect(requested.some((path) => path.startsWith("/publication/records/"))).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 30_000);

  test("resume reconstructs a public Submission committed before its local capture journal fact", async () => {
    const clock = makeClock();
    await setUpLockedDraft(clock);
    const handler = createWorkspacePublicationHttpHandler(workspaceDir);
    const server = createServer(async (request, response) => {
      const externalPath = request.url ?? "/";
      if (!externalPath.startsWith("/publication/")) { response.writeHead(404).end(); return; }
      const result = await handler(new Request(`http://127.0.0.1${externalPath.slice("/publication".length)}`, { method: request.method }));
      response.writeHead(result.status, Object.fromEntries(result.headers));
      response.end(Buffer.from(await result.arrayBuffer()));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("test server address unavailable");
      const base = `http://127.0.0.1:${address.port}/publication`;
      expect((await publicationConfigure(contextFor(clock), { draftId: "draft-1", publicBaseUrl: base })).ok).toBe(true);
      expect((await publicationRegister(contextFor(clock), { draftId: "draft-1" })).ok).toBe(true);
      const { backend: launchBackend } = makeStatefulFakeBackend();
      expect((await runLaunch(contextFor(clock), { draftId: "draft-1" }, { createVenue: () => fakeVenue(launchBackend) })).ok).toBe(true);

      const fullEntries = readRunJournalEntries(workspaceDir, "draft-1");
      const captured = fullEntries.find(
        (entry) => entry.kind === "submission-captured" && entry.publicationSourceSequence !== undefined,
      );
      if (captured?.kind !== "submission-captured") throw new Error("fixture produced no prospective Submission capture");
      const source = createWorkspacePublicationSource(workspaceDir, "colophon-benchmarks");
      const sourceBefore = await source.writer.readState();
      if (sourceBefore === undefined) throw new Error("fixture produced no public source state");
      const announcementCount = Object.keys(sourceBefore.announcements).length;

      // The public append and sealed record remain, but every local fact for this coordinate is
      // absent: the exact crash boundary between source.writer.append and the journal append.
      overwriteRunJournal("draft-1", fullEntries.filter((entry) => {
        if (entry.kind === "cell-event") return entry.event.cellKey !== captured.cellKey;
        if (
          entry.kind === "submission-captured"
          || entry.kind === "submission-pinning-evidence"
          || entry.kind === "submission-accepted"
          || entry.kind === "observation-accepted"
          || entry.kind === "delivery"
          || entry.kind === "evaluation"
        ) return entry.cellKey !== captured.cellKey;
        return true;
      }));

      const { backend: resumeBackend } = makeStatefulFakeBackend();
      const resumed = await runResume(contextFor(clock), { draftId: "draft-1" }, {
        createVenue: () => fakeVenue(resumeBackend),
      });
      expect(resumed.ok, JSON.stringify(resumed)).toBe(true);
      const after = readRunJournalEntries(workspaceDir, "draft-1");
      expect(after.filter(
        (entry) => entry.kind === "submission-captured" && entry.cellKey === captured.cellKey,
      )).toEqual([expect.objectContaining({
        submissionSha256: captured.submissionSha256,
        publicationSourceSequence: captured.publicationSourceSequence,
        publicationEntrySha256: captured.publicationEntrySha256,
      })]);
      const sourceAfter = await source.writer.readState();
      expect(Object.keys(sourceAfter?.announcements ?? {})).toHaveLength(announcementCount);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 30_000);
});

describe("runLaunch — drives a full 2-arm run to completion (fake backend)", () => {
  test("threads the selected cell concurrency into venue capacity and the durable journal", async () => {
    const clock = makeClock();
    await setUpLockedDraft(clock);
    const { backend } = makeStatefulFakeBackend();
    const capacities: Array<number | undefined> = [];
    const outcome = await runLaunch(contextFor(clock), {
      draftId: "draft-1",
      maxConcurrentCells: 8,
    }, {
      createVenue: (options) => {
        capacities.push(options.maxConcurrentAttempts);
        return fakeVenue(backend);
      },
      driverGenerationForTesting: () => "concurrency-eight-generation",
    });
    expect(outcome.ok).toBe(true);
    expect(capacities).toEqual([8]);
    expect(readRunJournalEntries(workspaceDir, "draft-1")).toContainEqual(
      expect.objectContaining({
        kind: "driver-started",
        operation: "launch",
        generation: "concurrency-eight-generation",
        maxConcurrentCells: 8,
      }),
    );
  }, 30_000);

  test("records the historical serial default explicitly", async () => {
    const clock = makeClock();
    await setUpLockedDraft(clock);
    const { backend } = makeStatefulFakeBackend();
    const outcome = await runLaunch(contextFor(clock), { draftId: "draft-1" }, {
      createVenue: () => fakeVenue(backend),
      driverGenerationForTesting: () => "serial-default-generation",
    });
    expect(outcome.ok).toBe(true);
    expect(readRunJournalEntries(workspaceDir, "draft-1")).toContainEqual(
      expect.objectContaining({
        kind: "driver-started",
        generation: "serial-default-generation",
        maxConcurrentCells: 1,
      }),
    );
  }, 30_000);

  test("a shutdown rejection is the generation's single durable failed terminal", async () => {
    const clock = makeClock();
    await setUpLockedDraft(clock);
    const { backend } = makeStatefulFakeBackend();
    const venue = fakeVenue(backend);
    const outcome = await runLaunch(contextFor(clock), { draftId: "draft-1" }, {
      createVenue: () => ({
        ...venue,
        async shutdown() {
          throw new Error("late shutdown rejection");
        },
      }),
      driverGenerationForTesting: () => "shutdown-failure-generation",
    });

    expect(outcome).toMatchObject({
      ok: false,
      error: { code: "execution", detail: "late shutdown rejection" },
    });
    const status = runStatus(contextFor(clock), { draftId: "draft-1" });
    expect(status).toMatchObject({
      ok: true,
      result: {
        driver: {
          generation: "shutdown-failure-generation",
          status: "failed",
          error: { code: "execution", detail: "late shutdown rejection" },
        },
      },
    });
    const terminals = readRunJournalEntries(workspaceDir, "draft-1").filter((entry) =>
      (entry.kind === "driver-succeeded" || entry.kind === "driver-failed")
      && entry.generation === "shutdown-failure-generation");
    expect(terminals).toEqual([
      expect.objectContaining({ kind: "driver-failed", generation: "shutdown-failure-generation" }),
    ]);
  });

  test("a readiness failure after synchronous ownership is a durable failed generation", async () => {
    const clock = makeClock();
    await setUpLockedDraft(clock);
    const { backend } = makeStatefulFakeBackend();
    const venue = fakeVenue(backend);
    const outcome = await runLaunch(contextFor(clock), { draftId: "draft-1" }, {
      createVenue: () => ({
        ...venue,
        assertRunOwnership() {},
        async preflightRun() {
          await new Promise<void>((resolve) => setImmediate(resolve));
          throw new Error("delayed launcher probe failure");
        },
      }),
      driverGenerationForTesting: () => "delayed-preflight-generation",
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("venue-unavailable");
    const status = runStatus(contextFor(clock), { draftId: "draft-1" });
    expect(status.ok).toBe(true);
    if (!status.ok) return;
    expect(status.result.driver).toMatchObject({
      generation: "delayed-preflight-generation",
      status: "failed",
      error: { code: "venue-unavailable", detail: "delayed launcher probe failure" },
    });
  });

  test("every expected cell reaches delivered + judged; RunState.launchedAt set; draft running", async () => {
    const clock = makeClock();
    await setUpLockedDraft(clock);
    const { backend, submits } = makeStatefulFakeBackend();

    const outcome = await runLaunch(contextFor(clock), { draftId: "draft-1" }, { createVenue: () => fakeVenue(backend) });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.draft.state).toBe("running");

    const state = readRunState(workspaceDir, "draft-1");
    expect(state?.launchedAt).toBeDefined();

    const entries = readRunJournalEntries(workspaceDir, "draft-1");
    expect(entries[0]).toMatchObject({ kind: "launched" });

    // 2 arms x 3 sample tasks x 1 replicate = 6 expected cells.
    const deliveredEvents = entries.filter((entry) => entry.kind === "cell-event" && entry.event.kind === "delivered");
    expect(deliveredEvents).toHaveLength(6);
    const deliveryEntries = entries.filter((entry) => entry.kind === "delivery");
    expect(deliveryEntries).toHaveLength(6);
    const evaluationEntries = entries.filter((entry) => entry.kind === "evaluation");
    expect(evaluationEntries).toHaveLength(6);
    expect(evaluationEntries.every((entry) => entry.kind === "evaluation" && entry.verdictSha256 !== undefined)).toBe(true);

    // Every eval Submission pinned the evaluation-harness requirement.
    const evalSubmits = submits.filter((call) => {
      const doc = JSON.parse(new TextDecoder().decode(call.submissionBytes)) as { requirements?: { harness?: { id?: string } } };
      return doc.requirements?.harness?.id === "evaluation-harness";
    });
    expect(evalSubmits).toHaveLength(6);
  }, 30_000);
});

describe("runLaunch — minVerdicts threads from the SEALED Run into the venue and drive (BP-21)", () => {
  test("a minVerdicts-2 assurance mints a 2-evaluator venue and dispatches 2 evaluation legs per delivered cell", async () => {
    const clock = makeClock();
    await setUpLockedDraft(clock, "draft-1", { preset: "direct-check", overrides: { minVerdicts: 2 } });
    const { backend, submits } = makeStatefulFakeBackend();
    const venueOptions: { evaluatorCount?: number }[] = [];

    const outcome = await runLaunch(contextFor(clock), { draftId: "draft-1" }, {
      createVenue: (options) => {
        venueOptions.push({ ...(options.evaluatorCount !== undefined ? { evaluatorCount: options.evaluatorCount } : {}) });
        return fakeVenue(backend, 2);
      },
    });
    expect(outcome.ok).toBe(true);

    // The venue was created with one evaluator identity per required verdict.
    expect(venueOptions).toEqual([{ evaluatorCount: 2 }]);

    // 6 solve cells x 2 legs = 12 evaluation Submissions, leg-distinct keys and evaluators.
    const evalDocs = submits
      .map((call) => JSON.parse(new TextDecoder().decode(call.submissionBytes)) as {
        idempotencyKey?: string;
        requirements?: Record<string, unknown>;
      })
      .filter((doc) => (doc.requirements?.["harness"] as { id?: string } | undefined)?.id === "evaluation-harness");
    expect(evalDocs).toHaveLength(12);
    expect(evalDocs.filter((doc) => doc.idempotencyKey?.includes(":e1:")).length).toBe(6);
    expect(evalDocs.filter((doc) => doc.idempotencyKey?.includes(":e2:")).length).toBe(6);
    expect(new Set(evalDocs.map((doc) => doc.idempotencyKey)).size).toBe(12);

    // Every cell journals one evaluation entry per leg, evaluator- and index-attributed.
    const entries = readRunJournalEntries(workspaceDir, "draft-1");
    const evaluationEntries = entries.filter(
      (entry): entry is Extract<RunJournalEntry, { kind: "evaluation" }> => entry.kind === "evaluation",
    );
    expect(evaluationEntries).toHaveLength(12);
    const byCell = new Map<string, number[]>();
    for (const entry of evaluationEntries) {
      expect(entry.verdictSha256).toBeDefined();
      expect(entry.evaluator).toBe(`urn:jinn:benchmark-product:local-venue:evaluator-${entry.evalIndex}`);
      byCell.set(entry.cellKey, [...(byCell.get(entry.cellKey) ?? []), entry.evalIndex ?? 0]);
    }
    expect(byCell.size).toBe(6);
    for (const [cellKey, evalIndexes] of byCell) {
      expect(evalIndexes.sort((a, b) => a - b), cellKey).toEqual([1, 2]);
    }
  }, 30_000);
});

describe("runResume — minVerdicts-aware evaluation catch-up (BP-21)", () => {
  test("a dropped leg-2 evaluation entry resumes exactly leg 2, not leg 1", async () => {
    const clock = makeClock();
    await setUpLockedDraft(clock, "draft-1", { preset: "direct-check", overrides: { minVerdicts: 2 } });
    const { backend: launchBackend } = makeStatefulFakeBackend();
    const launched = await runLaunch(contextFor(clock), { draftId: "draft-1" }, {
      createVenue: () => fakeVenue(launchBackend, 2),
    });
    expect(launched.ok).toBe(true);

    const fullEntries = readRunJournalEntries(workspaceDir, "draft-1");
    const legTwoEntries = fullEntries.filter((entry) => entry.kind === "evaluation" && entry.evalIndex === 2);
    expect(legTwoEntries).toHaveLength(6);
    const [dropped] = legTwoEntries;
    if (dropped?.kind !== "evaluation") throw new Error("unreachable");
    const gapCellKey = dropped.cellKey;
    overwriteRunJournal("draft-1", fullEntries.filter((entry) => entry !== dropped));

    const { backend: resumeBackend, submits } = makeStatefulFakeBackend();
    const outcome = await runResume(contextFor(clock), { draftId: "draft-1" }, {
      createVenue: () => fakeVenue(resumeBackend, 2),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.outstandingCount).toBe(0);
    expect(outcome.result.evaluationCatchUpCount).toBe(1);

    // Exactly ONE evaluation Submission was re-dispatched — leg 2's.
    expect(submits).toHaveLength(1);
    const doc = JSON.parse(new TextDecoder().decode(submits[0]!.submissionBytes)) as { idempotencyKey?: string };
    expect(doc.idempotencyKey).toContain(":e2:");
    expect(doc.idempotencyKey).toContain(gapCellKey);

    const afterEntries = readRunJournalEntries(workspaceDir, "draft-1");
    const gapEvaluations = afterEntries.filter((entry) => entry.kind === "evaluation" && entry.cellKey === gapCellKey);
    expect(gapEvaluations).toHaveLength(2);
    expect(gapEvaluations.map((entry) => (entry.kind === "evaluation" ? entry.evalIndex : 0)).sort()).toEqual([1, 2]);
  }, 30_000);
});

/**
 * The exact progress line a journal entry produces (BP-13, `../run/drive.ts`'s own `onProgress`
 * emission points) — `undefined` for entry kinds that emit no line ("launched",
 * "submission-accepted", "delivery", "closed"). Used to assert `onProgress` sees exactly the
 * journal's own cell-event/evaluation entries, in the journal's own append order — the strongest
 * ordering claim available, since `driveCellEvents` emits each line synchronously right after the
 * journal write it describes.
 */
function expectedProgressLine(entry: RunJournalEntry): string | undefined {
  if (entry.kind === "cell-event") return `${entry.event.cellKey} ${entry.event.kind}`;
  if (entry.kind === "evaluation") {
    return entry.evaluationTerminal === "could-not-grade" ? `${entry.cellKey} could-not-grade` : `${entry.cellKey} judged`;
  }
  return undefined;
}

describe("runLaunch — onProgress streaming (BP-13)", () => {
  test("emits one line per cell-event and evaluation terminal, in the journal's own append order", async () => {
    const clock = makeClock();
    await setUpLockedDraft(clock);
    const { backend } = makeStatefulFakeBackend();
    const lines: string[] = [];

    const outcome = await runLaunch(contextFor(clock), { draftId: "draft-1" }, {
      createVenue: () => fakeVenue(backend),
      onProgress: (line) => lines.push(line),
    });
    expect(outcome.ok).toBe(true);

    const entries = readRunJournalEntries(workspaceDir, "draft-1");
    const expectedLines = entries.map(expectedProgressLine).filter((line): line is string => line !== undefined);

    // 6 cells x (dispatch + delivered cell-events) + 6 judged evaluation terminals = 18 lines.
    expect(expectedLines).toHaveLength(18);
    expect(lines).toEqual(expectedLines);
  }, 30_000);

  test("omitting onProgress leaves the journal and return value byte-identical (purely additive)", async () => {
    const clock = makeClock();
    await setUpLockedDraft(clock, "draft-with-progress");
    await setUpLockedDraft(clock, "draft-without-progress");
    const { backend: backendA } = makeStatefulFakeBackend();
    const { backend: backendB } = makeStatefulFakeBackend();

    const withProgress = await runLaunch(contextFor(clock), { draftId: "draft-with-progress" }, {
      createVenue: () => fakeVenue(backendA),
      onProgress: () => {},
    });
    const withoutProgress = await runLaunch(contextFor(clock), { draftId: "draft-without-progress" }, {
      createVenue: () => fakeVenue(backendB),
    });
    expect(withProgress.ok).toBe(true);
    expect(withoutProgress.ok).toBe(true);
    if (!withProgress.ok || !withoutProgress.ok) return;
    expect(withProgress.result.draft.state).toBe(withoutProgress.result.draft.state);

    const entriesWith = readRunJournalEntries(workspaceDir, "draft-with-progress");
    const entriesWithout = readRunJournalEntries(workspaceDir, "draft-without-progress");
    // Compared by kind/shape rather than by exact bytes — the two drafts share one advancing
    // clock, so their `at` stamps genuinely differ — but the SEQUENCE of journal-entry kinds an
    // identical 2-arm run produces must be identical whether or not `onProgress` is supplied.
    expect(entriesWith.map((entry) => entry.kind)).toEqual(entriesWithout.map((entry) => entry.kind));
  }, 30_000);
});

/** Wraps a fake backend's `submit` so the cancel marker is written right after the Nth accepted
 * submission — a test-only way to prove `launchAndWatch`/`resumeRun`'s own `earlyClose` getter
 * (`../run/cancel-marker.ts`'s `cancelRequested`, threaded through in `run-launch.ts`) genuinely
 * reacts to a marker written MID-drive, not only one present before the call started. */
function withCancelAfterNthSubmit(
  inner: ProxiedBackend,
  writeMarkerAt: () => void,
  n: number,
): ProxiedBackend {
  let count = 0;
  return {
    ...inner,
    async submit(taskBytes, submissionBytes, engagement) {
      const ack = await inner.submit(taskBytes, submissionBytes, engagement);
      count += 1;
      if (count === n) writeMarkerAt();
      return ack;
    },
  };
}

describe("runLaunch — earlyClose getter reacts to a marker written mid-drive (BP-22)", () => {
  test("a marker written during the first cell's own solve dispatch stops the loop before a second cell is ever touched", async () => {
    const clock = makeClock();
    await setUpLockedDraft(clock);
    const { backend } = makeStatefulFakeBackend();
    // Fires after the FIRST accepted submission (the first cell's own solve dispatch) — every
    // later cell's outer-loop boundary check must then see the marker and stop.
    const wrapped = withCancelAfterNthSubmit(
      backend,
      () => writeCancelMarker(workspaceDir, "draft-1", { requestedAt: "2026-08-05T00:00:00Z", principal: "sponsor-1" }),
      1,
    );

    const outcome = await runLaunch(contextFor(clock), { draftId: "draft-1" }, { createVenue: () => fakeVenue(wrapped) });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // The drive stopping early is not itself a failure — launch still returns ok; a later
    // `run.cancel` is what finalizes the closed state and seals the Matrix.
    expect(outcome.result.draft.state).toBe("running");

    const entries = readRunJournalEntries(workspaceDir, "draft-1");
    const touchedCellKeys = new Set(
      entries
        .filter((entry) => entry.kind === "cell-event" && entry.event.cellKey !== "*")
        .map((entry) => (entry.kind === "cell-event" ? entry.event.cellKey : "")),
    );
    // Exactly one of the 6 expected cells was ever dispatched.
    expect(touchedCellKeys.size).toBe(1);

    const finalEvent = entries.find((entry) => entry.kind === "cell-event" && entry.event.cellKey === "*");
    expect(finalEvent).toMatchObject({ kind: "cell-event", event: { kind: "cancelled", cancelledRun: true } });
  }, 30_000);
});

describe("runResume — lifecycle guard", () => {
  test("refuses illegal-transition when the draft is not running", async () => {
    const clock = makeClock();
    await setUpLockedDraft(clock);

    const outcome = await runResume(contextFor(clock), { draftId: "draft-1" });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("illegal-transition");
  });

  test("refuses conflict when a cancel marker is already present (BP-22) — an interrupted cancel resumes via 'cancel', not 'resume'", async () => {
    const clock = makeClock();
    await setUpLockedDraft(clock);
    const { backend } = makeStatefulFakeBackend();
    const launched = await runLaunch(contextFor(clock), { draftId: "draft-1" }, { createVenue: () => fakeVenue(backend) });
    expect(launched.ok).toBe(true);

    writeCancelMarker(workspaceDir, "draft-1", { requestedAt: clock(), principal: "sponsor-1" });

    const outcome = await runResume(contextFor(clock), { draftId: "draft-1" });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("conflict");
  }, 30_000);

  test("a marker written during the first outstanding cell's own dispatch stops the loop before the second outstanding cell is redispatched", async () => {
    const clock = makeClock();
    await setUpLockedDraft(clock);
    const { backend: launchBackend } = makeStatefulFakeBackend();
    const launched = await runLaunch(contextFor(clock), { draftId: "draft-1" }, { createVenue: () => fakeVenue(launchBackend) });
    expect(launched.ok).toBe(true);

    // Simulate "launch crashed before two cells were ever touched": drop every journal entry
    // naming either of the first two delivered cells, so runResume has 2 outstanding cells.
    const fullEntries = readRunJournalEntries(workspaceDir, "draft-1");
    const deliveredCells = fullEntries
      .filter((entry) => entry.kind === "cell-event" && entry.event.kind === "delivered")
      .map((entry) => (entry.kind === "cell-event" ? entry.event.cellKey : ""));
    const [droppedA, droppedB] = deliveredCells;
    expect(droppedA).toBeDefined();
    expect(droppedB).toBeDefined();
    const truncated = fullEntries.filter((entry) => {
      if (entry.kind === "cell-event") return entry.event.cellKey !== droppedA && entry.event.cellKey !== droppedB;
      if (entry.kind === "submission-captured" || entry.kind === "submission-pinning-evidence" || entry.kind === "submission-accepted" || entry.kind === "observation-accepted" || entry.kind === "delivery" || entry.kind === "evaluation") {
        return entry.cellKey !== droppedA && entry.cellKey !== droppedB;
      }
      return true;
    });
    overwriteRunJournal("draft-1", truncated);

    const { backend: resumeBackend } = makeStatefulFakeBackend();
    // Fires after the FIRST accepted submission of this resume call (the first outstanding
    // cell's own solve dispatch) — the second outstanding cell's boundary check must then see
    // the marker and drain instead of redispatching.
    const wrapped = withCancelAfterNthSubmit(
      resumeBackend,
      () => writeCancelMarker(workspaceDir, "draft-1", { requestedAt: "2026-08-05T00:00:00Z", principal: "sponsor-1" }),
      1,
    );

    const outcome = await runResume(contextFor(clock), { draftId: "draft-1" }, { createVenue: () => fakeVenue(wrapped) });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const afterEntries = readRunJournalEntries(workspaceDir, "draft-1");
    // One of the two previously-outstanding cells was re-dispatched to completion; the other
    // was drained with a "cancelled" terminal instead of being resubmitted.
    const cancelledDrainEntry = afterEntries.find(
      (entry) =>
        entry.kind === "cell-event"
        && entry.event.kind === "cancelled"
        && entry.event.detail === "drain-to-boundary"
        && (entry.event.cellKey === droppedA || entry.event.cellKey === droppedB),
    );
    expect(cancelledDrainEntry).toBeDefined();
    const redeliveredEntry = afterEntries.find(
      (entry) => entry.kind === "cell-event" && entry.event.kind === "delivered" && (entry.event.cellKey === droppedA || entry.event.cellKey === droppedB),
    );
    expect(redeliveredEntry).toBeDefined();
  }, 30_000);

  test("ungated: a bare workspace member with no grants can resume", async () => {
    const clock = makeClock();
    await setUpLockedDraft(clock);
    const { backend } = makeStatefulFakeBackend();
    const launched = await runLaunch(contextFor(clock), { draftId: "draft-1" }, { createVenue: () => fakeVenue(backend) });
    expect(launched.ok).toBe(true);

    authorityGrant(contextFor(clock), { principalId: "agent-1", operations: [] });
    const outcome = await runResume(contextFor(clock, "agent-1"), { draftId: "draft-1" }, { createVenue: () => fakeVenue(backend) });
    expect(outcome.ok).toBe(true);
  }, 30_000);
});

/** Rewrites the run journal to exactly `entries` — a test-only fixture technique (the append-only
 * journal has no public rewrite API); simulates "the process was killed and lost everything
 * after this point" more faithfully than trying to interrupt a live async generator mid-stream. */
function overwriteRunJournal(draftId: string, entries: readonly unknown[]): void {
  atomicWriteFileSync(runJournalPath(workspaceDir, draftId), `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
}

describe("runResume — re-dispatches only outstanding cells", () => {
  test("a venue contender returns before ownership and cannot journal or mask the active owner", async () => {
    const clock = () => "2026-08-05T00:00:00.000Z";
    await setUpLockedDraft(clock);
    const { backend } = makeStatefulFakeBackend();
    let releaseFirstSubmit!: () => void;
    const submitGate = new Promise<void>((resolve) => { releaseFirstSubmit = resolve; });
    let firstSubmit = true;
    const blockingBackend: ProxiedBackend = {
      ...backend,
      async submit(taskBytes, submissionBytes) {
        if (firstSubmit) {
          firstSubmit = false;
          await submitGate;
        }
        return backend.submit(taskBytes, submissionBytes);
      },
    };
    const ownerVenue = fakeVenue(blockingBackend);
    const owner = runLaunch(contextFor(clock), { draftId: "draft-1" }, {
      createVenue: () => ({ ...ownerVenue, assertRunOwnership() {} }),
    });

    for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
    expect(readRunJournalEntries(workspaceDir, "draft-1").filter((entry) => entry.kind === "driver-started"))
      .toHaveLength(1);

    const contenderVenue = fakeVenue(backend);
    const contender = await runResume(contextFor(clock), { draftId: "draft-1" }, {
      createVenue: () => ({
        ...contenderVenue,
        assertRunOwnership() { throw new Error("state root locked"); },
      }),
    });
    expect(contender.ok).toBe(false);
    if (contender.ok) return;
    expect(contender.error.code).toBe("venue-unavailable");
    expect(readRunJournalEntries(workspaceDir, "draft-1").filter((entry) => entry.kind === "driver-started"))
      .toHaveLength(1);
    let status = runStatus(contextFor(clock), { draftId: "draft-1" });
    expect(status.ok).toBe(true);
    if (!status.ok) return;
    expect(status.result.driver?.status).toBe("active");

    releaseFirstSubmit();
    const completed = await owner;
    expect(completed.ok).toBe(true);
    status = runStatus(contextFor(clock), { draftId: "draft-1" });
    expect(status.ok).toBe(true);
    if (!status.ok) return;
    expect(status.result.driver?.status).toBe("succeeded");
  }, 30_000);

  test("reconciles a captured in-flight Submission before resuming its exact dispatch", async () => {
    const clock = makeClock();
    await setUpLockedDraft(clock);
    const { backend: launchBackend } = makeStatefulFakeBackend();
    const launched = await runLaunch(contextFor(clock), { draftId: "draft-1" }, {
      createVenue: () => fakeVenue(launchBackend),
    });
    expect(launched.ok).toBe(true);

    const fullEntries = readRunJournalEntries(workspaceDir, "draft-1");
    const delivered = fullEntries.find(
      (entry) => entry.kind === "cell-event" && entry.event.kind === "delivered",
    );
    if (delivered?.kind !== "cell-event") throw new Error("fixture produced no delivered cell");
    const cellKey = delivered.event.cellKey;
    const captured = fullEntries.find(
      (entry) => entry.kind === "submission-captured" && entry.cellKey === cellKey,
    );
    if (captured?.kind !== "submission-captured") throw new Error("fixture produced no captured Submission");

    // Retain the pre-submit capture and dispatch event, but remove everything that says this
    // cell reached a terminal. This is the product-journal shape of the real crash boundary:
    // backend outcome durable, product delivery/terminal not yet observed.
    overwriteRunJournal("draft-1", fullEntries.filter((entry) => {
      if (entry.kind === "cell-event" && entry.event.cellKey === cellKey) {
        return entry.event.kind === "dispatch";
      }
      if (
        (entry.kind === "observation-accepted"
          || entry.kind === "delivery"
          || entry.kind === "evaluation")
        && entry.cellKey === cellKey
      ) return false;
      return true;
    }));

    const { backend: resumeBackend, recoveries, submits } = makeStatefulFakeBackend();
    const outcome = await runResume(contextFor(clock), { draftId: "draft-1" }, {
      createVenue: () => fakeVenue(resumeBackend),
    });
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    expect(recoveries).toHaveLength(1);
    const capturedDocument = JSON.parse(new TextDecoder().decode(
      getSealedBytes(workspaceDir, captured.submissionSha256),
    )) as { readonly submission: string };
    expect(recoveries).toEqual([capturedDocument.submission]);
    expect(submits).toHaveLength(2);
    const afterEntries = readRunJournalEntries(workspaceDir, "draft-1");
    expect(afterEntries.filter(
      (entry) => entry.kind === "submission-captured" && entry.cellKey === cellKey,
    )).toHaveLength(1);
    expect(afterEntries.filter(
      (entry) => entry.kind === "submission-accepted" && entry.leg !== "evaluation" && entry.cellKey === cellKey,
    )).toHaveLength(1);
    expect(afterEntries.filter(
      (entry) => entry.kind === "observation-accepted" && entry.cellKey === cellKey,
    )).toHaveLength(1);
  }, 30_000);

  test("fails closed when backend recovery contradicts a captured Submission", async () => {
    const clock = makeClock();
    await setUpLockedDraft(clock);
    const { backend: launchBackend } = makeStatefulFakeBackend();
    const launched = await runLaunch(contextFor(clock), { draftId: "draft-1" }, {
      createVenue: () => fakeVenue(launchBackend),
    });
    expect(launched.ok).toBe(true);

    const fullEntries = readRunJournalEntries(workspaceDir, "draft-1");
    const delivered = fullEntries.find(
      (entry) => entry.kind === "cell-event" && entry.event.kind === "delivered",
    );
    if (delivered?.kind !== "cell-event") throw new Error("fixture produced no delivered cell");
    const cellKey = delivered.event.cellKey;
    overwriteRunJournal("draft-1", fullEntries.filter((entry) => {
      if (entry.kind === "cell-event" && entry.event.cellKey === cellKey) {
        return entry.event.kind === "dispatch";
      }
      if (
        (entry.kind === "observation-accepted"
          || entry.kind === "delivery"
          || entry.kind === "evaluation")
        && entry.cellKey === cellKey
      ) return false;
      return true;
    }));

    const { backend: resumeBackend, submits } = makeStatefulFakeBackend();
    resumeBackend.recover = async () => ({
      classification: "contradictory",
      detail: "durable attempt differs from captured bytes",
    });
    const outcome = await runResume(contextFor(clock), { draftId: "draft-1" }, {
      createVenue: () => fakeVenue(resumeBackend),
    });
    expect(outcome).toMatchObject({
      ok: false,
      error: {
        code: "record-integrity",
        detail: expect.stringContaining("backend recovery contradicted"),
      },
    });
    expect(submits).toHaveLength(0);
  }, 30_000);

  test("a cell whose journal entries are entirely missing (crash before it was ever dispatched) is picked up; already-complete cells are untouched", async () => {
    const clock = makeClock();
    await setUpLockedDraft(clock);
    const { backend: launchBackend } = makeStatefulFakeBackend();
    const launched = await runLaunch(contextFor(clock), { draftId: "draft-1" }, { createVenue: () => fakeVenue(launchBackend) });
    expect(launched.ok).toBe(true);
    const fullEntries = readRunJournalEntries(workspaceDir, "draft-1");
    const deliveredCells = fullEntries
      .filter((entry) => entry.kind === "cell-event" && entry.event.kind === "delivered")
      .map((entry) => (entry.kind === "cell-event" ? entry.event.cellKey : ""));
    expect(deliveredCells).toHaveLength(6);
    const [droppedCellKey] = deliveredCells;
    expect(droppedCellKey).toBeDefined();

    // Simulate "launch crashed before this one cell was ever touched": drop every journal entry
    // naming it, keeping the other 5 cells' entries (and the launched marker) intact.
    const truncated = fullEntries.filter((entry) => {
      if (entry.kind === "cell-event") return entry.event.cellKey !== droppedCellKey;
      if (entry.kind === "submission-captured" || entry.kind === "submission-pinning-evidence" || entry.kind === "submission-accepted" || entry.kind === "observation-accepted" || entry.kind === "delivery" || entry.kind === "evaluation") {
        return entry.cellKey !== droppedCellKey;
      }
      return true;
    });
    expect(truncated.length).toBeLessThan(fullEntries.length);
    overwriteRunJournal("draft-1", truncated);

    const { backend: resumeBackend, submits } = makeStatefulFakeBackend();
    const outcome = await runResume(contextFor(clock), { draftId: "draft-1" }, { createVenue: () => fakeVenue(resumeBackend) });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.outstandingCount).toBe(1);
    expect(outcome.result.evaluationCatchUpCount).toBe(0);
    // Exactly the dropped cell's solve + evaluation Submissions were (re-)dispatched.
    expect(submits.length).toBe(2);

    const afterEntries = readRunJournalEntries(workspaceDir, "draft-1");
    const nowDelivered = afterEntries.filter((entry) => entry.kind === "cell-event" && entry.event.kind === "delivered");
    expect(nowDelivered).toHaveLength(6);
    const nowEvaluated = afterEntries.filter((entry) => entry.kind === "evaluation" && entry.verdictSha256 !== undefined);
    expect(nowEvaluated).toHaveLength(6);

    // The other 5 cells' entries were not touched — no duplicate dispatch/delivery for them.
    const untouchedCellKeys = deliveredCells.filter((cellKey) => cellKey !== droppedCellKey);
    for (const cellKey of untouchedCellKeys) {
      const original = fullEntries.filter((entry) =>
        (entry.kind === "cell-event" && entry.event.cellKey === cellKey)
        || ((entry.kind === "submission-captured" || entry.kind === "submission-pinning-evidence" || entry.kind === "submission-accepted" || entry.kind === "observation-accepted" || entry.kind === "delivery" || entry.kind === "evaluation") && entry.cellKey === cellKey));
      const after = afterEntries.filter((entry) =>
        (entry.kind === "cell-event" && entry.event.cellKey === cellKey)
        || ((entry.kind === "submission-captured" || entry.kind === "submission-pinning-evidence" || entry.kind === "submission-accepted" || entry.kind === "observation-accepted" || entry.kind === "delivery" || entry.kind === "evaluation") && entry.cellKey === cellKey));
      expect(after).toEqual(original);
    }
  }, 30_000);

  test("a clean run with nothing outstanding is a true no-op on resume", async () => {
    const clock = makeClock();
    await setUpLockedDraft(clock);
    const { backend: launchBackend } = makeStatefulFakeBackend();
    const launched = await runLaunch(contextFor(clock), { draftId: "draft-1" }, { createVenue: () => fakeVenue(launchBackend) });
    expect(launched.ok).toBe(true);
    const before = readRunJournalEntries(workspaceDir, "draft-1");

    const { backend: resumeBackend, submits } = makeStatefulFakeBackend();
    const outcome = await runResume(contextFor(clock), { draftId: "draft-1" }, { createVenue: () => fakeVenue(resumeBackend) });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.outstandingCount).toBe(0);
    expect(outcome.result.evaluationCatchUpCount).toBe(0);
    expect(submits).toHaveLength(0);
    expect(readRunJournalEntries(workspaceDir, "draft-1").slice(0, before.length)).toEqual(before);
    expect(readRunJournalEntries(workspaceDir, "draft-1").slice(before.length)).toEqual([
      expect.objectContaining({ kind: "driver-started", operation: "resume" }),
      expect.objectContaining({ kind: "driver-succeeded", operation: "resume" }),
    ]);
  }, 30_000);
});

describe("runResume — evaluation catch-up", () => {
  test("re-runs only the evaluation leg for a delivered-but-unevaluated cell, without re-dispatching solve", async () => {
    const clock = makeClock();
    await setUpLockedDraft(clock);
    const { backend: launchBackend } = makeStatefulFakeBackend();
    const launched = await runLaunch(contextFor(clock), { draftId: "draft-1" }, { createVenue: () => fakeVenue(launchBackend) });
    expect(launched.ok).toBe(true);
    const fullEntries = readRunJournalEntries(workspaceDir, "draft-1");
    const deliveredCells = fullEntries
      .filter((entry) => entry.kind === "cell-event" && entry.event.kind === "delivered")
      .map((entry) => (entry.kind === "cell-event" ? entry.event.cellKey : ""));
    const [gapCellKey] = deliveredCells;
    expect(gapCellKey).toBeDefined();

    // Simulate "delivered, then the process died before the verdict was journaled": drop just
    // the gap cell's own "evaluation" entry, keeping its cell-event and delivery entries intact.
    const missingVerdict = fullEntries.filter((entry) => !(entry.kind === "evaluation" && entry.cellKey === gapCellKey));
    expect(missingVerdict.length).toBe(fullEntries.length - 1);
    overwriteRunJournal("draft-1", missingVerdict);

    const { backend: resumeBackend, submits } = makeStatefulFakeBackend();
    const outcome = await runResume(contextFor(clock), { draftId: "draft-1" }, { createVenue: () => fakeVenue(resumeBackend) });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // The solve side is done — nothing is outstanding; only the evaluation catch-up sweep runs.
    expect(outcome.result.outstandingCount).toBe(0);
    expect(outcome.result.evaluationCatchUpCount).toBe(1);
    // Exactly one (evaluation-only) Submission was dispatched — no solve resubmission.
    expect(submits).toHaveLength(1);
    const submittedDoc = JSON.parse(new TextDecoder().decode(submits[0]!.submissionBytes)) as { requirements?: { harness?: { id?: string } } };
    expect(submittedDoc.requirements?.harness?.id).toBe("evaluation-harness");

    const afterEntries = readRunJournalEntries(workspaceDir, "draft-1");
    const gapEvaluation = afterEntries.find((entry) => entry.kind === "evaluation" && entry.cellKey === gapCellKey);
    expect(gapEvaluation).toMatchObject({ cellKey: gapCellKey, verdictSha256: expect.any(String) });

    // No NEW cell-event or delivery entries were written for the gap cell — solve side untouched.
    const gapCellEvents = afterEntries.filter((entry) =>
      (entry.kind === "cell-event" && entry.event.cellKey === gapCellKey) || (entry.kind === "delivery" && entry.cellKey === gapCellKey));
    const originalGapCellEvents = fullEntries.filter((entry) =>
      (entry.kind === "cell-event" && entry.event.cellKey === gapCellKey) || (entry.kind === "delivery" && entry.cellKey === gapCellKey));
    expect(gapCellEvents).toEqual(originalGapCellEvents);
  }, 30_000);
});
