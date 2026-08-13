import {
  DISCOVERY_SIGNING_SCOPE,
  MEDIA_ENTRY,
  RECORD_KINDS,
  dssePreAuthEncoding,
  sealJson,
  type FactsRecompute,
} from "@jinn-network/record-discovery-protocol";
import { documentDigest } from "@jinn-network/task-execution-protocol";
import type { BlobStore, DsseSigner } from "@jinn-network/record-discovery-serve";
import type { Address, Hex } from "viem";
import { describe, expect, test } from "vitest";
import type { DerivationAnnotation } from "./derivation.js";
import type { MarketplaceEvent } from "./events.js";
import {
  projectAnnouncements,
  type AnnouncementProjectionPorts,
  type ScopedDiscoverySigner,
} from "./announce.js";
import type {
  MarketplaceProjectionState,
  ObservationMarketplaceEvent,
  ObservationProjectionContext,
} from "./observe.js";
import {
  createMarketplaceProjectionState,
  reduceMarketplaceProjection,
} from "./observe.js";

const COORDINATOR = "0x1111111111111111111111111111111111111111" satisfies Address;
const OPERATOR = "0x2222222222222222222222222222222222222222" satisfies Address;
const CREATOR = "0x3333333333333333333333333333333333333333" satisfies Address;
const REQUEST_ID = `0x${"4".repeat(64)}` satisfies Hex;
const TASK_DIGEST = `sha256:${"7".repeat(64)}` as const;
const SUBMISSION = "urn:uuid:11111111-1111-4111-8111-111111111111" as const;
const SUBMISSION_BYTES = new TextEncoder().encode('{"record":"submission"}');
const DELIVERY_BYTES = new TextEncoder().encode('{"record":"delivery"}');
const DELIVERY_DIGEST = documentDigest(DELIVERY_BYTES);
const EVALUATION_BYTES = new TextEncoder().encode('{"record":"evaluation-delivery"}');
const CONTEXT: ObservationProjectionContext = {
  taskCoordinator: COORDINATOR,
  timestamp: "2026-07-29T12:00:00Z",
  submission: SUBMISSION,
  taskDigest: TASK_DIGEST,
  effectiveDeadline: "2026-07-30T12:00:00Z",
  dispatchContext: {
    uri: "urn:jinn:marketplace:dispatch-context:42:3",
    digest: { sha256: "8".repeat(64) },
  },
};

function derivation(
  event: string,
  logIndex: number,
  generation: "today" | "revised" = "today",
): DerivationAnnotation {
  return {
    chainId: 84532,
    contract: COORDINATOR,
    event,
    blockNumber: 100,
    blockHash: `0x${"6".repeat(64)}`,
    txHash: `0x${String(logIndex).padStart(64, "0")}`,
    logIndex,
    finalityTier: "safe",
    contractGeneration: generation,
  };
}

function projectable(
  event: MarketplaceEvent,
  projection: Partial<ObservationProjectionContext> = {},
): ObservationMarketplaceEvent {
  return {
    ...event,
    projection: { ...CONTEXT, ...projection },
  } as ObservationMarketplaceEvent;
}

function task(maxClaims = 2): ObservationMarketplaceEvent {
  return projectable({
    event: "TaskCreated",
    facts: {
      creator: CREATOR,
      taskId: 42n,
      manifestDigest: `0x${"0".repeat(64)}`,
      taskCidDigest: `0x${"7".repeat(64)}`,
      maxClaims,
      solutionBudget: 100n,
      verdictBudget: 20n,
    },
    derivation: derivation("TaskCreated", 0),
  });
}

function claim(): ObservationMarketplaceEvent {
  return projectable({
    event: "TaskAttemptCreated",
    facts: {
      taskId: 42n,
      attemptIndex: 3,
      operator: OPERATOR,
      requestId: REQUEST_ID,
      priorityMech: OPERATOR,
      deliveryRate: 10n,
    },
    derivation: derivation("TaskAttemptCreated", 1),
  });
}

function deliveryEvents(
  onChainKeccak: Hex = `0x${"b".repeat(64)}`,
): ObservationMarketplaceEvent[] {
  return [
    projectable({
      event: "Deliver",
      facts: {
        mech: OPERATOR,
        mechServiceMultisig: OPERATOR,
        requestId: REQUEST_ID,
        deliveryRate: 10n,
        data: `0x${DELIVERY_DIGEST.slice("sha256:".length)}`,
      },
      derivation: derivation("Deliver", 2),
    }, {
      deliveryCorrespondence: {
        sha256Digest: DELIVERY_DIGEST,
        keccakEvidenceHash: `0x${"b".repeat(64)}`,
        onChainSha256CidDigest: DELIVERY_DIGEST,
        onChainKeccak,
      },
    }),
    projectable({
      event: "SolutionDeliveryClaimed",
      facts: {
        operator: OPERATOR,
        requestId: REQUEST_ID,
        taskId: 42n,
        attemptIndex: 3,
      },
      derivation: derivation("SolutionDeliveryClaimed", 3),
    }),
  ];
}

