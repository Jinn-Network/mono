// SPDX-License-Identifier: MIT

import {
  formatOrigin,
  formatSequence,
  MEDIA_ENTRY,
  RECORD_DISCOVERY_VERSION,
  sealJson,
  nextSequence,
  type AnnouncementEntry,
} from "@jinn-network/record-discovery-protocol";
import {
  maintainHead,
  writeRecord,
  type SignedEntry,
} from "@jinn-network/record-discovery-serve";
import {
  foldObservations,
  type DerivedAttemptState,
  type ProtocolObservation,
} from "@jinn-network/task-execution-protocol";
import type { Hex } from "viem";
import {
  signAnnouncementEntry,
  type AnnouncementProjectionPorts,
  type AnnouncementProjectionResult,
  type ProjectedAnnouncement,
  type ScopedDiscoverySigner,
} from "./announce.js";
import type { DerivationAnnotation, FinalityTier } from "./derivation.js";
import {
  cloneMarketplaceProjectionState,
  nextMarketplaceObservationSequence,
  type MarketplaceProtocolObservation,
  type MarketplaceProjectionState,
} from "./observe.js";

export interface FinalityPolicyOptions {
  /** Default `safe`; `finalized` is the explicit stricter published profile. */
  readonly announceAt?: FinalityTier;
}

export interface FinalityDecision {
  readonly tier: FinalityTier;
  readonly announce: boolean;
  readonly gateExecution: boolean;
}

/** Safe is the default publication threshold; decision-grade compute remains finalized-gated. */
export function finalityPolicy(
  event: Pick<DerivationAnnotation, "finalityTier">,
  options: FinalityPolicyOptions = {},
): FinalityDecision {
  const announceAt = options.announceAt ?? "safe";
  const isFinalized = event.finalityTier === "finalized";
  return {
    tier: event.finalityTier,
    announce: announceAt === "safe" || isFinalized,
    gateExecution: isFinalized,
  };
}

type AvailableProjectedAnnouncement = Extract<
  ProjectedAnnouncement,
  { action: "available" }
>;

/**
 * Produces a new retraction for a now-orphaned availability. The prior value is never changed;
 * callers append the returned action in the next signed source entry.
 */
export function reorgCorrection(
  prior: AvailableProjectedAnnouncement,
  reorgedBlockHash: Hex,
): Extract<ProjectedAnnouncement, { action: "withdrawn" }> {
  if (prior.derivation.blockHash !== reorgedBlockHash) {
    throw new Error(
      `reorged block ${reorgedBlockHash} does not match prior derivation block ${prior.derivation.blockHash}`,
    );
  }
  return {
    announcementId:
      `${prior.announcementId}-reorged-${reorgedBlockHash.slice(2)}`,
    action: "withdrawn",
    retracts: prior.announcementId,
    reason: "reorged",
    derivation: prior.derivation,
  };
}

export interface AppendSignedReorgCorrectionInput {
  readonly priorEntry: AnnouncementEntry;
  readonly prior: AvailableProjectedAnnouncement;
  readonly reorgedBlockHash: Hex;
  readonly timestamp: string;
  readonly signer: ScopedDiscoverySigner;
}

/** Appends the correction at sequence+1 and signs the new entry under the discovery scope. */
export async function appendSignedReorgCorrection(
  input: AppendSignedReorgCorrectionInput,
): Promise<SignedEntry> {
  const correction = reorgCorrection(input.prior, input.reorgedBlockHash);
  const entry: AnnouncementEntry = {
    protocol: input.priorEntry.protocol,
    source: { ...input.priorEntry.source },
    sequence: nextSequence(input.priorEntry.sequence),
    previous: sealJson(input.priorEntry).digest,
    timestamp: input.timestamp,
    announcements: [correction],
  };
  return {
    entry,
    signature: await signAnnouncementEntry(entry, input.signer),
  };
}

/**
 * Publishes one signed, append-only withdrawal per displaced active availability. The ordinary
 * availability entries stay byte-for-byte intact in the archive; only this later chain suffix
 * changes the canonical view. `ProjectorCursorStore` records the matching local retractions in
 * the same transaction as its rebuilt state/cursor.
 */
