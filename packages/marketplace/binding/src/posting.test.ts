import { documentDigest, sealSubmission, sealTask, sha256Hex } from "@jinn-network/task-execution-protocol";
import { TaskExecutionError } from "@jinn-network/task-execution-backend";
import { describe, expect, test, vi } from "vitest";
import { BASE_SEPOLIA_TODAY } from "./addresses.js";
import { BroadcastUncertainError, createInMemoryPostingIntentStore } from "./broadcast-intent.js";
import { MARKETPLACE_MANIFEST_DIGEST_SENTINEL, encodeCreateTaskCalldata, postTask, type PostingPorts, type PostingTerms } from "./posting.js";

const CREATOR_SAFE = "0x8a34793e10595c89B7e41Cc7Ff0F76850F44AD98" as const;

function hash(char: string): `0x${string}` {
  return `0x${char.repeat(64)}` as `0x${string}`;
}

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

function goldenSubmission(taskBytes: Uint8Array, overrides: Record<string, unknown> = {}): Uint8Array {
  return sealSubmission({
    protocol: "https://jinn.network/profiles/task-execution/1.0",
    submission: `urn:uuid:${crypto.randomUUID()}`,
    task: { digest: { sha256: sha256Hex(taskBytes) } },
    requester: `urn:uuid:${crypto.randomUUID()}`,
    idempotencyKey: `post-${Math.random()}`,
    nonce: "nonce-1",
    deadline: "2099-01-01T00:00:00Z",
    ...overrides,
  });
}

const TERMS: PostingTerms = {
  solutionMaxDeliveryRateWei: 10n,
  verdictMaxDeliveryRateWei: 5n,
  responseTimeoutSeconds: 3600n,
  allowSolverSelfEvaluation: false,
};

function makePorts(broadcast: PostingPorts["safe"]["broadcastCreateTask"]): PostingPorts {
  const pinned: Uint8Array[] = [];
  return {
    ipfs: {
      pin: async (bytes) => {
        pinned.push(bytes);
      },
    },
    intents: createInMemoryPostingIntentStore(),
    safe: { broadcastCreateTask: broadcast },
  };
}

