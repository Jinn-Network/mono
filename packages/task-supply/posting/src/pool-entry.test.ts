import { sha256Hex } from "@jinn-network/task-execution-protocol";
import { describe, expect, test } from "vitest";
import { buildDispatchSubmission } from "./dispatch-submission.js";
import { evaluationSpecIsPublic, postingPoolEntry } from "./pool-entry.js";
import type { SuppliedPoolEntry } from "./pool-entry.js";

const TASK_BYTES = new TextEncoder().encode("sealed-task-bytes");

function specBytes(document: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(document));
}

const PUBLIC_SPEC = specBytes({
  protocol: "https://spec.jinn.network/profiles/task-execution/v1",
  familyBlock: {
    testMaterial: [
      { name: "test-patch", mediaType: "text/x-diff", content: "ZGlmZg==", accessClass: "public" },
    ],
  },
  grader: { name: "parser", accessClass: "public" },
});

function supplied(overrides: Partial<SuppliedPoolEntry> = {}): SuppliedPoolEntry {
  const evaluationSpecBytes = overrides.evaluationSpecBytes ?? PUBLIC_SPEC;
  return {
    taskDigest: `sha256:${sha256Hex(TASK_BYTES)}`,
    taskBytes: TASK_BYTES,
    evaluationSpecDigest: `sha256:${sha256Hex(evaluationSpecBytes)}`,
    evaluationSpecBytes,
    receiptDigest: `sha256:${"a".repeat(64)}`,
    ...overrides,
  };
}

describe("evaluationSpecIsPublic", () => {
  test("reads the access-class stamps off the sealed specification bytes", () => {
    expect(evaluationSpecIsPublic(PUBLIC_SPEC)).toBe(true);
  });

  test("is false when any stamped descriptor is private", () => {
    expect(evaluationSpecIsPublic(specBytes({
      familyBlock: { testMaterial: [{ name: "held-out", accessClass: "private" }] },
      grader: { name: "parser", accessClass: "public" },
    }))).toBe(false);
  });

  test("is false when nothing is stamped at all -- an unstamped spec is not evidence of public", () => {
    expect(evaluationSpecIsPublic(specBytes({
      familyBlock: { testMaterial: [{ name: "test-patch", content: "ZGlmZg==" }] },
    }))).toBe(false);
  });

  test("is false when a stamp is not a string, rather than coercing it into one", () => {
    expect(evaluationSpecIsPublic(specBytes({ grader: { accessClass: { value: "public" } } })))
      .toBe(false);
  });

  test("is false for bytes that are not a JSON document", () => {
    expect(evaluationSpecIsPublic(new TextEncoder().encode("not json"))).toBe(false);
  });
});

describe("postingPoolEntry", () => {
  test("carries C4's receiptDigest into the field the dispatch Submission annotates", () => {
    const entry = postingPoolEntry(supplied());
    expect(entry.admissionReceiptDigest).toBe(`sha256:${"a".repeat(64)}`);
  });

  test("derives evaluationSpecPublic from the specification bytes, not from a caller's claim", () => {
    expect(postingPoolEntry(supplied()).evaluationSpecPublic).toBe(true);

    const privateSpec = specBytes({ grader: { accessClass: "private" } });
    const entry = postingPoolEntry(supplied({
      evaluationSpecBytes: privateSpec,
      evaluationSpecDigest: `sha256:${sha256Hex(privateSpec)}`,
    }));
    expect(entry.evaluationSpecPublic).toBe(false);
  });

  test("refuses specification bytes the entry's own digest does not address", () => {
    expect(() => postingPoolEntry(supplied({
      evaluationSpecDigest: `sha256:${"b".repeat(64)}`,
    }))).toThrow(/evaluationSpecDigest/u);
  });

  test("refuses task bytes the entry's own digest does not address", () => {
    expect(() => postingPoolEntry(supplied({
      taskBytes: new TextEncoder().encode("other"),
    }))).toThrow(/taskDigest/u);
  });

  test("refuses a receipt digest that is not in the canonical prefixed form", () => {
    expect(() => postingPoolEntry(supplied({
      receiptDigest: "a".repeat(64) as `sha256:${string}`,
    }))).toThrow(/receiptDigest/u);
  });

  test("carries the optional acquisition hint when one is supplied", () => {
    expect(postingPoolEntry(supplied()).admissionReceiptUri).toBeUndefined();
    expect(postingPoolEntry(supplied(), { admissionReceiptUri: "ipfs://bafyreireceipt" })
      .admissionReceiptUri).toBe("ipfs://bafyreireceipt");
  });

  test("produces an entry the dispatch Submission accepts without further adaptation", () => {
    const entry = postingPoolEntry(supplied(), { admissionReceiptUri: "ipfs://bafyreireceipt" });
    const planEntry = {
      taskDigest: entry.taskDigest,
      deadline: "2026-08-01T00:00:00.000Z",
      maxClaims: 1,
      escrowValueWei: 12n,
      repost: false,
    } as const;
    const plan = {
      createdAt: "2026-07-31T00:00:00Z",
      creatorSafe: "0x8a34793e10595c89B7e41Cc7Ff0F76850F44AD98",
      requester: "urn:uuid:11111111-2222-3333-4444-555555555555",
      terms: {
        solutionMaxDeliveryRateWei: 10n,
        verdictMaxDeliveryRateWei: 2n,
        responseTimeoutSeconds: 3_600n,
        allowSolverSelfEvaluation: false,
        maxClaims: 1,
      },
      approval: "explicit",
      entries: [planEntry],
      totalEscrowValueWei: 12n,
      skipped: [],
    } as const;

    expect(() => buildDispatchSubmission(entry, planEntry, plan)).not.toThrow();
  });
});
