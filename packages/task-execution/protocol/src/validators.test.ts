import { describe, expect, test } from "vitest";
import {
  validateDelivery,
  validateDispatchContext,
  validateObservation,
  validateSubmission,
  validateTask,
} from "./validators.js";

const validTask = {
  protocol: "https://spec.jinn.network/profiles/task-execution/v1",
  profile: {
    uri: "https://spec.jinn.network/task-profiles/repository-work/1.0",
    digest: { sha256: "a".repeat(64) },
  },
  instructions: "Fix the bug.",
  outputs: [{ name: "patch", mediaType: "text/x-diff", required: true }],
};

const validSubmission = {
  protocol: "https://spec.jinn.network/profiles/task-execution/v1",
  submission: "urn:uuid:11111111-1111-5111-8111-111111111111",
  task: { digest: { sha256: "a".repeat(64) } },
  requester: "urn:uuid:22222222-2222-5222-8222-222222222222",
  idempotencyKey: "key-1",
  nonce: "nonce-1",
  deadline: "2026-08-01T00:00:00Z",
};

const validDelivery = {
  protocol: "https://spec.jinn.network/profiles/task-execution/v1",
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

  describe("ResourceDescriptor content-without-digest (§6.4)", () => {
    test("rejects an inputs[] descriptor carrying inline content with no accompanying digest", () => {
      const result = validateTask({ ...validTask, inputs: [{ content: "aGVsbG8=" }] });
      expect(result.conforms).toBe(false);
    });
    test("accepts inline content accompanied by a digest", () => {
      const result = validateTask({
        ...validTask,
        inputs: [{ content: "aGVsbG8=", digest: { sha256: "a".repeat(64) } }],
      });
      expect(result.conforms).toBe(true);
    });
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

  describe("task ResourceDescriptor requires a sha256 digest entry (§8)", () => {
    test("rejects a task reference carrying only a uri, no digest", () => {
      const result = validateSubmission({
        ...validSubmission,
        task: { uri: "https://example.test/task.json" },
      });
      expect(result.conforms).toBe(false);
    });
    test("rejects a task reference whose digest map has no sha256 entry", () => {
      const result = validateSubmission({
        ...validSubmission,
        task: { digest: { sha1: "a".repeat(40) } },
      });
      expect(result.conforms).toBe(false);
    });
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
