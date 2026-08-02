/**
 * Feature-disabled native requester vertical.
 *
 * This is deliberately a product seam, not a second marketplace implementation: B1 owns the
 * deterministic public prediction contract, marketplace-binding owns the actual `postTask` WAL,
 * and discovery owns record/head/archive layout. The runner owns only the requester-specific
 * durable association from a canonical today-mode `TaskCreated` to the exact Submission graph.
 */
import { mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  BASE_SEPOLIA_TODAY,
  type MarketplaceChainConfig,
  type PostingOutcome,
} from '@jinn-network/marketplace-binding';
import {
  admitPredictionSnapshot,
  ADMISSION_RECEIPT_MEDIA_TYPE,
  loadPredictionSnapshotFixture,
  sealPredictionSnapshotAdmissionReceipt,
  verifyPredictionSnapshotFixture,
} from '@jinn-network/task-admission';
import {
  documentDigest,
  sealSubmission,
  sha256Hex,
} from '@jinn-network/task-execution-protocol';
import {
  canonicalJsonBytes,
  sealSignedRecord,
} from '@jinn-network/trust-core';
import {
  DISCOVERY_SIGNING_SCOPE,
  LOCATION_PROFILE_HTTPS,
  RECORD_DISCOVERY_VERSION,
  RECORD_KINDS,
  archivePagePath,
  formatOrigin,
  formatSequence,
  headPath,
  recordPath,
  sealJson,
  type AnnouncementEntry,
  type PublishedLocation,
  type SourceHead,
  type SourceIdentity,
} from '@jinn-network/record-discovery-protocol';
import { TASK_EXECUTION_FACTS_RECOMPUTE } from '@jinn-network/record-discovery-facts-task-execution';
import { signAnnouncementEntry } from '@jinn-network/marketplace-projector';
import {
  signHead,
  writeRecord,
  writeWellKnownDocument,
} from '@jinn-network/record-discovery-serve';
import {
  createArchiveHttpHandler,
  createFsBlobStore,
} from '@jinn-network/record-discovery-transport-http';

const FIXTURE = 'prediction-snapshot-v1' as const;
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const REQUESTER_ENVELOPE_PREDICATE = 'https://jinn.network/attestations/requester-submission/v1';
const REQUESTER_ASSOCIATION_FACT = 'https://jinn.network/facts/native-requester-association/1.0';
const JSON_MEDIA_TYPE = 'application/json';

type Digest = `sha256:${string}`;
type NativeRequesterRole = 'requester-submission' | 'admission' | 'requester-discovery';

export interface NativeRequesterIdentity {
  readonly keyId: string;
  sign(payload: Uint8Array): Uint8Array;
}

/** Narrow B2 dependency: the requester never gains authority over solver/evaluator keys. */
export interface NativeRequesterRoles {
  get(role: NativeRequesterRole): NativeRequesterIdentity;
}

export interface NativeRequesterRequest {
  readonly network: 'base-sepolia';
  readonly fixture: typeof FIXTURE;
  readonly runId: string;
}

export interface CanonicalTaskCreated {
  readonly canonical: true;
  readonly chainId: number;
  readonly coordinator: `0x${string}`;
  readonly creator: `0x${string}`;
  readonly taskId: bigint;
  readonly taskDigest: Digest;
  readonly txHash: `0x${string}`;
}

interface NativeRequesterPostInput {
  readonly taskBytes: Uint8Array;
  readonly evaluationSpecBytes: Uint8Array;
  readonly admissionReceiptBytes: Uint8Array;
  readonly submissionBytes: Uint8Array;
  readonly requesterEnvelopeBytes: Uint8Array;
  readonly chain: MarketplaceChainConfig;
  readonly creatorSafe: `0x${string}`;
}

interface NativeRequesterDraft {
  readonly version: 1;
  readonly key: string;
  readonly runId: string;
  readonly chainId: number;
  readonly coordinator: `0x${string}`;
  readonly creatorSafe: `0x${string}`;
  readonly taskDigest: Digest;
  readonly submissionDigest: Digest;
  readonly requesterEnvelopeDigest: Digest;
  readonly artifacts: NativeRequesterArtifacts;
  readonly stage: 'prepared' | 'broadcasting' | 'broadcasted';
  readonly outcome?: StoredPostingOutcome;
}

