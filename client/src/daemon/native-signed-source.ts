import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
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
  recordPath,
  sealJson,
  type AnnouncementEntry,
  type SourceHead,
  type SourceIdentity,
} from '@jinn-network/record-discovery-protocol';
import {
  signHead,
  writeRecord,
  writeWellKnownDocument,
  type ArchivePage,
  type DsseEnvelope,
} from '@jinn-network/record-discovery-serve';
import {
  createArchiveHttpHandler,
  createFsBlobStore,
  type ArchiveHttpHandler,
} from '@jinn-network/record-discovery-transport-http';
import { signAnnouncementEntry } from '@jinn-network/marketplace-projector';

const JSON_MEDIA_TYPE = 'application/json';
const HEAD_MEDIA_TYPE = 'application/vnd.jinn.record-discovery.head.v1+json';
const DEFAULT_OWNER_TTL_MS = 30_000;

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

interface AppendJournal {
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

async function putExact(store: ReturnType<typeof createFsBlobStore>, path: string, bytes: Uint8Array, mediaType: string): Promise<void> {
  const existing = await store.get(path);
  if (existing !== undefined && !sameBytes(existing.bytes, bytes)) {
    throw new NativeSignedSourceIntegrityError(`immutable source path ${path} conflicts with recovered bytes`);
  }
  if (existing === undefined) await store.put(path, bytes, mediaType);
}

async function validateCommittedHistory(input: {
  readonly store: ReturnType<typeof createFsBlobStore>;
  readonly state: SourceState;
  readonly signer: NativeSignedSourceSigner;
  readonly skipHead?: boolean;
}): Promise<void> {
  if (input.state.last === undefined) {
    if (!input.skipHead && await input.store.get(headPath(input.state.source.name)) !== undefined) {
      throw new NativeSignedSourceIntegrityError('public signed head exists without committed source state or append journal');
    }
    return;
  }
  let previousPage: string | null = null;
  let previousEntry: `sha256:${string}` | null = null;
  const authenticated = new Map<string, NativeSignedSourceReceipt>();
  for (let number = 1n; number <= BigInt(input.state.last.page); number += 1n) {
    const page = formatSequence(number);
    const stored = await input.store.get(archivePagePath(input.state.source.name, page));
    if (stored === undefined) throw new NativeSignedSourceIntegrityError(`committed archive page ${page} is missing`);
    const verified = parseAndVerifyPage({
      bytes: stored.bytes,
      source: input.state.source,
      signer: input.signer,
      expectedPage: page,
      previousPage,
      previousEntry,
    });
    previousPage = page;
    previousEntry = verified.entryDigest;
    const announcement = verified.entry.announcements[0];
    if (verified.entry.announcements.length !== 1 || announcement === undefined) {
      throw new NativeSignedSourceIntegrityError('owned archive entry has unexpected announcement cardinality');
    }
    if (announcement.action === 'available') {
      if (announcement.locations?.length !== 1) {
        throw new NativeSignedSourceIntegrityError('owned available announcement has no unique exact location');
      }
      authenticated.set(announcement.announcementId, {
        location: announcement.locations[0]!.locator,
        sequence: verified.entry.sequence,
        entryDigest: verified.entryDigest,
      });
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
    }
  }
  if (previousEntry !== input.state.last.entryDigest || previousPage !== input.state.last.page) {
    throw new NativeSignedSourceIntegrityError('committed state does not equal the authenticated archive tip');
  }
  if (!sameJson(Object.fromEntries(authenticated), input.state.published)) {
    throw new NativeSignedSourceIntegrityError('unsigned source state does not match authenticated archive receipts');
  }
  if (input.skipHead) return;
  const storedHead = await input.store.get(headPath(input.state.source.name));
  if (storedHead === undefined) throw new NativeSignedSourceIntegrityError('committed signed source head is missing');
  parseAndVerifyHead({
    bytes: storedHead.bytes,
    source: input.state.source,
    signer: input.signer,
    sequence: input.state.last.sequence,
    entryDigest: input.state.last.entryDigest,
  });
}

async function invokeFault(faults: NativeSignedSourceFaults | undefined, boundary: NativeSignedSourceFaultBoundary): Promise<void> {
  const hook = boundary === 'after-record-before-journal' ? faults?.afterRecordBeforeJournal
    : boundary === 'after-journal-before-page' ? faults?.afterJournalBeforePage
      : boundary === 'after-page-before-head' ? faults?.afterPageBeforeHead
        : boundary === 'after-head-before-state' ? faults?.afterHeadBeforeState
          : faults?.afterStateBeforeJournalClear;
  await hook?.();
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
    makeEntry(input: {
      readonly sequence: string;
      readonly previous: `sha256:${string}` | null;
      readonly location: string;
    }): AnnouncementEntry;
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
  try {
    const loaded = await readJson<SourceState | SourceStateV1>(statePath);
    let state: SourceState = loaded === undefined
      ? { version: 2, source: input.source, signerKeyId: input.signer.keyId, published: {} }
      : loaded.version === 1
        ? { ...loaded, version: 2, signerKeyId: input.signer.keyId }
        : loaded;
    if (state.version !== 2
      || !sourceMatches(state.source, input.source)
      || state.signerKeyId !== input.signer.keyId) {
      throw input.ownershipError('signed source state belongs to a different source/key identity');
    }
    const journal = await readJson<AppendJournal>(journalPath);
    if (journal === undefined) {
      await validateCommittedHistory({ store, state, signer: input.signer });
      if (loaded?.version === 1) await writeJson(statePath, state);
    } else {
      if (journal.version !== 1
        || !sourceMatches(journal.source, input.source)
        || journal.signerKeyId !== input.signer.keyId
        || journal.receipt.sequence !== journal.page) {
        throw new NativeSignedSourceIntegrityError('append journal does not continue the authenticated committed source state');
      }
      const alreadyCommitted = state.published[journal.publicationKey];
      if (alreadyCommitted !== undefined) {
        if (!sameJson(alreadyCommitted, journal.receipt)
          || state.last?.sequence !== journal.page
          || state.last.entryDigest !== journal.receipt.entryDigest) {
          throw new NativeSignedSourceIntegrityError('committed source state conflicts with its pending append journal');
        }
      } else if (!sameJson(journal.previousLast, state.last)) {
        throw new NativeSignedSourceIntegrityError('append journal does not continue the authenticated committed source state');
      }
      await validateCommittedHistory({ store, state: alreadyCommitted === undefined ? state : {
        ...state,
        last: journal.previousLast,
        published: Object.fromEntries(Object.entries(state.published).filter(([key]) => key !== journal.publicationKey)),
      }, signer: input.signer, skipHead: true });
      const pageBytes = decodeBase64(journal.pageBytes);
      const headBytes = decodeBase64(journal.headBytes);
      const verified = parseAndVerifyPage({
        bytes: pageBytes,
        source: input.source,
        signer: input.signer,
        expectedPage: journal.page,
        previousPage: journal.previousLast?.page ?? null,
        previousEntry: journal.previousLast?.entryDigest ?? null,
      });
      if (verified.entryDigest !== journal.receipt.entryDigest) {
        throw new NativeSignedSourceIntegrityError('append journal entry digest does not match its receipt');
      }
      parseAndVerifyHead({
        bytes: headBytes,
        source: input.source,
        signer: input.signer,
        sequence: journal.page,
        entryDigest: verified.entryDigest,
      });
      const record = await store.get(recordPath(journal.recordDigest));
      const observedRecordDigest = record === undefined
        ? undefined
        : `sha256:${createHash('sha256').update(record.bytes).digest('hex')}`;
      if (record === undefined || observedRecordDigest !== journal.recordDigest) {
        throw new NativeSignedSourceIntegrityError('append journal exact record is missing');
      }
      await putExact(store, archivePagePath(input.source.name, journal.page), pageBytes, JSON_MEDIA_TYPE);
      const existingHead = await store.get(headPath(input.source.name));
      if (existingHead !== undefined && !sameBytes(existingHead.bytes, headBytes)) {
        if (journal.previousLast === undefined) {
          throw new NativeSignedSourceIntegrityError('recovered head conflicts with both journal and genesis');
        }
        parseAndVerifyHead({
          bytes: existingHead.bytes,
          source: input.source,
          signer: input.signer,
          sequence: journal.previousLast.sequence,
          entryDigest: journal.previousLast.entryDigest,
        });
      }
      await store.put(headPath(input.source.name), headBytes, HEAD_MEDIA_TYPE);
      await writeWellKnownDocument(store, {
        protocol: RECORD_DISCOVERY_VERSION,
        sources: [{
          agent: input.source.agent,
          name: input.source.name,
          headPath: headPath(input.source.name),
          archiveRoot: archivePagePath(input.source.name, journal.page),
        }],
      });
      if (alreadyCommitted === undefined) {
        state = {
          ...state,
          last: { sequence: journal.page, entryDigest: verified.entryDigest, page: journal.page },
          published: { ...state.published, [journal.publicationKey]: journal.receipt },
        };
        await writeJson(statePath, state);
      }
      await unlink(journalPath);
    }

    let closed = false;
    let append = Promise.resolve();
    const sourceId = formatOrigin(input.source.agent, input.source.name);
    const entrySigner = {
      scope: 'jinn:discovery-announcements' as const,
      sign: async (pae: Uint8Array) => [{ keyid: input.signer.keyId, sig: input.signer.sign(pae) }],
    };
    const headSigner = {
      sign: async (pae: Uint8Array) => [{ keyid: input.signer.keyId, sig: input.signer.sign(pae) }],
    };
    const publish: NativeSignedSourcePublisher['publish'] = async (value) => {
      let resolve!: (receipt: NativeSignedSourceReceipt) => void;
      let reject!: (error: unknown) => void;
      const response = new Promise<NativeSignedSourceReceipt>((res, rej) => { resolve = res; reject = rej; });
      append = append.then(async () => {
        if (closed) throw input.ownershipError('native signed source publisher is closed');
        const existing = state.published[value.publicationKey];
        if (existing !== undefined) { resolve(existing); return; }
        if (value.sourceId !== sourceId) throw new Error('publication source does not equal the owned source identity');
        const written = await writeRecord(store, value.bytes, value.mediaType);
        if (written.digest !== value.recordDigest) throw new Error('public record write returned a different digest');
        await invokeFault(input.faults, 'after-record-before-journal');
        const sequence = formatSequence(state.last === undefined ? 1n : BigInt(state.last.sequence) + 1n);
        const receipt: NativeSignedSourceReceipt = {
          location: `${baseUrl}${written.path}`,
          sequence,
          entryDigest: `sha256:${'0'.repeat(64)}`,
        };
        const entry = value.makeEntry({
          sequence,
          previous: state.last?.entryDigest ?? null,
          location: receipt.location,
        });
        if (!sourceMatches(entry.source, input.source)
          || entry.sequence !== sequence
          || entry.previous !== (state.last?.entryDigest ?? null)) {
          throw new NativeSignedSourceIntegrityError('caller-built announcement does not continue the owned source');
        }
        const entryDigest = sealJson(entry).digest;
        const signedEntry = await signAnnouncementEntry(entry, entrySigner);
        const page: ArchivePage = {
          protocol: RECORD_DISCOVERY_VERSION,
          source: input.source.name,
          page: sequence,
          prevArchive: state.last?.page ?? null,
          entries: [{ entry, signature: signedEntry }],
        };
        const pageBytes = sealJson(page).bytes;
        const head: SourceHead = {
          protocol: RECORD_DISCOVERY_VERSION,
          origin: sourceId,
          sequence,
          entry: entryDigest,
          issuedAt: value.timestamp,
          refreshBy: new Date(Date.parse(value.timestamp) + 24 * 60 * 60 * 1000).toISOString(),
        };
        const headBytes = sealJson(await signHead(head, headSigner)).bytes;
        const exactReceipt = { ...receipt, entryDigest };
        const journal: AppendJournal = {
          version: 1,
          source: input.source,
          signerKeyId: input.signer.keyId,
          publicationKey: value.publicationKey,
          recordDigest: value.recordDigest,
          ...(state.last === undefined ? {} : { previousLast: state.last }),
          receipt: exactReceipt,
          page: sequence,
          pageBytes: Buffer.from(pageBytes).toString('base64'),
          headBytes: Buffer.from(headBytes).toString('base64'),
        };
        await writeJson(journalPath, journal);
        await invokeFault(input.faults, 'after-journal-before-page');
        await putExact(store, archivePagePath(input.source.name, sequence), pageBytes, JSON_MEDIA_TYPE);
        await invokeFault(input.faults, 'after-page-before-head');
        await store.put(headPath(input.source.name), headBytes, HEAD_MEDIA_TYPE);
        await writeWellKnownDocument(store, {
          protocol: RECORD_DISCOVERY_VERSION,
          sources: [{
            agent: input.source.agent,
            name: input.source.name,
            headPath: headPath(input.source.name),
            archiveRoot: archivePagePath(input.source.name, sequence),
          }],
        });
        await invokeFault(input.faults, 'after-head-before-state');
        state = {
          ...state,
          last: { sequence, entryDigest, page: sequence },
          published: { ...state.published, [value.publicationKey]: exactReceipt },
        };
        await writeJson(statePath, state);
        await invokeFault(input.faults, 'after-state-before-journal-clear');
        await unlink(journalPath);
        resolve(exactReceipt);
      }).catch(reject);
      return response;
    };
    const basePath = new URL(baseUrl).pathname.replace(/\/+$/u, '');
    return {
      sourceId,
      publish,
      handler: createArchiveHttpHandler({ reader: store, ...(basePath === '' ? {} : { basePath }) }),
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
