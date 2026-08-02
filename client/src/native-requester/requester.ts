/**
 * Feature-disabled native requester vertical.
 *
 * This is deliberately a product seam, not a second marketplace implementation: B1 owns the
 * deterministic public prediction contract, marketplace-binding owns the actual `postTask` WAL,
 * and discovery owns record/head/archive layout. The runner owns only the requester-specific
 * durable association from a canonical today-mode `TaskCreated` to the exact Submission graph.
 */
import { mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises';
import { verify as cryptoVerify, type KeyObject } from 'node:crypto';
import { dirname, join } from 'node:path';
import {
  BASE_SEPOLIA_TODAY,
  postTask,
  type MarketplaceChainConfig,
  type PostingOutcome,
  type PostingPorts,
  type PostingTerms,
} from '@jinn-network/marketplace-binding';
import {
  admitPredictionSnapshot,
  ADMISSION_RECEIPT_MEDIA_TYPE,
  loadPredictionSnapshotFixture,
  sealPredictionSnapshotAdmissionReceipt,
  verifyPredictionSnapshotFixture,
} from '@jinn-network/task-admission';
import {
  SUBMISSION_MEDIA_TYPE,
  TASK_MEDIA_TYPE,
  SubmissionRecordSchema,
  documentDigest,
  sealSubmission,
  sha256Hex,
} from '@jinn-network/task-execution-protocol';
import {
  EVALUATION_SPEC_MEDIA_TYPE,
} from '@jinn-network/task-execution-profiles';
import {
  canonicalJsonBytes,
  DSSE_ENVELOPE_MEDIA_TYPE,
  dssePreAuthEncoding,
  parseExactDsseEnvelope,
  sealDsseEnvelope,
} from '@jinn-network/trust-core';
import {
  DISCOVERY_SIGNING_SCOPE,
  LOCATION_PROFILE_HTTPS,
  MEDIA_HEAD,
  RECORD_DISCOVERY_VERSION,
  RECORD_KINDS,
  archivePagePath,
  formatOrigin,
  formatSequence,
  headPath,
  parseAnnouncementEntry,
  parseSourceHead,
  parseWireDsseEnvelope,
  recordPath,
  sealJson,
  type AnnouncementEntry,
  type PublishedLocation,
  type SourceHead,
  type SourceIdentity,
} from '@jinn-network/record-discovery-protocol';
import { TASK_EXECUTION_FACTS_RECOMPUTE } from '@jinn-network/record-discovery-facts-task-execution';
import type { AnnouncedSubmissionCard } from '@jinn-network/marketplace-pipeline';
import type { NativeDiscoveryDecodeInput } from '../daemon/native-discovery.js';
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
export const NATIVE_REQUESTER_ASSOCIATION_FACT = 'https://jinn.network/facts/native-requester-association/1.0';
const JSON_MEDIA_TYPE = 'application/json';
const UINT256_MAX = (1n << 256n) - 1n;

type Digest = `sha256:${string}`;
type NativeRequesterRole = 'requester-submission' | 'admission' | 'requester-discovery';

export interface NativeRequesterIdentity {
  readonly keyId: string;
  sign(payload: Uint8Array): Uint8Array;
}

/** Public half of B2's requester-submission identity, used by the native projector only. */
export interface NativeRequesterSubmissionVerifier {
  readonly keyId: string;
  readonly publicKey: KeyObject;
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
  readonly terms: PostingTerms;
  readonly maxClaims: 1;
}

export interface NativePostingTermsWire {
  readonly solutionMaxDeliveryRateWei: string;
  readonly verdictMaxDeliveryRateWei: string;
  readonly responseTimeoutSeconds: string;
  readonly allowSolverSelfEvaluation: false;
}

export interface NativeRequesterPostInput {
  readonly taskBytes: Uint8Array;
  readonly evaluationSpecBytes: Uint8Array;
  readonly admissionReceiptBytes: Uint8Array;
  readonly submissionBytes: Uint8Array;
  readonly requesterEnvelopeBytes: Uint8Array;
  readonly chain: MarketplaceChainConfig;
  readonly creatorSafe: `0x${string}`;
  readonly terms: PostingTerms;
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
  readonly submissionUri: `urn:uuid:${string}`;
  readonly nonce: string;
  readonly postingTerms: NativePostingTermsWire;
  readonly intendedSpendWei: string;
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
  readonly submissionUri: `urn:uuid:${string}`;
  readonly nonce: string;
  readonly postingTerms: NativePostingTermsWire;
  readonly intendedSpendWei: string;
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
    /** Current product configuration, snapshotted into the durable draft before broadcast. */
    readonly terms: PostingTerms;
    /** Adapter around marketplace-binding's native `postTask`; no legacy adapter is admitted here. */
    readonly post: (input: NativeRequesterPostInput) => Promise<PostingOutcome>;
    /** Exact recovery scan for a draft left in `broadcasting` by a process death. */
    readonly recover: (draft: {
      readonly chain: MarketplaceChainConfig;
      readonly creatorSafe: `0x${string}`;
      readonly taskDigest: Digest;
      readonly submissionDigest: Digest;
      readonly terms: PostingTerms;
      readonly maxClaims: 1;
    }) => Promise<PostingOutcome | null>;
    /** Must read a canonical `TaskCreated`, never a receipt-only or projected fallback. */
    readonly canonicalTaskCreated: (expected: {
      readonly chainId: number;
      readonly coordinator: `0x${string}`;
      readonly creator: `0x${string}`;
      readonly taskId: bigint;
      readonly taskDigest: Digest;
      readonly txHash: `0x${string}`;
      readonly terms: PostingTerms;
      readonly maxClaims: 1;
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

/**
 * The production posting adapter: B3's only broadcast operation is marketplace-binding's native
 * `postTask`, which owns its own durable posting-intent WAL and Safe broadcast fence. The caller
 * still supplies those infrastructure ports; the feature-disabled CLI never instantiates this.
 */
export function createNativeRequesterPostTask(input: {
  readonly terms: PostingTerms;
  readonly ports: PostingPorts;
}): Pick<NativeRequesterDeps['posting'], 'terms' | 'post'> {
  return {
    terms: input.terms,
    post: async (request) => {
      if (!samePostingTerms(request.terms, input.terms)) {
        throw new Error('native requester post adapter refuses terms that differ from its configured authority');
      }
      return postTask(
        request.taskBytes,
        request.submissionBytes,
        request.terms,
        request.chain,
        request.creatorSafe,
        input.ports,
      );
    },
  };
}

export interface NativeRequesterResult {
  readonly association: NativeRequesterAssociation;
  readonly reused: boolean;
}

/** The only native projector lookup shape: the canonical TaskCreated tuple, no legacy hints. */
export interface NativeRequesterSubmissionLookup {
  readonly chainId: number;
  readonly coordinator: `0x${string}`;
  readonly taskId: bigint;
  readonly taskDigest: Digest;
}

/** Exact requester-authentication boundary shared by local resolution and public consumers. */
export function verifyNativeRequesterSubmissionEnvelope(input: {
  readonly envelopeBytes: Uint8Array;
  readonly submissionBytes: Uint8Array;
  readonly requesterSubmission: NativeRequesterSubmissionVerifier;
}): boolean {
  try {
    const envelope = parseExactDsseEnvelope(input.envelopeBytes);
    if (
      envelope.payloadType !== SUBMISSION_MEDIA_TYPE
      || Buffer.compare(Buffer.from(envelope.payloadBytes), Buffer.from(input.submissionBytes)) !== 0
    ) return false;
    const signature = envelope.signatures.find(
      (candidate) => candidate.keyid === input.requesterSubmission.keyId,
    );
    return signature !== undefined && cryptoVerify(
      null,
      Buffer.from(dssePreAuthEncoding(SUBMISSION_MEDIA_TYPE, envelope.payloadBytes)),
      input.requesterSubmission.publicKey,
      Buffer.from(signature.sig, 'base64'),
    );
  } catch {
    return false;
  }
}

function exactBytes(left: Uint8Array, right: Uint8Array): boolean {
  return Buffer.compare(Buffer.from(left), Buffer.from(right)) === 0;
}

function objectFact(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    failAssociation(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function digestFact(value: unknown, label: string): Digest {
  if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(value)) {
    failAssociation(`${label} must be a sha256 digest`);
  }
  return value as Digest;
}

/**
 * Turns one already trust-gated requester source item into the exact native marketplace card.
 * Source/head cryptographic authority remains in `NativeDiscoveryConsumer.verify`; this pure join
 * refuses any structural provenance, exact-record, posting-term, or canonical-chain divergence.
 */
export async function decodeNativeRequesterAnnouncement(input: {
  readonly discovery: NativeDiscoveryDecodeInput;
  readonly canonicalTaskCreated: CanonicalTaskCreated;
  readonly submissionBytes: Uint8Array;
}): Promise<AnnouncedSubmissionCard> {
  try {
    const { discovery, canonicalTaskCreated: canonical } = input;
    const entry = parseAnnouncementEntry(discovery.entry);
    const entryDigest = sealJson(entry).digest;
    if (entryDigest !== discovery.entryDigest) failAssociation('entry digest does not name the sealed entry');
    if (entry.source.agent !== discovery.source.agent || entry.source.name !== discovery.source.name) {
      failAssociation('entry source does not match the verified source');
    }
    const matching = entry.announcements.filter((candidate) =>
      candidate.action === 'available' && candidate.announcementId === discovery.announcement.announcementId,
    );
    if (matching.length !== 1 || !sameJson(matching[0], discovery.announcement)) {
      failAssociation('announcement is not the exact available item in the verified entry');
    }

    const parsedEnvelope = parseWireDsseEnvelope(discovery.signedHighWater.signature);
    if (parsedEnvelope.envelope.payloadType !== MEDIA_HEAD || parsedEnvelope.signatures.length === 0) {
      failAssociation('signed high-water is unsigned or has the wrong payload type');
    }
    let headValue: unknown;
    try {
      headValue = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(parsedEnvelope.payloadBytes));
    } catch {
      failAssociation('signed high-water payload is not JSON');
    }
    const head = parseSourceHead(headValue);
    if (!exactBytes(sealJson(head).bytes, parsedEnvelope.payloadBytes)) {
      failAssociation('signed high-water payload is not canonical');
    }
    if (
      head.origin !== formatOrigin(discovery.source.agent, discovery.source.name)
      || head.sequence !== discovery.signedHighWater.sequence
      || head.entry !== discovery.signedHighWater.entry
      || head.issuedAt !== discovery.signedHighWater.issuedAt
      || head.refreshBy !== discovery.signedHighWater.refreshBy
      || head.sequence < entry.sequence
      || (head.sequence === entry.sequence && head.entry !== entryDigest)
    ) failAssociation('signed high-water does not cover this exact source entry');

    const announcement = matching[0]!;
    if (announcement.action !== 'available') failAssociation('announcement is not available');
    if (announcement.record.kind !== RECORD_KINDS.submission || announcement.record.mediaType !== SUBMISSION_MEDIA_TYPE) {
      failAssociation('available item is not a native Submission record');
    }
    if (rawDigest(input.submissionBytes) !== announcement.record.digest) {
      failAssociation('advertised Submission digest does not match exact bytes');
    }
    let submission: ReturnType<typeof SubmissionRecordSchema.parse>;
    try {
      submission = SubmissionRecordSchema.parse(bytesToObject(input.submissionBytes, 'Submission'));
    } catch {
      failAssociation('exact Submission bytes do not parse');
    }
    if (!exactBytes(sealSubmission(submission), input.submissionBytes)) {
      failAssociation('exact Submission bytes are not canonical');
    }
    if ((submission.attempts?.maxTotal ?? 1) !== 1 || (submission.attempts?.maxConcurrent ?? 1) !== 1) {
      failAssociation('native requester Submission must carry today maxClaims=1');
    }

    const facts = objectFact(announcement.facts, 'announcement facts');
    const association = objectFact(facts[NATIVE_REQUESTER_ASSOCIATION_FACT], 'requester association fact');
    const expectedAssociationMembers = [
      'admissionReceiptDigest',
      'chainId',
      'coordinator',
      'intendedSpendWei',
      'nonce',
      'postingTerms',
      'requesterEnvelopeDigest',
      'runId',
      'submission',
      'taskDigest',
      'taskId',
    ];
    if (Object.keys(association).sort().join('|') !== expectedAssociationMembers.sort().join('|')) {
      failAssociation('requester association fact has missing or unexpected members');
    }
    if (canonical.canonical !== true || canonical.maxClaims !== 1) {
      failAssociation('TaskCreated is not canonical today maxClaims=1');
    }
    if (!Number.isSafeInteger(association.chainId) || association.chainId !== canonical.chainId) {
      failAssociation('chainId does not match canonical TaskCreated');
    }
    if (association.coordinator !== canonical.coordinator) {
      failAssociation('coordinator does not match canonical TaskCreated');
    }
    const taskId = uint256Decimal(association.taskId, 'taskId');
    if (taskId !== canonical.taskId) failAssociation('taskId does not match canonical TaskCreated');
    const taskDigest = digestFact(association.taskDigest, 'taskDigest');
    if (taskDigest !== canonical.taskDigest || facts.taskDigest !== taskDigest) {
      failAssociation('Task digest does not match Submission facts and canonical TaskCreated');
    }
    const submissionTaskDigest = submission.task.digest?.sha256;
    if (`sha256:${submissionTaskDigest}` !== taskDigest) failAssociation('Submission does not bind the canonical Task digest');
    if (association.submission !== submission.submission) failAssociation('Submission URI does not match exact bytes');
    if (typeof association.nonce !== 'string' || association.nonce.length === 0 || association.nonce !== submission.nonce) {
      failAssociation('Submission nonce does not match exact bytes');
    }
    digestFact(association.admissionReceiptDigest, 'admissionReceiptDigest');
    digestFact(association.requesterEnvelopeDigest, 'requesterEnvelopeDigest');
    if (typeof association.runId !== 'string' || !RUN_ID_PATTERN.test(association.runId)) {
      failAssociation('runId is not canonical');
    }

    const wireTerms = postingTermsFromWire(association.postingTerms);
    const canonicalTermsWire = postingTermsWire(canonical.terms);
    if (!sameJson(association.postingTerms, canonicalTermsWire) || !samePostingTerms(wireTerms, canonical.terms)) {
      failAssociation('posting terms do not match canonical TaskCreated');
    }
    const intendedSpend = uint256Decimal(association.intendedSpendWei, 'intendedSpendWei');
    if (intendedSpend !== wireTerms.solutionMaxDeliveryRateWei + wireTerms.verdictMaxDeliveryRateWei) {
      failAssociation('intendedSpendWei is not the exact today maxClaims=1 sum');
    }

    return {
      record: { kind: announcement.record.kind, digest: announcement.record.digest },
      facts,
      chain: {
        taskId,
        submission: submission.submission as `urn:uuid:${string}`,
        nonce: submission.nonce,
        intendedSpendWei: intendedSpend,
      },
      derivationKind: 'chain',
      discovery: {
        source: discovery.source,
        sequence: entry.sequence,
        entryDigest,
        signedHighWater: discovery.signedHighWater,
      },
    };
  } catch (error) {
    if (error instanceof NativeRequesterAssociationError) throw error;
    failAssociation(error instanceof Error ? error.message : String(error));
  }
}

function lowerAddress(address: string): string {
  return address.toLowerCase();
}

function failAssociation(reason: string): never {
  throw new NativeRequesterAssociationError(reason);
}

function uint256Decimal(value: unknown, label: string): bigint {
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    failAssociation(`${label} must be a canonical unsigned decimal string`);
  }
  const parsed = BigInt(value);
  if (parsed > UINT256_MAX) failAssociation(`${label} exceeds uint256`);
  return parsed;
}

function postingTermsWire(terms: PostingTerms): NativePostingTermsWire {
  const solution = terms.solutionMaxDeliveryRateWei;
  const verdict = terms.verdictMaxDeliveryRateWei;
  const timeout = terms.responseTimeoutSeconds;
  for (const [label, value] of [
    ['solutionMaxDeliveryRateWei', solution],
    ['verdictMaxDeliveryRateWei', verdict],
    ['responseTimeoutSeconds', timeout],
  ] as const) {
    if (value < 0n || value > UINT256_MAX) throw new RangeError(`native requester ${label} must fit uint256`);
  }
  if (terms.allowSolverSelfEvaluation) {
    throw new Error('native requester golden posting terms require allowSolverSelfEvaluation=false');
  }
  if (solution + verdict > UINT256_MAX) throw new RangeError('native requester intended spend exceeds uint256');
  return {
    solutionMaxDeliveryRateWei: solution.toString(10),
    verdictMaxDeliveryRateWei: verdict.toString(10),
    responseTimeoutSeconds: timeout.toString(10),
    allowSolverSelfEvaluation: false,
  };
}

function postingTermsFromWire(value: unknown): PostingTerms {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    failAssociation('postingTerms must be an object');
  }
  const terms = value as Record<string, unknown>;
  const exact = [
    'allowSolverSelfEvaluation',
    'responseTimeoutSeconds',
    'solutionMaxDeliveryRateWei',
    'verdictMaxDeliveryRateWei',
  ];
  if (Object.keys(terms).sort().join('|') !== exact.join('|')) {
    failAssociation('postingTerms contains missing or unexpected members');
  }
  if (terms.allowSolverSelfEvaluation !== false) {
    failAssociation('allowSolverSelfEvaluation must be false');
  }
  return {
    solutionMaxDeliveryRateWei: uint256Decimal(terms.solutionMaxDeliveryRateWei, 'solutionMaxDeliveryRateWei'),
    verdictMaxDeliveryRateWei: uint256Decimal(terms.verdictMaxDeliveryRateWei, 'verdictMaxDeliveryRateWei'),
    responseTimeoutSeconds: uint256Decimal(terms.responseTimeoutSeconds, 'responseTimeoutSeconds'),
    allowSolverSelfEvaluation: false,
  };
}

function samePostingTerms(left: PostingTerms, right: PostingTerms): boolean {
  return left.solutionMaxDeliveryRateWei === right.solutionMaxDeliveryRateWei
    && left.verdictMaxDeliveryRateWei === right.verdictMaxDeliveryRateWei
    && left.responseTimeoutSeconds === right.responseTimeoutSeconds
    && left.allowSolverSelfEvaluation === right.allowSolverSelfEvaluation;
}

function intendedSpendWire(terms: PostingTerms): string {
  const total = terms.solutionMaxDeliveryRateWei + terms.verdictMaxDeliveryRateWei;
  if (total < 0n || total > UINT256_MAX) throw new RangeError('native requester intended spend must fit uint256');
  return total.toString(10);
}

export class NativeRequesterAssociationError extends Error {
  override readonly name = 'NativeRequesterAssociationError';
  constructor(readonly reason: string) {
    super(`native requester association refused: ${reason}`);
  }
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
    evaluationSpec: await save(bytes.evaluationSpec, EVALUATION_SPEC_MEDIA_TYPE),
    task: await save(bytes.task, TASK_MEDIA_TYPE),
    // These exact records are DSSE envelopes. Their signed payloadType and the admission
    // annotation remain ADMISSION_RECEIPT_MEDIA_TYPE for protocol compatibility.
    admissionReceipt: await save(bytes.admissionReceipt, DSSE_ENVELOPE_MEDIA_TYPE),
    submission: await save(bytes.submission, SUBMISSION_MEDIA_TYPE),
    requesterEnvelope: await save(bytes.requesterEnvelope, DSSE_ENVELOPE_MEDIA_TYPE),
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
  readonly submissionUri: `urn:uuid:${string}`;
  readonly nonce: string;
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
    requester: input.requesterAgent,
    idempotencyKey: `native-prediction-forecast:${input.runId}:${taskDigest.slice(7, 23)}`,
    nonce: seed.slice(0, 32),
    task: { digest: { sha256: taskDigest.slice('sha256:'.length) } },
    annotations,
  });
  const submissionDigest = rawDigest(submissionBytes);
  const submission = SubmissionRecordSchema.parse(bytesToObject(submissionBytes, 'sealed Submission'));
  if ((submission.attempts?.maxTotal ?? 1) !== 1 || (submission.attempts?.maxConcurrent ?? 1) !== 1) {
    throw new Error('native requester golden Submission must have exactly one total/concurrent claim');
  }
  await input.checkpoint?.('submission-sealed');

  const requesterRole = input.roles.get('requester-submission');
  const requesterEnvelopeBytes = sealDsseEnvelope({
    payloadType: SUBMISSION_MEDIA_TYPE,
    payloadBytes: submissionBytes,
    signatures: [{
      keyid: requesterRole.keyId,
      signature: requesterRole.sign(dssePreAuthEncoding(SUBMISSION_MEDIA_TYPE, submissionBytes)),
    }],
  });
  await input.checkpoint?.('requester-envelope-sealed');
  return {
    evaluationSpecBytes,
    taskBytes,
    admissionReceiptBytes,
    submissionBytes,
    requesterEnvelopeBytes,
    submissionUri: submission.submission as `urn:uuid:${string}`,
    nonce: submission.nonce,
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
  association: Pick<NativeRequesterAssociation,
    | 'chainId'
    | 'coordinator'
    | 'taskId'
    | 'taskDigest'
    | 'submissionUri'
    | 'nonce'
    | 'postingTerms'
    | 'intendedSpendWei'
    | 'requesterEnvelopeDigest'
    | 'admissionReceiptDigest'>,
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
    [NATIVE_REQUESTER_ASSOCIATION_FACT]: {
      chainId: association.chainId,
      coordinator: association.coordinator,
      taskId: association.taskId.toString(10),
      taskDigest: association.taskDigest,
      submission: association.submissionUri,
      nonce: association.nonce,
      postingTerms: association.postingTerms,
      intendedSpendWei: association.intendedSpendWei,
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
        record: {
          kind: RECORD_KINDS.submission,
          digest: association.submissionDigest,
          mediaType: SUBMISSION_MEDIA_TYPE,
        },
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

async function readExactRecord(
  state: NativeRequesterState,
  expected: StoredExactRecord,
): Promise<Uint8Array | undefined> {
  if (expected.path !== recordPath(expected.digest)) return undefined;
  const record = await state.records.get(expected.path);
  if (record === undefined || rawDigest(record.bytes) !== expected.digest) return undefined;
  return record.bytes;
}

/**
 * Native-only projector resolver. It accepts a Submission only when its local association has
 * the exact canonical `(chainId, coordinator, taskId, taskDigest)` key and its requester DSSE
 * verifies against B2's requester-submission public key. This intentionally has no IPFS,
 * SignedTaskV1, CreatorLoop, or projection fallback.
 */
export function createNativeRequesterSubmissionResolver(input: {
  readonly stateDir: string;
  readonly requesterSubmission: NativeRequesterSubmissionVerifier;
}): (lookup: NativeRequesterSubmissionLookup) => Promise<Uint8Array | undefined> {
  const state = new NativeRequesterState(input.stateDir);

  return async (lookup) => {
    try {
      const key = associationKey(lookup);
      const association = await state.readAssociation(key);
      if (
        association === undefined
        || association.chainId !== lookup.chainId
        || lowerAddress(association.coordinator) !== lowerAddress(lookup.coordinator)
        || association.taskId !== lookup.taskId
        || association.taskDigest !== lookup.taskDigest
        || association.task.digest !== lookup.taskDigest
        || association.submission.digest !== association.submissionDigest
        || association.requesterEnvelope.digest !== association.requesterEnvelopeDigest
        || association.admissionReceipt.digest !== association.admissionReceiptDigest
        || association.publication.state !== 'published'
      ) return undefined;

      const [taskBytes, submissionBytes, requesterEnvelopeBytes, receiptBytes] = await Promise.all([
        readExactRecord(state, association.task),
        readExactRecord(state, association.submission),
        readExactRecord(state, association.requesterEnvelope),
        readExactRecord(state, association.admissionReceipt),
      ]);
      if (
        taskBytes === undefined
        || submissionBytes === undefined
        || requesterEnvelopeBytes === undefined
        || receiptBytes === undefined
        || rawDigest(taskBytes) !== lookup.taskDigest
      ) return undefined;

      const submission = SubmissionRecordSchema.parse(bytesToObject(submissionBytes, 'associated Submission'));
      const terms = postingTermsFromWire(association.postingTerms);
      if (
        !exactBytes(sealSubmission(submission), submissionBytes)
        || submission.submission !== association.submissionUri
        || submission.nonce !== association.nonce
        || (submission.attempts?.maxTotal ?? 1) !== 1
        || (submission.attempts?.maxConcurrent ?? 1) !== 1
        || intendedSpendWire(terms) !== association.intendedSpendWei
      ) return undefined;

      if (!verifyNativeRequesterSubmissionEnvelope({
        envelopeBytes: requesterEnvelopeBytes,
        submissionBytes,
        requesterSubmission: input.requesterSubmission,
      })) return undefined;

      return submissionBytes;
    } catch {
      return undefined;
    }
  };
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
    const durableTerms = postingTermsFromWire(draft.postingTerms);
    const canonical = await deps.posting.canonicalTaskCreated({
      chainId: chain.chainId,
      coordinator: chain.taskCoordinator,
      creator: draft.creatorSafe,
      taskId: outcome.taskId,
      taskDigest: draft.taskDigest,
      txHash: outcome.txHash,
      terms: durableTerms,
      maxClaims: 1,
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
      || canonical.maxClaims !== 1
      || !samePostingTerms(canonical.terms, durableTerms)
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
        || existing.submissionUri !== draft.submissionUri
        || existing.nonce !== draft.nonce
        || !sameJson(existing.postingTerms, draft.postingTerms)
        || existing.intendedSpendWei !== draft.intendedSpendWei
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
      submissionUri: draft.submissionUri,
      nonce: draft.nonce,
      postingTerms: draft.postingTerms,
      intendedSpendWei: draft.intendedSpendWei,
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
        const terms = postingTermsFromWire(current.postingTerms);
        const recovered = await deps.posting.recover({
          chain,
          creatorSafe: current.creatorSafe,
          taskDigest: current.taskDigest,
          submissionDigest: current.submissionDigest,
          terms,
          maxClaims: 1,
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
      const configuredPostingTerms = postingTermsWire(deps.posting.terms);
      const configuredIntendedSpend = intendedSpendWire(deps.posting.terms);
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
        submissionUri: bundle.submissionUri,
        nonce: bundle.nonce,
        postingTerms: configuredPostingTerms,
        intendedSpendWei: configuredIntendedSpend,
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
        terms: postingTermsFromWire(durable.postingTerms),
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