function close(): ObservationMarketplaceEvent {
  return projectable({
    event: "TaskBudgetRefunded",
    facts: {
      taskId: 42n,
      creator: CREATOR,
      solutionAmount: 10n,
      verdictAmount: 20n,
    },
    derivation: derivation("TaskBudgetRefunded", 4),
  });
}

function transition(
  events: readonly ObservationMarketplaceEvent[],
  state: MarketplaceProjectionState = createMarketplaceProjectionState(),
) {
  return reduceMarketplaceProjection(events, state);
}

function makePorts() {
  const writes: Array<{ path: string; bytes: Uint8Array; contentType: string }> = [];
  const signed: Uint8Array[] = [];
  const recomputed: Uint8Array[] = [];
  const resolved: Array<{
    role: "submission" | "delivery" | "evaluation-delivery";
    material: {
      kind: string;
      bytes: Uint8Array;
      mediaType?: string;
      locations?: Array<{ profile: string; locator: string }>;
    };
  }> = [];
  const verified: Array<{
    event: Extract<ObservationMarketplaceEvent, { event: "VerdictDeliveryClaimed" }>;
    material: (typeof resolved)[number]["material"];
  }> = [];
  const store: BlobStore = {
    async put(path, bytes, contentType) {
      writes.push({ path, bytes: bytes.slice(), contentType });
    },
  };
  const signer: ScopedDiscoverySigner = {
    scope: DISCOVERY_SIGNING_SCOPE,
    async sign(pae) {
      signed.push(pae.slice());
      return [{ keyid: "key-1", sig: new Uint8Array([1, 2, 3]) }];
    },
  };
  const factsRecompute: FactsRecompute = {
    get(kind) {
      if (kind === RECORD_KINDS.submission) {
        return async (bytes) => {
          recomputed.push(bytes.slice());
          return {
            taskDigest: TASK_DIGEST,
            taskProfileUri: "https://spec.jinn.network/task-profiles/repository-work/1.0",
            requesterIri: "did:key:zRequester",
            deadline: "2026-07-30T12:00:00Z",
          };
        };
      }
      if (kind === RECORD_KINDS.delivery) {
        return async (bytes) => {
          recomputed.push(bytes.slice());
          return {
            taskDigest: TASK_DIGEST,
            attemptUri: "urn:uuid:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            outcome: "fulfilled",
          };
        };
      }
      return undefined;
    },
  };
  const ports: AnnouncementProjectionPorts = {
    source: { agent: "did:key:zProjector", name: "marketplace" },
    signer,
    store,
    clock: { now: () => new Date("2026-07-29T12:00:01Z") },
    factsRecompute,
    referencedBytes: { async fetch() { return undefined; } },
    async resolveRecord(_event, role) {
      if (role === "submission") {
        const material = {
          kind: RECORD_KINDS.submission,
          bytes: SUBMISSION_BYTES,
          mediaType: "application/vnd.jinn.task-execution.submission.v1+json",
          locations: [{
            profile: "https://spec.jinn.network/record-discovery/location/ipfs/v1",
            locator: "ipfs://submission",
          }],
        };
        resolved.push({ role, material });
        return material;
      }
      const material = {
        kind: RECORD_KINDS.delivery,
        bytes: role === "evaluation-delivery" ? EVALUATION_BYTES : DELIVERY_BYTES,
        mediaType: "application/vnd.jinn.task-execution.delivery.v1+json",
        locations: [{
          profile: "https://spec.jinn.network/record-discovery/location/ipfs/v1",
          locator: role === "evaluation-delivery" ? "ipfs://evaluation" : "ipfs://delivery",
        }],
      };
      resolved.push({ role, material });
      return material;
    },
    async verifyVerdictObservation(event, material) {
      verified.push({ event, material });
      const statementVerdict = event.facts.verdictCode === 1
        ? "pass"
        : event.facts.verdictCode === 2
        ? "fail"
        : event.facts.verdictCode === 4
        ? "inconclusive"
        : undefined;
      return {
        gate: { decisionGrade: true, failures: [] },
        ...(statementVerdict === undefined ? {} : { statementVerdict }),
      };
    },
  };
  return { ports, writes, signed, recomputed, resolved, verified };
}

