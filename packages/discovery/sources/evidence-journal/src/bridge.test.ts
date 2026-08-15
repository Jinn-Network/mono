import type {
  AnnouncementBatch,
  EvidenceRecordAnnouncement,
  EvidenceRecordAnnouncementSource,
} from "@jinn-network/evidence-discovery";
import type { SourceIdentity } from "@jinn-network/record-discovery-protocol";
import { formatOrigin, recordDigest } from "@jinn-network/record-discovery-protocol";
import type {
  DurableSourceReceipt,
  DurableSourceState,
  DurableSourceWriter,
} from "@jinn-network/record-discovery-serve";
import { describe, expect, it, vi } from "vitest";

import {
  createEvidenceJournalDurableBridge,
  PublicSourceStrategyConflictError,
  type EvidenceJournalBridgeState,
  type EvidenceJournalBridgeStateStore,
  type PublicSourceStrategyStore,
} from "./bridge.js";

const SOURCE: SourceIdentity = {
  agent: "did:key:zEvidenceJournalBridge",
  name: "evidence-journal",
};
const EVIDENCE_SOURCE = "local-source";

function announcementSource(
  announcements: readonly EvidenceRecordAnnouncement[],
): EvidenceRecordAnnouncementSource {
  return {
    async *read(options): AsyncIterable<AnnouncementBatch> {
      const start = options?.after === undefined ? 0 : Number(options.after) + 1;
      for (let index = start; index < announcements.length; index += 1) {
        yield { announcements: [announcements[index]!], cursor: String(index) };
      }
    },
  };
}

class MemoryBridgeStates implements EvidenceJournalBridgeStateStore {
  revision = 0;
  value: EvidenceJournalBridgeState | undefined;
  failAfterWriterOnce = false;

  async read(_sourceId?: string) {
    return this.value === undefined
      ? undefined
      : { revision: String(this.revision), value: structuredClone(this.value) };
  }

  async compareAndSwap(
    _sourceId: string,
    expectedRevision: string | null,
    next: EvidenceJournalBridgeState,
  ) {
    const actual = this.value === undefined ? null : String(this.revision);
    if (actual !== expectedRevision) return { ok: false as const };
    if (
      this.failAfterWriterOnce
      && next.pending?.nextIndex === 1
    ) {
      this.failAfterWriterOnce = false;
      throw new Error("simulated death after writer append");
    }
    this.revision += 1;
    this.value = structuredClone(next);
    return { ok: true as const, revision: String(this.revision) };
  }
}

class MemoryStrategies implements PublicSourceStrategyStore {
  readonly claims = new Map<string, string>();

  async read(sourceId: string) {
    return this.claims.get(sourceId);
  }

  async claim(sourceId: string, strategyId: string) {
    const existing = this.claims.get(sourceId);
    if (existing === undefined) {
      this.claims.set(sourceId, strategyId);
      return "claimed" as const;
    }
    return existing === strategyId ? "existing" as const : "conflict" as const;
  }
}

function fakeWriter() {
  const receipts = new Map<string, DurableSourceReceipt>();
  let sequence = 0;
  const append = vi.fn<DurableSourceWriter["append"]>(async (command) => {
    const fingerprint = recordDigest(new TextEncoder().encode(
      `${command.announcement.announcementId}|${command.timestamp}`,
    ));
    const existing = receipts.get(command.announcement.announcementId);
    if (existing !== undefined) return existing;
    sequence += 1;
    const receipt: DurableSourceReceipt = {
      source: SOURCE,
      announcementId: command.announcement.announcementId,
      fingerprint,
      sequence: String(sequence).padStart(16, "0"),
      entryDigest: `sha256:${String(sequence).padStart(64, "0")}`,
      page: String(sequence).padStart(16, "0"),
      ...(command.announcement.action === "available"
        ? {
            record: {
              digest: command.announcement.record.digest,
              path: `/records/${command.announcement.record.digest}`,
              contentType: command.record?.contentType ?? "application/octet-stream",
            },
          }
        : {}),
    };
    receipts.set(command.announcement.announcementId, receipt);
    return receipt;
  });
  const recover = vi.fn<DurableSourceWriter["recover"]>(async () => ({ status: "idle" }));
  const writer: DurableSourceWriter = {
    append,
    recover,
    async readState(): Promise<DurableSourceState | undefined> {
      if (sequence === 0) return undefined;
      return {
        version: 1,
        source: SOURCE,
        signerKeyId: "fake",
        last: {
          sequence: String(sequence).padStart(16, "0"),
          entryDigest: `sha256:${String(sequence).padStart(64, "0")}`,
          page: String(sequence).padStart(16, "0"),
        },
        announcements: {},
      };
    },
  };
  return { writer, append, recover, receipts };
}

