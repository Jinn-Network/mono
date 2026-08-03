import { describe, expect, it } from "vitest";
import {
  DISCOVERY_SIGNING_SCOPE,
  MEDIA_HEAD,
  RECORD_KINDS,
  archivePagePath,
  formatOrigin,
  headPath,
  recordDigest,
  recordPath,
  sealJson,
  type Announcement,
  type SourceIdentity,
} from "@jinn-network/record-discovery-protocol";

import type { ReadableImmutableBlobStore, StoredBlob } from "./ports.js";
import type { ArchivePage } from "./archive.js";
import {
  SourceAnnouncementConflictError,
  SourceWriterIntegrityError,
  createDurableSourceWriter,
  type AppendAnnouncementCommand,
  type CasSnapshot,
  type CasWriteResult,
  type DurableSourceAppendIntent,
  type DurableSourceSigner,
  type DurableSourceState,
  type SourceAppendIntentStore,
  type SourceStateStore,
  type SourceWriterFaultBoundary,
} from "./source-writer.js";

function copyBytes(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(bytes);
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

class MemoryBlobStore implements ReadableImmutableBlobStore {
  readonly values = new Map<string, StoredBlob>();

  async get(path: string): Promise<StoredBlob | undefined> {
    const value = this.values.get(path);
    return value === undefined
      ? undefined
      : { bytes: copyBytes(value.bytes), contentType: value.contentType };
  }

  async put(path: string, bytes: Uint8Array, contentType: string): Promise<void> {
    this.values.set(path, { bytes: copyBytes(bytes), contentType });
  }

  async putImmutable(path: string, bytes: Uint8Array, contentType: string): Promise<void> {
    const current = this.values.get(path);
    if (current !== undefined && (!equalBytes(current.bytes, bytes) || current.contentType !== contentType)) {
      throw new Error(`immutable conflict at ${path}`);
    }
    if (current === undefined) {
      this.values.set(path, { bytes: copyBytes(bytes), contentType });
    }
  }

  force(path: string, bytes: Uint8Array, contentType: string): void {
    this.values.set(path, { bytes: copyBytes(bytes), contentType });
  }
}

class MemoryCasStore<T> {
  private snapshot: CasSnapshot<T> | undefined;
  private revision = 0;

  async read(): Promise<CasSnapshot<T> | undefined> {
    return this.snapshot;
  }

  async compareAndSwap(expectedRevision: string | null, next: T | undefined): Promise<CasWriteResult> {
    const currentRevision = this.snapshot?.revision ?? null;
    if (currentRevision !== expectedRevision) return { ok: false };
    this.revision += 1;
    const revision = String(this.revision);
    this.snapshot = next === undefined ? undefined : { revision, value: next };
    return { ok: true, revision };
  }

  force(value: T): void {
    this.revision += 1;
    this.snapshot = { revision: String(this.revision), value };
  }
}

const SOURCE: SourceIdentity = { agent: "did:key:zSourceWriter", name: "native-feed" };
const RECORD_BYTES = new TextEncoder().encode("exact-record-one");
const RECORD_DIGEST = recordDigest(RECORD_BYTES);

function available(
  announcementId = "ann-1",
  facts: unknown = { workKind: "native" },
): Announcement {
  return {
    announcementId,
    action: "available",
    record: {
      kind: RECORD_KINDS.submission,
      digest: RECORD_DIGEST,
      mediaType: "application/vnd.jinn.submission+json",
    },
    facts,
  };
}

function command(announcement: Announcement = available()): AppendAnnouncementCommand {
  return announcement.action === "available"
    ? {
      announcement,
      timestamp: "2026-08-03T12:00:00.000Z",
      record: {
        bytes: RECORD_BYTES,
        contentType: "application/vnd.jinn.submission+json",
      },
    }
    : { announcement, timestamp: "2026-08-03T12:01:00.000Z" };
}

function makeHarness(keyId = "key-1") {
  const blobs = new MemoryBlobStore();
  const stateCas = new MemoryCasStore<DurableSourceState>();
  const intentCas = new MemoryCasStore<DurableSourceAppendIntent>();
  const states: SourceStateStore = {
    read: async () => stateCas.read(),
    compareAndSwap: async (_sourceId, expected, next) => stateCas.compareAndSwap(expected, next),
  };
  const intents: SourceAppendIntentStore = {
    read: async () => intentCas.read(),
    compareAndSwap: async (_sourceId, expected, next) => intentCas.compareAndSwap(expected, next),
  };
  let signCount = 0;
  const signer: DurableSourceSigner = {
    scope: DISCOVERY_SIGNING_SCOPE,
    keyId,
    async sign(pae) {
      signCount += 1;
      return [{ keyid: keyId, sig: copyBytes(pae) }];
    },
    verify(pae, signature) {
      return equalBytes(pae, signature);
    },
  };
  return {
    blobs,
    stateCas,
    intentCas,
    states,
    intents,
    signer,
    signCount: () => signCount,
  };
}

function writer(
  harness: ReturnType<typeof makeHarness>,
  faultBoundary?: SourceWriterFaultBoundary,
) {
  let tripped = false;
  return createDurableSourceWriter({
    source: SOURCE,
    signer: harness.signer,
    blobs: harness.blobs,
    states: harness.states,
    intents: harness.intents,
    ...(faultBoundary === undefined ? {} : {
      faults: {
        async at(boundary: SourceWriterFaultBoundary) {
          if (!tripped && boundary === faultBoundary) {
            tripped = true;
            throw new Error(`fault:${boundary}`);
          }
        },
      },
    }),
  });
}

describe("durable Record Discovery source writer", () => {
  it("writes exact record/page/head bytes and advances one authoritative state", async () => {
    const harness = makeHarness();
    const receipt = await writer(harness).append(command());

    expect(receipt).toMatchObject({
      source: SOURCE,
      announcementId: "ann-1",
      sequence: "0000000000000001",
      page: "0000000000000001",
      record: { digest: RECORD_DIGEST, path: recordPath(RECORD_DIGEST) },
    });
    expect(await harness.blobs.get(recordPath(RECORD_DIGEST))).toBeDefined();
    expect(await harness.blobs.get(archivePagePath(SOURCE.name, receipt.page))).toBeDefined();
    expect((await harness.blobs.get(headPath(SOURCE.name)))?.contentType).toBe(MEDIA_HEAD);
    expect((await harness.stateCas.read())?.value.last?.entryDigest).toBe(receipt.entryDigest);
    expect(await harness.intentCas.read()).toBeUndefined();
  });

  it("returns the exact prior receipt for the same announcement fingerprint without signing again", async () => {
    const harness = makeHarness();
    const sourceWriter = writer(harness);
    const first = await sourceWriter.append(command());
    const signCount = harness.signCount();
    const second = await sourceWriter.append(command());

    expect(second).toEqual(first);
    expect(harness.signCount()).toBe(signCount);
  });

  it("rejects different exact input under an already committed announcementId", async () => {
    const harness = makeHarness();
    const sourceWriter = writer(harness);
    await sourceWriter.append(command());

    await expect(sourceWriter.append(command(available("ann-1", { workKind: "different" }))))
      .rejects.toBeInstanceOf(SourceAnnouncementConflictError);
  });

  it("serializes concurrent identical callers through CAS into one source position", async () => {
    const harness = makeHarness();
    const firstWriter = writer(harness);
    const secondWriter = writer(harness);

    const receipts = await Promise.all([
      firstWriter.append(command()),
      secondWriter.append(command()),
    ]);
    expect(receipts[1]).toEqual(receipts[0]);
    expect(receipts[0]!.sequence).toBe("0000000000000001");
    expect(Object.keys((await harness.stateCas.read())!.value.announcements)).toEqual(["ann-1"]);
  });

  it.each<SourceWriterFaultBoundary>([
    "after-record-before-intent",
    "after-intent-before-page",
    "after-page-before-head",
    "after-head-before-state",
    "after-state-before-intent-clear",
  ])("recovers the %s boundary without a second publication", async (boundary) => {
    const harness = makeHarness();
    await expect(writer(harness, boundary).append(command())).rejects.toThrow(`fault:${boundary}`);

    const pending = await harness.intentCas.read();
    const frozenPage = pending?.value.page.bytesBase64;
    const frozenHead = pending?.value.head.bytesBase64;
    const signCountBeforeRecovery = harness.signCount();
    const recoveryWriter = writer(harness);
    const report = await recoveryWriter.recover();
    const receipt = await recoveryWriter.append(command());

    expect(receipt.announcementId).toBe("ann-1");
    expect(harness.signCount()).toBe(boundary === "after-record-before-intent" ? 2 : signCountBeforeRecovery);
    expect(report.status).toBe(boundary === "after-record-before-intent" ? "idle" : "recovered");
    expect(await harness.intentCas.read()).toBeUndefined();
    if (frozenPage !== undefined && frozenHead !== undefined) {
      const storedPage = await harness.blobs.get(archivePagePath(SOURCE.name, receipt.page));
      const storedHead = await harness.blobs.get(headPath(SOURCE.name));
      expect(storedPage?.bytes).toEqual(Uint8Array.from(atob(frozenPage), (character) => character.charCodeAt(0)));
      expect(storedHead?.bytes).toEqual(Uint8Array.from(atob(frozenHead), (character) => character.charCodeAt(0)));
    }
  });

  it("recovers frozen intent bytes without invoking a signer", async () => {
    const harness = makeHarness();
    await expect(writer(harness, "after-intent-before-page").append(command())).rejects.toThrow();
    const pending = (await harness.intentCas.read())!;
    const rejectingSigner: DurableSourceSigner = {
      scope: DISCOVERY_SIGNING_SCOPE,
      keyId: "key-1",
      async sign() {
        throw new Error("recovery must not sign");
      },
      verify(pae, signature) {
        return equalBytes(pae, signature);
      },
    };
    const recoveryWriter = createDurableSourceWriter({
      source: SOURCE,
      signer: rejectingSigner,
      blobs: harness.blobs,
      states: harness.states,
      intents: harness.intents,
    });

    await expect(recoveryWriter.recover()).resolves.toMatchObject({ status: "recovered" });
    expect((await harness.blobs.get(pending.value.page.path))?.bytes)
      .toEqual(Uint8Array.from(atob(pending.value.page.bytesBase64), (character) => character.charCodeAt(0)));
  });

  it("fails closed when immutable page bytes conflict during recovery", async () => {
    const harness = makeHarness();
    await expect(writer(harness, "after-intent-before-page").append(command())).rejects.toThrow();
    const pending = (await harness.intentCas.read())!;
    harness.blobs.force(pending.value.page.path, new TextEncoder().encode("wrong-page"), "application/json");

    await expect(writer(harness).recover()).rejects.toThrow("immutable conflict");
  });

  it("cryptographically verifies the frozen entry signature before recovery", async () => {
    const harness = makeHarness();
    await expect(writer(harness, "after-intent-before-page").append(command())).rejects.toThrow();
    const pending = (await harness.intentCas.read())!;
    const pageBytes = Uint8Array.from(
      atob(pending.value.page.bytesBase64),
      (character) => character.charCodeAt(0),
    );
    const page = JSON.parse(new TextDecoder().decode(pageBytes)) as ArchivePage;
    page.entries[0]!.signature!.signatures[0]!.sig = encodeBase64(new Uint8Array([1, 2, 3]));
    const alteredPageBytes = sealJson(page).bytes;
    harness.intentCas.force({
      ...pending.value,
      page: {
        ...pending.value.page,
        bytesBase64: encodeBase64(alteredPageBytes),
        digest: recordDigest(alteredPageBytes),
      },
    });

    await expect(writer(harness).recover()).rejects.toThrow("signature is not valid");
  });

  it("requires exact record bytes and source-local available withdrawal targets", async () => {
    const harness = makeHarness();
    const sourceWriter = writer(harness);
    await expect(sourceWriter.append({
      announcement: available(),
      timestamp: "2026-08-03T12:00:00.000Z",
      record: { bytes: new TextEncoder().encode("wrong") },
    })).rejects.toBeInstanceOf(SourceWriterIntegrityError);

    const withdrawal: Announcement = {
      announcementId: "withdraw-1",
      action: "withdrawn",
      retracts: "missing",
      reason: "delisted",
    };
    await expect(sourceWriter.append(command(withdrawal))).rejects.toBeInstanceOf(SourceAnnouncementConflictError);

    await sourceWriter.append(command());
    const receipt = await sourceWriter.append(command({ ...withdrawal, retracts: "ann-1" }));
    expect(receipt.sequence).toBe("0000000000000002");
  });

  it("fails closed when a later append would make Source Head issuedAt non-monotonic", async () => {
    const harness = makeHarness();
    const sourceWriter = writer(harness);
    await sourceWriter.append(command());
    const secondRecordBytes = new TextEncoder().encode("exact-record-two");
    const secondRecordDigest = recordDigest(secondRecordBytes);

    await expect(sourceWriter.append({
      announcement: {
        announcementId: "ann-2",
        action: "available",
        record: { kind: RECORD_KINDS.delivery, digest: secondRecordDigest },
      },
      timestamp: "2026-08-03T11:59:59.000Z",
      record: { bytes: secondRecordBytes },
    })).rejects.toThrow("strictly advance");
  });

  it("binds persisted state to one exact source signer", async () => {
    const harness = makeHarness();
    await writer(harness).append(command());
    const otherSigner: DurableSourceSigner = {
      scope: DISCOVERY_SIGNING_SCOPE,
      keyId: "key-2",
      async sign(pae) {
        return [{ keyid: "key-2", sig: pae }];
      },
      verify(pae, signature) {
        return equalBytes(pae, signature);
      },
    };
    const mismatched = createDurableSourceWriter({
      source: SOURCE,
      signer: otherSigner,
      blobs: harness.blobs,
      states: harness.states,
      intents: harness.intents,
    });

    await expect(mismatched.readState()).rejects.toThrow("different signer key");
  });

  it("uses the exact formatted source identity as the durable CAS key", async () => {
    const harness = makeHarness();
    const seen: string[] = [];
    const states: SourceStateStore = {
      read: async (sourceId) => {
        seen.push(sourceId);
        return harness.stateCas.read();
      },
      compareAndSwap: async (sourceId, expected, next) => {
        seen.push(sourceId);
        return harness.stateCas.compareAndSwap(expected, next);
      },
    };
    await createDurableSourceWriter({
      source: SOURCE,
      signer: harness.signer,
      blobs: harness.blobs,
      states,
      intents: harness.intents,
    }).append(command());

    expect(new Set(seen)).toEqual(new Set([formatOrigin(SOURCE.agent, SOURCE.name)]));
  });
});
