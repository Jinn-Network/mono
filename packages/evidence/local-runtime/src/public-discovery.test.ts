// SPDX-License-Identifier: MIT
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  AnnouncementBatch,
  EvidenceRecordAnnouncement,
  EvidenceRecordAnnouncementSource,
} from "@jinn-network/evidence-discovery";
import {
  DISCOVERY_SIGNING_SCOPE,
  GENESIS_SEQUENCE,
  RECORD_KINDS,
  archivePagePath,
  formatOrigin,
  headPath,
  recordDigest,
  recordPath,
  sealJson,
  type SourceIdentity,
} from "@jinn-network/record-discovery-protocol";
import {
  createDurableSourceWriter,
  type CasSnapshot,
  type CasWriteResult,
  type DurableSourceAppendIntent,
  type DurableSourceSigner,
  type DurableSourceState,
  type ReadableImmutableBlobStore,
  type StoredBlob,
} from "@jinn-network/record-discovery-serve";
import {
  createEvidenceJournalDurableBridge,
  type EvidenceJournalBridgeState,
} from "@jinn-network/record-discovery-source-evidence-journal";
import { afterEach, describe, expect, it } from "vitest";

import { publicationIdentity } from "./publication.js";
import { prepareRuntimePaths } from "./paths.js";
import type { EvidenceJournalPublicDiscoveryBridgeFactory } from "./public-discovery.js";
import { openLocalEvidenceRuntime } from "./runtime.js";

const BRIDGE_FACTORY: EvidenceJournalPublicDiscoveryBridgeFactory = (context) =>
  createEvidenceJournalDurableBridge({
    source: context.source,
    evidenceSourceId: context.evidenceSourceId,
    journal: context.journal,
    withdrawals: context.withdrawals,
    records: context.records,
    writer: context.writer,
    writerIntents: context.writerIntents,
    states: context.openBridgeStateStore<EvidenceJournalBridgeState>(),
    strategies: context.strategies,
    now: context.now,
  });

const SOURCE: SourceIdentity = {
  agent: "did:key:zEvidenceLocalRuntime",
  name: "evidence-journal",
};

const roots: string[] = [];

async function root(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "jinn-evidence-public-discovery-"));
  roots.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

class MemoryBlobs implements ReadableImmutableBlobStore {
  readonly values = new Map<string, StoredBlob>();

  async get(path: string): Promise<StoredBlob | undefined> {
    const value = this.values.get(path);
    return value === undefined
      ? undefined
      : { bytes: value.bytes.slice(), contentType: value.contentType };
  }

  async put(path: string, bytes: Uint8Array, contentType: string): Promise<void> {
    this.values.set(path, { bytes: bytes.slice(), contentType });
  }

  async putImmutable(path: string, bytes: Uint8Array, contentType: string): Promise<void> {
    const existing = this.values.get(path);
    if (
      existing !== undefined
      && (!equalBytes(existing.bytes, bytes) || existing.contentType !== contentType)
    ) throw new Error(`immutable blob conflict at ${path}`);
    if (existing === undefined) this.values.set(path, { bytes: bytes.slice(), contentType });
  }
}

class MemoryCas<State> {
  snapshot: CasSnapshot<State> | undefined;
  revision = 0;

  async read(): Promise<CasSnapshot<State> | undefined> {
    return this.snapshot;
  }

  async compareAndSwap(
    expectedRevision: string | null,
    next: State | undefined,
  ): Promise<CasWriteResult> {
    if ((this.snapshot?.revision ?? null) !== expectedRevision) return { ok: false };
    this.revision += 1;
    const revision = String(this.revision);
    this.snapshot = next === undefined ? undefined : { revision, value: next };
    return { ok: true, revision };
  }
}

const SIGNER: DurableSourceSigner = {
  keyId: "evidence-local-runtime-test-key",
  scope: DISCOVERY_SIGNING_SCOPE,
  async sign(pae) { return [{ keyid: this.keyId, sig: pae.slice() }]; },
  verify(pae, signature) { return equalBytes(pae, signature); },
};

