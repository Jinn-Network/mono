import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  cellIdempotencyKey,
  cellKey,
  documentDigest,
  parseBenchmark,
  parseRun,
  sealBenchmark,
  sealRun,
  submissionExtensionBlock,
  type BenchmarkRecord,
  type RunRecord,
} from "@jinn-network/benchmarking-records";
import {
  BASE_SEPOLIA_TODAY,
  createInMemoryPostingIntentStore,
  createInMemoryMarketplaceObserveStore,
  deriveMarketplaceAttemptUri,
  encodeRevisedRequestData,
  makeMarketplaceBackend,
  type MarketplaceRequesterBackend,
} from "@jinn-network/marketplace-binding";
import {
  REVISED_PROJECTOR_EVENTS_ABI,
  REVISED_MECH_DELIVER_ABI,
  createMarketplaceProjectionState,
  decodeMarketplaceLogs,
  marketplaceEventOriginAuthority,
  reduceMarketplaceProjection,
  type MarketplaceRawLog,
  type ObservationMarketplaceEvent,
} from "@jinn-network/marketplace-projector";
import { sealDelivery, sealSubmission, sealTask } from "@jinn-network/task-execution-protocol";
import type { TaskExecutionBackend } from "@jinn-network/task-execution-backend";
import {
  encodeAbiParameters,
  encodeEventTopics,
  keccak256,
  toBytes,
  type AbiEvent,
  type Address,
  type Hex,
} from "viem";
import { describe, expect, test, vi } from "vitest";
import {
  BENCHMARKING_CELL_EXTENSION,
  type ProjectorCellJoinCandidate,
} from "./cell-authority.js";
import {
  AnchoredOrderingViolationError,
  MarketplaceCompositionValidationError,
  runOnMarketplace,
  validateMarketplaceComposition,
} from "./venue.js";

const TASK_DIGEST = "f2fcac284b66b5ed9d0567dea00ca3a75ac5a9fd570c1909851d1512393ce741";
const RUN_OWNER = "urn:uuid:20000000-0000-5000-8000-000000000002";
const COORDINATOR = BASE_SEPOLIA_TODAY.taskCoordinator;
const MECH = BASE_SEPOLIA_TODAY.mechMarketplace;
const CLOSE_AT = "2099-01-01T00:00:00Z";
const BENCHMARKING_PROTOCOL = "https://jinn.network/protocols/benchmarking/1.0";

function singleCellBench(): { bench: BenchmarkRecord; benchDigest: `sha256:${string}` } {
  const sealed = sealBenchmark({
    protocol: BENCHMARKING_PROTOCOL,
    name: "venue composition probe",
    description: "single-cell marketplace composition fixture",
    author: "urn:uuid:10000000-0000-5000-8000-000000000001",
    version: "1.0.0",
    items: [{ task: { digest: { sha256: TASK_DIGEST } } }],
    reveal: { policy: "immediate" },
  });
  return { bench: parseBenchmark(sealed.bytes), benchDigest: sealed.digest };
}

function openCompetitionRun(benchDigest: `sha256:${string}`): RunRecord {
  return parseRun(sealRun({
    protocol: BENCHMARKING_PROTOCOL,
    benchmark: { digest: { sha256: benchDigest.slice("sha256:".length) } },
    owner: RUN_OWNER,
    arms: [{
      armId: "armA",
      pinning: {
        harness: { id: "kit", version: "1" },
        model: { id: "model-a" },
      },
    }],
    replicates: 1,
    policy: {
      completenessFloor: "1",
      cellWindow: 3_600_000,
      replacement: { allowed: false },
      independence: "gating",
      evaluation: { minVerdicts: 1, distinctEvaluator: true },
      submissionBaseline: { isolationPolicy: "fixture" },
    },
    venue: { kind: "open-competition" },
    budget: {
      perCell: { solve: "10", evaluate: "5" },
      hardCap: "100",
      unit: "wei",
    },
    closeAt: CLOSE_AT,
  }).bytes);
}

