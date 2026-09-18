import { describe, expect, test } from "vitest";
import type { ObservationMarketplaceEvent } from "@jinn-network/marketplace-projector";
import type { Address, Hex } from "viem";
import { sealSubmission } from "@jinn-network/task-execution-protocol";
import { BENCHMARKING_CELL_EXTENSION } from "./cell-authority.js";
import { deriveAuthorityProjection } from "./authority-projection.js";
import {
  MARKETPLACE_ORDERING_SCHEMA_ID,
  compareSubmissionEntries,
  eventMemberPath,
  memberSha256Hex,
  serializeMarketplaceOrderingRecord,
  submissionMemberPath,
} from "./ordering-record.js";
import { serializeMarketplaceEvent } from "./ordering-event-json.js";
import {
  buildMarketplaceOrderingReceipt,
  evaluateOrderingBytes,
} from "./ordering-receipt.js";

const RUN_DIGEST = `sha256:${"a".repeat(64)}` as const;
const OTHER_RUN = `sha256:${"e".repeat(64)}` as const;
const COORDINATOR = "0x1111111111111111111111111111111111111111" as Address;
const TASK_DIGEST = "7777777777777777777777777777777777777777777777777777777777777777";
const SUBMISSION_URN = "urn:uuid:11111111-1111-4111-8111-111111111111" as const;
const ANCHOR = {
  chain: "eip155:84532",
  blockNumber: 105,
  blockHash: "0x1515151515151515151515151515151515151515151515151515151515151515" as Hex,
};

function projectionShell(
  timestamp: string,
  submission: `urn:uuid:${string}` = SUBMISSION_URN,
  taskDigest: string = TASK_DIGEST,
): ObservationMarketplaceEvent["projection"] {
  return {
    taskCoordinator: COORDINATOR,
    timestamp,
    submission,
    taskDigest: `sha256:${taskDigest}`,
    effectiveDeadline: "2026-08-04T00:00:00Z",
    dispatchContext: {
      uri: "urn:jinn:marketplace:dispatch-context:42:0",
      digest: { sha256: "8888888888888888888888888888888888888888888888888888888888888888" },
    },
  };
}

function todayTaskCreated(
  timestamp: string,
  overrides: {
    submission?: `urn:uuid:${string}`;
    taskDigest?: string;
    taskId?: bigint;
    blockNumber?: number;
    txHash?: Hex;
  } = {},
): ObservationMarketplaceEvent {
  const taskDigest = overrides.taskDigest ?? TASK_DIGEST;
  return {
    event: "TaskCreated",
    derivation: {
      chainId: 84532,
      contract: COORDINATOR,
      event: "TaskCreated",
      blockNumber: overrides.blockNumber ?? 99,
      blockHash: `0x${"6".repeat(64)}`,
      txHash: overrides.txHash ?? `0x${"1".repeat(64)}`,
      logIndex: 0,
      finalityTier: "finalized",
      contractGeneration: "today",
    },
    projection: projectionShell(timestamp, overrides.submission ?? SUBMISSION_URN, taskDigest),
    facts: {
      creator: "0x2222222222222222222222222222222222222222",
      taskId: overrides.taskId ?? 42n,
      manifestDigest: `0x${"0".repeat(64)}`,
      taskCidDigest: `0x${taskDigest}`,
      maxClaims: 2,
      solutionBudget: 100n,
      verdictBudget: 20n,
    },
  } as ObservationMarketplaceEvent;
}

function taskCreated(
  timestamp: string,
  overrides: {
    submission?: `urn:uuid:${string}`;
    taskDigest?: string;
    taskId?: bigint;
    blockNumber?: number;
    txHash?: Hex;
    submissionDigest?: Hex;
  } = {},
): ObservationMarketplaceEvent {
  const taskDigest = overrides.taskDigest ?? TASK_DIGEST;
  return {
    event: "TaskCreated",
    derivation: {
      chainId: 84532,
      contract: COORDINATOR,
      event: "TaskCreated",
      blockNumber: overrides.blockNumber ?? 99,
      blockHash: `0x${"6".repeat(64)}`,
      txHash: overrides.txHash ?? `0x${"1".repeat(64)}`,
      logIndex: 0,
      finalityTier: "finalized",
      contractGeneration: "revised",
    },
    projection: projectionShell(timestamp, overrides.submission ?? SUBMISSION_URN, taskDigest),
    facts: {
      creator: "0x2222222222222222222222222222222222222222",
      taskCidDigest: `0x${taskDigest}`,
      submissionDigest: overrides.submissionDigest ?? HONEST_SUBMISSION_DIGEST,
      taskId: overrides.taskId ?? 42n,
      maxTotal: 2,
      maxConcurrent: 2,
      submissionDeadline: 1_800_000_000n,
      closeAt: 0n,
      responseTimeout: 3600n,
      minVerdicts: 1,
      requireDistinctEvaluator: true,
      solutionMaxDeliveryRate: 10n,
      verdictMaxDeliveryRate: 10n,
      solutionBudget: 20n,
      verdictBudget: 20n,
    },
  } as ObservationMarketplaceEvent;
}