async function validPendingWriterIntent(): Promise<{
  intent: DurableSourceAppendIntent;
  blobs: ReadonlyMap<string, StoredBlob>;
}> {
  const states = new MemoryCas<DurableSourceState>();
  const intents = new MemoryCas<DurableSourceAppendIntent>();
  const blobs = new MemoryBlobs();
  const writer = createDurableSourceWriter({
    source: SOURCE,
    signer: SIGNER,
    blobs,
    states: {
      read: async () => states.read(),
      compareAndSwap: async (_sourceId, expected, next) =>
        states.compareAndSwap(expected, next),
    },
    intents: {
      read: async () => intents.read(),
      compareAndSwap: async (_sourceId, expected, next) =>
        intents.compareAndSwap(expected, next),
    },
    faults: {
      async at(boundary) {
        if (boundary === "after-intent-before-page") {
          throw new Error("capture-valid-pending-intent");
        }
      },
    },
  });
  const bytes = new TextEncoder().encode("valid pending exact evidence bytes");
  await expect(writer.append({
    announcement: {
      announcementId: "valid-pending-announcement",
      action: "available",
      record: {
        kind: RECORD_KINDS.executionEvidence,
        digest: recordDigest(bytes),
        mediaType: "application/json",
      },
    },
    timestamp: "2026-08-03T11:59:00.000Z",
    record: { bytes, contentType: "application/json" },
  })).rejects.toThrow("capture-valid-pending-intent");
  expect(states.snapshot).toBeUndefined();
  expect(intents.snapshot?.value.expectedStateRevision).toBeNull();
  return {
    intent: structuredClone(intents.snapshot!.value),
    blobs: new Map([...blobs.values].map(([path, blob]) => [
      path,
      { bytes: blob.bytes.slice(), contentType: blob.contentType },
    ])),
  };
}

class MutableWithdrawals implements EvidenceRecordAnnouncementSource {
  readonly announcements: EvidenceRecordAnnouncement[] = [];

  async *read(options?: { readonly after?: string }): AsyncIterable<AnnouncementBatch> {
    const start = options?.after === undefined ? 0 : Number(options.after) + 1;
    for (let index = start; index < this.announcements.length; index += 1) {
      yield { announcements: [this.announcements[index]!], cursor: String(index) };
    }
  }
}

function pageAnnouncement(bytes: Uint8Array): Record<string, unknown> {
  const page = JSON.parse(new TextDecoder().decode(bytes)) as {
    entries: { entry: { announcements: Record<string, unknown>[] } }[];
  };
  return page.entries[0]!.entry.announcements[0]!;
}

async function goldenEvidence(): Promise<Uint8Array> {
  return readFile(new URL(
    "../../protocol/fixtures/golden-execution-evidence-v1/execution/ro-crate-metadata.json",
    import.meta.url,
  ));
}

