import { describe, expect, it } from "vitest";
import {
  DISCOVERY_SIGNING_SCOPE,
  MEDIA_HEAD,
  RECORD_KINDS,
  archivePagePath,
  dssePreAuthEncoding,
  formatOrigin,
  headPath,
  parseSourceHead,
  recordDigest,
  recordPath,
  sealJson,
  verifySourceChain,
  type Announcement,
  type HighWaterMark,
  type SourceIdentity,
} from "@jinn-network/record-discovery-protocol";
import type { DsseEnvelope } from "@jinn-network/trust-core";

import type { Clock, ReadableImmutableBlobStore, StoredBlob } from "./ports.js";
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
  type DurableSourceWriterOptions,
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

function clockAt(iso: string): Clock {
  return { now: () => new Date(iso) };
}

/** Pinned so the suite does not depend on wall clock now that appends are clock-bounded. */
const DEFAULT_TEST_CLOCK = clockAt("2026-08-03T12:00:00.000Z");

/**
 * The one place this suite builds writer options. Every writer is constructed from
 * it, so no case can silently fall back to the wall-clock default and start reading
 * host time on the clock-bounded append path (#3570).
 */
function writerOptions(
  harness: ReturnType<typeof makeHarness>,
  overrides: Partial<DurableSourceWriterOptions> = {},
): DurableSourceWriterOptions {
  return {
    source: SOURCE,
    signer: harness.signer,
    blobs: harness.blobs,
    states: harness.states,
    intents: harness.intents,
    clock: DEFAULT_TEST_CLOCK,
    ...overrides,
  };
}