function attemptCreated(input: {
  attemptIndex: number;
  timestamp: string;
  blockNumber: number;
}): ObservationMarketplaceEvent {
  return {
    event: "TaskAttemptCreated",
    derivation: {
      chainId: 84532,
      contract: COORDINATOR,
      event: "TaskAttemptCreated",
      blockNumber: input.blockNumber,
      blockHash: `0x${"7".repeat(64)}`,
      txHash: `0x${String(input.attemptIndex).padStart(64, "a")}` as Hex,
      logIndex: input.attemptIndex,
      finalityTier: "finalized",
      contractGeneration: "revised",
    },
    projection: projectionShell(input.timestamp),
    facts: {
      taskId: 42n,
      attemptIndex: input.attemptIndex,
      deliveryRate: 10n,
      operator: "0x3333333333333333333333333333333333333333" as Address,
      priorityMech: "0x4444444444444444444444444444444444444444" as Address,
      attemptDeadline: 1785369600n,
    },
  } as ObservationMarketplaceEvent;
}

function sealedSubmissionBytes({
  runDigest = RUN_DIGEST,
  submission = SUBMISSION_URN,
  taskDigest = TASK_DIGEST,
  nonce = "ordering-kit",
}: {
  runDigest?: string;
  submission?: `urn:uuid:${string}`;
  taskDigest?: string;
  nonce?: string;
} = {}) {
  return sealSubmission({
    protocol: "https://spec.jinn.network/profiles/task-execution/v1",
    submission,
    task: { digest: { sha256: taskDigest } },
    requester: "urn:uuid:20000000-0000-5000-8000-000000000002",
    nonce,
    idempotencyKey: "ordering/kit/1",
    deadline: "2026-08-04T00:00:00Z",
    requirements: { isolationPolicy: "fixture" },
    [BENCHMARKING_CELL_EXTENSION]: {
      run: runDigest,
      cellKey: `${taskDigest}/armA/1`,
      armId: "armA",
    },
  });
}

const HONEST_SUBMISSION_BYTES = sealedSubmissionBytes();
const HONEST_SUBMISSION_DIGEST = `0x${memberSha256Hex(HONEST_SUBMISSION_BYTES)}` as Hex;

function materialFor(bytes: Uint8Array) {
  return {
    sealedSubmissionBytes: () => bytes,
  };
}

const PASSING_EVENTS = [
  taskCreated("2026-08-03T09:00:00Z"),
  attemptCreated({
    attemptIndex: 0,
    timestamp: "2026-08-03T09:00:01Z",
    blockNumber: 100,
  }),
] as const;

async function passingReceipt(events: readonly ObservationMarketplaceEvent[] = PASSING_EVENTS) {
  return buildMarketplaceOrderingReceipt({
    events,
    closeAnchor: ANCHOR,
    runDigest: RUN_DIGEST,
    material: materialFor(HONEST_SUBMISSION_BYTES),
    transcript: {
      runDigestAnchorAt: events[0]!.projection.timestamp,
      earliestCellPostAt: events[events.length - 1]!.projection.timestamp,
    },
  });
}

