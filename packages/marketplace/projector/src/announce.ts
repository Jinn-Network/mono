// SPDX-License-Identifier: MIT

import {
  DISCOVERY_SIGNING_SCOPE,
  MEDIA_ENTRY,
  RECORD_DISCOVERY_VERSION,
  RECORD_KINDS,
  dssePreAuthEncoding,
  formatOrigin,
  formatSequence,
  sealJson,
  type Announcement,
  type AnnouncementEntry,
  type AvailableAnnouncement,
  type FactsRecompute,
  type PublishedLocation,
  type ReferencedBytes,
  type SourceHead,
  type SourceIdentity,
  type WithdrawnAnnouncement,
} from "@jinn-network/record-discovery-protocol";
import {
  maintainHead,
  writeArchivePages,
  writeRecord,
  type BlobStore,
  type Clock,
  type DsseEnvelope,
  type DsseSigner,
  type SignedEntry,
} from "@jinn-network/record-discovery-serve";
import type { DerivationAnnotation } from "./derivation.js";
import type { MarketplaceEvent } from "./events.js";
import {
  projectObservations,
  type ObservationMarketplaceEvent,
} from "./observe.js";

export interface ScopedDiscoverySigner extends DsseSigner {
  readonly scope: typeof DISCOVERY_SIGNING_SCOPE;
}

export type AnnouncementRecordRole =
  | "submission"
  | "delivery"
  | "evaluation-delivery";

export interface AnnouncementRecordMaterial {
  readonly kind: string;
  readonly bytes: Uint8Array;
  readonly mediaType?: string;
  readonly locations?: PublishedLocation[];
}

export interface AnnouncementProjectionPorts {
  readonly source: SourceIdentity;
  readonly signer: ScopedDiscoverySigner;
  readonly store: BlobStore;
  readonly clock: Clock;
  readonly factsRecompute: FactsRecompute;
  readonly referencedBytes: ReferencedBytes;
  readonly resolveRecord: (
    event: ObservationMarketplaceEvent,
    role: AnnouncementRecordRole,
  ) => Promise<AnnouncementRecordMaterial>;
  /** Existing chain position for an incremental append; omitted only at genesis. */
  readonly previousHead?: SourceHead;
  readonly previousEntryDigest?: `sha256:${string}` | null;
  readonly initialSequence?: bigint;
  /** Host lookup for a prior availability when this batch did not itself announce it. */
  readonly resolvePriorAnnouncementId?: (
    event: ObservationMarketplaceEvent,
    role: "submission" | "delivery",
  ) => Promise<string | undefined>;
}

export type ProjectedAnnouncement =
  | (AvailableAnnouncement & { readonly derivation: DerivationAnnotation })
  | (WithdrawnAnnouncement & { readonly derivation: DerivationAnnotation });