function writer(
  harness: ReturnType<typeof makeHarness>,
  faultBoundary?: SourceWriterFaultBoundary,
  clock?: Clock,
) {
  let tripped = false;
  return createDurableSourceWriter({
    ...writerOptions(harness, clock === undefined ? {} : { clock }),
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
    const recoveryWriter = createDurableSourceWriter(
      writerOptions(harness, { signer: rejectingSigner }),
    );

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

  // The command's timestamp becomes the head's `issuedAt` verbatim, so a
  // timestamp the head schema will refuse (#3482) has to be refused HERE:
  // admitting it signs a head and persists the append intent before the
  // schema sees it, and the claimed intent then replays the same failure on
  // every recover, wedging the source permanently.
  it.each([
    ["offset-less", "2026-08-03T12:00:00"],
    ["a day the calendar does not have", "2026-02-30T00:00:00Z"],
  ])("refuses %s timestamp before anything is signed or persisted", async (_label, timestamp) => {
    const harness = makeHarness();
    const sourceWriter = writer(harness);

    await expect(sourceWriter.append({ ...command(), timestamp })).rejects.toBeInstanceOf(SourceWriterIntegrityError);
    expect(await harness.intents.read("any")).toBeUndefined();
    expect(harness.signCount()).toBe(0);

    await expect(sourceWriter.append(command())).resolves.toBeDefined();
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
    const mismatched = createDurableSourceWriter(writerOptions(harness, { signer: otherSigner }));

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
    await createDurableSourceWriter(writerOptions(harness, { states })).append(command());

    expect(new Set(seen)).toEqual(new Set([formatOrigin(SOURCE.agent, SOURCE.name)]));
  });

  // #3481: the head's `issuedAt` is the command's timestamp verbatim, and PR #3473 made
  // that value load-bearing for acceptance (`checkRefreshWindow` rule 3). Without a
  // matching write-side bound this writer mints, signs and publishes a head its own
  // verifier permanently refuses `head-issued-ahead`.
  it("refuses a timestamp further ahead of its own clock than one freshness window", async () => {
    const harness = makeHarness();
    // command() is stamped 2026-08-03T12:00:00Z; this clock is two days behind it.
    const append = writer(harness, undefined, clockAt("2026-08-01T12:00:00.000Z")).append(command());

    await expect(append).rejects.toThrow(SourceWriterIntegrityError);
    await expect(append).rejects.toThrow(/clock/);
  });

  it("refuses a future-dated timestamp before it writes or signs anything", async () => {
    const harness = makeHarness();

    await expect(writer(harness, undefined, clockAt("2026-08-01T12:00:00.000Z")).append(command()))
      .rejects.toThrow(SourceWriterIntegrityError);

    expect(harness.blobs.values.size).toBe(0);
    expect(await harness.intentCas.read()).toBeUndefined();
    expect(await harness.stateCas.read()).toBeUndefined();
    expect(harness.signCount()).toBe(0);
  });

  it("accepts a timestamp exactly one freshness window ahead of its own clock", async () => {
    const harness = makeHarness();
    // Exactly 24h behind command()'s timestamp: the reading side's bound is `<=`.
    const receipt = await writer(harness, undefined, clockAt("2026-08-02T12:00:00.000Z")).append(command());

    expect(receipt).toMatchObject({ announcementId: "ann-1", sequence: "0000000000000001" });
  });

  // #3569: the bound governs minting a new head, never acknowledging one that already
  // exists. A backwards clock correction of more than one window (an NTP fix on a host
  // that was badly fast -- exactly the population this bound exists for) must not stop a
  // durably committed announcement from returning its receipt, or the publish path's
  // unconditional-append-plus-idempotency contract retries a committed publication until
  // wall clock catches up.
  it("returns a committed announcement's receipt however far ahead of the clock its timestamp is", async () => {
    const harness = makeHarness();
    const first = await writer(harness).append(command());
    const signCount = harness.signCount();

    // Two days behind command()'s timestamp -- past the 24h window, so minting is refused.
    const replay = await writer(harness, undefined, clockAt("2026-08-01T12:00:00.000Z")).append(command());

    expect(replay).toEqual(first);
    expect(harness.signCount()).toBe(signCount);
  });

  // The carve-out is idempotency, not a clock special case: a writer whose window has
  // since collapsed refuses to mint, but must still acknowledge what it already minted.
  it("returns a committed announcement's receipt from a writer whose window now collapses", async () => {
    const harness = makeHarness();
    const first = await writer(harness).append(command());
    const collapsed = createDurableSourceWriter(writerOptions(harness, { refreshWithinMs: 0.5 }));

    await expect(collapsed.append(command())).resolves.toEqual(first);
  });

  it("accepts a past-dated timestamp however far behind its own clock", async () => {
    const harness = makeHarness();
    const receipt = await writer(harness, undefined, clockAt("2031-01-01T00:00:00.000Z")).append(command());

    expect(receipt).toMatchObject({ announcementId: "ann-1", sequence: "0000000000000001" });
  });

  it("refuses a refresh window that truncates to nothing", async () => {
    const harness = makeHarness();
    // Sub-millisecond windows round to `refreshBy === issuedAt`, which §5.2 rule 1 refuses.
    const collapsed = createDurableSourceWriter(writerOptions(harness, { refreshWithinMs: 0.5 }));

    await expect(collapsed.append(command())).rejects.toThrow(/no consumer accepts/);
  });

  // Was "refuses a timestamp whose freshness window overflows the representable
  // range": an extended-year spelling near the ECMAScript time-value limit used to
  // reach the window arithmetic and needed its own guard there. Reading the §5.2
  // grammar (#3482) refuses it one step earlier, as invalid -- a four-digit year plus
  // the 24h `refreshWithinMs` clamp cannot overflow -- so the assertion moves to the
  // refusal that now happens, and the refusal is still checked to land before the
  // writer signs or persists anything.
  it("refuses an extended-year timestamp before anything is signed or persisted", async () => {
    const harness = makeHarness();
    const extreme: AppendAnnouncementCommand = { ...command(), timestamp: "+275760-09-13T00:00:00.000Z" };

    await expect(writer(harness).append(extreme)).rejects.toThrow(SourceWriterIntegrityError);
    await expect(writer(harness).append(extreme)).rejects.toThrow(/timestamp is invalid/);
    expect(harness.blobs.values.size).toBe(0);
    expect(await harness.intentCas.read()).toBeUndefined();
    expect(harness.signCount()).toBe(0);
  });

  it("does not re-bound an already-signed recovery intent against the clock", async () => {
    const harness = makeHarness();
    await expect(writer(harness, "after-intent-before-page").append(command())).rejects.toThrow();
    expect(await harness.intentCas.read()).toBeDefined();

    // Recovery replays frozen, already-signed bytes. Re-bounding here would strand a head
    // that was in-window when it was minted, and `recover()` runs at the top of every
    // append, so the source would be wedged rather than merely delayed.
    //
    // The clock must be *behind* the intent's timestamp for this to discriminate (#3570):
    // `checkRefreshWindow` rule 3 only refuses a head issued ahead of `now`, so a clock
    // ahead of it passes the bound whether or not recovery applies it. Two days behind
    // command()'s 2026-08-03T12:00:00Z stamp is past the 24h window, so an implementation
    // that re-bounded during recovery fails here.
    await expect(writer(harness, undefined, clockAt("2026-08-01T12:00:00.000Z")).recover())
      .resolves.toMatchObject({ status: "recovered" });
  });

  // The two guards above replay an announcement already committed in STATE, which the
  // append path answers from its idempotency lookup before reaching the window check.
  // This replays a durable INTENT instead -- signed, not yet in state -- which is what
  // the carve-out at the top of the CAS loop is actually justified by: `recover()` runs
  // unconditionally there, ahead of the window refusal, precisely so an out-of-window
  // writer still finishes work that is already durable. Nothing covered that, so
  // gating the recovery on `windowFailure === undefined` left the whole suite green
  // while breaking exactly that: the intent can only be cleared by the recovery the
  // gate now skips, so that command keeps refusing until the writer's clock catches up.
  // The stall is bounded, not permanent -- an in-window append runs the recovery and
  // clears the intent -- but it is a real refusal of durable work, which is what the
  // carve-out exists to prevent.
  //
  // The clock must be BEHIND the intent's timestamp, as in the case above (#3570):
  // `checkRefreshWindow` rule 3 only refuses a head issued ahead of `now`, so a clock
  // set forward never produces the `windowFailure` the gate reads and the case would
  // not discriminate at all.
  it("finishes a durable intent on append from a writer whose clock is now out of window", async () => {
    const harness = makeHarness();
    await expect(writer(harness, "after-intent-before-page").append(command())).rejects.toThrow();
    expect(await harness.intentCas.read()).toBeDefined();
    const signCount = harness.signCount();

    const replay = await writer(harness, undefined, clockAt("2026-08-01T12:00:00.000Z")).append(command());

    expect(replay).toMatchObject({ announcementId: "ann-1", sequence: "0000000000000001" });
    // Together these say the receipt came from finishing the frozen intent, not from
    // minting a second head: nothing re-signed, and the intent is durably cleared.
    expect(harness.signCount()).toBe(signCount);
    expect(await harness.intentCas.read()).toBeUndefined();
  });
});

// #4187: an idle source re-signs its current head before `refreshBy` lapses, so a reader that
// arrives during the idle window never fetches a stale head. Design record:
// docs/superpowers/specs/2026-09-09-idle-head-heartbeat-design.md (§4 trigger, §5 primitive).
describe("idle head refresh (#4187)", () => {
  // command() is stamped T0 with the 24h default window, so its head lapses at T0+24h and
  // falls due for a refresh at T0+12h, half the window it was minted with.
  const T0 = "2026-08-03T12:00:00.000Z";
  const DUE = "2026-08-04T00:00:00.000Z";
  const JUST_BEFORE_DUE = "2026-08-03T23:59:59.999Z";

  interface ServedHead {
    readonly bytes: Uint8Array;
    readonly envelope: { payloadType: string; payload: string; signatures: { keyid?: string; sig: string }[] };
    readonly head: { protocol: string; origin: string; sequence: string; entry: string; issuedAt: string; refreshBy: string };
  }

  async function servedHead(harness: ReturnType<typeof makeHarness>): Promise<ServedHead> {
    const stored = await harness.blobs.get(headPath(SOURCE.name));
    expect(stored?.contentType).toBe(MEDIA_HEAD);
    const envelope = JSON.parse(new TextDecoder().decode(stored!.bytes)) as ServedHead["envelope"];
    const head = JSON.parse(new TextDecoder().decode(
      Uint8Array.from(atob(envelope.payload), (character) => character.charCodeAt(0)),
    )) as ServedHead["head"];
    return { bytes: stored!.bytes, envelope, head };
  }

  function commandAt(announcementId: string, timestamp: string): AppendAnnouncementCommand {
    return { ...command(available(announcementId)), timestamp };
  }

  function refresher(harness: ReturnType<typeof makeHarness>, at: string, overrides: Partial<DurableSourceWriterOptions> = {}) {
    return createDurableSourceWriter(writerOptions(harness, { clock: clockAt(at), ...overrides }));
  }

  /** A cold or returning reader of the served chain, holding its own high-water mark. */
  function reader(harness: ReturnType<typeof makeHarness>) {
    const marks = new Map<string, HighWaterMark>();
    const key = { keyid: harness.signer.keyId, publicKey: "test-key", algorithm: "test" };
    return {
      marks,
      async verify(head: ServedHead, at: string, firstAdoption: boolean) {
        const page = JSON.parse(new TextDecoder().decode(
          (await harness.blobs.get(archivePagePath(SOURCE.name, head.head.sequence)))!.bytes,
        )) as ArchivePage;
        return verifySourceChain({
          head: parseSourceHead(head.head),
          headSignature: head.envelope as DsseEnvelope,
          entries: (async function* () {
            for (const signed of firstAdoption ? page.entries : []) yield signed as never;
          })(),
          ports: {
            keys: { resolve: async () => [key], everBound: async (_agent, keyid) => keyid === key.keyid },
            sigs: { verify: async (pae, signature) => equalBytes(pae, signature) },
            fresh: { isFresh: (refreshBy, now) => Date.parse(refreshBy) > now.getTime() },
            hwm: {
              get: async (source) => marks.get(formatOrigin(source.agent, source.name)),
              put: async (source, mark) => { marks.set(formatOrigin(source.agent, source.name), mark); },
            },
            now: new Date(at),
            firstAdoption,
          },
        });
      },
    };
  }

  it("re-signs a head idle for half its window at the same position, re-basing refreshBy", async () => {
    const harness = makeHarness();
    await writer(harness).append(command());
    const before = await servedHead(harness);
    const stateBefore = (await harness.stateCas.read())!.value;

    const outcome = await refresher(harness, DUE).refreshIdleHead();

    expect(outcome).toEqual({
      status: "refreshed",
      previous: { issuedAt: T0, refreshBy: "2026-08-04T12:00:00.000Z" },
      current: { issuedAt: DUE, refreshBy: "2026-08-05T00:00:00.000Z" },
    });
    const after = await servedHead(harness);
    // Position is untouched; only the two instants move, and `refreshBy` moves because it is
    // recomputed from the new `issuedAt` -- the re-basing IS the heartbeat (design §2).
    expect(after.head).toEqual({ ...before.head, issuedAt: DUE, refreshBy: "2026-08-05T00:00:00.000Z" });
    expect(after.envelope.signatures).toEqual([
      { keyid: harness.signer.keyId, sig: encodeBase64(dssePreAuthEncoding(MEDIA_HEAD, sealJson(after.head).bytes)) },
    ]);
    expect((await harness.stateCas.read())!.value).toEqual(stateBefore);
    expect(await harness.intentCas.read()).toBeUndefined();
  });

  it("leaves a head with more than half its window remaining byte-identical", async () => {
    const harness = makeHarness();
    await writer(harness).append(command());
    const before = await servedHead(harness);
    const signCount = harness.signCount();

    const outcome = await refresher(harness, JUST_BEFORE_DUE).refreshIdleHead();

    expect(outcome).toEqual({ status: "not-due", current: { issuedAt: T0, refreshBy: "2026-08-04T12:00:00.000Z" } });
    expect((await servedHead(harness)).bytes).toEqual(before.bytes);
    expect(harness.signCount()).toBe(signCount);
  });

  it("re-signs a head that has already lapsed", async () => {
    const harness = makeHarness();
    await writer(harness).append(command());

    const outcome = await refresher(harness, "2026-08-06T12:00:00.000Z").refreshIdleHead();

    expect(outcome).toMatchObject({ status: "refreshed", current: { issuedAt: "2026-08-06T12:00:00.000Z", refreshBy: "2026-08-07T12:00:00.000Z" } });
  });

  it("has nothing to refresh for a source that never appended, and writes nothing", async () => {
    const harness = makeHarness();

    await expect(refresher(harness, DUE).refreshIdleHead()).resolves.toEqual({ status: "no-position" });
    expect(harness.blobs.values.size).toBe(0);
    expect(harness.signCount()).toBe(0);
  });

  it("keeps every successive window at the profile clamp rather than widening it", async () => {
    const harness = makeHarness();
    await writer(harness).append(command());

    const first = await refresher(harness, DUE).refreshIdleHead();
    const early = await refresher(harness, "2026-08-04T11:59:59.999Z").refreshIdleHead();
    const second = await refresher(harness, "2026-08-04T12:00:00.000Z").refreshIdleHead();

    expect(first).toMatchObject({ status: "refreshed", current: { issuedAt: DUE, refreshBy: "2026-08-05T00:00:00.000Z" } });
    // The trigger reads the window the served head was minted with, so the second beat falls
    // due half a window after the first, not half a window after the original append.
    expect(early).toMatchObject({ status: "not-due" });
    expect(second).toMatchObject({ status: "refreshed", current: { issuedAt: "2026-08-04T12:00:00.000Z", refreshBy: "2026-08-05T12:00:00.000Z" } });
    const head = (await servedHead(harness)).head;
    expect(Date.parse(head.refreshBy) - Date.parse(head.issuedAt)).toBe(24 * 60 * 60 * 1000);
  });

  it("reads the wall clock when no clock is injected", async () => {
    const harness = makeHarness();
    await writer(harness).append(command());
    const before = Date.now();

    const outcome = await createDurableSourceWriter({ ...writerOptions(harness), clock: undefined }).refreshIdleHead();

    const after = Date.now();
    expect(outcome.status).toBe("refreshed");
    const issuedAt = Date.parse((await servedHead(harness)).head.issuedAt);
    expect(issuedAt).toBeGreaterThanOrEqual(before);
    expect(issuedAt).toBeLessThanOrEqual(after);
  });

  it("serves a cold reader a head that passes the chain check where the idle head is stale", async () => {
    const harness = makeHarness();
    await writer(harness).append(command());
    const idle = await servedHead(harness);
    const coldAt = "2026-08-05T06:00:00.000Z";

    // Round-10 as a cold reader sees it: the idle head has lapsed, so it is refused.
    await expect(reader(harness).verify(idle, coldAt, true)).resolves.toEqual({ status: "stale" });

    await refresher(harness, "2026-08-05T00:00:00.000Z").refreshIdleHead();
    await expect(reader(harness).verify(await servedHead(harness), coldAt, true)).resolves.toMatchObject({ status: "ok" });
  });

  it("leaves a replay of the head it superseded refused by a reader that holds the re-signed one", async () => {
    const harness = makeHarness();
    await writer(harness).append(command());
    const superseded = await servedHead(harness);
    await refresher(harness, DUE).refreshIdleHead();
    const current = await servedHead(harness);
    // Both heads are inside `refreshBy` at this instant, so freshness cannot be what refuses.
    const at = "2026-08-04T01:00:00.000Z";
    const consumer = reader(harness);

    await expect(consumer.verify(current, at, true)).resolves.toMatchObject({ status: "ok" });
    expect(consumer.marks.get(formatOrigin(SOURCE.agent, SOURCE.name))).toMatchObject({ issuedAt: DUE });
    // Same sequence, same entry, an earlier `issuedAt`: a rollback mirror's replay.
    await expect(consumer.verify(superseded, at, false))
      .resolves.toEqual({ status: "broken-chain", at: "issued-at-monotonicity" });
  });

  it("lets a new record advance the source from the re-signed head, as it would without one", async () => {
    const harness = makeHarness();
    await writer(harness).append(command());
    await refresher(harness, DUE).refreshIdleHead();
    const refreshed = await servedHead(harness);

    // The append floor is the head actually served, so a timestamp at or before the re-signed
    // instant is refused exactly as one at or before an appended head is.
    await expect(refresher(harness, DUE).append(commandAt("ann-2", DUE))).rejects.toThrow("strictly advance");
    const receipt = await refresher(harness, "2026-08-04T00:00:01.000Z").append(commandAt("ann-2", "2026-08-04T00:00:01.000Z"));

    expect(receipt.sequence).toBe("0000000000000002");
    const appended = (await servedHead(harness)).head;
    expect(appended).toMatchObject({
      sequence: "0000000000000002",
      entry: receipt.entryDigest,
      issuedAt: "2026-08-04T00:00:01.000Z",
      refreshBy: "2026-08-05T00:00:01.000Z",
    });
    expect(appended.entry).not.toBe(refreshed.head.entry);
  });

  it("finishes a crashed append before it judges the head, so the refresh never writes under it", async () => {
    const harness = makeHarness();
    await writer(harness).append(command());
    await expect(writer(harness, "after-intent-before-page").append(commandAt("ann-2", "2026-08-03T12:01:00.000Z")))
      .rejects.toThrow("fault:after-intent-before-page");

    // The recovered append's head is minted at 12:01, so it is not yet due at DUE.
    await expect(refresher(harness, DUE).refreshIdleHead()).resolves.toMatchObject({ status: "not-due" });
    expect(await harness.intentCas.read()).toBeUndefined();
    expect((await servedHead(harness)).head.sequence).toBe("0000000000000002");
  });

  it("refuses when an append stages an intent mid-refresh, and the source stays appendable", async () => {
    const harness = makeHarness();
    await writer(harness).append(command());
    const before = await servedHead(harness);
    let raced = false;
    const racingSigner: DurableSourceSigner = {
      ...harness.signer,
      async sign(pae) {
        if (!raced) {
          raced = true;
          // A concurrent append claims its intent after the refresh has judged the head and
          // before it writes. Writing now would make that intent's own head guard throw on
          // every later recover() -- the permanent wedge the interlock exists to prevent.
          await expect(writer(harness, "after-intent-before-page").append(commandAt("ann-2", "2026-08-03T12:01:00.000Z")))
            .rejects.toThrow("fault:after-intent-before-page");
        }
        return harness.signer.sign(pae);
      },
    };

    const outcome = await refresher(harness, DUE, { signer: racingSigner }).refreshIdleHead();

    expect(raced).toBe(true);
    expect(outcome).toEqual({ status: "append-in-flight" });
    expect((await servedHead(harness)).bytes).toEqual(before.bytes);
    await expect(writer(harness).recover()).resolves.toMatchObject({ status: "recovered" });
    const third = await refresher(harness, "2026-08-03T12:02:00.000Z").append(commandAt("ann-3", "2026-08-03T12:02:00.000Z"));
    expect(third.sequence).toBe("0000000000000003");
  });

  it("returns a store failure as faulted, leaves the head as it was, and the next append proceeds", async () => {
    const harness = makeHarness();
    await writer(harness).append(command());
    const before = await servedHead(harness);
    const failure = new Error("disk full");
    const failingBlobs: ReadableImmutableBlobStore = {
      get: (path) => harness.blobs.get(path),
      putImmutable: (path, bytes, contentType) => harness.blobs.putImmutable(path, bytes, contentType),
      put: async () => { throw failure; },
    };

    const outcome = await refresher(harness, DUE, { blobs: failingBlobs }).refreshIdleHead();

    expect(outcome).toEqual({ status: "faulted", error: failure });
    expect((await servedHead(harness)).bytes).toEqual(before.bytes);
    const receipt = await refresher(harness, DUE).append(commandAt("ann-2", DUE));
    expect(receipt.sequence).toBe("0000000000000002");
  });

  it("refuses a candidate its own window check rejects, without signing or writing", async () => {
    const harness = makeHarness();
    await writer(harness).append(command());
    // The trigger reads the served window, so an honest head is never due while it is issued
    // ahead of the clock; only a deeply inverted one is. Forged here so the guard (design §5.3)
    // is exercised directly: `issuedAt + 1ms` would be carried forward, a day past the clock.
    const state = (await harness.stateCas.read())!.value;
    const forged = {
      protocol: (await servedHead(harness)).head.protocol,
      origin: formatOrigin(SOURCE.agent, SOURCE.name),
      sequence: state.last!.sequence,
      entry: state.last!.entryDigest,
      issuedAt: "2026-08-06T12:00:00.000Z",
      refreshBy: "2026-08-02T12:00:00.000Z",
    };
    const payload = sealJson(forged).bytes;
    const envelope = {
      payloadType: MEDIA_HEAD,
      payload: encodeBase64(payload),
      signatures: [{ keyid: harness.signer.keyId, sig: encodeBase64(dssePreAuthEncoding(MEDIA_HEAD, payload)) }],
    };
    harness.blobs.force(headPath(SOURCE.name), sealJson(envelope).bytes, MEDIA_HEAD);
    const signCount = harness.signCount();

    const outcome = await refresher(harness, "2026-08-04T12:00:00.000Z").refreshIdleHead();

    expect(outcome).toEqual({
      status: "refused",
      reason: "head-issued-ahead",
      current: { issuedAt: "2026-08-06T12:00:00.000Z", refreshBy: "2026-08-02T12:00:00.000Z" },
    });
    expect(harness.signCount()).toBe(signCount);
    expect((await servedHead(harness)).bytes).toEqual(sealJson(envelope).bytes);
  });
});