describe("buildMarketplaceOrderingReceipt + evaluateOrderingBytes", () => {
  test("byte-only replay is present for a consistent truncated stream", async () => {
    const receipt = await passingReceipt();
    expect(receipt.record.schema).toBe(MARKETPLACE_ORDERING_SCHEMA_ID);
    expect(receipt.record.events).toHaveLength(2);
    expect(receipt.record.submissions).toHaveLength(1);
    const evaluation = await evaluateOrderingBytes({
      recordBytes: receipt.recordBytes,
      members: receipt.members,
    });
    expect(evaluation.status).toBe("present");
    expect(evaluation.record).toEqual(receipt.record);
  });

  test("equal-time boundary remains present", async () => {
    const events = [
      taskCreated("2026-08-03T09:00:00Z"),
      attemptCreated({
        attemptIndex: 0,
        timestamp: "2026-08-03T09:00:00Z",
        blockNumber: 100,
      }),
    ];
    const receipt = await passingReceipt(events);
    const evaluation = await evaluateOrderingBytes({
      recordBytes: receipt.recordBytes,
      members: receipt.members,
    });
    expect(evaluation.status).toBe("present");
  });

  test("omitting an earlier cell event still evaluates present from the truncated stream", async () => {
    const truncated = [
      taskCreated("2026-08-03T09:00:00Z"),
      attemptCreated({
        attemptIndex: 1,
        timestamp: "2026-08-03T09:00:05Z",
        blockNumber: 102,
      }),
    ];
    const receipt = await passingReceipt(truncated);
    expect(receipt.record.transcript.earliestCellPostAt).toBe("2026-08-03T09:00:05Z");
    const evaluation = await evaluateOrderingBytes({
      recordBytes: receipt.recordBytes,
      members: receipt.members,
    });
    expect(evaluation.status).toBe("present");
  });

  test("swapped Run digest is invalid", async () => {
    const receipt = await passingReceipt();
    const bytes = serializeMarketplaceOrderingRecord({
      ...receipt.record,
      runDigest: OTHER_RUN,
    });
    const evaluation = await evaluateOrderingBytes({
      recordBytes: bytes,
      members: receipt.members,
    });
    expect(evaluation.status).toBe("invalid");
  });

  test("altered transcript timestamp is invalid", async () => {
    const receipt = await passingReceipt();
    const bytes = serializeMarketplaceOrderingRecord({
      ...receipt.record,
      transcript: {
        runDigestAnchorAt: "2026-08-03T09:00:00Z",
        earliestCellPostAt: "2026-08-03T08:00:00Z",
      },
    });
    const evaluation = await evaluateOrderingBytes({
      recordBytes: bytes,
      members: receipt.members,
    });
    expect(evaluation.status).toBe("invalid");
  });

  test("reversed transcript ordering is invalid", async () => {
    const receipt = await passingReceipt();
    const bytes = serializeMarketplaceOrderingRecord({
      ...receipt.record,
      transcript: {
        runDigestAnchorAt: "2026-08-03T09:00:01Z",
        earliestCellPostAt: "2026-08-03T09:00:00Z",
      },
    });
    const evaluation = await evaluateOrderingBytes({
      recordBytes: bytes,
      members: receipt.members,
    });
    expect(evaluation.status).toBe("invalid");
  });

  test("event digest mismatch is invalid", async () => {
    const receipt = await passingReceipt();
    const members = new Map(receipt.members);
    const path = receipt.record.events[0]!.path;
    const original = members.get(path)!;
    const tampered = new Uint8Array(original);
    tampered[0] = (tampered[0]! ^ 0xff) & 0xff;
    members.set(path, tampered);
    const evaluation = await evaluateOrderingBytes({
      recordBytes: receipt.recordBytes,
      members,
    });
    expect(evaluation.status).toBe("invalid");
    expect(evaluation.detail).toMatch(/digest mismatch/);
  });

  test("missing referenced member is invalid", async () => {
    const receipt = await passingReceipt();
    const members = new Map(receipt.members);
    members.delete(receipt.record.events[0]!.path);
    const evaluation = await evaluateOrderingBytes({
      recordBytes: receipt.recordBytes,
      members,
    });
    expect(evaluation.status).toBe("invalid");
    expect(evaluation.detail).toMatch(/missing referenced/);
  });

  test("unreferenced ordering member is invalid", async () => {
    const receipt = await passingReceipt();
    const members = new Map(receipt.members);
    members.set(`ordering/events/000099-${"f".repeat(64)}.json`, new Uint8Array([1, 2, 3]));
    const evaluation = await evaluateOrderingBytes({
      recordBytes: receipt.recordBytes,
      members,
    });
    expect(evaluation.status).toBe("invalid");
    expect(evaluation.detail).toMatch(/unreferenced/);
  });

  test("Submission bytes that commit to another Run are omitted from the receipt", async () => {
    const events = PASSING_EVENTS;
    const receipt = await buildMarketplaceOrderingReceipt({
      events,
      closeAnchor: ANCHOR,
      runDigest: RUN_DIGEST,
      material: materialFor(sealedSubmissionBytes({ runDigest: OTHER_RUN })),
      transcript: {
        runDigestAnchorAt: "2026-08-03T09:00:00Z",
        earliestCellPostAt: "2026-08-03T09:00:01Z",
      },
    });
    expect(receipt.record.submissions).toEqual([]);
    const evaluation = await evaluateOrderingBytes({
      recordBytes: receipt.recordBytes,
      members: receipt.members,
    });
    expect(evaluation.status).toBe("invalid");
  });

  test("identity-blind material does not catalog a foreign TaskCreated against this Run's blob", async () => {
    const foreignUrn = "urn:uuid:22222222-2222-4222-8222-222222222222" as const;
    const foreignTask = "9999999999999999999999999999999999999999999999999999999999999999";
    const events = [
      taskCreated("2026-08-03T08:00:00Z", {
        submission: foreignUrn,
        taskDigest: foreignTask,
        taskId: 41n,
        blockNumber: 90,
        txHash: `0x${"2".repeat(64)}`,
      }),
      ...PASSING_EVENTS,
    ];
    const receipt = await buildMarketplaceOrderingReceipt({
      events,
      closeAnchor: ANCHOR,
      runDigest: RUN_DIGEST,
      material: materialFor(sealedSubmissionBytes()),
      transcript: {
        runDigestAnchorAt: "2026-08-03T09:00:00Z",
        earliestCellPostAt: "2026-08-03T09:00:01Z",
      },
    });
    expect(receipt.record.submissions).toEqual([
      expect.objectContaining({
        submission: SUBMISSION_URN,
        task: `sha256:${TASK_DIGEST}`,
      }),
    ]);
  });

  test("two identities sharing one blob with an earlier foreign TaskCreated is invalid", async () => {
    const honestBytes = sealedSubmissionBytes();
    const sha256 = memberSha256Hex(honestBytes);
    const path = submissionMemberPath(sha256);
    const foreignUrn = "urn:uuid:22222222-2222-4222-8222-222222222222" as const;
    const foreignTask = "9999999999999999999999999999999999999999999999999999999999999999";
    const events = [
      taskCreated("2026-08-03T08:00:00Z", {
        submission: foreignUrn,
        taskDigest: foreignTask,
        taskId: 41n,
        blockNumber: 90,
        txHash: `0x${"2".repeat(64)}`,
      }),
      ...PASSING_EVENTS,
    ];
    const members = new Map<string, Uint8Array>();
    const eventEntries = events.map((event, ordinal) => {
      const bytes = serializeMarketplaceEvent(event);
      const digest = memberSha256Hex(bytes);
      const eventPath = eventMemberPath(ordinal, digest);
      members.set(eventPath, bytes);
      return { ordinal, sha256: digest, path: eventPath };
    });
    members.set(path, honestBytes);
    const submissions = [
      {
        submission: SUBMISSION_URN,
        task: `sha256:${TASK_DIGEST}` as const,
        sha256,
        path,
      },
      {
        submission: foreignUrn,
        task: `sha256:${foreignTask}` as const,
        sha256,
        path,
      },
    ].sort(compareSubmissionEntries);
    const recordBytes = serializeMarketplaceOrderingRecord({
      schema: MARKETPLACE_ORDERING_SCHEMA_ID,
      runDigest: RUN_DIGEST,
      closeAnchor: ANCHOR,
      events: eventEntries,
      submissions,
      transcript: {
        runDigestAnchorAt: "2026-08-03T08:00:00Z",
        earliestCellPostAt: "2026-08-03T09:00:01Z",
      },
    });
    const evaluation = await evaluateOrderingBytes({ recordBytes, members });
    expect(evaluation.status).toBe("invalid");
    expect(evaluation.detail).toMatch(/identity does not match sealed document/);
  });

  test("catalog blob that claims a foreign TaskCreated but is not its anchored digest is invalid", async () => {
    const honestSha = memberSha256Hex(HONEST_SUBMISSION_BYTES);
    const honestPath = submissionMemberPath(honestSha);
    const foreignUrn = "urn:uuid:22222222-2222-4222-8222-222222222222" as const;
    const foreignTask = "9999999999999999999999999999999999999999999999999999999999999999";
    const foreignHonestBytes = sealedSubmissionBytes({
      submission: foreignUrn,
      taskDigest: foreignTask,
      runDigest: OTHER_RUN,
      nonce: "foreign-honest",
    });
    const fakeBytes = sealedSubmissionBytes({
      submission: foreignUrn,
      taskDigest: foreignTask,
      nonce: "foreign-fake",
    });
    const fakeSha = memberSha256Hex(fakeBytes);
    const fakePath = submissionMemberPath(fakeSha);
    const events = [
      taskCreated("2026-08-03T08:00:00Z", {
        submission: foreignUrn,
        taskDigest: foreignTask,
        taskId: 41n,
        blockNumber: 90,
        txHash: `0x${"2".repeat(64)}`,
        submissionDigest: `0x${memberSha256Hex(foreignHonestBytes)}`,
      }),
      ...PASSING_EVENTS,
    ];
    const members = new Map<string, Uint8Array>();
    const eventEntries = events.map((event, ordinal) => {
      const bytes = serializeMarketplaceEvent(event);
      const digest = memberSha256Hex(bytes);
      const eventPath = eventMemberPath(ordinal, digest);
      members.set(eventPath, bytes);
      return { ordinal, sha256: digest, path: eventPath };
    });
    members.set(honestPath, HONEST_SUBMISSION_BYTES);
    members.set(fakePath, fakeBytes);
    const submissions = [
      {
        submission: SUBMISSION_URN,
        task: `sha256:${TASK_DIGEST}` as const,
        sha256: honestSha,
        path: honestPath,
      },
      {
        submission: foreignUrn,
        task: `sha256:${foreignTask}` as const,
        sha256: fakeSha,
        path: fakePath,
      },
    ].sort(compareSubmissionEntries);
    const recordBytes = serializeMarketplaceOrderingRecord({
      schema: MARKETPLACE_ORDERING_SCHEMA_ID,
      runDigest: RUN_DIGEST,
      closeAnchor: ANCHOR,
      events: eventEntries,
      submissions,
      transcript: {
        runDigestAnchorAt: "2026-08-03T08:00:00Z",
        earliestCellPostAt: "2026-08-03T09:00:01Z",
      },
    });
    const evaluation = await evaluateOrderingBytes({ recordBytes, members });
    expect(evaluation.status).toBe("invalid");
  });

  test("today TaskCreated without submissionDigest cannot steal runDigestAnchorAt via a rewritten catalog blob", async () => {
    const honestSha = memberSha256Hex(HONEST_SUBMISSION_BYTES);
    const honestPath = submissionMemberPath(honestSha);
    const foreignUrn = "urn:uuid:22222222-2222-4222-8222-222222222222" as const;
    const foreignTask = "9999999999999999999999999999999999999999999999999999999999999999";
    const fakeBytes = sealedSubmissionBytes({
      submission: foreignUrn,
      taskDigest: foreignTask,
      nonce: "foreign-today-fake",
    });
    const fakeSha = memberSha256Hex(fakeBytes);
    const fakePath = submissionMemberPath(fakeSha);
    const events = [
      todayTaskCreated("2026-08-03T08:00:00Z", {
        submission: foreignUrn,
        taskDigest: foreignTask,
        taskId: 41n,
        blockNumber: 90,
        txHash: `0x${"2".repeat(64)}`,
      }),
      ...PASSING_EVENTS,
    ];
    const members = new Map<string, Uint8Array>();
    const eventEntries = events.map((event, ordinal) => {
      const bytes = serializeMarketplaceEvent(event);
      const digest = memberSha256Hex(bytes);
      const eventPath = eventMemberPath(ordinal, digest);
      members.set(eventPath, bytes);
      return { ordinal, sha256: digest, path: eventPath };
    });
    members.set(honestPath, HONEST_SUBMISSION_BYTES);
    members.set(fakePath, fakeBytes);
    const submissions = [
      {
        submission: SUBMISSION_URN,
        task: `sha256:${TASK_DIGEST}` as const,
        sha256: honestSha,
        path: honestPath,
      },
      {
        submission: foreignUrn,
        task: `sha256:${foreignTask}` as const,
        sha256: fakeSha,
        path: fakePath,
      },
    ].sort(compareSubmissionEntries);
    const recordBytes = serializeMarketplaceOrderingRecord({
      schema: MARKETPLACE_ORDERING_SCHEMA_ID,
      runDigest: RUN_DIGEST,
      closeAnchor: ANCHOR,
      events: eventEntries,
      submissions,
      transcript: {
        runDigestAnchorAt: "2026-08-03T08:00:00Z",
        earliestCellPostAt: "2026-08-03T09:00:01Z",
      },
    });
    const evaluation = await evaluateOrderingBytes({ recordBytes, members });
    expect(evaluation.status).toBe("invalid");
    expect(evaluation.detail).toMatch(/transcript timestamps do not match rederived pair/);
  });

  test("reordered projector input is a different replay", async () => {
    const forward = deriveAuthorityProjection([...PASSING_EVENTS], ANCHOR);
    const reversed = deriveAuthorityProjection([...PASSING_EVENTS].reverse(), ANCHOR);
    expect(forward.events.map((event) => event.event))
      .not.toEqual(reversed.events.map((event) => event.event));
  });
});
