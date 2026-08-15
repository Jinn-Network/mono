import type {
  Announcement,
  AnnouncementEntry,
  SourceHead,
  SourceIdentity,
} from "@jinn-network/record-discovery-protocol";
import {
  DISCOVERY_SIGNING_SCOPE,
  CEILINGS,
  GENESIS_SEQUENCE,
  MEDIA_ENTRY,
  MEDIA_HEAD,
  RECORD_DISCOVERY_VERSION,
  archivePagePath,
  dssePreAuthEncoding,
  formatOrigin,
  headPath,
  nextSequence,
  parseAnnouncementEntry,
  parseSourceHead,
  recordDigest,
  recordPath,
  sealJson,
} from "@jinn-network/record-discovery-protocol";

import type { ArchivePage } from "./archive.js";
import { signAnnouncementEntry, type ScopedDiscoverySigner } from "./entry-signing.js";
import { MAX_REFRESH_BY_AHEAD_MS, signHead, type DsseEnvelope } from "./head.js";
import type { ReadableImmutableBlobStore, StoredBlob } from "./ports.js";

const ARCHIVE_PAGE_CONTENT_TYPE = "application/json";
const DEFAULT_RECORD_CONTENT_TYPE = "application/octet-stream";
const MAX_CAS_ATTEMPTS = 32;

export interface CasSnapshot<T> {
  readonly revision: string;
  readonly value: T;
}

export type CasWriteResult =
  | { readonly ok: true; readonly revision: string }
  | { readonly ok: false };

/** Durable source state. Revisions are opaque and owned by the adapter. */
export interface SourceStateStore {
  read(sourceId: string): Promise<CasSnapshot<DurableSourceState> | undefined>;
  compareAndSwap(
    sourceId: string,
    expectedRevision: string | null,
    next: DurableSourceState,
  ): Promise<CasWriteResult>;
}

/**
 * Single in-flight append intent per source. `next: undefined` is a CAS
 * delete. The store must preserve the frozen base64 byte strings exactly.
 */
export interface SourceAppendIntentStore {
  read(sourceId: string): Promise<CasSnapshot<DurableSourceAppendIntent> | undefined>;
  compareAndSwap(
    sourceId: string,
    expectedRevision: string | null,
    next: DurableSourceAppendIntent | undefined,
  ): Promise<CasWriteResult>;
}

export interface DurableSourceSigner extends ScopedDiscoverySigner {
  /** Stable key identifier bound to this source state. */
  readonly keyId: string;
  /** Verifies persisted signed bytes before recovery or continuation. */
  verify(pae: Uint8Array, signature: Uint8Array): boolean | Promise<boolean>;
}

export interface DurableSourcePosition {
  readonly sequence: string;
  readonly entryDigest: `sha256:${string}`;
  readonly page: string;
}

export interface DurableSourceReceipt {
  readonly source: SourceIdentity;
  readonly announcementId: string;
  readonly fingerprint: `sha256:${string}`;
  readonly sequence: string;
  readonly entryDigest: `sha256:${string}`;
  readonly page: string;
  readonly record?: {
    readonly digest: `sha256:${string}`;
    readonly path: string;
    readonly contentType: string;
  };
}

export interface DurablePublishedAnnouncement {
  readonly action: Announcement["action"];
  readonly fingerprint: `sha256:${string}`;
  readonly receipt: DurableSourceReceipt;
}

export interface DurableSourceState {
  readonly version: 1;
  readonly source: SourceIdentity;
  readonly signerKeyId: string;
  readonly last: DurableSourcePosition | null;
  readonly announcements: Readonly<Record<string, DurablePublishedAnnouncement>>;
}

export interface FrozenSourceBlob {
  readonly path: string;
  readonly contentType: string;
  readonly digest: `sha256:${string}`;
  readonly bytesBase64: string;
}