describe("projectAnnouncements", () => {
  test("publishes exact available/withdrawn actions, recomputing record facts from bytes and skipping claims", async () => {
    const { ports, writes, signed, recomputed } = makePorts();
    const events = [task(), claim(), ...deliveryEvents(), close()];
    const result = await projectAnnouncements(transition(events), ports);

    expect(result.announcements.map(({ action }) => action)).toEqual([
      "available",
      "available",
      "withdrawn",
    ]);
    expect(result.announcements[0]).toMatchObject({
      action: "available",
      record: {
        kind: RECORD_KINDS.submission,
        mediaType: "application/vnd.jinn.task-execution.submission.v1+json",
      },
      facts: {
        taskDigest: TASK_DIGEST,
        taskProfileUri: "https://spec.jinn.network/task-profiles/repository-work/1.0",
        requesterIri: "did:key:zRequester",
        deadline: "2026-07-30T12:00:00Z",
        terms: {
          contractGeneration: "today",
          maxTotal: "2",
          solutionBudgetWei: "100",
          verdictBudgetWei: "20",
        },
      },
      derivation: expect.objectContaining({ event: "TaskCreated" }),
    });
    expect(result.announcements[1]).toMatchObject({
      action: "available",
      record: { kind: RECORD_KINDS.delivery },
      facts: {
        taskDigest: TASK_DIGEST,
        attemptUri: "urn:uuid:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        outcome: "fulfilled",
      },
      derivation: expect.objectContaining({ event: "SolutionDeliveryClaimed" }),
    });
    expect(result.announcements[2]).toMatchObject({
      action: "withdrawn",
      retracts: result.announcements[0]!.announcementId,
      reason: "delisted",
      derivation: expect.objectContaining({ event: "TaskBudgetRefunded" }),
    });
    expect(recomputed).toEqual([SUBMISSION_BYTES, DELIVERY_BYTES]);
    expect(result.entries).toHaveLength(3);
    expect(result.entries[0]!.entry.previous).toBeNull();
    expect(result.entries[1]!.entry.previous).toBe(
      sealJson(result.entries[0]!.entry).digest,
    );
    expect(result.entries[2]!.entry.previous).toBe(
      sealJson(result.entries[1]!.entry).digest,
    );
    expect(result.entries.every(({ signature }) => signature?.payloadType === MEDIA_ENTRY)).toBe(true);
    expect(signed).toContainEqual(
      dssePreAuthEncoding(MEDIA_ENTRY, sealJson(result.entries[0]!.entry).bytes),
    );
    expect(ports.signer.scope).toBe("jinn:discovery-announcements");
    expect(DISCOVERY_SIGNING_SCOPE).toBe("jinn:discovery-announcements");
    expect(writes.some(({ path }) => path.startsWith("/records/"))).toBe(true);
    expect(result.head?.sequence).toBe("0000000000000003");
  });

  test("refuses to publish a Delivery announcement when the mandatory today digest join diverges", async () => {
    const { ports } = makePorts();
    const result = await projectAnnouncements(
      transition([
        task(),
        claim(),
        ...deliveryEvents(`0x${"c".repeat(64)}`),
      ]),
      ports,
    );
    expect(
      result.announcements.filter((announcement) =>
        announcement.action === "available"
        && announcement.record.kind === RECORD_KINDS.delivery
      ),
    ).toEqual([]);
  });

  test("refuses swapped revised Submission material before facts, storage, signing, or archive writes", async () => {
    const { ports, writes, signed, recomputed } = makePorts();
    const revisedTask = projectable({
      event: "TaskCreated",
      facts: {
        creator: CREATOR,
        taskCidDigest: `0x${"7".repeat(64)}`,
        submissionDigest: `0x${"d".repeat(64)}`,
        taskId: 42n, maxTotal: 1, maxConcurrent: 1,
        submissionDeadline: 1_800_000_000n, closeAt: 0n, responseTimeout: 3600n,
        minVerdicts: 1, requireDistinctEvaluator: true,
        solutionMaxDeliveryRate: 10n, verdictMaxDeliveryRate: 20n,
        solutionBudget: 100n, verdictBudget: 20n,
      },
      derivation: derivation("TaskCreated", 30, "revised"),
    });
    const result = await projectAnnouncements(transition([revisedTask]), ports);

    expect(result.announcements).toEqual([]);
    expect(result.refusals).toEqual([{
      kind: "announcement-material-refused",
      role: "submission",
      expectedDigest: `sha256:${"d".repeat(64)}`,
      actualDigest: documentDigest(SUBMISSION_BYTES),
      derivation: revisedTask.derivation,
    }]);
    expect(recomputed).toEqual([]);
    expect(writes).toEqual([]);
    expect(signed).toEqual([]);
  });

  test.each(["solution", "evaluation"] as const)(
    "refuses swapped revised %s Delivery material before downstream effects",
    async (leg) => {
      const { ports, writes, signed, recomputed, verified } = makePorts();
      const event = leg === "solution"
        ? projectable({
            event: "SolutionDeliveryClaimed",
            facts: { operator: OPERATOR, requestId: REQUEST_ID, deliveryDigest: `0x${"d".repeat(64)}`, taskId: 42n, attemptIndex: 3 },
            derivation: derivation("SolutionDeliveryClaimed", 31, "revised"),
          })
        : projectable({
            event: "VerdictDeliveryClaimed",
            facts: { evaluator: OPERATOR, requestId: REQUEST_ID, evaluationDeliveryDigest: `0x${"e".repeat(64)}`, taskId: 42n, attemptIndex: 3, verdictIndex: 1, verdictCode: 1 },
            derivation: derivation("VerdictDeliveryClaimed", 32, "revised"),
          });
      const type = leg === "solution"
        ? "network.jinn.task-execution.delivery-recorded.v1"
        : "network.jinn.task-execution.attempt-terminal.v1";
      const synthetic = {
        ...transition([]),
        events: [event],
        observations: [{
          id: `${event.derivation.txHash}:${event.derivation.logIndex}:${type}`,
          data: leg === "solution" ? { digest: `sha256:${"d".repeat(64)}` } : { state: "delivered" },
        }],
      } as unknown as ReturnType<typeof transition>;
      const result = await projectAnnouncements(synthetic, ports);

      const expectedDigest = `sha256:${leg === "solution" ? "d".repeat(64) : "e".repeat(64)}`;
      expect(result.refusals).toMatchObject([{
        kind: "announcement-material-refused",
        role: leg === "solution" ? "delivery" : "evaluation-delivery",
        expectedDigest,
        derivation: event.derivation,
      }]);
      expect(recomputed).toEqual([]);
      expect(writes).toEqual([]);
      expect(signed).toEqual([]);
      expect(verified).toEqual([]);
    },
  );

  test("claim emits no announcement, while exhaustion withdrawal followed by AttemptsAdded appends a fresh availability", async () => {
    const { ports } = makePorts();
    const topUp = projectable({
      event: "AttemptsAdded",
      facts: { taskId: 42n, creator: CREATOR, added: 1, newMaxTotal: 2 },
      derivation: derivation("AttemptsAdded", 2, "revised"),
    });
    const result = await projectAnnouncements(
      transition([task(1), claim(), topUp]),
      ports,
    );

    expect(result.announcements.map((announcement) => ({
      action: announcement.action,
      ...(announcement.action === "withdrawn" ? { reason: announcement.reason } : {}),
    }))).toEqual([
      { action: "available" },
      { action: "withdrawn", reason: "delisted" },
      { action: "available" },
    ]);
    expect(result.announcements[2]!.announcementId).not.toBe(
      result.announcements[0]!.announcementId,
    );
  });

  test("a retained revised anchor reopens with the original record digest and facts identity", async () => {
    const anchoredDigest = documentDigest(SUBMISSION_BYTES);
    const revisedTask = projectable({
      event: "TaskCreated",
      facts: {
        creator: CREATOR, taskCidDigest: `0x${"7".repeat(64)}`,
        submissionDigest: `0x${anchoredDigest.slice("sha256:".length)}`,
        taskId: 42n, maxTotal: 1, maxConcurrent: 1,
        submissionDeadline: 1_800_000_000n, closeAt: 0n, responseTimeout: 3600n,
        minVerdicts: 1, requireDistinctEvaluator: true,
        solutionMaxDeliveryRate: 10n, verdictMaxDeliveryRate: 20n,
        solutionBudget: 100n, verdictBudget: 20n,
      },
      derivation: derivation("TaskCreated", 60, "revised"),
    });
    const revisedClaim = projectable({
      event: "TaskAttemptCreated",
      facts: {
        taskId: 42n, attemptIndex: 1, operator: OPERATOR, requestId: REQUEST_ID,
        priorityMech: OPERATOR, attemptDeadline: 1_800_000_001n, deliveryRate: 10n,
      },
      derivation: derivation("TaskAttemptCreated", 61, "revised"),
    });
    const topUp = projectable({
      event: "AttemptsAdded",
      facts: { taskId: 42n, creator: CREATOR, added: 1, newMaxTotal: 2 },
      derivation: derivation("AttemptsAdded", 62, "revised"),
    });
    const creation = reduceMarketplaceProjection([revisedTask, revisedClaim], createMarketplaceProjectionState());
    const reopening = reduceMarketplaceProjection([topUp], creation.state);
    const initial = await projectAnnouncements(creation, makePorts().ports);
    const reopened = await projectAnnouncements(reopening, makePorts().ports);
    const initialAvailable = initial.announcements.find((announcement) => announcement.action === "available");
    const reopenedAvailable = reopened.announcements.find((announcement) => announcement.action === "available");

    expect(reopenedAvailable?.announcementId).not.toBe(initialAvailable?.announcementId);
    expect(reopenedAvailable?.action === "available" && initialAvailable?.action === "available"
      ? reopenedAvailable.record.digest
      : undefined).toBe(initialAvailable?.action === "available" ? initialAvailable.record.digest : undefined);
    expect(reopenedAvailable?.action === "available" && initialAvailable?.action === "available"
      ? reopenedAvailable.facts
      : undefined).toEqual(initialAvailable?.action === "available" ? initialAvailable.facts : undefined);
  });

  test.each([
    ["release", "AttemptReleased"],
    ["expiry", "AttemptExpired"],
    ["top-up", "AttemptsAdded"],
  ] as const)("refuses swapped retained Submission material on revised %s reopening before downstream effects", async (_name, eventName) => {
    const { ports, writes, signed, recomputed, resolved } = makePorts();
    const anchoredDigest = documentDigest(SUBMISSION_BYTES);
    const revisedTask = projectable({
      event: "TaskCreated",
      facts: {
        creator: CREATOR, taskCidDigest: `0x${"7".repeat(64)}`,
        submissionDigest: `0x${anchoredDigest.slice("sha256:".length)}`,
        taskId: 42n, maxTotal: 1, maxConcurrent: 1,
        submissionDeadline: 1_800_000_000n, closeAt: 0n, responseTimeout: 3600n,
        minVerdicts: 1, requireDistinctEvaluator: true,
        solutionMaxDeliveryRate: 10n, verdictMaxDeliveryRate: 20n,
        solutionBudget: 100n, verdictBudget: 20n,
      },
      derivation: derivation("TaskCreated", 70, "revised"),
    });
    const revisedClaim = projectable({
      event: "TaskAttemptCreated",
      facts: {
        taskId: 42n, attemptIndex: 1, operator: OPERATOR, requestId: REQUEST_ID,
        priorityMech: OPERATOR, attemptDeadline: 1_800_000_001n, deliveryRate: 10n,
      },
      derivation: derivation("TaskAttemptCreated", 71, "revised"),
    });
    const opening = eventName === "AttemptsAdded"
      ? projectable({
          event: "AttemptsAdded",
          facts: { taskId: 42n, creator: CREATOR, added: 1, newMaxTotal: 2 },
          derivation: derivation("AttemptsAdded", 72, "revised"),
        })
      : projectable({
          event: eventName,
          facts: { taskId: 42n, attemptIndex: 1, operator: OPERATOR },
          derivation: derivation(eventName, 72, "revised"),
        } as MarketplaceEvent);
    const before = reduceMarketplaceProjection([revisedTask, revisedClaim], createMarketplaceProjectionState());
    const reopening = reduceMarketplaceProjection([opening], before.state);
    const result = await projectAnnouncements(reopening, {
      ...ports,
      async resolveRecord(event, role) {
        if (role === "submission" && event === opening) {
          return {
            kind: RECORD_KINDS.submission,
            bytes: new TextEncoder().encode('{"swapped":true}'),
          };
        }
        return ports.resolveRecord(event, role);
      },
    });

    expect(result.announcements).toEqual([]);
    expect(result.refusals).toEqual([{
      kind: "announcement-material-refused",
      role: "submission",
      expectedDigest: anchoredDigest,
      actualDigest: documentDigest(new TextEncoder().encode('{"swapped":true}')),
      derivation: opening.derivation,
      originalAnchorDerivation: revisedTask.derivation,
    }]);
    expect(resolved.filter(({ role }) => role === "submission")).toHaveLength(0);
    expect(recomputed).toEqual([]);
    expect(writes).toEqual([]);
    expect(signed).toEqual([]);
  });

  test("verdict verifies exact resolved material once, signs correspondence fact, then withdraws Submission", async () => {
    const { ports, resolved, verified } = makePorts();
    const verdict = projectable({
      event: "VerdictDeliveryClaimed",
      facts: {
        evaluator: OPERATOR,
        requestId: REQUEST_ID,
        taskId: 42n,
        attemptIndex: 3,
        verdictIndex: 1,
        verdictCode: 1,
      },
      derivation: derivation("VerdictDeliveryClaimed", 5),
    });
    const result = await projectAnnouncements(
      transition([task(), verdict]),
      ports,
    );
    expect(result.announcements.map((announcement) =>
      announcement.action === "available"
        ? [announcement.action, announcement.record.kind]
        : [announcement.action, announcement.reason]
    )).toEqual([
      ["available", RECORD_KINDS.submission],
      ["available", RECORD_KINDS.delivery],
      ["withdrawn", "delisted"],
    ]);
    expect(result.announcements[1]).toMatchObject({
      locations: [{ locator: "ipfs://evaluation" }],
      facts: {
        "https://spec.jinn.network/facts/marketplace-verdict-correspondence/v1": {
          onChainVerdictCode: 1,
          statementVerdict: "pass",
        },
      },
    });
    const evaluationResolution = resolved.filter(({ role }) =>
      role === "evaluation-delivery"
    );
    expect(evaluationResolution).toHaveLength(1);
    expect(verified).toHaveLength(1);
    expect(verified[0]!.material).toBe(evaluationResolution[0]!.material);
    expect(result.refusals).toEqual([]);
  });

  test("false named-check gate suppresses verdict publication and withdrawal without record writes", async () => {
    const { ports, writes, resolved } = makePorts();
    const failures = [
      { check: "settlement-join", detail: "rotated evaluator key does not join settlement" },
      { check: "verdict-consistency", detail: "measurement contradicts verdict" },
    ];
    const verdict = projectable({
      event: "VerdictDeliveryClaimed",
      facts: {
        evaluator: OPERATOR,
        requestId: REQUEST_ID,
        taskId: 42n,
        attemptIndex: 3,
        verdictIndex: 1,
        verdictCode: 1,
      },
      derivation: derivation("VerdictDeliveryClaimed", 5),
    });
    const result = await projectAnnouncements(transition([verdict]), {
      ...ports,
      async resolvePriorAnnouncementId() {
        return "ann-prior-submission";
      },
      async verifyVerdictObservation() {
        return {
          gate: { decisionGrade: false, failures },
          statementVerdict: "pass",
        };
      },
    });

    expect(result.announcements).toEqual([]);
    expect(result.entries).toEqual([]);
    expect(result.refusals).toEqual([{
      kind: "verdict-observation-refused",
      derivation: verdict.derivation,
      onChainVerdictCode: 1,
      statementVerdict: "pass",
      failures,
    }]);
    expect(resolved.filter(({ role }) => role === "evaluation-delivery")).toHaveLength(1);
    expect(writes).toEqual([]);
  });

  test.each([
    {
      name: "missing Statement verdict",
      statementVerdict: undefined,
      expectedDetail: "verified Result Evaluation Statement verdict is missing",
    },
    {
      name: "unmappable Statement verdict",
      statementVerdict: "invalid",
      expectedDetail: 'missing or non-conforming Result Evaluation verdict "invalid"',
    },
    {
      name: "on-chain code mismatch",
      statementVerdict: "fail",
      expectedDetail: 'Statement verdict "fail" requires code 2; on-chain claim carries 1',
    },
  ])("refuses $name without publishing or withdrawing", async ({
    statementVerdict,
    expectedDetail,
  }) => {
    const { ports, writes } = makePorts();
    const verdict = projectable({
      event: "VerdictDeliveryClaimed",
      facts: {
        evaluator: OPERATOR,
        requestId: REQUEST_ID,
        taskId: 42n,
        attemptIndex: 3,
        verdictIndex: 1,
        verdictCode: 1,
      },
      derivation: derivation("VerdictDeliveryClaimed", 5),
    });
    const result = await projectAnnouncements(transition([verdict]), {
      ...ports,
      async resolvePriorAnnouncementId() {
        return "ann-prior-submission";
      },
      async verifyVerdictObservation() {
        return {
          gate: { decisionGrade: true, failures: [] },
          ...(statementVerdict === undefined
            ? {}
            : {
                statementVerdict:
                  statementVerdict as "pass" | "fail" | "inconclusive",
              }),
        };
      },
    });

    expect(result.announcements).toEqual([]);
    expect(result.entries).toEqual([]);
    expect(result.refusals).toEqual([
      expect.objectContaining({
        kind: "verdict-observation-refused",
        derivation: verdict.derivation,
        onChainVerdictCode: 1,
        ...(statementVerdict === undefined ? {} : { statementVerdict }),
        failures: [{
          check: "verdict-correspondence",
          detail: expect.stringContaining(expectedDetail),
        }],
      }),
    ]);
    expect(writes).toEqual([]);
  });

  test("missing verifier port fails closed with a typed refusal and no record write", async () => {
    const { ports, writes } = makePorts();
    const verdict = projectable({
      event: "VerdictDeliveryClaimed",
      facts: {
        evaluator: OPERATOR,
        requestId: REQUEST_ID,
        taskId: 42n,
        attemptIndex: 3,
        verdictIndex: 1,
        verdictCode: 1,
      },
      derivation: derivation("VerdictDeliveryClaimed", 5),
    });
    const result = await projectAnnouncements(transition([verdict]), {
      ...ports,
      verifyVerdictObservation: undefined as never,
    });

    expect(result.announcements).toEqual([]);
    expect(result.refusals).toEqual([{
      kind: "verdict-observation-refused",
      derivation: verdict.derivation,
      onChainVerdictCode: 1,
      failures: [{
        check: "verdict-observation-verifier",
        detail: "verifyVerdictObservation port is required for VerdictDeliveryClaimed",
      }],
    }]);
    expect(writes).toEqual([]);
  });

  test("fails closed if the injected signer is not scoped to the discovery constant", async () => {
    const { ports } = makePorts();
    const wrongSigner = {
      ...(ports.signer as DsseSigner),
      scope: "jinn:wrong",
    };
    await expect(
      projectAnnouncements(transition([task()]), {
        ...ports,
        signer: wrongSigner as ScopedDiscoverySigner,
      }),
    ).rejects.toThrow(/DISCOVERY_SIGNING_SCOPE/);
  });

  test("requires an append-aware archive writer for incremental publication instead of overwriting genesis pages", async () => {
    const genesisPorts = makePorts();
    const genesisTransition = transition([task()]);
    const genesis = await projectAnnouncements(
      genesisTransition,
      genesisPorts.ports,
    );
    const previousHead = genesis.head!;
    const previousEntryDigest = sealJson(genesis.entries.at(-1)!.entry).digest;
    const topUp = projectable({
      event: "AttemptsAdded",
      facts: { taskId: 42n, creator: CREATOR, added: 1, newMaxTotal: 3 },
      derivation: derivation("AttemptsAdded", 6, "revised"),
    });

    const missingWriter = makePorts();
    const incrementalTransition = transition(
      [topUp],
      genesisTransition.state,
    );
    await expect(
      projectAnnouncements(incrementalTransition, {
        ...missingWriter.ports,
        previousHead,
        previousEntryDigest,
        initialSequence: 2n,
      }),
    ).rejects.toThrow(/append-aware archive writer/);

    const appended: Array<{ previous: typeof previousHead; sequences: string[] }> = [];
    const incremental = makePorts();
    const projected = await projectAnnouncements(incrementalTransition, {
      ...incremental.ports,
      previousHead,
      previousEntryDigest,
      initialSequence: 2n,
      async appendArchiveEntries(input) {
        appended.push({
          previous: input.previousHead,
          sequences: input.entries.map(({ entry }) => entry.sequence),
        });
        return { pages: ["0000000000000002"] };
      },
    });

    expect(appended).toEqual([]);
    expect(projected.pages).toEqual([]);
    expect(projected.entries).toEqual([]);
    expect(projected.head).toEqual(previousHead);
  });

  test("consumes the exact shared transition result instead of re-projecting its events", async () => {
    const { ports } = makePorts();
    const projected = transition([task()]);
    const result = await projectAnnouncements(
      { ...projected, observations: [] },
      ports,
    );

    expect(projected.observations).toHaveLength(1);
    expect(result.announcements).toEqual([]);
    expect(result.entries).toEqual([]);
  });

  test.each([
    ["verdict then release", "VerdictDeliveryClaimed", "AttemptReleased"],
    ["refund then expiry", "TaskBudgetRefunded", "AttemptExpired"],
    ["refund then top-up", "TaskBudgetRefunded", "AttemptsAdded"],
  ] as const)(
    "%s never emits a reopening available announcement across a batch boundary",
    async (_name, terminalName, laterName) => {
      const opening = transition([task(), claim()]);
      const terminal = terminalName === "VerdictDeliveryClaimed"
        ? projectable({
            event: terminalName,
            facts: { evaluator: OPERATOR, requestId: REQUEST_ID, taskId: 42n, attemptIndex: 3, verdictIndex: 0, verdictCode: 1 },
            derivation: derivation(terminalName, 80),
          })
        : close();
      const closed = transition([terminal], opening.state);
      const later = laterName === "AttemptsAdded"
        ? projectable({ event: laterName, facts: { taskId: 42n, creator: CREATOR, added: 1, newMaxTotal: 3 }, derivation: derivation(laterName, 81, "revised") })
        : projectable({ event: laterName, facts: { taskId: 42n, attemptIndex: 3, operator: OPERATOR }, derivation: derivation(laterName, 81, "revised") } as MarketplaceEvent);
      const after = transition([later], closed.state);
      const result = await projectAnnouncements(after, makePorts().ports);

      expect(after.availabilityOpenedLogIds).toEqual([]);
      expect(result.announcements.filter((announcement) => announcement.action === "available")).toEqual([]);
      expect(result.entries).toEqual([]);
      expect(result.refusals).toEqual([]);
    },
  );

  // One unresolvable record used to take the whole tick down with it. `resolveRecord` is a HOST
  // port -- it reaches a serving plane, a durable store, a chain read -- so a throw is an ordinary
  // outcome for one record, not a statement about the others. But it propagated straight out of
  // `projectAnnouncements`, and `projector-loop.ts` catches that as non-fatal and advances the
  // cursor anyway: `hasCanonicalEvent` then filters every event in the tick out of later
  // `publicationEvents`, so all of them are dropped for good -- permanently, since a rewind replays
  // the identical event_keys and `hasCanonicalEvent` filters them right back out. Observed live on
  // Base Sepolia during the DR-2026-08-05 gate endgame -- one unanchorable counterparty Delivery
  // dropped the other four announcements in the same tick with it.
  //
  // Fail-closed is unchanged for the record that could not be resolved: no announcement, and a
  // named refusal. It just no longer speaks for its neighbours.
  test("one unresolvable record refuses alone, leaving the tick's other announcements published", async () => {
    const { ports, verified } = makePorts();
    const attempted: string[] = [];
    const isolated: AnnouncementProjectionPorts = {
      ...ports,
      async resolveRecord(event, role) {
        attempted.push(role);
        if (role === "delivery") {
          throw new Error("this operator holds no single durable solution-delivery record");
        }
        return ports.resolveRecord(event, role);
      },
    };
    const events = [task(), claim(), ...deliveryEvents(), close()];

    const result = await projectAnnouncements(transition(events), isolated);

    // The delivery leg was asked, and refused by name -- never silently skipped.
    expect(attempted).toContain("delivery");
    expect(result.refusals).toEqual([{
      kind: "announcement-record-unresolved",
      role: "delivery",
      reason: "Error: this operator holds no single durable solution-delivery record",
      derivation: deliveryEvents()[1]!.derivation,
    }]);
    // No delivery announcement -- fail-closed is intact.
    expect(result.announcements.filter(
      (announcement) => announcement.action === "available"
        && announcement.record.kind === RECORD_KINDS.delivery,
    )).toEqual([]);
    // ...and the submission's availability and withdrawal still published.
    expect(result.announcements.map(({ action }) => action)).toEqual(["available", "withdrawn"]);
    expect(result.entries).toHaveLength(2);
    expect(verified).toEqual([]);
  });

  test("a throwing verdict-delivery record leaves the verdict gate unrun and the rest intact", async () => {
    const { ports, verified } = makePorts();
    const isolated: AnnouncementProjectionPorts = {
      ...ports,
      async resolveRecord(event, role) {
        if (role === "evaluation-delivery") throw new Error("serving plane unreachable");
        return ports.resolveRecord(event, role);
      },
    };
    const verdict = projectable({
      event: "VerdictDeliveryClaimed",
      facts: { evaluator: OPERATOR, requestId: REQUEST_ID, taskId: 42n, attemptIndex: 3, verdictIndex: 0, verdictCode: 1 },
      derivation: derivation("VerdictDeliveryClaimed", 90),
    });

    const result = await projectAnnouncements(
      transition([task(), claim(), ...deliveryEvents(), verdict]),
      isolated,
    );

    expect(result.refusals).toEqual([{
      kind: "announcement-record-unresolved",
      role: "evaluation-delivery",
      reason: "Error: serving plane unreachable",
      derivation: verdict.derivation,
    }]);
    // The M4b gate is never handed material that was never resolved.
    expect(verified).toEqual([]);
    // The submission and the solution delivery both still published.
    expect(result.announcements.map(({ action }) => action)).toEqual(["available", "available"]);
  });
});
