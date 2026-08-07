/**
 * Feature-disabled native requester vertical.
 *
 * This is deliberately a product seam, not a second marketplace implementation: B1 owns the
 * deterministic public prediction contract, marketplace-binding owns the requester posting WAL,
 * and discovery owns record/head/archive layout. The runner owns only the requester-specific
 * durable association from a canonical today-mode `TaskCreated` to the exact Submission graph.
 */
import { mkdir, open, readFile, readdir, rename, stat, unlink } from 'node:fs/promises';
import { verify as cryptoVerify, type KeyObject } from 'node:crypto';
import { dirname, join } from 'node:path';
import {
  BASE_SEPOLIA_TODAY,
  DEFAULT_SUBMISSION_DEADLINE_LEAD_MS,
  type MarketplaceChainConfig,
  type MarketplaceRequesterBackend,
  type PostingOutcome,
  type PostingTerms,
  type RequesterPostingRecoveryReport,
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
  MEDIA_ENTRY,
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
  recordDigest,
  recordPath,
  sealJson,
  type AnnouncementEntry,
  type PublishedLocation,
  type SourceHead,
  type SourceIdentity,
} from '@jinn-network/record-discovery-protocol';
import { TASK_EXECUTION_FACTS_RECOMPUTE } from '@jinn-network/record-discovery-facts-task-execution';
import type { NativeDiscoveryDecodeInput } from '../daemon/native-discovery.js';
import type { AnnouncedSubmissionCard } from '../daemon/native-submission-facts.js';
import {
  createDurableSourceWriter,
  writeRecord,
  writeWellKnownDocument,
  type ArchivePage,
  type CasSnapshot,
  type CasWriteResult,
  type DurableSourceAppendIntent,
  type DurableSourceReceipt,
  type DurableSourceSigner,
  type DurableSourceState,
  type ReadableImmutableBlobStore,
  type SourceAppendIntentStore,
  type SourceStateStore,
} from '@jinn-network/record-discovery-serve';
import {
  createArchiveHttpHandler,
  createFsBlobStore,
} from '@jinn-network/record-discovery-transport-http';
import {
  adaptRequesterSourceV1Publication,
  freezeRequesterSourceV1Intent,
} from './requester-source-writer-adapter.js';

// Public, stable product fixture name. The admission package may retain its
// internal snapshot fixture directory; that storage detail must not leak into
// the accepted requester command contract.
const FIXTURE = 'prediction-forecast-golden.json' as const;

/**
 * The single today-mode requester fixture name, exported so a composing host (the fleet posting
 * write path, one-swap M5e) can name the `NativeRequesterRequest.fixture` it drives `request()`
 * with without duplicating the literal. `request()` still refuses any other value.
 */
export const NATIVE_REQUESTER_FIXTURE = FIXTURE;
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
export const NATIVE_REQUESTER_ASSOCIATION_FACT = 'https://spec.jinn.network/facts/native-requester-association/v1';
const UINT256_MAX = (1n << 256n) - 1n;

type Digest = `sha256:${string}`;
type NativeRequesterRole = 'requester-submission' | 'admission' | 'requester-discovery';

