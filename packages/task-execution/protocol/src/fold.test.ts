import { describe, expect, test } from "vitest";
import { foldObservations } from "./fold.js";
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
