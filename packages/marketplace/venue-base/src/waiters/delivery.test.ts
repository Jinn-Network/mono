// SPDX-License-Identifier: MIT

// Event-watch with poll fallback and cancellation (design §6.1). The Delivery this port waits on
// is produced by the EMBEDDED backend, not the chain, so the watch surface is TEP's optional
// `watch` capability and the fallback is polling `observe`. This port owns the timer policy the
// library deliberately does not: it must never throw (timeout and cancellation are typed
// results), it must prefer watch over poll whenever watch is offered, and it must degrade to
// polling rather than fail the engagement when a watch stream faults mid-stream.
import { describe, expect, test, vi } from "vitest";
import type {
  AttemptUri,
  DeliveryRef,
  ObservationSnapshot,
  TaskExecutionBackend,
} from "@jinn-network/task-execution-backend";
import { TaskExecutionError } from "@jinn-network/task-execution-backend";
import type { AttemptState } from "@jinn-network/task-execution-protocol";
import type { ProtocolObservation } from "@jinn-network/task-execution-protocol";
import { createDeliveryWaiter } from "./delivery.js";

const ATTEMPT_URI = "urn:uuid:33333333-3333-5333-8333-333333333333" as AttemptUri;
const SUBMISSION_URI = "urn:uuid:11111111-1111-5111-8111-111111111111";
const TASK_DIGEST = `sha256:${"a".repeat(64)}` as `sha256:${string}`;
const DELIVERY_DIGEST = `sha256:${"b".repeat(64)}` as `sha256:${string}`;
const DELIVERY_BYTES = new Uint8Array([1, 2, 3]);

let sequenceCounter = 0;
function nextSequence(): string {
  sequenceCounter += 1;
  return sequenceCounter.toString().padStart(16, "0");
}

function observation(type: string, data: Record<string, unknown>): ProtocolObservation {
  return {
    specversion: "1.0",
    id: `evt-${nextSequence()}`,
    source: "urn:jinn:backend:local",
    subject: ATTEMPT_URI,
    time: "2026-08-01T00:00:00Z",
    datacontenttype: "application/json",
    sequence: nextSequence(),
    type,
    data,
  } as ProtocolObservation;
}

function deliveryRecorded(): ProtocolObservation {
  return observation("network.jinn.task-execution.delivery-recorded.v1", {
    digest: DELIVERY_DIGEST,
  });
}

function attemptTerminal(state: AttemptState): ProtocolObservation {
  return observation("network.jinn.task-execution.attempt-terminal.v1", { state });
}

function snapshot(input: {
  readonly deliveries?: readonly { readonly digest: `sha256:${string}` }[];
  readonly terminal?: boolean;
  readonly state?: AttemptState;
}): ObservationSnapshot {
  return {
    descriptor: {
      attempt: ATTEMPT_URI,
      task: TASK_DIGEST,
      submission: SUBMISSION_URI,
      derived: {
        state: input.state ?? (input.terminal === true ? "failed" : "running"),
        terminal: input.terminal ?? false,
        contradictory: false,
        cancelRequested: false,
        executionIds: [],
        deliveries: input.deliveries ?? [],
      },
    },
    cursor: { sequence: nextSequence() },
    observations: [],
  };
}

/** A hand-rolled async iterator so tests can assert `return()` is called and inspect call order. */
function buildWatch(
  events: readonly (ProtocolObservation | "throw")[],
): { readonly watch: NonNullable<TaskExecutionBackend["watch"]>; readonly returnSpy: ReturnType<typeof vi.fn> } {
  const returnSpy = vi.fn(async () => ({ done: true as const, value: undefined }));
  const watch: NonNullable<TaskExecutionBackend["watch"]> = () => ({
    [Symbol.asyncIterator]() {
      let index = 0;
      return {
        async next() {
          if (index >= events.length) return { done: true as const, value: undefined };
          const event = events[index]!;
          index += 1;
          if (event === "throw") throw new Error("watch stream faulted");
          return { done: false as const, value: event };
        },
        return: returnSpy,
      };
    },
  });
  return { watch, returnSpy };
}

function buildBackend(overrides: Partial<TaskExecutionBackend>): TaskExecutionBackend {
  return {
    capabilities: vi.fn(async () => {
      throw new Error("unexpected capabilities() call");
    }),
    submit: vi.fn(async () => {
      throw new Error("unexpected submit() call");
    }),
    observe: vi.fn(async () => {
      throw new Error("unexpected observe() call");
    }),
    recover: vi.fn(async () => {
      throw new Error("unexpected recover() call");
    }),
    deliveries: vi.fn(async () => {
      throw new Error("unexpected deliveries() call");
    }),
    fetchDelivery: vi.fn(async () => {
      throw new Error("unexpected fetchDelivery() call");
    }),
    ...overrides,
  };
}

