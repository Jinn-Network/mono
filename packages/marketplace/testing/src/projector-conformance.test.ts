// SPDX-License-Identifier: MIT

import {
  DISCOVERY_SIGNING_SCOPE,
  formatOrigin,
  RECORD_DISCOVERY_VERSION,
  RECORD_KINDS,
  recordDigest,
  sealJson,
  verifyItem,
  type AnnouncedItem,
  type FactsRecompute,
  type SourceHead,
} from "@jinn-network/record-discovery-protocol";
import type { BlobStore } from "@jinn-network/record-discovery-serve";
import { BASE_SEPOLIA_TODAY } from "@jinn-network/marketplace-binding";
import {
  foldObservations,
  type ProtocolObservation,
} from "@jinn-network/task-execution-protocol";
import {
  REVISED_PROJECTOR_EVENTS_ABI,
  REVISED_MECH_DELIVER_ABI,
  appendSignedReorgCorrection,
  createMarketplaceProjectionState,
  decodeMarketplaceLogs,
  marketplaceEventOriginAuthority,
  foldCanonicalMarketplaceObservations,
  projectAnnouncements,
  projectReorgObservation,
  reduceMarketplaceProjection,
  selectCanonicalMarketplaceObservations,
  type AnnouncementProjectionPorts,
  type MarketplaceRawLog,
  type ObservationMarketplaceEvent,
  type ScopedDiscoverySigner,
} from "@jinn-network/marketplace-projector";
import {
  encodeAbiParameters,
  encodeEventTopics,
  type AbiEvent,
  type Address,
  type Hex,
} from "viem";
import {
  describeMarketplaceProjectorConformance,
  loadMarketplaceProjectorFixtures,
  describeMarketplaceProjectorIdentityConformance,
  type DerivationOutcome,
  type MarketplaceProjectorConformanceSubject,
  type MarketplaceProjectorFixture,
  type MarketplaceProjectorReorgFixture,
  type ProjectedDerivation,
} from "./projector-conformance.js";
import { expect, test } from "vitest";

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

const encoder = new TextEncoder();
const SUBMISSION_BYTES = encoder.encode('{"record":"submission"}');

function stringifyProjectionState(state: unknown): string {
  return JSON.stringify(state, (_key, value) =>
    typeof value === "bigint" ? value.toString() : value,
  );
}
const DELIVERY_BYTES = encoder.encode('{"record":"delivery"}');
const EVALUATION_BYTES = encoder.encode('{"record":"evaluation-delivery"}');

function asFixtureLogs(fixture: {
  readonly logs: readonly unknown[];
}): FixtureLog[] {
  return fixture.logs as FixtureLog[];
}