async function loadMiniatureTask(): Promise<Uint8Array> {
  const tasks = JSON.parse(
    await readFile(
      fileURLToPath(new URL("../../testing/fixtures/miniature-run/tasks.json", import.meta.url)),
      "utf8",
    ),
  ) as { digest: string; record: unknown }[];
  const task = tasks.find((entry) => entry.digest.includes(TASK_DIGEST));
  if (task === undefined) throw new Error("miniature task not found");
  return sealTask(task.record);
}

function makeBackend(): MarketplaceRequesterBackend {
  let nextTaskId = 1n;
  return makeMarketplaceBackend(BASE_SEPOLIA_TODAY, {
    creatorSafe: "0x8a34793e10595c89B7e41Cc7Ff0F76850F44AD98",
    terms: {
      solutionMaxDeliveryRateWei: 10n,
      verdictMaxDeliveryRateWei: 5n,
      responseTimeoutSeconds: 3600n,
      allowSolverSelfEvaluation: false,
    },
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
  });
}

function marketplaceWaitPort(backend: MarketplaceRequesterBackend) {
  return {
    async waitUntilTerminal({ attempt }: { attempt: string }) {
      const snap = await backend.observe(attempt as never);
      if (snap.descriptor.derived.terminal) return snap;
      const engaged = snap.observations.find(
        (observation) => observation.type === "network.jinn.task-execution.attempt-engaged.v1",
      );
      if (engaged === undefined) throw new Error("missing attempt-engaged");
      await backend.drive(attempt as never, [{
        specversion: "1.0",
        id: `terminal-${attempt}`,
        source: engaged.source,
        subject: attempt,
        time: new Date().toISOString(),
        datacontenttype: "application/json",
        sequence: "0000000000000100",
        type: "network.jinn.task-execution.attempt-terminal.v1",
        data: { state: "delivered" },
      }]);
      return backend.observe(attempt as never);
    },
  };
}

function closePorts() {
  return {
    blocks: {
      async firstFinalizedAtOrAfter() {
        return {
          chain: "eip155:84532",
          blockNumber: 110,
          blockHash: "0x1515151515151515151515151515151515151515151515151515151515151515",
          timestamp: "2026-08-04T00:00:01Z",
        };
      },
    },
  };
}

function buildSealedSubmission(runDigest: `sha256:${string}`, dispatch = 1) {
  const key = cellKey(TASK_DIGEST, "armA", 1);
  const doc = {
    protocol: "https://jinn.network/profiles/task-execution/1.0",
    submission: "urn:uuid:11111111-1111-4111-8111-111111111111",
    task: { digest: { sha256: TASK_DIGEST } },
    requester: RUN_OWNER,
    nonce: "venue-test-nonce",
    idempotencyKey: cellIdempotencyKey(runDigest, key, dispatch),
    deadline: CLOSE_AT,
    requirements: { isolationPolicy: "fixture" },
    [BENCHMARKING_CELL_EXTENSION]: submissionExtensionBlock(runDigest, key, "armA"),
  };
  const bytes = sealSubmission(doc);
  return { bytes, digest: documentDigest(bytes), key, dispatch, doc };
}

function abiEvent(name: string): AbiEvent {
  const event = [...REVISED_PROJECTOR_EVENTS_ABI, ...REVISED_MECH_DELIVER_ABI].find((item) => item.name === name);
  if (event === undefined) throw new Error(`unknown event ${name}`);
  return event as AbiEvent;
}

function digestToBytes32(digest: `sha256:${string}`): Hex {
  return `0x${digest.slice("sha256:".length)}`;
}