export async function appendSignedReorgCorrections(input: {
  readonly priors: readonly AvailableProjectedAnnouncement[];
  readonly ports: AnnouncementProjectionPorts;
}): Promise<AnnouncementProjectionResult> {
  if (input.priors.length === 0) {
    return {
      announcements: [],
      entries: [],
      pages: [],
      refusals: [],
      ...(input.ports.previousHead === undefined ? {} : { head: input.ports.previousHead }),
    };
  }
  const previousHead = input.ports.previousHead;
  const previousEntryDigest = input.ports.previousEntryDigest;
  if (previousHead === undefined || previousEntryDigest === undefined || previousEntryDigest === null) {
    throw new Error("reorg correction requires a persisted append-only discovery head");
  }
  if (input.ports.appendArchiveEntries === undefined) {
    throw new Error("reorg correction requires an append-aware archive writer");
  }
  if (previousEntryDigest !== previousHead.entry) {
    throw new Error("reorg correction previousEntryDigest must match previousHead.entry");
  }
  const expectedOrigin = formatOrigin(input.ports.source.agent, input.ports.source.name);
  if (previousHead.origin !== expectedOrigin) {
    throw new Error("reorg correction previousHead origin does not match projector source");
  }

  let sequence = input.ports.initialSequence ?? (BigInt(previousHead.sequence) + 1n);
  if (sequence !== BigInt(previousHead.sequence) + 1n) {
    throw new Error("reorg correction sequence must immediately follow previousHead");
  }
  let previous = previousEntryDigest;
  const entries: SignedEntry[] = [];
  const announcements: ProjectedAnnouncement[] = [];
  for (const prior of input.priors) {
    const correction = reorgCorrection(prior, prior.derivation.blockHash);
    const entry: AnnouncementEntry = {
      protocol: RECORD_DISCOVERY_VERSION,
      source: input.ports.source,
      sequence: formatSequence(sequence),
      previous,
      timestamp: input.ports.clock.now().toISOString(),
      announcements: [correction],
    };
    const signature = await signAnnouncementEntry(entry, input.ports.signer);
    const sealed = sealJson(entry);
    await writeRecord(input.ports.store, sealed.bytes, MEDIA_ENTRY);
    entries.push({ entry, signature });
    announcements.push(correction);
    previous = sealed.digest;
    sequence += 1n;
  }

  const { pages } = await input.ports.appendArchiveEntries({
    source: input.ports.source,
    previousHead,
    entries,
  });
  const tip = entries.at(-1)!.entry;
  const maintained = await maintainHead(
    input.ports.store,
    input.ports.signer,
    input.ports.clock,
    input.ports.source,
    { ...previousHead, sequence: tip.sequence, entry: sealJson(tip).digest },
  );
  return {
    announcements,
    entries,
    pages,
    refusals: [],
    head: maintained.head,
    ...(maintained.envelope === undefined ? {} : { headEnvelope: maintained.envelope }),
  };
}

const ATTEMPT_SCOPED_TYPES = new Set<ProtocolObservation["type"]>([
  "network.jinn.task-execution.attempt-engaged.v1",
  "network.jinn.task-execution.attempt-started.v1",
  "network.jinn.task-execution.progress.v1",
  "network.jinn.task-execution.cancel-requested.v1",
  "network.jinn.task-execution.cancel-acknowledged.v1",
  "network.jinn.task-execution.execution-observed.v1",
  "network.jinn.task-execution.delivery-recorded.v1",
  "network.jinn.task-execution.attempt-terminal.v1",
]);

export interface ProjectReorgObservationInput {
  readonly priorObservation: ProtocolObservation;
  readonly derivation: DerivationAnnotation;
  readonly reorgedBlockHash: Hex;
  readonly timestamp: string;
  readonly state: MarketplaceProjectionState;
}

export interface ReorgObservationTransition {
  readonly state: MarketplaceProjectionState;
  readonly observation?: MarketplaceProtocolObservation;
}

/**
 * Applies ruling §7.30. Attempt facts receive an append-only `lost` terminal on the same
 * authoritative stream. Submission facts receive no invented TEP admission/closure outcome;
 * their signed discovery retraction and canonical query exclusion are the correction.
 */
