import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  cellIdempotencyKey,
  submissionExtensionBlock,
} from "@jinn-network/benchmarking-records";
import { deriveMarketplaceAttemptUri, BASE_SEPOLIA_TODAY, MECH_ABI } from "@jinn-network/marketplace-binding";
import {
  decodeMarketplaceLogs,
  marketplaceEventOriginAuthority,
  REVISED_PROJECTOR_EVENTS_ABI,
  type ObservationMarketplaceEvent,
} from "@jinn-network/marketplace-projector";
import {
  documentDigest,
  sealSubmission,
} from "@jinn-network/task-execution-protocol";
import {
  encodeAbiParameters,
  encodeEventTopics,
  type AbiEvent,
  type Address,
  type Hex,
} from "viem";
import { describe, expect, test } from "vitest";
import {
  deriveAuthorityProjection,
  type AttemptCreationAuthority,
  type AttemptObservationAuthority,
} from "./authority-projection.js";
import {
  authorizeCellFromProjection,
  BENCHMARKING_CELL_EXTENSION,
  selectAccountedAttempt,
  type ProjectorCellJoinCandidate,
} from "./cell-authority.js";

const RUN_DIGEST = `sha256:${"a".repeat(64)}` as const;
const TASK_DIGEST = "7777777777777777777777777777777777777777777777777777777777777777";
const CELL_KEY = `${TASK_DIGEST}/armA/1`;
const SUBMISSION_URN = "urn:uuid:11111111-1111-4111-8111-111111111111";
const COORDINATOR = "0x1111111111111111111111111111111111111111" as Address;
const OPERATOR = "0x3333333333333333333333333333333333333333" as Address;
const FIXTURES_ROOT = fileURLToPath(new URL("../fixtures/projector/", import.meta.url));

function buildSealedSubmission(dispatch = 1) {
  const extension = submissionExtensionBlock(RUN_DIGEST, CELL_KEY, "armA");
  const doc = {
    protocol: "https://jinn.network/profiles/task-execution/1.0",
    submission: SUBMISSION_URN,
    task: { digest: { sha256: TASK_DIGEST } },
    requester: "urn:uuid:3333333333333333333333333333333333333333",
    nonce: "attempt-select-nonce",
    idempotencyKey: cellIdempotencyKey(RUN_DIGEST, CELL_KEY, dispatch),
    deadline: "2026-08-04T00:00:00Z",
    requirements: {},
    [BENCHMARKING_CELL_EXTENSION]: extension,
  };
  const bytes = sealSubmission(doc);
  return { bytes, digest: documentDigest(bytes) as `sha256:${string}` };
}

interface FixtureLog {
  readonly event: string;
  readonly chainId: number;
  readonly address: Address;
  readonly blockNumber: string;
  readonly blockHash: Hex;
  readonly transactionHash: Hex;
  readonly logIndex: number;
  readonly finalityTier: "safe" | "finalized";
  readonly args: Readonly<Record<string, string | boolean>>;
  readonly projection: ObservationMarketplaceEvent["projection"];
}

function abiEvent(name: string): AbiEvent {
  const event = [...REVISED_PROJECTOR_EVENTS_ABI, ...MECH_ABI].find((item) => item.name === name);
  if (event === undefined) throw new Error(`unknown fixture event: ${name}`);
  return event as AbiEvent;
}

function enrichedEvents(submissionDigestHex: string): ObservationMarketplaceEvent[] {
  const fixture = JSON.parse(
    readFileSync(`${FIXTURES_ROOT}golden-events/revised-task-created.json`, "utf8"),
  ) as { logs: FixtureLog[] };
  const logs = fixture.logs;
  const decoded = decodeMarketplaceLogs(
    logs.map((log) => {
      const event = abiEvent(log.event);
      const args = Object.fromEntries(
        event.inputs.map((input) => {
          const name = input.name ?? "";
          const value = log.args[name];
          if (value === undefined) throw new TypeError(`missing ${name}`);
          return [name, typeof value === "string" && (input.type.startsWith("uint") || input.type.startsWith("int"))
            ? BigInt(value)
            : value];
        }),
      );
      const unindexed = event.inputs.filter((input) => input.indexed !== true);
      const data = encodeAbiParameters(
        unindexed.map((input) => ({ name: input.name, type: input.type })),
        unindexed.map((input) => args[input.name ?? ""]),
      );
      return {
        chainId: log.chainId,
        address: log.address,
        blockNumber: BigInt(log.blockNumber),
        blockHash: log.blockHash,
        transactionHash: log.transactionHash,
        logIndex: log.logIndex,
        finalityTier: log.finalityTier,
        topics: encodeEventTopics({ abi: [event], eventName: log.event, args }) as readonly Hex[],
        data,
      };
    }),
    marketplaceEventOriginAuthority({
      ...BASE_SEPOLIA_TODAY,
      generation: "revised",
      jinnRouter: logs[0]!.address,
      taskCoordinator: logs[0]!.address,
      mechMarketplace: BASE_SEPOLIA_TODAY.mechMarketplace,
    }, () => false),
  );
  return decoded.map((event, index) => {
    const log = logs[index]!;
    return {
      ...event,
      facts: log.event === "TaskCreated"
        ? { ...event.facts, submissionDigest: submissionDigestHex as Hex }
        : event.facts,
      projection: { ...log.projection, taskCoordinator: logs[0]!.address },
    };
  }) as ObservationMarketplaceEvent[];
}

