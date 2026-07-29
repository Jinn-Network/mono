// SPDX-License-Identifier: Apache-2.0

import type {
  AttemptUri,
  TaskExecutionBackend,
} from "@jinn-network/task-execution-backend";
import { TaskExecutionError } from "@jinn-network/task-execution-backend";
import type { LocalTaskExecutionBackend } from "@jinn-network/task-execution-backend-local";
import {
  documentDigest,
  sealDelivery,
  sealSubmission,
  sealTask,
} from "@jinn-network/task-execution-protocol";
import {
  describeTaskExecutionBackendContract,
  type TestableBackend,
} from "@jinn-network/task-execution-testing";
import { describe, expect, test } from "vitest";

const PROFILE = {
  uri: "https://jinn.network/task-profiles/repository-work/1.0",
  digest: {
    sha256: "3917f0428b2626fd2cc93675172731cc000b69d7d783f9adaf5159be56fd10a6",
  },
};

function taskBytes(): Uint8Array {
  return sealTask({
    protocol: "https://jinn.network/profiles/task-execution/1.0",
    profile: PROFILE,
    instructions: "Local backend conformance fixture.",
    outputs: [{ name: "patch", mediaType: "text/x-diff", required: true }],
  });
}

function submissionBytes(
  task: Uint8Array,
  overrides: Readonly<Record<string, unknown>> = {},
): Uint8Array {
  return sealSubmission({
    protocol: "https://jinn.network/profiles/task-execution/1.0",
    submission: `urn:uuid:${crypto.randomUUID()}`,
    task: { digest: { sha256: documentDigest(task).slice("sha256:".length) } },
    requester: `urn:uuid:${crypto.randomUUID()}`,
    idempotencyKey: crypto.randomUUID(),
    nonce: crypto.randomUUID(),
    deadline: "2099-01-01T00:00:00Z",
    ...overrides,
  });
}

export interface LocalBackendConformanceSubject
  extends TestableBackend,
    Pick<LocalTaskExecutionBackend, "close" | "deliveryCheckpointPath"> {}

export interface LocalBackendContractFactory {
  (): LocalBackendConformanceSubject;
  readonly lockedPair: () => {
    readonly first: LocalBackendConformanceSubject;
    readonly second: LocalBackendConformanceSubject;
  };
  readonly evidenceScenario: (
    mode: "success" | "finalization-failure",
  ) => {
    readonly backend: LocalBackendConformanceSubject;
    readonly indexingCalls: () => number;
  };
  readonly sealOnceScenario: () => {
    readonly backend: LocalBackendConformanceSubject;
    readonly restart: () => LocalBackendConformanceSubject;
  };
}

async function acceptedAttempt(
  backend: TaskExecutionBackend,
  task: Uint8Array,
  submission: Uint8Array,
): Promise<AttemptUri> {
  const ack = await backend.submit(task, submission);
  if (!ack.accepted) throw new Error(`expected accepted: ${ack.error.category}`);
  return (await backend.observe(ack.submission)).descriptor.attempt;
}

/**
 * The exact local binding suite. It registers the unchanged TEP core kit first, then exercises
 * the binding-specific one-writer, one-attempt, seal-once, and evidence-capture postures.
 */