describe("local evidence Record Discovery host", () => {
  it("publishes the real journal, persists restart cursors, and appends injected withdrawals", async () => {
    const runtimeRoot = await root();
    const blobs = new MemoryBlobs();
    const withdrawals = new MutableWithdrawals();
    let clockMs = Date.parse("2026-08-03T12:00:00.000Z");
    const publicDiscovery = {
      source: SOURCE,
      signer: SIGNER,
      blobs,
      bridgeFactory: BRIDGE_FACTORY,
      withdrawals,
      now: () => new Date(clockMs),
    };
    const runtime = await openLocalEvidenceRuntime({ rootDir: runtimeRoot, publicDiscovery });
    const bytes = await goldenEvidence();
    const receipt = await runtime.repository.putRecord("execution-evidence", bytes);
    await runtime.sync();

    const availableId = publicationIdentity(
      (await runtime.getStatus()).sourceId,
      (await runtime.getStatus()).repositoryId,
      receipt.reference,
    ).announcementId;
    const firstPage = await blobs.get(archivePagePath(SOURCE.name, GENESIS_SEQUENCE));
    expect(firstPage).toBeDefined();
    expect(pageAnnouncement(firstPage!.bytes)).toMatchObject({
      announcementId: availableId,
      action: "available",
      record: { digest: receipt.reference.digest },
    });
    expect(equalBytes(
      (await blobs.get(recordPath(receipt.reference.digest)))!.bytes,
      bytes,
    )).toBe(true);
    const headBeforeRestart = (await blobs.get(headPath(SOURCE.name)))!.bytes;
    await runtime.close();

    const reopened = await openLocalEvidenceRuntime({ rootDir: runtimeRoot, publicDiscovery });
    expect((await blobs.get(headPath(SOURCE.name)))!.bytes).toEqual(headBeforeRestart);
    const bridgeState = await reopened.publicDiscovery!.readState();
    expect(bridgeState).toMatchObject({
      source: SOURCE,
      journalCursor: expect.any(String),
    });
    expect(bridgeState).not.toHaveProperty("pending");

    withdrawals.announcements.push({
      kind: "withdrawn",
      sourceId: (await reopened.getStatus()).sourceId,
      announcementId: "withdrawal-1",
      retractsAnnouncementId: availableId,
    });
    clockMs += 1_000;
    await reopened.publicDiscovery!.sync();
    const withdrawalPage = await blobs.get(archivePagePath(SOURCE.name, "0000000000000002"));
    expect(pageAnnouncement(withdrawalPage!.bytes)).toEqual({
      announcementId: "withdrawal-1",
      action: "withdrawn",
      retracts: availableId,
      reason: "delisted",
    });
    expect((await reopened.publicDiscovery!.readState())?.withdrawalCursor).toBe("0");
    await reopened.close();
  });

  it("fails closed before publication when another strategy owns the same source identity", async () => {
    const runtimeRoot = await root();
    const paths = await prepareRuntimePaths(runtimeRoot);
    await writeFile(
      join(paths.publicDiscoveryDir, "strategy.json"),
      sealJson({
        version: 1,
        sourceId: formatOrigin(SOURCE.agent, SOURCE.name),
        strategyId: "another-publication-strategy",
      }).bytes,
      { mode: 0o600 },
    );
    const blobs = new MemoryBlobs();

    await expect(openLocalEvidenceRuntime({
      rootDir: runtimeRoot,
      publicDiscovery: { source: SOURCE, signer: SIGNER, blobs, bridgeFactory: BRIDGE_FACTORY },
    })).rejects.toThrow(/Public Record Discovery bridge failed|publication strategy/iu);
    expect(blobs.values.size).toBe(0);
  });

  async function expectUnsafeUnclaimedSourceToRejectTwice(
    persisted: Readonly<Record<string, unknown>>,
    initialBlobs: ReadonlyMap<string, StoredBlob> = new Map(),
  ): Promise<void> {
    const runtimeRoot = await root();
    const paths = await prepareRuntimePaths(runtimeRoot);
    const exactFiles = new Map<string, Uint8Array>();
    for (const [file, value] of Object.entries(persisted)) {
      const bytes = sealJson(value).bytes;
      exactFiles.set(file, bytes);
      await writeFile(join(paths.publicDiscoveryDir, file), bytes, { mode: 0o600 });
    }
    const blobs = new MemoryBlobs();
    await blobs.put("sentinel", new TextEncoder().encode("unchanged"), "text/plain");
    for (const [path, blob] of initialBlobs) {
      await blobs.put(path, blob.bytes, blob.contentType);
    }
    const blobsBefore = new Map([...blobs.values].map(([path, blob]) => [
      path,
      { bytes: blob.bytes.slice(), contentType: blob.contentType },
    ]));

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(openLocalEvidenceRuntime({
        rootDir: runtimeRoot,
        publicDiscovery: { source: SOURCE, signer: SIGNER, blobs, bridgeFactory: BRIDGE_FACTORY },
      })).rejects.toThrow(/Public Record Discovery bridge failed/iu);

      for (const [file, bytes] of exactFiles) {
        expect(equalBytes(await readFile(join(paths.publicDiscoveryDir, file)), bytes)).toBe(true);
      }
      expect(blobs.values.size).toBe(blobsBefore.size);
      for (const [path, blob] of blobsBefore) {
        const current = await blobs.get(path);
        expect(current?.contentType).toBe(blob.contentType);
        expect(equalBytes(current!.bytes, blob.bytes)).toBe(true);
      }
      await expect(readFile(join(paths.publicDiscoveryDir, "strategy.json")))
        .rejects.toMatchObject({ code: "ENOENT" });
    }
  }

  it("rejects a valid pre-existing source state on every attempt without creating strategy ownership", async () => {
    const state: DurableSourceState = {
      version: 1,
      source: SOURCE,
      signerKeyId: SIGNER.keyId,
      last: null,
      announcements: {},
    };
    await expectUnsafeUnclaimedSourceToRejectTwice({ "source-state.json": state });
  });

  it("rejects a valid pre-existing append intent on every attempt without creating strategy ownership", async () => {
    const pending = await validPendingWriterIntent();
    await expectUnsafeUnclaimedSourceToRejectTwice({
      "append-intent.json": pending.intent,
    }, pending.blobs);
  });
});
