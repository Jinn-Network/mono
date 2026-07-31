import { DEFAULT_POSTING_TERMS, postingEscrowValueWei } from "@jinn-network/marketplace-binding";
import { describe, expect, test } from "vitest";
import { planPosting } from "./plan.js";
import type { PostingPolicy, PostingPoolEntry } from "./types.js";

function entry(seed: string, overrides: Partial<PostingPoolEntry> = {}): PostingPoolEntry {
  return {
    taskDigest: `sha256:${seed.repeat(64).slice(0, 64)}`,
    taskBytes: new TextEncoder().encode(`task-${seed}`),
    evaluationSpecDigest: `sha256:${seed.repeat(64).slice(0, 63)}e`,
    admissionReceiptDigest: `sha256:${seed.repeat(64).slice(0, 63)}a`,
    evaluationSpecPublic: true,
    ...overrides,
  };
}

const POLICY: PostingPolicy = {
  terms: { ...DEFAULT_POSTING_TERMS, maxClaims: 2 },
  creatorSafe: "0x8a34793e10595c89B7e41Cc7Ff0F76850F44AD98",
  requester: "urn:uuid:11111111-2222-3333-4444-555555555555",
  now: "2026-07-31T00:00:00Z",
  deadlineSeconds: 86_400,
  batchLimit: 2,
};

describe("planPosting", () => {
  test("is pure: the same inputs plan the same batch twice", () => {
    const pool = [entry("1"), entry("2"), entry("3")];
    expect(planPosting(pool, POLICY)).toEqual(planPosting(pool, POLICY));
  });

  test("computes per-entry and total escrow from the terms", () => {
    const plan = planPosting([entry("1")], POLICY);
    const expected = postingEscrowValueWei(POLICY.terms);
    expect(plan.entries[0]?.escrowValueWei).toBe(expected);
    expect(plan.entries[0]?.maxClaims).toBe(2);
    expect(plan.totalEscrowValueWei).toBe(expected);
  });

  test("totals across a batch", () => {
    const plan = planPosting([entry("1"), entry("2")], POLICY);
    expect(plan.entries).toHaveLength(2);
    expect(plan.totalEscrowValueWei).toBe(postingEscrowValueWei(POLICY.terms) * 2n);
  });

  test("caps the batch and records the overflow as skipped", () => {
    const plan = planPosting([entry("1"), entry("2"), entry("3")], { ...POLICY, batchLimit: 1 });
    expect(plan.entries).toHaveLength(1);
    expect(plan.skipped).toContainEqual({ taskDigest: entry("2").taskDigest, reason: "batch-limit" });
    expect(plan.skipped).toContainEqual({ taskDigest: entry("3").taskDigest, reason: "batch-limit" });
  });

  test("drops excluded digests before anything else sees them", () => {
    const plan = planPosting([entry("1"), entry("2")], {
      ...POLICY, excludedTaskDigests: [entry("1").taskDigest],
    });
    expect(plan.entries.map((planned) => planned.taskDigest)).toEqual([entry("2").taskDigest]);
    expect(plan.skipped).toContainEqual({ taskDigest: entry("1").taskDigest, reason: "excluded" });
  });

  test("drops already-posted digests by default", () => {
    const plan = planPosting([entry("1"), entry("2")], {
      ...POLICY, postedTaskDigests: [entry("1").taskDigest],
    });
    expect(plan.entries.map((planned) => planned.taskDigest)).toEqual([entry("2").taskDigest]);
    expect(plan.skipped).toContainEqual({ taskDigest: entry("1").taskDigest, reason: "already-posted" });
  });

  test("plans never-posted entries before reposts when reposting is allowed", () => {
    const plan = planPosting([entry("1"), entry("2")], {
      ...POLICY, postedTaskDigests: [entry("1").taskDigest], repostPosted: true, batchLimit: 5,
    });
    expect(plan.entries.map((planned) => planned.taskDigest))
      .toEqual([entry("2").taskDigest, entry("1").taskDigest]);
    expect(plan.entries.map((planned) => planned.repost)).toEqual([false, true]);
  });

  test("refuses a non-public evaluation leg (D5) instead of posting it", () => {
    const plan = planPosting([entry("1", { evaluationSpecPublic: false }), entry("2")], POLICY);
    expect(plan.entries.map((planned) => planned.taskDigest)).toEqual([entry("2").taskDigest]);
    expect(plan.skipped).toContainEqual({
      taskDigest: entry("1").taskDigest, reason: "evaluation-not-public",
    });
  });

  test("pins the deadline (and closeAt) from policy.now, not from a host clock", () => {
    const plan = planPosting([entry("1")], { ...POLICY, closeAtSeconds: 3_600 });
    expect(plan.entries[0]?.deadline).toBe("2026-08-01T00:00:00.000Z");
    expect(plan.entries[0]?.closeAt).toBe("2026-07-31T01:00:00.000Z");
    expect(plan.createdAt).toBe(POLICY.now);
  });

  test("marks the plan auto when the policy pre-approves", () => {
    expect(planPosting([entry("1")], POLICY).approval).toBe("explicit");
    expect(planPosting([entry("1")], { ...POLICY, autoPost: true }).approval).toBe("auto");
  });

  test("rejects an unusable policy rather than planning a batch nobody can pay for", () => {
    expect(() => planPosting([entry("1")], { ...POLICY, batchLimit: 0 })).toThrow(RangeError);
    expect(() => planPosting([entry("1")], { ...POLICY, now: "not-a-time" })).toThrow(/RFC 3339/u);
    expect(() => planPosting([entry("1")], { ...POLICY, deadlineSeconds: 0 })).toThrow(RangeError);
  });
});