interface NativeRequesterArtifacts {
  readonly evaluationSpec: StoredExactRecord;
  readonly task: StoredExactRecord;
  readonly admissionReceipt: StoredExactRecord;
  readonly submission: StoredExactRecord;
  readonly requesterEnvelope: StoredExactRecord;
}

export interface StoredExactRecord {
  readonly digest: Digest;
  readonly path: string;
}

interface StoredPostingOutcome {
  readonly taskId: string;
  readonly txHash: `0x${string}`;
}

interface PublicationIntent {
  readonly state: 'pending' | 'published';
  readonly sequence: string;
  readonly page: string;
  readonly entry: AnnouncementEntry;
  readonly entryDigest: Digest;
  readonly head: SourceHead;
  readonly announcementId: string;
}

export interface NativeRequesterAssociation {
  readonly version: 1;
  readonly chainId: number;
  readonly coordinator: `0x${string}`;
  readonly taskId: bigint;
  readonly taskDigest: Digest;
  readonly submissionDigest: Digest;
  readonly requesterEnvelopeDigest: Digest;
  readonly admissionReceiptDigest: Digest;
  readonly txHash: `0x${string}`;
  readonly submission: StoredExactRecord;
  readonly requesterEnvelope: StoredExactRecord;
  readonly admissionReceipt: StoredExactRecord;
  readonly task: StoredExactRecord;
  readonly evaluationSpec: StoredExactRecord;
  readonly publication: PublicationIntent;
}

interface StoredAssociation extends Omit<NativeRequesterAssociation, 'taskId'> {
  readonly taskId: string;
}

interface SourceState {
  readonly version: 1;
  readonly last?: {
    readonly sequence: string;
    readonly entryDigest: Digest;
    readonly page: string;
    readonly head: SourceHead;
  };
}

export interface NativeRequesterDeps {
  /** Absolute directory owned by this requester process. */
  readonly stateDir: string;
  readonly requesterAgent: string;
  readonly publicBaseUrl: string;
  /** This is intentionally first: mismatches reject before key loading or transaction preparation. */
  readonly readChain: () => Promise<MarketplaceChainConfig>;
  readonly loadRoles: () => Promise<NativeRequesterRoles>;
  readonly creatorSafe: `0x${string}`;
  readonly posting: {
    /** Adapter around marketplace-binding's native `postTask`; no legacy adapter is admitted here. */
    readonly post: (input: NativeRequesterPostInput) => Promise<PostingOutcome>;
    /** Exact recovery scan for a draft left in `broadcasting` by a process death. */
    readonly recover: (draft: {
      readonly chain: MarketplaceChainConfig;
      readonly creatorSafe: `0x${string}`;
      readonly taskDigest: Digest;
      readonly submissionDigest: Digest;
    }) => Promise<PostingOutcome | null>;
    /** Must read a canonical `TaskCreated`, never a receipt-only or projected fallback. */
    readonly canonicalTaskCreated: (expected: {
      readonly chainId: number;
      readonly coordinator: `0x${string}`;
      readonly creator: `0x${string}`;
      readonly taskId: bigint;
      readonly taskDigest: Digest;
      readonly txHash: `0x${string}`;
    }) => Promise<CanonicalTaskCreated | null>;
  };
  readonly now: () => Date;
  /** Test-only failure-injection seam. Production composition does not provide it. */
  readonly checkpoints?: (name:
    | 'evaluation-spec-sealed'
    | 'task-sealed'
    | 'admission-receipt-sealed'
    | 'submission-sealed'
    | 'requester-envelope-sealed'
    | 'draft-durable'
    | 'before-broadcast'
    | 'after-broadcast'
    | 'canonical-associated'
    | 'source-announced') => Promise<void>;
}

export interface NativeRequesterResult {
  readonly association: NativeRequesterAssociation;
  readonly reused: boolean;
}

function lowerAddress(address: string): string {
  return address.toLowerCase();
}