export interface DurableSourceAppendIntent {
  readonly version: 1;
  readonly source: SourceIdentity;
  readonly signerKeyId: string;
  readonly announcementId: string;
  readonly fingerprint: `sha256:${string}`;
  readonly expectedStateRevision: string | null;
  readonly previousStateDigest: `sha256:${string}` | null;
  readonly previousPosition: DurableSourcePosition | null;
  readonly expectedHeadDigest: `sha256:${string}` | null;
  readonly previousHeadIssuedAt: string | null;
  readonly record: NonNullable<DurableSourceReceipt["record"]> | null;
  /** Exact signed archive page bytes. Recovery never signs them again. */
  readonly page: FrozenSourceBlob;
  /** Exact signed mutable head bytes. Recovery never signs them again. */
  readonly head: FrozenSourceBlob;
  readonly nextState: DurableSourceState;
  readonly receipt: DurableSourceReceipt;
}

export interface AppendAnnouncementCommand {
  readonly announcement: Announcement;
  /** Exact timestamp written into the Announcement Entry and Source Head. */
  readonly timestamp: string;
  /** Required for `available`; forbidden for `withdrawn`. */
  readonly record?: {
    readonly bytes: Uint8Array;
    readonly contentType?: string;
  };
}

export type SourceWriterFaultBoundary =
  | "after-record-before-intent"
  | "after-intent-before-page"
  | "after-page-before-head"
  | "after-head-before-state"
  | "after-state-before-intent-clear";

export interface SourceWriterFaultInjector {
  at(boundary: SourceWriterFaultBoundary): Promise<void>;
}

export interface DurableSourceRecoveryReport {
  readonly status: "idle" | "recovered";
  readonly receipt?: DurableSourceReceipt;
}

export interface DurableSourceWriter {
  append(command: AppendAnnouncementCommand): Promise<DurableSourceReceipt>;
  recover(): Promise<DurableSourceRecoveryReport>;
  readState(): Promise<DurableSourceState | undefined>;
}

export interface DurableSourceWriterOptions {
  readonly source: SourceIdentity;
  readonly signer: DurableSourceSigner;
  readonly blobs: ReadableImmutableBlobStore;
  readonly states: SourceStateStore;
  readonly intents: SourceAppendIntentStore;
  readonly faults?: SourceWriterFaultInjector;
  readonly refreshWithinMs?: number;
}

export class SourceAnnouncementConflictError extends Error {
  readonly announcementId: string;

  constructor(announcementId: string, message: string) {
    super(`announcementId "${announcementId}" conflict: ${message}`);
    this.name = "SourceAnnouncementConflictError";
    this.announcementId = announcementId;
  }
}

export class SourceWriterIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceWriterIntegrityError";
  }
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

