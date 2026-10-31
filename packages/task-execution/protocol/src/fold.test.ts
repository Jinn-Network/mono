import { describe, expect, test } from "vitest";
import { ConflictingObservationError, foldObservations } from "./fold.js";
import type { ProtocolObservation } from "./schemas/observation.js";

const ATTEMPT = "urn:uuid:33333333-3333-5333-8333-333333333333";
const SOURCE = "urn:jinn:backend:local";

let sequenceCounter = 0;
function seq(): string {
  sequenceCounter += 1;
  return sequenceCounter.toString().padStart(16, "0");
}

function observation(
  type: string,
  data: Record<string, unknown>,
  overrides: Partial<ProtocolObservation> = {},
): ProtocolObservation {
  const base = {
    specversion: "1.0" as const,
    id: overrides.id ?? `evt-${seq()}`,
    source: overrides.source ?? SOURCE,
    subject: ATTEMPT,
    time: "2026-08-01T00:00:00Z",
    datacontenttype: "application/json" as const,
    sequence: overrides.sequence ?? seq(),
    type,
    data,
  };
  return { ...base, ...overrides } as ProtocolObservation;
}

function engaged(overrides?: Partial<ProtocolObservation>) {
  return observation(
    "network.jinn.task-execution.attempt-engaged.v1",
    {
      attempt: ATTEMPT,
      task: `sha256:${"a".repeat(64)}`,
      submission: "urn:uuid:11111111-1111-5111-8111-111111111111",
      effectiveDeadline: "2026-08-01T01:00:00Z",
      source: SOURCE,
      dispatchContext: { uri: "https://example.test/dispatch-context.json" },
    },
    overrides,
  );
}

function started(overrides?: Partial<ProtocolObservation>) {
  return observation(
    "network.jinn.task-execution.attempt-started.v1",
    { startedAt: "2026-08-01T00:05:00Z" },
    overrides,
  );
}

function progress(overrides?: Partial<ProtocolObservation>) {
  return observation(
    "network.jinn.task-execution.progress.v1",
    { message: "working" },
    overrides,
  );
}

function terminal(
  state: string,
  extra: Record<string, unknown> = {},
  overrides?: Partial<ProtocolObservation>,
) {
  return observation(
    "network.jinn.task-execution.attempt-terminal.v1",
    { state, ...extra },
    overrides,
  );
}

