import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  DISCOVERY_SIGNING_SCOPE,
  LOCATION_PROFILE_HTTPS,
  MEDIA_ENTRY,
  MEDIA_HEAD,
  RECORD_DISCOVERY_VERSION,
  archivePagePath,
  dssePreAuthEncoding,
  formatOrigin,
  formatSequence,
  headPath,
  parseSourceHead,
  recordDigest,
  recordPath,
  sealJson,
  toAnnouncementEvent,
  type AnnouncedItem,
  type AnnouncementEntry,
  type Announcement,
  type SourceHead,
  type SourceIdentity,
} from '@jinn-network/record-discovery-protocol';
import {
  createDurableSourceWriter,
  writeWellKnownDocument,
  type ArchivePage,
  type CasSnapshot,
  type CasWriteResult,
  type DurableSourceAppendIntent,
  type DurableSourceReceipt,
  type DurableSourceSigner,
  type DurableSourceState,
  type DsseEnvelope,
  type ReadableImmutableBlobStore,
  type SourceAppendIntentStore,
  type SourceStateStore,
  type SourceWriterFaultBoundary,
} from '@jinn-network/record-discovery-serve';
import {
  createArchiveHttpHandler,
  createFsBlobStore,
  createInMemoryTailSource,
  type ArchiveHttpHandler,
} from '@jinn-network/record-discovery-transport-http';

const JSON_MEDIA_TYPE = 'application/json';
const HEAD_MEDIA_TYPE = 'application/vnd.jinn.record-discovery.head.v1+json';
const DEFAULT_OWNER_TTL_MS = 30_000;
/**
 * Bounded, non-archival SSE replay window (record-discovery design §9.3). Live consumers
 * resume through `Last-Event-ID`; a cursor evicted from this window is told to cold-sync.
 */
const DEFAULT_TAIL_REPLAY_WINDOW = 256;

export type NativeSignedSourceFaultBoundary =
  | 'after-record-before-journal'
  | 'after-journal-before-page'
  | 'after-page-before-head'
  | 'after-head-before-state'
  | 'after-state-before-journal-clear';

export interface NativeSignedSourceFaults {
  readonly afterRecordBeforeJournal?: () => void | Promise<void>;
  readonly afterJournalBeforePage?: () => void | Promise<void>;
  readonly afterPageBeforeHead?: () => void | Promise<void>;
  readonly afterHeadBeforeState?: () => void | Promise<void>;
  readonly afterStateBeforeJournalClear?: () => void | Promise<void>;
}

export interface NativeSignedSourceSigner {
  readonly keyId: string;
  sign(payload: Uint8Array): Uint8Array;
  verify(payload: Uint8Array, signature: Uint8Array): boolean;
}

export interface NativeSignedSourceReceipt {
  readonly location: string;
  readonly sequence: string;
  readonly entryDigest: `sha256:${string}`;
}

interface LastSourcePosition {
  readonly sequence: string;
  readonly entryDigest: `sha256:${string}`;
  readonly page: string;
}

interface SourceStateV1 {
  readonly version: 1;
  readonly source: SourceIdentity;
  readonly last?: LastSourcePosition;
  readonly published: Readonly<Record<string, NativeSignedSourceReceipt>>;
}

interface SourceState {
  readonly version: 2;
  readonly source: SourceIdentity;
  readonly signerKeyId: string;
  readonly last?: LastSourcePosition;
  readonly published: Readonly<Record<string, NativeSignedSourceReceipt>>;
}

interface AppendJournalV1 {
  readonly version: 1;
  readonly source: SourceIdentity;
  readonly signerKeyId: string;
  readonly publicationKey: string;
  readonly recordDigest: `sha256:${string}`;
  readonly previousLast?: LastSourcePosition;
  readonly receipt: NativeSignedSourceReceipt;
  readonly page: string;
  readonly pageBytes: string;
  readonly headBytes: string;
}

interface AppendJournalV2 {
  readonly version: 2;
  readonly source: SourceIdentity;
  readonly signerKeyId: string;
  readonly publicationKey: string;
  readonly recordDigest: `sha256:${string}`;
  readonly previousLast?: LastSourcePosition;
  readonly receipt: NativeSignedSourceReceipt;
  readonly page: string;
  readonly pageBytes: string;
  readonly headBytes: string;
  readonly intent: DurableSourceAppendIntent;
}

type AppendJournal = AppendJournalV1 | AppendJournalV2;

interface OwnerLease {
  readonly version: 1;
  readonly source: SourceIdentity;
  readonly signerKeyId: string;
  readonly pid: number;
  readonly token: string;
  readonly acquiredAt: string;
  readonly expiresAt: string;
}

