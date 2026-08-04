import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  cellIdempotencyKey,
  cellKey,
  submissionExtensionBlock,
} from "@jinn-network/benchmarking-records";
import { BASE_SEPOLIA_TODAY } from "@jinn-network/marketplace-binding";
import { MECH_ABI } from "@jinn-network/marketplace-binding";
import {
  createMarketplaceProjectionState,
  decodeMarketplaceLogs,
  marketplaceEventOriginAuthority,
  reduceMarketplaceProjection,
  REVISED_PROJECTOR_EVENTS_ABI,
  selectCanonicalMarketplaceObservations,
  type MarketplaceProtocolObservation,
  type ObservationMarketplaceEvent,
} from "@jinn-network/marketplace-projector";
import type { ProtocolObservation } from "@jinn-network/task-execution-protocol";
import {
  documentDigest,
  sealSubmission,
  validateSubmission,
} from "@jinn-network/task-execution-protocol";
import {
  encodeAbiParameters,
  encodeEventTopics,
  type AbiEvent,
  type Address,
  type Hex,
} from "viem";
import { describe, expect, test } from "vitest";
import { deriveMarketplaceAttemptUri } from "@jinn-network/marketplace-binding";
import {
  deriveEligibleObservations,
  deriveEligibleProjection,
  isObservationEligible,
  isValidCloseAnchor,
  projectorInputScope,
} from "./input-scope.js";
import { deriveAuthorityProjection } from "./authority-projection.js";
import {
  authorizeCellFromProjection,
  BENCHMARKING_CELL_EXTENSION,
  type ProjectorCellJoinCandidate,
} from "./cell-authority.js";
import { bytesMatchCanonicalSeal, decodeUtf8Json } from "./canonical-bytes.js";

const RUN_DIGEST = `sha256:${"a".repeat(64)}` as const;
const TASK_DIGEST = "7777777777777777777777777777777777777777777777777777777777777777";
const CELL_KEY = `${TASK_DIGEST}/armA/1`;
const SUBMISSION_URN = "urn:uuid:11111111-1111-4111-8111-111111111111";
const ANCHOR = {
  chain: "eip155:84532",
  blockNumber: 105,
  blockHash: "0x1515151515151515151515151515151515151515151515151515151515151515",
};

const COORDINATOR = "0x1111111111111111111111111111111111111111" as Address;
const FIXTURES_ROOT = fileURLToPath(new URL("../fixtures/projector/", import.meta.url));
const REQUEST_ID = `0x${"5".repeat(64)}` as Hex;

interface ProjectorGoldenFixture {
  readonly name: string;
  readonly logs: readonly unknown[];
}

