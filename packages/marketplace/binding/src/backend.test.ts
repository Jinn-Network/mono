import { TaskExecutionError } from "@jinn-network/task-execution-backend";
import { documentDigest, sealSubmission, sealTask, sha256Hex, type SubmissionRecord } from "@jinn-network/task-execution-protocol";
import { describe, expect, test, vi } from "vitest";
import { BASE_SEPOLIA_TODAY } from "./addresses.js";
import { createInMemoryPostingIntentStore } from "./broadcast-intent.js";
import { makeMarketplaceBackend } from "./backend.js";
import { createInMemoryMarketplaceObserveStore } from "./observe-store.js";
import type { MarketplaceBackendPorts } from "./backend-ports.js";
import { ADMISSION_RECEIPT_ANNOTATION_URI, deriveAndSealEvaluationSubmission } from "./evaluation-derive.js";
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
    protocol: "https://spec.jinn.network/profiles/task-execution/v1",
    profile: {
      uri: "https://spec.jinn.network/task-profiles/repository-work/1.0",
      digest: { sha256: "3917f0428b2626fd2cc93675172731cc000b69d7d783f9adaf5159be56fd10a6" },
    },
    instructions: "Fix the failing test.",
    outputs: [{ name: "patch", mediaType: "text/x-diff", required: true }],
  });
}

