import { TaskExecutionError } from "@jinn-network/task-execution-backend";
import { documentDigest, sealDelivery, sealSubmission, sealTask } from "@jinn-network/task-execution-protocol";
import { describe, expect, test } from "vitest";
import type { TestableBackend } from "./fake-backend.js";

let counter = 0;
function unique(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter}`;
}

const PROFILE = {
  uri: "https://jinn.network/task-profiles/repository-work/1.0",
  digest: { sha256: "3917f0428b2626fd2cc93675172731cc000b69d7d783f9adaf5159be56fd10a6" },
};

function taskBytes(): Uint8Array {
  return sealTask({
    protocol: "https://jinn.network/profiles/task-execution/1.0",
    profile: PROFILE,
    instructions: "Backend-contract sanity fixture.",
    outputs: [{ name: "patch", mediaType: "text/x-diff", required: true }],
  });
}

function submissionBytes(taskDigest: string, overrides: Record<string, unknown> = {}): Uint8Array {
  return sealSubmission({
    protocol: "https://jinn.network/profiles/task-execution/1.0",
    submission: `urn:uuid:${crypto.randomUUID()}`,
    task: { digest: { sha256: taskDigest.replace(/^sha256:/, "") } },
    requester: `urn:uuid:${crypto.randomUUID()}`,
    idempotencyKey: unique("backend-contract"),
    nonce: unique("nonce"),
    deadline: "2099-01-01T00:00:00Z",
    ...overrides,
  });
}

function deliveryBytesFor(taskDigest: string, attempt: string): Uint8Array {
  return sealDelivery({
    protocol: "https://jinn.network/profiles/task-execution/1.0",
    attempt,
    task: taskDigest,
    outputs: [{ name: "patch", mediaType: "text/x-diff", digest: { sha256: "b".repeat(64) } }],
    outcome: "fulfilled",
    createdAt: "2026-07-28T00:05:00Z",
  });
}

// `foldObservations` self-filters to the authoritative source pinned by `attempt-engaged`
// (§10.1/§10.4): a driven observation must carry that same envelope `source` to count toward
// derived state, so every fixture below takes the attempt's real authoritative `source` as a
// parameter rather than inventing its own producer identity.
function terminalObservation(
  attempt: string,
  source: string,
  state: "delivered" | "failed",
  blame?: "task" | "infrastructure",
) {
  return {
    specversion: "1.0" as const,
    id: unique("evt"),
    source,
    subject: attempt,
    time: new Date().toISOString(),
    datacontenttype: "application/json" as const,
    sequence: "9999999999999999",
    type: "network.jinn.task-execution.attempt-terminal.v1" as const,
    data: { state, ...(blame !== undefined ? { blame } : {}) },
  };
}

function startedObservation(attempt: string, source: string) {
  return {
    specversion: "1.0" as const,
    id: unique("evt"),
    source,
    subject: attempt,
    time: new Date().toISOString(),
    datacontenttype: "application/json" as const,
    sequence: "0000000000000050",
    type: "network.jinn.task-execution.attempt-started.v1" as const,
    data: { startedAt: new Date().toISOString() },
  };
}

async function submitAccepted(
  backend: TestableBackend,
  overrides: Record<string, unknown> = {},
): Promise<{ attempt: `urn:uuid:${string}`; taskDigest: `sha256:${string}`; source: string }> {
  const task = taskBytes();
  const taskDigest = documentDigest(task);
  const submission = submissionBytes(taskDigest, overrides);
  const ack = await backend.submit(task, submission);
  if (!ack.accepted) throw new Error(`expected acceptance, got ${JSON.stringify(ack.error)}`);
  const snapshot = await backend.observe(ack.submission);
  const engaged = snapshot.observations.find(
    (observation) => observation.type === "network.jinn.task-execution.attempt-engaged.v1",
  );
  if (engaged === undefined) throw new Error("expected an attempt-engaged observation on submit");
  return { attempt: snapshot.descriptor.attempt, taskDigest, source: engaged.source };
}

export type DescribeTaskExecutionBackendContract = typeof describeTaskExecutionBackendContract;

/**
 * The §24 Layer-2 csi-sanity-style backend contract suite: any `TaskExecutionBackend`
 * implementation satisfying the documented `TestableBackend` seam (drive, recordDelivery,
 * simulateReconciliation — test-only, not part of the frozen §22 contract) can run this suite.
 * Proven first against the in-memory fake (design §26); bindings run it against themselves.
 */
export function describeTaskExecutionBackendContract(makeBackend: () => TestableBackend): void {
  describe("TEP Layer 2: backend contract sanity suite", () => {
    test("submit is byte-exact idempotent: same-key/same-bytes returns the same acknowledgement", async () => {
      const backend = makeBackend();
      const task = taskBytes();
      const submission = submissionBytes(documentDigest(task));

      const first = await backend.submit(task, submission);
      const second = await backend.submit(task, submission);
      expect(second).toEqual(first);
    });

    test("submit rejects same-key/different-bytes as a typed submission-conflict", async () => {
      const backend = makeBackend();
      const task = taskBytes();
      const taskDigest = documentDigest(task);
      const requester = `urn:uuid:${crypto.randomUUID()}`;
      const key = unique("conflict-key");
      const first = submissionBytes(taskDigest, { requester, idempotencyKey: key });
      const second = submissionBytes(taskDigest, { requester, idempotencyKey: key, nonce: unique("different-nonce") });

      const firstAck = await backend.submit(task, first);
      expect(firstAck.accepted).toBe(true);
      const secondAck = await backend.submit(task, second);
      expect(secondAck.accepted).toBe(false);
      if (secondAck.accepted) throw new Error("unreachable");
      expect(secondAck.error).toBeInstanceOf(TaskExecutionError);
      expect(secondAck.error.category).toBe("submission-conflict");
    });

    test("observe is honest: distinguishes pending, running, and a failed terminal (never infers success from liveness)", async () => {
      const backend = makeBackend();
      const { attempt, source } = await submitAccepted(backend);

      const pending = await backend.observe(attempt);
      expect(pending.descriptor.derived.state).toBe("pending");
      expect(pending.descriptor.derived.terminal).toBe(false);

      await backend.drive(attempt, [startedObservation(attempt, source)]);
      const running = await backend.observe(attempt);
      expect(running.descriptor.derived.state).toBe("running");
      expect(running.descriptor.derived.terminal).toBe(false);

      await backend.drive(attempt, [terminalObservation(attempt, source, "failed", "task")]);
      const failed = await backend.observe(attempt);
      expect(failed.descriptor.derived.state).toBe("failed");
      expect(failed.descriptor.derived.terminal).toBe(true);
      expect(failed.descriptor.derived.blame).toBe("task");
    });

    test("recover classifies matching, absent, and contradictory, and fail-loud never guesses on contradictory", async () => {
      const backend = makeBackend();
      const { attempt } = await submitAccepted(backend);

      const matching = await backend.recover(attempt);
      expect(matching.classification).toBe("matching");

      backend.simulateReconciliation(attempt, { classification: "absent", detail: "no durable record found" });
      const absent = await backend.recover(attempt);
      expect(absent.classification).toBe("absent");

      backend.simulateReconciliation(attempt, {
        classification: "contradictory",
        detail: "durable record disagrees with backend-native state",
      });
      const contradictory = await backend.recover(attempt);
      expect(contradictory.classification).toBe("contradictory");
      expect(contradictory.detail).toBeDefined();
    });

    test("cancel is idempotent and terminal-state-aware, including cancel-after-terminal (cancel races)", async () => {
      const backend = makeBackend();
      if (backend.cancel === undefined) return; // optional capability (§14)
      const cancel = backend.cancel.bind(backend);
      const { attempt, source } = await submitAccepted(backend);

      const beforeTerminal = await cancel(attempt, "no longer needed");
      expect(beforeTerminal.requested).toBe(true);
      expect(beforeTerminal.terminalState).toBeUndefined();

      await backend.drive(attempt, [terminalObservation(attempt, source, "delivered")]);

      const afterTerminalFirst = await cancel(attempt, "race: caller A");
      const afterTerminalSecond = await cancel(attempt, "race: caller B");
      expect(afterTerminalFirst).toEqual({ requested: false, terminalState: "delivered" });
      expect(afterTerminalSecond).toEqual(afterTerminalFirst);
    });

    test("submit names the field it rejects: an undeclared run-pinning key is unsupported-requirement", async () => {
      const backend = makeBackend();
      const capabilities = await backend.capabilities();
      const declared = new Set(capabilities.runPinning.keys.map((entry) => entry.key));
      const undeclaredKey = ["harness", "model", "loadout", "isolationPolicy"].find((key) => !declared.has(key))
        ?? "x-conformance-kit/definitely-unsupported-key";

      const task = taskBytes();
      const taskDigest = documentDigest(task);
      const submission = submissionBytes(taskDigest, { requirements: { [undeclaredKey]: { id: "unsupported-value" } } });

      const ack = await backend.submit(task, submission);
      expect(ack.accepted).toBe(false);
      if (ack.accepted) throw new Error("unreachable");
      expect(ack.error).toBeInstanceOf(TaskExecutionError);
      expect(ack.error.category).toBe("unsupported-requirement");
    });

    test("failure-category mapping: an operational rejection is a TaskExecutionError, distinct from a failed Attempt terminal", async () => {
      const backend = makeBackend();

      // A structurally malformed Task (missing the required outputs[] field, never run through
      // the sealer's own validation) is an operational rejection, not an Attempt outcome.
      const malformedTaskBytes = new TextEncoder().encode(JSON.stringify({
        protocol: "https://jinn.network/profiles/task-execution/1.0",
        profile: PROFILE,
        instructions: "missing the required outputs[] field",
      }));
      const malformedAck = await backend.submit(malformedTaskBytes, submissionBytes(`sha256:${"0".repeat(64)}`));
      expect(malformedAck.accepted).toBe(false);
      if (malformedAck.accepted) throw new Error("unreachable");
      expect(malformedAck.error).toBeInstanceOf(TaskExecutionError);
      expect(malformedAck.error.category).toBe("invalid-document");

      // observe() on a reference the backend never engaged is an operational rejection too.
      await expect(backend.observe("urn:uuid:00000000-0000-5000-8000-000000000000")).rejects.toBeInstanceOf(
        TaskExecutionError,
      );
      await expect(backend.observe("urn:uuid:00000000-0000-5000-8000-000000000000")).rejects.toMatchObject({
        category: "attempt-not-found",
      });

      // By contrast, a *failed* Attempt terminal is a successful, honest observe() — a work
      // outcome, never an operational error (§13).
      const { attempt, source } = await submitAccepted(backend);
      await backend.drive(attempt, [terminalObservation(attempt, source, "failed", "task")]);
      const snapshot = await backend.observe(attempt);
      expect(snapshot.descriptor.derived.state).toBe("failed");
    });

    test("result retrieval on terminal Attempts: deliveries + fetchDelivery return exact bytes; result-unavailable is loud otherwise", async () => {
      const backend = makeBackend();
      const { attempt, taskDigest, source } = await submitAccepted(backend);
      const delivery = deliveryBytesFor(taskDigest, attempt);

      await backend.recordDelivery(attempt, delivery);
      await backend.drive(attempt, [terminalObservation(attempt, source, "delivered")]);

      const refs = await backend.deliveries(attempt);
      expect(refs).toHaveLength(1);
      const fetched = await backend.fetchDelivery(refs[0]!);
      expect(fetched).toEqual(delivery);

      await expect(
        backend.fetchDelivery({ attempt, digest: `sha256:${"c".repeat(64)}` }),
      ).rejects.toMatchObject({ category: "result-unavailable" });
    });

    test("idempotency scope is delimited: concatenation-colliding (requester, idempotencyKey) pairs never conflict or capture each other (§12.2)", async () => {
      const backend = makeBackend();
      const task = taskBytes();
      const taskDigest = documentDigest(task);
      // Chosen so naive concatenation ("requester" + "idempotencyKey") collides: "ab" + "c" ===
      // "a" + "bc" === "abc". A scope key with no delimiter between the two fields would treat
      // these as the same scope — exactly the cross-requester capture §12.2 forbids.
      const first = submissionBytes(taskDigest, { requester: "ab", idempotencyKey: "c" });
      const second = submissionBytes(taskDigest, { requester: "a", idempotencyKey: "bc" });

      const firstAck = await backend.submit(task, first);
      const secondAck = await backend.submit(task, second);
      expect(firstAck.accepted).toBe(true);
      expect(secondAck.accepted).toBe(true);
      if (!firstAck.accepted || !secondAck.accepted) throw new Error("unreachable");
      expect(firstAck.submission).not.toBe(secondAck.submission);

      const firstSnapshot = await backend.observe(firstAck.submission);
      const secondSnapshot = await backend.observe(secondAck.submission);
      expect(firstSnapshot.descriptor.attempt).not.toBe(secondSnapshot.descriptor.attempt);
    });

    test("the same idempotencyKey under two different requesters yields two distinct accepted Submissions (no conflict, no capture, §12.2)", async () => {
      const backend = makeBackend();
      const task = taskBytes();
      const taskDigest = documentDigest(task);
      const sharedKey = unique("shared-key");
      const requesterA = `urn:uuid:${crypto.randomUUID()}`;
      const requesterB = `urn:uuid:${crypto.randomUUID()}`;

      const firstAck = await backend.submit(
        task,
        submissionBytes(taskDigest, { requester: requesterA, idempotencyKey: sharedKey }),
      );
      const secondAck = await backend.submit(
        task,
        submissionBytes(taskDigest, { requester: requesterB, idempotencyKey: sharedKey }),
      );
      expect(firstAck.accepted).toBe(true);
      expect(secondAck.accepted).toBe(true);
      if (!firstAck.accepted || !secondAck.accepted) throw new Error("unreachable");
      expect(firstAck.submission).not.toBe(secondAck.submission);
    });

    test("submit rejects when the Submission's task digest does not match the provided Task bytes (invalid-reference, §8)", async () => {
      const backend = makeBackend();
      const task = taskBytes();
      const wrongDigest = `sha256:${"0".repeat(64)}`;
      const submission = submissionBytes(wrongDigest);

      const ack = await backend.submit(task, submission);
      expect(ack.accepted).toBe(false);
      if (ack.accepted) throw new Error("unreachable");
      expect(ack.error).toBeInstanceOf(TaskExecutionError);
      expect(ack.error.category).toBe("invalid-reference");
      expect(ack.error.retryable).toBe(false);
    });

    test("submit rejects supplied evaluationRequirements this backend does not declare/interpret (unsupported-requirement, §8)", async () => {
      const backend = makeBackend();
      const task = taskBytes();
      const taskDigest = documentDigest(task);
      const submission = submissionBytes(taskDigest, { evaluationRequirements: { minConfidenceBps: 900 } });

      const ack = await backend.submit(task, submission);
      expect(ack.accepted).toBe(false);
      if (ack.accepted) throw new Error("unreachable");
      expect(ack.error).toBeInstanceOf(TaskExecutionError);
      expect(ack.error.category).toBe("unsupported-requirement");
    });

    test("submit rejects supplied capabilityGrants this backend does not declare/interpret (unsupported-requirement, §8)", async () => {
      const backend = makeBackend();
      const task = taskBytes();
      const taskDigest = documentDigest(task);
      const submission = submissionBytes(taskDigest, { capabilityGrants: { "x-conformance-kit/grant": true } });

      const ack = await backend.submit(task, submission);
      expect(ack.accepted).toBe(false);
      if (ack.accepted) throw new Error("unreachable");
      expect(ack.error).toBeInstanceOf(TaskExecutionError);
      expect(ack.error.category).toBe("unsupported-requirement");
    });

    test("submit rejects a requested attempts bound outside this backend's declared range (unsupported-requirement, §8)", async () => {
      const backend = makeBackend();
      const capabilities = await backend.capabilities();
      const declaredMaxTotal = capabilities.attempts.maxTotal;
      if (declaredMaxTotal === undefined) {
        throw new Error("fixture expects this backend to declare attempts.maxTotal bounds");
      }
      const task = taskBytes();
      const taskDigest = documentDigest(task);
      const outOfRange = declaredMaxTotal[1] + 1;
      const submission = submissionBytes(taskDigest, { attempts: { maxTotal: outOfRange } });

      const ack = await backend.submit(task, submission);
      expect(ack.accepted).toBe(false);
      if (ack.accepted) throw new Error("unreachable");
      expect(ack.error).toBeInstanceOf(TaskExecutionError);
      expect(ack.error.category).toBe("unsupported-requirement");
    });

    test("concurrent Attempts on one Task, under separate Submissions, are legal within declared bounds (§9.2)", async () => {
      const backend = makeBackend();
      const task = taskBytes();
      const taskDigest = documentDigest(task);
      const bounds = { attempts: { maxConcurrent: 1, maxTotal: 1 } };

      const firstAck = await backend.submit(task, submissionBytes(taskDigest, bounds));
      const secondAck = await backend.submit(task, submissionBytes(taskDigest, bounds));
      if (!firstAck.accepted || !secondAck.accepted) throw new Error("unreachable");

      const first = await backend.observe(firstAck.submission);
      const second = await backend.observe(secondAck.submission);
      expect(first.descriptor.attempt).not.toBe(second.descriptor.attempt);
      expect(first.descriptor.derived.terminal).toBe(false);
      expect(second.descriptor.derived.terminal).toBe(false);
    });
  });
}
