import { TaskExecutionError } from "@jinn-network/task-execution-backend";
import { documentDigest, sealSubmission, sealTask, sha256Hex } from "@jinn-network/task-execution-protocol";
import { describe, expect, test, vi } from "vitest";
import { BASE_SEPOLIA_TODAY } from "./addresses.js";
import { createInMemoryPostingIntentStore } from "./broadcast-intent.js";
import { makeMarketplaceBackend } from "./backend.js";
import { createInMemoryMarketplaceObserveStore } from "./observe-store.js";
import type { MarketplaceBackendPorts } from "./backend-ports.js";
import type { PostingTerms } from "./posting.js";

const CREATOR_SAFE = "0x8a34793e10595c89B7e41Cc7Ff0F76850F44AD98" as const;
const TERMS: PostingTerms = {
  solutionMaxDeliveryRateWei: 10n,
  verdictMaxDeliveryRateWei: 5n,
  responseTimeoutSeconds: 3600n,
  allowSolverSelfEvaluation: false,
};

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
    idempotencyKey: `key-${Math.random()}`,
    nonce: "nonce-1",
    deadline: "2099-01-01T00:00:00Z",
    ...overrides,
  });
}

let nextTaskId = 1n;

function makeTestPorts(): MarketplaceBackendPorts {
  return {
    creatorSafe: CREATOR_SAFE,
    terms: TERMS,
    posting: {
      ipfs: { pin: async () => {} },
      intents: createInMemoryPostingIntentStore(),
      safe: {
        broadcastCreateTask: async () => {
          const taskId = nextTaskId;
          nextTaskId += 1n;
          return { taskId, txHash: `0x${taskId.toString(16).padStart(64, "0")}` as `0x${string}` };
        },
      },
    },
    observe: createInMemoryMarketplaceObserveStore(BASE_SEPOLIA_TODAY),
  };
}

describe("makeMarketplaceBackend -- submit", () => {
  test("a valid Submission is accepted, calls postTask, and returns an ack carrying the SubmissionUri", async () => {
    const backend = makeMarketplaceBackend(BASE_SEPOLIA_TODAY, makeTestPorts());
    const task = goldenTask();
    const submission = goldenSubmission(task);

    const ack = await backend.submit(task, submission);

    expect(ack.accepted).toBe(true);
    if (!ack.accepted) throw new Error("unreachable");
    expect(ack.submission).toBe(JSON.parse(new TextDecoder().decode(submission)).submission);
    expect(ack.digest).toBe(documentDigest(submission));
  });

  test("a Submission with minVerdicts:2 rejects unsupported-requirement (honor-or-reject wired)", async () => {
    const backend = makeMarketplaceBackend(BASE_SEPOLIA_TODAY, makeTestPorts());
    const task = goldenTask();
    const submission = goldenSubmission(task, { evaluationRequirements: { minVerdicts: 2 } });

    const ack = await backend.submit(task, submission);

    expect(ack.accepted).toBe(false);
    if (ack.accepted) throw new Error("unreachable");
    expect(ack.error).toBeInstanceOf(TaskExecutionError);
    expect(ack.error.category).toBe("unsupported-requirement");
  });

  test("a Submission with closeAt rejects unsupported-requirement (today-mode, ruling §7.20)", async () => {
    const backend = makeMarketplaceBackend(BASE_SEPOLIA_TODAY, makeTestPorts());
    const task = goldenTask();
    const submission = goldenSubmission(task, { closeAt: "2099-06-01T00:00:00Z" });

    const ack = await backend.submit(task, submission);

    expect(ack.accepted).toBe(false);
    if (ack.accepted) throw new Error("unreachable");
    expect(ack.error.category).toBe("unsupported-requirement");
  });

  test("a structurally invalid Task rejects invalid-document without reaching honor-or-reject or postTask", async () => {
    const ports = makeTestPorts();
    const broadcast = vi.fn(ports.posting.safe.broadcastCreateTask);
    ports.posting.safe.broadcastCreateTask = broadcast;
    const backend = makeMarketplaceBackend(BASE_SEPOLIA_TODAY, ports);

    const malformedTask = new TextEncoder().encode(JSON.stringify({ protocol: "https://jinn.network/profiles/task-execution/1.0" }));
    const ack = await backend.submit(malformedTask, goldenSubmission(goldenTask()));

    expect(ack.accepted).toBe(false);
    if (ack.accepted) throw new Error("unreachable");
    expect(ack.error.category).toBe("invalid-document");
    expect(broadcast).not.toHaveBeenCalled();
  });

  test("submit is byte-exact idempotent: same (requester, idempotencyKey) scope + same bytes returns the same ack without re-broadcasting", async () => {
    const ports = makeTestPorts();
    const broadcast = vi.fn(ports.posting.safe.broadcastCreateTask);
    ports.posting.safe.broadcastCreateTask = broadcast;
    const backend = makeMarketplaceBackend(BASE_SEPOLIA_TODAY, ports);
    const task = goldenTask();
    const submission = goldenSubmission(task);

    const first = await backend.submit(task, submission);
    const second = await backend.submit(task, submission);

    expect(second).toEqual(first);
    expect(broadcast).toHaveBeenCalledTimes(1);
  });

  test("submit rejects same-key/different-bytes as a typed submission-conflict (§12.2)", async () => {
    const backend = makeMarketplaceBackend(BASE_SEPOLIA_TODAY, makeTestPorts());
    const task = goldenTask();
    const requester = `urn:uuid:${crypto.randomUUID()}`;
    const idempotencyKey = "shared-key";
    const first = goldenSubmission(task, { requester, idempotencyKey });
    const second = goldenSubmission(task, { requester, idempotencyKey, nonce: "different-nonce" });

    const firstAck = await backend.submit(task, first);
    expect(firstAck.accepted).toBe(true);
    const secondAck = await backend.submit(task, second);
    expect(secondAck.accepted).toBe(false);
    if (secondAck.accepted) throw new Error("unreachable");
    expect(secondAck.error.category).toBe("submission-conflict");
  });

  test("observe(ack.submission) immediately after submit finds an attempt-engaged observation (stub self-claim, design §5.3)", async () => {
    const backend = makeMarketplaceBackend(BASE_SEPOLIA_TODAY, makeTestPorts());
    const task = goldenTask();
    const submission = goldenSubmission(task);

    const ack = await backend.submit(task, submission);
    if (!ack.accepted) throw new Error("unreachable");
    const snapshot = await backend.observe(ack.submission);

    const engaged = snapshot.observations.find((o) => o.type === "network.jinn.task-execution.attempt-engaged.v1");
    expect(engaged).toBeDefined();
    expect(snapshot.descriptor.attempt).toBeDefined();
  });
});

describe("makeMarketplaceBackend -- capabilities", () => {
  test("matches marketplaceCapabilities()", async () => {
    const backend = makeMarketplaceBackend(BASE_SEPOLIA_TODAY, makeTestPorts());
    const capabilities = await backend.capabilities();
    expect(capabilities.runPinning.keys.length).toBeGreaterThan(0);
    expect(capabilities.attempts.maxConcurrent).toEqual(capabilities.attempts.maxTotal);
  });
});
