import { describe, expect, test } from "vitest";
import {
  ATTEMPT_EVENT_TYPES,
  MAX_SEQUENCE,
  SUBMISSION_EVENT_TYPES,
  TASK_EXECUTION_EVENT_TYPES,
  formatSequence,
} from "./events.js";

describe("event type vocabulary", () => {
  test("the 11 type strings match §10.2 exactly", () => {
    expect([...SUBMISSION_EVENT_TYPES]).toEqual([
      "network.jinn.task-execution.submission-accepted.v1",
      "network.jinn.task-execution.submission-rejected.v1",
      "network.jinn.task-execution.submission-closed.v1",
    ]);
    expect([...ATTEMPT_EVENT_TYPES]).toEqual([
      "network.jinn.task-execution.attempt-engaged.v1",
      "network.jinn.task-execution.attempt-started.v1",
      "network.jinn.task-execution.progress.v1",
      "network.jinn.task-execution.cancel-requested.v1",
      "network.jinn.task-execution.cancel-acknowledged.v1",
      "network.jinn.task-execution.execution-observed.v1",
      "network.jinn.task-execution.delivery-recorded.v1",
      "network.jinn.task-execution.attempt-terminal.v1",
    ]);
    expect(TASK_EXECUTION_EVENT_TYPES.length).toBe(11);
  });
});

describe("formatSequence", () => {
  test("zero-pads to 16 digits", () => {
    expect(formatSequence(0n)).toBe("0000000000000000");
    expect(formatSequence(42n)).toBe("0000000000000042");
  });
  test("orders lexicographically at the width boundary (§10.1)", () => {
    expect(formatSequence(42n) < formatSequence(100n)).toBe(true);
  });
  test("throws past the 16-digit boundary", () => {
    expect(() => formatSequence(MAX_SEQUENCE + 1n)).toThrow(RangeError);
  });
  test("throws for a negative sequence", () => {
    expect(() => formatSequence(-1n)).toThrow(RangeError);
  });
});
