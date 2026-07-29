import type { JournalEvent } from "@jinn-network/task-execution-supervisor";
import { describe, expect, test } from "vitest";
import { projectObservations } from "./observation.js";

const attempt = "urn:uuid:00000000-0000-4000-8000-000000000108";
const source = "urn:jinn:backend-local:test-root";

function events(): JournalEvent[] {
  return [
    {
      attemptId: attempt,
      seq: 1,
      type: "attempt-engaged",
      time: "2026-07-28T00:00:00.000Z",
      details: {
        attempt,
        submission: "urn:uuid:00000000-0000-4000-8000-0000000000f8",
        taskDigest: `sha256:${"a".repeat(64)}`,
        source,
        executor: "urn:jinn:agent:test",
        effectiveDeadline: "2026-07-28T01:00:00.000Z",
        dispatchContext: {
          uri: "urn:jinn:dispatch:test",
          digest: { sha256: "b".repeat(64) },
        },
      },
    },
    {
      attemptId: attempt,
      seq: 2,
      type: "attempt-started",
      time: "2026-07-28T00:00:00.200Z",
      details: { source },
    },
    {
      attemptId: attempt,
      seq: 3,
      type: "attempt-terminal",
      time: "2026-07-28T00:02:00.000Z",
      details: { state: "delivered", exitCode: 0, source },
      failsAttempt: false,
    },
  ];
}

describe("projectObservations", () => {
  test("rebuilds emit identical deterministic (source,id) pairs", () => {
    const first = projectObservations(events());
    const rebuilt = projectObservations(structuredClone(events()));

    expect(
      first.map(({ source: projectedSource, id }) => ({ source: projectedSource, id })),
    ).toEqual(
      rebuilt.map(({ source: projectedSource, id }) => ({ source: projectedSource, id })),
    );
    expect(first.map(({ id }) => id)).toEqual([
      `${source}/${attempt}/1`,
      `${source}/${attempt}/2`,
      `${source}/${attempt}/3`,
    ]);
  });

  test("maps internal phases to progress while preserving TEP lifecycle facts", () => {
    const projected = projectObservations([
      events()[0]!,
      {
        attemptId: attempt,
        seq: 2,
        type: "spawn-intended",
        time: "2026-07-28T00:00:00.100Z",
        displayMessage: "launch plan checkpointed",
        details: { source },
      },
      {
        attemptId: attempt,
        seq: 3,
        type: "delivery-recorded",
        time: "2026-07-28T00:02:00.000Z",
        details: { source, digest: `sha256:${"c".repeat(64)}` },
      },
    ]);

    expect(projected.map(({ type }) => type)).toEqual([
      "network.jinn.task-execution.attempt-engaged.v1",
      "network.jinn.task-execution.progress.v1",
      "network.jinn.task-execution.delivery-recorded.v1",
    ]);
    expect(projected[1]?.data).toEqual({ message: "launch plan checkpointed" });
  });

  test("projects execution receipt identity and terminal blame", () => {
    const projected = projectObservations([
      events()[0]!,
      {
        attemptId: attempt,
        seq: 2,
        type: "execution-observed",
        time: "2026-07-28T00:01:59.000Z",
        details: {
          source,
          executionId: "urn:uuid:00000000-0000-4000-8000-0000000000ee",
          evidenceRecord: {
            family: "execution-evidence",
            digest: `sha256:${"e".repeat(64)}`,
          },
        },
      },
      {
        attemptId: attempt,
        seq: 3,
        type: "attempt-terminal",
        time: "2026-07-28T00:02:00.000Z",
        details: {
          source,
          state: "failed",
          blame: "infrastructure",
          detail: "capture failed",
        },
        failsAttempt: true,
      },
    ]);

    expect(projected[1]).toMatchObject({
      type: "network.jinn.task-execution.execution-observed.v1",
      data: {
        executionId: "urn:uuid:00000000-0000-4000-8000-0000000000ee",
      },
    });
    expect(projected[2]).toMatchObject({
      type: "network.jinn.task-execution.attempt-terminal.v1",
      data: { state: "failed", blame: "infrastructure" },
    });
  });
});
