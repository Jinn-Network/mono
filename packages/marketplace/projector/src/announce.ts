// SPDX-License-Identifier: MIT

import {
  decisionGradeVerdictCode,
  type VerdictObservationFailure,
  type VerdictObservationGate,
} from "@jinn-network/marketplace-binding";
import {
  DISCOVERY_SIGNING_SCOPE,
  MEDIA_ENTRY,
  RECORD_DISCOVERY_VERSION,
  RECORD_KINDS,
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
import { documentDigest } from "@jinn-network/task-execution-protocol";
import {
  maintainHead,
  signAnnouncementEntry,
  writeArchivePages,
  writeRecord,
  type BlobStore,
  type Clock,
  type DsseEnvelope,
  type ScopedDiscoverySigner,
  type SignedEntry,
} from "@jinn-network/record-discovery-serve";
import type { DerivationAnnotation } from "./derivation.js";
import type { MarketplaceEvent } from "./events.js";
import {
  type ObservationMarketplaceEvent,
  type MarketplaceProjectionTransition,
} from "./observe.js";

export { signAnnouncementEntry };
export type { ScopedDiscoverySigner };

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
  readonly verifyVerdictObservation: (
    event: Extract<ObservationMarketplaceEvent, { event: "VerdictDeliveryClaimed" }>,
    material: AnnouncementRecordMaterial,
  ) => Promise<{
    readonly gate: VerdictObservationGate;
    readonly statementVerdict?: "pass" | "fail" | "inconclusive";
  }>;
  /** Existing chain position for an incremental append; omitted only at genesis. */
  readonly previousHead?: SourceHead;
  readonly previousEntryDigest?: `sha256:${string}` | null;
  readonly initialSequence?: bigint;
  /**
   * Required for incremental publication. `serve.writeArchivePages` is a genesis/full-history
   * writer whose page numbering starts at one, so invoking it over only a later batch would
   * overwrite immutable archive paths. The host must inject its append-aware archive writer.
   */
  readonly appendArchiveEntries?: (input: {
    readonly source: SourceIdentity;
    readonly previousHead: SourceHead;
    readonly entries: readonly SignedEntry[];
  }) => Promise<{ readonly pages: string[] }>;
  /** Host lookup for a prior availability when this batch did not itself announce it. */
  readonly resolvePriorAnnouncementId?: (
    event: ObservationMarketplaceEvent,
    role: "submission" | "delivery",
  ) => Promise<string | undefined>;
  /**
   * Optional local-source readback used to recover publication that completed before the daemon
   * cursor transaction did. Entries are immutable archive facts, so this is an exact recovery
   * input rather than a best-effort cache.
   */
  readonly readPublishedArchive?: () => Promise<{
    readonly head?: SourceHead;
    readonly entries: readonly AnnouncementEntry[];
  }>;
}

export type ProjectedAnnouncement =
  | (AvailableAnnouncement & { readonly derivation: DerivationAnnotation })
  | (WithdrawnAnnouncement & { readonly derivation: DerivationAnnotation });

export interface VerdictObservationRefusal {
  readonly kind: "verdict-observation-refused";
  readonly derivation: DerivationAnnotation;
  readonly onChainVerdictCode: number;
  readonly statementVerdict?: "pass" | "fail" | "inconclusive";
  readonly failures: VerdictObservationFailure[];
}

/** A chain-anchor admission failure. It intentionally remains outside Protocol Observation data. */
export interface AnnouncementMaterialRefusal {
  readonly kind: "announcement-material-refused";
  readonly role: AnnouncementRecordRole;
  readonly expectedDigest: `sha256:${string}`;
  readonly actualDigest: `sha256:${string}`;
  readonly derivation: DerivationAnnotation;
  /** Present when a later availability epoch fails the immutable creation anchor. */
  readonly originalAnchorDerivation?: DerivationAnnotation;
}

export interface AnnouncementProjectionResult {
  readonly announcements: ProjectedAnnouncement[];
  readonly entries: SignedEntry[];
  readonly pages: string[];
  readonly refusals: Array<VerdictObservationRefusal | AnnouncementMaterialRefusal>;
  readonly head?: SourceHead;
  readonly headEnvelope?: DsseEnvelope;
}

