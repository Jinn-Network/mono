import { documentDigest, sealDelivery, sealSubmission, sealTask } from "@jinn-network/task-execution-protocol";
import { describe, expect, test } from "vitest";
import { createInMemoryBackend } from "./fake-backend.js";

const PROFILE = {
  uri: "https://jinn.network/task-profiles/repository-work/1.0",
  digest: { sha256: "3917f0428b2626fd2cc93675172731cc000b69d7d783f9adaf5159be56fd10a6" },
};

function taskBytes(overrides: Record<string, unknown> = {}): Uint8Array {
  return sealTask({
    protocol: "https://jinn.network/profiles/task-execution/1.0",
    profile: PROFILE,
    instructions: "Normalize the slug helper.",
    outputs: [{ name: "patch", mediaType: "text/x-diff", required: true }],
    ...overrides,
  });
}

function submissionBytes(taskDigest: string, overrides: Record<string, unknown> = {}): Uint8Array {
  return sealSubmission({
    protocol: "https://jinn.network/profiles/task-execution/1.0",
    submission: "urn:uuid:11111111-1111-5111-8111-111111111111",
    task: { digest: { sha256: taskDigest.replace(/^sha256:/, "") } },
    requester: "urn:uuid:22222222-2222-5222-8222-222222222222",
    idempotencyKey: "fake-backend-happy-path-1",
    nonce: "nonce-1",
    deadline: "2099-01-01T00:00:00Z",
    ...overrides,
  });
}

function deliveryBytesFor(taskDigest: string, attempt: string): Uint8Array {
  return sealDelivery({
    protocol: "https://jinn.network/profiles/task-execution/1.0",
    attempt,
    task: taskDigest,
    outputs: [{ name: "patch", mediaType: "text/x-diff", digest: { sha256: "a".repeat(64) } }],
    outcome: "fulfilled",
    createdAt: "2026-07-28T00:05:00Z",
  });
}

describe("InMemoryTaskExecutionBackend: happy path", () => {
  test("submit accepts, mints an Attempt, and observe reports pending then delivered", async () => {
    const backend = createInMemoryBackend();
    const task = taskBytes();
    const taskDigest = documentDigest(task);
    const submission = submissionBytes(taskDigest);

    const ack = await backend.submit(task, submission);
    expect(ack.accepted).toBe(true);
    if (!ack.accepted) throw new Error("unreachable");
    expect(ack.submission).toBe("urn:uuid:11111111-1111-5111-8111-111111111111");
    expect(ack.digest).toBe(documentDigest(submission));

    const pendingSnapshot = await backend.observe(ack.submission);
    expect(pendingSnapshot.descriptor.derived.state).toBe("pending");
    expect(pendingSnapshot.descriptor.task).toBe(taskDigest);
    expect(pendingSnapshot.descriptor.submission).toBe("urn:uuid:11111111-1111-5111-8111-111111111111");
    const attempt = pendingSnapshot.descriptor.attempt;
    // `foldObservations` self-filters to the authoritative source pinned by `attempt-engaged`
    // (§10.1/§10.4): a driven observation must carry that same envelope `source` to count.
    const engaged = pendingSnapshot.observations.find(
      (observation) => observation.type === "network.jinn.task-execution.attempt-engaged.v1",
    );
    if (engaged === undefined) throw new Error("expected an attempt-engaged observation on submit");
    const authoritativeSource = engaged.source;

    const delivery = deliveryBytesFor(taskDigest, attempt);
    await backend.recordDelivery(attempt, delivery);
    await backend.drive(attempt, [
      {
        specversion: "1.0",
        id: "evt-terminal",
        source: authoritativeSource,
        subject: attempt,
        time: "2026-07-28T00:05:30Z",
        datacontenttype: "application/json",
        sequence: "0000000000000100",
        type: "network.jinn.task-execution.attempt-terminal.v1",
        data: { state: "delivered" },
      },
    ]);

    const deliveredSnapshot = await backend.observe(attempt);
    expect(deliveredSnapshot.descriptor.derived.state).toBe("delivered");
    expect(deliveredSnapshot.descriptor.derived.terminal).toBe(true);

    const refs = await backend.deliveries(attempt);
    expect(refs).toHaveLength(1);
    expect(refs[0]?.digest).toBe(documentDigest(delivery));
    const fetched = await backend.fetchDelivery(refs[0]!);
    expect(fetched).toEqual(delivery);
  });

  test("recover reports matching for a durable Attempt", async () => {
    const backend = createInMemoryBackend();
    const task = taskBytes();
    const taskDigest = documentDigest(task);
    const submission = submissionBytes(taskDigest);
    const ack = await backend.submit(task, submission);
    if (!ack.accepted) throw new Error("unreachable");

    const report = await backend.recover(ack.submission);
    expect(report.classification).toBe("matching");
  });

  test("duplicate byte-identical submit returns the same acknowledgement (idempotent, §12.2)", async () => {
    const backend = createInMemoryBackend();
    const task = taskBytes();
    const submission = submissionBytes(documentDigest(task));

    const first = await backend.submit(task, submission);
    const second = await backend.submit(task, submission);
    expect(second).toEqual(first);
  });

  test("same-key/different-bytes submit is a typed submission-conflict rejection", async () => {
    const backend = createInMemoryBackend();
    const task = taskBytes();
    const taskDigest = documentDigest(task);
    const first = submissionBytes(taskDigest, { idempotencyKey: "same-key" });
    const second = submissionBytes(taskDigest, { idempotencyKey: "same-key", nonce: "a-different-nonce" });

    const firstAck = await backend.submit(task, first);
    expect(firstAck.accepted).toBe(true);

    const secondAck = await backend.submit(task, second);
    expect(secondAck.accepted).toBe(false);
    if (secondAck.accepted) throw new Error("unreachable");
    expect(secondAck.error.category).toBe("submission-conflict");
  });
});
