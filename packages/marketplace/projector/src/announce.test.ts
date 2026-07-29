import {
  DISCOVERY_SIGNING_SCOPE,
  MEDIA_ENTRY,
  RECORD_KINDS,
  dssePreAuthEncoding,
  sealJson,
  type FactsRecompute,
} from "@jinn-network/record-discovery-protocol";
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
const EVALUATION_BYTES = new TextEncoder().encode('{"record":"evaluation-delivery"}');
const CONTEXT: ObservationProjectionContext = {
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
        data: `0x${"a".repeat(64)}`,
      },
      derivation: derivation("Deliver", 2),
    }, {
      deliveryCorrespondence: {
        sha256Digest: `sha256:${"a".repeat(64)}`,
        keccakEvidenceHash: `0x${"b".repeat(64)}`,
        onChainSha256CidDigest: `sha256:${"a".repeat(64)}`,
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
            taskProfileUri: "https://jinn.network/task-profiles/repository-work/1.0",
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
        return {
          kind: RECORD_KINDS.submission,
          bytes: SUBMISSION_BYTES,
          mediaType: "application/vnd.jinn.task-execution.submission.v1+json",
          locations: [{
            profile: "https://jinn.network/record-discovery/location/ipfs/1.0",
            locator: "ipfs://submission",
          }],
        };
      }
      return {
        kind: RECORD_KINDS.delivery,
        bytes: role === "evaluation-delivery" ? EVALUATION_BYTES : DELIVERY_BYTES,
        mediaType: "application/vnd.jinn.task-execution.delivery.v1+json",
        locations: [{
          profile: "https://jinn.network/record-discovery/location/ipfs/1.0",
          locator: role === "evaluation-delivery" ? "ipfs://evaluation" : "ipfs://delivery",
        }],
      };
    },
  };
  return { ports, writes, signed, recomputed };
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
        taskProfileUri: "https://jinn.network/task-profiles/repository-work/1.0",
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

  test("verdict publishes an evaluation Delivery then withdraws Submission availability", async () => {
    const { ports } = makePorts();
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
    });
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

    expect(appended).toEqual([{
      previous: previousHead,
      sequences: ["0000000000000002"],
    }]);
    expect(projected.pages).toEqual(["0000000000000002"]);
    expect(projected.entries[0]!.entry.previous).toBe(previousEntryDigest);
    expect(projected.head?.sequence).toBe("0000000000000002");
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
});
