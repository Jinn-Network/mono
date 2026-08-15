import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { AttemptUri, ObservationSnapshot, SubmissionUri } from "@jinn-network/task-execution-backend";
import { runsDir } from "../workspace/layout.js";
import { writeCancelMarker } from "./cancel-marker.js";
import { createCancellationAwareBackend } from "./cancellation-aware-backend.js";
import type { ProxiedBackend } from "./drive.js";

const ATTEMPT = "urn:uuid:00000000-0000-4000-8000-000000000001" as AttemptUri;
const SUBMISSION = "urn:uuid:00000000-0000-4000-8000-000000000002" as SubmissionUri;
const DIGEST = `sha256:${"a".repeat(64)}` as const;

let workspaceDir: string;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "bp22-cancel-aware-"));
  mkdirSync(runsDir(workspaceDir), { recursive: true });
});

afterEach(() => {
  rmSync(workspaceDir, { recursive: true, force: true });
});

function snapshot(terminal: boolean): ObservationSnapshot {
  return {
    descriptor: {
      attempt: ATTEMPT,
      derived: { terminal, state: terminal ? "cancelled" : "running" },
    },
    cursor: { sequence: terminal ? "2" : "1" },
    observations: [],
  } as unknown as ObservationSnapshot;
}

function fakeBackend(isTerminal: () => boolean, cancellations: AttemptUri[]): ProxiedBackend {
  return {
    async capabilities() {
      throw new Error("not used");
    },
    async submit() {
      throw new Error("not used");
    },
    async observe() {
      return snapshot(isTerminal());
    },
    async cancel(attempt) {
      cancellations.push(attempt);
      return { requested: true };
    },
    async recover() {
      throw new Error("not used");
    },
    async deliveries() {
      return [];
    },
    async fetchDelivery() {
      throw new Error("not used");
    },
    async drain() {},
  };
}