function attemptEvent(input: {
  attemptIndex: number;
  requestId: Hex;
  operator?: Address;
  blockNumber?: number;
  generation?: "today" | "revised";
}): ObservationMarketplaceEvent {
  const blockNumber = input.blockNumber ?? 100;
  return {
    event: "TaskAttemptCreated",
    derivation: {
      chainId: 84532,
      contract: COORDINATOR,
      event: "TaskAttemptCreated",
      blockNumber,
      blockHash: "0x6666666666666666666666666666666666666666666666666666666666666666",
      txHash: `0x${String(input.attemptIndex).padStart(64, "a")}` as Hex,
      logIndex: input.attemptIndex + 1,
      finalityTier: "finalized",
      contractGeneration: input.generation ?? "revised",
    },
    projection: {
      taskCoordinator: COORDINATOR,
      timestamp: "2026-08-01T00:00:00Z",
      submission: SUBMISSION_URN,
      taskDigest: `sha256:${TASK_DIGEST}`,
      effectiveDeadline: "2026-08-04T00:00:00Z",
      dispatchContext: {
        uri: "urn:jinn:marketplace:dispatch-context:42:0",
        digest: { sha256: "8888888888888888888888888888888888888888888888888888888888888888" },
      },
    },
    facts: {
      taskId: 42n,
      attemptIndex: input.attemptIndex,
      requestId: input.requestId,
      deliveryRate: 10n,
      operator: input.operator ?? OPERATOR,
      priorityMech: "0x4444444444444444444444444444444444444444" as Address,
      attemptDeadline: 1785369600n,
    },
  } as ObservationMarketplaceEvent;
}

function deliveryEvent(attemptIndex: number, requestId: Hex): ObservationMarketplaceEvent {
  return {
    event: "SolutionDeliveryClaimed",
    derivation: {
      chainId: 84532,
      contract: COORDINATOR,
      event: "SolutionDeliveryClaimed",
      blockNumber: 101 + attemptIndex,
      blockHash: `0x${String(attemptIndex + 7).padStart(64, "7")}` as Hex,
      txHash: `0x${String(attemptIndex + 20).padStart(64, "b")}` as Hex,
      logIndex: 0,
      finalityTier: "finalized",
      contractGeneration: "revised",
    },
    projection: {
      taskCoordinator: COORDINATOR,
      timestamp: "2026-08-01T00:00:01Z",
      submission: SUBMISSION_URN,
      taskDigest: `sha256:${TASK_DIGEST}`,
      effectiveDeadline: "2026-08-04T00:00:00Z",
      dispatchContext: {
        uri: "urn:jinn:marketplace:dispatch-context:42:0",
        digest: { sha256: "8888888888888888888888888888888888888888888888888888888888888888" },
      },
    },
    facts: {
      taskId: 42n,
      attemptIndex,
      requestId,
      deliveryDigest: `0x${"d".repeat(64)}` as Hex,
      operator: OPERATOR,
    },
  } as ObservationMarketplaceEvent;
}

function projectionWithAttempts(
  baseEvents: ObservationMarketplaceEvent[],
  attempts: ObservationMarketplaceEvent[],
  settlements: ObservationMarketplaceEvent[] = [],
) {
  const closeAnchor = {
    chain: "eip155:84532",
    blockNumber: 105,
    blockHash: "0x1515151515151515151515151515151515151515151515151515151515151515",
  };
  const all = [...baseEvents, ...attempts, ...settlements];
  return deriveAuthorityProjection(all, closeAnchor);
}