export function projectReorgObservation(
  input: ProjectReorgObservationInput,
): ReorgObservationTransition {
  const priorDerivation = exactDerivation(
    (input.priorObservation as MarketplaceProtocolObservation).derivation,
  );
  const suppliedDerivation = exactDerivation(input.derivation);
  if (!sameDerivation(priorDerivation, suppliedDerivation)) {
    throw new Error(
      "reorg derivation does not exactly match prior observation derivation",
    );
  }
  if (input.derivation.blockHash !== input.reorgedBlockHash) {
    throw new Error(
      `reorged block ${input.reorgedBlockHash} does not match prior derivation block ${input.derivation.blockHash}`,
    );
  }
  if (!ATTEMPT_SCOPED_TYPES.has(input.priorObservation.type)) {
    return { state: cloneMarketplaceProjectionState(input.state) };
  }

  const correctionId =
    `reorg:${input.priorObservation.id}:${input.reorgedBlockHash}`;
  if (input.state.processedCorrectionIds.includes(correctionId)) {
    return { state: cloneMarketplaceProjectionState(input.state) };
  }

  const state = cloneMarketplaceProjectionState(input.state);
  state.processedCorrectionIds.push(correctionId);
  const sequence = nextMarketplaceObservationSequence(
    state,
    input.priorObservation.source,
    input.priorObservation.subject,
    input.priorObservation.sequence,
  );
  const observation: MarketplaceProtocolObservation = {
    specversion: "1.0",
    id: correctionId,
    source: input.priorObservation.source,
    subject: input.priorObservation.subject,
    time: input.timestamp,
    datacontenttype: "application/json",
    sequence,
    ...(input.priorObservation.taskdigest === undefined
      ? {}
      : { taskdigest: input.priorObservation.taskdigest }),
    derivation: input.derivation,
    correction: {
      retractsObservationId: input.priorObservation.id,
      orphanedBlockHash: input.reorgedBlockHash,
    },
    type: "network.jinn.task-execution.attempt-terminal.v1",
    data: { state: "lost" },
  };
  return { state, observation };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactDerivation(value: unknown): DerivationAnnotation {
  if (!isRecord(value)) {
    throw new Error("marketplace observation is missing exact derivation provenance");
  }
  if (
    !Number.isSafeInteger(value["chainId"])
    || (value["chainId"] as number) < 0
    || typeof value["contract"] !== "string"
    || !/^0x[0-9a-fA-F]{40}$/u.test(value["contract"])
    || typeof value["event"] !== "string"
    || value["event"].length === 0
    || !Number.isSafeInteger(value["blockNumber"])
    || (value["blockNumber"] as number) < 0
    || typeof value["blockHash"] !== "string"
    || !/^0x[0-9a-fA-F]{64}$/u.test(value["blockHash"])
    || typeof value["txHash"] !== "string"
    || !/^0x[0-9a-fA-F]{64}$/u.test(value["txHash"])
    || !Number.isSafeInteger(value["logIndex"])
    || (value["logIndex"] as number) < 0
    || (value["finalityTier"] !== "safe"
      && value["finalityTier"] !== "finalized")
    || (value["contractGeneration"] !== "today"
      && value["contractGeneration"] !== "revised")
  ) {
    throw new Error("marketplace observation is missing exact derivation provenance");
  }
  return value as unknown as DerivationAnnotation;
}

function sameDerivation(
  left: DerivationAnnotation,
  right: DerivationAnnotation,
): boolean {
  return left.chainId === right.chainId
    && left.contract === right.contract
    && left.event === right.event
    && left.blockNumber === right.blockNumber
    && left.blockHash === right.blockHash
    && left.txHash === right.txHash
    && left.logIndex === right.logIndex
    && left.finalityTier === right.finalityTier
    && left.contractGeneration === right.contractGeneration;
}

/**
 * Selects the current canonical marketplace view while returning the original observation
 * objects unchanged. Ordinary orphaned facts are excluded; explicit lost corrections remain.
 */
export function selectCanonicalMarketplaceObservations(
  raw: readonly ProtocolObservation[],
  orphanedBlockHashes: ReadonlySet<string>,
): MarketplaceProtocolObservation[] {
  const orphaned = new Set(
    [...orphanedBlockHashes].map((hash) => hash.toLowerCase()),
  );
  const indexed = raw.map((observation) => {
    const candidate = observation as MarketplaceProtocolObservation;
    return {
      candidate,
      derivation: exactDerivation(candidate.derivation),
    };
  });
  const ordinaryById = new Map<
    string,
    Array<(typeof indexed)[number]>
  >();
  for (const item of indexed) {
    if (item.candidate.correction === undefined) {
      const matches = ordinaryById.get(item.candidate.id) ?? [];
      matches.push(item);
      ordinaryById.set(item.candidate.id, matches);
    }
  }

  const selected: MarketplaceProtocolObservation[] = [];
  for (const { candidate, derivation } of indexed) {
    if (candidate.correction !== undefined) {
      const correction = candidate.correction;
      if (
        !isRecord(correction)
        || typeof correction.retractsObservationId !== "string"
        || correction.retractsObservationId.length === 0
        || typeof correction.orphanedBlockHash !== "string"
        || !/^0x[0-9a-fA-F]{64}$/u.test(correction.orphanedBlockHash)
        || correction.orphanedBlockHash !== derivation.blockHash
        || candidate.type
          !== "network.jinn.task-execution.attempt-terminal.v1"
        || candidate.data.state !== "lost"
      ) {
        throw new Error("marketplace reorg correction metadata is invalid");
      }
      if (!orphaned.has(correction.orphanedBlockHash.toLowerCase())) {
        throw new Error(
          "marketplace reorg correction is outside the orphaned-hash substrate",
        );
      }
      const targets = ordinaryById.get(correction.retractsObservationId) ?? [];
      if (targets.length !== 1) {
        throw new Error(
          "marketplace reorg correction must resolve exactly one ordinary target",
        );
      }
      const target = targets[0]!;
      if (
        target.candidate.source !== candidate.source
        || target.candidate.subject !== candidate.subject
      ) {
        throw new Error(
          "marketplace reorg correction source and subject must match its target",
        );
      }
      if (target.derivation.blockHash !== correction.orphanedBlockHash) {
        throw new Error(
          "marketplace reorg correction target derivation block does not match",
        );
      }
      selected.push(candidate);
      continue;
    }
    if (!orphaned.has(derivation.blockHash.toLowerCase())) {
      selected.push(candidate);
    }
  }
  return selected;
}

/** Applies the unchanged generic TEP fold only after marketplace canonical selection. */
export function foldCanonicalMarketplaceObservations(
  raw: readonly ProtocolObservation[],
  orphanedBlockHashes: ReadonlySet<string>,
): DerivedAttemptState {
  return foldObservations(
    selectCanonicalMarketplaceObservations(raw, orphanedBlockHashes),
  );
}