const noopSleep = async () => undefined;

describe("createDeliveryWaiter", () => {
  test("a backend exposing watch is watched, not polled", async () => {
    const { watch } = buildWatch([deliveryRecorded()]);
    const observeSpy = vi.fn(async () => {
      throw new Error("observe should never be called when watch is available");
    });
    const deliveriesSpy = vi.fn(async (): Promise<DeliveryRef[]> => [
      { attempt: ATTEMPT_URI, digest: DELIVERY_DIGEST },
    ]);
    const fetchDeliverySpy = vi.fn(async () => DELIVERY_BYTES);
    const backend = buildBackend({
      watch,
      observe: observeSpy,
      deliveries: deliveriesSpy,
      fetchDelivery: fetchDeliverySpy,
    });
    const waiter = createDeliveryWaiter();

    const result = await waiter.waitForDelivery({ attemptUri: ATTEMPT_URI, backend });

    expect(result).toEqual({ ok: true, deliveryBytes: DELIVERY_BYTES });
    expect(observeSpy).not.toHaveBeenCalled();
  });

  test("the watch path returns ok:true as soon as delivery-recorded arrives, fetching bytes via deliveries + fetchDelivery", async () => {
    const { watch } = buildWatch([deliveryRecorded()]);
    const deliveriesSpy = vi.fn(async (): Promise<DeliveryRef[]> => [
      { attempt: ATTEMPT_URI, digest: DELIVERY_DIGEST },
    ]);
    const fetchDeliverySpy = vi.fn(async (ref: DeliveryRef) => {
      expect(ref.digest).toBe(DELIVERY_DIGEST);
      return DELIVERY_BYTES;
    });
    const backend = buildBackend({ watch, deliveries: deliveriesSpy, fetchDelivery: fetchDeliverySpy });
    const waiter = createDeliveryWaiter();

    const result = await waiter.waitForDelivery({ attemptUri: ATTEMPT_URI, backend });

    expect(result).toEqual({ ok: true, deliveryBytes: DELIVERY_BYTES });
    expect(deliveriesSpy).toHaveBeenCalledTimes(1);
    expect(fetchDeliverySpy).toHaveBeenCalledTimes(1);
  });

  test("a backend without watch falls back to polling observe at pollIntervalMs and returns the same result", async () => {
    let call = 0;
    const observeSpy = vi.fn(async () => {
      call += 1;
      return call < 3 ? snapshot({}) : snapshot({ deliveries: [{ digest: DELIVERY_DIGEST }] });
    });
    const deliveriesSpy = vi.fn(async (): Promise<DeliveryRef[]> => [
      { attempt: ATTEMPT_URI, digest: DELIVERY_DIGEST },
    ]);
    const fetchDeliverySpy = vi.fn(async () => DELIVERY_BYTES);
    const backend = buildBackend({ observe: observeSpy, deliveries: deliveriesSpy, fetchDelivery: fetchDeliverySpy });
    const sleep = vi.fn(noopSleep);
    const waiter = createDeliveryWaiter({ sleep });

    const result = await waiter.waitForDelivery({ attemptUri: ATTEMPT_URI, backend });

    expect(result).toEqual({ ok: true, deliveryBytes: DELIVERY_BYTES });
    expect(observeSpy).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  test("a terminal attempt with no recorded Delivery returns backend-terminal carrying the derived state", async () => {
    const observeSpy = vi.fn(async () => snapshot({ terminal: true, state: "failed" }));
    const deliveriesSpy = vi.fn(async (): Promise<DeliveryRef[]> => []);
    const backend = buildBackend({ observe: observeSpy, deliveries: deliveriesSpy });
    const waiter = createDeliveryWaiter({ sleep: noopSleep });

    const result = await waiter.waitForDelivery({ attemptUri: ATTEMPT_URI, backend });

    expect(result).toEqual({ ok: false, kind: "backend-terminal", state: "failed" });
    expect(deliveriesSpy).toHaveBeenCalledTimes(1);
  });

  test("a terminal attempt with a recorded Delivery returns ok:true — terminal is not automatically failure", async () => {
    const observeSpy = vi.fn(async () =>
      snapshot({ terminal: true, state: "delivered", deliveries: [{ digest: DELIVERY_DIGEST }] }),
    );
    const deliveriesSpy = vi.fn(async (): Promise<DeliveryRef[]> => [
      { attempt: ATTEMPT_URI, digest: DELIVERY_DIGEST },
    ]);
    const fetchDeliverySpy = vi.fn(async () => DELIVERY_BYTES);
    const backend = buildBackend({ observe: observeSpy, deliveries: deliveriesSpy, fetchDelivery: fetchDeliverySpy });
    const waiter = createDeliveryWaiter({ sleep: noopSleep });

    const result = await waiter.waitForDelivery({ attemptUri: ATTEMPT_URI, backend });

    expect(result).toEqual({ ok: true, deliveryBytes: DELIVERY_BYTES });
  });

  test("an aborted signal resolves cancelled promptly and stops watching via the iterator's return()", async () => {
    const { watch, returnSpy } = buildWatch(["throw"]);
    const backend = buildBackend({ watch });
    const controller = new AbortController();
    controller.abort();
    const waiter = createDeliveryWaiter();

    const result = await waiter.waitForDelivery({
      attemptUri: ATTEMPT_URI,
      backend,
      signal: controller.signal,
    });

    expect(result).toEqual({ ok: false, kind: "cancelled" });
    expect(returnSpy).toHaveBeenCalledTimes(1);
  });

  test("exceeding timeoutMs resolves timeout and never throws", async () => {
    const observeSpy = vi.fn(async () => snapshot({}));
    const backend = buildBackend({ observe: observeSpy });
    const waiter = createDeliveryWaiter({ timeoutMs: 20, pollIntervalMs: 5, sleep: noopSleep });

    await expect(
      waiter.waitForDelivery({ attemptUri: ATTEMPT_URI, backend }),
    ).resolves.toEqual({ ok: false, kind: "timeout" });
  });

  test("a watch iterator that throws mid-stream degrades to the poll path instead of failing the engagement", async () => {
    const { watch, returnSpy } = buildWatch(["throw"]);
    const observeSpy = vi.fn(async () => snapshot({ deliveries: [{ digest: DELIVERY_DIGEST }] }));
    const deliveriesSpy = vi.fn(async (): Promise<DeliveryRef[]> => [
      { attempt: ATTEMPT_URI, digest: DELIVERY_DIGEST },
    ]);
    const fetchDeliverySpy = vi.fn(async () => DELIVERY_BYTES);
    const backend = buildBackend({
      watch,
      observe: observeSpy,
      deliveries: deliveriesSpy,
      fetchDelivery: fetchDeliverySpy,
    });
    const waiter = createDeliveryWaiter({ sleep: noopSleep });

    const result = await waiter.waitForDelivery({ attemptUri: ATTEMPT_URI, backend });

    expect(result).toEqual({ ok: true, deliveryBytes: DELIVERY_BYTES });
    expect(returnSpy).toHaveBeenCalledTimes(1);
    expect(observeSpy).toHaveBeenCalledTimes(1);
  });

  test("fetchDelivery throwing result-unavailable for a terminal attempt resolves backend-terminal, never a silent shrug", async () => {
    const observeSpy = vi.fn(async () => snapshot({ terminal: true, state: "lost" }));
    const deliveriesSpy = vi.fn(async (): Promise<DeliveryRef[]> => [
      { attempt: ATTEMPT_URI, digest: DELIVERY_DIGEST },
    ]);
    const fetchDeliverySpy = vi.fn(async () => {
      throw new TaskExecutionError("result-unavailable", { message: "delivery content is gone" });
    });
    const backend = buildBackend({ observe: observeSpy, deliveries: deliveriesSpy, fetchDelivery: fetchDeliverySpy });
    const waiter = createDeliveryWaiter({ sleep: noopSleep });

    const result = await waiter.waitForDelivery({ attemptUri: ATTEMPT_URI, backend });

    // `DeliveryWaitResult`'s `ok: false` variant carries only `kind` and the derived `state` --
    // there is no message field to preserve the thrown error's text on (binding-frozen type,
    // pinned structurally equal in the pipeline package). The honest signal this shape can carry
    // is the real terminal state, never an incorrectly reported success. The distinguishing proof
    // that the error was not swallowed *before* being handled -- as opposed to the "no Delivery
    // was ever recorded" case above -- is that `fetchDelivery` really was called.
    expect(result).toEqual({ ok: false, kind: "backend-terminal", state: "lost" });
    expect(fetchDeliverySpy).toHaveBeenCalledTimes(1);
  });
});
