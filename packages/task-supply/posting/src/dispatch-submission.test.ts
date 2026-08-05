import { ADMISSION_RECEIPT_ANNOTATION_URI } from "@jinn-network/marketplace-binding";
import { SubmissionRecordSchema, sha256Hex } from "@jinn-network/task-execution-protocol";
import { describe, expect, test } from "vitest";
import {
  assertSealedMaxClaimsAgreement,
  buildDispatchSubmission,
} from "./dispatch-submission.js";
import type { PostingPlan, PostingPlanEntry, PostingPoolEntry } from "./types.js";

const TASK_BYTES = new TextEncoder().encode("sealed-task-bytes");
const ENTRY: PostingPoolEntry = {
  taskDigest: `sha256:${sha256Hex(TASK_BYTES)}`,
  taskBytes: TASK_BYTES,
  evaluationSpecDigest: `sha256:${"e".repeat(64)}`,
  admissionReceiptDigest: `sha256:${"a".repeat(64)}`,
  admissionReceiptUri: "ipfs://bafyreiadmissionreceipt",
  evaluationSpecPublic: true,
};
const PLAN_ENTRY: PostingPlanEntry = {
  taskDigest: ENTRY.taskDigest,
  deadline: "2026-08-01T00:00:00.000Z",
  maxClaims: 2,
  escrowValueWei: 24n,
  repost: false,
};
const PLAN = {
  createdAt: "2026-07-31T00:00:00Z",
  creatorSafe: "0x8a34793e10595c89B7e41Cc7Ff0F76850F44AD98",
  requester: "urn:uuid:11111111-2222-3333-4444-555555555555",
  terms: {
    solutionMaxDeliveryRateWei: 10n,
    verdictMaxDeliveryRateWei: 2n,
    responseTimeoutSeconds: 3_600n,
    allowSolverSelfEvaluation: false,
    maxClaims: 2,
  },
  approval: "explicit",
  entries: [PLAN_ENTRY],
  totalEscrowValueWei: 24n,
  skipped: [],
} as const satisfies PostingPlan;

function parse(bytes: Uint8Array) {
  return SubmissionRecordSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
}

describe("buildDispatchSubmission", () => {
  test("binds the sealed Task by digest and names the requester of record", () => {
    const parsed = parse(buildDispatchSubmission(ENTRY, PLAN_ENTRY, PLAN));
    expect(parsed.task.digest?.sha256).toBe(sha256Hex(TASK_BYTES));
    expect(parsed.requester).toBe(PLAN.requester);
    expect(parsed.deadline).toBe(PLAN_ENTRY.deadline);
  });

  test("states attempts.maxTotal explicitly so the escrow multiplier is never the fallback", () => {
    expect(parse(buildDispatchSubmission(ENTRY, PLAN_ENTRY, PLAN)).attempts?.maxTotal).toBe(2);
  });

  test("carries the admission receipt where the evaluation leg looks for it", () => {
    const parsed = parse(buildDispatchSubmission(ENTRY, PLAN_ENTRY, PLAN));
    expect(parsed.annotations?.[ADMISSION_RECEIPT_ANNOTATION_URI]).toEqual({
      name: "admission-receipt",
      digest: { sha256: "a".repeat(64) },
      uri: "ipfs://bafyreiadmissionreceipt",
    });
  });

  test("never populates capabilityGrants (D5: no private evaluation material in v1)", () => {
    const parsed = parse(buildDispatchSubmission(ENTRY, PLAN_ENTRY, PLAN));
    expect(Object.keys(parsed)).not.toContain("capabilityGrants");
    expect(parsed.capabilityGrants).toBeUndefined();
  });

  test("is byte-identical across calls, so a replayed plan reuses one broadcast-intent key", () => {
    expect(buildDispatchSubmission(ENTRY, PLAN_ENTRY, PLAN))
      .toEqual(buildDispatchSubmission(ENTRY, PLAN_ENTRY, PLAN));
  });

  test("changes bytes when the plan changes, so a new batch is a new key", () => {
    const later = { ...PLAN_ENTRY, deadline: "2026-08-02T00:00:00.000Z" };
    expect(buildDispatchSubmission(ENTRY, later, PLAN))
      .not.toEqual(buildDispatchSubmission(ENTRY, PLAN_ENTRY, PLAN));
  });

  test("refuses a non-public evaluation leg even if the plan let it through", () => {
    expect(() => buildDispatchSubmission({ ...ENTRY, evaluationSpecPublic: false }, PLAN_ENTRY, PLAN))
      .toThrow(/public-specification/u);
  });

  test("refuses an entry whose bytes do not hash to its own digest", () => {
    expect(() => buildDispatchSubmission(
      { ...ENTRY, taskBytes: new TextEncoder().encode("other") }, PLAN_ENTRY, PLAN,
    )).toThrow(/does not hash/u);
  });

  test("refuses a plan entry whose maxClaims disagrees with the plan's terms", () => {
    expect(() => buildDispatchSubmission(ENTRY, { ...PLAN_ENTRY, maxClaims: 3 }, PLAN))
      .toThrow(/disagrees/u);
  });

  test("carries closeAt only when the plan pinned one", () => {
    expect(parse(buildDispatchSubmission(ENTRY, PLAN_ENTRY, PLAN)).closeAt).toBeUndefined();
    const withClose = { ...PLAN_ENTRY, closeAt: "2026-07-31T01:00:00.000Z" };
    expect(parse(buildDispatchSubmission(ENTRY, withClose, PLAN)).closeAt).toBe(withClose.closeAt);
  });
});