function rawLog(input: {
  event: string;
  blockNumber: number;
  blockHash: Hex;
  txHash: Hex;
  logIndex: number;
  finalityTier: "safe" | "finalized";
  args: Record<string, string | boolean>;
}): MarketplaceRawLog {
  const event = abiEvent(input.event);
  const args = Object.fromEntries(
    event.inputs.map((field) => {
      const name = field.name ?? "";
      const value = input.args[name];
      if (value === undefined) throw new Error(`missing arg ${name}`);
      if (field.type.startsWith("uint") || field.type.startsWith("int")) {
        return [name, BigInt(String(value))];
      }
      return [name, value];
    }),
  );
  const unindexed = event.inputs.filter((field) => field.indexed !== true);
  const data = encodeAbiParameters(
    unindexed.map((field) => ({ name: field.name, type: field.type })),
    unindexed.map((field) => args[field.name!]),
  );
  return {
    chainId: 84532,
    address: input.event === "Deliver" ? MECH : COORDINATOR,
    blockNumber: BigInt(input.blockNumber),
    blockHash: input.blockHash,
    transactionHash: input.txHash,
    logIndex: input.logIndex,
    finalityTier: input.finalityTier,
    topics: encodeEventTopics({
      abi: [event],
      eventName: input.event,
      args,
    }) as readonly Hex[],
    data,
  };
}

function decodePipelineLogs(
  logs: MarketplaceRawLog[],
  projectionByIndex: ObservationMarketplaceEvent["projection"][],
): ObservationMarketplaceEvent[] {
  const authority = marketplaceEventOriginAuthority({
    ...BASE_SEPOLIA_TODAY,
    generation: "revised",
    jinnRouter: COORDINATOR,
    taskCoordinator: COORDINATOR,
    mechMarketplace: MECH,
  }, (address) => address.toLowerCase() === MECH.toLowerCase());
  const decoded = decodeMarketplaceLogs(logs, authority);
  return decoded.map((event, index) => ({
    ...event,
    projection: projectionByIndex[index]!,
  })) as ObservationMarketplaceEvent[];
}

describe("validateMarketplaceComposition", () => {
  test("rejects self-run venue", () => {
    const { bench, benchDigest } = singleCellBench();
    const run = openCompetitionRun(benchDigest);
    run.venue = { kind: "self-run" };
    expect(() => validateMarketplaceComposition(bench, run)).toThrow(MarketplaceCompositionValidationError);
  });

  test("rejects hardCap below minimum", () => {
    const { bench, benchDigest } = singleCellBench();
    const run = openCompetitionRun(benchDigest);
    run.budget!.hardCap = "1";
    expect(() => validateMarketplaceComposition(bench, run)).toThrow(MarketplaceCompositionValidationError);
  });
});