describe("foldObservations", () => {
  test("terminal states are absorbing: a late progress does not un-terminate", () => {
    sequenceCounter = 0;
    const log = [engaged(), started(), terminal("delivered"), progress()];
    const derived = foldObservations(log);
    expect(derived.state).toBe("delivered");
    expect(derived.terminal).toBe(true);
  });

  test("dedupes on (source, id): a replayed attempt-started counts once", () => {
    sequenceCounter = 0;
    const one = started({ id: "evt-started" });
    const replay = { ...one }; // identical (source, id)
    const log = [engaged(), one, replay];
    const derived = foldObservations(log);
    expect(derived.state).toBe("running");
    // no crash / no duplication artifact — executionIds/deliveries stay empty either way
    expect(derived.executionIds).toEqual([]);
  });

  test("two observations sharing (source, id) that disagree on the terminal are refused, in either order", () => {
    sequenceCounter = 0;
    const delivered = terminal("delivered", {}, { id: "evt-terminal", sequence: "0000000000000009" });
    const failed = terminal("failed", { blame: "task" }, { id: "evt-terminal", sequence: "0000000000000005" });
    expect(() => foldObservations([engaged(), delivered, failed])).toThrow(ConflictingObservationError);
    expect(() => foldObservations([engaged(), failed, delivered])).toThrow(ConflictingObservationError);
  });

  test("the refusal names the pair and carries the protocol-violation category", () => {
    sequenceCounter = 0;
    const log = [
      engaged(),
      terminal("delivered", {}, { id: "evt-terminal", sequence: "0000000000000009" }),
      terminal("delivered", {}, { id: "evt-terminal", sequence: "0000000000000005" }),
    ];
    let refusal: unknown;
    try {
      foldObservations(log);
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(ConflictingObservationError);
    expect(refusal).toMatchObject({ category: "protocol-violation", source: SOURCE, id: "evt-terminal" });
  });

  test("agreeing on sequence does not make two observations the same one", () => {
    sequenceCounter = 0;
    const one = started({ id: "evt-started", sequence: "0000000000000007" });
    const other = progress({ id: "evt-started", sequence: "0000000000000007" });
    expect(() => foldObservations([engaged(), one, other])).toThrow(ConflictingObservationError);
    expect(() => foldObservations([engaged(), other, one])).toThrow(ConflictingObservationError);
  });

  test("one sequence and one type do not make two observations the same one when the data differs", () => {
    sequenceCounter = 0;
    const delivered = terminal("delivered", {}, { id: "evt-terminal", sequence: "0000000000000005" });
    const failed = terminal("failed", { blame: "task" }, { id: "evt-terminal", sequence: "0000000000000005" });
    expect(() => foldObservations([engaged(), delivered, failed])).toThrow(ConflictingObservationError);
    expect(() => foldObservations([engaged(), failed, delivered])).toThrow(ConflictingObservationError);
  });

  test("one sequence and one payload do not make two observations the same one when the type differs", () => {
    sequenceCounter = 0;
    const one = observation("network.jinn.task-execution.progress.v1", {}, { id: "evt-same", sequence: "0000000000000005" });
    const other = observation("network.jinn.task-execution.attempt-started.v1", {}, { id: "evt-same", sequence: "0000000000000005" });
    expect(() => foldObservations([engaged(), one, other])).toThrow(ConflictingObservationError);
    expect(() => foldObservations([engaged(), other, one])).toThrow(ConflictingObservationError);
  });

  test("an explicit undefined field is not a disagreement", () => {
    sequenceCounter = 0;
    const one = terminal("failed", { blame: "task" }, { id: "evt-terminal", sequence: "0000000000000005" });
    const replay = terminal("failed", { blame: "task", detail: undefined }, { id: "evt-terminal", sequence: "0000000000000005" });
    expect(foldObservations([engaged(), one, replay])).toEqual(foldObservations([engaged(), one]));
  });

  test("a payload nested far past any call stack folds and compares", () => {
    sequenceCounter = 0;
    let deep: Record<string, unknown> = { leaf: true };
    for (let depth = 0; depth < 500_000; depth += 1) deep = { deep };
    const one = terminal("failed", { blame: "task", annotations: deep }, { id: "evt-terminal", sequence: "0000000000000005" });
    const other = terminal("failed", { blame: "task", annotations: { deep } }, { id: "evt-terminal", sequence: "0000000000000005" });
    expect(foldObservations([engaged(), one, { ...one }]).state).toBe("failed");
    expect(() => foldObservations([engaged(), one, other])).toThrow(ConflictingObservationError);
  });

  test("a replay that differs only in what the fold never reads is still a duplicate (§10.1 rebuild)", () => {
    sequenceCounter = 0;
    const one = started({ id: "evt-started" });
    const rebuilt = { ...one, time: "2026-08-02T00:00:00Z", traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01" };
    expect(foldObservations([engaged(), one, rebuilt]).state).toBe("running");
    expect(foldObservations([engaged(), rebuilt, one]).state).toBe("running");
  });

  test("key order inside a payload does not make a replay a disagreement", () => {
    sequenceCounter = 0;
    const one = observation(
      "network.jinn.task-execution.cancel-requested.v1",
      { reason: "requester asked", requestedBy: "urn:jinn:requester:1" },
      { id: "evt-cancel", sequence: "0000000000000007" },
    );
    const replay = observation(
      "network.jinn.task-execution.cancel-requested.v1",
      { requestedBy: "urn:jinn:requester:1", reason: "requester asked" },
      { id: "evt-cancel", sequence: "0000000000000007" },
    );
    expect(foldObservations([engaged(), one, replay]).cancelRequested).toBe(true);
  });

  test("a non-authoritative producer cannot refuse the fold by disagreeing with itself", () => {
    sequenceCounter = 0;
    const FOREIGN = "urn:jinn:attacker:forged-executor";
    const genuine = [engaged({ source: SOURCE, sequence: "0000000000000001" }), terminal("delivered", {}, { sequence: "0000000000000002" })];
    const forged = [
      terminal("failed", { blame: "task" }, { source: FOREIGN, id: "evt-forged", sequence: "0000000000000003" }),
      terminal("cancelled", {}, { source: FOREIGN, id: "evt-forged", sequence: "0000000000000004" }),
    ];
    const expected = foldObservations(genuine);
    expect(foldObservations([...genuine, ...forged])).toEqual(expected);
    expect(foldObservations([...forged].reverse().concat(genuine))).toEqual(expected);
  });

  test("with no engagement to pin a source, a disagreement from any source is refused", () => {
    sequenceCounter = 0;
    const one = started({ id: "evt-started", sequence: "0000000000000001" });
    const other = started({ id: "evt-started", sequence: "0000000000000002" });
    expect(() => foldObservations([one, other])).toThrow(ConflictingObservationError);
  });

  test("the same sequence on two different observations resolves the same way in either order", () => {
    sequenceCounter = 0;
    const delivered = terminal("delivered", {}, { id: "evt-a", sequence: "0000000000000005" });
    const failed = terminal("failed", { blame: "task" }, { id: "evt-b", sequence: "0000000000000005" });
    const forward = foldObservations([engaged({ sequence: "0000000000000001" }), delivered, failed]);
    const reversed = foldObservations([failed, delivered, engaged({ sequence: "0000000000000001" })]);
    expect(reversed).toEqual(forward);
    expect(forward).toMatchObject({ state: "delivered", contradictory: true });
  });

  test("out-of-order non-terminal observations are resolved by sequence", () => {
    // started arrives with a LOWER sequence than engaged in array order, but a HIGHER sequence
    // number — the fold must still land on "running" because sequence, not array position, orders.
    const engagedEvt = observation(
      "network.jinn.task-execution.attempt-engaged.v1",
      {
        attempt: ATTEMPT,
        task: `sha256:${"a".repeat(64)}`,
        submission: "urn:uuid:11111111-1111-5111-8111-111111111111",
        effectiveDeadline: "2026-08-01T01:00:00Z",
        source: SOURCE,
        dispatchContext: { uri: "https://example.test/dispatch-context.json" },
      },
      { sequence: "0000000000000002" },
    );
    const startedEvt = observation(
      "network.jinn.task-execution.attempt-started.v1",
      { startedAt: "2026-08-01T00:05:00Z" },
      { sequence: "0000000000000001" },
    );
    // array order: started first, engaged second — sequence order is the reverse.
    const derived = foldObservations([startedEvt, engagedEvt]);
    expect(derived.state).toBe("running");
    expect(derived.effectiveDeadline).toBe("2026-08-01T01:00:00Z");
  });

  test("contradictory terminals: derived state is the first in sequence order, flagged", () => {
    sequenceCounter = 0;
    const log = [engaged(), terminal("delivered"), terminal("failed")];
    const derived = foldObservations(log);
    expect(derived.state).toBe("delivered");
    expect(derived.contradictory).toBe(true);
  });

  test("clockless fold has no provisional expired", () => {
    sequenceCounter = 0;
    const log = [engaged(), started()];
    const derived = foldObservations(log);
    expect(derived.state).not.toBe("expired");
    expect(["pending", "running"]).toContain(derived.state);
    expect(derived.terminal).toBe(false);
  });

  test("provisional expired derives only when opts carry now past effectiveDeadline", () => {
    sequenceCounter = 0;
    const log = [engaged(), started()];
    const derived = foldObservations(log, {
      now: "2026-08-01T02:00:00Z", // past the 01:00:00Z effectiveDeadline
      effectiveDeadline: "2026-08-01T01:00:00Z",
    });
    expect(derived.state).toBe("expired");
    expect(derived.terminal).toBe(true);
    expect(derived.contradictory).toBe(false);
  });

  test("a genuine later terminal supersedes provisional expired without contradiction", () => {
    sequenceCounter = 0;
    const log = [engaged(), started(), terminal("delivered")];
    const derived = foldObservations(log, {
      now: "2026-08-01T02:00:00Z",
      effectiveDeadline: "2026-08-01T01:00:00Z",
    });
    expect(derived.state).toBe("delivered");
    expect(derived.contradictory).toBe(false);
  });

  test("lost is quasi-terminal: a later terminal supersedes without contradiction", () => {
    sequenceCounter = 0;
    const log = [engaged(), terminal("lost"), terminal("delivered")];
    const derived = foldObservations(log);
    expect(derived.state).toBe("delivered");
    expect(derived.contradictory).toBe(false);
  });

  test("any other terminal-to-terminal transition stays contradictory", () => {
    sequenceCounter = 0;
    const log = [engaged(), terminal("delivered"), terminal("cancelled")];
    const derived = foldObservations(log);
    expect(derived.state).toBe("delivered");
    expect(derived.contradictory).toBe(true);
  });

  test("cancel-requested is a flag, not a state", () => {
    sequenceCounter = 0;
    const cancelRequested = observation(
      "network.jinn.task-execution.cancel-requested.v1",
      { reason: "requester asked", requestedBy: "urn:jinn:requester:1" },
    );
    const log = [engaged(), cancelRequested, terminal("delivered")];
    const derived = foldObservations(log);
    expect(derived.state).toBe("delivered");
    expect(derived.cancelRequested).toBe(true);
  });

  test("self-filters to the authoritative source pinned by attempt-engaged: a forged non-authoritative attempt-terminal does not alter derived state", () => {
    sequenceCounter = 0;
    const engagedEvt = engaged({ source: SOURCE }); // pins SOURCE as authoritative
    const genuineTerminal = terminal("delivered", {}, { source: SOURCE });
    // Forged: a different source injects a contradictory terminal after the genuine one.
    const forgedTerminal = terminal("failed", {}, { source: "urn:jinn:attacker:forged-executor" });
    const log = [engagedEvt, genuineTerminal, forgedTerminal];
    const derived = foldObservations(log);
    expect(derived.state).toBe("delivered");
    expect(derived.terminal).toBe(true);
    expect(derived.contradictory).toBe(false); // the forged terminal is filtered out, not folded
  });

  test("self-filters non-authoritative attempt-started: only the authoritative source's activity drives derived state", () => {
    sequenceCounter = 0;
    const engagedEvt = engaged({ source: SOURCE });
    const forgedStarted = started({ source: "urn:jinn:attacker:forged-executor" });
    const log = [engagedEvt, forgedStarted];
    const derived = foldObservations(log);
    expect(derived.state).toBe("pending"); // the forged "started" from another source never counts
  });

  test("multiple attempt-engaged from different sources: the first by sequence wins as authoritative", () => {
    sequenceCounter = 0;
    const ATTACKER = "urn:jinn:attacker:forged-executor";
    const genuineEngaged = engaged({ source: SOURCE, sequence: "0000000000000001" });
    // Forged: a later attempt-engaged from a different producer, naming itself as source in both
    // the envelope and the payload's authoritative-source field.
    const forgedEngaged = observation(
      "network.jinn.task-execution.attempt-engaged.v1",
      {
        attempt: ATTEMPT,
        task: `sha256:${"a".repeat(64)}`,
        submission: "urn:uuid:11111111-1111-5111-8111-111111111111",
        effectiveDeadline: "2026-08-01T01:00:00Z",
        source: ATTACKER,
        executor: ATTACKER,
        dispatchContext: { uri: "https://example.test/dispatch-context.json" },
      },
      { source: ATTACKER, sequence: "0000000000000002" },
    );
    const genuineTerminal = terminal("delivered", {}, { source: SOURCE, sequence: "0000000000000003" });
    const log = [genuineEngaged, forgedEngaged, genuineTerminal];
    const derived = foldObservations(log);
    expect(derived.state).toBe("delivered");
    expect(derived.contradictory).toBe(false);
    // The later, non-authoritative engaged never overwrote the authoritative executor.
    expect(derived.executor).toBe(undefined);
  });

  test("execution-observed accumulates executionIds; delivery-recorded accumulates deliveries", () => {
    sequenceCounter = 0;
    const executionObserved = observation(
      "network.jinn.task-execution.execution-observed.v1",
      { executionId: "urn:uuid:44444444-4444-5444-8444-444444444444" },
    );
    const deliveryRecorded = observation(
      "network.jinn.task-execution.delivery-recorded.v1",
      { digest: `sha256:${"c".repeat(64)}` },
    );
    const log = [engaged(), executionObserved, deliveryRecorded, terminal("delivered")];
    const derived = foldObservations(log);
    expect(derived.executionIds).toEqual([
      "urn:uuid:44444444-4444-5444-8444-444444444444",
    ]);
    expect(derived.deliveries).toEqual([{ digest: `sha256:${"c".repeat(64)}` }]);
  });
});