describe("createCancellationAwareBackend", () => {
  test("a marker during blocked submit cannot abort before the accepted attempt terminalizes", async () => {
    let terminal = false;
    const cancellations: AttemptUri[] = [];
    let announceSubmit!: () => void;
    const submitStarted = new Promise<void>((resolve) => { announceSubmit = resolve; });
    let releaseSubmit!: () => void;
    const submitRelease = new Promise<void>((resolve) => { releaseSubmit = resolve; });
    const backend: ProxiedBackend = {
      ...fakeBackend(() => terminal, cancellations),
      async submit() {
        announceSubmit();
        await submitRelease;
        return { accepted: true, submission: SUBMISSION, digest: DIGEST };
      },
    };
    const composition = createCancellationAwareBackend(backend, { workspaceDir, draftId: "draft-1" });
    const submitting = composition.backend.submit(new Uint8Array(), new Uint8Array());
    await submitStarted;
    writeCancelMarker(workspaceDir, "draft-1", {
      requestedAt: "2026-08-05T00:00:00Z",
      principal: "sponsor-1",
    });
    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(composition.signal.aborted).toBe(false);

    releaseSubmit();
    await submitting;
    expect(composition.signal.aborted).toBe(false);
    await composition.backend.observe(SUBMISSION);
    expect(cancellations).toEqual([ATTEMPT]);
    expect(composition.signal.aborted).toBe(false);
    terminal = true;
    await composition.backend.observe(ATTEMPT);
    expect(composition.signal.aborted).toBe(true);
    await composition.close();
  });

  test("a marker during blocked first observe keeps the accepted submission pending until its attempt drains", async () => {
    let terminal = false;
    const cancellations: AttemptUri[] = [];
    let firstObserve = true;
    let announceObserve!: () => void;
    const observeStarted = new Promise<void>((resolve) => { announceObserve = resolve; });
    let releaseObserve!: () => void;
    const observeRelease = new Promise<void>((resolve) => { releaseObserve = resolve; });
    const backend: ProxiedBackend = {
      ...fakeBackend(() => terminal, cancellations),
      async submit() {
        return { accepted: true, submission: SUBMISSION, digest: DIGEST };
      },
      async observe() {
        if (firstObserve) {
          firstObserve = false;
          announceObserve();
          await observeRelease;
        }
        return snapshot(terminal);
      },
    };
    const composition = createCancellationAwareBackend(backend, { workspaceDir, draftId: "draft-1" });
    await composition.backend.submit(new Uint8Array(), new Uint8Array());
    const observing = composition.backend.observe(SUBMISSION);
    await observeStarted;
    writeCancelMarker(workspaceDir, "draft-1", {
      requestedAt: "2026-08-05T00:00:00Z",
      principal: "sponsor-1",
    });
    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(composition.signal.aborted).toBe(false);

    releaseObserve();
    await observing;
    expect(cancellations).toEqual([ATTEMPT]);
    expect(composition.signal.aborted).toBe(false);
    terminal = true;
    await composition.backend.observe(ATTEMPT);
    expect(composition.signal.aborted).toBe(true);
    await composition.close();
  });

  test("a marker-check failure after accepted submit never double-decrements into a falsely safe boundary", async () => {
    const backend: ProxiedBackend = {
      ...fakeBackend(() => false, []),
      async submit() {
        return { accepted: true, submission: SUBMISSION, digest: DIGEST };
      },
      async cancel() {
        throw new Error("cancel port failed");
      },
    };
    const composition = createCancellationAwareBackend(backend, { workspaceDir, draftId: "draft-1" });
    // Establish one active attempt, then accept another submission while cancellation is pending.
    await composition.backend.observe(ATTEMPT);
    writeCancelMarker(workspaceDir, "draft-1", {
      requestedAt: "2026-08-05T00:00:00Z",
      principal: "sponsor-1",
    });
    await expect(composition.backend.submit(new Uint8Array(), new Uint8Array())).rejects.toThrow(/cancel port failed/u);
    expect(composition.signal.aborted).toBe(false);
    expect(composition.earlyClose).toBe(false);
    await expect(composition.close()).rejects.toThrow(/cancel port failed/u);
  });

  test("cancels a nonterminal attempt but aborts platform dispatch only after its true terminal snapshot", async () => {
    let terminal = false;
    const cancellations: AttemptUri[] = [];
    let composition: ReturnType<typeof createCancellationAwareBackend>;
    composition = createCancellationAwareBackend(fakeBackend(() => terminal, cancellations), {
      workspaceDir,
      draftId: "draft-1",
      onAttemptNonterminal() {
        expect(composition.signal.aborted).toBe(false);
        writeCancelMarker(workspaceDir, "draft-1", {
          requestedAt: "2026-08-05T00:00:00Z",
          principal: "sponsor-1",
        });
      },
    });

    const first = await composition.backend.observe(SUBMISSION);
    expect(first.descriptor.derived.terminal).toBe(false);
    expect(cancellations).toEqual([ATTEMPT]);
    expect(composition.signal.aborted).toBe(false);
    expect(composition.earlyClose).toBe(false);

    terminal = true;
    const drained = await composition.backend.observe(ATTEMPT);
    expect(drained.descriptor.derived).toMatchObject({ terminal: true, state: "cancelled" });
    expect(composition.signal.aborted).toBe(true);
    expect(composition.earlyClose).toBe(true);
    await composition.close();
  });

  test("the bounded durable-marker poll cancels even without another observe boundary", async () => {
    let terminal = false;
    const cancellations: AttemptUri[] = [];
    const composition = createCancellationAwareBackend(fakeBackend(() => terminal, cancellations), {
      workspaceDir,
      draftId: "draft-1",
    });
    await composition.backend.observe(SUBMISSION);
    writeCancelMarker(workspaceDir, "draft-1", {
      requestedAt: "2026-08-05T00:00:00Z",
      principal: "sponsor-1",
    });

    await expect.poll(() => cancellations.length, { timeout: 1_000 }).toBe(1);
    expect(composition.signal.aborted).toBe(false);
    terminal = true;
    await composition.backend.observe(ATTEMPT);
    expect(composition.signal.aborted).toBe(true);
    await composition.close();
  });

  test("a terminal observe queues a fresh post-delete check behind an overlapping cancellation check", async () => {
    let terminal = false;
    let releaseCancel!: () => void;
    const cancelRelease = new Promise<void>((resolve) => { releaseCancel = resolve; });
    let cancelStarted!: () => void;
    const cancelStart = new Promise<void>((resolve) => { cancelStarted = resolve; });
    const base = fakeBackend(() => terminal, []);
    const backend: ProxiedBackend = {
      ...base,
      async cancel() {
        cancelStarted();
        await cancelRelease;
        return { requested: true };
      },
    };
    const composition = createCancellationAwareBackend(backend, { workspaceDir, draftId: "draft-1" });
    await composition.backend.observe(SUBMISSION);
    writeCancelMarker(workspaceDir, "draft-1", {
      requestedAt: "2026-08-05T00:00:00Z",
      principal: "sponsor-1",
    });
    await cancelStart;

    terminal = true;
    const terminalObserve = composition.backend.observe(ATTEMPT);
    releaseCancel();
    await terminalObserve;
    expect(composition.signal.aborted).toBe(true);
    await composition.close();
  });
});