export interface AnnouncementProjectionResult {
  readonly announcements: ProjectedAnnouncement[];
  readonly entries: SignedEntry[];
  readonly pages: string[];
  readonly head?: SourceHead;
  readonly headEnvelope?: DsseEnvelope;
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function signEntry(
  entry: AnnouncementEntry,
  signer: ScopedDiscoverySigner,
): Promise<DsseEnvelope> {
  const { bytes } = sealJson(entry);
  const signatures = await signer.sign(dssePreAuthEncoding(MEDIA_ENTRY, bytes));
  return {
    payloadType: MEDIA_ENTRY,
    payload: encodeBase64(bytes),
    signatures: signatures.map((signature) => ({
      ...(signature.keyid === undefined ? {} : { keyid: signature.keyid }),
      sig: encodeBase64(signature.sig),
    })),
  };
}

function taskKey(event: ObservationMarketplaceEvent, taskId: bigint): string {
  return `${event.derivation.chainId}:${event.derivation.contract.toLowerCase()}:${taskId}`;
}

function observationId(
  event: ObservationMarketplaceEvent,
  type: string,
): string {
  return `${event.derivation.txHash}:${event.derivation.logIndex}:${type}`;
}

function announcementId(
  event: ObservationMarketplaceEvent,
  role: string,
  action: "available" | "withdrawn",
): string {
  return [
    "ann",
    event.derivation.chainId,
    event.derivation.txHash.slice(2),
    event.derivation.logIndex,
    role,
    action,
  ].join("-");
}

function sortedDefinedFacts(
  facts: Record<string, string | number | boolean | undefined>,
): Record<string, string | number | boolean> {
  const result: Record<string, string | number | boolean> = {};
  for (const key of Object.keys(facts).sort()) {
    const value = facts[key];
    if (value !== undefined) result[key] = value;
  }
  return result;
}

function submissionTerms(
  event: Extract<MarketplaceEvent, { event: "TaskCreated" | "AttemptsAdded" }>,
): Record<string, string> {
  if (event.event === "AttemptsAdded") {
    return {
      contractGeneration: event.derivation.contractGeneration,
      maxTotal: String(event.facts.newMaxTotal),
    };
  }
  if ("maxClaims" in event.facts) {
    return {
      contractGeneration: "today",
      maxTotal: String(event.facts.maxClaims),
      solutionBudgetWei: event.facts.solutionBudget.toString(),
      verdictBudgetWei: event.facts.verdictBudget.toString(),
    };
  }
  return {
    contractGeneration: "revised",
    maxTotal: String(event.facts.maxTotal),
    maxConcurrent: String(event.facts.maxConcurrent),
    submissionDeadline: event.facts.submissionDeadline.toString(),
    ...(event.facts.closeAt === 0n ? {} : { closeAt: event.facts.closeAt.toString() }),
    responseTimeout: event.facts.responseTimeout.toString(),
    minVerdicts: String(event.facts.minVerdicts),
    requireDistinctEvaluator: String(event.facts.requireDistinctEvaluator),
    solutionMaxDeliveryRateWei: event.facts.solutionMaxDeliveryRate.toString(),
    verdictMaxDeliveryRateWei: event.facts.verdictMaxDeliveryRate.toString(),
    solutionBudgetWei: event.facts.solutionBudget.toString(),
    verdictBudgetWei: event.facts.verdictBudget.toString(),
  };
}

async function availableAnnouncement(
  event: ObservationMarketplaceEvent,
  role: AnnouncementRecordRole,
  ports: AnnouncementProjectionPorts,
): Promise<ProjectedAnnouncement> {
  const material = await ports.resolveRecord(event, role);
  const expectedKind = role === "submission"
    ? RECORD_KINDS.submission
    : RECORD_KINDS.delivery;
  if (material.kind !== expectedKind) {
    throw new Error(
      `record resolver returned kind "${material.kind}" for ${role}; expected "${expectedKind}"`,
    );
  }

  const recompute = ports.factsRecompute.get(material.kind);
  if (recompute === undefined) {
    throw new Error(`no injected FactsRecompute function for record kind "${material.kind}"`);
  }
  const recordFacts = sortedDefinedFacts(
    await recompute(material.bytes, ports.referencedBytes),
  );
  const stored = await writeRecord(
    ports.store,
    material.bytes,
    material.mediaType,
  );
  const facts = role === "submission"
    && (event.event === "TaskCreated" || event.event === "AttemptsAdded")
    ? { ...recordFacts, terms: submissionTerms(event) }
    : recordFacts;

  return {
    announcementId: announcementId(event, role, "available"),
    action: "available",
    record: {
      kind: material.kind,
      digest: stored.digest,
      ...(material.mediaType === undefined ? {} : { mediaType: material.mediaType }),
    },
    ...(material.locations === undefined ? {} : { locations: material.locations }),
    facts,
    derivation: event.derivation,
  };
}

async function priorAvailability(
  event: ObservationMarketplaceEvent,
  role: "submission" | "delivery",
  known: ReadonlyMap<string, string>,
  ports: AnnouncementProjectionPorts,
): Promise<string | undefined> {
  const taskId = "taskId" in event.facts ? event.facts.taskId : undefined;
  if (taskId !== undefined) {
    const local = known.get(`${taskKey(event, taskId)}:${role}`);
    if (local !== undefined) return local;
  }
  return ports.resolvePriorAnnouncementId?.(event, role);
}

async function withdrawnAnnouncement(
  event: ObservationMarketplaceEvent,
  role: "submission" | "delivery",
  reason: WithdrawnAnnouncement["reason"],
  known: ReadonlyMap<string, string>,
  ports: AnnouncementProjectionPorts,
): Promise<ProjectedAnnouncement | undefined> {
  const retracts = await priorAvailability(event, role, known, ports);
  if (retracts === undefined) return undefined;
  return {
    announcementId: announcementId(event, role, "withdrawn"),
    action: "withdrawn",
    retracts,
    reason,
    derivation: event.derivation,
  };
}

/**
 * Projects signed discovery entries from the same ordered event facts passed to
 * `projectObservations`. Record facts are always recomputed from exact resolver bytes through
 * the injected registry; callers cannot supply a precomputed record-facts card.
 */
export async function projectAnnouncements(
  events: readonly ObservationMarketplaceEvent[],
  ports: AnnouncementProjectionPorts,
): Promise<AnnouncementProjectionResult> {
  if (ports.signer.scope !== DISCOVERY_SIGNING_SCOPE) {
    throw new Error(
      `projector signer must be bound to DISCOVERY_SIGNING_SCOPE "${DISCOVERY_SIGNING_SCOPE}"`,
    );
  }
  const initialSequence = ports.initialSequence ?? 1n;
  const initialPrevious = ports.previousEntryDigest ?? null;
  if (initialSequence > 1n && initialPrevious === null) {
    throw new Error("non-genesis announcement sequence requires previousEntryDigest");
  }

  const observationIds = new Set(
    projectObservations(events).map((observation) => observation.id),
  );
  const announcements: ProjectedAnnouncement[] = [];
  const entries: SignedEntry[] = [];
  const known = new Map<string, string>();
  let next = initialSequence;
  let previous = initialPrevious;

  for (const event of events) {
    const projected: ProjectedAnnouncement[] = [];
    switch (event.event) {
      case "TaskCreated": {
        if (
          observationIds.has(
            observationId(event, "network.jinn.task-execution.submission-accepted.v1"),
          )
        ) {
          projected.push(await availableAnnouncement(event, "submission", ports));
        }
        break;
      }

      case "TaskAttemptCreated": {
        if (
          observationIds.has(
            observationId(event, "network.jinn.task-execution.submission-closed.v1"),
          )
        ) {
          const withdrawal = await withdrawnAnnouncement(
            event,
            "submission",
            "delisted",
            known,
            ports,
          );
          if (withdrawal !== undefined) projected.push(withdrawal);
        }
        break;
      }

      case "SolutionDeliveryClaimed": {
        if (
          observationIds.has(
            observationId(event, "network.jinn.task-execution.delivery-recorded.v1"),
          )
        ) {
          projected.push(await availableAnnouncement(event, "delivery", ports));
        }
        break;
      }

      case "VerdictDeliveryClaimed": {
        if (
          observationIds.has(
            observationId(event, "network.jinn.task-execution.attempt-terminal.v1"),
          )
        ) {
          projected.push(
            await availableAnnouncement(event, "evaluation-delivery", ports),
          );
          const withdrawal = await withdrawnAnnouncement(
            event,
            "submission",
            "delisted",
            known,
            ports,
          );
          if (withdrawal !== undefined) projected.push(withdrawal);
        }
        break;
      }

      case "TaskBudgetRefunded":
      case "TaskClosed": {
        const withdrawal = await withdrawnAnnouncement(
          event,
          "submission",
          "delisted",
          known,
          ports,
        );
        if (withdrawal !== undefined) projected.push(withdrawal);
        break;
      }

      case "AttemptsAdded":
        projected.push(await availableAnnouncement(event, "submission", ports));
        break;

      // Claims are graph edges, not availability counters. Mech Deliver is only a join fact;
      // expiry/release terminate Attempts but do not delist a still-open multi-attempt task.
      case "EvaluationAttemptCreated":
      case "Deliver":
      case "AttemptExpired":
      case "AttemptReleased":
        break;
    }

    if (projected.length === 0) continue;
    for (const announcement of projected) {
      if (
        announcement.action === "available"
        && "taskId" in event.facts
      ) {
        const role = announcement.record.kind === RECORD_KINDS.submission
          ? "submission"
          : "delivery";
        known.set(
          `${taskKey(event, event.facts.taskId)}:${role}`,
          announcement.announcementId,
        );
      }
    }

    const entry: AnnouncementEntry = {
      protocol: RECORD_DISCOVERY_VERSION,
      source: ports.source,
      sequence: formatSequence(next),
      previous,
      timestamp: event.projection.timestamp,
      announcements: projected as Announcement[],
    };
    const signature = await signEntry(entry, ports.signer);
    const sealed = sealJson(entry);
    await writeRecord(ports.store, sealed.bytes, MEDIA_ENTRY);
    entries.push({ entry, signature });
    announcements.push(...projected);
    previous = sealed.digest;
    next += 1n;
  }

  if (entries.length === 0) {
    return {
      announcements,
      entries,
      pages: [],
      ...(ports.previousHead === undefined ? {} : { head: ports.previousHead }),
    };
  }

  const { pages } = await writeArchivePages(ports.store, ports.source.name, entries);
  const tip = entries.at(-1)!.entry;
  const tipDigest = sealJson(tip).digest;
  const base: SourceHead = ports.previousHead === undefined
    ? {
        protocol: RECORD_DISCOVERY_VERSION,
        origin: formatOrigin(ports.source.agent, ports.source.name),
        sequence: tip.sequence,
        entry: tipDigest,
        issuedAt: new Date(0).toISOString(),
        refreshBy: new Date(0).toISOString(),
      }
    : {
        ...ports.previousHead,
        sequence: tip.sequence,
        entry: tipDigest,
      };
  const maintained = await maintainHead(
    ports.store,
    ports.signer,
    ports.clock,
    ports.source,
    base,
  );
  return {
    announcements,
    entries,
    pages,
    head: maintained.head,
    ...(maintained.envelope === undefined
      ? {}
      : { headEnvelope: maintained.envelope }),
  };
}
