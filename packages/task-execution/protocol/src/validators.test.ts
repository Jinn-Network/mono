import { describe, expect, test } from "vitest";
import {
  validateDelivery,
  validateDispatchContext,
  validateObservation,
  validateSubmission,
  validateTask,
} from "./validators.js";

const validTask = {
  protocol: "https://jinn.network/profiles/task-execution/1.0",
  profile: {
    uri: "https://jinn.network/task-profiles/repository-work/1.0",
    digest: { sha256: "a".repeat(64) },
  },
  instructions: "Fix the bug.",
  outputs: [{ name: "patch", mediaType: "text/x-diff", required: true }],
};

const validSubmission = {
  protocol: "https://jinn.network/profiles/task-execution/1.0",
  submission: "urn:uuid:11111111-1111-5111-8111-111111111111",
  task: { digest: { sha256: "a".repeat(64) } },
  requester: "urn:uuid:22222222-2222-5222-8222-222222222222",
  idempotencyKey: "key-1",
  nonce: "nonce-1",
  deadline: "2026-08-01T00:00:00Z",
};

const validDelivery = {
  protocol: "https://jinn.network/profiles/task-execution/1.0",
  attempt: "urn:uuid:33333333-3333-5333-8333-333333333333",
  task: `sha256:${"a".repeat(64)}`,
  outputs: [
    { name: "patch", digest: { sha256: "b".repeat(64) }, mediaType: "text/x-diff" },
  ],
  outcome: "fulfilled",
  createdAt: "2026-08-01T00:00:00Z",
};

const validDispatchContext = {
  taskDigest: `sha256:${"a".repeat(64)}`,
  submission: "urn:uuid:11111111-1111-5111-8111-111111111111",
  nonce: "nonce-1",
  attempt: "urn:uuid:33333333-3333-5333-8333-333333333333",
};

const validObservation = {
  specversion: "1.0",
  id: "evt-1",
  source: "urn:jinn:backend:local",
  subject: "urn:uuid:33333333-3333-5333-8333-333333333333",
  time: "2026-08-01T00:00:00Z",
  datacontenttype: "application/json",
  sequence: "0000000000000001",
  type: "network.jinn.task-execution.progress.v1",
  data: { message: "working" },
};

describe("validateTask", () => {
  test("accepts a valid Task", () => {
    expect(validateTask(validTask).conforms).toBe(true);
  });
  test("rejects a Task carrying a forbidden mutable field", () => {
    const result = validateTask({ ...validTask, deadline: "2026-08-01T00:00:00Z" });
    expect(result.conforms).toBe(false);
    expect(result.errors.some((e) => e.path.includes("deadline"))).toBe(true);
  });
});

describe("validateSubmission", () => {
  test("accepts a valid Submission", () => {
    expect(validateSubmission(validSubmission).conforms).toBe(true);
  });
  test("rejects a Submission missing a required field", () => {
    const { nonce: _nonce, ...withoutNonce } = validSubmission;
    const result = validateSubmission(withoutNonce);
    expect(result.conforms).toBe(false);
  });
});

describe("validateDelivery", () => {
  test("accepts a valid Delivery", () => {
    expect(validateDelivery(validDelivery).conforms).toBe(true);
  });
  test("rejects escalation outcome without escalationReason", () => {
    const result = validateDelivery({ ...validDelivery, outcome: "escalation" });
    expect(result.conforms).toBe(false);
    expect(result.errors.some((e) => e.path.includes("escalationReason"))).toBe(true);
  });
});

describe("validateDispatchContext", () => {
  test("accepts a valid dispatch context", () => {
    expect(validateDispatchContext(validDispatchContext).conforms).toBe(true);
  });
});

describe("validateObservation", () => {
  test("accepts a valid observation", () => {
    expect(validateObservation(validObservation).conforms).toBe(true);
  });
  test("rejects a sequence of 15 digits", () => {
    const result = validateObservation({ ...validObservation, sequence: "123456789012345" });
    expect(result.conforms).toBe(false);
    expect(result.errors.some((e) => e.path.includes("sequence"))).toBe(true);
  });
});