export class NativeSignedSourceIntegrityError extends Error {
  override readonly name = 'NativeSignedSourceIntegrityError';
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function decodeBase64(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, 'base64'));
}

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${randomBytes(8).toString('hex')}`;
  try {
    await writeFile(temporary, `${JSON.stringify(value)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

function sourceMatches(left: SourceIdentity, right: SourceIdentity): boolean {
  return left.agent === right.agent && left.name === right.name;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function acquireOwner(input: {
  readonly rootDir: string;
  readonly ownerFile: string;
  readonly source: SourceIdentity;
  readonly signerKeyId: string;
  readonly now: () => Date;
  readonly ttlMs: number;
  readonly isPidAlive: (pid: number) => boolean;
  readonly ownershipError: (message: string) => Error;
}): Promise<{ readonly path: string; readonly lease: OwnerLease }> {
  await mkdir(input.rootDir, { recursive: true, mode: 0o700 });
  const path = join(input.rootDir, input.ownerFile);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const now = input.now();
    const lease: OwnerLease = {
      version: 1,
      source: input.source,
      signerKeyId: input.signerKeyId,
      pid: process.pid,
      token: randomBytes(16).toString('hex'),
      acquiredAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + input.ttlMs).toISOString(),
    };
    try {
      await writeFile(path, `${JSON.stringify(lease)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      return { path, lease };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const existing = await readJson<OwnerLease>(path);
    if (existing === undefined) continue;
    if (existing.version !== 1
      || !sourceMatches(existing.source, input.source)
      || existing.signerKeyId !== input.signerKeyId
      || !Number.isSafeInteger(existing.pid)
      || existing.pid <= 0
      || typeof existing.token !== 'string'
      || existing.token.length < 16) {
      throw input.ownershipError('source owner lease has a different or unauthenticated identity');
    }
    const expiresAt = Date.parse(existing.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt > input.now().getTime() || input.isPidAlive(existing.pid)) {
      throw input.ownershipError(`source state path already has a lifecycle owner: ${input.rootDir}`);
    }
    const quarantine = `${path}.stale-${existing.token}-${randomBytes(6).toString('hex')}`;
    try {
      await rename(path, quarantine);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
  }
  throw input.ownershipError(`could not acquire source lifecycle ownership: ${input.rootDir}`);
}

async function releaseOwner(path: string, token: string): Promise<void> {
  const current = await readJson<OwnerLease>(path);
  if (current?.token === token) await unlink(path).catch(() => undefined);
}

function verifyEnvelope(input: {
  readonly bytes: Uint8Array;
  readonly payloadType: string;
  readonly expectedPayload: Uint8Array;
  readonly signer: NativeSignedSourceSigner;
  readonly label: string;
}): void {
  let envelope: DsseEnvelope;
  try {
    envelope = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(input.bytes)) as DsseEnvelope;
  } catch (error) {
    throw new NativeSignedSourceIntegrityError(`${input.label} envelope is invalid JSON: ${String(error)}`);
  }
  if (envelope.payloadType !== input.payloadType || envelope.signatures.length !== 1) {
    throw new NativeSignedSourceIntegrityError(`${input.label} envelope has an invalid payload type or signature cardinality`);
  }
  const payload = decodeBase64(envelope.payload);
  if (!sameBytes(payload, input.expectedPayload)) {
    throw new NativeSignedSourceIntegrityError(`${input.label} envelope payload is not the expected canonical bytes`);
  }
  const signature = envelope.signatures[0]!;
  if (signature.keyid !== input.signer.keyId
    || !input.signer.verify(dssePreAuthEncoding(input.payloadType, payload), decodeBase64(signature.sig))) {
    throw new NativeSignedSourceIntegrityError(`${input.label} envelope signature is not valid for the owned source key`);
  }
}

function parseAndVerifyPage(input: {
  readonly bytes: Uint8Array;
  readonly source: SourceIdentity;
  readonly signer: NativeSignedSourceSigner;
  readonly expectedPage: string;
  readonly previousPage: string | null;
  readonly previousEntry: `sha256:${string}` | null;
}): { readonly entry: AnnouncementEntry; readonly entryDigest: `sha256:${string}` } {
  let page: ArchivePage;
  try {
    page = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(input.bytes)) as ArchivePage;
  } catch (error) {
    throw new NativeSignedSourceIntegrityError(`archive page is invalid JSON: ${String(error)}`);
  }
  if (page.protocol !== RECORD_DISCOVERY_VERSION
    || page.source !== input.source.name
    || page.page !== input.expectedPage
    || page.prevArchive !== input.previousPage
    || page.entries.length !== 1
    || page.entries[0]?.signature === undefined) {
    throw new NativeSignedSourceIntegrityError('archive page breaks source/page continuity');
  }
  const entry = page.entries[0].entry;
  if (!sourceMatches(entry.source, input.source)
    || entry.sequence !== input.expectedPage
    || entry.previous !== input.previousEntry) {
    throw new NativeSignedSourceIntegrityError('archive entry breaks signed source continuity');
  }
  const entryBytes = sealJson(entry).bytes;
  verifyEnvelope({
    bytes: sealJson(page.entries[0].signature).bytes,
    payloadType: MEDIA_ENTRY,
    expectedPayload: entryBytes,
    signer: input.signer,
    label: 'archive entry',
  });
  return { entry, entryDigest: sealJson(entry).digest };
}

function parseAndVerifyHead(input: {
  readonly bytes: Uint8Array;
  readonly source: SourceIdentity;
  readonly signer: NativeSignedSourceSigner;
  readonly sequence: string;
  readonly entryDigest: `sha256:${string}`;
}): SourceHead {
  const envelope = JSON.parse(new TextDecoder().decode(input.bytes)) as DsseEnvelope;
  const payload = decodeBase64(envelope.payload);
  const head = parseSourceHead(JSON.parse(new TextDecoder().decode(payload)));
  if (head.origin !== formatOrigin(input.source.agent, input.source.name)
    || head.sequence !== input.sequence
    || head.entry !== input.entryDigest) {
    throw new NativeSignedSourceIntegrityError('signed head does not name the recovered source tip');
  }
  verifyEnvelope({
    bytes: input.bytes,
    payloadType: MEDIA_HEAD,
    expectedPayload: sealJson(head).bytes,
    signer: input.signer,
    label: 'source head',
  });
  return head;
}

interface ReconstructedHistory {
  readonly durable: DurableSourceState;
  readonly legacyPublished: Readonly<Record<string, NativeSignedSourceReceipt>>;
  readonly lastTimestamp?: string;
}

async function reconstructCommittedHistory(input: {
  readonly store: ReturnType<typeof createFsBlobStore>;
  readonly source: SourceIdentity;
  readonly signerKeyId: string;
  readonly last?: LastSourcePosition;
  readonly expectedPublished?: Readonly<Record<string, NativeSignedSourceReceipt>>;
  readonly signer: NativeSignedSourceSigner;
  readonly skipHead?: boolean;
}): Promise<ReconstructedHistory> {
  if (input.last === undefined) {
    if (!input.skipHead && await input.store.get(headPath(input.source.name)) !== undefined) {
      throw new NativeSignedSourceIntegrityError('public signed head exists without committed source state or append journal');
    }
    const durable: DurableSourceState = {
      version: 1,
      source: input.source,
      signerKeyId: input.signerKeyId,
      last: null,
      announcements: {},
    };
    if (input.expectedPublished !== undefined && Object.keys(input.expectedPublished).length !== 0) {
      throw new NativeSignedSourceIntegrityError('source state has receipts without a committed archive tip');
    }
    return { durable, legacyPublished: {} };
  }
  let previousPage: string | null = null;
  let previousEntry: `sha256:${string}` | null = null;
  let lastTimestamp: string | undefined;
  const authenticated = new Map<string, NativeSignedSourceReceipt>();
  const announcements: Record<string, DurableSourceState['announcements'][string]> = {};
  for (let number = 1n; number <= BigInt(input.last.page); number += 1n) {
    const page = formatSequence(number);
    const stored = await input.store.get(archivePagePath(input.source.name, page));
    if (stored === undefined) throw new NativeSignedSourceIntegrityError(`committed archive page ${page} is missing`);
    const verified = parseAndVerifyPage({
      bytes: stored.bytes,
      source: input.source,
      signer: input.signer,
      expectedPage: page,
      previousPage,
      previousEntry,
    });
    previousPage = page;
    previousEntry = verified.entryDigest;
    lastTimestamp = verified.entry.timestamp;
    const announcement = verified.entry.announcements[0];
    if (verified.entry.announcements.length !== 1 || announcement === undefined) {
      throw new NativeSignedSourceIntegrityError('owned archive entry has unexpected announcement cardinality');
    }
    let receipt: DurableSourceReceipt;
    let fingerprint: `sha256:${string}`;
    if (announcement.action === 'available') {
      if (announcement.locations?.length !== 1) {
        throw new NativeSignedSourceIntegrityError('owned available announcement has no unique exact location');
      }
      const path = recordPath(announcement.record.digest);
      const storedRecord = await input.store.get(path);
      if (storedRecord === undefined || recordDigest(storedRecord.bytes) !== announcement.record.digest) {
        throw new NativeSignedSourceIntegrityError('owned available announcement exact record is missing');
      }
      if (announcement.record.mediaType !== undefined && storedRecord.contentType !== announcement.record.mediaType) {
        throw new NativeSignedSourceIntegrityError('owned available announcement media type conflicts with exact record storage');
      }
      authenticated.set(announcement.announcementId, {
        location: announcement.locations[0]!.locator,
        sequence: verified.entry.sequence,
        entryDigest: verified.entryDigest,
      });
      fingerprint = sealJson({
        source: input.source,
        timestamp: verified.entry.timestamp,
        announcement,
        recordContentType: storedRecord.contentType,
      }).digest;
      receipt = {
        source: input.source,
        announcementId: announcement.announcementId,
        fingerprint,
        sequence: verified.entry.sequence,
        entryDigest: verified.entryDigest,
        page,
        record: { digest: announcement.record.digest, path, contentType: storedRecord.contentType },
      };
    } else {
      const target = authenticated.get(announcement.retracts);
      if (target === undefined) {
        throw new NativeSignedSourceIntegrityError('owned withdrawal does not retract an earlier available announcement');
      }
      authenticated.set(announcement.announcementId, {
        location: target.location,
        sequence: verified.entry.sequence,
        entryDigest: verified.entryDigest,
      });
      fingerprint = sealJson({
        source: input.source,
        timestamp: verified.entry.timestamp,
        announcement,
        recordContentType: null,
      }).digest;
      receipt = {
        source: input.source,
        announcementId: announcement.announcementId,
        fingerprint,
        sequence: verified.entry.sequence,
        entryDigest: verified.entryDigest,
        page,
      };
    }
    announcements[announcement.announcementId] = {
      action: announcement.action,
      fingerprint,
      receipt,
    };
  }
  if (previousEntry !== input.last.entryDigest || previousPage !== input.last.page) {
    throw new NativeSignedSourceIntegrityError('committed state does not equal the authenticated archive tip');
  }
  const legacyPublished = Object.fromEntries(authenticated);
  if (input.expectedPublished !== undefined && !sameJson(legacyPublished, input.expectedPublished)) {
    throw new NativeSignedSourceIntegrityError('unsigned source state does not match authenticated archive receipts');
  }
  if (!input.skipHead) {
    const storedHead = await input.store.get(headPath(input.source.name));
    if (storedHead === undefined) throw new NativeSignedSourceIntegrityError('committed signed source head is missing');
    parseAndVerifyHead({
      bytes: storedHead.bytes,
      source: input.source,
      signer: input.signer,
      sequence: input.last.sequence,
      entryDigest: input.last.entryDigest,
    });
  }
  return {
    durable: {
      version: 1,
      source: input.source,
      signerKeyId: input.signerKeyId,
      last: input.last,
      announcements,
    },
    legacyPublished,
    ...(lastTimestamp === undefined ? {} : { lastTimestamp }),
  };
}

async function invokeFault(faults: NativeSignedSourceFaults | undefined, boundary: NativeSignedSourceFaultBoundary): Promise<void> {
  const hook = boundary === 'after-record-before-journal' ? faults?.afterRecordBeforeJournal
    : boundary === 'after-journal-before-page' ? faults?.afterJournalBeforePage
      : boundary === 'after-page-before-head' ? faults?.afterPageBeforeHead
        : boundary === 'after-head-before-state' ? faults?.afterHeadBeforeState
          : faults?.afterStateBeforeJournalClear;
  await hook?.();
}

async function readJsonSnapshot<T>(path: string): Promise<CasSnapshot<T> | undefined> {
  try {
    const bytes = new Uint8Array(await readFile(path));
    return {
      revision: createHash('sha256').update(bytes).digest('hex'),
      value: JSON.parse(new TextDecoder().decode(bytes)) as T,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function writeJsonSnapshot<T>(path: string, value: T): Promise<CasSnapshot<T>> {
  await writeJson(path, value);
  const snapshot = await readJsonSnapshot<T>(path);
  if (snapshot === undefined) throw new NativeSignedSourceIntegrityError(`durable JSON write disappeared: ${path}`);
  return snapshot;
}

function sameDurableState(left: DurableSourceState, right: DurableSourceState): boolean {
  return sealJson(left).digest === sealJson(right).digest;
}

function assertDurableOwnership(
  value: DurableSourceState | DurableSourceAppendIntent,
  source: SourceIdentity,
  signerKeyId: string,
): void {
  if (!sourceMatches(value.source, source) || value.signerKeyId !== signerKeyId) {
    throw new NativeSignedSourceIntegrityError('generic source writer state belongs to a different source/key identity');
  }
}

function createNativeBlobStore(
  store: ReturnType<typeof createFsBlobStore>,
): ReadableImmutableBlobStore {
  return store;
}

function createNativeSourceStateStore(input: {
  readonly statePath: string;
  readonly journalPath: string;
  readonly source: SourceIdentity;
  readonly signer: NativeSignedSourceSigner;
  readonly store: ReturnType<typeof createFsBlobStore>;
}): SourceStateStore {
  return {
    async read() {
      const snapshot = await readJsonSnapshot<SourceState>(input.statePath);
      if (snapshot === undefined) return undefined;
      const state = snapshot.value;
      if (state.version !== 2
        || !sourceMatches(state.source, input.source)
        || state.signerKeyId !== input.signer.keyId) {
        throw new NativeSignedSourceIntegrityError('signed source state belongs to a different source/key identity');
      }
      const pending = await readJson<AppendJournal>(input.journalPath);
      const reconstructed = await reconstructCommittedHistory({
        store: input.store,
        source: input.source,
        signerKeyId: input.signer.keyId,
        last: state.last,
        expectedPublished: state.published,
        signer: input.signer,
        skipHead: pending !== undefined,
      });
      return { revision: snapshot.revision, value: reconstructed.durable };
    },
    async compareAndSwap(_sourceId, expectedRevision, next): Promise<CasWriteResult> {
      assertDurableOwnership(next, input.source, input.signer.keyId);
      const current = await readJsonSnapshot<SourceState>(input.statePath);
      if ((current?.revision ?? null) !== expectedRevision) return { ok: false };
      const reconstructed = await reconstructCommittedHistory({
        store: input.store,
        source: input.source,
        signerKeyId: input.signer.keyId,
        ...(next.last === null ? {} : { last: next.last }),
        signer: input.signer,
      });
      if (!sameDurableState(reconstructed.durable, next)) {
        throw new NativeSignedSourceIntegrityError('generic next state does not equal the authenticated public archive');
      }
      const legacy: SourceState = {
        version: 2,
        source: input.source,
        signerKeyId: input.signer.keyId,
        ...(next.last === null ? {} : { last: next.last }),
        published: reconstructed.legacyPublished,
      };
      const written = await writeJsonSnapshot(input.statePath, legacy);
      return { ok: true, revision: written.revision };
    },
  };
}

function decodeJournalPage(journal: Pick<AppendJournal, 'pageBytes'>): ArchivePage {
  try {
    return JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(decodeBase64(journal.pageBytes))) as ArchivePage;
  } catch (error) {
    throw new NativeSignedSourceIntegrityError(`append journal page is invalid JSON: ${String(error)}`);
  }
}

function nativeReceiptFromIntent(
  intent: DurableSourceAppendIntent,
  baseUrl: string,
): { readonly receipt: NativeSignedSourceReceipt; readonly recordDigest: `sha256:${string}` } {
  const page = JSON.parse(new TextDecoder().decode(decodeBase64(intent.page.bytesBase64))) as ArchivePage;
  const announcement = page.entries[0]?.entry.announcements[0];
  if (announcement === undefined || announcement.announcementId !== intent.announcementId) {
    throw new NativeSignedSourceIntegrityError('generic append intent has no matching announcement');
  }
  const record = announcement.action === 'available'
    ? intent.record
    : intent.nextState.announcements[announcement.retracts]?.receipt.record;
  if (record === null || record === undefined) {
    throw new NativeSignedSourceIntegrityError('generic append intent cannot resolve its exact record location');
  }
  return {
    receipt: {
      location: `${baseUrl}${record.path}`,
      sequence: intent.receipt.sequence,
      entryDigest: intent.receipt.entryDigest,
    },
    recordDigest: record.digest,
  };
}

function journalV2FromIntent(
  intent: DurableSourceAppendIntent,
  baseUrl: string,
): AppendJournalV2 {
  const native = nativeReceiptFromIntent(intent, baseUrl);
  return {
    version: 2,
    source: intent.source,
    signerKeyId: intent.signerKeyId,
    publicationKey: intent.announcementId,
    recordDigest: native.recordDigest,
    ...(intent.previousPosition === null ? {} : { previousLast: intent.previousPosition }),
    receipt: native.receipt,
    page: intent.receipt.page,
    pageBytes: intent.page.bytesBase64,
    headBytes: intent.head.bytesBase64,
    intent,
  };
}

function assertJournalV2Mirror(journal: AppendJournalV2, baseUrl: string): void {
  const expected = journalV2FromIntent(journal.intent, baseUrl);
  if (!sameJson(journal, expected)) {
    throw new NativeSignedSourceIntegrityError('append journal compatibility mirror conflicts with its generic intent');
  }
}

async function legacyJournalIntent(input: {
  readonly journal: AppendJournalV1;
  readonly statePath: string;
  readonly source: SourceIdentity;
  readonly signer: NativeSignedSourceSigner;
  readonly store: ReturnType<typeof createFsBlobStore>;
}): Promise<DurableSourceAppendIntent> {
  const journal = input.journal;
  if (!sourceMatches(journal.source, input.source)
    || journal.signerKeyId !== input.signer.keyId
    || journal.receipt.sequence !== journal.page
    || journal.publicationKey.length === 0) {
    throw new NativeSignedSourceIntegrityError('legacy append journal does not continue the owned source identity');
  }
  const previous = await reconstructCommittedHistory({
    store: input.store,
    source: input.source,
    signerKeyId: input.signer.keyId,
    ...(journal.previousLast === undefined ? {} : { last: journal.previousLast }),
    signer: input.signer,
    skipHead: true,
  });
  const pageBytes = decodeBase64(journal.pageBytes);
  const verified = parseAndVerifyPage({
    bytes: pageBytes,
    source: input.source,
    signer: input.signer,
    expectedPage: journal.page,
    previousPage: journal.previousLast?.page ?? null,
    previousEntry: journal.previousLast?.entryDigest ?? null,
  });
  if (verified.entryDigest !== journal.receipt.entryDigest) {
    throw new NativeSignedSourceIntegrityError('legacy append journal entry digest does not match its receipt');
  }
  const page = decodeJournalPage(journal);
  const announcement = page.entries[0]?.entry.announcements[0];
  if (page.entries.length !== 1
    || announcement === undefined
    || announcement.announcementId !== journal.publicationKey) {
    throw new NativeSignedSourceIntegrityError('legacy append journal has no exact operation announcement');
  }

  const headBytes = decodeBase64(journal.headBytes);
  parseAndVerifyHead({
    bytes: headBytes,
    source: input.source,
    signer: input.signer,
    sequence: journal.page,
    entryDigest: verified.entryDigest,
  });

  const recordPathValue = recordPath(journal.recordDigest);
  const storedRecord = await input.store.get(recordPathValue);
  if (storedRecord === undefined || recordDigest(storedRecord.bytes) !== journal.recordDigest) {
    throw new NativeSignedSourceIntegrityError('legacy append journal exact record is missing');
  }
  let durableRecord: NonNullable<DurableSourceReceipt['record']> | null = null;
  let expectedLocation: string;
  if (announcement.action === 'available') {
    if (announcement.record.digest !== journal.recordDigest || announcement.locations?.length !== 1) {
      throw new NativeSignedSourceIntegrityError('legacy available journal does not bind one exact record and location');
    }
    if (announcement.record.mediaType !== undefined && announcement.record.mediaType !== storedRecord.contentType) {
      throw new NativeSignedSourceIntegrityError('legacy available journal media type conflicts with exact record storage');
    }
    durableRecord = {
      digest: journal.recordDigest,
      path: recordPathValue,
      contentType: storedRecord.contentType,
    };
    expectedLocation = announcement.locations[0]!.locator;
  } else {
    const target = previous.durable.announcements[announcement.retracts];
    const targetLegacy = previous.legacyPublished[announcement.retracts];
    if (target?.action !== 'available'
      || target.receipt.record?.digest !== journal.recordDigest
      || targetLegacy === undefined) {
      throw new NativeSignedSourceIntegrityError('legacy withdrawal journal does not retract an owned availability');
    }
    expectedLocation = targetLegacy.location;
  }
  if (!sameJson(journal.receipt, {
    location: expectedLocation,
    sequence: journal.page,
    entryDigest: verified.entryDigest,
  })) {
    throw new NativeSignedSourceIntegrityError('legacy append journal receipt conflicts with its signed announcement');
  }

  const fingerprint = sealJson({
    source: input.source,
    timestamp: verified.entry.timestamp,
    announcement,
    recordContentType: durableRecord?.contentType ?? null,
  }).digest;
  const receipt: DurableSourceReceipt = {
    source: input.source,
    announcementId: announcement.announcementId,
    fingerprint,
    sequence: verified.entry.sequence,
    entryDigest: verified.entryDigest,
    page: journal.page,
    ...(durableRecord === null ? {} : { record: durableRecord }),
  };
  const nextState: DurableSourceState = {
    ...previous.durable,
    last: { sequence: journal.page, entryDigest: verified.entryDigest, page: journal.page },
    announcements: {
      ...previous.durable.announcements,
      [announcement.announcementId]: { action: announcement.action, fingerprint, receipt },
    },
  };

  const currentState = await readJsonSnapshot<SourceState>(input.statePath);
  if (currentState !== undefined) {
    const current = currentState.value;
    const reconstructed = await reconstructCommittedHistory({
      store: input.store,
      source: input.source,
      signerKeyId: input.signer.keyId,
      last: current.last,
      expectedPublished: current.published,
      signer: input.signer,
      skipHead: true,
    });
    if (!sameDurableState(reconstructed.durable, previous.durable)
      && !sameDurableState(reconstructed.durable, nextState)) {
      throw new NativeSignedSourceIntegrityError('legacy append journal conflicts with current committed source state');
    }
  }

  const existingHead = await input.store.get(headPath(input.source.name));
  let expectedHeadDigest: `sha256:${string}` | null = null;
  if (existingHead !== undefined && !sameBytes(existingHead.bytes, headBytes)) {
    if (journal.previousLast === undefined) {
      throw new NativeSignedSourceIntegrityError('legacy recovered head conflicts with both journal and genesis');
    }
    parseAndVerifyHead({
      bytes: existingHead.bytes,
      source: input.source,
      signer: input.signer,
      sequence: journal.previousLast.sequence,
      entryDigest: journal.previousLast.entryDigest,
    });
    expectedHeadDigest = recordDigest(existingHead.bytes);
  }

  return {
    version: 1,
    source: input.source,
    signerKeyId: input.signer.keyId,
    announcementId: announcement.announcementId,
    fingerprint,
    expectedStateRevision: currentState?.revision ?? null,
    previousStateDigest: currentState === undefined ? null : sealJson(previous.durable).digest,
    previousPosition: journal.previousLast ?? null,
    expectedHeadDigest,
    previousHeadIssuedAt: previous.lastTimestamp ?? null,
    record: durableRecord,
    page: {
      path: archivePagePath(input.source.name, journal.page),
      contentType: JSON_MEDIA_TYPE,
      digest: recordDigest(pageBytes),
      bytesBase64: journal.pageBytes,
    },
    head: {
      path: headPath(input.source.name),
      contentType: HEAD_MEDIA_TYPE,
      digest: recordDigest(headBytes),
      bytesBase64: journal.headBytes,
    },
    nextState,
    receipt,
  };
}

function createNativeIntentStore(input: {
  readonly journalPath: string;
  readonly statePath: string;
  readonly baseUrl: string;
  readonly source: SourceIdentity;
  readonly signer: NativeSignedSourceSigner;
  readonly store: ReturnType<typeof createFsBlobStore>;
}): SourceAppendIntentStore {
  return {
    async read() {
      const snapshot = await readJsonSnapshot<AppendJournal>(input.journalPath);
      if (snapshot === undefined) return undefined;
      if (snapshot.value.version === 2) {
        assertJournalV2Mirror(snapshot.value, input.baseUrl);
        assertDurableOwnership(snapshot.value.intent, input.source, input.signer.keyId);
        return { revision: snapshot.revision, value: snapshot.value.intent };
      }
      return {
        revision: snapshot.revision,
        value: await legacyJournalIntent({
          journal: snapshot.value,
          statePath: input.statePath,
          source: input.source,
          signer: input.signer,
          store: input.store,
        }),
      };
    },
    async compareAndSwap(_sourceId, expectedRevision, next): Promise<CasWriteResult> {
      const current = await readJsonSnapshot<AppendJournal>(input.journalPath);
      if ((current?.revision ?? null) !== expectedRevision) return { ok: false };
      if (next === undefined) {
        if (current !== undefined) await unlink(input.journalPath);
        return { ok: true, revision: `deleted:${current?.revision ?? 'absent'}` };
      }
      assertDurableOwnership(next, input.source, input.signer.keyId);
      const journal = journalV2FromIntent(next, input.baseUrl);
      const written = await writeJsonSnapshot(input.journalPath, journal);
      return { ok: true, revision: written.revision };
    },
  };
}

function createNativeDurableSigner(signer: NativeSignedSourceSigner): DurableSourceSigner {
  return {
    scope: DISCOVERY_SIGNING_SCOPE,
    keyId: signer.keyId,
    async sign(pae) {
      return [{ keyid: signer.keyId, sig: signer.sign(pae) }];
    },
    verify: (pae, signature) => signer.verify(pae, signature),
  };
}

function sourceWriterFaults(faults: NativeSignedSourceFaults | undefined): {
  at(boundary: SourceWriterFaultBoundary): Promise<void>;
} | undefined {
  if (faults === undefined) return undefined;
  return {
    async at(boundary) {
      const legacyBoundary: NativeSignedSourceFaultBoundary = boundary === 'after-record-before-intent'
        ? 'after-record-before-journal'
        : boundary === 'after-intent-before-page'
          ? 'after-journal-before-page'
          : boundary === 'after-page-before-head'
            ? 'after-page-before-head'
            : boundary === 'after-head-before-state'
              ? 'after-head-before-state'
              : 'after-state-before-journal-clear';
      await invokeFault(faults, legacyBoundary);
    },
  };
}

export interface NativeSignedSourcePublisher {
  readonly sourceId: string;
  readonly handler: ArchiveHttpHandler;
  publish(input: {
    readonly publicationKey: string;
    readonly sourceId: string;
    readonly recordDigest: `sha256:${string}`;
    readonly bytes: Uint8Array;
    readonly mediaType: string;
    readonly timestamp: string;
    makeAnnouncement(input: {
      readonly location: string;
    }): Announcement;
  }): Promise<NativeSignedSourceReceipt>;
  close(): Promise<void>;
}

export async function openNativeSignedSource(input: {
  readonly rootDir: string;
  readonly publicBaseUrl: string;
  readonly source: SourceIdentity;
  readonly signer: NativeSignedSourceSigner;
  readonly ownerFile: string;
  readonly ownershipError: (message: string) => Error;
  readonly faults?: NativeSignedSourceFaults;
  /** Bounded SSE replay window for live tail consumers (§9.3). Defaults to 256 entries. */
  readonly replayWindow?: number;
  readonly owner?: {
    readonly now?: () => Date;
    readonly ttlMs?: number;
    readonly isPidAlive?: (pid: number) => boolean;
  };
}): Promise<NativeSignedSourcePublisher> {
  const baseUrl = input.publicBaseUrl.replace(/\/+$/u, '');
  if (baseUrl.length === 0) throw new Error('native signed source publicBaseUrl is required');
  const now = input.owner?.now ?? (() => new Date());
  const owner = await acquireOwner({
    rootDir: input.rootDir,
    ownerFile: input.ownerFile,
    source: input.source,
    signerKeyId: input.signer.keyId,
    now,
    ttlMs: input.owner?.ttlMs ?? DEFAULT_OWNER_TTL_MS,
    isPidAlive: input.owner?.isPidAlive ?? pidAlive,
    ownershipError: input.ownershipError,
  });
  const statePath = join(input.rootDir, 'source-state.json');
  const journalPath = join(input.rootDir, 'append-journal.json');
  const store = createFsBlobStore(join(input.rootDir, 'public'));
  // In-memory SSE relay: `serve` writes only the static layout, so a live tail needs a
  // process-local feed (§9.3). The publish path drives it; the archive handler serves it.
  const tail = createInMemoryTailSource(input.replayWindow ?? DEFAULT_TAIL_REPLAY_WINDOW);
  try {
    const loaded = await readJson<SourceState | SourceStateV1>(statePath);
    const state: SourceState = loaded === undefined
      ? { version: 2, source: input.source, signerKeyId: input.signer.keyId, published: {} }
      : loaded.version === 1
        ? { ...loaded, version: 2, signerKeyId: input.signer.keyId }
        : loaded;
    if (state.version !== 2
      || !sourceMatches(state.source, input.source)
      || state.signerKeyId !== input.signer.keyId) {
      throw input.ownershipError('signed source state belongs to a different source/key identity');
    }
    const pendingJournal = await readJson<AppendJournal>(journalPath);
    await reconstructCommittedHistory({
      store,
      source: input.source,
      signerKeyId: input.signer.keyId,
      last: state.last,
      expectedPublished: state.published,
      signer: input.signer,
      skipHead: pendingJournal !== undefined,
    });
    if (loaded?.version === 1) await writeJson(statePath, state);

    let closed = false;
    let append = Promise.resolve();
    const sourceId = formatOrigin(input.source.agent, input.source.name);
    const states = createNativeSourceStateStore({
      statePath,
      journalPath,
      source: input.source,
      signer: input.signer,
      store,
    });
    const intents = createNativeIntentStore({
      journalPath,
      statePath,
      baseUrl,
      source: input.source,
      signer: input.signer,
      store,
    });
    const durableFaults = sourceWriterFaults(input.faults);
    const durable = createDurableSourceWriter({
      source: input.source,
      signer: createNativeDurableSigner(input.signer),
      blobs: createNativeBlobStore(store),
      states,
      intents,
      ...(durableFaults === undefined ? {} : { faults: durableFaults }),
    });

    async function syncWellKnown(): Promise<void> {
      const committed = await durable.readState();
      if (committed?.last === null || committed === undefined) return;
      await writeWellKnownDocument(store, {
        protocol: RECORD_DISCOVERY_VERSION,
        sources: [{
          agent: input.source.agent,
          name: input.source.name,
          headPath: headPath(input.source.name),
          archiveRoot: archivePagePath(input.source.name, committed.last.page),
        }],
      });
    }

    await durable.recover();
    await syncWellKnown();

    const publish: NativeSignedSourcePublisher['publish'] = async (value) => {
      let resolve!: (receipt: NativeSignedSourceReceipt) => void;
      let reject!: (error: unknown) => void;
      const response = new Promise<NativeSignedSourceReceipt>((res, rej) => { resolve = res; reject = rej; });
      append = append.then(async () => {
        if (closed) throw input.ownershipError('native signed source publisher is closed');
        if (value.sourceId !== sourceId) throw new Error('publication source does not equal the owned source identity');
        if (recordDigest(value.bytes) !== value.recordDigest) {
          throw new NativeSignedSourceIntegrityError('publication exact bytes do not match the declared record digest');
        }
        const location = `${baseUrl}${recordPath(value.recordDigest)}`;
        const announcement = value.makeAnnouncement({ location });
        if (announcement.announcementId !== value.publicationKey) {
          throw new NativeSignedSourceIntegrityError('publication key does not equal the signed announcement identity');
        }
        if (announcement.action === 'available' && announcement.record.digest !== value.recordDigest) {
          throw new NativeSignedSourceIntegrityError('available announcement does not name the exact publication record');
        }
        const receipt = await durable.append({
          announcement,
          timestamp: value.timestamp,
          ...(announcement.action === 'available'
            ? { record: { bytes: value.bytes, contentType: value.mediaType } }
            : {}),
        });
        await syncWellKnown();
        // Relay the new announcement to live tail subscribers as its CloudEvents envelope
        // (§9.1). Withdrawals name no record and are recovered via the chain walk, not the
        // announcement stream, so only `available` items are relayed.
        if (announcement.action === 'available') {
          const item: AnnouncedItem = {
            record: announcement.record,
            ...(announcement.facts === undefined ? {} : { facts: announcement.facts }),
            ...(announcement.locations === undefined ? {} : { locations: announcement.locations }),
            provenance: {
              source: input.source,
              entry: receipt.entryDigest,
              announcementId: announcement.announcementId,
            },
          };
          tail.publish('announcement', JSON.stringify(toAnnouncementEvent(item, undefined)));
        }
        resolve({ location, sequence: receipt.sequence, entryDigest: receipt.entryDigest });
      }).catch(reject);
      return response;
    };
    const basePath = new URL(baseUrl).pathname.replace(/\/+$/u, '');
    return {
      sourceId,
      publish,
      handler: createArchiveHttpHandler({
        reader: store,
        tail: tail.source,
        ...(basePath === '' ? {} : { basePath }),
      }),
      async close(): Promise<void> {
        if (closed) return;
        closed = true;
        await append.catch(() => undefined);
        await releaseOwner(owner.path, owner.lease.token);
      },
    };
  } catch (error) {
    await releaseOwner(owner.path, owner.lease.token);
    throw error;
  }
}

export { LOCATION_PROFILE_HTTPS };
