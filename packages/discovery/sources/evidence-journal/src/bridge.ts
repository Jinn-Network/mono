import type {
  AnnouncementBatch,
  EvidenceRecordAnnouncement,
  EvidenceRecordAnnouncementSource,
} from "@jinn-network/evidence-discovery";
import type {
  EvidenceRecordReference,
} from "@jinn-network/evidence-repository";
import type {
  Announcement,
  SourceIdentity,
} from "@jinn-network/record-discovery-protocol";
import {
  formatOrigin,
  sealJson,
} from "@jinn-network/record-discovery-protocol";
import type {
  CasSnapshot,
  CasWriteResult,
  DurableSourceReceipt,
  DurableSourceWriter,
} from "@jinn-network/record-discovery-serve";

import {
  projectAvailableEvidenceAnnouncement,
  projectWithdrawnAnnouncement,
} from "./project.js";

const MAX_STATE_ATTEMPTS = 32;
const DEFAULT_CONTENT_TYPE = "application/json";

export const EVIDENCE_JOURNAL_PUBLIC_SOURCE_STRATEGY =
  "record-discovery-evidence-journal-v1" as const;

export type EvidenceJournalBridgeStream = "journal" | "withdrawals";

export interface PendingEvidenceJournalBridgeItem {
  readonly announcement: Announcement;
  readonly timestamp: string;
  readonly reference?: EvidenceRecordReference;
}

export interface PendingEvidenceJournalBridgeBatch {
  readonly stream: EvidenceJournalBridgeStream;
  readonly cursor: string;
  readonly items: readonly PendingEvidenceJournalBridgeItem[];
  readonly nextIndex: number;
}

/**
 * Durable host-side cursor and pending-command state. Source sequence, previous entry, signed
 * bytes and append recovery remain exclusively owned by DurableSourceWriter.
 */
export interface EvidenceJournalBridgeState {
  readonly version: 1;
  readonly source: SourceIdentity;
  readonly evidenceSourceId: string;
  readonly strategyId: string;
  readonly journalCursor?: string;
  readonly withdrawalCursor?: string;
  readonly lastTimestamp?: string;
  readonly pending?: PendingEvidenceJournalBridgeBatch;
}

export interface EvidenceJournalBridgeStateStore {
  read(sourceId: string): Promise<CasSnapshot<EvidenceJournalBridgeState> | undefined>;
  compareAndSwap(
    sourceId: string,
    expectedRevision: string | null,
    next: EvidenceJournalBridgeState,
  ): Promise<CasWriteResult>;
}

export interface PublicSourceStrategyStore {
  /** Read-only ownership lookup. Undefined means no strategy has claimed this source. */
  read(sourceId: string): Promise<string | undefined>;
  claim(
    sourceId: string,
    strategyId: string,
  ): Promise<"claimed" | "existing" | "conflict">;
}

export interface DurableSourceAppendIntentInspector {
  hasPending(sourceId: string): Promise<boolean>;
}

export interface ExactEvidenceRecordSource {
  getRecord(reference: EvidenceRecordReference): Promise<Uint8Array | null>;
}

export interface EvidenceJournalBridgeSyncReport {
  readonly available: number;
  readonly withdrawn: number;
  readonly recoveredWriterIntent: boolean;
  readonly journalCursor?: string;
  readonly withdrawalCursor?: string;
}

export interface EvidenceJournalDurableBridge {
  sync(): Promise<EvidenceJournalBridgeSyncReport>;
  readState(): Promise<EvidenceJournalBridgeState | undefined>;
}

export interface EvidenceJournalDurableBridgeOptions {
  readonly source: SourceIdentity;
  /** The private local journal/catalog source identifier; never published. */
  readonly evidenceSourceId: string;
  readonly journal: EvidenceRecordAnnouncementSource;
  readonly withdrawals: EvidenceRecordAnnouncementSource;
  readonly records: ExactEvidenceRecordSource;
  readonly writer: DurableSourceWriter;
  /** Read-only preflight used before a newly claimed strategy may recover the writer. */
  readonly writerIntents: DurableSourceAppendIntentInspector;
  readonly states: EvidenceJournalBridgeStateStore;
  readonly strategies: PublicSourceStrategyStore;
  readonly now: () => Date;
  readonly contentType?: (reference: EvidenceRecordReference) => string;
  readonly strategyId?: string;
}

export class EvidenceJournalBridgeIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvidenceJournalBridgeIntegrityError";
  }
}

export class PublicSourceStrategyConflictError extends Error {
  constructor(readonly sourceId: string) {
    super(`public source ${JSON.stringify(sourceId)} is already owned by another publication strategy`);
    this.name = "PublicSourceStrategyConflictError";
  }
}

function sameSource(left: SourceIdentity, right: SourceIdentity): boolean {
  return left.agent === right.agent && left.name === right.name;
}

function initialState(
  source: SourceIdentity,
  evidenceSourceId: string,
  strategyId: string,
): EvidenceJournalBridgeState {
  return {
    version: 1,
    source: JSON.parse(new TextDecoder().decode(sealJson(source).bytes)) as SourceIdentity,
    evidenceSourceId,
    strategyId,
  };
}

function assertState(
  state: EvidenceJournalBridgeState,
  source: SourceIdentity,
  evidenceSourceId: string,
  strategyId: string,
): void {
  if (
    state.version !== 1
    || !sameSource(state.source, source)
    || state.evidenceSourceId !== evidenceSourceId
    || state.strategyId !== strategyId
  ) {
    throw new EvidenceJournalBridgeIntegrityError(
      "persisted evidence-journal bridge state belongs to another source or strategy",
    );
  }
  const pending = state.pending;
  if (
    pending !== undefined
    && (
      pending.cursor.length === 0
      || pending.nextIndex < 0
      || pending.nextIndex > pending.items.length
    )
  ) {
    throw new EvidenceJournalBridgeIntegrityError("persisted bridge pending batch is invalid");
  }
}

function isExactReceipt(
  receipt: DurableSourceReceipt,
  source: SourceIdentity,
  item: PendingEvidenceJournalBridgeItem,
): boolean {
  if (
    !sameSource(receipt.source, source)
    || receipt.announcementId !== item.announcement.announcementId
  ) return false;
  if (item.announcement.action === "available") {
    return receipt.record?.digest === item.announcement.record.digest;
  }
  return receipt.record === undefined;
}

function nextTimestamp(previous: string | undefined, now: Date, offset: number): string {
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) {
    throw new EvidenceJournalBridgeIntegrityError("bridge clock returned an invalid Date");
  }
  const previousMs = previous === undefined ? Number.NEGATIVE_INFINITY : new Date(previous).getTime();
  if (!Number.isFinite(previousMs) && previous !== undefined) {
    throw new EvidenceJournalBridgeIntegrityError("persisted bridge timestamp is invalid");
  }
  return new Date(Math.max(nowMs, previousMs + 1) + offset).toISOString();
}

function projectBatch(
  stream: EvidenceJournalBridgeStream,
  batch: AnnouncementBatch,
  evidenceSourceId: string,
  lastTimestamp: string | undefined,
  now: Date,
): PendingEvidenceJournalBridgeBatch {
  if (typeof batch.cursor !== "string" || batch.cursor.length === 0) {
    throw new EvidenceJournalBridgeIntegrityError(`${stream} source returned an empty cursor`);
  }
  const projected: { announcement: Announcement; reference?: EvidenceRecordReference }[] = [];
  for (const announcement of batch.announcements) {
    if (announcement.sourceId !== evidenceSourceId) continue;
    if (stream === "journal") {
      if (announcement.kind !== "available") {
        throw new EvidenceJournalBridgeIntegrityError(
          "the available journal yielded a withdrawal; the two durable inputs must remain distinct",
        );
      }
      projected.push({
        announcement: projectAvailableEvidenceAnnouncement(announcement),
        reference: announcement.reference,
      });
    } else if (announcement.kind === "withdrawn") {
      projected.push({ announcement: projectWithdrawnAnnouncement(announcement) });
    }
  }
  return {
    stream,
    cursor: batch.cursor,
    nextIndex: 0,
    items: projected.map((item, index) => ({
      ...item,
      timestamp: nextTimestamp(lastTimestamp, now, index),
    })),
  };
}