function taskKey(event: ObservationMarketplaceEvent, taskId: bigint): string {
  return `${event.derivation.chainId}:${event.projection.taskCoordinator.toLowerCase()}:${taskId}`;
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
    // A replacement block can legitimately preserve a transaction/log position. Include the
    // canonical block identity so a re-announced fact after a reorg is a distinct availability,
    // never a collision with the append-only orphaned one it supersedes.
    event.derivation.blockHash.slice(2),
    event.derivation.txHash.slice(2),
    event.derivation.logIndex,
    role,
    action,
  ].join("-");
}

function sortedDefinedFacts(
  facts: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
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

async function availableAnnouncementFromMaterial(
  event: ObservationMarketplaceEvent,
  role: AnnouncementRecordRole,
  material: AnnouncementRecordMaterial,
  ports: AnnouncementProjectionPorts,
  additionalFacts: Record<string, unknown> = {},
): Promise<ProjectedAnnouncement> {
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
  const facts = sortedDefinedFacts(role === "submission"
    && event.event === "TaskCreated"
    ? { ...recordFacts, ...additionalFacts, terms: submissionTerms(event) }
    : { ...recordFacts, ...additionalFacts });

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

function digestFromBytes32(value: string): `sha256:${string}` {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new TypeError(`expected bytes32 sha256 anchor, got ${value}`);
  }
  return `sha256:${value.slice(2).toLowerCase()}`;
}

function expectedMaterialDigest(
  event: ObservationMarketplaceEvent,
  role: AnnouncementRecordRole,
  observationById: ReadonlyMap<string, { readonly data: Record<string, unknown> }>,
): `sha256:${string}` | undefined {
  if (role === "submission" && event.event === "TaskCreated") {
    return event.derivation.contractGeneration === "revised" && "submissionDigest" in event.facts
      ? digestFromBytes32(event.facts.submissionDigest)
      : undefined;
  }
  if (role === "delivery" && event.event === "SolutionDeliveryClaimed") {
    const recorded = observationById.get(
      observationId(event, "network.jinn.task-execution.delivery-recorded.v1"),
    );
    const digest = recorded?.data["digest"];
    return typeof digest === "string" && /^sha256:[0-9a-f]{64}$/.test(digest)
      ? digest as `sha256:${string}`
      : undefined;
  }
  if (
    role === "evaluation-delivery"
    && event.event === "VerdictDeliveryClaimed"
    && event.derivation.contractGeneration === "revised"
    && "evaluationDeliveryDigest" in event.facts
  ) {
    return digestFromBytes32(event.facts.evaluationDeliveryDigest);
  }
  return undefined;
}

function retainedReopeningAnchor(
  event: ObservationMarketplaceEvent,
  transition: MarketplaceProjectionTransition,
): {
  readonly digest: `sha256:${string}`;
  readonly derivation: DerivationAnnotation;
  readonly terms: Record<string, string>;
} | undefined {
  if (
    event.derivation.contractGeneration !== "revised"
    || (event.event !== "AttemptsAdded" && event.event !== "AttemptExpired" && event.event !== "AttemptReleased")
    || !("taskId" in event.facts)
  ) {
    return undefined;
  }
  const task = transition.state.tasks[taskKey(event, event.facts.taskId)];
  if (task?.submissionAnchor === undefined) return undefined;
  return { ...task.submissionAnchor, terms: task.submissionTerms ?? {} };
}

async function anchorCheckedMaterial(
  event: ObservationMarketplaceEvent,
  role: AnnouncementRecordRole,
  ports: AnnouncementProjectionPorts,
  observationById: ReadonlyMap<string, { readonly data: Record<string, unknown> }>,
  refusals: Array<VerdictObservationRefusal | AnnouncementMaterialRefusal>,
  transition: MarketplaceProjectionTransition,
): Promise<AnnouncementRecordMaterial | undefined> {
  const material = await ports.resolveRecord(event, role);
  const anchor = role === "submission" ? retainedReopeningAnchor(event, transition) : undefined;
  const expectedDigest = expectedMaterialDigest(event, role, observationById) ?? anchor?.digest;
  if (expectedDigest !== undefined) {
    const actualDigest = documentDigest(material.bytes);
    if (actualDigest !== expectedDigest) {
      refusals.push({
        kind: "announcement-material-refused",
        role,
        expectedDigest,
        actualDigest,
        derivation: event.derivation,
        ...(anchor === undefined ? {} : { originalAnchorDerivation: anchor.derivation }),
      });
      return undefined;
    }
  }
  return material;
}

function verdictRefusal(
  event: Extract<ObservationMarketplaceEvent, { event: "VerdictDeliveryClaimed" }>,
  failures: VerdictObservationFailure[],
  statementVerdict?: "pass" | "fail" | "inconclusive",
): VerdictObservationRefusal {
  return {
    kind: "verdict-observation-refused",
    derivation: event.derivation,
    onChainVerdictCode: event.facts.verdictCode,
    ...(statementVerdict === undefined ? {} : { statementVerdict }),
    failures,
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
  transition: MarketplaceProjectionTransition,
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
  if (ports.previousHead !== undefined) {
    if (ports.appendArchiveEntries === undefined) {
      throw new Error(
        "incremental announcement publication requires an append-aware archive writer",
      );
    }
    const expectedOrigin = formatOrigin(
      ports.source.agent,
      ports.source.name,
    );
    if (ports.previousHead.origin !== expectedOrigin) {
      throw new Error(
        `previousHead origin "${ports.previousHead.origin}" does not match projector source "${expectedOrigin}"`,
      );
    }
    const expectedSequence = BigInt(ports.previousHead.sequence) + 1n;
    if (initialSequence !== expectedSequence) {
      throw new Error(
        `incremental sequence ${initialSequence} must follow previousHead sequence ${ports.previousHead.sequence}`,
      );
    }
    if (initialPrevious !== ports.previousHead.entry) {
      throw new Error(
        "previousEntryDigest must equal previousHead.entry for incremental publication",
      );
    }
  }

  const observationIds = new Set(
    transition.observations.map((observation) => observation.id),
  );
  const observationById = new Map(
    transition.observations.map((observation) => [
      observation.id,
      { data: observation.data },
    ] as const),
  );
  const announcements: ProjectedAnnouncement[] = [];
  const entries: SignedEntry[] = [];
  const refusals: Array<VerdictObservationRefusal | AnnouncementMaterialRefusal> = [];
  const known = new Map<string, string>();
  let next = initialSequence;
  let previous = initialPrevious;

  for (const event of transition.events) {
    const projected: ProjectedAnnouncement[] = [];
    switch (event.event) {
      case "TaskCreated": {
        if (
          observationIds.has(
            observationId(event, "network.jinn.task-execution.submission-accepted.v1"),
          )
        ) {
          const material = await anchorCheckedMaterial(
            event, "submission", ports, observationById, refusals, transition,
          );
          if (material !== undefined) {
            projected.push(await availableAnnouncementFromMaterial(event, "submission", material, ports, {
              terms: retainedReopeningAnchor(event, transition)?.terms,
            }));
          }
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
          const material = await anchorCheckedMaterial(
            event, "delivery", ports, observationById, refusals, transition,
          );
          if (material !== undefined) {
            projected.push(await availableAnnouncementFromMaterial(event, "delivery", material, ports));
          }
        }
        break;
      }

      case "VerdictDeliveryClaimed": {
        if (
          observationIds.has(
            observationId(event, "network.jinn.task-execution.attempt-terminal.v1"),
          )
        ) {
          const material = await anchorCheckedMaterial(
            event,
            "evaluation-delivery",
            ports,
            observationById,
            refusals,
            transition,
          );
          if (material === undefined) {
            break;
          }
          if (typeof ports.verifyVerdictObservation !== "function") {
            refusals.push(verdictRefusal(event, [{
              check: "verdict-observation-verifier",
              detail: "verifyVerdictObservation port is required for VerdictDeliveryClaimed",
            }]));
            break;
          }

          let verified: Awaited<
            ReturnType<AnnouncementProjectionPorts["verifyVerdictObservation"]>
          >;
          try {
            verified = await ports.verifyVerdictObservation(event, material);
          } catch (cause) {
            refusals.push(verdictRefusal(event, [{
              check: "verdict-observation-verifier",
              detail: `verifyVerdictObservation failed: ${String(cause)}`,
            }]));
            break;
          }
          if (!verified.gate.decisionGrade) {
            refusals.push(
              verdictRefusal(
                event,
                verified.gate.failures,
                verified.statementVerdict,
              ),
            );
            break;
          }
          if (verified.statementVerdict === undefined) {
            refusals.push(verdictRefusal(event, [{
              check: "verdict-correspondence",
              detail: "verified Result Evaluation Statement verdict is missing",
            }]));
            break;
          }

          let expectedCode: number;
          try {
            expectedCode = decisionGradeVerdictCode(verified.statementVerdict);
          } catch (cause) {
            refusals.push(verdictRefusal(event, [{
              check: "verdict-correspondence",
              detail: String(cause),
            }], verified.statementVerdict));
            break;
          }
          if (expectedCode !== event.facts.verdictCode) {
            refusals.push(verdictRefusal(event, [{
              check: "verdict-correspondence",
              detail:
                `Statement verdict "${verified.statementVerdict}" requires code ${expectedCode}; `
                + `on-chain claim carries ${event.facts.verdictCode}`,
            }], verified.statementVerdict));
            break;
          }

          // The material was anchor-admitted before the verifier ran. Rebuild only the facts
          // card with the verified correspondence; writing/signing remains after this gate.
          projected.push(await availableAnnouncementFromMaterial(event, "evaluation-delivery", material, ports, {
            "https://spec.jinn.network/facts/marketplace-verdict-correspondence/v1": {
              onChainVerdictCode: event.facts.verdictCode,
              statementVerdict: verified.statementVerdict,
            },
          }));
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
        if (transition.availabilityOpenedLogIds.includes([
          event.derivation.chainId,
          event.derivation.contract.toLowerCase(),
          event.derivation.blockHash.toLowerCase(),
          event.derivation.txHash.toLowerCase(),
          event.derivation.logIndex,
        ].join(":"))) {
          const material = await anchorCheckedMaterial(
            event, "submission", ports, observationById, refusals, transition,
          );
          if (material !== undefined) {
            projected.push(await availableAnnouncementFromMaterial(event, "submission", material, ports, {
              terms: retainedReopeningAnchor(event, transition)?.terms,
            }));
          }
        }
        break;

      // Claims are graph edges, not availability counters. Mech Deliver is only a join fact;
      // expiry/release terminate Attempts but do not delist a still-open multi-attempt task.
      case "EvaluationAttemptCreated":
      case "Deliver":
      case "AttemptExpired":
      case "AttemptReleased":
        if (transition.availabilityOpenedLogIds.includes([
          event.derivation.chainId,
          event.derivation.contract.toLowerCase(),
          event.derivation.blockHash.toLowerCase(),
          event.derivation.txHash.toLowerCase(),
          event.derivation.logIndex,
        ].join(":"))) {
          const material = await anchorCheckedMaterial(
            event, "submission", ports, observationById, refusals, transition,
          );
          if (material !== undefined) {
            projected.push(await availableAnnouncementFromMaterial(event, "submission", material, ports, {
              terms: retainedReopeningAnchor(event, transition)?.terms,
            }));
          }
        }
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
      } else if (announcement.action === "withdrawn") {
        for (const [key, announcementId] of known) {
          if (announcementId === announcement.retracts) known.delete(key);
        }
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
    const signature = await signAnnouncementEntry(entry, ports.signer);
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
      refusals,
      ...(ports.previousHead === undefined ? {} : { head: ports.previousHead }),
    };
  }

  const { pages } = ports.previousHead === undefined
    ? await writeArchivePages(ports.store, ports.source.name, entries)
    : await ports.appendArchiveEntries!({
        source: ports.source,
        previousHead: ports.previousHead,
        entries,
      });
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
    refusals,
    head: maintained.head,
    ...(maintained.envelope === undefined
      ? {}
      : { headEnvelope: maintained.envelope }),
  };
}