function assertBaseSepoliaTarget(network: string, actual: MarketplaceChainConfig): MarketplaceChainConfig {
  if (network !== 'base-sepolia') throw new Error('native requester only supports network base-sepolia');
  if (actual.chainId === 8453) throw new Error('native requester refuses Base mainnet (chainId 8453) before key loading');
  if (actual.chainId !== BASE_SEPOLIA_TODAY.chainId) {
    throw new Error(`native requester requires Base Sepolia chainId ${BASE_SEPOLIA_TODAY.chainId}, got ${actual.chainId}`);
  }
  for (const field of ['taskCoordinator', 'jinnRouter', 'mechMarketplace', 'activityChecker'] as const) {
    if (lowerAddress(actual[field]) !== lowerAddress(BASE_SEPOLIA_TODAY[field])) {
      throw new Error(`native requester refuses unexpected Base Sepolia ${field} ${actual[field]}`);
    }
  }
  if (actual.generation !== 'today') throw new Error('native requester requires the Base Sepolia today generation');
  return BASE_SEPOLIA_TODAY;
}

function assertRunId(runId: string): void {
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new Error('native requester runId must be 1-128 URL-safe identifier characters');
  }
}

function bytesToObject(bytes: Uint8Array, label: string): Record<string, unknown> {
  const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} is not an object`);
  }
  return value as Record<string, unknown>;
}

function roleDsseSigner(role: NativeRequesterIdentity) {
  return async ({ preAuthEncoding }: { readonly preAuthEncoding: Uint8Array }) => [{
    keyid: role.keyId,
    signature: role.sign(preAuthEncoding),
  }] as const;
}

function rawDigest(bytes: Uint8Array): Digest {
  return documentDigest(bytes);
}

function runSeed(runId: string, taskDigest: Digest, admissionReceiptDigest: Digest): string {
  return sha256Hex(new TextEncoder().encode(
    `jinn:native-requester:v1|${runId}|${taskDigest}|${admissionReceiptDigest}`,
  ));
}

function uuidFromHex(hex: string): string {
  return `urn:uuid:${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function asStoredOutcome(outcome: PostingOutcome): StoredPostingOutcome {
  return { taskId: outcome.taskId.toString(10), txHash: outcome.txHash };
}

function asPostingOutcome(outcome: StoredPostingOutcome): PostingOutcome {
  return { taskId: BigInt(outcome.taskId), txHash: outcome.txHash };
}

function toAssociation(stored: StoredAssociation): NativeRequesterAssociation {
  return { ...stored, taskId: BigInt(stored.taskId) };
}

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${crypto.randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, path);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

function sameJson(left: unknown, right: unknown): boolean {
  return Buffer.from(canonicalJsonBytes(left)).equals(Buffer.from(canonicalJsonBytes(right)));
}

class NativeRequesterState {
  readonly records;

  constructor(private readonly root: string) {
    this.records = createFsBlobStore(join(root, 'discovery'));
  }

  private draftsDir(): string { return join(this.root, 'drafts'); }
  private draftPath(key: string): string { return join(this.draftsDir(), `${key}.json`); }
  private associationsDir(): string { return join(this.root, 'associations'); }
  private associationPath(key: string): string { return join(this.associationsDir(), `${key}.json`); }
  private sourcePath(): string { return join(this.root, 'requester-source.json'); }

  async readDraft(key: string): Promise<NativeRequesterDraft | undefined> {
    return readJson<NativeRequesterDraft>(this.draftPath(key));
  }

  async putDraft(draft: NativeRequesterDraft): Promise<NativeRequesterDraft> {
    const existing = await this.readDraft(draft.key);
    if (existing !== undefined) {
      if (!sameJson(existing, draft) && existing.stage === 'prepared') {
        throw new Error(`native requester draft ${draft.key} conflicts with different exact record bytes`);
      }
      return existing;
    }
    await writeJsonAtomic(this.draftPath(draft.key), draft);
    return draft;
  }

  async updateDraft(draft: NativeRequesterDraft): Promise<void> {
    await writeJsonAtomic(this.draftPath(draft.key), draft);
  }

  async allDrafts(): Promise<readonly NativeRequesterDraft[]> {
    try {
      const names = (await readdir(this.draftsDir())).filter((name) => name.endsWith('.json')).sort();
      const drafts = await Promise.all(names.map((name) => readJson<NativeRequesterDraft>(join(this.draftsDir(), name))));
      return drafts.filter((draft): draft is NativeRequesterDraft => draft !== undefined);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  async readAssociation(key: string): Promise<NativeRequesterAssociation | undefined> {
    const stored = await readJson<StoredAssociation>(this.associationPath(key));
    return stored === undefined ? undefined : toAssociation(stored);
  }

  async writeAssociation(key: string, association: NativeRequesterAssociation): Promise<void> {
    const stored: StoredAssociation = { ...association, taskId: association.taskId.toString(10) };
    await writeJsonAtomic(this.associationPath(key), stored);
  }

  async readSource(): Promise<SourceState> {
    return (await readJson<SourceState>(this.sourcePath())) ?? { version: 1 };
  }

  async writeSource(source: SourceState): Promise<void> {
    await writeJsonAtomic(this.sourcePath(), source);
  }
}

function draftKey(input: Pick<NativeRequesterDraft, 'chainId' | 'coordinator' | 'taskDigest' | 'submissionDigest'>): string {
  return sha256Hex(new TextEncoder().encode(
    `${input.chainId}|${lowerAddress(input.coordinator)}|${input.taskDigest}|${input.submissionDigest}`,
  ));
}

function associationKey(input: Pick<NativeRequesterAssociation, 'chainId' | 'coordinator' | 'taskId' | 'taskDigest'>): string {
  return sha256Hex(new TextEncoder().encode(
    `${input.chainId}|${lowerAddress(input.coordinator)}|${input.taskId.toString(10)}|${input.taskDigest}`,
  ));
}

async function storeExactRecords(
  state: NativeRequesterState,
  bytes: {
    readonly evaluationSpec: Uint8Array;
    readonly task: Uint8Array;
    readonly admissionReceipt: Uint8Array;
    readonly submission: Uint8Array;
    readonly requesterEnvelope: Uint8Array;
  },
): Promise<NativeRequesterArtifacts> {
  async function save(value: Uint8Array, contentType: string): Promise<StoredExactRecord> {
    const written = await writeRecord(state.records, value, contentType);
    if (written.digest !== rawDigest(value)) throw new Error('exact record write returned a non-matching digest');
    return written;
  }
  return {
    evaluationSpec: await save(bytes.evaluationSpec, JSON_MEDIA_TYPE),
    task: await save(bytes.task, JSON_MEDIA_TYPE),
    admissionReceipt: await save(bytes.admissionReceipt, ADMISSION_RECEIPT_MEDIA_TYPE),
    submission: await save(bytes.submission, JSON_MEDIA_TYPE),
    requesterEnvelope: await save(bytes.requesterEnvelope, ADMISSION_RECEIPT_MEDIA_TYPE),
  };
}

async function sealRunBundle(input: {
  readonly runId: string;
  readonly requesterAgent: string;
  readonly roles: NativeRequesterRoles;
  readonly checkpoint?: NativeRequesterDeps['checkpoints'];
}): Promise<{
  readonly evaluationSpecBytes: Uint8Array;
  readonly taskBytes: Uint8Array;
  readonly admissionReceiptBytes: Uint8Array;
  readonly submissionBytes: Uint8Array;
  readonly requesterEnvelopeBytes: Uint8Array;
}> {
  // The B1 contract is verified before any use as a template. Its historic Submission/DSSE bytes
  // are not a replay source; only the pinned Task/EvaluationSpec contract is preserved.
  await verifyPredictionSnapshotFixture();
  const template = await loadPredictionSnapshotFixture();
  await input.checkpoint?.('evaluation-spec-sealed');
  const evaluationSpecBytes = template.evaluationSpec;
  await input.checkpoint?.('task-sealed');
  const taskBytes = template.task;

  const admissionRole = input.roles.get('admission');
  const receipt = admitPredictionSnapshot({
    taskBytes,
    evaluationSpecBytes,
    issuer: `${input.requesterAgent}/admission/${input.runId}`,
  });
  const sealedReceipt = await sealPredictionSnapshotAdmissionReceipt(receipt, roleDsseSigner(admissionRole));
  const admissionReceiptBytes = sealedReceipt.envelopeBytes;
  await input.checkpoint?.('admission-receipt-sealed');

  const templateSubmission = bytesToObject(template.submission, 'B1 Submission template');
  const taskDigest = rawDigest(taskBytes);
  const seed = runSeed(input.runId, taskDigest, sealedReceipt.receiptDigest);
  const annotations = {
    ...(templateSubmission.annotations as Record<string, unknown> ?? {}),
    'https://jinn.network/annotations/admission-receipt/1.0': {
      name: 'admission-receipt',
      mediaType: ADMISSION_RECEIPT_MEDIA_TYPE,
      digest: { sha256: sealedReceipt.receiptDigest.slice('sha256:'.length) },
    },
    'https://jinn.network/annotations/native-requester-run/1.0': { runId: input.runId },
  };
  const submissionBytes = sealSubmission({
    ...templateSubmission,
    submission: uuidFromHex(seed),
    idempotencyKey: `native-prediction-forecast:${input.runId}:${taskDigest.slice(7, 23)}`,
    nonce: seed.slice(0, 32),
    task: { digest: { sha256: taskDigest.slice('sha256:'.length) } },
    annotations,
  });
  const submissionDigest = rawDigest(submissionBytes);
  await input.checkpoint?.('submission-sealed');

  const requesterRole = input.roles.get('requester-submission');
  const requesterEnvelope = await sealSignedRecord({
    payloadType: ADMISSION_RECEIPT_MEDIA_TYPE,
    signer: roleDsseSigner(requesterRole),
    record: {
      _type: 'https://in-toto.io/Statement/v1',
      subject: [{ name: 'submission', digest: { sha256: submissionDigest.slice('sha256:'.length) } }],
      predicateType: REQUESTER_ENVELOPE_PREDICATE,
      predicate: {
        requester: templateSubmission.requester,
        taskDigest,
        submissionDigest,
        admissionReceiptDigest: sealedReceipt.receiptDigest,
        runId: input.runId,
      },
    },
  });
  await input.checkpoint?.('requester-envelope-sealed');
  return {
    evaluationSpecBytes,
    taskBytes,
    admissionReceiptBytes,
    submissionBytes,
    requesterEnvelopeBytes: requesterEnvelope.envelopeBytes,
  };
}

function exactLocations(base: string, artifacts: NativeRequesterArtifacts): Record<string, string> {
  const normalized = base.replace(/\/+$/u, '');
  return Object.fromEntries(Object.entries(artifacts).map(([name, record]) => [name, `${normalized}${record.path}`]));
}

function location(base: string, path: string): PublishedLocation[] {
  return [{ profile: LOCATION_PROFILE_HTTPS, locator: `${base.replace(/\/+$/u, '')}${path}` }];
}

function discoverySigner(role: NativeRequesterIdentity) {
  return {
    scope: DISCOVERY_SIGNING_SCOPE,
    sign: async (pae: Uint8Array) => [{ keyid: role.keyId, sig: role.sign(pae) }],
  } as const;
}

function sourceDsseSigner(role: NativeRequesterIdentity) {
  return { sign: async (pae: Uint8Array) => [{ keyid: role.keyId, sig: role.sign(pae) }] };
}

async function sourceFacts(
  state: NativeRequesterState,
  submission: Uint8Array,
  association: Pick<NativeRequesterAssociation, 'chainId' | 'coordinator' | 'taskId' | 'taskDigest' | 'requesterEnvelopeDigest' | 'admissionReceiptDigest'>,
  runId: string,
): Promise<Record<string, unknown>> {
  const recompute = TASK_EXECUTION_FACTS_RECOMPUTE.get(RECORD_KINDS.submission);
  if (recompute === undefined) throw new Error('submission facts recompute is not registered');
  const facts = await recompute(submission, {
    fetch: async (digest) => (await state.records.get(recordPath(digest)))?.bytes,
  });
  return {
    // A recomputer denotes an unavailable fact with `undefined`; an archive entry is sealed
    // JSON, so omit those fields instead of letting an implementation detail corrupt the page.
    ...Object.fromEntries(Object.entries(facts).filter(([, value]) => value !== undefined)),
    [REQUESTER_ASSOCIATION_FACT]: {
      chainId: association.chainId,
      coordinator: association.coordinator,
      taskId: association.taskId.toString(10),
      taskDigest: association.taskDigest,
      admissionReceiptDigest: association.admissionReceiptDigest,
      requesterEnvelopeDigest: association.requesterEnvelopeDigest,
      runId,
    },
  };
}

async function appendRequesterSource(input: {
  readonly state: NativeRequesterState;
  readonly source: SourceIdentity;
  readonly role: NativeRequesterIdentity;
  readonly publicBaseUrl: string;
  readonly now: Date;
  readonly association: NativeRequesterAssociation;
  readonly runId: string;
}): Promise<NativeRequesterAssociation> {
  if (input.association.publication.state === 'published') return input.association;
  let association = input.association;
  let publication = association.publication;

  if (publication.sequence === '') {
    const sourceState = await input.state.readSource();
    const sequence = formatSequence(sourceState.last === undefined ? 1n : BigInt(sourceState.last.sequence) + 1n);
    const previous = sourceState.last?.entryDigest ?? null;
    const page = sequence;
    const issuedAt = input.now.toISOString();
    const entry: AnnouncementEntry = {
      protocol: RECORD_DISCOVERY_VERSION,
      source: input.source,
      sequence,
      previous,
      timestamp: issuedAt,
      announcements: [{
        announcementId: `native-requester-${association.chainId}-${association.taskId.toString(10)}-${association.taskDigest.slice(7, 23)}`,
        action: 'available',
        record: { kind: RECORD_KINDS.submission, digest: association.submissionDigest, mediaType: JSON_MEDIA_TYPE },
        locations: location(input.publicBaseUrl, association.submission.path),
        facts: await sourceFacts(
          input.state,
          (await input.state.records.get(association.submission.path))!.bytes,
          association,
          input.runId,
        ),
      }],
    };
    const entryDigest = sealJson(entry).digest;
    const head: SourceHead = {
      protocol: RECORD_DISCOVERY_VERSION,
      origin: formatOrigin(input.source.agent, input.source.name),
      sequence,
      entry: entryDigest,
      issuedAt,
      refreshBy: new Date(input.now.getTime() + 24 * 60 * 60 * 1000).toISOString(),
    };
    publication = {
      state: 'pending',
      sequence,
      page,
      entry,
      entryDigest,
      head,
      announcementId: entry.announcements[0]!.announcementId,
    };
    association = { ...association, publication };
  }

  // Persist the append intent before touching the archive. A restart reuses this exact timestamp,
  // entry, signature, page and head instead of creating a second public announcement.
  await input.state.writeAssociation(
    associationKey(association),
    association,
  );
  const signer = discoverySigner(input.role);
  const signedEntry = await signAnnouncementEntry(publication.entry, signer);
  const pageBytes = sealJson({
    protocol: RECORD_DISCOVERY_VERSION,
    source: input.source.name,
    page: publication.page,
    prevArchive: publication.entry.previous === null ? null : formatSequence(BigInt(publication.sequence) - 1n),
    entries: [{ entry: publication.entry, signature: signedEntry }],
  }).bytes;
  await input.state.records.put(archivePagePath(input.source.name, publication.page), pageBytes, JSON_MEDIA_TYPE);
  const headEnvelope = await signHead(publication.head, sourceDsseSigner(input.role));
  await input.state.records.put(headPath(input.source.name), sealJson(headEnvelope).bytes, 'application/vnd.jinn.record-discovery.head.v1+json');
  await writeWellKnownDocument(input.state.records, {
    protocol: RECORD_DISCOVERY_VERSION,
    sources: [{
      agent: input.source.agent,
      name: input.source.name,
      headPath: headPath(input.source.name),
      archiveRoot: archivePagePath(input.source.name, publication.page),
    }],
  });
  await input.state.writeSource({
    version: 1,
    last: { sequence: publication.sequence, entryDigest: publication.entryDigest, page: publication.page, head: publication.head },
  });
  association = { ...association, publication: { ...publication, state: 'published' } };
  await input.state.writeAssociation(associationKey(association), association);
  return association;
}

/**
 * Builds the feature-disabled native requester. The public CLI intentionally never instantiates
 * this without a later explicit product cutover; tests and a future native composition inject
 * all key, chain, post, recovery, and canonical-read authority through this seam.
 */
export function createNativeRequester(deps: NativeRequesterDeps): {
  request(input: NativeRequesterRequest): Promise<NativeRequesterResult>;
  handleDiscoveryRequest(request: Request): Promise<Response>;
} {
  const state = new NativeRequesterState(deps.stateDir);
  const source: SourceIdentity = { agent: deps.requesterAgent, name: 'requester' };
  const handler = createArchiveHttpHandler({ reader: state.records });

  async function canonicalAssociation(
    draft: NativeRequesterDraft,
    chain: MarketplaceChainConfig,
    roles: NativeRequesterRoles,
  ): Promise<NativeRequesterAssociation | undefined> {
    if (draft.outcome === undefined) return undefined;
    const outcome = asPostingOutcome(draft.outcome);
    const canonical = await deps.posting.canonicalTaskCreated({
      chainId: chain.chainId,
      coordinator: chain.taskCoordinator,
      creator: draft.creatorSafe,
      taskId: outcome.taskId,
      taskDigest: draft.taskDigest,
      txHash: outcome.txHash,
    });
    if (
      canonical === null
      || canonical.canonical !== true
      || canonical.chainId !== chain.chainId
      || lowerAddress(canonical.coordinator) !== lowerAddress(chain.taskCoordinator)
      || lowerAddress(canonical.creator) !== lowerAddress(draft.creatorSafe)
      || canonical.taskId !== outcome.taskId
      || canonical.taskDigest !== draft.taskDigest
      || canonical.txHash !== outcome.txHash
    ) {
      throw new Error('native requester refuses non-canonical or mismatched TaskCreated association');
    }
    const key = associationKey({
      chainId: chain.chainId,
      coordinator: chain.taskCoordinator,
      taskId: outcome.taskId,
      taskDigest: draft.taskDigest,
    });
    const existing = await state.readAssociation(key);
    if (existing !== undefined) {
      if (
        existing.submissionDigest !== draft.submissionDigest
        || existing.requesterEnvelopeDigest !== draft.requesterEnvelopeDigest
      ) throw new Error('canonical TaskCreated is already associated with a different exact Submission graph');
      return appendRequesterSource({
        state,
        source,
        role: roles.get('requester-discovery'),
        publicBaseUrl: deps.publicBaseUrl,
        now: deps.now(),
        association: existing,
        runId: draft.runId,
      });
    }
    const association: NativeRequesterAssociation = {
      version: 1,
      chainId: canonical.chainId,
      coordinator: canonical.coordinator,
      taskId: canonical.taskId,
      taskDigest: canonical.taskDigest,
      submissionDigest: draft.submissionDigest,
      requesterEnvelopeDigest: draft.requesterEnvelopeDigest,
      admissionReceiptDigest: draft.artifacts.admissionReceipt.digest,
      txHash: canonical.txHash,
      submission: draft.artifacts.submission,
      requesterEnvelope: draft.artifacts.requesterEnvelope,
      admissionReceipt: draft.artifacts.admissionReceipt,
      task: draft.artifacts.task,
      evaluationSpec: draft.artifacts.evaluationSpec,
      publication: {
        state: 'pending', sequence: '', page: '', entry: undefined as unknown as AnnouncementEntry,
        entryDigest: '' as Digest, head: undefined as unknown as SourceHead, announcementId: '',
      },
    };
    await state.writeAssociation(key, association);
    await deps.checkpoints?.('canonical-associated');
    const published = await appendRequesterSource({
      state,
      source,
      role: roles.get('requester-discovery'),
      publicBaseUrl: deps.publicBaseUrl,
      now: deps.now(),
      association,
      runId: draft.runId,
    });
    await deps.checkpoints?.('source-announced');
    return published;
  }

  async function reconcile(chain: MarketplaceChainConfig, roles: NativeRequesterRoles): Promise<void> {
    const drafts = await state.allDrafts();
    for (const draft of drafts) {
      let current = draft;
      if (current.stage === 'broadcasting' && current.outcome === undefined) {
        const recovered = await deps.posting.recover({
          chain,
          creatorSafe: current.creatorSafe,
          taskDigest: current.taskDigest,
          submissionDigest: current.submissionDigest,
        });
        if (recovered === null) {
          throw new Error(`native requester has an unresolved broadcast for runId ${current.runId}; refusing new posts`);
        }
        current = { ...current, stage: 'broadcasted', outcome: asStoredOutcome(recovered) };
        await state.updateDraft(current);
      }
      if (current.outcome !== undefined) await canonicalAssociation(current, chain, roles);
    }
  }

  return {
    async request(input): Promise<NativeRequesterResult> {
      assertRunId(input.runId);
      if (input.fixture !== FIXTURE) throw new Error(`native requester fixture must be ${FIXTURE}`);
      // This assertion is intentionally before role load, template signing, or post construction.
      const chain = assertBaseSepoliaTarget(input.network, await deps.readChain());
      const roles = await deps.loadRoles();
      // Resolve every prior broadcast before producing a new Submission. In particular, a retry
      // of the same run must return its durable canonical association rather than re-seal a
      // receipt with a newly loaded key and accidentally mint another Submission identity.
      await reconcile(chain, roles);
      const priorForRun = (await state.allDrafts()).find((draft) => (
        draft.runId === input.runId
        && draft.chainId === chain.chainId
        && lowerAddress(draft.coordinator) === lowerAddress(chain.taskCoordinator)
        && lowerAddress(draft.creatorSafe) === lowerAddress(deps.creatorSafe)
      ));
      if (priorForRun?.outcome !== undefined) {
        const association = await canonicalAssociation(priorForRun, chain, roles);
        if (association === undefined) throw new Error('native requester lost its durable canonical association');
        return { association, reused: true };
      }
      if (priorForRun !== undefined) {
        throw new Error(`native requester runId ${input.runId} has a durable prepared bundle; resolve it before minting another Submission`);
      }
      const bundle = await sealRunBundle({
        runId: input.runId,
        requesterAgent: deps.requesterAgent,
        roles,
        ...(deps.checkpoints === undefined ? {} : { checkpoint: deps.checkpoints }),
      });
      const artifacts = await storeExactRecords(state, {
        evaluationSpec: bundle.evaluationSpecBytes,
        task: bundle.taskBytes,
        admissionReceipt: bundle.admissionReceiptBytes,
        submission: bundle.submissionBytes,
        requesterEnvelope: bundle.requesterEnvelopeBytes,
      });
      const taskDigest = artifacts.task.digest;
      const submissionDigest = artifacts.submission.digest;
      const draft: NativeRequesterDraft = {
        version: 1,
        key: draftKey({ chainId: chain.chainId, coordinator: chain.taskCoordinator, taskDigest, submissionDigest }),
        runId: input.runId,
        chainId: chain.chainId,
        coordinator: chain.taskCoordinator,
        creatorSafe: deps.creatorSafe,
        taskDigest,
        submissionDigest,
        requesterEnvelopeDigest: artifacts.requesterEnvelope.digest,
        artifacts,
        stage: 'prepared',
      };
      let durable = await state.putDraft(draft);
      await deps.checkpoints?.('draft-durable');
      if (durable.outcome !== undefined) {
        const association = await canonicalAssociation(durable, chain, roles);
        if (association === undefined) throw new Error('native requester lost its durable canonical association');
        return { association, reused: true };
      }
      await deps.checkpoints?.('before-broadcast');
      durable = { ...durable, stage: 'broadcasting' };
      await state.updateDraft(durable);
      const outcome = await deps.posting.post({
        taskBytes: bundle.taskBytes,
        evaluationSpecBytes: bundle.evaluationSpecBytes,
        admissionReceiptBytes: bundle.admissionReceiptBytes,
        submissionBytes: bundle.submissionBytes,
        requesterEnvelopeBytes: bundle.requesterEnvelopeBytes,
        chain,
        creatorSafe: deps.creatorSafe,
      });
      durable = { ...durable, stage: 'broadcasted', outcome: asStoredOutcome(outcome) };
      await state.updateDraft(durable);
      await deps.checkpoints?.('after-broadcast');
      const association = await canonicalAssociation(durable, chain, roles);
      if (association === undefined) throw new Error('native requester could not persist its canonical association');
      return { association, reused: false };
    },
    handleDiscoveryRequest: handler,
  };
}