function goldenSubmission(taskBytes: Uint8Array, overrides: Record<string, unknown> = {}): Uint8Array {
  return sealSubmission({
    protocol: "https://spec.jinn.network/profiles/task-execution/v1",
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
  const intents = createInMemoryPostingIntentStore();
  return {
    creatorSafe: CREATOR_SAFE,
    terms: TERMS,
    posting: {
      ipfs: { pin: async () => {} },
      intents,
      safe: {
        broadcastCreateTask: async () => {
          const taskId = nextTaskId;
          nextTaskId += 1n;
          return { taskId, txHash: `0x${taskId.toString(16).padStart(64, "0")}` as `0x${string}` };
        },
      },
    },
    observe: createInMemoryMarketplaceObserveStore(BASE_SEPOLIA_TODAY, { intents }),
  };
}

function text(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function reorderedJson(value: Uint8Array): Uint8Array {
  const parsed = JSON.parse(text(value)) as Record<string, unknown>;
  return bytes(JSON.stringify(Object.fromEntries(Object.entries(parsed).reverse())));
}

function invalidUtf8(value: Uint8Array): Uint8Array {
  const copy = value.slice();
  copy[Math.floor(copy.length / 2)] = 0xff;
  return copy;
}

describe("makeMarketplaceBackend -- submit", () => {
  test("restart recovery atomically joins a resolved WAL after scope completion was interrupted", async () => {
    const ports = makeTestPorts();
    const broadcast = vi.fn(ports.posting.safe.broadcastCreateTask);
    ports.posting.safe.broadcastCreateTask = broadcast;
    const complete = ports.observe.resolveSubmissionScope.bind(ports.observe);
    let interruptOnce = true;
    ports.observe.resolveSubmissionScope = async (input, ownerToken) => {
      if (interruptOnce) {
        interruptOnce = false;
        throw new Error("simulated death after WAL resolution");
      }
      return complete(input, ownerToken);
    };
    const backend = makeMarketplaceBackend(BASE_SEPOLIA_TODAY, ports);
    const task = goldenTask();
    const submission = goldenSubmission(task);
    const submissionUri = (JSON.parse(text(submission)) as SubmissionRecord).submission;

    await expect(backend.post(task, submission)).rejects.toThrow(/after WAL resolution/u);
    await expect(backend.recoverPosting()).resolves.toMatchObject({
      resolvedScopes: [submissionUri],
      uncertainScopes: [],
      conflicts: [],
    });
    const replayed = await backend.post(task, submission);
    expect(typeof replayed.taskId).toBe("bigint");
    expect(broadcast).toHaveBeenCalledTimes(1);
  });

  test("linearizes simultaneous requester-scope contenders before any upload, intent, or broadcast", async () => {
    const ports = makeTestPorts();
    const broadcasts: unknown[] = [];
    const pinned: Uint8Array[] = [];
    ports.posting.safe.broadcastCreateTask = async (input) => {
      broadcasts.push(input);
      return { taskId: 91n, txHash: `0x${"9".repeat(64)}` };
    };
    ports.posting.ipfs.pin = async (value) => { pinned.push(value.slice()); };

    const task = goldenTask();
    const requester = "urn:uuid:00000000-0000-4000-8000-000000000091";
    const idempotencyKey = "simultaneous-submission-scope";
    const first = goldenSubmission(task, { requester, idempotencyKey, nonce: "first" });
    const second = goldenSubmission(task, { requester, idempotencyKey, nonce: "second" });

    const claimScope = ports.observe.claimSubmissionScope.bind(ports.observe);
    let entered = 0;
    let releaseBarrier: (() => void) | undefined;
    const barrier = new Promise<void>((resolve) => { releaseBarrier = resolve; });
    ports.observe.claimSubmissionScope = async (input) => {
      const claim = await claimScope(input);
      entered += 1;
      if (entered === 2) releaseBarrier?.();
      await barrier;
      return claim;
    };
    const backend = makeMarketplaceBackend(BASE_SEPOLIA_TODAY, ports);

    const outcomes = await Promise.all([backend.submit(task, first), backend.submit(task, second)]);

    expect(outcomes.map((outcome) => outcome.accepted
      ? { accepted: true, submission: outcome.submission, digest: outcome.digest }
      : { accepted: false, category: outcome.error.category, retryable: outcome.error.retryable ?? false },
    )).toEqual([
      {
        accepted: true,
        submission: JSON.parse(text(first)).submission,
        digest: documentDigest(first),
      },
      { accepted: false, category: "submission-conflict", retryable: false },
    ]);
    expect(broadcasts).toHaveLength(1);
    expect(pinned).toEqual([task, first]);

    await expect(backend.submit(task, first)).resolves.toEqual({
      accepted: true,
      submission: JSON.parse(text(first)).submission,
      digest: documentDigest(first),
    });
    expect(broadcasts).toHaveLength(1);
    expect(pinned).toEqual([task, first]);
  });

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

  test("today-mode accepts the supported one-verdict evaluation rail", async () => {
    const backend = makeMarketplaceBackend(BASE_SEPOLIA_TODAY, makeTestPorts());
    const task = goldenTask();
    const submission = goldenSubmission(task, {
      evaluationRequirements: { minVerdicts: 1 },
    });

    await expect(backend.submit(task, submission)).resolves.toMatchObject({
      accepted: true,
    });
  });

  test("requester-derived private evaluation grants survive helper → submit → post byte-exactly", async () => {
    const subjectTask = {
      name: "subject-task.json",
      digest: `sha256:${"1".repeat(64)}` as const,
    };
    const requester = "urn:uuid:20000000-0000-4000-8000-000000000002";
    const receipt = {
      name: "admission-receipt",
      digest: { sha256: "a".repeat(64) },
      uri: "ipfs://bafy-admission-receipt",
      mediaType: "application/vnd.in-toto+json",
    };
    const subjectSubmission = {
      protocol: "https://spec.jinn.network/profiles/task-execution/v1",
      submission: "urn:uuid:10000000-0000-4000-8000-000000000001",
      task: {
        name: subjectTask.name,
        digest: { sha256: subjectTask.digest.slice("sha256:".length) },
      },
      requester,
      idempotencyKey: "subject-submission",
      nonce: "subject-nonce",
      deadline: "2030-01-01T00:00:00Z",
      annotations: { [ADMISSION_RECEIPT_ANNOTATION_URI]: receipt },
    } as SubmissionRecord;
    const capabilityGrants = {
      "grader-bundle": { uri: "urn:jinn:capability:grader" },
      "test-material": { uri: "urn:jinn:capability:tests" },
    };
    const evaluation = deriveAndSealEvaluationSubmission({
      subjectTask,
      subjectSubmission,
      subjectDelivery: {
        name: "subject-delivery.json",
        digest: `sha256:${"2".repeat(64)}`,
      },
      subjectResults: [{
        name: "result.txt",
        digest: `sha256:${"3".repeat(64)}`,
      }],
      evaluationSpecDigest: `sha256:${"4".repeat(64)}`,
      submissionFields: {
        submission: "urn:uuid:30000000-0000-4000-8000-000000000003",
        requester,
        idempotencyKey: "evaluation-submission",
        nonce: "evaluation-nonce",
        deadline: "2030-01-02T00:00:00Z",
        attempts: { maxTotal: 1, maxConcurrent: 1 },
        evaluationRequirements: { minVerdicts: 1 },
      },
      capabilityGrants,
      publicSpec: false,
      sealerRole: "requester",
    });
    const ports = makeTestPorts();
    const pinned: Uint8Array[] = [];
    ports.posting.ipfs.pin = async (value) => {
      pinned.push(value.slice());
    };
    const backend = makeMarketplaceBackend(BASE_SEPOLIA_TODAY, ports);

    await expect(
      backend.submit(evaluation.task.bytes, evaluation.submission.bytes),
    ).resolves.toMatchObject({ accepted: true });
    expect(pinned).toContainEqual(evaluation.submission.bytes);
    expect(
      (JSON.parse(text(pinned[1]!)) as SubmissionRecord).capabilityGrants,
    ).toEqual(capabilityGrants);
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

    const malformedTask = new TextEncoder().encode(JSON.stringify({ protocol: "https://spec.jinn.network/profiles/task-execution/v1" }));
    const ack = await backend.submit(malformedTask, goldenSubmission(goldenTask()));

    expect(ack.accepted).toBe(false);
    if (ack.accepted) throw new Error("unreachable");
    expect(ack.error.category).toBe("invalid-document");
    expect(broadcast).not.toHaveBeenCalled();
  });

  // TEP Addendum 2026-07-28-b / marketplace-binding-design Finding F4: the requester-facing
  // marketplace backend must honor the optional third engagement parameter on submit.
  test("two-party engagement adopts the caller-minted Attempt URI instead of minting one", async () => {
    const backend = makeMarketplaceBackend(BASE_SEPOLIA_TODAY, makeTestPorts());
    const task = goldenTask();
    const submissionUri = `urn:uuid:${crypto.randomUUID()}` as const;
    const nonce = "two-party-adopt-nonce";
    const submission = goldenSubmission(task, { submission: submissionUri, nonce });
    const attemptUri = `urn:uuid:${crypto.randomUUID()}` as const;

    const ack = await backend.submit(task, submission, {
      attemptUri,
      dispatchContext: {
        taskDigest: documentDigest(task),
        submission: submissionUri,
        nonce,
        attempt: attemptUri,
      },
    });

    expect(ack.accepted).toBe(true);
    if (!ack.accepted) throw new Error("unreachable");
    expect((await backend.observe(ack.submission)).descriptor.attempt).toBe(attemptUri);
  });

  test("two-party engagement rejects a malformed Attempt URI as invalid-document before durable work", async () => {
    const ports = makeTestPorts();
    const broadcast = vi.fn(ports.posting.safe.broadcastCreateTask);
    ports.posting.safe.broadcastCreateTask = broadcast;
    const claimScope = vi.fn(ports.observe.claimSubmissionScope.bind(ports.observe));
    ports.observe.claimSubmissionScope = claimScope;
    const backend = makeMarketplaceBackend(BASE_SEPOLIA_TODAY, ports);

    const task = goldenTask();
    const submissionUri = `urn:uuid:${crypto.randomUUID()}` as const;
    const nonce = "two-party-malformed-nonce";
    const submission = goldenSubmission(task, { submission: submissionUri, nonce });
    const malformedAttemptUri = "urn:uuid:not-a-real-uuid" as const;

    const ack = await backend.submit(task, submission, {
      attemptUri: malformedAttemptUri,
      dispatchContext: {
        taskDigest: documentDigest(task),
        submission: submissionUri,
        nonce,
        attempt: malformedAttemptUri,
      },
    });

    expect(ack.accepted).toBe(false);
    if (ack.accepted) throw new Error("unreachable");
    expect(ack.error).toBeInstanceOf(TaskExecutionError);
    expect(ack.error.category).toBe("invalid-document");
    expect(claimScope).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
  });

  test("two-party engagement scopes attempts honor-or-reject away from single-party capability bounds", async () => {
    const backend = makeMarketplaceBackend(BASE_SEPOLIA_TODAY, makeTestPorts());
    const capabilities = await backend.capabilities();
    const declaredMaxTotal = capabilities.attempts.maxTotal;
    if (declaredMaxTotal === undefined) {
      throw new Error("fixture expects marketplace backend to declare attempts.maxTotal");
    }
    const outOfRange = declaredMaxTotal[1] + 1;

    const task = goldenTask();
    const submissionUri = `urn:uuid:${crypto.randomUUID()}` as const;
    const nonce = "two-party-scoped-nonce";
    const submission = goldenSubmission(task, {
      submission: submissionUri,
      nonce,
      attempts: { maxTotal: outOfRange },
    });
    const attemptUri = `urn:uuid:${crypto.randomUUID()}` as const;

    const ack = await backend.submit(task, submission, {
      attemptUri,
      dispatchContext: {
        taskDigest: documentDigest(task),
        submission: submissionUri,
        nonce,
        attempt: attemptUri,
      },
    });

    expect(ack.accepted).toBe(true);
    if (!ack.accepted) throw new Error("unreachable");
    expect((await backend.observe(ack.submission)).descriptor.attempt).toBe(attemptUri);
  });

  test.each([
    {
      label: "pretty-printed Task",
      mutate: (task: Uint8Array, _submission: Uint8Array) =>
        [bytes(JSON.stringify(JSON.parse(text(task)), null, 2)), _submission] as const,
    },
    {
      label: "duplicate-key Task",
      mutate: (task: Uint8Array, submission: Uint8Array) =>
        [
          bytes(text(task).replace(
            '"instructions":"Fix the failing test."',
            '"instructions":"shadow","instructions":"Fix the failing test."',
          )),
          submission,
        ] as const,
    },
    {
      label: "replacement-decoded Task",
      mutate: (task: Uint8Array, submission: Uint8Array) =>
        [invalidUtf8(task), submission] as const,
    },
    {
      label: "lone-surrogate Task",
      mutate: (task: Uint8Array, submission: Uint8Array) =>
        [
          bytes(text(task).replace(
            '"instructions":"Fix the failing test."',
            '"instructions":"\\ud800"',
          )),
          submission,
        ] as const,
    },
    {
      label: "reordered Submission",
      mutate: (task: Uint8Array, submission: Uint8Array) =>
        [task, reorderedJson(submission)] as const,
    },
    {
      label: "duplicate-key Submission",
      mutate: (task: Uint8Array, submission: Uint8Array) =>
        [
          task,
          bytes(text(submission).replace(
            '"nonce":"nonce-1"',
            '"nonce":"shadow","nonce":"nonce-1"',
          )),
        ] as const,
    },
    {
      label: "replacement-decoded Submission",
      mutate: (task: Uint8Array, submission: Uint8Array) =>
        [task, invalidUtf8(submission)] as const,
    },
    {
      label: "lone-surrogate Submission",
      mutate: (task: Uint8Array, submission: Uint8Array) =>
        [
          task,
          bytes(text(submission).replace(
            '"nonce":"nonce-1"',
            '"nonce":"\\ud800"',
          )),
        ] as const,
    },
  ])(
    "rejects a $label before idempotency capture, WAL, upload, or broadcast",
    async ({ mutate }) => {
      const ports = makeTestPorts();
      const scopeClaim = vi.spyOn(ports.observe, "claimSubmissionScope");
      const intentClaim = vi.spyOn(ports.posting.intents, "claim");
      const upload = vi.spyOn(ports.posting.ipfs, "pin");
      const broadcast = vi.spyOn(ports.posting.safe, "broadcastCreateTask");
      const canonicalTask = goldenTask();
      const canonicalSubmission = goldenSubmission(canonicalTask);
      const [task, submission] = mutate(canonicalTask, canonicalSubmission);

      const ack = await makeMarketplaceBackend(
        BASE_SEPOLIA_TODAY,
        ports,
      ).submit(task, submission);

      expect(ack.accepted).toBe(false);
      if (ack.accepted) throw new Error("unreachable");
      expect(ack.error.category).toBe("invalid-document");
      expect(scopeClaim).not.toHaveBeenCalled();
      expect(intentClaim).not.toHaveBeenCalled();
      expect(upload).not.toHaveBeenCalled();
      expect(broadcast).not.toHaveBeenCalled();
    },
  );

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

  test("advertises cancel exactly when lifecycle ports are injected", async () => {
    const withoutLifecycle = makeMarketplaceBackend(
      BASE_SEPOLIA_TODAY,
      makeTestPorts(),
    );
    expect((await withoutLifecycle.capabilities()).cancel).toBe(false);
    expect(withoutLifecycle.cancel).toBeUndefined();

    const ports = makeTestPorts();
    ports.lifecycle = {
      resolveAttempt: async () => ({ taskId: 1n, attemptIndex: 0 }),
      requestCancel: async () => "requested",
      withdrawAnnouncement: async () => {},
      refundUnusedTaskBudget: async () => {},
    };
    const withLifecycle = makeMarketplaceBackend(BASE_SEPOLIA_TODAY, ports);
    expect((await withLifecycle.capabilities()).cancel).toBe(true);
    expect(withLifecycle.cancel).toBeTypeOf("function");
  });
});

describe("makeMarketplaceBackend -- lifecycle", () => {
  test("cancel is terminal-aware, idempotent, signals the requester, and never releases in today-mode", async () => {
    const ports = makeTestPorts();
    const signal = vi.fn(async (_input: unknown) => undefined);
    const requestedAttempts = new Set<string>();
    const requestCancel = vi.fn(async (input: {
      attempt: string;
      taskId: bigint;
      attemptIndex: number;
      reason: string;
    }) => {
      if (requestedAttempts.has(input.attempt)) return "already-requested" as const;
      requestedAttempts.add(input.attempt);
      await signal(input);
      return "requested" as const;
    });
    const releaseAttempt = vi.fn(async () => undefined);
    ports.lifecycle = {
      resolveAttempt: async () => ({ taskId: 7n, attemptIndex: 2 }),
      requestCancel,
      releaseAttempt,
      withdrawAnnouncement: async () => {},
      refundUnusedTaskBudget: async () => {},
    };
    const backend = makeMarketplaceBackend(BASE_SEPOLIA_TODAY, ports);
    const task = goldenTask();
    const ack = await backend.submit(task, goldenSubmission(task));
    if (!ack.accepted) throw new Error("unreachable");
    const snapshot = await backend.observe(ack.submission);
    const attempt = snapshot.descriptor.attempt;

    await expect(backend.cancel?.(attempt, "no longer needed")).resolves.toEqual({
      requested: true,
    });
    const restartedBackend = makeMarketplaceBackend(BASE_SEPOLIA_TODAY, ports);
    await expect(restartedBackend.cancel?.(attempt, "duplicate after restart")).resolves.toEqual({
      requested: true,
    });
    expect(signal).toHaveBeenCalledTimes(1);
    expect(signal).toHaveBeenCalledWith({
      taskId: 7n,
      attemptIndex: 2,
      reason: "no longer needed",
      attempt,
    });
    expect(releaseAttempt).not.toHaveBeenCalled();

    await backend.drive(attempt, [{
      specversion: "1.0",
      id: "terminal-after-cancel",
      source: snapshot.observations[0]!.source,
      subject: attempt,
      time: "2026-07-29T00:00:00Z",
      datacontenttype: "application/json",
      sequence: "0000000000000002",
      type: "network.jinn.task-execution.attempt-terminal.v1",
      data: { state: "delivered" },
    }]);
    await expect(backend.cancel?.(attempt, "too late")).resolves.toEqual({
      requested: false,
      terminalState: "delivered",
    });
    expect(signal).toHaveBeenCalledTimes(1);
  });

  test("revised requester cancel signals only; it never releases or closes chain state", async () => {
    const ports = makeTestPorts();
    const signal = vi.fn(async (_input: unknown) => undefined);
    const releaseAttempt = vi.fn(async () => undefined);
    const closeTask = vi.fn(async () => undefined);
    const refundUnusedTaskBudget = vi.fn(async () => undefined);
    ports.lifecycle = {
      resolveAttempt: async () => ({ taskId: 8n, attemptIndex: 3 }),
      requestCancel: async (input) => {
        await signal(input);
        return "requested";
      },
      releaseAttempt,
      withdrawAnnouncement: async () => {},
      closeTask,
      refundUnusedTaskBudget,
    };
    const backend = makeMarketplaceBackend(
      { ...BASE_SEPOLIA_TODAY, generation: "revised" },
      ports,
    );
    const task = goldenTask();
    const ack = await backend.submit(task, goldenSubmission(task));
    if (!ack.accepted) throw new Error("unreachable");
    const attempt = (await backend.observe(ack.submission)).descriptor.attempt;

    await backend.cancel?.(attempt, "release requested");
    expect(signal).toHaveBeenCalledOnce();
    expect(releaseAttempt).not.toHaveBeenCalled();
    expect(closeTask).not.toHaveBeenCalled();
    expect(refundUnusedTaskBudget).not.toHaveBeenCalled();
  });

  test("explicit Submission close routes through closeSubmission", async () => {
    const ports = makeTestPorts();
    const refundUnusedTaskBudget = vi.fn(async () => undefined);
    const withdrawAnnouncement = vi.fn(async () => undefined);
    ports.lifecycle = {
      resolveAttempt: async () => ({ taskId: 1n, attemptIndex: 0 }),
      requestCancel: async () => "requested",
      refundUnusedTaskBudget,
      withdrawAnnouncement,
    };
    const backend = makeMarketplaceBackend(BASE_SEPOLIA_TODAY, ports);

    await backend.closeSubmission!(9n);

    expect(refundUnusedTaskBudget).toHaveBeenCalledWith({ taskId: 9n });
    expect(withdrawAnnouncement).toHaveBeenCalledWith({ taskId: 9n });
  });
});