export function describeLocalBackendContract(
  makeBackend: LocalBackendContractFactory,
): void {
  describeTaskExecutionBackendContract(makeBackend);

  describe("Local backend conformance (design §16)", () => {
    test("two live instances on one root fail the second submit/recover as backend-unavailable", async () => {
      const { first, second } = makeBackend.lockedPair();
      const task = taskBytes();
      const submission = submissionBytes(task);
      const firstAck = await first.submit(task, submission);
      if (!firstAck.accepted) throw new Error("expected first instance acceptance");

      const anotherTask = taskBytes();
      const secondAck = await second.submit(anotherTask, submissionBytes(anotherTask));
      expect(secondAck.accepted).toBe(false);
      if (secondAck.accepted) throw new Error("unreachable");
      expect(secondAck.error).toBeInstanceOf(TaskExecutionError);
      expect(secondAck.error.category).toBe("backend-unavailable");
      await expect(second.recover(firstAck.submission)).rejects.toMatchObject({
        category: "backend-unavailable",
      });
    });

    test("single-party attempts bounds outside 1..1 are unsupported-requirement", async () => {
      const backend = makeBackend();
      const task = taskBytes();
      const ack = await backend.submit(
        task,
        submissionBytes(task, { attempts: { maxTotal: 2 } }),
      );
      expect(ack.accepted).toBe(false);
      if (ack.accepted) throw new Error("unreachable");
      expect(ack.error.category).toBe("unsupported-requirement");
    });

    test("seal-once recovery reuses the exact checkpoint after the scripted post-checkpoint crash", async () => {
      const scenario = makeBackend.sealOnceScenario();
      const task = taskBytes();
      const attempt = await acceptedAttempt(
        scenario.backend,
        task,
        submissionBytes(task),
      );
      const delivery = sealDelivery({
        protocol: "https://jinn.network/profiles/task-execution/1.0",
        attempt,
        task: documentDigest(task),
        outputs: [],
        outcome: "fulfilled",
        createdAt: "2026-07-28T00:05:00Z",
      });

      await expect(scenario.backend.recordDelivery(attempt, delivery)).rejects.toThrow(
        "scripted crash after checkpoint",
      );
      scenario.backend.close();
      const recovered = scenario.restart();
      expect(await recovered.recover(attempt)).toEqual({ classification: "matching" });
      const refs = await recovered.deliveries(attempt);
      expect(refs).toHaveLength(1);
      expect(refs[0]?.digest).toBe(documentDigest(delivery));
      expect(await recovered.fetchDelivery(refs[0]!)).toEqual(delivery);
    });

    test("capture always finalizes before delivered and indexing never gates Delivery", async () => {
      const scenario = makeBackend.evidenceScenario("success");
      const task = taskBytes();
      const submission = submissionBytes(task);
      const ack = await scenario.backend.submit(task, submission);
      if (!ack.accepted) throw new Error(`expected accepted: ${ack.error.category}`);

      const snapshot = await scenario.backend.observe(ack.submission);
      expect(snapshot.descriptor.derived.state).toBe("delivered");
      const types = snapshot.observations.map(({ type }) => type);
      expect(types.indexOf("network.jinn.task-execution.execution-observed.v1"))
        .toBeLessThan(types.indexOf("network.jinn.task-execution.delivery-recorded.v1"));
      expect(types.indexOf("network.jinn.task-execution.delivery-recorded.v1"))
        .toBeLessThan(types.indexOf("network.jinn.task-execution.attempt-terminal.v1"));
      expect(scenario.indexingCalls()).toBe(0);

      const refs = await scenario.backend.deliveries(snapshot.descriptor.attempt);
      const delivery = JSON.parse(
        new TextDecoder().decode(await scenario.backend.fetchDelivery(refs[0]!)),
      ) as { evidenceRecords?: unknown[]; executionIds?: unknown[] };
      expect(delivery.evidenceRecords).toHaveLength(1);
      expect(delivery.executionIds).toHaveLength(1);
    });

    test("capture always finalization failure is failed[infrastructure] with no Delivery", async () => {
      const { backend } = makeBackend.evidenceScenario("finalization-failure");
      const task = taskBytes();
      const ack = await backend.submit(task, submissionBytes(task));
      if (!ack.accepted) throw new Error(`expected accepted: ${ack.error.category}`);
      const snapshot = await backend.observe(ack.submission);
      expect(snapshot.descriptor.derived).toMatchObject({
        state: "failed",
        terminal: true,
        blame: "infrastructure",
      });
      expect(await backend.deliveries(snapshot.descriptor.attempt)).toEqual([]);
    });
  });
}
