import { sealSubmission, sealTask, sha256Hex } from "@jinn-network/task-execution-protocol";
import { describe, expect, test, vi } from "vitest";
import { BASE_SEPOLIA_TODAY } from "./addresses.js";
import { createInMemoryPostingIntentStore } from "./broadcast-intent.js";
import {
  DEFAULT_POSTING_TERMS,
  assertMaxClaimsAgreement,
  postingEscrowValueWei,
} from "./posting-defaults.js";
import { postTask, type PostingPorts, type SafeBroadcastPort } from "./posting.js";

const CREATOR = "0x8a34793e10595c89B7e41Cc7Ff0F76850F44AD98" as const;

function goldenTask(): Uint8Array {
  return sealTask({
    protocol: "https://jinn.network/profiles/task-execution/1.0",
    profile: {
      uri: "https://jinn.network/task-profiles/repository-work/1.0",
      digest: { sha256: "3917f0428b2626fd2cc93675172731cc000b69d7d783f9adaf5159be56fd10a6" },
    },
    instructions: "Fix the failing test.",
    outputs: [{ name: "patch", mediaType: "text/x-diff", required: true }],
  });
}

function goldenSubmission(taskBytes: Uint8Array, maxTotal: number | undefined): Uint8Array {
  return sealSubmission({
    protocol: "https://jinn.network/profiles/task-execution/1.0",
    submission: "urn:uuid:11111111-2222-3333-4444-555555555555",
    task: { digest: { sha256: sha256Hex(taskBytes) } },
    requester: "urn:uuid:66666666-7777-8888-9999-aaaaaaaaaaaa",
    idempotencyKey: "defaults-1",
    nonce: "nonce-1",
    deadline: "2099-01-01T00:00:00Z",
    ...(maxTotal === undefined ? {} : { attempts: { maxTotal } }),
  });
}

describe("DEFAULT_POSTING_TERMS", () => {
  test("names maxClaims explicitly and never leaves the escrow multiplier to the fallback", () => {
    expect(DEFAULT_POSTING_TERMS.maxClaims).toBeGreaterThanOrEqual(1);
    expect(Number.isInteger(DEFAULT_POSTING_TERMS.maxClaims)).toBe(true);
    expect(DEFAULT_POSTING_TERMS.allowSolverSelfEvaluation).toBe(false);
  });

  test("postingEscrowValueWei is the exact msg.value postTask sends", async () => {
    const taskBytes = goldenTask();
    const submissionBytes = goldenSubmission(taskBytes, DEFAULT_POSTING_TERMS.maxClaims);
    const broadcastCreateTask = vi.fn<SafeBroadcastPort["broadcastCreateTask"]>(
      async () => ({ taskId: 7n, txHash: `0x${"a".repeat(64)}` as const }),
    );
    const ports: PostingPorts = {
      ipfs: { pin: async () => {} },
      intents: createInMemoryPostingIntentStore(),
      safe: { broadcastCreateTask },
    };

    await postTask(taskBytes, submissionBytes, DEFAULT_POSTING_TERMS, BASE_SEPOLIA_TODAY, CREATOR, ports);

    expect(broadcastCreateTask.mock.calls[0]?.[0]?.value).toBe(postingEscrowValueWei(DEFAULT_POSTING_TERMS));
  });

  test("responseTimeoutSeconds is inside the deployed marketplace's own bounds", () => {
    // Read 2026-07-31 from the deployed Base Sepolia MechMarketplace
    // 0xD3233FdAaB51E9775f6bFCE8242B02C181D7c0e7 (chainId 84532 -- the address
    // JinnRouterV3.mechMarketplace() returns): minResponseTimeout() = 60, maxResponseTimeout() = 300.
    // `createTask` does not validate this value; the marketplace does, at CLAIM time. An
    // out-of-bounds default posts fine, escrows msg.value, and then makes every claim revert.
    expect(DEFAULT_POSTING_TERMS.responseTimeoutSeconds).toBeGreaterThanOrEqual(60n);
    expect(DEFAULT_POSTING_TERMS.responseTimeoutSeconds).toBeLessThanOrEqual(300n);
  });

  test("the escrow equality holds only while the Submission agrees with terms.maxClaims", async () => {
    // `postTask`'s multiplier is the sealed Submission's `attempts.maxTotal`, NOT `terms.maxClaims`:
    // raise `maxClaims` without a matching Submission and the poster silently gets a one-claim task
    // at a fifth of the escrow it asked for. `assertMaxClaimsAgreement` is how a caller makes that
    // unreachable; nothing inside `postTask` checks it.
    const terms = { ...DEFAULT_POSTING_TERMS, maxClaims: 5 };
    const taskBytes = goldenTask();
    const submissionBytes = goldenSubmission(taskBytes, undefined);
    const broadcastCreateTask = vi.fn<SafeBroadcastPort["broadcastCreateTask"]>(
      async () => ({ taskId: 7n, txHash: `0x${"a".repeat(64)}` as const }),
    );
    const ports: PostingPorts = {
      ipfs: { pin: async () => {} },
      intents: createInMemoryPostingIntentStore(),
      safe: { broadcastCreateTask },
    };

    await postTask(taskBytes, submissionBytes, terms, BASE_SEPOLIA_TODAY, CREATOR, ports);

    expect(broadcastCreateTask.mock.calls[0]?.[0]?.value)
      .toBe(postingEscrowValueWei({ ...terms, maxClaims: 1 }));
    expect(broadcastCreateTask.mock.calls[0]?.[0]?.value).not.toBe(postingEscrowValueWei(terms));
    expect(() => assertMaxClaimsAgreement(undefined, terms.maxClaims)).toThrow(/attempts\.maxTotal/u);
  });

  test("the formula is (solutionRate + verdictRate) x maxClaims", () => {
    expect(postingEscrowValueWei({
      solutionMaxDeliveryRateWei: 10n,
      verdictMaxDeliveryRateWei: 5n,
      maxClaims: 3,
    })).toBe(45n);
  });

  test("rejects a claim count that cannot be escrowed", () => {
    expect(() => postingEscrowValueWei({
      solutionMaxDeliveryRateWei: 10n,
      verdictMaxDeliveryRateWei: 5n,
      maxClaims: 0,
    })).toThrow(RangeError);
  });
});

describe("assertMaxClaimsAgreement", () => {
  test("refuses a Submission that omits attempts.maxTotal (the silent fallback of 1)", () => {
    expect(() => assertMaxClaimsAgreement(undefined, 1)).toThrow(/attempts\.maxTotal/u);
  });

  test("refuses a Submission whose maxTotal disagrees with the terms", () => {
    expect(() => assertMaxClaimsAgreement(2, 1)).toThrow(/disagrees/u);
  });

  test("accepts agreement", () => {
    expect(() => assertMaxClaimsAgreement(3, 3)).not.toThrow();
  });
});