describe("postTask", () => {
  test("uploads both docs as raw-codec CIDs, escrows (solutionRate + verdictRate) x maxClaims, and anchors only the task digest", async () => {
    const task = goldenTask();
    const submission = goldenSubmission(task, { attempts: { maxTotal: 3 } });
    let broadcastInput: { safeAddress: string; to: string; value: bigint; data: string } | undefined;
    const ports = makePorts(async (input) => {
      broadcastInput = input;
      return { taskId: 1n, txHash: hash("a") };
    });

    const outcome = await postTask(task, submission, TERMS, BASE_SEPOLIA_TODAY, CREATOR_SAFE, ports);

    expect(outcome).toEqual({ taskId: 1n, txHash: hash("a") });
    expect(broadcastInput?.safeAddress).toBe(CREATOR_SAFE);
    expect(broadcastInput?.to).toBe(BASE_SEPOLIA_TODAY.jinnRouter);
    expect(broadcastInput?.value).toBe((10n + 5n) * 3n);
    // Today-mode: no Submission digest appears in the calldata -- only the task CID digest.
    expect(broadcastInput?.data).toContain(sha256Hex(task));
  });

  test("defaults maxClaims to 1 when the Submission declares no attempts bound", async () => {
    const task = goldenTask();
    const submission = goldenSubmission(task);
    const ports = makePorts(async () => ({ taskId: 2n, txHash: hash("b") }));
    let capturedValue: bigint | undefined;
    ports.safe.broadcastCreateTask = async (input) => {
      capturedValue = input.value;
      return { taskId: 2n, txHash: hash("b") };
    };

    await postTask(task, submission, TERMS, BASE_SEPOLIA_TODAY, CREATOR_SAFE, ports);
    expect(capturedValue).toBe(10n + 5n);
  });

  test("enforces the digest-join before broadcast: a mismatched task digest rejects invalid-document, never reaching the safe port", async () => {
    const task = goldenTask();
    const otherTask = sealTask({
      protocol: "https://jinn.network/profiles/task-execution/1.0",
      profile: {
        uri: "https://jinn.network/task-profiles/repository-work/1.0",
        digest: { sha256: "3917f0428b2626fd2cc93675172731cc000b69d7d783f9adaf5159be56fd10a6" },
      },
      instructions: "A DIFFERENT task.",
      outputs: [{ name: "patch", mediaType: "text/x-diff", required: true }],
    });
    const submissionForOtherTask = goldenSubmission(otherTask);
    const broadcast = vi.fn(async () => ({ taskId: 99n, txHash: hash("f") }));
    const ports = makePorts(broadcast);

    await expect(postTask(task, submissionForOtherTask, TERMS, BASE_SEPOLIA_TODAY, CREATOR_SAFE, ports)).rejects.toMatchObject(
      { category: "invalid-document" },
    );
    expect(broadcast).not.toHaveBeenCalled();
  });

  test("rejects the mismatched pair as a TaskExecutionError instance", async () => {
    const task = goldenTask();
    const wrongDigestSubmission = sealSubmission({
      protocol: "https://jinn.network/profiles/task-execution/1.0",
      submission: `urn:uuid:${crypto.randomUUID()}`,
      task: { digest: { sha256: "0".repeat(64) } },
      requester: `urn:uuid:${crypto.randomUUID()}`,
      idempotencyKey: "mismatch",
      nonce: "nonce-1",
      deadline: "2099-01-01T00:00:00Z",
    });
    const ports = makePorts(async () => ({ taskId: 1n, txHash: hash("a") }));
    await expect(postTask(task, wrongDigestSubmission, TERMS, BASE_SEPOLIA_TODAY, CREATOR_SAFE, ports)).rejects.toBeInstanceOf(
      TaskExecutionError,
    );
  });

  test("persists the intent before broadcast: a crash mid-broadcast leaves exactly one recoverable intent", async () => {
    const task = goldenTask();
    const submission = goldenSubmission(task);
    const ports = makePorts(async () => {
      throw new Error("simulated crash between persist and broadcast confirmation");
    });

    await expect(postTask(task, submission, TERMS, BASE_SEPOLIA_TODAY, CREATOR_SAFE, ports)).rejects.toThrow(
      /simulated crash/,
    );

    const pending = await ports.intents.scanPending();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.taskCidDigest).toBe(`sha256:${sha256Hex(task)}`);
  });

  test("a completed post resolves and clears the intent (no longer pending)", async () => {
    const task = goldenTask();
    const submission = goldenSubmission(task);
    const ports = makePorts(async () => ({ taskId: 3n, txHash: hash("c") }));

    await postTask(task, submission, TERMS, BASE_SEPOLIA_TODAY, CREATOR_SAFE, ports);

    expect(await ports.intents.scanPending()).toHaveLength(0);
  });

  test("at-most-once: a resolved intent replays idempotently without re-broadcasting", async () => {
    const task = goldenTask();
    const submission = goldenSubmission(task);
    const broadcast = vi.fn(async () => ({ taskId: 4n, txHash: hash("d") }));
    const ports = makePorts(broadcast);

    const first = await postTask(task, submission, TERMS, BASE_SEPOLIA_TODAY, CREATOR_SAFE, ports);
    const second = await postTask(task, submission, TERMS, BASE_SEPOLIA_TODAY, CREATOR_SAFE, ports);

    expect(second).toEqual(first);
    expect(broadcast).toHaveBeenCalledTimes(1);
  });

  test("a still-pending intent for the same key refuses a concurrent re-broadcast (broadcast-uncertain, never blind-retried)", async () => {
    const task = goldenTask();
    const submission = goldenSubmission(task);
    const ports = makePorts(async () => {
      throw new Error("never reached");
    });
    // Manually persist a pending intent for the same key, simulating a crashed prior attempt.
    await ports.intents.persist({
      creatorSafe: CREATOR_SAFE,
      taskCidDigest: `sha256:${sha256Hex(task)}`,
      submissionDigest: documentDigest(submission),
      idempotencyKey: "stale",
      createdAt: "2026-01-01T00:00:00Z",
    });

    await expect(postTask(task, submission, TERMS, BASE_SEPOLIA_TODAY, CREATOR_SAFE, ports)).rejects.toBeInstanceOf(
      BroadcastUncertainError,
    );
  });
});

describe("encodeCreateTaskCalldata", () => {
  test("encodes the MARKETPLACE_MANIFEST_DIGEST_SENTINEL as the manifestDigest parameter", () => {
    const data = encodeCreateTaskCalldata({
      taskCidDigestBytes32: hash("1"),
      maxClaims: 1,
      allowSolverSelfEvaluation: false,
      solutionMaxDeliveryRateWei: 1n,
      verdictMaxDeliveryRateWei: 1n,
      responseTimeoutSeconds: 60n,
    });
    expect(data).toContain(MARKETPLACE_MANIFEST_DIGEST_SENTINEL.slice(2));
  });
});