function loadProjectorFixture(name: string): ProjectorGoldenFixture {
  const fixture = JSON.parse(
    readFileSync(`${FIXTURES_ROOT}golden-events/${name}.json`, "utf8"),
  ) as ProjectorGoldenFixture;
  if (fixture.name !== name) {
    throw new Error(`fixture name mismatch: expected ${name}, got ${fixture.name}`);
  }
  return fixture;
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

function observation(
  blockNumber: number,
  finalityTier: "safe" | "finalized",
  overrides: Partial<ProtocolObservation> = {},
): MarketplaceProtocolObservation {
  return {
    specversion: "1.0",
    id: overrides.id ?? `obs-${blockNumber}-${finalityTier}`,
    source: "urn:jinn:backend:marketplace",
    subject: SUBMISSION_URN,
    time: "2026-08-01T00:00:00Z",
    datacontenttype: "application/json",
    sequence: String(blockNumber).padStart(16, "0"),
    type: "network.jinn.task-execution.submission-accepted.v1",
    data: {
      submission: SUBMISSION_URN,
      task: `sha256:${TASK_DIGEST}`,
    },
    taskdigest: TASK_DIGEST,
    derivation: {
      chainId: 84532,
      contract: "0x1111111111111111111111111111111111111111",
      event: "TaskCreated",
      blockNumber,
      blockHash: `0x${String(blockNumber).padStart(64, "0")}`,
      txHash: `0x${"3".repeat(64)}`,
      logIndex: 0,
      finalityTier,
      contractGeneration: "revised",
    },
    ...overrides,
  } as MarketplaceProtocolObservation;
}

function abiEvent(name: string): AbiEvent {
  const event = [...REVISED_PROJECTOR_EVENTS_ABI, ...MECH_ABI].find((item) => item.name === name);
  if (event === undefined) throw new Error(`unknown fixture event: ${name}`);
  return event as AbiEvent;
}

function evmValue(type: string, value: string | boolean): unknown {
  if (type.startsWith("uint") || type.startsWith("int")) {
    if (typeof value !== "string") throw new TypeError(`${type} fixture value must be decimal text`);
    return BigInt(value);
  }
  return value;
}

function rawLog(log: FixtureLog) {
  const event = abiEvent(log.event);
  const args = Object.fromEntries(
    event.inputs.map((input) => {
      const name = input.name ?? "";
      const value = log.args[name];
      if (value === undefined) throw new TypeError(`fixture event ${log.event} has no argument "${name}"`);
      return [name, evmValue(input.type, value)];
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
}

function enrichedEvents(
  fixture: { logs: readonly unknown[] },
  submissionDigestHex?: string,
): ObservationMarketplaceEvent[] {
  const logs = fixture.logs as FixtureLog[];
  const decoded = decodeMarketplaceLogs(
    logs.map(rawLog),
    marketplaceEventOriginAuthority({
      ...BASE_SEPOLIA_TODAY,
      generation: "revised",
      jinnRouter: logs.find((log) => log.event !== "Deliver")!.address,
      taskCoordinator: logs.find((log) => log.event !== "Deliver")!.address,
      mechMarketplace: logs.find((log) => log.event === "Deliver")?.address
        ?? BASE_SEPOLIA_TODAY.mechMarketplace,
    }, (address) => logs.some((log) => log.event === "Deliver" && log.address.toLowerCase() === address.toLowerCase())),
  );
  if (decoded.length !== logs.length) {
    throw new Error("fixture did not decode one event per log");
  }
  return decoded.map((event, index) => {
    const log = logs[index]!;
    const args = submissionDigestHex !== undefined && log.event === "TaskCreated"
      ? { ...log.args, submissionDigest: submissionDigestHex }
      : log.args;
    return {
      ...event,
      facts: log.event === "TaskCreated" && submissionDigestHex !== undefined
        ? { ...event.facts, submissionDigest: submissionDigestHex as Hex }
        : event.facts,
      projection: {
        ...log.projection,
        taskCoordinator: logs[0]!.address,
      },
    };
  }) as ObservationMarketplaceEvent[];
}

function buildSealedSubmission(input: {
  runDigest?: string;
  taskDigestHex?: string;
  submissionUrn?: string;
  armId?: string;
  replicate?: number;
  dispatch?: number;
  extensionOverrides?: Record<string, unknown>;
  idempotencyKey?: string;
}) {
  const runDigest = input.runDigest ?? RUN_DIGEST;
  const taskDigestHex = input.taskDigestHex ?? TASK_DIGEST;
  const submissionUrn = input.submissionUrn ?? SUBMISSION_URN;
  const armId = input.armId ?? "armA";
  const replicate = input.replicate ?? 1;
  const dispatch = input.dispatch ?? 1;
  const key = cellKey(taskDigestHex, armId, replicate);
  const extension = {
    ...submissionExtensionBlock(runDigest, key, armId),
    ...input.extensionOverrides,
  };
  const doc = {
    protocol: "https://spec.jinn.network/profiles/task-execution/v1",
    submission: submissionUrn,
    task: { digest: { sha256: taskDigestHex } },
    requester: "urn:uuid:3333333333333333333333333333333333333333",
    nonce: "authority-test-nonce",
    idempotencyKey: input.idempotencyKey ?? cellIdempotencyKey(runDigest, key, dispatch),
    deadline: "2026-08-04T00:00:00Z",
    requirements: {},
    [BENCHMARKING_CELL_EXTENSION]: extension,
  };
  const bytes = sealSubmission(doc);
  return {
    bytes,
    digest: documentDigest(bytes) as `sha256:${string}`,
    doc,
    cellKey: key,
    dispatch,
  };
}

function joinCandidate(
  sealed: ReturnType<typeof buildSealedSubmission>,
  dispatch?: number,
): ProjectorCellJoinCandidate {
  const accounted = dispatch ?? sealed.dispatch;
  return {
    cellKey: sealed.cellKey,
    armId: "armA",
    replicate: 1,
    taskDigest: TASK_DIGEST,
    dispatches: accounted,
    accounted,
  };
}

function projectionWithAttemptLineage(
  events: ObservationMarketplaceEvent[],
  closeAnchor: { chain: string; blockNumber: number; blockHash: string },
) {
  const attempt = deriveMarketplaceAttemptUri({
    chainId: 84532,
    coordinator: COORDINATOR,
    taskId: 42n,
    attemptIndex: 0,
  });
  const attemptEvent = {
    event: "TaskAttemptCreated" as const,
    derivation: {
      chainId: 84532,
      contract: COORDINATOR,
      event: "TaskAttemptCreated" as const,
      blockNumber: closeAnchor.blockNumber,
      blockHash: closeAnchor.blockHash as Hex,
      txHash: `0x${"b".repeat(64)}` as Hex,
      logIndex: 1,
      finalityTier: "finalized" as const,
      contractGeneration: "revised" as const,
    },
    projection: events[0]!.projection,
    facts: {
      taskId: 42n,
      attemptIndex: 0,
      deliveryRate: 10n,
      operator: "0x3333333333333333333333333333333333333333" as Address,
      priorityMech: "0x4444444444444444444444444444444444444444" as Address,
      attemptDeadline: 1785369600n,
    },
  } as ObservationMarketplaceEvent;
  const reduced = reduceMarketplaceProjection(
    [...events, attemptEvent],
    createMarketplaceProjectionState(),
  );
  return deriveAuthorityProjection([...events, ...reduced.events], closeAnchor);
}

describe("isObservationEligible", () => {
  test("excludes safe-tier facts", () => {
    expect(isObservationEligible(observation(100, "safe"), ANCHOR)).toBe(false);
  });

  test("excludes late finalized facts beyond the anchor block", () => {
    expect(isObservationEligible(observation(200, "finalized"), ANCHOR)).toBe(false);
  });

  test("includes finalized facts on or before the anchor block", () => {
    expect(isObservationEligible(observation(100, "finalized"), ANCHOR)).toBe(true);
    expect(isObservationEligible(observation(105, "finalized", {
      derivation: {
        ...observation(105, "finalized").derivation!,
        blockHash: ANCHOR.blockHash,
      },
    }), ANCHOR)).toBe(true);
  });

  test("rejects same-height block-hash mismatch at the anchor", () => {
    const mismatch = observation(105, "finalized", {
      derivation: {
        ...observation(105, "finalized").derivation!,
        blockHash: "0x9999999999999999999999999999999999999999999999999999999999999999",
      },
    });
    expect(isObservationEligible(mismatch, ANCHOR)).toBe(false);
  });

  test("allows earlier blocks with a different hash than the anchor", () => {
    const earlier = observation(100, "finalized", {
      derivation: {
        ...observation(100, "finalized").derivation!,
        blockHash: "0x9999999999999999999999999999999999999999999999999999999999999999",
      },
    });
    expect(isObservationEligible(earlier, ANCHOR)).toBe(true);
  });

  test("rejects wrong-chain observations", () => {
    const wrongChain = observation(100, "finalized", {
      derivation: {
        ...observation(100, "finalized").derivation!,
        chainId: 1,
      },
    });
    expect(isObservationEligible(wrongChain, ANCHOR)).toBe(false);
  });

  test.each([
    ["NaN", Number.NaN],
    ["fractional", 100.5],
    ["negative", -1],
  ] as const)("rejects non-integer block numbers (%s)", (_label, blockNumber) => {
    const invalid = observation(100, "finalized", {
      derivation: {
        ...observation(100, "finalized").derivation!,
        blockNumber,
      },
    });
    expect(isObservationEligible(invalid, ANCHOR)).toBe(false);
  });

  test("rejects observations missing blockHash", () => {
    const missing = observation(100, "finalized", {
      derivation: {
        ...observation(100, "finalized").derivation!,
        blockHash: undefined,
      },
    });
    expect(isObservationEligible(missing, ANCHOR)).toBe(false);
  });

  test("rejects invalid close anchor hash shape", () => {
    expect(isValidCloseAnchor({
      chain: "eip155:84532",
      blockNumber: 1,
      blockHash: "not-a-hash",
    })).toBe(false);
  });
});

describe("deriveEligibleObservations", () => {
  test("drops reorg-orphaned facts via canonical selection", () => {
    const orphanHash = "0x1010101010101010101010101010101010101010101010101010101010101010";
    const kept = observation(100, "finalized", { id: "kept" });
    const orphan = observation(101, "finalized", {
      id: "orphan",
      derivation: {
        ...observation(101, "finalized").derivation!,
        blockHash: orphanHash,
      },
    });
    const selected = selectCanonicalMarketplaceObservations(
      [kept, orphan],
      new Set([orphanHash]),
    );
    expect(selected.map((item) => item.id)).toEqual(["kept"]);
  });
});

describe("projectorInputScope authority path", () => {
  test("decode/reduce/select surfaces gate hostile finality and late facts", async () => {
    const fixture = loadProjectorFixture("revised-task-created");
    const events = enrichedEvents(fixture);
    const { observations } = reduceMarketplaceProjection(
      events,
      createMarketplaceProjectionState(),
    );
    expect(observations.length).toBeGreaterThan(0);

    const eligible = deriveEligibleObservations(events, {
      ...ANCHOR,
      blockNumber: 100,
      blockHash: "0x6666666666666666666666666666666666666666666666666666666666666666",
    });
    expect(eligible.length).toBeGreaterThan(0);

    const safeEvents = enrichedEvents({
      logs: (fixture.logs as FixtureLog[]).map((log) => ({
        ...log,
        finalityTier: "safe" as const,
      })),
    });
    const safeEligible = deriveEligibleObservations(safeEvents, {
      ...ANCHOR,
      blockNumber: 100,
      blockHash: "0x6666666666666666666666666666666666666666666666666666666666666666",
    });
    expect(safeEligible).toEqual([]);

    const lateEligible = deriveEligibleObservations(events, {
      ...ANCHOR,
      blockNumber: 1,
      blockHash: "0x1111111111111111111111111111111111111111111111111111111111111111",
    });
    expect(lateEligible).toEqual([]);
  });

  test("authorized candidate with real sealed Submission bytes passes through scope", async () => {
    const sealed = buildSealedSubmission({});
    const fixture = loadProjectorFixture("revised-task-created");
    const events = enrichedEvents(fixture, `0x${sealed.digest.slice("sha256:".length)}`);
    const closeAnchor = {
      chain: "eip155:84532",
      blockNumber: 100,
      blockHash: "0x6666666666666666666666666666666666666666666666666666666666666666",
    };
    const projection = projectionWithAttemptLineage(events, closeAnchor);
    expect(projection.observations.length).toBeGreaterThan(0);

    const scope = projectorInputScope({
      eventsThroughAnchor: () => [...events, ...projection.events.slice(events.length)],
      closeAnchor,
      sealedRecordMaterial: { sealedSubmissionBytes: () => sealed.bytes },
      join: {
        cellsFromObservations() {
          return [joinCandidate(sealed)];
        },
      },
    });

    const cells = [];
    for await (const cell of scope.submissionsForRun(RUN_DIGEST)) {
      cells.push(cell);
    }
    expect(cells).toHaveLength(1);
    expect(cells[0]?.submissionDigest).toBe(sealed.digest);
    expect(cells[0]?.submissionBytes).toEqual(sealed.bytes);
    expect(cells[0]?.attempt).toBeDefined();

    const direct = await authorizeCellFromProjection({
      runDigest: RUN_DIGEST,
      candidate: joinCandidate(sealed),
      projection,
      material: { sealedSubmissionBytes: () => sealed.bytes },
    });
    expect(direct?.submissionDigest).toBe(sealed.digest);
  });

  test("malicious join cannot smuggle cells from raw events when only observations are in scope", async () => {
    const fixture = loadProjectorFixture("revised-task-created");
    const sealed = buildSealedSubmission({});
    const events = enrichedEvents(fixture, `0x${sealed.digest.slice("sha256:".length)}`);
    const safeEvents = enrichedEvents({
      logs: (fixture.logs as FixtureLog[]).map((log) => ({
        ...log,
        finalityTier: "safe" as const,
        blockNumber: "999",
      })),
    });
    const allEvents = [...events, ...safeEvents];
    const closeAnchor = {
      chain: "eip155:84532",
      blockNumber: 100,
      blockHash: "0x6666666666666666666666666666666666666666666666666666666666666666",
    };
    const projection = projectionWithAttemptLineage(events, closeAnchor);

    const scope = projectorInputScope({
      eventsThroughAnchor: () => [...allEvents, ...projection.events.slice(events.length)],
      closeAnchor,
      sealedRecordMaterial: { sealedSubmissionBytes: () => sealed.bytes },
      join: {
        cellsFromObservations({ observations: eligibleOnly }) {
          expect(eligibleOnly.length).toBe(projection.observations.length);
          return [
            joinCandidate(sealed),
            {
              cellKey: `${"b".repeat(64)}/armZ/9`,
              armId: "armZ",
              replicate: 9,
              taskDigest: "b".repeat(64),
              dispatches: 1,
            },
          ];
        },
      },
    });

    const cells = [];
    for await (const cell of scope.submissionsForRun(RUN_DIGEST)) {
      cells.push(cell);
    }
    expect(cells).toHaveLength(1);
    expect(cells[0]?.cellKey).toBe(CELL_KEY);
  });

  test("cannot bypass projector authority with arbitrary host-invented cells", async () => {
    const scope = projectorInputScope({
      eventsThroughAnchor: () => [],
      closeAnchor: ANCHOR,
      join: {
        cellsFromObservations() {
          return [{
            cellKey: CELL_KEY,
            armId: "armA",
            replicate: 1,
            taskDigest: TASK_DIGEST,
            dispatches: 1,
          }];
        },
      },
    });
    const cells = [];
    for await (const cell of scope.submissionsForRun(RUN_DIGEST)) {
      cells.push(cell);
    }
    expect(cells).toEqual([]);
  });

  test.each([
    ["run", { extensionOverrides: { run: `sha256:${"b".repeat(64)}` } }],
    ["cellKey", { extensionOverrides: { cellKey: `${TASK_DIGEST}/armB/1` } }],
    ["armId", { extensionOverrides: { armId: "armB" } }],
    ["replicate", { candidateOverrides: { replicate: 2 } }],
    ["dispatch", { dispatch: 2, candidateDispatches: 1 }],
  ] as const)("rejects substituted %s dimension", async (_label, mutation) => {
    const sealed = buildSealedSubmission({
      dispatch: "dispatch" in mutation ? mutation.dispatch : 1,
      extensionOverrides: "extensionOverrides" in mutation ? mutation.extensionOverrides : undefined,
    });
    const fixture = loadProjectorFixture("revised-task-created");
    const events = enrichedEvents(fixture, `0x${sealed.digest.slice("sha256:".length)}`);
    const closeAnchor = {
      chain: "eip155:84532",
      blockNumber: 100,
      blockHash: "0x6666666666666666666666666666666666666666666666666666666666666666",
    };
    const projection = projectionWithAttemptLineage(events, closeAnchor);
    const candidate = {
      ...joinCandidate(sealed, "dispatch" in mutation ? mutation.candidateDispatches ?? mutation.dispatch : undefined),
      ...("candidateOverrides" in mutation ? mutation.candidateOverrides : {}),
    };

    const scope = projectorInputScope({
      eventsThroughAnchor: () => [...events, ...projection.events.slice(events.length)],
      closeAnchor,
      sealedRecordMaterial: { sealedSubmissionBytes: () => sealed.bytes },
      join: { cellsFromObservations: () => [candidate] },
    });
    const cells = [];
    for await (const item of scope.submissionsForRun(RUN_DIGEST)) {
      cells.push(item);
    }
    expect(cells).toEqual([]);

    const direct = await authorizeCellFromProjection({
      runDigest: RUN_DIGEST,
      candidate,
      projection,
      material: { sealedSubmissionBytes: () => sealed.bytes },
    });
    expect(direct).toBeUndefined();
  });

  test("rejects substituted-run extension even when host join omits its own guard", async () => {
    const sealed = buildSealedSubmission({
      extensionOverrides: { run: `sha256:${"b".repeat(64)}` },
    });
    const fixture = loadProjectorFixture("revised-task-created");
    const events = enrichedEvents(fixture, `0x${sealed.digest.slice("sha256:".length)}`);
    const closeAnchor = {
      chain: "eip155:84532",
      blockNumber: 100,
      blockHash: "0x6666666666666666666666666666666666666666666666666666666666666666",
    };
    const { observations } = deriveEligibleProjection(events, closeAnchor);

    const scope = projectorInputScope({
      eventsThroughAnchor: () => events,
      closeAnchor,
      join: {
        cellsFromObservations({ runDigest }) {
          void runDigest;
          return [joinCandidate(sealed)];
        },
      },
      sealedRecordMaterial: { sealedSubmissionBytes: () => sealed.bytes },
    });
    const cells = [];
    for await (const cell of scope.submissionsForRun(RUN_DIGEST)) {
      cells.push(cell);
    }
    expect(cells).toEqual([]);
  });

  test("material port supplies bytes when join omits submissionBytes", async () => {
    const sealed = buildSealedSubmission({});
    const fixture = loadProjectorFixture("revised-task-created");
    const events = enrichedEvents(fixture, `0x${sealed.digest.slice("sha256:".length)}`);
    const closeAnchor = {
      chain: "eip155:84532",
      blockNumber: 100,
      blockHash: "0x6666666666666666666666666666666666666666666666666666666666666666",
    };

    const scope = projectorInputScope({
      eventsThroughAnchor: () => {
        const projection = projectionWithAttemptLineage(events, closeAnchor);
        return [...events, ...projection.events.slice(events.length)];
      },
      closeAnchor,
      sealedRecordMaterial: {
        sealedSubmissionBytes() {
          return sealed.bytes;
        },
      },
      join: { cellsFromObservations: () => [joinCandidate(sealed)] },
    });

    const cells = [];
    for await (const cell of scope.submissionsForRun(RUN_DIGEST)) {
      cells.push(cell);
    }
    expect(cells).toHaveLength(1);
    expect(cells[0]?.submissionDigest).toBe(sealed.digest);
  });

  test("rejects non-canonical pretty-printed submission bytes", () => {
    const sealed = buildSealedSubmission({});
    const parsed = JSON.parse(new TextDecoder().decode(sealed.bytes));
    const pretty = new TextEncoder().encode(`${JSON.stringify(parsed, null, 2)}\n`);
    const validation = validateSubmission(parsed);
    expect(bytesMatchCanonicalSeal(pretty, parsed, sealSubmission, validation)).toBe(false);
    expect(decodeUtf8Json(new Uint8Array([0xff, 0xfe, 0x00]))).toBeUndefined();
  });
});
