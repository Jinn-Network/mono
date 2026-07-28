import { describe, expect, test } from "vitest";
import { documentDigest } from "./hashing.js";
import { IJsonNumberError } from "./json.js";
import { sealDelivery, sealSubmission, sealTask } from "./sealing.js";

const validTask = {
  outputs: [{ name: "patch", mediaType: "text/x-diff", required: true }],
  instructions: "Fix the bug.",
  protocol: "https://jinn.network/profiles/task-execution/1.0",
  profile: {
    uri: "https://jinn.network/task-profiles/repository-work/1.0",
    digest: { sha256: "a".repeat(64) },
  },
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
  outputs: [{ name: "patch", digest: { sha256: "b".repeat(64) }, mediaType: "text/x-diff" }],
  outcome: "fulfilled",
  createdAt: "2026-08-01T00:00:00Z",
};

describe("sealTask", () => {
  test("is insensitive to source key order (digest equivalence)", () => {
    const reordered = {
      profile: validTask.profile,
      protocol: validTask.protocol,
      outputs: validTask.outputs,
      instructions: validTask.instructions,
    };
    const a = sealTask(validTask);
    const b = sealTask(reordered);
    expect(documentDigest(a)).toBe(documentDigest(b));
  });

  test("throws IJsonNumberError for a fractional number inside payload", () => {
    expect(() => sealTask({ ...validTask, payload: { weight: 1.5 } })).toThrow(IJsonNumberError);
  });
});

describe("sealSubmission / sealDelivery", () => {
  test("sealSubmission rejects an invalid Submission with invalid-document", () => {
    expect(() => sealSubmission({ ...validSubmission, nonce: undefined })).toThrow();
    try {
      sealSubmission({ ...validSubmission, submission: "not-a-urn" });
      expect.unreachable();
    } catch (error: unknown) {
      expect((error as { category?: string }).category).toBe("invalid-document");
    }
  });

  test("sealDelivery rejects an invalid Delivery with invalid-document", () => {
    try {
      sealDelivery({ ...validDelivery, outcome: "escalation" }); // missing escalationReason
      expect.unreachable();
    } catch (error: unknown) {
      expect((error as { category?: string }).category).toBe("invalid-document");
    }
  });
});

describe("seal-once idempotence", () => {
  test("re-sealing a parsed, already-canonical document reproduces identical bytes", () => {
    const original = sealTask(validTask);
    const reparsed = JSON.parse(new TextDecoder().decode(original));
    const resealed = sealTask(reparsed);
    expect(documentDigest(original)).toBe(documentDigest(resealed));
  });
});