export interface NativeRequesterIdentity {
  readonly keyId: string;
  readonly publicKey: KeyObject;
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

/** Finalized chain time sealed into both admission and requester authority. */
export interface NativeAuthorityTimeAnchor {
  readonly chainId: 84532;
  readonly blockNumber: string;
  readonly blockHash: `0x${string}`;
  readonly timestamp: string;
  readonly finalized: true;
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

interface NativeRequesterDraftV1 {
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
  readonly authorityTime: NativeAuthorityTimeAnchor;
  readonly artifacts: NativeRequesterArtifacts;
  readonly stage: 'prepared' | 'broadcasting' | 'broadcasted';
  readonly outcome?: StoredPostingOutcome;
}

/** Phase C product-only draft: broadcast ownership lives exclusively in marketplace binding. */
interface NativeRequesterDraftV2 extends Omit<NativeRequesterDraftV1, 'version' | 'stage'> {
  readonly version: 2;
}

type NativeRequesterDraft = NativeRequesterDraftV1 | NativeRequesterDraftV2;

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
  /** Frozen generic append transaction, persisted inside the existing association authority. */
  readonly writerIntent?: DurableSourceAppendIntent;
}

export interface NativeRequesterAssociation {
  readonly version: 1;
  readonly chainId: number;
  readonly coordinator: `0x${string}`;
  readonly creator: `0x${string}`;
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
  readonly authorityTime: NativeAuthorityTimeAnchor;
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
  /** Present only while the one source-global append transaction is in flight. */
  readonly pending?: {
    readonly version: 1;
    readonly associationKey: string;
    readonly intent: DurableSourceAppendIntent;
  };
}

export interface NativeRequesterDeps {
  /** Absolute directory owned by this requester process. */
  readonly stateDir: string;
  readonly requesterAgent: string;
  /** Stable admission authority; never derived from runId or requester identity. */
  readonly admissionAgent: string;
  readonly publicBaseUrl: string;
  /** This is intentionally first: mismatches reject before key loading or transaction preparation. */
  readonly readChain: () => Promise<MarketplaceChainConfig>;
  /** Latest canonical finalized block, fetched before role custody is loaded. */
  readonly authorityTime: () => Promise<NativeAuthorityTimeAnchor>;
  readonly loadRoles: () => Promise<NativeRequesterRoles>;
  readonly creatorSafe: `0x${string}`;
  readonly posting: {
    /** Current product configuration, snapshotted into the durable draft before broadcast. */
    readonly terms: PostingTerms;
    /** Outcome-bearing shared requester operation; no direct venue posting port is admitted here. */
    readonly post: (input: NativeRequesterPostInput) => Promise<PostingOutcome>;
    /** Reconciles the requester-scope/WAL join before any new product work is admitted. */
    readonly recoverPosting: () => Promise<RequesterPostingRecoveryReport>;
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
    | 'source-intent-durable'
    | 'source-announced') => Promise<void>;
}

/**
 * The production posting adapter: B3 delegates exact Task/Submission posting to the shared
 * marketplace requester backend, which owns scope/WAL recovery and the Safe broadcast fence.
 */
export function createNativeRequesterPostTask(input: {
  readonly terms: PostingTerms;
  readonly backend: Pick<MarketplaceRequesterBackend, 'post' | 'recoverPosting'>;
}): Pick<NativeRequesterDeps['posting'], 'terms' | 'post' | 'recoverPosting'> {
  return {
    terms: input.terms,
    recoverPosting: () => input.backend.recoverPosting(),
    post: async (request) => {
      if (!samePostingTerms(request.terms, input.terms)) {
        throw new Error('native requester post adapter refuses terms that differ from its configured authority');
      }
      return input.backend.post(request.taskBytes, request.submissionBytes);
    },
  };
}

function assertPostingRecoverySafe(
  report: RequesterPostingRecoveryReport,
  options: { readonly allowRetryable: boolean },
): void {
  const unsafe = report.uncertainScopes.length > 0
    || report.conflicts.length > 0
    || (!options.allowRetryable && report.retryableScopes.length > 0);
  if (unsafe) {
    throw new Error(
      'native requester posting recovery is not closed: '
      + `${report.uncertainScopes.length} uncertain, ${report.retryableScopes.length} retryable, `
      + `${report.conflicts.length} conflicting scope(s)`,
    );
  }
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

export function parseNativeAuthorityTimeAnchor(value: unknown): NativeAuthorityTimeAnchor {
  const anchor = objectFact(value, 'authority time');
  if (anchor.chainId !== 84532
    || anchor.finalized !== true
    || typeof anchor.blockNumber !== 'string'
    || !/^(?:0|[1-9][0-9]*)$/u.test(anchor.blockNumber)
    || typeof anchor.blockHash !== 'string'
    || !/^0x[0-9a-fA-F]{64}$/u.test(anchor.blockHash)
    || typeof anchor.timestamp !== 'string'
    || !Number.isFinite(Date.parse(anchor.timestamp))) {
    failAssociation('authority time is not a canonical finalized Base Sepolia block');
  }
  return anchor as unknown as NativeAuthorityTimeAnchor;
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
      'authorityTime',
      'chainId',
      'coordinator',
      'creator',
      'intendedSpendWei',
      'nonce',
      'postingTerms',
      'requesterEnvelopeDigest',
      'runId',
      'submission',
      'sealedAt',
      'taskDigest',
      'taskId',
      'txHash',
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
    if (association.creator !== canonical.creator) failAssociation('creator does not match canonical TaskCreated');
    if (association.txHash !== canonical.txHash) failAssociation('transaction hash does not match canonical TaskCreated');
    const authorityTime = parseNativeAuthorityTimeAnchor(association.authorityTime);
    if (association.sealedAt !== authorityTime.timestamp) failAssociation('sealedAt does not equal the sealed authority time');
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
    const annotations = objectFact(submission.annotations ?? {}, 'Submission annotations');
    if (!sameJson(annotations['https://spec.jinn.network/annotations/authority-time/v1'], authorityTime)) {
      failAssociation('signed Submission authority time does not equal signed source facts');
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

async function readJsonSnapshot<T>(path: string): Promise<CasSnapshot<T> | undefined> {
  try {
    const bytes = new Uint8Array(await readFile(path));
    return {
      revision: recordDigest(bytes),
      value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as T,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function sameJson(left: unknown, right: unknown): boolean {
  return Buffer.from(canonicalJsonBytes(left)).equals(Buffer.from(canonicalJsonBytes(right)));
}

class NativeRequesterState {
  readonly records;
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(private readonly root: string) {
    this.records = createFsBlobStore(join(root, 'discovery'));
  }

  private draftsDir(): string { return join(this.root, 'drafts'); }
  private draftPath(key: string): string { return join(this.draftsDir(), `${key}.json`); }
  private associationsDir(): string { return join(this.root, 'associations'); }
  private associationPath(key: string): string { return join(this.associationsDir(), `${key}.json`); }
  private sourcePath(): string { return join(this.root, 'requester-source.json'); }
  private sourceCasLockPath(): string { return join(this.root, 'requester-source.cas.lock'); }
  private sourceOwnerLockPath(): string { return join(this.root, 'requester-source.owner.lock'); }

  async readDraft(key: string): Promise<NativeRequesterDraft | undefined> {
    return readJson<NativeRequesterDraft>(this.draftPath(key));
  }

  async putDraft(draft: NativeRequesterDraft): Promise<NativeRequesterDraft> {
    const existing = await this.readDraft(draft.key);
    if (existing !== undefined) {
      if (!sameJson(existing, draft) && existing.outcome === undefined) {
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

  /** Every durable canonical association this requester has posted (read-only; mirrors `allDrafts`). */
  async allAssociations(): Promise<readonly NativeRequesterAssociation[]> {
    try {
      const names = (await readdir(this.associationsDir())).filter((name) => name.endsWith('.json')).sort();
      const stored = await Promise.all(
        names.map((name) => readJson<StoredAssociation>(join(this.associationsDir(), name))),
      );
      return stored.filter((value): value is StoredAssociation => value !== undefined).map(toAssociation);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  async writeAssociation(key: string, association: NativeRequesterAssociation): Promise<void> {
    const stored: StoredAssociation = { ...association, taskId: association.taskId.toString(10) };
    await writeJsonAtomic(this.associationPath(key), stored);
  }

  async readAssociationSnapshot(key: string): Promise<CasSnapshot<NativeRequesterAssociation> | undefined> {
    const snapshot = await readJsonSnapshot<StoredAssociation>(this.associationPath(key));
    return snapshot === undefined
      ? undefined
      : { revision: snapshot.revision, value: toAssociation(snapshot.value) };
  }

  async readSource(): Promise<SourceState> {
    return (await readJson<SourceState>(this.sourcePath())) ?? { version: 1 };
  }

  async writeSource(source: SourceState): Promise<void> {
    await writeJsonAtomic(this.sourcePath(), source);
  }

  async readSourceSnapshot(): Promise<CasSnapshot<SourceState> | undefined> {
    return readJsonSnapshot<SourceState>(this.sourcePath());
  }

  private async withFileLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
    const token = crypto.randomUUID();
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    for (let attempt = 0; attempt < 2_500; attempt += 1) {
      try {
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        handle = await open(path, 'wx', 0o600);
        await handle.writeFile(`${JSON.stringify({ version: 1, pid: process.pid, token })}\n`, 'utf8');
        await handle.sync();
        break;
      } catch (error) {
        await handle?.close().catch(() => undefined);
        handle = undefined;
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        let stale = false;
        try {
          const owner = JSON.parse(await readFile(path, 'utf8')) as { pid?: unknown };
          if (typeof owner.pid === 'number' && Number.isInteger(owner.pid)) {
            try { process.kill(owner.pid, 0); } catch (killError) {
              stale = (killError as NodeJS.ErrnoException).code === 'ESRCH';
            }
          } else {
            stale = Date.now() - (await stat(path)).mtimeMs > 30_000;
          }
        } catch (readError) {
          if ((readError as NodeJS.ErrnoException).code === 'ENOENT') continue;
          stale = Date.now() - (await stat(path)).mtimeMs > 30_000;
        }
        if (stale) {
          await unlink(path).catch((unlinkError) => {
            if ((unlinkError as NodeJS.ErrnoException).code !== 'ENOENT') throw unlinkError;
          });
          continue;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 2));
      }
    }
    if (handle === undefined) throw new Error(`requester source lock ${path} could not be acquired`);
    try {
      return await operation();
    } finally {
      await handle.close().catch(() => undefined);
      try {
        const owner = JSON.parse(await readFile(path, 'utf8')) as { token?: unknown };
        if (owner.token === token) await unlink(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  }

  /** Serializes each CAS section across requester processes. */
  async mutate<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.mutationTail;
    let release!: () => void;
    this.mutationTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await this.withFileLock(this.sourceCasLockPath(), operation);
    } finally {
      release();
    }
  }

  /** One source-global publisher lease; product association files never grant sequence authority. */
  async withSourceLease<T>(operation: () => Promise<T>): Promise<T> {
    return this.withFileLock(this.sourceOwnerLockPath(), operation);
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

/**
 * The sealed Submission's `deadline` (issue #2526).
 *
 * Derived from the posting's own FINALIZED chain authority time rather than a local wall clock, for
 * two reasons. It is the same authority every other time-bearing field in this bundle is pinned to
 * (`authorityTime` is already validated as a canonical finalized Base Sepolia block above, and is
 * already sealed verbatim into the Submission's `authority-time` annotation). And it keeps sealing
 * DETERMINISTIC: the Submission's digest is its identity here — `draftKey` is built from it and a
 * retry of the same run must reproduce the same bytes — which a `Date.now()` reading would break.
 *
 * The lead itself is `DEFAULT_SUBMISSION_DEADLINE_LEAD_MS`, a named posting default; see its doc
 * for why it is deliberately not the posting terms' `responseTimeoutSeconds`. Note that a finalized
 * block lags the head by roughly two epochs, so the lead a solver actually observes at discovery is
 * this interval minus that lag — another reason the interval is generous rather than tight.
 */
function sealedDeadline(authorityTime: NativeAuthorityTimeAnchor): string {
  const anchored = Date.parse(authorityTime.timestamp);
  if (!Number.isFinite(anchored)) {
    throw new Error('native requester cannot derive a Submission deadline from a non-instant authority time');
  }
  const deadline = anchored + DEFAULT_SUBMISSION_DEADLINE_LEAD_MS;
  if (!Number.isSafeInteger(deadline)) {
    throw new Error('native requester Submission deadline exceeds JavaScript time bounds');
  }
  return new Date(deadline).toISOString();
}

async function sealRunBundle(input: {
  readonly runId: string;
  readonly requesterAgent: string;
  readonly admissionAgent: string;
  readonly roles: NativeRequesterRoles;
  readonly authorityTime: NativeAuthorityTimeAnchor;
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
  const receipt = {
    ...admitPredictionSnapshot({
    taskBytes,
    evaluationSpecBytes,
    issuer: input.admissionAgent,
    }),
    authorityTime: input.authorityTime,
  };
  const sealedReceipt = await sealPredictionSnapshotAdmissionReceipt(receipt, roleDsseSigner(admissionRole));
  const admissionReceiptBytes = sealedReceipt.envelopeBytes;
  await input.checkpoint?.('admission-receipt-sealed');

  const templateSubmission = bytesToObject(template.submission, 'B1 Submission template');
  const taskDigest = rawDigest(taskBytes);
  const deadline = sealedDeadline(input.authorityTime);
  const seed = runSeed(input.runId, taskDigest, sealedReceipt.receiptDigest);
  const annotations = {
    ...(templateSubmission.annotations as Record<string, unknown> ?? {}),
    'https://spec.jinn.network/annotations/admission-receipt/v1': {
      name: 'admission-receipt',
      mediaType: ADMISSION_RECEIPT_MEDIA_TYPE,
      digest: { sha256: sealedReceipt.receiptDigest.slice('sha256:'.length) },
    },
    'https://spec.jinn.network/annotations/native-requester-run/v1': { runId: input.runId },
    'https://spec.jinn.network/annotations/authority-time/v1': input.authorityTime,
  };
  const submissionBytes = sealSubmission({
    ...templateSubmission,
    submission: uuidFromHex(seed),
    requester: input.requesterAgent,
    idempotencyKey: `native-prediction-forecast:${input.runId}:${taskDigest.slice(7, 23)}`,
    nonce: seed.slice(0, 32),
    task: { digest: { sha256: taskDigest.slice('sha256:'.length) } },
    // Set at seal time like every other per-posting field above. Before issue #2526 `deadline` was
    // the one field NOT overridden here, so it fell through the spread from the pinned fixture as
    // the literal `2026-08-02T12:00:00Z` and every native posting shipped an already-past deadline.
    deadline,
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

function durableRequesterSigner(role: NativeRequesterIdentity): DurableSourceSigner {
  return {
    scope: DISCOVERY_SIGNING_SCOPE,
    keyId: role.keyId,
    sign: async (pae) => [{ keyid: role.keyId, sig: role.sign(pae) }],
    verify: (pae, signature) => cryptoVerify(null, pae, role.publicKey, signature),
  };
}

function decodeBase64(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, 'base64'));
}

function sourceMatches(left: SourceIdentity, right: SourceIdentity): boolean {
  return left.agent === right.agent && left.name === right.name;
}

async function assertRequesterEnvelope(input: {
  readonly envelope: unknown;
  readonly payloadType: string;
  readonly payload: Uint8Array;
  readonly signer: DurableSourceSigner;
  readonly label: string;
}): Promise<void> {
  const parsed = parseWireDsseEnvelope(input.envelope);
  if (parsed.envelope.payloadType !== input.payloadType || !exactBytes(parsed.payloadBytes, input.payload)) {
    throw new Error(`${input.label} does not carry the exact expected payload`);
  }
  const pae = dssePreAuthEncoding(input.payloadType, input.payload);
  let verified = false;
  for (const signature of parsed.signatures) {
    if (signature.keyid === input.signer.keyId
      && await input.signer.verify(pae, signature.signatureBytes)) verified = true;
  }
  if (!verified) {
    throw new Error(`${input.label} is not signed by the requester source identity`);
  }
}

interface ReconstructedRequesterHistory {
  readonly durable: DurableSourceState;
  readonly lastHead?: SourceHead;
  readonly lastTimestamp?: string;
}

async function reconstructRequesterHistory(input: {
  readonly records: ReturnType<typeof createFsBlobStore>;
  readonly source: SourceIdentity;
  readonly signer: DurableSourceSigner;
  readonly last?: {
    readonly sequence: string;
    readonly entryDigest: Digest;
    readonly page: string;
    readonly head?: SourceHead;
  };
  readonly skipHead?: boolean;
}): Promise<ReconstructedRequesterHistory> {
  if (input.last === undefined) {
    if (!input.skipHead && await input.records.get(headPath(input.source.name)) !== undefined) {
      throw new Error('requester source has a public head without committed requester-source state');
    }
    return {
      durable: {
        version: 1,
        source: input.source,
        signerKeyId: input.signer.keyId,
        last: null,
        announcements: {},
      },
    };
  }

  let previousPage: string | null = null;
  let previousEntry: Digest | null = null;
  let lastTimestamp: string | undefined;
  const announcements: Record<string, DurableSourceState['announcements'][string]> = {};
  for (let ordinal = 1n; ordinal <= BigInt(input.last.page); ordinal += 1n) {
    const pageName = formatSequence(ordinal);
    const stored = await input.records.get(archivePagePath(input.source.name, pageName));
    if (stored === undefined) throw new Error(`requester source archive page ${pageName} is missing`);
    const page = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(stored.bytes)) as ArchivePage;
    if (!exactBytes(sealJson(page).bytes, stored.bytes)
      || page.protocol !== RECORD_DISCOVERY_VERSION
      || page.source !== input.source.name
      || page.page !== pageName
      || page.prevArchive !== previousPage
      || page.entries.length !== 1) {
      throw new Error(`requester source archive page ${pageName} is not the exact owned chain page`);
    }
    const signed = page.entries[0]!;
    const entry = parseAnnouncementEntry(signed.entry);
    const entryBytes = sealJson(entry).bytes;
    const entryDigest = sealJson(entry).digest;
    if (entry.source.agent !== input.source.agent
      || entry.source.name !== input.source.name
      || entry.sequence !== pageName
      || entry.previous !== previousEntry
      || entry.announcements.length !== 1
      || signed.signature === undefined) {
      throw new Error(`requester source archive page ${pageName} breaks source continuity`);
    }
    await assertRequesterEnvelope({
      envelope: signed.signature,
      payloadType: MEDIA_ENTRY,
      payload: entryBytes,
      signer: input.signer,
      label: `requester source entry ${pageName}`,
    });
    const announcement = entry.announcements[0]!;
    lastTimestamp = entry.timestamp;
    if (announcement.action !== 'available') {
      throw new Error('requester source v1 history may contain only available announcements');
    }
    const record = await input.records.get(recordPath(announcement.record.digest));
    if (record === undefined
      || recordDigest(record.bytes) !== announcement.record.digest
      || (announcement.record.mediaType !== undefined && announcement.record.mediaType !== record.contentType)) {
      throw new Error(`requester source announcement ${announcement.announcementId} has no exact record`);
    }
    const fingerprint = sealJson({
      source: input.source,
      timestamp: entry.timestamp,
      announcement,
      recordContentType: record.contentType,
    }).digest;
    const receipt: DurableSourceReceipt = {
      source: input.source,
      announcementId: announcement.announcementId,
      fingerprint,
      sequence: entry.sequence,
      entryDigest,
      page: pageName,
      record: { digest: announcement.record.digest, path: recordPath(announcement.record.digest), contentType: record.contentType },
    };
    announcements[announcement.announcementId] = { action: 'available', fingerprint, receipt };
    previousPage = pageName;
    previousEntry = entryDigest;
  }
  if (previousPage !== input.last.page || previousEntry !== input.last.entryDigest) {
    throw new Error('requester-source state does not equal the authenticated archive tip');
  }
  if (input.skipHead) {
    return {
      durable: {
        version: 1,
        source: input.source,
        signerKeyId: input.signer.keyId,
        last: { sequence: input.last.sequence, entryDigest: input.last.entryDigest, page: input.last.page },
        announcements,
      },
      ...(input.last.head === undefined ? {} : { lastHead: input.last.head }),
      ...(lastTimestamp === undefined ? {} : { lastTimestamp }),
    };
  }
  const storedHead = await input.records.get(headPath(input.source.name));
  if (storedHead === undefined) throw new Error('requester source committed state has no public head');
  const parsedHeadEnvelope = parseWireDsseEnvelope(JSON.parse(new TextDecoder().decode(storedHead.bytes)));
  const head = parseSourceHead(JSON.parse(new TextDecoder().decode(parsedHeadEnvelope.payloadBytes)));
  if (!exactBytes(sealJson(head).bytes, parsedHeadEnvelope.payloadBytes)
    || (input.last.head !== undefined && !sameJson(head, input.last.head))
    || head.origin !== formatOrigin(input.source.agent, input.source.name)
    || head.sequence !== input.last.sequence
    || head.entry !== input.last.entryDigest) {
    throw new Error('requester source public head does not equal requester-source state');
  }
  await assertRequesterEnvelope({
    envelope: parsedHeadEnvelope.envelope,
    payloadType: MEDIA_HEAD,
    payload: parsedHeadEnvelope.payloadBytes,
    signer: input.signer,
    label: 'requester source head',
  });
  return {
    durable: {
      version: 1,
      source: input.source,
      signerKeyId: input.signer.keyId,
      last: { sequence: input.last.sequence, entryDigest: input.last.entryDigest, page: input.last.page },
      announcements,
    },
    lastHead: head,
    ...(lastTimestamp === undefined ? {} : { lastTimestamp }),
  };
}

function requesterBlobStore(records: ReturnType<typeof createFsBlobStore>): ReadableImmutableBlobStore {
  return records;
}

function sameDurableState(left: DurableSourceState, right: DurableSourceState): boolean {
  return sealJson(left).digest === sealJson(right).digest;
}

function assertDurableRequesterOwnership(
  value: DurableSourceState | DurableSourceAppendIntent,
  source: SourceIdentity,
  signer: DurableSourceSigner,
): void {
  if (!sourceMatches(value.source, source) || value.signerKeyId !== signer.keyId) {
    throw new Error('requester generic source state belongs to another source or signer');
  }
}

function publicationFromWriterIntent(intent: DurableSourceAppendIntent): PublicationIntent {
  const pageBytes = decodeBase64(intent.page.bytesBase64);
  const page = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(pageBytes)) as ArchivePage;
  const entry = page.entries[0]?.entry;
  if (page.entries.length !== 1 || entry === undefined
    || page.page !== intent.receipt.page
    || entry.announcements.length !== 1
    || entry.announcements[0]!.announcementId !== intent.announcementId) {
    throw new Error('requester generic append intent cannot be mirrored as a v1 publication');
  }
  const parsedHead = parseWireDsseEnvelope(JSON.parse(
    new TextDecoder('utf-8', { fatal: true }).decode(decodeBase64(intent.head.bytesBase64)),
  ));
  const head = parseSourceHead(JSON.parse(new TextDecoder().decode(parsedHead.payloadBytes)));
  return {
    state: 'pending',
    sequence: entry.sequence,
    page: page.page,
    entry,
    entryDigest: intent.receipt.entryDigest,
    head,
    announcementId: intent.announcementId,
    writerIntent: intent,
  };
}

function logicalSourceRevision(snapshot: CasSnapshot<SourceState> | undefined): string | null {
  if (snapshot === undefined) return null;
  return snapshot.value.pending === undefined
    ? snapshot.revision
    : snapshot.value.pending.intent.expectedStateRevision;
}

function createRequesterSourceStateStore(input: {
  readonly state: NativeRequesterState;
  readonly source: SourceIdentity;
  readonly signer: DurableSourceSigner;
}): SourceStateStore {
  return {
    async read() {
      const snapshot = await input.state.readSourceSnapshot();
      if (snapshot === undefined) return undefined;
      if (snapshot.value.version !== 1) throw new Error('unsupported requester-source state version');
      const reconstructed = await reconstructRequesterHistory({
        records: input.state.records,
        source: input.source,
        signer: input.signer,
        ...(snapshot.value.last === undefined ? {} : { last: snapshot.value.last }),
        skipHead: snapshot.value.pending !== undefined,
      });
      const revision = logicalSourceRevision(snapshot);
      if (revision === null) return undefined;
      return { revision, value: reconstructed.durable };
    },
    async compareAndSwap(_sourceId, expectedRevision, next): Promise<CasWriteResult> {
      assertDurableRequesterOwnership(next, input.source, input.signer);
      return input.state.mutate(async () => {
        const current = await input.state.readSourceSnapshot();
        if (logicalSourceRevision(current) !== expectedRevision) return { ok: false };
        const reconstructed = await reconstructRequesterHistory({
          records: input.state.records,
          source: input.source,
          signer: input.signer,
          ...(next.last === null ? {} : { last: next.last }),
        });
        if (!sameDurableState(reconstructed.durable, next) || reconstructed.lastHead === undefined) {
          throw new Error('requester generic next state does not equal the signed public source');
        }
        const legacy: SourceState = {
          version: 1,
          last: {
            sequence: next.last!.sequence,
            entryDigest: next.last!.entryDigest,
            page: next.last!.page,
            head: reconstructed.lastHead,
          },
          ...(current?.value.pending === undefined ? {} : { pending: current.value.pending }),
        };
        await input.state.writeSource(legacy);
        const written = await input.state.readSourceSnapshot();
        if (written === undefined) throw new Error('requester-source state disappeared after commit');
        return { ok: true, revision: logicalSourceRevision(written)! };
      });
    },
  };
}

async function legacyRequesterWriterIntent(input: {
  readonly state: NativeRequesterState;
  readonly source: SourceIdentity;
  readonly signer: DurableSourceSigner;
  readonly publication: PublicationIntent;
  readonly recordBytes: Uint8Array;
  readonly recordContentType: string;
}): Promise<DurableSourceAppendIntent> {
  const previousPosition = input.publication.entry.previous === null
    ? null
    : {
      sequence: formatSequence(BigInt(input.publication.sequence) - 1n),
      entryDigest: input.publication.entry.previous,
      page: formatSequence(BigInt(input.publication.page) - 1n),
    };
  const previous = await reconstructRequesterHistory({
    records: input.state.records,
    source: input.source,
    signer: input.signer,
    ...(previousPosition === null ? {} : { last: previousPosition }),
    skipHead: true,
  });
  const sourceSnapshot = await input.state.readSourceSnapshot();
  const currentHead = await input.state.records.get(headPath(input.source.name));
  return freezeRequesterSourceV1Intent({
    source: input.source,
    signer: input.signer,
    publication: input.publication,
    recordBytes: input.recordBytes,
    recordContentType: input.recordContentType,
    previousState: previous.durable,
    expectedStateRevision: logicalSourceRevision(sourceSnapshot),
    previousStateDigest: sourceSnapshot === undefined ? null : sealJson(previous.durable).digest,
    previousPosition,
    expectedHeadDigest: currentHead === undefined ? null : recordDigest(currentHead.bytes),
    previousHeadIssuedAt: previous.lastTimestamp ?? null,
  });
}

function createRequesterSourceIntentStore(input: {
  readonly state: NativeRequesterState;
  readonly associationKey: string;
  readonly source: SourceIdentity;
  readonly signer: DurableSourceSigner;
  readonly checkpoint?: NativeRequesterDeps['checkpoints'];
}): SourceAppendIntentStore {
  const store: SourceAppendIntentStore = {
    async read() {
      const sourceSnapshot = await input.state.readSourceSnapshot();
      if (sourceSnapshot?.value.pending !== undefined) {
        const pending = sourceSnapshot.value.pending;
        assertDurableRequesterOwnership(pending.intent, input.source, input.signer);
        return { revision: sourceSnapshot.revision, value: pending.intent };
      }
      const association = await input.state.readAssociationSnapshot(input.associationKey);
      if (association === undefined || association.value.publication.state === 'published') return undefined;
      const publication = association.value.publication;
      if (publication.sequence === '') return undefined;
      const record = await input.state.records.get(association.value.submission.path);
      if (record === undefined) throw new Error('requester source legacy intent record is missing');
      const intent = publication.writerIntent ?? await legacyRequesterWriterIntent({
          state: input.state,
          source: input.source,
          signer: input.signer,
          publication,
          recordBytes: record.bytes,
          recordContentType: record.contentType,
        });
      assertDurableRequesterOwnership(intent, input.source, input.signer);
      await store.compareAndSwap(formatOrigin(input.source.agent, input.source.name), null, intent);
      const migrated = await input.state.readSourceSnapshot();
      if (migrated?.value.pending === undefined) {
        throw new Error('requester source legacy intent could not acquire the source-global slot');
      }
      return { revision: migrated.revision, value: migrated.value.pending.intent };
    },
    async compareAndSwap(_sourceId, expectedRevision, next): Promise<CasWriteResult> {
      return input.state.mutate(async () => {
        const sourceSnapshot = await input.state.readSourceSnapshot();
        const currentRevision = sourceSnapshot?.value.pending === undefined ? null : sourceSnapshot.revision;
        if (currentRevision !== expectedRevision) return { ok: false };
        if (next === undefined) {
          const pending = sourceSnapshot?.value.pending;
          if (pending === undefined) return { ok: true, revision: `cleared:${expectedRevision ?? 'absent'}` };
          if (sourceSnapshot === undefined) throw new Error('requester source pending intent has no source state');
          const association = await input.state.readAssociationSnapshot(pending.associationKey);
          if (association === undefined) throw new Error('requester source pending association disappeared');
          const mirrored = association.value.publication.sequence === ''
            ? publicationFromWriterIntent(pending.intent)
            : association.value.publication;
          const { writerIntent: _committedIntent, ...legacyPublication } = mirrored;
          await input.state.writeAssociation(pending.associationKey, {
            ...association.value,
            publication: { ...legacyPublication, state: 'published' },
          });
          const committed: SourceState = {
            version: 1,
            ...(sourceSnapshot.value.last === undefined ? {} : { last: sourceSnapshot.value.last }),
          };
          await input.state.writeSource(committed);
        } else {
          assertDurableRequesterOwnership(next, input.source, input.signer);
          const association = await input.state.readAssociationSnapshot(input.associationKey);
          if (association === undefined || association.value.publication.state === 'published') {
            throw new Error('requester source association cannot claim a new source-global intent');
          }
          const pending: NonNullable<SourceState['pending']> = {
            version: 1,
            associationKey: input.associationKey,
            intent: next,
          };
          await input.state.writeSource({
            version: 1,
            ...(sourceSnapshot?.value.last === undefined ? {} : { last: sourceSnapshot.value.last }),
            pending,
          });
          await input.state.writeAssociation(input.associationKey, {
            ...association.value,
            publication: publicationFromWriterIntent(next),
          });
          await input.checkpoint?.('source-intent-durable');
        }
        const written = await input.state.readSourceSnapshot();
        return { ok: true, revision: written?.revision ?? `cleared:${expectedRevision ?? 'absent'}` };
      });
    },
  };
  return store;
}

async function sourceFacts(
  state: NativeRequesterState,
  submission: Uint8Array,
  association: Pick<NativeRequesterAssociation,
    | 'chainId'
    | 'coordinator'
    | 'creator'
    | 'taskId'
    | 'taskDigest'
    | 'submissionUri'
    | 'nonce'
    | 'postingTerms'
    | 'intendedSpendWei'
    | 'requesterEnvelopeDigest'
    | 'admissionReceiptDigest'
    | 'txHash'
    | 'authorityTime'>,
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
      creator: association.creator,
      taskId: association.taskId.toString(10),
      taskDigest: association.taskDigest,
      submission: association.submissionUri,
      nonce: association.nonce,
      postingTerms: association.postingTerms,
      intendedSpendWei: association.intendedSpendWei,
      admissionReceiptDigest: association.admissionReceiptDigest,
      requesterEnvelopeDigest: association.requesterEnvelopeDigest,
      txHash: association.txHash,
      authorityTime: association.authorityTime,
      sealedAt: association.authorityTime.timestamp,
      runId,
    },
  };
}

async function appendRequesterSource(input: {
  readonly state: NativeRequesterState;
  readonly source: SourceIdentity;
  readonly role: NativeRequesterIdentity;
  readonly publicBaseUrl: string;
  readonly now: () => Date;
  readonly association: NativeRequesterAssociation;
  readonly runId: string;
  readonly checkpoint?: NativeRequesterDeps['checkpoints'];
}): Promise<NativeRequesterAssociation> {
  return input.state.withSourceLease(async () => {
  async function writeDiscoveryIndex(): Promise<void> {
    const committed = await input.state.readSource();
    const page = committed.last?.page ?? formatSequence(1n);
    await writeWellKnownDocument(input.state.records, {
      protocol: RECORD_DISCOVERY_VERSION,
      sources: [{
        agent: input.source.agent,
        name: input.source.name,
        headPath: headPath(input.source.name),
        archiveRoot: archivePagePath(input.source.name, page),
      }],
    });
  }
  if (input.association.publication.state === 'published') {
    await writeDiscoveryIndex();
    return input.association;
  }
  const key = associationKey(input.association);
  const submissionRecord = await input.state.records.get(input.association.submission.path);
  if (submissionRecord === undefined) throw new Error('requester source exact Submission record is missing');
  const signer = durableRequesterSigner(input.role);
  const writer = createDurableSourceWriter({
    source: input.source,
    signer,
    blobs: requesterBlobStore(input.state.records),
    states: createRequesterSourceStateStore({
      state: input.state,
      source: input.source,
      signer,
    }),
    intents: createRequesterSourceIntentStore({
      state: input.state,
      associationKey: key,
      source: input.source,
      signer,
      ...(input.checkpoint === undefined ? {} : { checkpoint: input.checkpoint }),
    }),
  });
  await writer.recover();
  const currentAssociation = await input.state.readAssociation(key);
  if (currentAssociation === undefined) throw new Error('requester source association disappeared before append');
  if (currentAssociation.publication.state === 'published') {
    await writeDiscoveryIndex();
    return currentAssociation;
  }
  const publication = currentAssociation.publication;
  const committed = await input.state.readSource();
  const requestedTimestamp = input.now().getTime();
  const previousTimestamp = committed.last === undefined ? Number.NEGATIVE_INFINITY : new Date(committed.last.head.issuedAt).getTime();
  const timestamp = new Date(Math.max(requestedTimestamp, previousTimestamp + 1)).toISOString();
  const command = publication.sequence === ''
    ? {
      announcement: {
        announcementId: `native-requester-${input.association.chainId}-${input.association.taskId.toString(10)}-${input.association.taskDigest.slice(7, 23)}`,
        action: 'available' as const,
        record: {
          kind: RECORD_KINDS.submission,
          digest: input.association.submissionDigest,
          mediaType: SUBMISSION_MEDIA_TYPE,
        },
        locations: location(input.publicBaseUrl, input.association.submission.path),
        facts: await sourceFacts(
          input.state,
          submissionRecord.bytes,
          currentAssociation,
          input.runId,
        ),
      },
      timestamp,
      record: { bytes: submissionRecord.bytes, contentType: submissionRecord.contentType },
    }
    : adaptRequesterSourceV1Publication({
      source: input.source,
      publication,
      recordBytes: submissionRecord.bytes,
      recordContentType: submissionRecord.contentType,
    });
  await writer.append(command);
  await writeDiscoveryIndex();
  const association = await input.state.readAssociation(key);
  if (association === undefined || association.publication.state !== 'published') {
    throw new Error('requester durable source writer did not complete the existing association intent');
  }
  return association;
  });
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
  /** Reconciles every durable posting/outbox before the native host admits new work. */
  reconcile(): Promise<void>;
  request(input: NativeRequesterRequest): Promise<NativeRequesterResult>;
  handleDiscoveryRequest(request: Request): Promise<Response>;
  /**
   * The signed source identity this requester publishes under, and therefore the identity a host
   * must introduce when it mounts {@link handleDiscoveryRequest}. Exposed for #2519: the fleet
   * daemon's serving plane composes several archives behind one listener and needs each handler's
   * identity to merge the well-known introduction, and re-deriving `name` at the mount site would
   * be a second copy of a literal that lives here.
   */
  readonly source: SourceIdentity;
  /**
   * Read-only enumeration of this operator's own posted tasks (the durable canonical associations).
   * The one-swap M5f adoption leg reads these to observe + adopt deliveries for tasks THIS requester
   * posted; it opens no new store — it reads the same durable association directory `request` writes.
   */
  postedAssociations(): Promise<readonly NativeRequesterAssociation[]>;
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
        || !sameJson(existing.authorityTime, draft.authorityTime)
        || !sameJson(existing.postingTerms, draft.postingTerms)
        || existing.intendedSpendWei !== draft.intendedSpendWei
      ) throw new Error('canonical TaskCreated is already associated with a different exact Submission graph');
      return appendRequesterSource({
        state,
        source,
        role: roles.get('requester-discovery'),
        publicBaseUrl: deps.publicBaseUrl,
        now: deps.now,
        association: existing,
        runId: draft.runId,
        ...(deps.checkpoints === undefined ? {} : { checkpoint: deps.checkpoints }),
      });
    }
    const association: NativeRequesterAssociation = {
      version: 1,
      chainId: canonical.chainId,
      coordinator: canonical.coordinator,
      creator: canonical.creator,
      taskId: canonical.taskId,
      taskDigest: canonical.taskDigest,
      submissionDigest: draft.submissionDigest,
      requesterEnvelopeDigest: draft.requesterEnvelopeDigest,
      admissionReceiptDigest: draft.artifacts.admissionReceipt.digest,
      submissionUri: draft.submissionUri,
      nonce: draft.nonce,
      postingTerms: draft.postingTerms,
      intendedSpendWei: draft.intendedSpendWei,
      authorityTime: draft.authorityTime,
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
      now: deps.now,
      association,
      runId: draft.runId,
      ...(deps.checkpoints === undefined ? {} : { checkpoint: deps.checkpoints }),
    });
    await deps.checkpoints?.('source-announced');
    return published;
  }

  async function reconcile(chain: MarketplaceChainConfig, roles: NativeRequesterRoles): Promise<void> {
    const drafts = await state.allDrafts();
    for (const draft of drafts) {
      let current = draft;
      if (current.version === 1 && current.stage === 'broadcasting' && current.outcome === undefined) {
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
          throw new Error(
            `native requester has a legacy broadcast-uncertain operation for runId ${current.runId}; `
            + 'TaskCreated does not prove the Submission, so explicit operator reconciliation is required',
          );
        }
        current = { ...current, stage: 'broadcasted', outcome: asStoredOutcome(recovered) };
        await state.updateDraft(current);
      }
      if (current.outcome === undefined) {
        const [taskBytes, evaluationSpecBytes, admissionReceiptBytes, submissionBytes, requesterEnvelopeBytes] = await Promise.all([
          readExactRecord(state, current.artifacts.task),
          readExactRecord(state, current.artifacts.evaluationSpec),
          readExactRecord(state, current.artifacts.admissionReceipt),
          readExactRecord(state, current.artifacts.submission),
          readExactRecord(state, current.artifacts.requesterEnvelope),
        ]);
        if (
          taskBytes === undefined || evaluationSpecBytes === undefined || admissionReceiptBytes === undefined
          || submissionBytes === undefined || requesterEnvelopeBytes === undefined
        ) throw new Error(`native requester draft ${current.runId} lost an exact product artifact`);
        const outcome = await deps.posting.post({
          taskBytes,
          evaluationSpecBytes,
          admissionReceiptBytes,
          submissionBytes,
          requesterEnvelopeBytes,
          chain,
          creatorSafe: current.creatorSafe,
          terms: postingTermsFromWire(current.postingTerms),
        });
        current = current.version === 1
          ? { ...current, stage: 'broadcasted', outcome: asStoredOutcome(outcome) }
          : { ...current, outcome: asStoredOutcome(outcome) };
        await state.updateDraft(current);
      }
      if (current.outcome !== undefined) await canonicalAssociation(current, chain, roles);
    }
  }

  return {
    async reconcile(): Promise<void> {
      const chain = assertBaseSepoliaTarget('base-sepolia', await deps.readChain());
      assertPostingRecoverySafe(await deps.posting.recoverPosting(), { allowRetryable: true });
      const roles = await deps.loadRoles();
      await reconcile(chain, roles);
      assertPostingRecoverySafe(await deps.posting.recoverPosting(), { allowRetryable: false });
    },
    async request(input): Promise<NativeRequesterResult> {
      assertRunId(input.runId);
      if (input.fixture !== FIXTURE) throw new Error(`native requester fixture must be ${FIXTURE}`);
      // This assertion is intentionally before role load, template signing, or post construction.
      const chain = assertBaseSepoliaTarget(input.network, await deps.readChain());
      // Complete the reusable requester-scope/WAL recovery pass before loading product keys or
      // sealing a new Submission. Uncertain/conflicting scopes are never bypassed by product state.
      assertPostingRecoverySafe(await deps.posting.recoverPosting(), { allowRetryable: true });
      const authorityTime = await deps.authorityTime();
      if (authorityTime.chainId !== 84532
        || authorityTime.finalized !== true
        || !/^(?:0|[1-9][0-9]*)$/u.test(authorityTime.blockNumber)
        || !/^0x[0-9a-fA-F]{64}$/u.test(authorityTime.blockHash)
        || !Number.isFinite(Date.parse(authorityTime.timestamp))) {
        throw new Error('native requester authority time is not a canonical finalized Base Sepolia block');
      }
      const configuredPostingTerms = postingTermsWire(deps.posting.terms);
      const configuredIntendedSpend = intendedSpendWire(deps.posting.terms);
      const roles = await deps.loadRoles();
      // Resolve every prior broadcast before producing a new Submission. In particular, a retry
      // of the same run must return its durable canonical association rather than re-seal a
      // receipt with a newly loaded key and accidentally mint another Submission identity.
      await reconcile(chain, roles);
      // A retryable no-intent scope may have been completed by the matching durable local draft.
      // Any unresolved scope after that pass blocks admission of an unrelated new bundle.
      assertPostingRecoverySafe(await deps.posting.recoverPosting(), { allowRetryable: false });
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
        admissionAgent: deps.admissionAgent,
        roles,
        authorityTime,
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
        version: 2,
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
        authorityTime,
        artifacts,
      };
      let durable = await state.putDraft(draft);
      await deps.checkpoints?.('draft-durable');
      if (durable.outcome !== undefined) {
        const association = await canonicalAssociation(durable, chain, roles);
        if (association === undefined) throw new Error('native requester lost its durable canonical association');
        return { association, reused: true };
      }
      await deps.checkpoints?.('before-broadcast');
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
      durable = durable.version === 1
        ? { ...durable, stage: 'broadcasted', outcome: asStoredOutcome(outcome) }
        : { ...durable, outcome: asStoredOutcome(outcome) };
      await state.updateDraft(durable);
      await deps.checkpoints?.('after-broadcast');
      const association = await canonicalAssociation(durable, chain, roles);
      if (association === undefined) throw new Error('native requester could not persist its canonical association');
      return { association, reused: false };
    },
    handleDiscoveryRequest: handler,
    source,
    async postedAssociations(): Promise<readonly NativeRequesterAssociation[]> {
      return state.allAssociations();
    },
  };
}