describe("selectAccountedAttempt", () => {
  test("prefers delivered attempt over earlier undelivered sibling", () => {
    const selected = selectAccountedAttempt([
      {
        attemptUrn: "urn:uuid:00000000-0000-4000-8000-000000000001",
        engaged: {} as AttemptObservationAuthority,
        creation: { attemptIndex: 0 } as AttemptCreationAuthority,
        submission: { bytes: new Uint8Array(), digest: `sha256:${"a".repeat(64)}` },
        hasDelivery: false,
      },
      {
        attemptUrn: "urn:uuid:00000000-0000-4000-8000-000000000002",
        engaged: {} as AttemptObservationAuthority,
        creation: { attemptIndex: 1 } as AttemptCreationAuthority,
        submission: { bytes: new Uint8Array(), digest: `sha256:${"b".repeat(64)}` },
        hasDelivery: true,
        deliveryDigest: `sha256:${"d".repeat(64)}`,
      },
    ]);
    expect(selected?.creation.attemptIndex).toBe(1);
  });

  test("fails closed on multiple delivered attempts", () => {
    expect(selectAccountedAttempt([
      {
        attemptUrn: "urn:uuid:00000000-0000-4000-8000-000000000001",
        engaged: {} as AttemptObservationAuthority,
        creation: { attemptIndex: 0 } as AttemptCreationAuthority,
        submission: { bytes: new Uint8Array(), digest: `sha256:${"a".repeat(64)}` },
        hasDelivery: true,
      },
      {
        attemptUrn: "urn:uuid:00000000-0000-4000-8000-000000000002",
        engaged: {} as AttemptObservationAuthority,
        creation: { attemptIndex: 1 } as AttemptCreationAuthority,
        submission: { bytes: new Uint8Array(), digest: `sha256:${"b".repeat(64)}` },
        hasDelivery: true,
      },
    ])).toBeUndefined();
  });

  test("without delivery picks highest attemptIndex", () => {
    const selected = selectAccountedAttempt([
      {
        attemptUrn: "urn:uuid:00000000-0000-4000-8000-000000000001",
        engaged: {} as AttemptObservationAuthority,
        creation: { attemptIndex: 0 } as AttemptCreationAuthority,
        submission: { bytes: new Uint8Array(), digest: `sha256:${"a".repeat(64)}` },
        hasDelivery: false,
      },
      {
        attemptUrn: "urn:uuid:0000-0000-0000-0000-000000000002",
        engaged: {} as AttemptObservationAuthority,
        creation: { attemptIndex: 2 } as AttemptCreationAuthority,
        submission: { bytes: new Uint8Array(), digest: `sha256:${"b".repeat(64)}` },
        hasDelivery: false,
      },
    ]);
    expect(selected?.creation.attemptIndex).toBe(2);
  });
});

describe("authorizeCellFromProjection attempt selection", () => {
  test("selects later delivered attempt over earlier undelivered attempt", async () => {
    const sealed = buildSealedSubmission();
    const base = enrichedEvents(`0x${sealed.digest.slice("sha256:".length)}`);
    const request0 = `0x${"a".repeat(64)}` as Hex;
    const request1 = `0x${"b".repeat(64)}` as Hex;
    const projection = projectionWithAttempts(
      base,
      [
        attemptEvent({ attemptIndex: 0, requestId: request0, blockNumber: 99 }),
        attemptEvent({ attemptIndex: 1, requestId: request1, blockNumber: 100 }),
      ],
      [deliveryEvent(1, request1)],
    );
    const attempt1 = deriveMarketplaceAttemptUri({
      chainId: 84532,
      coordinator: COORDINATOR,
      taskId: 42n,
      attemptIndex: 1,
    });
    const candidate: ProjectorCellJoinCandidate = {
      cellKey: CELL_KEY,
      armId: "armA",
      replicate: 1,
      taskDigest: TASK_DIGEST,
      dispatches: 1,
      accounted: 1,
    };
    const cell = await authorizeCellFromProjection({
      runDigest: RUN_DIGEST,
      candidate,
      projection,
      material: { sealedSubmissionBytes: () => sealed.bytes },
    });
    expect(cell?.attempt).toBe(attempt1);
  });

  test("rejects operator mismatch between creation event and attempt-engaged observation", async () => {
    const sealed = buildSealedSubmission();
    const base = enrichedEvents(`0x${sealed.digest.slice("sha256:".length)}`);
    const projection = projectionWithAttempts(
      base,
      [attemptEvent({ attemptIndex: 0, requestId: `0x${"c".repeat(64)}` as Hex })],
    );
    const tampered = {
      ...projection,
      events: projection.events.map((event) => {
        if (event.event !== "TaskAttemptCreated") return event;
        return {
          ...event,
          facts: {
            ...event.facts,
            operator: "0x9999999999999999999999999999999999999999" as Address,
          },
        };
      }),
    } as typeof projection;
    const cell = await authorizeCellFromProjection({
      runDigest: RUN_DIGEST,
      candidate: {
        cellKey: CELL_KEY,
        armId: "armA",
        replicate: 1,
        taskDigest: TASK_DIGEST,
        dispatches: 1,
      },
      projection: tampered,
      material: { sealedSubmissionBytes: () => sealed.bytes },
    });
    expect(cell).toBeUndefined();
  });

  test("rejects generation mismatch between creation and submission-accepted", async () => {
    const sealed = buildSealedSubmission();
    const base = enrichedEvents(`0x${sealed.digest.slice("sha256:".length)}`);
    const projection = projectionWithAttempts(
      base,
      [attemptEvent({ attemptIndex: 0, requestId: `0x${"d".repeat(64)}` as Hex })],
    );
    const tampered = {
      ...projection,
      events: projection.events.map((event) => {
        if (event.event !== "TaskAttemptCreated") return event;
        return {
          ...event,
          derivation: { ...event.derivation, contractGeneration: "today" as const },
        };
      }),
    } as typeof projection;
    const cell = await authorizeCellFromProjection({
      runDigest: RUN_DIGEST,
      candidate: {
        cellKey: CELL_KEY,
        armId: "armA",
        replicate: 1,
        taskDigest: TASK_DIGEST,
        dispatches: 1,
      },
      projection: tampered,
      material: { sealedSubmissionBytes: () => sealed.bytes },
    });
    expect(cell).toBeUndefined();
  });
});