function writerIntents(pending = false) {
  return { async hasPending() { return pending; } };
}

function available(id: string, digest: `sha256:${string}`): EvidenceRecordAnnouncement {
  return {
    kind: "available",
    sourceId: EVIDENCE_SOURCE,
    announcementId: id,
    reference: { family: "execution-evidence", digest },
    repositoryId: "private-repository",
  };
}

describe("durable evidence-journal bridge", () => {
  it("preserves announcementId and exact record digest across available and withdrawn entries", async () => {
    const bytes = new TextEncoder().encode("exact evidence bytes");
    const digest = recordDigest(bytes);
    const states = new MemoryBridgeStates();
    const strategies = new MemoryStrategies();
    const writer = fakeWriter();
    const bridge = createEvidenceJournalDurableBridge({
      source: SOURCE,
      evidenceSourceId: EVIDENCE_SOURCE,
      journal: announcementSource([available("available-1", digest)]),
      withdrawals: announcementSource([{
        kind: "withdrawn",
        sourceId: EVIDENCE_SOURCE,
        announcementId: "withdrawn-1",
        retractsAnnouncementId: "available-1",
      }]),
      records: { async getRecord(reference) { return reference.digest === digest ? bytes : null; } },
      writer: writer.writer,
      writerIntents: writerIntents(),
      states,
      strategies,
      now: () => new Date("2026-08-03T12:00:00.000Z"),
    });

    await expect(bridge.sync()).resolves.toMatchObject({ available: 1, withdrawn: 1 });
    expect(writer.append.mock.calls.map(([command]) => command.announcement)).toEqual([
      expect.objectContaining({
        announcementId: "available-1",
        action: "available",
        record: expect.objectContaining({ digest }),
      }),
      {
        announcementId: "withdrawn-1",
        action: "withdrawn",
        retracts: "available-1",
        reason: "delisted",
      },
    ]);
    expect(writer.append.mock.calls[0]![0].record?.bytes).toEqual(bytes);
    expect(writer.append.mock.calls[1]![0].record).toBeUndefined();
  });

  it("replays the exact pending command after restart without a second committed announcement", async () => {
    const bytes = new TextEncoder().encode("restart bytes");
    const digest = recordDigest(bytes);
    const states = new MemoryBridgeStates();
    states.failAfterWriterOnce = true;
    const strategies = new MemoryStrategies();
    const writer = fakeWriter();
    const options = {
      source: SOURCE,
      evidenceSourceId: EVIDENCE_SOURCE,
      journal: announcementSource([available("available-restart", digest)]),
      withdrawals: announcementSource([]),
      records: { async getRecord() { return bytes; } },
      writer: writer.writer,
      writerIntents: writerIntents(),
      states,
      strategies,
      now: () => new Date("2026-08-03T12:00:00.000Z"),
    };

    await expect(createEvidenceJournalDurableBridge(options).sync())
      .rejects.toThrow(/simulated death/u);
    const pending = await states.read(formatOrigin(SOURCE.agent, SOURCE.name));
    expect(pending?.value.pending?.nextIndex).toBe(0);

    await expect(createEvidenceJournalDurableBridge(options).sync())
      .resolves.toMatchObject({ journalCursor: "0" });
    expect(writer.append).toHaveBeenCalledTimes(2);
    expect(writer.recover).toHaveBeenCalledTimes(2);
    expect(writer.receipts.size).toBe(1);
    expect((await states.read(formatOrigin(SOURCE.agent, SOURCE.name)))?.value.pending)
      .toBeUndefined();
  });

  it("fails closed when another strategy already owns the public source identity", async () => {
    const strategies = new MemoryStrategies();
    strategies.claims.set(formatOrigin(SOURCE.agent, SOURCE.name), "another-strategy");
    const writer = fakeWriter();
    const bridge = createEvidenceJournalDurableBridge({
      source: SOURCE,
      evidenceSourceId: EVIDENCE_SOURCE,
      journal: announcementSource([]),
      withdrawals: announcementSource([]),
      records: { async getRecord() { return null; } },
      writer: writer.writer,
      writerIntents: writerIntents(),
      states: new MemoryBridgeStates(),
      strategies,
      now: () => new Date("2026-08-03T12:00:00.000Z"),
    });

    await expect(bridge.sync()).rejects.toBeInstanceOf(PublicSourceStrategyConflictError);
    expect(writer.append).not.toHaveBeenCalled();
  });

  it("rejects pre-existing writer state before a newly claimed strategy can recover or mutate public state", async () => {
    const states = new MemoryBridgeStates();
    const strategies = new MemoryStrategies();
    const writer = fakeWriter();
    const persistedWriterState: DurableSourceState = {
      version: 1,
      source: SOURCE,
      signerKeyId: "pre-existing-key",
      last: null,
      announcements: {},
    };
    writer.writer.readState = vi.fn(async () => structuredClone(persistedWriterState));
    const publicBlobs = new Map([["head", "unchanged"]]);
    writer.writer.recover = vi.fn(async () => {
      publicBlobs.set("head", "mutated");
      return { status: "recovered" as const };
    });
    const bridge = createEvidenceJournalDurableBridge({
      source: SOURCE,
      evidenceSourceId: EVIDENCE_SOURCE,
      journal: announcementSource([]),
      withdrawals: announcementSource([]),
      records: { async getRecord() { return null; } },
      writer: writer.writer,
      writerIntents: writerIntents(),
      states,
      strategies,
      now: () => new Date("2026-08-03T12:00:00.000Z"),
    });

    await expect(bridge.sync()).rejects.toThrow(/pre-existing source state or append intent/u);
    await expect(bridge.sync()).rejects.toThrow(/pre-existing source state or append intent/u);
    expect(writer.writer.recover).not.toHaveBeenCalled();
    expect(writer.append).not.toHaveBeenCalled();
    expect(publicBlobs).toEqual(new Map([["head", "unchanged"]]));
    expect(await writer.writer.readState()).toEqual(persistedWriterState);
    expect(states.value).toBeUndefined();
    expect(strategies.claims.size).toBe(0);
  });

  it("rejects a pre-existing append intent before a newly claimed strategy can recover public blobs", async () => {
    const states = new MemoryBridgeStates();
    const strategies = new MemoryStrategies();
    const writer = fakeWriter();
    const publicBlobs = new Map([["page", "unchanged"]]);
    writer.writer.recover = vi.fn(async () => {
      publicBlobs.set("page", "mutated");
      return { status: "recovered" as const };
    });
    const bridge = createEvidenceJournalDurableBridge({
      source: SOURCE,
      evidenceSourceId: EVIDENCE_SOURCE,
      journal: announcementSource([]),
      withdrawals: announcementSource([]),
      records: { async getRecord() { return null; } },
      writer: writer.writer,
      writerIntents: writerIntents(true),
      states,
      strategies,
      now: () => new Date("2026-08-03T12:00:00.000Z"),
    });

    await expect(bridge.sync()).rejects.toThrow(/pre-existing source state or append intent/u);
    await expect(bridge.sync()).rejects.toThrow(/pre-existing source state or append intent/u);
    expect(writer.writer.recover).not.toHaveBeenCalled();
    expect(writer.append).not.toHaveBeenCalled();
    expect(publicBlobs).toEqual(new Map([["page", "unchanged"]]));
    expect(await writer.writer.readState()).toBeUndefined();
    expect(states.value).toBeUndefined();
    expect(strategies.claims.size).toBe(0);
  });
});
