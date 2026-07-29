import { describe, expect, test, vi } from "vitest";
import { BASE_SEPOLIA_TODAY } from "./addresses.js";
import { claimAttempt, dispatchContextDescriptor } from "./claim.js";

const TASK_DIGEST = `sha256:${"a".repeat(64)}` as const;
const REQUEST_ID = `0x${"b".repeat(64)}` as const;

describe("claimAttempt", () => {
  test("rejects a failed preflight before claimTask spends funds", async () => {
    const claimTask = vi.fn();
    await expect(claimAttempt(7n, BASE_SEPOLIA_TODAY, {
      taskDigest: TASK_DIGEST, submission: "urn:uuid:submission", nonce: "n-1", priorityMech: BASE_SEPOLIA_TODAY.mechMarketplace,
      capabilityMatch: async () => ({ ok: true }), preflight: async () => ({ ok: false, reason: "offline" }), claimTask,
    })).resolves.toEqual({ ok: false, kind: "pre-claim-rejected", reason: "offline" });
    expect(claimTask).not.toHaveBeenCalled();
  });

  test("derives the protocol Attempt URI and carries correlation annotations after a successful claim", async () => {
    const claimTask = vi.fn(async () => ({ attemptIndex: 3, requestId: REQUEST_ID, txHash: `0x${"c".repeat(64)}` as const }));
    const result = await claimAttempt(7n, BASE_SEPOLIA_TODAY, {
      taskDigest: TASK_DIGEST, submission: "urn:uuid:submission", nonce: "n-1", priorityMech: BASE_SEPOLIA_TODAY.mechMarketplace,
      capabilityMatch: async () => ({ ok: true }), preflight: async () => ({ ok: true }), claimTask,
    });
    expect(result).toMatchObject({ ok: true, attemptIndex: 3, requestId: REQUEST_ID });
    if (result.ok) {
      expect(result.attemptUri).toMatch(/^urn:uuid:/);
      expect(result.dispatchContext.attempt).toBe(result.attemptUri);
      expect(dispatchContextDescriptor(result.attemptUri, result.requestId, result.txHash)).toMatchObject({ requestId: REQUEST_ID });
    }
    expect(claimTask).toHaveBeenCalledWith({ taskId: 7n, priorityMech: BASE_SEPOLIA_TODAY.mechMarketplace });
  });
});