function abiEvent(name: string): AbiEvent {
  const event = [...REVISED_PROJECTOR_EVENTS_ABI, ...REVISED_MECH_DELIVER_ABI].find((item) =>
    item.name === name
  );
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

function inputName(input: AbiEvent["inputs"][number]): string {
  if (input.name === undefined || input.name.length === 0) {
    throw new TypeError("projector fixture ABI inputs must be named");
  }
  return input.name;
}

function rawLog(log: FixtureLog): MarketplaceRawLog {
  const event = abiEvent(log.event);
  const args = Object.fromEntries(
    event.inputs.map((input) => {
      const name = inputName(input);
      const value = log.args[name];
      if (value === undefined) {
        throw new TypeError(`fixture event ${log.event} has no argument "${name}"`);
      }
      return [name, evmValue(input.type, value)];
    }),
  );
  const unindexed = event.inputs.filter((input) => input.indexed !== true);
  const data = encodeAbiParameters(
    unindexed.map((input) => ({
      name: input.name,
      type: input.type,
    })),
    unindexed.map((input) => args[inputName(input)]),
  );
  return {
    chainId: log.chainId,
    address: log.address,
    blockNumber: BigInt(log.blockNumber),
    blockHash: log.blockHash,
    transactionHash: log.transactionHash,
    logIndex: log.logIndex,
    finalityTier: log.finalityTier,
    topics: encodeEventTopics({
      abi: [event],
      eventName: log.event,
      args,
    }) as readonly Hex[],
    data,
  };
}

function enrichedEvents(
  fixture: MarketplaceProjectorFixture | MarketplaceProjectorReorgFixture,
): ObservationMarketplaceEvent[] {
  const logs = asFixtureLogs(fixture);
  const decoded = decodeMarketplaceLogs(
    logs.map(rawLog),
    marketplaceEventOriginAuthority({
      ...BASE_SEPOLIA_TODAY,
      generation: fixture.generation,
      jinnRouter: logs.find((log) => log.event !== "Deliver")!.address,
      taskCoordinator: logs.find((log) => log.event !== "Deliver")!.address,
      mechMarketplace: logs.find((log) => log.event === "Deliver")?.address
        ?? BASE_SEPOLIA_TODAY.mechMarketplace,
    }, (address) => logs.some((log) => log.event === "Deliver" && log.address.toLowerCase() === address.toLowerCase())),
  );
  if (decoded.length !== logs.length) {
    throw new Error(`fixture ${fixture.name} did not decode one event per log`);
  }
  return decoded.map((event, index) => ({
    ...event,
    projection: {
      ...logs[index]!.projection,
      taskCoordinator: logs[0]!.address,
    },
  })) as ObservationMarketplaceEvent[];
}

interface AnnouncementHostState {
  previousHead?: SourceHead;
  previousEntryDigest?: `sha256:${string}`;
  nextSequence: bigint;
  nextArchivePage: bigint;
  priorAnnouncements: Map<"submission" | "delivery", string>;
}

function createAnnouncementHostState(): AnnouncementHostState {
  return {
    nextSequence: 1n,
    nextArchivePage: 1n,
    priorAnnouncements: new Map(),
  };
}

function incrementalPorts(): AnnouncementProjectionPorts {
  const host = createAnnouncementHostState();
  const agent = "did:key:zMarketplaceProjectorFixture";
  const name = "marketplace";
  host.previousHead = {
    protocol: RECORD_DISCOVERY_VERSION,
    origin: formatOrigin(agent, name),
    sequence: "0000000000000005",
    entry: `sha256:${"1".repeat(64)}`,
    issuedAt: "2026-07-29T12:00:00Z",
    refreshBy: "2026-07-30T12:00:00Z",
  };
  host.previousEntryDigest = host.previousHead.entry;
  host.nextSequence = 6n;
  return ports(host);
}

function ports(host = createAnnouncementHostState()): AnnouncementProjectionPorts {
  const store: BlobStore = { async put() {} };
  const signer: ScopedDiscoverySigner = {
    scope: DISCOVERY_SIGNING_SCOPE,
    async sign() {
      return [{ keyid: "did:key:zMarketplaceProjectorFixture", sig: new Uint8Array([1, 2, 3]) }];
    },
  };
  const factsRecompute: FactsRecompute = {
    get(kind) {
      if (kind === RECORD_KINDS.submission) {
        return async () => ({
          taskDigest: `sha256:${"7".repeat(64)}`,
          taskProfileUri: "https://jinn.network/task-profiles/repository-work/1.0",
          requesterIri: "did:key:zRequesterFixture",
          deadline: "2026-07-30T12:00:00Z",
        });
      }
      if (kind === RECORD_KINDS.delivery) {
        return async () => ({
          taskDigest: `sha256:${"7".repeat(64)}`,
          attemptUri: "urn:uuid:2868f518-bc8c-5703-992d-51afdfb53e4b",
          outcome: "fulfilled",
        });
      }
      return undefined;
    },
  };
  return {
    source: {
      agent: "did:key:zMarketplaceProjectorFixture",
      name: "marketplace",
    },
    signer,
    store,
    clock: { now: () => new Date("2026-07-29T12:00:01Z") },
    factsRecompute,
    referencedBytes: { async fetch() { return undefined; } },
    async verifyVerdictObservation(event) {
      const statementVerdict = event.facts.verdictCode === 1
        ? "pass"
        : event.facts.verdictCode === 2
        ? "fail"
        : event.facts.verdictCode === 4
        ? "inconclusive"
        : undefined;
      return {
        gate: {
          decisionGrade: statementVerdict !== undefined,
          failures: statementVerdict === undefined
            ? [{
                check: "verdict-correspondence",
                detail: `fixture has no Statement verdict for code ${event.facts.verdictCode}`,
              }]
            : [],
        },
        ...(statementVerdict === undefined ? {} : { statementVerdict }),
      };
    },
    ...(host.previousHead === undefined
      ? {}
      : {
          previousHead: host.previousHead,
          previousEntryDigest: host.previousEntryDigest!,
          initialSequence: host.nextSequence,
          async appendArchiveEntries() {
            const page = host.nextArchivePage.toString().padStart(16, "0");
            host.nextArchivePage += 1n;
            return { pages: [page] };
          },
        }),
    async resolvePriorAnnouncementId(_event, role) {
      return host.priorAnnouncements.get(role);
    },
    async resolveRecord(_event, role) {
      if (role === "submission") {
        return {
          kind: RECORD_KINDS.submission,
          bytes: SUBMISSION_BYTES,
          mediaType: "application/vnd.jinn.task-execution.submission.v1+json",
        };
      }
      return {
        kind: RECORD_KINDS.delivery,
        bytes: role === "evaluation-delivery"
          ? EVALUATION_BYTES
          : DELIVERY_BYTES,
        mediaType: "application/vnd.jinn.task-execution.delivery.v1+json",
      };
    },
  };
}

function updateAnnouncementHost(
  host: AnnouncementHostState,
  projected: Awaited<ReturnType<typeof projectAnnouncements>>,
): void {
  for (const announcement of projected.announcements) {
    if (announcement.action === "available") {
      const role = announcement.record.kind === RECORD_KINDS.submission
        ? "submission"
        : "delivery";
      host.priorAnnouncements.set(role, announcement.announcementId);
      continue;
    }
    for (const [role, id] of host.priorAnnouncements) {
      if (id === announcement.retracts) host.priorAnnouncements.delete(role);
    }
  }
  const last = projected.entries.at(-1)?.entry;
  if (projected.head !== undefined && last !== undefined) {
    host.previousHead = projected.head;
    host.previousEntryDigest = sealJson(last).digest;
    host.nextSequence = BigInt(last.sequence) + 1n;
  }
}

function batchEvents(
  events: readonly ObservationMarketplaceEvent[],
  batchSizes?: readonly number[],
): ObservationMarketplaceEvent[][] {
  if (batchSizes === undefined) return [[...events]];
  if (
    batchSizes.some((size) => !Number.isSafeInteger(size) || size <= 0)
    || batchSizes.reduce((sum, size) => sum + size, 0) !== events.length
  ) {
    throw new Error("batchSizes must be positive safe integers covering every fixture log");
  }
  const batches: ObservationMarketplaceEvent[][] = [];
  let offset = 0;
  for (const size of batchSizes) {
    batches.push(events.slice(offset, offset + size));
    offset += size;
  }
  return batches;
}

function refuses(operation: () => unknown): boolean {
  try {
    operation();
    return false;
  } catch {
    return true;
  }
}

function appendedProcessedLogId(
  state: { readonly processedLogIds: readonly string[] },
  event: ObservationMarketplaceEvent,
): string[] {
  const derivation = event.derivation;
  return [...state.processedLogIds, [
    derivation.chainId,
    derivation.contract.toLowerCase(),
    derivation.blockHash.toLowerCase(),
    derivation.txHash.toLowerCase(),
    derivation.logIndex,
  ].join(":")];
}

test("lifecycle replay and refusals preserve the complete accepted-output boundary", () => {
  const fixture = loadMarketplaceProjectorFixtures().find(({ name }) => name === "revised-cross-batch-flow");
  if (fixture === undefined) throw new Error("revised lifecycle fixture is missing");
  const [created, claim] = enrichedEvents(fixture);
  if (
    created === undefined || created.event !== "TaskCreated"
    || claim === undefined || claim.event !== "TaskAttemptCreated"
  ) {
    throw new Error("revised lifecycle fixture lacks TaskCreated and TaskAttemptCreated");
  }
  const createdState = reduceMarketplaceProjection([created], createMarketplaceProjectionState());
  const claimed = reduceMarketplaceProjection([claim], createdState.state);
  const replay = reduceMarketplaceProjection([claim], claimed.state);
  expect(replay).toEqual({
    state: claimed.state,
    events: [],
    observations: [],
    availabilityOpenedLogIds: [],
    refusals: [],
  });

  const distinctLog = {
    ...claim,
    derivation: { ...claim.derivation, txHash: `0x${"c".repeat(64)}`, logIndex: 1 },
  } as ObservationMarketplaceEvent;
  const regressing = reduceMarketplaceProjection([distinctLog], claimed.state);
  expect(regressing).toEqual({
    state: {
      ...claimed.state,
      processedLogIds: appendedProcessedLogId(claimed.state, distinctLog),
    },
    events: [], observations: [], availabilityOpenedLogIds: [],
    refusals: [{
      kind: "marketplace-projection-refused",
      reason: "attempt-identity-regressing",
      derivation: distinctLog.derivation,
      taskId: claim.facts.taskId,
      attemptIndex: claim.facts.attemptIndex,
    }],
  });

  const reusedIndex = {
    ...claim,
    facts: { ...claim.facts, attemptIndex: claim.facts.attemptIndex - 1 },
    derivation: { ...claim.derivation, txHash: `0x${"b".repeat(64)}`, logIndex: 5 },
  } as ObservationMarketplaceEvent;
  const reused = reduceMarketplaceProjection([reusedIndex], claimed.state);
  expect(reused).toEqual({
    state: {
      ...claimed.state,
      processedLogIds: appendedProcessedLogId(claimed.state, reusedIndex),
    },
    events: [], observations: [], availabilityOpenedLogIds: [],
    refusals: [{
      kind: "marketplace-projection-refused",
      reason: "attempt-identity-regressing",
      derivation: reusedIndex.derivation,
      taskId: claim.facts.taskId,
      attemptIndex: claim.facts.attemptIndex - 1,
    }],
  });

  const unknown = {
    ...claim,
    facts: { ...claim.facts, taskId: 999n, attemptIndex: claim.facts.attemptIndex + 1 },
    derivation: { ...claim.derivation, txHash: `0x${"d".repeat(64)}`, logIndex: 2 },
  } as ObservationMarketplaceEvent;
  const unknownResult = reduceMarketplaceProjection([unknown], createdState.state);
  expect(unknownResult).toEqual({
    state: {
      ...createdState.state,
      processedLogIds: appendedProcessedLogId(createdState.state, unknown),
    },
    events: [], observations: [], availabilityOpenedLogIds: [],
    refusals: [{
      kind: "marketplace-projection-refused",
      reason: "unknown-task",
      derivation: unknown.derivation,
      taskId: 999n,
      attemptIndex: claim.facts.attemptIndex + 1,
    }],
  });

  const release = {
    event: "AttemptReleased" as const,
    facts: { taskId: claim.facts.taskId, attemptIndex: claim.facts.attemptIndex, operator: claim.facts.operator },
    derivation: { ...claim.derivation, event: "AttemptReleased", txHash: `0x${"e".repeat(64)}`, logIndex: 3 },
    projection: claim.projection,
  } as ObservationMarketplaceEvent;
  const nonLive = reduceMarketplaceProjection([release], createdState.state);
  expect(nonLive).toEqual({
    state: {
      ...createdState.state,
      processedLogIds: appendedProcessedLogId(createdState.state, release),
    },
    events: [], observations: [], availabilityOpenedLogIds: [],
    refusals: [{
      kind: "marketplace-projection-refused",
      reason: "attempt-not-live",
      derivation: release.derivation,
      taskId: claim.facts.taskId,
      attemptIndex: claim.facts.attemptIndex,
    }],
  });

  const expiry = {
    ...release,
    event: "AttemptExpired" as const,
    derivation: { ...release.derivation, event: "AttemptExpired", txHash: `0x${"a".repeat(64)}`, logIndex: 6 },
  } as ObservationMarketplaceEvent;
  const nonLiveExpiry = reduceMarketplaceProjection([expiry], createdState.state);
  expect(nonLiveExpiry).toEqual({
    state: {
      ...createdState.state,
      processedLogIds: appendedProcessedLogId(createdState.state, expiry),
    },
    events: [], observations: [], availabilityOpenedLogIds: [],
    refusals: [{
      kind: "marketplace-projection-refused",
      reason: "attempt-not-live",
      derivation: expiry.derivation,
      taskId: claim.facts.taskId,
      attemptIndex: claim.facts.attemptIndex,
    }],
  });

  for (const lifecycle of [release, expiry]) {
    const unknownLifecycle = {
      ...lifecycle,
      facts: { ...lifecycle.facts, taskId: 999n },
      derivation: {
        ...lifecycle.derivation,
        txHash: `0x${(lifecycle.event === "AttemptReleased" ? "9" : "8").repeat(64)}`,
      },
    } as ObservationMarketplaceEvent;
    const unknownLifecycleResult = reduceMarketplaceProjection([unknownLifecycle], createdState.state);
    expect(unknownLifecycleResult).toEqual({
      state: {
        ...createdState.state,
        processedLogIds: appendedProcessedLogId(createdState.state, unknownLifecycle),
      },
      events: [], observations: [], availabilityOpenedLogIds: [],
      refusals: [{
        kind: "marketplace-projection-refused",
        reason: "unknown-task",
        derivation: unknownLifecycle.derivation,
        taskId: 999n,
        attemptIndex: claim.facts.attemptIndex,
      }],
    });
  }

  const topUp = {
    event: "AttemptsAdded" as const,
    facts: { taskId: claim.facts.taskId, creator: created.facts.creator, added: 1, newMaxTotal: 1 },
    derivation: { ...claim.derivation, event: "AttemptsAdded", txHash: `0x${"f".repeat(64)}`, logIndex: 4 },
    projection: claim.projection,
  } as ObservationMarketplaceEvent;
  const contradictory = reduceMarketplaceProjection([topUp], createdState.state);
  expect(contradictory).toEqual({
    state: {
      ...createdState.state,
      processedLogIds: appendedProcessedLogId(createdState.state, topUp),
    },
    events: [], observations: [], availabilityOpenedLogIds: [],
    refusals: [{
      kind: "marketplace-projection-refused",
      reason: "capacity-contradiction",
      derivation: topUp.derivation,
      taskId: claim.facts.taskId,
    }],
  });
});

async function projectFixtureInternal(
  fixture: MarketplaceProjectorFixture | MarketplaceProjectorReorgFixture,
  options: { readonly batchSizes?: readonly number[] } = {},
) {
  const events = enrichedEvents(fixture);
  let state = createMarketplaceProjectionState();
  const host = createAnnouncementHostState();
  const observations: unknown[] = [];
  const announcements: unknown[] = [];
  const derivations: ProjectedDerivation[] = [];
  const projectedBatches: Array<Awaited<ReturnType<typeof projectAnnouncements>>> = [];

  for (const batch of batchEvents(events, options.batchSizes)) {
    const transition = reduceMarketplaceProjection(batch, state);
    const projected = await projectAnnouncements(transition, ports(host));
    observations.push(...transition.observations);
    announcements.push(...projected.announcements);
    derivations.push(...transition.events.map((event) => event.derivation));
    projectedBatches.push(projected);
    state = transition.state;
    updateAnnouncementHost(host, projected);
  }

  const publicRun = {
    observations,
    announcements,
    derivations,
    observationBytes: encoder.encode(JSON.stringify(observations)),
    announcementBytes: encoder.encode(JSON.stringify(announcements)),
    stateBytes: encoder.encode(stringifyProjectionState(state)),
  };
  return {
    events,
    state,
    host,
    projectedBatches,
    publicRun,
  };
}

const subject: MarketplaceProjectorConformanceSubject = {
  async project(fixture, options) {
    return (await projectFixtureInternal(fixture, options)).publicRun;
  },

  async replay(fixture) {
    const first = await projectFixtureInternal(fixture);
    const replayTransition = reduceMarketplaceProjection(
      first.events,
      first.state,
    );
    const replayAnnouncements = await projectAnnouncements(
      replayTransition,
      ports(first.host),
    );
    return {
      first: first.publicRun,
      replayObservations: replayTransition.observations,
      replayAnnouncements: replayAnnouncements.announcements,
      stateBytesAfterReplay: encoder.encode(
        stringifyProjectionState(replayTransition.state),
      ),
    };
  },

  async projectReorg(fixture) {
    const run = await projectFixtureInternal(fixture);
    const projected = run.projectedBatches[0]!;
    const prior = projected.announcements.find((announcement) =>
      announcement.action === "available"
    );
    const priorEntry = projected.entries[0]?.entry;
    if (prior === undefined || prior.action !== "available" || priorEntry === undefined) {
      throw new Error(`fixture ${fixture.name} did not project an availability entry`);
    }
    const before = sealJson(priorEntry);
    const signed = await appendSignedReorgCorrection({
      priorEntry,
      prior,
      reorgedBlockHash: fixture.reorg.blockHash,
      timestamp: fixture.reorg.timestamp,
      signer: ports().signer,
    });
    const after = sealJson(priorEntry);
    const correction = sealJson(signed.entry);
    const accepted = run.publicRun.observations.find((observation) =>
      typeof observation === "object"
      && observation !== null
      && "type" in observation
      && observation.type
        === "network.jinn.task-execution.submission-accepted.v1"
    ) as ProtocolObservation | undefined;
    if (accepted === undefined) {
      throw new Error(`fixture ${fixture.name} projected no Submission acceptance`);
    }
    const tepCorrection = projectReorgObservation({
      priorObservation: accepted,
      derivation: run.events[0]!.derivation,
      reorgedBlockHash: fixture.reorg.blockHash,
      timestamp: fixture.reorg.timestamp,
      state: run.state,
    });
    return {
      priorEntry,
      priorEntryBytesBefore: before.bytes,
      priorEntryBytesAfter: after.bytes,
      priorAnnouncementId: prior.announcementId,
      correctionEntry: signed.entry,
      correctionEntryBytes: correction.bytes,
      expectedPreviousDigest: before.digest,
      signatureCount: signed.signature?.signatures.length ?? 0,
      tepCorrections: tepCorrection.observation === undefined
        ? []
        : [tepCorrection.observation],
    };
  },

  async projectAttemptReorg(fixture) {
    const events = enrichedEvents(fixture);
    const verdict = events.find((event) =>
      event.event === "VerdictDeliveryClaimed"
    );
    if (verdict === undefined) {
      throw new Error(`fixture ${fixture.name} needs a claim and later verdict`);
    }
    const beforeReorg = reduceMarketplaceProjection(
      events,
      createMarketplaceProjectionState(),
    );
    const engaged = beforeReorg.observations.find((observation) =>
      observation.type === "network.jinn.task-execution.attempt-engaged.v1"
    );
    const prior = beforeReorg.observations.find((observation) =>
      observation.type === "network.jinn.task-execution.attempt-terminal.v1"
      && observation.derivation.event === "VerdictDeliveryClaimed"
    );
    if (engaged === undefined || prior === undefined) {
      throw new Error(`fixture ${fixture.name} projected no engaged/terminal Attempt`);
    }
    const priorBytesBefore = encoder.encode(JSON.stringify(prior));
    const corrected = projectReorgObservation({
      priorObservation: prior,
      derivation: prior.derivation,
      reorgedBlockHash: prior.derivation.blockHash,
      timestamp: "2026-07-29T12:06:00Z",
      state: beforeReorg.state,
    });
    if (
      corrected.observation === undefined
      || corrected.observation.type
        !== "network.jinn.task-execution.attempt-terminal.v1"
    ) {
      throw new Error(`fixture ${fixture.name} projected no lost correction`);
    }
    const preparation = events.find((event) =>
      event.event === "VerdictDeliveryPrepared"
      && event.facts.expectedRequestId === verdict.facts.requestId
    );
    const delivery = events.find((event) =>
      event.event === "Deliver"
      && event.facts.requestId === verdict.facts.requestId
    );
    if (preparation === undefined || delivery === undefined) {
      throw new Error(`fixture ${fixture.name} projected no atomic verdict receipt`);
    }
    const atomicReceipt = [preparation, delivery, verdict];
    const laterReceipt = atomicReceipt.map((event, logIndex): ObservationMarketplaceEvent => ({
      ...event,
      derivation: {
        ...event.derivation,
        blockNumber: verdict.derivation.blockNumber + 1,
        blockHash: `0x${"8".repeat(64)}`,
        txHash: `0x${"9".repeat(64)}`,
        logIndex,
      },
      projection: {
        ...event.projection,
        timestamp: "2026-07-29T12:10:00Z",
      },
    }));
    const canonicalBeforeVerdict = reduceMarketplaceProjection(
      events.filter((event) => !atomicReceipt.includes(event)),
      createMarketplaceProjectionState(),
    ).state;
    const later = reduceMarketplaceProjection(laterReceipt, {
      ...canonicalBeforeVerdict,
      processedCorrectionIds: corrected.state.processedCorrectionIds,
      sequenceBySourceSubject: corrected.state.sequenceBySourceSubject,
    });
    const laterTerminal = later.observations.find((observation) =>
      observation.type === "network.jinn.task-execution.attempt-terminal.v1"
    );
    if (
      laterTerminal === undefined
      || laterTerminal.type
        !== "network.jinn.task-execution.attempt-terminal.v1"
    ) {
      throw new Error(`fixture ${fixture.name} projected no later terminal`);
    }
    const raw = [engaged, prior, corrected.observation];
    const rawBytes = raw.map((observation) => JSON.stringify(observation));
    const orphaned = new Set([prior.derivation.blockHash]);
    const canonical = selectCanonicalMarketplaceObservations(raw, orphaned);
    let missingProvenanceRefused = false;
    const missing = { ...engaged } as ProtocolObservation;
    delete (missing as { derivation?: unknown }).derivation;
    try {
      selectCanonicalMarketplaceObservations([missing], new Set());
    } catch {
      missingProvenanceRefused = true;
    }
    const duplicateTarget = structuredClone(prior);
    const wrongSource = {
      ...corrected.observation,
      source: `${corrected.observation.source}:wrong`,
    } as ProtocolObservation;
    const wrongSubject = {
      ...corrected.observation,
      subject: `${corrected.observation.subject}:wrong`,
    } as ProtocolObservation;
    const wrongTargetBlock = {
      ...prior,
      derivation: {
        ...prior.derivation,
        blockHash: `0x${"a".repeat(64)}`,
      },
    } as ProtocolObservation;
    const invalidCorrectionsRefused = {
      absentTarget: refuses(() =>
        selectCanonicalMarketplaceObservations(
          [corrected.observation!],
          orphaned,
        )
      ),
      duplicateTarget: refuses(() =>
        selectCanonicalMarketplaceObservations(
          [engaged, prior, duplicateTarget, corrected.observation!],
          orphaned,
        )
      ),
      nonOrphanedHash: refuses(() =>
        selectCanonicalMarketplaceObservations(raw, new Set())
      ),
      wrongSource: refuses(() =>
        selectCanonicalMarketplaceObservations(
          [engaged, prior, wrongSource],
          orphaned,
        )
      ),
      wrongSubject: refuses(() =>
        selectCanonicalMarketplaceObservations(
          [engaged, prior, wrongSubject],
          orphaned,
        )
      ),
      wrongTargetBlock: refuses(() =>
        selectCanonicalMarketplaceObservations(
          [engaged, wrongTargetBlock, corrected.observation!],
          orphaned,
        )
      ),
      mismatchedDerivation: refuses(() =>
        projectReorgObservation({
          priorObservation: prior,
          derivation: {
            ...prior.derivation,
            event: "TaskAttemptCreated",
          },
          reorgedBlockHash: prior.derivation.blockHash,
          timestamp: "2026-07-29T12:06:00Z",
          state: beforeReorg.state,
        })
      ),
    };
    return {
      priorObservation: prior,
      priorBytesBefore,
      priorBytesAfter: encoder.encode(JSON.stringify(prior)),
      lostObservation: corrected.observation,
      laterTerminal,
      rawFolded: foldObservations(raw),
      canonicalLostFolded: foldCanonicalMarketplaceObservations(
        raw,
        orphaned,
      ),
      folded: foldCanonicalMarketplaceObservations(
        [...raw, laterTerminal],
        orphaned,
      ),
      canonicalPreservedRaw:
        canonical[0] === engaged
        && canonical[1] === corrected.observation
        && raw.map((observation) => JSON.stringify(observation))
          .every((bytes, index) => bytes === rawBytes[index]),
      missingProvenanceRefused,
      invalidCorrectionsRefused,
    };
  },

  async verifyDerivation(
    fixture: MarketplaceProjectorFixture,
    derivation: ProjectedDerivation,
    substrateOutcome: DerivationOutcome,
  ) {
    const run = await projectFixtureInternal(fixture);
    const projected = run.projectedBatches[0]!;
    const exactAvailable = projected.announcements.find((announcement) =>
      announcement.action === "available"
      && announcement.derivation.txHash === derivation.txHash
      && announcement.derivation.logIndex === derivation.logIndex
    );
    if (
      exactAvailable === undefined
      || exactAvailable.action !== "available"
    ) {
      throw new Error(`fixture ${fixture.name} projected no matching availability`);
    }
    const signedEntry = projected.entries.find(({ entry }) =>
      entry.announcements.some((announcement) =>
        announcement.announcementId === exactAvailable.announcementId
      )
    );
    if (signedEntry === undefined) {
      throw new Error(`fixture ${fixture.name} projected no citing entry`);
    }
    const sealedEntry = sealJson(signedEntry.entry);
    const item: AnnouncedItem = {
      record: exactAvailable.record,
      facts: exactAvailable.facts,
      locations: exactAvailable.locations,
      provenance: {
        source: signedEntry.entry.source,
        entry: sealedEntry.digest,
        announcementId: exactAvailable.announcementId,
        derivation: exactAvailable.derivation,
      },
    };
    const outcome = await verifyItem({
      item,
      decisionGrade: true,
      ports: {
        records: {
          async "fetch"(digest) {
            if (digest !== recordDigest(SUBMISSION_BYTES)) {
              throw new Error(`unexpected record digest: ${digest}`);
            }
            return SUBMISSION_BYTES;
          },
        },
        entries: {
          async "fetch"(digest) {
            if (digest !== sealedEntry.digest) {
              throw new Error(`unexpected entry digest: ${digest}`);
            }
            return sealedEntry.bytes;
          },
        },
        keys: {
          async resolve() { return []; },
          async everBound() { return false; },
        },
        sigs: { async verify() { return false; } },
        factsRecompute: ports().factsRecompute,
        substrate: {
          async check(received) {
            if (JSON.stringify(received) !== JSON.stringify(derivation)) {
              throw new Error("discovery verification did not receive the exact projected derivation");
            }
            return substrateOutcome;
          },
        },
        async verifiedChain(cursor) {
          return cursor.sequence === signedEntry.entry.sequence
            && cursor.entry === sealedEntry.digest;
        },
      },
    });
    if (outcome.status !== "verified" || outcome.derivation === undefined) {
      throw new Error(
        `discovery item verification failed for ${fixture.name}: ${outcome.status}`,
      );
    }
    return outcome.derivation;
  },
};

describeMarketplaceProjectorConformance(subject);
describeMarketplaceProjectorIdentityConformance({ ports, incrementalPorts });