// The digest-confusion fixture for the two DigestSet values this package produces (program §5
// contract 6). Both are sealed into a Submission that is posted and escrowed, and nothing
// downstream re-checks their shape: TEP's DigestMap only requires non-empty keys, and the
// evaluation leg only checks that the admission-receipt descriptor is present and named. A
// malformed digest here therefore rides all the way onto a paid-for task, so it is refused at the
// only place it can still be caught.
describe("buildDispatchSubmission digest discipline", () => {
  const CONFUSED = [
    ["bare hex", "a".repeat(64)],
    ["double-prefixed", `sha256:sha256:${"a".repeat(64)}`],
    ["prefix only", "sha256:"],
    ["upper-case hex", `sha256:${"A".repeat(64)}`],
    ["non-hex", "sha256:zz"],
    ["a bytes32 anchor", `0x${"a".repeat(64)}`],
  ] as const;

  test.each(CONFUSED)("refuses an admissionReceiptDigest in %s form", (_form, digest) => {
    expect(() => buildDispatchSubmission(
      { ...ENTRY, admissionReceiptDigest: digest as `sha256:${string}` }, PLAN_ENTRY, PLAN,
    )).toThrow(/admissionReceiptDigest/u);
  });

  test.each(CONFUSED)("refuses a taskDigest in %s form", (_form, digest) => {
    const entry = { ...ENTRY, taskDigest: digest as `sha256:${string}` };
    const planEntry = { ...PLAN_ENTRY, taskDigest: digest as `sha256:${string}` };
    expect(() => buildDispatchSubmission(entry, planEntry, PLAN)).toThrow(/taskDigest/u);
  });

  test("the sealed annotation carries the bare hex the descriptor form requires", () => {
    const parsed = parse(buildDispatchSubmission(ENTRY, PLAN_ENTRY, PLAN));
    const annotation = parsed.annotations?.[ADMISSION_RECEIPT_ANNOTATION_URI] as
      { digest?: { sha256?: string } } | undefined;
    expect(annotation?.digest?.sha256).toMatch(/^[0-9a-f]{64}$/u);
  });
});

// F-C5-1's disposition in full: half B seals `attempts.maxTotal` explicitly AND re-parses its own
// sealed bytes to assert agreement. Comparing the two in-memory numbers the plan already holds is
// a tautology -- it cannot see a sealing layer that drops, renames, or coerces the field, which is
// exactly the case where the requester backend falls back to `?? 1` and escrows for one claim while the
// surfaced plan said N.
describe("assertSealedMaxClaimsAgreement", () => {
  function seal(document: Record<string, unknown>): Uint8Array {
    return new TextEncoder().encode(JSON.stringify(document));
  }
  const BASE = {
    protocol: "https://spec.jinn.network/profiles/task-execution/v1",
    submission: "urn:uuid:11111111-2222-3333-4444-555555555555",
    task: { digest: { sha256: sha256Hex(TASK_BYTES) } },
    requester: "urn:uuid:66666666-7777-8888-9999-aaaaaaaaaaaa",
    idempotencyKey: "k",
    nonce: "n",
    deadline: "2026-08-01T00:00:00.000Z",
  };

  test("refuses sealed bytes that carry no attempts block (the silent single-claim fallback)", () => {
    expect(() => assertSealedMaxClaimsAgreement(seal(BASE), 2)).toThrow(/attempts\.maxTotal/u);
  });

  test("refuses sealed bytes whose maxTotal is not the number the escrow was computed from", () => {
    expect(() => assertSealedMaxClaimsAgreement(seal({ ...BASE, attempts: { maxTotal: 1 } }), 2))
      .toThrow(/disagrees/u);
  });

  test("accepts the bytes buildDispatchSubmission actually seals", () => {
    expect(() => assertSealedMaxClaimsAgreement(
      buildDispatchSubmission(ENTRY, PLAN_ENTRY, PLAN), PLAN.terms.maxClaims,
    )).not.toThrow();
  });
});