export function createEvidenceJournalDurableBridge(
  options: EvidenceJournalDurableBridgeOptions,
): EvidenceJournalDurableBridge {
  const source = JSON.parse(
    new TextDecoder().decode(sealJson(options.source).bytes),
  ) as SourceIdentity;
  const sourceId = formatOrigin(source.agent, source.name);
  const strategyId = options.strategyId ?? EVIDENCE_JOURNAL_PUBLIC_SOURCE_STRATEGY;
  let active: Promise<EvidenceJournalBridgeSyncReport> | undefined;

  async function loadOrCreateState(): Promise<CasSnapshot<EvidenceJournalBridgeState>> {
    for (let attempt = 0; attempt < MAX_STATE_ATTEMPTS; attempt += 1) {
      const existing = await options.states.read(sourceId);
      if (existing !== undefined) {
        assertState(existing.value, source, options.evidenceSourceId, strategyId);
        return existing;
      }
      const created = await options.states.compareAndSwap(
        sourceId,
        null,
        initialState(source, options.evidenceSourceId, strategyId),
      );
      if (created.ok) {
        const stored = await options.states.read(sourceId);
        if (stored === undefined) {
          throw new EvidenceJournalBridgeIntegrityError("bridge state was unreadable after creation");
        }
        return stored;
      }
    }
    throw new EvidenceJournalBridgeIntegrityError("bridge state creation exceeded the CAS retry bound");
  }

  async function replaceState(
    snapshot: CasSnapshot<EvidenceJournalBridgeState>,
    next: EvidenceJournalBridgeState,
  ): Promise<CasSnapshot<EvidenceJournalBridgeState>> {
    assertState(next, source, options.evidenceSourceId, strategyId);
    const result = await options.states.compareAndSwap(sourceId, snapshot.revision, next);
    if (!result.ok) {
      throw new EvidenceJournalBridgeIntegrityError(
        "bridge state changed concurrently; refusing to run two wrappers for one source",
      );
    }
    const stored = await options.states.read(sourceId);
    if (stored === undefined || stored.revision !== result.revision) {
      throw new EvidenceJournalBridgeIntegrityError("bridge state was unreadable after persistence");
    }
    return stored;
  }

  async function finishPending(
    starting: CasSnapshot<EvidenceJournalBridgeState>,
  ): Promise<{ snapshot: CasSnapshot<EvidenceJournalBridgeState>; available: number; withdrawn: number }> {
    let snapshot = starting;
    let available = 0;
    let withdrawn = 0;
    for (;;) {
      const pending = snapshot.value.pending;
      if (pending === undefined) return { snapshot, available, withdrawn };
      if (pending.nextIndex >= pending.items.length) {
        const next: EvidenceJournalBridgeState = {
          ...snapshot.value,
          ...(pending.stream === "journal"
            ? { journalCursor: pending.cursor }
            : { withdrawalCursor: pending.cursor }),
        };
        delete (next as { pending?: PendingEvidenceJournalBridgeBatch }).pending;
        snapshot = await replaceState(snapshot, next);
        continue;
      }

      const item = pending.items[pending.nextIndex]!;
      let record: { bytes: Uint8Array; contentType: string } | undefined;
      if (item.announcement.action === "available") {
        if (item.reference === undefined) {
          throw new EvidenceJournalBridgeIntegrityError("available pending item lost its local reference");
        }
        const bytes = await options.records.getRecord(item.reference);
        if (bytes === null) {
          throw new EvidenceJournalBridgeIntegrityError(
            `exact evidence bytes are unavailable for ${item.reference.digest}`,
          );
        }
        record = {
          bytes,
          contentType: options.contentType?.(item.reference) ?? DEFAULT_CONTENT_TYPE,
        };
      }
      const receipt = await options.writer.append({
        announcement: item.announcement,
        timestamp: item.timestamp,
        ...(record === undefined ? {} : { record }),
      });
      if (!isExactReceipt(receipt, source, item)) {
        throw new EvidenceJournalBridgeIntegrityError(
          "durable writer returned a receipt for a different announcement or record",
        );
      }
      if (item.announcement.action === "available") available += 1;
      else withdrawn += 1;
      snapshot = await replaceState(snapshot, {
        ...snapshot.value,
        lastTimestamp: item.timestamp,
        pending: { ...pending, nextIndex: pending.nextIndex + 1 },
      });
    }
  }

  async function processStream(
    starting: CasSnapshot<EvidenceJournalBridgeState>,
    stream: EvidenceJournalBridgeStream,
    input: EvidenceRecordAnnouncementSource,
  ): Promise<{ snapshot: CasSnapshot<EvidenceJournalBridgeState>; available: number; withdrawn: number }> {
    let snapshot = starting;
    let available = 0;
    let withdrawn = 0;
    const cursor = stream === "journal"
      ? snapshot.value.journalCursor
      : snapshot.value.withdrawalCursor;
    const seen = new Set<string>();
    for await (const batch of input.read(cursor === undefined ? {} : { after: cursor })) {
      if (seen.has(batch.cursor) || batch.cursor === cursor) {
        throw new EvidenceJournalBridgeIntegrityError(`${stream} source did not advance its cursor`);
      }
      seen.add(batch.cursor);
      const pending = projectBatch(
        stream,
        batch,
        options.evidenceSourceId,
        snapshot.value.lastTimestamp,
        options.now(),
      );
      snapshot = await replaceState(snapshot, { ...snapshot.value, pending });
      const finished = await finishPending(snapshot);
      snapshot = finished.snapshot;
      available += finished.available;
      withdrawn += finished.withdrawn;
    }
    return { snapshot, available, withdrawn };
  }

  async function runSync(): Promise<EvidenceJournalBridgeSyncReport> {
    const existingStrategy = await options.strategies.read(sourceId);
    if (existingStrategy !== undefined && existingStrategy !== strategyId) {
      throw new PublicSourceStrategyConflictError(sourceId);
    }
    if (existingStrategy === undefined) {
      const [writerState, hasPendingWriterIntent] = await Promise.all([
        options.writer.readState(),
        options.writerIntents.hasPending(sourceId),
      ]);
      if (writerState !== undefined || hasPendingWriterIntent) {
        throw new EvidenceJournalBridgeIntegrityError(
          "an unclaimed evidence-journal source has pre-existing source state or append intent",
        );
      }
      const ownership = await options.strategies.claim(sourceId, strategyId);
      if (ownership === "conflict") throw new PublicSourceStrategyConflictError(sourceId);
    }

    const recovery = await options.writer.recover();
    let snapshot = await loadOrCreateState();

    let available = 0;
    let withdrawn = 0;
    const resumed = await finishPending(snapshot);
    snapshot = resumed.snapshot;
    available += resumed.available;
    withdrawn += resumed.withdrawn;

    const journal = await processStream(snapshot, "journal", options.journal);
    snapshot = journal.snapshot;
    available += journal.available;
    withdrawn += journal.withdrawn;

    const withdrawals = await processStream(snapshot, "withdrawals", options.withdrawals);
    snapshot = withdrawals.snapshot;
    available += withdrawals.available;
    withdrawn += withdrawals.withdrawn;

    return {
      available,
      withdrawn,
      recoveredWriterIntent: recovery.status === "recovered",
      ...(snapshot.value.journalCursor === undefined
        ? {}
        : { journalCursor: snapshot.value.journalCursor }),
      ...(snapshot.value.withdrawalCursor === undefined
        ? {}
        : { withdrawalCursor: snapshot.value.withdrawalCursor }),
    };
  }

  return {
    sync() {
      if (active !== undefined) return active;
      const operation = runSync();
      active = operation;
      return operation.finally(() => {
        if (active === operation) active = undefined;
      });
    },
    async readState() {
      const state = await options.states.read(sourceId);
      if (state === undefined) return undefined;
      assertState(state.value, source, options.evidenceSourceId, strategyId);
      return state.value;
    },
  };
}
