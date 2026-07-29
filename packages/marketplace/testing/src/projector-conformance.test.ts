// SPDX-License-Identifier: MIT

import {
  DISCOVERY_SIGNING_SCOPE,
  RECORD_KINDS,
  sealJson,
  type FactsRecompute,
} from "@jinn-network/record-discovery-protocol";
import type { BlobStore } from "@jinn-network/record-discovery-serve";
import {
  REVISED_PROJECTOR_EVENTS_ABI,
  appendSignedReorgCorrection,
  decodeMarketplaceLogs,
  projectAnnouncements,
  projectObservations,
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
  type MarketplaceProjectorConformanceSubject,
  type MarketplaceProjectorFixture,
  type MarketplaceProjectorReorgFixture,
} from "./projector-conformance.js";

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

function asFixtureLogs(fixture: {
  readonly logs: readonly unknown[];
}): FixtureLog[] {
  return fixture.logs as FixtureLog[];
}

function abiEvent(name: string): AbiEvent {
  const event = REVISED_PROJECTOR_EVENTS_ABI.find((item) =>
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
    fixture.generation,
  );
  if (decoded.length !== logs.length) {
    throw new Error(`fixture ${fixture.name} did not decode one event per log`);
  }
  return decoded.map((event, index) => ({
    ...event,
    projection: logs[index]!.projection,
  })) as ObservationMarketplaceEvent[];
}

function ports(): AnnouncementProjectionPorts {
  const store: BlobStore = { async put() {} };
  const signer: ScopedDiscoverySigner = {
    scope: DISCOVERY_SIGNING_SCOPE,
    async sign() {
      return [{ keyid: "did:key:zMarketplaceProjectorFixture", sig: new Uint8Array([1, 2, 3]) }];
    },
  };
  const factsRecompute: FactsRecompute = {
    get(kind) {
      if (kind !== RECORD_KINDS.submission) return undefined;
      return async () => ({
        taskDigest: `sha256:${"7".repeat(64)}`,
        taskProfileUri: "https://jinn.network/task-profiles/repository-work/1.0",
        requesterIri: "did:key:zRequesterFixture",
        deadline: "2026-07-30T12:00:00Z",
      });
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
    async resolveRecord(_event, role) {
      if (role !== "submission") {
        throw new Error(`fixture has no ${role} record`);
      }
      return {
        kind: RECORD_KINDS.submission,
        bytes: SUBMISSION_BYTES,
        mediaType: "application/vnd.jinn.task-execution.submission.v1+json",
      };
    },
  };
}

const subject: MarketplaceProjectorConformanceSubject = {
  async project(fixture) {
    const events = enrichedEvents(fixture);
    const observations = projectObservations(events);
    const projected = await projectAnnouncements(events, ports());
    const announcements = projected.announcements;
    return {
      observations,
      announcements,
      derivations: events.map((event) => event.derivation),
      observationBytes: encoder.encode(JSON.stringify(observations)),
      announcementBytes: encoder.encode(JSON.stringify(announcements)),
    };
  },

  async projectReorg(fixture) {
    const events = enrichedEvents(fixture);
    const projected = await projectAnnouncements(events, ports());
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
    return {
      priorEntry,
      priorEntryBytesBefore: before.bytes,
      priorEntryBytesAfter: after.bytes,
      priorAnnouncementId: prior.announcementId,
      correctionEntry: signed.entry,
      correctionEntryBytes: correction.bytes,
      expectedPreviousDigest: before.digest,
      signatureCount: signed.signature?.signatures.length ?? 0,
    };
  },
};

describeMarketplaceProjectorConformance(subject);