describe("runOnMarketplace", () => {
  test("failed validation has zero backend submit side effects", async () => {
    const backend = makeBackend();
    const submit = vi.spyOn(backend, "submit");
    const { bench, benchDigest } = singleCellBench();
    const run = openCompetitionRun(benchDigest);
    run.venue = { kind: "self-run" };
    await expect(runOnMarketplace(bench, run, backend, {
      runDigest: sealRun(run).digest,
      closeBoundary: closePorts(),
      projector: {
        eventsThroughAnchor: () => [],
        generation: "revised",
        join: { cellsFromObservations: () => [] },
      },
      trust: { async resolveAgent() { return "unresolved"; } },
      taskBytesFor: async () => loadMiniatureTask(),
      waitForTerminal: marketplaceWaitPort(backend),
      clock: { now: () => new Date("2026-01-01T00:00:00Z") },
    })).rejects.toThrow(MarketplaceCompositionValidationError);
    expect(submit).not.toHaveBeenCalled();
  });

  test("uses a concrete requester backend through the two-argument TaskExecutionBackend seam", async () => {
    const backend = makeBackend();
    const executionBackend: TaskExecutionBackend = backend;
    const submit = vi.spyOn(backend, "submit");
    const { bench, benchDigest } = singleCellBench();
    const run = openCompetitionRun(benchDigest);
    const runDigest = sealRun(run).digest;
    const taskBytes = await loadMiniatureTask();
    const sealed = buildSealedSubmission(runDigest);
    const taskId = 1n;
    const requestId = `0x${"4".repeat(64)}` as const;
    const attempt = deriveMarketplaceAttemptUri({
      chainId: 84532,
      coordinator: COORDINATOR,
      taskId,
      attemptIndex: 0,
    });
    const deliveryDoc = {
      protocol: "https://jinn.network/profiles/task-execution/1.0",
      task: `sha256:${TASK_DIGEST}`,
      attempt,
      outcome: "fulfilled",
      outputs: [{ name: "answer", mediaType: "text/plain", digest: { sha256: keccak256(toBytes("answer")).slice(2) } }],
      createdAt: "2026-08-03T12:00:00Z",
    };
    const deliveryBytes = sealDelivery(deliveryDoc);
    const deliveryDigest = documentDigest(deliveryBytes);

    const projectionContext = {
      timestamp: "2026-08-03T09:00:00Z",
      submission: sealed.doc.submission as `urn:uuid:${string}`,
      taskDigest: `sha256:${TASK_DIGEST}` as const,
      effectiveDeadline: CLOSE_AT,
      dispatchContext: {
        uri: "urn:jinn:marketplace:dispatch-context:1:0",
        digest: { sha256: "8888888888888888888888888888888888888888888888888888888888888888" },
      },
    };
    const logs = [
      rawLog({
        event: "TaskCreated",
        blockNumber: 100,
        blockHash: "0x6666666666666666666666666666666666666666666666666666666666666666",
        txHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        logIndex: 0,
        finalityTier: "finalized",
        args: {
          creator: "0x3333333333333333333333333333333333333333",
          taskCidDigest: digestToBytes32(documentDigest(taskBytes)),
          submissionDigest: digestToBytes32(sealed.digest),
          taskId: "1",
          maxTotal: "1",
          maxConcurrent: "1",
          submissionDeadline: "4102444800",
          closeAt: "4102444800",
          responseTimeout: "3600",
          minVerdicts: "1",
          requireDistinctEvaluator: false,
          solutionMaxDeliveryRate: "10",
          verdictMaxDeliveryRate: "5",
          solutionBudget: "100",
          verdictBudget: "50",
        },
      }),
      rawLog({
        event: "TaskAttemptCreated",
        blockNumber: 101,
        blockHash: "0x7777777777777777777777777777777777777777777777777777777777777777",
        txHash: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        logIndex: 0,
        finalityTier: "finalized",
        args: {
          operator: "0x3333333333333333333333333333333333333333",
          priorityMech: MECH,
          taskId: "1",
          attemptIndex: "0",
          attemptDeadline: "4102444800",
          deliveryRate: "10",
        },
      }),
      rawLog({
        event: "SolutionDeliveryPrepared",
        blockNumber: 102,
        blockHash: "0x8888888888888888888888888888888888888888888888888888888888888888",
        txHash: "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
        logIndex: 0,
        finalityTier: "finalized",
        args: {
          operator: "0x3333333333333333333333333333333333333333",
          expectedRequestId: requestId,
          taskId: "1",
          attemptIndex: "0",
          nonce: "1",
          deliveryDigest: digestToBytes32(deliveryDigest),
        },
      }),
      rawLog({
        event: "Deliver",
        blockNumber: 102,
        blockHash: "0x8888888888888888888888888888888888888888888888888888888888888888",
        txHash: "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
        logIndex: 1,
        finalityTier: "finalized",
        args: {
          mech: MECH,
          mechServiceMultisig: "0x3333333333333333333333333333333333333333",
          requestId,
          deliveryRate: "10",
          requestData: encodeRevisedRequestData({
            legKind: 1,
            taskId: 1n,
            attemptIndex: 0,
            verdictIndex: 0,
            deliveryDigest: digestToBytes32(deliveryDigest),
            verdictCode: 0,
          }),
          deliveryData: `0x${Buffer.from(deliveryBytes).toString("hex")}`,
        },
      }),
      rawLog({
        event: "SolutionDeliveryClaimed",
        blockNumber: 102,
        blockHash: "0x8888888888888888888888888888888888888888888888888888888888888888",
        txHash: "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
        logIndex: 2,
        finalityTier: "finalized",
        args: {
          operator: "0x3333333333333333333333333333333333333333",
          requestId,
          deliveryDigest: digestToBytes32(deliveryDigest),
          taskId: "1",
          attemptIndex: "0",
        },
      }),
    ];
    const timestamps = [
      "2026-08-03T09:00:00Z",
      "2026-08-03T09:00:01Z",
      "2026-08-03T09:00:02Z",
      "2026-08-03T09:00:02Z",
      "2026-08-03T09:00:02Z",
    ];
    const enriched = decodePipelineLogs(
      logs,
      timestamps.map((timestamp, index) => ({
        ...projectionContext,
        timestamp,
        taskCoordinator: COORDINATOR,
        ...(index >= 3
          ? {
            deliveryCorrespondence: {
              sha256Digest: deliveryDigest,
              keccakEvidenceHash: keccak256(deliveryBytes),
              onChainSha256CidDigest: deliveryDigest,
              onChainKeccak: keccak256(deliveryBytes),
            },
          }
          : {}),
      })),
    );
    reduceMarketplaceProjection(enriched, createMarketplaceProjectionState());

    const joinCandidate: ProjectorCellJoinCandidate = {
      cellKey: sealed.key,
      armId: "armA",
      replicate: 1,
      taskDigest: TASK_DIGEST,
      dispatches: 1,
      accounted: 1,
    };

    const result = await runOnMarketplace(bench, run, executionBackend, {
      runDigest,
      closeBoundary: closePorts(),
      projector: {
        eventsThroughAnchor: () => enriched,
        generation: "revised",
        join: {
          cellsFromObservations: () => [joinCandidate],
        },
        sealedRecordMaterial: {
          sealedSubmissionBytes: () => sealed.bytes,
          sealedDeliveryBytes: () => deliveryBytes,
        },
      },
      trust: { async resolveAgent() { return "unresolved"; } },
      taskBytesFor: async () => taskBytes,
      waitForTerminal: marketplaceWaitPort(backend),
      clock: { now: () => new Date("2026-01-01T00:00:00Z") },
      acceptedSubmissions: {
        acceptedSubmissionBytes: (_digest, cell, dispatch) =>
          cell === sealed.key && dispatch === 1 ? sealed.bytes : undefined,
      },
    });

    expect(submit.mock.calls).toHaveLength(1);
    expect(submit.mock.calls[0]?.length).toBe(2);
    expect(submit.mock.calls[0]?.[2]).toBeUndefined();

    expect(result.coherentClose.boundary.at).toBe(CLOSE_AT);
    expect(result.matrix.record.closeBoundary.at).toBe(CLOSE_AT);
    expect(result.anchoredOrdering.check.ok).toBe(true);

    const cell = result.matrix.record.cells[0]!;
    expect(cell.attempt).toBe(attempt);
    expect(cell.cost).toEqual({ value: "10", unit: "wei", source: "settled" });
    expect(cell.verification.harness).toBe("unverifiable");
    expect(cell.integrityTier).toBe("attested-only");
  });

  test("hostile safe-tier decoded logs refuse Matrix via ordering/authority gate", async () => {
    const backend = makeBackend();
    const { bench, benchDigest } = singleCellBench();
    const run = openCompetitionRun(benchDigest);
    const runDigest = sealRun(run).digest;
    const sealed = buildSealedSubmission(runDigest);
    const safeLogs = decodePipelineLogs(
      [rawLog({
        event: "TaskCreated",
        blockNumber: 100,
        blockHash: "0x6666666666666666666666666666666666666666666666666666666666666666",
        txHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        logIndex: 0,
        finalityTier: "safe",
        args: {
          creator: "0x3333333333333333333333333333333333333333",
          taskCidDigest: digestToBytes32(documentDigest(await loadMiniatureTask())),
          submissionDigest: digestToBytes32(sealed.digest),
          taskId: "1",
          maxTotal: "1",
          maxConcurrent: "1",
          submissionDeadline: "4102444800",
          closeAt: "4102444800",
          responseTimeout: "3600",
          minVerdicts: "1",
          requireDistinctEvaluator: false,
          solutionMaxDeliveryRate: "10",
          verdictMaxDeliveryRate: "5",
          solutionBudget: "100",
          verdictBudget: "50",
        },
      })],
      [{
        timestamp: "2026-08-03T09:00:00Z",
        submission: sealed.doc.submission as `urn:uuid:${string}`,
        taskDigest: `sha256:${TASK_DIGEST}` as const,
        effectiveDeadline: CLOSE_AT,
        dispatchContext: {
          uri: "urn:uuid:dispatch",
          digest: { sha256: "8888888888888888888888888888888888888888888888888888888888888888" },
        },
        taskCoordinator: COORDINATOR,
      }],
    );

    await expect(runOnMarketplace(bench, run, backend, {
      runDigest,
      closeBoundary: closePorts(),
      projector: {
        eventsThroughAnchor: () => safeLogs,
        generation: "revised",
        join: { cellsFromObservations: () => [] },
        sealedRecordMaterial: { sealedSubmissionBytes: () => sealed.bytes },
      },
      trust: { async resolveAgent() { return "unresolved"; } },
      taskBytesFor: async () => loadMiniatureTask(),
      waitForTerminal: marketplaceWaitPort(backend),
      clock: { now: () => new Date("2026-01-01T00:00:00Z") },
      acceptedSubmissions: {
        acceptedSubmissionBytes: () => sealed.bytes,
      },
    })).rejects.toThrow(AnchoredOrderingViolationError);
  });
});