function decodeJson<T>(bytes: Uint8Array): T {
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function sameSource(left: SourceIdentity, right: SourceIdentity): boolean {
  return left.agent === right.agent && left.name === right.name;
}

function stateDigest(state: DurableSourceState): `sha256:${string}` {
  return sealJson(state).digest;
}

function freezeJson<T>(value: T): T {
  return decodeJson<T>(sealJson(value).bytes);
}

async function assertSignerEnvelope(
  envelope: DsseEnvelope,
  signer: DurableSourceSigner,
  label: string,
  payloadType: string,
  expectedPayload: Uint8Array,
): Promise<void> {
  if (envelope.payloadType !== payloadType || !equalBytes(decodeBase64(envelope.payload), expectedPayload)) {
    throw new SourceWriterIntegrityError(`${label} envelope does not carry the exact expected payload bytes`);
  }
  if (envelope.signatures.length === 0) {
    throw new SourceWriterIntegrityError(`${label} signer returned no signatures`);
  }
  const pae = dssePreAuthEncoding(payloadType, expectedPayload);
  for (const signature of envelope.signatures) {
    if (signature.keyid !== signer.keyId) {
      throw new SourceWriterIntegrityError(
        `${label} signature keyid ${JSON.stringify(signature.keyid)} does not match source signer ${JSON.stringify(signer.keyId)}`,
      );
    }
    if (!await signer.verify(pae, decodeBase64(signature.sig))) {
      throw new SourceWriterIntegrityError(`${label} signature is not valid for the owned source key`);
    }
  }
}

function assertStoredBlob(
  stored: StoredBlob | undefined,
  expectedBytes: Uint8Array,
  expectedContentType: string,
  label: string,
): void {
  if (stored === undefined) {
    throw new SourceWriterIntegrityError(`${label} was not readable after write`);
  }
  if (stored.contentType !== expectedContentType || !equalBytes(stored.bytes, expectedBytes)) {
    throw new SourceWriterIntegrityError(`${label} readback did not match the exact bytes and content type written`);
  }
}

async function putImmutableExact(
  blobs: ReadableImmutableBlobStore,
  path: string,
  bytes: Uint8Array,
  contentType: string,
  label: string,
): Promise<void> {
  await blobs.putImmutable(path, bytes, contentType);
  assertStoredBlob(await blobs.get(path), bytes, contentType, label);
}

function parseHeadEnvelope(bytes: Uint8Array): {
  envelope: DsseEnvelope;
  head: SourceHead;
  headBytes: Uint8Array;
} {
  const envelope = decodeJson<DsseEnvelope>(bytes);
  if (envelope.payloadType !== MEDIA_HEAD) {
    throw new SourceWriterIntegrityError(`source head envelope payloadType must be ${MEDIA_HEAD}`);
  }
  const headBytes = decodeBase64(envelope.payload);
  const head = parseSourceHead(decodeJson<unknown>(headBytes));
  if (!equalBytes(sealJson(head).bytes, headBytes)) {
    throw new SourceWriterIntegrityError("source head payload is not the exact sealed Source Head bytes");
  }
  return { envelope, head, headBytes };
}

async function assertHeadMatchesState(
  stored: StoredBlob | undefined,
  source: SourceIdentity,
  state: DurableSourceState,
  signer: DurableSourceSigner,
): Promise<{ readonly digest: `sha256:${string}`; readonly issuedAt: string } | null> {
  if (state.last === null) {
    if (stored !== undefined) {
      throw new SourceWriterIntegrityError("source has no committed state position but a head already exists");
    }
    return null;
  }
  if (stored === undefined) {
    throw new SourceWriterIntegrityError("committed source state has no readable head");
  }
  if (stored.contentType !== MEDIA_HEAD) {
    throw new SourceWriterIntegrityError(`source head content type must be ${MEDIA_HEAD}`);
  }
  const { envelope, head, headBytes } = parseHeadEnvelope(stored.bytes);
  await assertSignerEnvelope(envelope, signer, "existing head", MEDIA_HEAD, headBytes);
  if (
    head.origin !== formatOrigin(source.agent, source.name)
    || head.sequence !== state.last.sequence
    || head.entry !== state.last.entryDigest
  ) {
    throw new SourceWriterIntegrityError("source head does not match the committed source position");
  }
  return { digest: recordDigest(stored.bytes), issuedAt: head.issuedAt };
}

function assertStateOwnership(state: DurableSourceState, source: SourceIdentity, keyId: string): void {
  if (state.version !== 1 || !sameSource(state.source, source)) {
    throw new SourceWriterIntegrityError("durable source state belongs to a different source identity");
  }
  if (state.signerKeyId !== keyId) {
    throw new SourceWriterIntegrityError("durable source state belongs to a different signer key");
  }
}

function frozenBlob(path: string, bytes: Uint8Array, contentType: string): FrozenSourceBlob {
  return {
    path,
    bytesBase64: encodeBase64(bytes),
    contentType,
    digest: recordDigest(bytes),
  };
}

function thawFrozenBlob(blob: FrozenSourceBlob, label: string): Uint8Array {
  const bytes = decodeBase64(blob.bytesBase64);
  if (recordDigest(bytes) !== blob.digest) {
    throw new SourceWriterIntegrityError(`${label} frozen bytes do not match their digest`);
  }
  return bytes;
}

async function assertIntentOwnership(
  intent: DurableSourceAppendIntent,
  source: SourceIdentity,
  signer: DurableSourceSigner,
): Promise<void> {
  if (intent.version !== 1 || !sameSource(intent.source, source)) {
    throw new SourceWriterIntegrityError("durable append intent belongs to a different source identity");
  }
  if (intent.signerKeyId !== signer.keyId) {
    throw new SourceWriterIntegrityError("durable append intent belongs to a different signer key");
  }
  if (
    intent.receipt.announcementId !== intent.announcementId
    || intent.receipt.fingerprint !== intent.fingerprint
    || !sameSource(intent.receipt.source, source)
  ) {
    throw new SourceWriterIntegrityError("durable append intent receipt does not match its operation identity");
  }
  if ((intent.previousPosition === null) !== (intent.previousHeadIssuedAt === null)) {
    throw new SourceWriterIntegrityError("durable append intent previous position/head timestamp disagree");
  }
  assertStateOwnership(intent.nextState, source, signer.keyId);
  const published = intent.nextState.announcements[intent.announcementId];
  if (
    published === undefined
    || published.action !== pageAnnouncementAction(intent)
    || published.fingerprint !== intent.fingerprint
    || sealJson(published.receipt).digest !== sealJson(intent.receipt).digest
  ) {
    throw new SourceWriterIntegrityError("durable append intent next state does not contain its exact receipt");
  }
  if (
    intent.nextState.last?.sequence !== intent.receipt.sequence
    || intent.nextState.last.entryDigest !== intent.receipt.entryDigest
    || intent.nextState.last.page !== intent.receipt.page
  ) {
    throw new SourceWriterIntegrityError("durable append intent next position does not match its receipt");
  }

  const pageBytes = thawFrozenBlob(intent.page, "archive page");
  const page = decodeJson<ArchivePage>(pageBytes);
  if (pageBytes.length > CEILINGS.archivePageBytes) {
    throw new SourceWriterIntegrityError("frozen archive page exceeds the published-source byte ceiling");
  }
  if (!equalBytes(sealJson(page).bytes, pageBytes)) {
    throw new SourceWriterIntegrityError("frozen archive page is not exact sealed I-JSON");
  }
  if (
    intent.page.path !== archivePagePath(source.name, intent.receipt.page)
    || intent.page.contentType !== ARCHIVE_PAGE_CONTENT_TYPE
    || page.protocol !== RECORD_DISCOVERY_VERSION
    || page.source !== source.name
    || page.page !== intent.receipt.page
    || page.page !== intent.receipt.sequence
    || page.prevArchive !== (intent.previousPosition?.page ?? null)
    || page.entries.length !== 1
  ) {
    throw new SourceWriterIntegrityError("frozen archive page does not match the intended source position");
  }
  const signedEntry = page.entries[0]!;
  const entryBytes = sealJson(signedEntry.entry).bytes;
  if (entryBytes.length > CEILINGS.entrySealedBytes) {
    throw new SourceWriterIntegrityError("frozen announcement entry exceeds the published-source byte ceiling");
  }
  const expectedSequence = intent.previousPosition === null
    ? GENESIS_SEQUENCE
    : nextSequence(intent.previousPosition.sequence);
  if (
    recordDigest(entryBytes) !== intent.receipt.entryDigest
    || signedEntry.entry.source.agent !== source.agent
    || signedEntry.entry.source.name !== source.name
    || signedEntry.entry.sequence !== intent.receipt.sequence
    || signedEntry.entry.sequence !== expectedSequence
    || signedEntry.entry.previous !== (intent.previousPosition?.entryDigest ?? null)
    || signedEntry.entry.announcements.length !== 1
    || signedEntry.entry.announcements[0]!.announcementId !== intent.announcementId
    || signedEntry.signature?.payloadType !== MEDIA_ENTRY
    || !equalBytes(decodeBase64(signedEntry.signature.payload), entryBytes)
  ) {
    throw new SourceWriterIntegrityError("frozen archive page entry does not match the intended announcement");
  }
  await assertSignerEnvelope(
    signedEntry.signature,
    signer,
    "announcement entry",
    MEDIA_ENTRY,
    entryBytes,
  );

  const announcement = signedEntry.entry.announcements[0]!;
  const expectedFingerprint = sealJson({
    source,
    timestamp: signedEntry.entry.timestamp,
    announcement,
    recordContentType: intent.record?.contentType ?? null,
  }).digest;
  if (expectedFingerprint !== intent.fingerprint) {
    throw new SourceWriterIntegrityError("append intent fingerprint does not match its exact announcement input");
  }
  if (announcement.action === "available") {
    if (
      intent.record === null
      || intent.record.digest !== announcement.record.digest
      || intent.receipt.record?.digest !== announcement.record.digest
    ) {
      throw new SourceWriterIntegrityError("available intent does not bind its exact record digest");
    }
  } else if (intent.record !== null || intent.receipt.record !== undefined) {
    throw new SourceWriterIntegrityError("withdrawn intent unexpectedly carries record material");
  }

  const headBytes = thawFrozenBlob(intent.head, "source head");
  if (intent.head.path !== headPath(source.name) || intent.head.contentType !== MEDIA_HEAD) {
    throw new SourceWriterIntegrityError("frozen source head path does not match the source identity");
  }
  const { envelope, head, headBytes: exactHeadPayload } = parseHeadEnvelope(headBytes);
  await assertSignerEnvelope(envelope, signer, "source head", MEDIA_HEAD, exactHeadPayload);
  if (
    head.origin !== formatOrigin(source.agent, source.name)
    || head.sequence !== intent.receipt.sequence
    || head.entry !== intent.receipt.entryDigest
    || head.issuedAt !== signedEntry.entry.timestamp
    || (intent.previousHeadIssuedAt !== null
      && new Date(head.issuedAt).getTime() <= new Date(intent.previousHeadIssuedAt).getTime())
    || new Date(head.refreshBy).getTime() <= new Date(head.issuedAt).getTime()
    || new Date(head.refreshBy).getTime() - new Date(head.issuedAt).getTime() > MAX_REFRESH_BY_AHEAD_MS
  ) {
    throw new SourceWriterIntegrityError("frozen source head does not match the intended source position");
  }
}

function pageAnnouncementAction(intent: DurableSourceAppendIntent): Announcement["action"] {
  const page = decodeJson<ArchivePage>(thawFrozenBlob(intent.page, "archive page"));
  const announcement = page.entries[0]?.entry.announcements[0];
  if (announcement === undefined) {
    throw new SourceWriterIntegrityError("frozen archive page contains no announcement");
  }
  return announcement.action;
}

function exactCommittedState(state: DurableSourceState, intent: DurableSourceAppendIntent): boolean {
  return stateDigest(state) === stateDigest(intent.nextState);
}

function makeInitialState(source: SourceIdentity, keyId: string): DurableSourceState {
  return {
    version: 1,
    source: freezeJson(source),
    signerKeyId: keyId,
    last: null,
    announcements: {},
  };
}

export function createDurableSourceWriter(options: DurableSourceWriterOptions): DurableSourceWriter {
  const source = freezeJson(options.source);
  const sourceId = formatOrigin(source.agent, source.name);
  const requestedRefreshWithinMs = options.refreshWithinMs ?? MAX_REFRESH_BY_AHEAD_MS;
  if (!Number.isFinite(requestedRefreshWithinMs) || requestedRefreshWithinMs <= 0) {
    throw new SourceWriterIntegrityError("refreshWithinMs must be a positive finite duration");
  }
  const refreshWithinMs = Math.min(requestedRefreshWithinMs, MAX_REFRESH_BY_AHEAD_MS);

  if (options.signer.keyId.length === 0) {
    throw new SourceWriterIntegrityError("durable source signer keyId must not be empty");
  }
  if (options.signer.scope !== DISCOVERY_SIGNING_SCOPE) {
    throw new SourceWriterIntegrityError(
      `durable source signer must be bound to ${DISCOVERY_SIGNING_SCOPE}`,
    );
  }

  async function fault(boundary: SourceWriterFaultBoundary): Promise<void> {
    await options.faults?.at(boundary);
  }

  async function loadState(): Promise<{
    readonly revision: string | null;
    readonly value: DurableSourceState;
  }> {
    const stored = await options.states.read(sourceId);
    if (stored === undefined) {
      return { revision: null, value: makeInitialState(source, options.signer.keyId) };
    }
    assertStateOwnership(stored.value, source, options.signer.keyId);
    return { revision: stored.revision, value: stored.value };
  }

  async function writeHeadFromIntent(intent: DurableSourceAppendIntent): Promise<void> {
    const bytes = thawFrozenBlob(intent.head, "source head");
    const current = await options.blobs.get(intent.head.path);
    const currentDigest = current === undefined ? null : recordDigest(current.bytes);
    if (currentDigest !== intent.expectedHeadDigest && currentDigest !== intent.head.digest) {
      throw new SourceWriterIntegrityError("source head changed after the append intent was claimed");
    }
    if (current !== undefined && current.contentType !== MEDIA_HEAD) {
      throw new SourceWriterIntegrityError(`source head content type must be ${MEDIA_HEAD}`);
    }
    await options.blobs.put(intent.head.path, bytes, intent.head.contentType);
    assertStoredBlob(await options.blobs.get(intent.head.path), bytes, intent.head.contentType, "source head");
  }

  async function verifyIntentRecord(intent: DurableSourceAppendIntent): Promise<void> {
    if (intent.record === null) return;
    const stored = await options.blobs.get(intent.record.path);
    if (
      stored === undefined
      || stored.contentType !== intent.record.contentType
      || recordDigest(stored.bytes) !== intent.record.digest
      || intent.record.path !== recordPath(intent.record.digest)
    ) {
      throw new SourceWriterIntegrityError("append intent record is missing or does not match its exact digest path");
    }
  }

  async function commitIntent(snapshot: CasSnapshot<DurableSourceAppendIntent>): Promise<DurableSourceReceipt> {
    const intent = snapshot.value;
    await assertIntentOwnership(intent, source, options.signer);
    await verifyIntentRecord(intent);

    const pageBytes = thawFrozenBlob(intent.page, "archive page");
    await putImmutableExact(
      options.blobs,
      intent.page.path,
      pageBytes,
      intent.page.contentType,
      "archive page",
    );
    await fault("after-page-before-head");

    await writeHeadFromIntent(intent);
    await fault("after-head-before-state");

    let state = await loadState();
    if (!exactCommittedState(state.value, intent)) {
      if (
        state.revision !== intent.expectedStateRevision
        || (state.revision === null
          ? intent.previousStateDigest !== null
          : stateDigest(state.value) !== intent.previousStateDigest)
      ) {
        throw new SourceWriterIntegrityError("source state changed after the append intent was claimed");
      }

      const committed = await options.states.compareAndSwap(
        sourceId,
        intent.expectedStateRevision,
        intent.nextState,
      );
      if (!committed.ok) {
        state = await loadState();
        if (!exactCommittedState(state.value, intent)) {
          throw new SourceWriterIntegrityError("source state CAS lost to a different append");
        }
      }
    }
    await fault("after-state-before-intent-clear");

    let intentRevision = snapshot.revision;
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const cleared = await options.intents.compareAndSwap(sourceId, intentRevision, undefined);
      if (cleared.ok) return intent.receipt;
      const current = await options.intents.read(sourceId);
      if (current === undefined) return intent.receipt;
      if (sealJson(current.value).digest !== sealJson(intent).digest) {
        throw new SourceWriterIntegrityError("append intent changed before it could be cleared");
      }
      intentRevision = current.revision;
    }
    throw new SourceWriterIntegrityError("append intent clear exceeded the CAS retry bound");
  }

  async function recover(): Promise<DurableSourceRecoveryReport> {
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const intent = await options.intents.read(sourceId);
      if (intent === undefined) return { status: "idle" };
      const receipt = await commitIntent(intent);
      if (await options.intents.read(sourceId) === undefined) {
        return { status: "recovered", receipt };
      }
    }
    throw new SourceWriterIntegrityError("append intent recovery exceeded the CAS retry bound");
  }

  async function append(command: AppendAnnouncementCommand): Promise<DurableSourceReceipt> {
    const timestampMs = new Date(command.timestamp).getTime();
    if (!Number.isFinite(timestampMs)) {
      throw new SourceWriterIntegrityError(`announcement timestamp is invalid: ${command.timestamp}`);
    }

    const announcement = freezeJson(command.announcement);
    if (
      announcement.action === "available"
      && sealJson(announcement.facts ?? {}).bytes.length > CEILINGS.factsCardBytes
    ) {
      throw new SourceWriterIntegrityError("available announcement facts exceed the published-source byte ceiling");
    }
    let record: DurableSourceReceipt["record"] | undefined;
    if (announcement.action === "available") {
      if (command.record === undefined) {
        throw new SourceWriterIntegrityError("available announcement requires exact record bytes");
      }
      const digest = recordDigest(command.record.bytes);
      if (digest !== announcement.record.digest) {
        throw new SourceWriterIntegrityError("available announcement record digest does not match the exact record bytes");
      }
      if (
        announcement.record.mediaType !== undefined
        && command.record.contentType !== undefined
        && announcement.record.mediaType !== command.record.contentType
      ) {
        throw new SourceWriterIntegrityError("available announcement mediaType conflicts with the record content type");
      }
      const contentType = command.record.contentType
        ?? announcement.record.mediaType
        ?? DEFAULT_RECORD_CONTENT_TYPE;
      record = { digest, path: recordPath(digest), contentType };
    } else if (command.record !== undefined) {
      throw new SourceWriterIntegrityError("withdrawn announcement must not carry record bytes");
    }

    const fingerprint = sealJson({
      source,
      timestamp: command.timestamp,
      announcement,
      recordContentType: record?.contentType ?? null,
    }).digest;

    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      await recover();
      const state = await loadState();
      const existing = state.value.announcements[announcement.announcementId];
      if (existing !== undefined) {
        if (existing.fingerprint !== fingerprint) {
          throw new SourceAnnouncementConflictError(
            announcement.announcementId,
            "the source already committed different exact input bytes",
          );
        }
        return existing.receipt;
      }

      if (announcement.action === "withdrawn") {
        const target = state.value.announcements[announcement.retracts];
        if (target === undefined || target.action !== "available") {
          throw new SourceAnnouncementConflictError(
            announcement.announcementId,
            `withdrawal target "${announcement.retracts}" is not an available announcement in this source`,
          );
        }
      }

      if (record !== undefined) {
        await putImmutableExact(
          options.blobs,
          record.path,
          command.record!.bytes,
          record.contentType,
          "record",
        );
      }
      await fault("after-record-before-intent");

      const previousHead = await assertHeadMatchesState(
        await options.blobs.get(headPath(source.name)),
        source,
        state.value,
        options.signer,
      );
      if (
        previousHead !== null
        && timestampMs <= new Date(previousHead.issuedAt).getTime()
      ) {
        throw new SourceWriterIntegrityError("announcement timestamp must strictly advance the signed source head");
      }
      const sequence = state.value.last === null
        ? GENESIS_SEQUENCE
        : nextSequence(state.value.last.sequence);
      const entry: AnnouncementEntry = parseAnnouncementEntry({
        protocol: RECORD_DISCOVERY_VERSION,
        source,
        sequence,
        previous: state.value.last?.entryDigest ?? null,
        timestamp: command.timestamp,
        announcements: [announcement],
      });
      const sealedEntry = sealJson(entry);
      const entryDigest = sealedEntry.digest;
      if (sealedEntry.bytes.length > CEILINGS.entrySealedBytes) {
        throw new SourceWriterIntegrityError("announcement entry exceeds the published-source byte ceiling");
      }
      const entryEnvelope = await signAnnouncementEntry(entry, options.signer);
      await assertSignerEnvelope(
        entryEnvelope,
        options.signer,
        "announcement entry",
        MEDIA_ENTRY,
        sealedEntry.bytes,
      );

      const page = sequence;
      const archivePage: ArchivePage = {
        protocol: RECORD_DISCOVERY_VERSION,
        source: source.name,
        page,
        prevArchive: state.value.last?.page ?? null,
        entries: [{ entry, signature: entryEnvelope }],
      };
      const pageBytes = sealJson(archivePage).bytes;
      if (pageBytes.length > CEILINGS.archivePageBytes) {
        throw new SourceWriterIntegrityError("archive page exceeds the published-source byte ceiling");
      }

      const issuedAt = command.timestamp;
      const head: SourceHead = {
        protocol: RECORD_DISCOVERY_VERSION,
        origin: sourceId,
        sequence,
        entry: entryDigest,
        issuedAt,
        refreshBy: new Date(timestampMs + refreshWithinMs).toISOString(),
      };
      const headEnvelope = await signHead(head, options.signer);
      await assertSignerEnvelope(
        headEnvelope,
        options.signer,
        "source head",
        MEDIA_HEAD,
        sealJson(head).bytes,
      );
      const headBytes = sealJson(headEnvelope).bytes;

      const receipt: DurableSourceReceipt = {
        source,
        announcementId: announcement.announcementId,
        fingerprint,
        sequence,
        entryDigest,
        page,
        ...(record === undefined ? {} : { record }),
      };
      const nextState: DurableSourceState = {
        ...state.value,
        last: { sequence, entryDigest, page },
        announcements: {
          ...state.value.announcements,
          [announcement.announcementId]: {
            action: announcement.action,
            fingerprint,
            receipt,
          },
        },
      };
      const intent: DurableSourceAppendIntent = {
        version: 1,
        source,
        signerKeyId: options.signer.keyId,
        announcementId: announcement.announcementId,
        fingerprint,
        expectedStateRevision: state.revision,
        previousStateDigest: state.revision === null ? null : stateDigest(state.value),
        previousPosition: state.value.last,
        expectedHeadDigest: previousHead?.digest ?? null,
        previousHeadIssuedAt: previousHead?.issuedAt ?? null,
        record: record ?? null,
        page: frozenBlob(
          archivePagePath(source.name, page),
          pageBytes,
          ARCHIVE_PAGE_CONTENT_TYPE,
        ),
        head: frozenBlob(headPath(source.name), headBytes, MEDIA_HEAD),
        nextState,
        receipt,
      };

      const claimed = await options.intents.compareAndSwap(sourceId, null, intent);
      if (!claimed.ok) continue;
      const snapshot: CasSnapshot<DurableSourceAppendIntent> = {
        revision: claimed.revision,
        value: intent,
      };
      await fault("after-intent-before-page");
      return commitIntent(snapshot);
    }
    throw new SourceWriterIntegrityError("source append exceeded the CAS retry bound");
  }

  return {
    append,
    recover,
    async readState() {
      const state = await options.states.read(sourceId);
      if (state === undefined) return undefined;
      assertStateOwnership(state.value, source, options.signer.keyId);
      return state.value;
    },
  };
}