describe("runOnMarketplace lifecycle", () => {
  test("resolves close anchor only after launch completes", async () => {
    const backend = makeBackend();
    const { bench, benchDigest } = singleCellBench();
    const run = openCompetitionRun(benchDigest);
    const runDigest = sealRun(run).digest;
    const sealed = buildSealedSubmission(runDigest);
    const order: string[] = [];
    const { projection, material } = {
      projection: {
        observations: [],
        events: [],
        state: createMarketplaceProjectionState(),
      },
      material: { sealedSubmissionBytes: () => sealed.bytes },
    };

    await expect(runOnMarketplace(bench, run, backend, {
      runDigest,
      closeBoundary: {
        blocks: {
          async firstFinalizedAtOrAfter() {
            order.push("close-anchor");
            return {
              chain: "eip155:84532",
              blockNumber: 110,
              blockHash: "0x1515151515151515151515151515151515151515151515151515151515151515",
              timestamp: "2026-08-04T00:00:01Z",
            };
          },
        },
      },
      projector: {
        eventsThroughAnchor: () => {
          order.push("events");
          return [];
        },
        generation: "revised",
        join: { cellsFromObservations: () => [] },
        sealedRecordMaterial: material,
      },
      trust: { async resolveAgent() { return "unresolved"; } },
      taskBytesFor: async () => loadMiniatureTask(),
      waitForTerminal: marketplaceWaitPort(backend),
      clock: { now: () => new Date("2026-01-01T00:00:00Z") },
      acceptedSubmissions: {
        acceptedSubmissionBytes: () => sealed.bytes,
      },
    })).rejects.toThrow(AnchoredOrderingViolationError);

    expect(order.indexOf("close-anchor")).toBeGreaterThan(-1);
    expect(order.indexOf("events")).toBeGreaterThan(order.indexOf("close-anchor"));
    void projection;
  });
});
