/**
 * Harness-layer publish path (plan Task 4, issue #1311).
 *
 * `publish(pending)` performs the consent conversion (calling publish after
 * preview IS the consent action), projects the scrubbed pending capture into
 * a canonical EpisodeV1 artifact, and wraps it in the same signed
 * `jinn.execution.v1` envelope the daemon capture path publishes (reusing
 * `buildUnsignedCaptureEnvelope`), and anchors it via ERC-8004. Publishing
 * through that wrapper is what makes the returned ref resolvable with
 * `jinn-layer corpus get <ref>` — the corpus reads signed envelopes, so the
 * contribute → anchored → discoverable round trip closes.
 *
 * No-bypass: only a `PendingEnvelope` produced by `capture()` (which ran the
 * mandatory scrub, fail-closed) can be published — enforced by the parameter
 * type and a runtime kind gate. There is no code path from raw spans to
 * `publish()`.
 *
 * Per-task veto: `opts.veto` publishes nothing and records a ledger entry
 * marked `vetoed (local only)` — the operator's receipt that the trace
 * existed and was withheld.
 *
 * v0 anchors directly per publish (testnet); the batch relayer is v0.5 work
 * alongside earning.
 */

import type {
  CaptureEnvelopeAnchorInput,
  CaptureEnvelopeAnchorResult,
  CapturePublishedBlob,
} from '../../../src/captures/publish.js';
import { buildUnsignedCaptureEnvelope, sha256Hex } from '../../../src/captures/publish.js';
import type { PendingCaptureRow } from '../../../src/store/captures.js';
import type { Artifact, SignedEnvelope, UnsignedEnvelope } from '../../../src/types/envelope.js';
import { SignedEnvelopeSchema } from '../../../src/types/envelope.js';
import {
  SKILL_ARTIFACT_TYPE,
  SkillArtifactV1Schema,
  type SkillArtifactV1,
} from '../../../src/types/skill-artifact.js';
import { canonicalJson } from '../../../src/harnesses/engine/canonical-json.js';
import { signCanonical } from '../../../src/harnesses/engine/signing.js';
import { EMPTY_BUNDLE_SHA256 } from '../../../src/trajectory/schema.js';
import {
  EPISODE_SCHEMA_VERSION,
  EpisodeV1WriteSchema,
  hasRetrievalMark,
  type EpisodeV1Write,
} from '@jinn-network/plugin';
import {
  buildManifestMetadataKey,
  encodeManifestPayload,
  hashLeaf,
  MANIFEST_SCHEMA_VERSION,
  merkleRoot,
  parseManifestV0,
  type ManifestV0,
  type ManifestPayload,
} from '@jinn-network/core';
import { PENDING_ENVELOPE_KIND, type PendingEnvelope } from './capture.js';
import { parseTraceEnvelopeV0, type TraceEnvelopeV0 } from './envelope.js';
import {
  assertRawSha256CidMatches,
  MAX_RAW_IPFS_BLOCK_BYTES,
} from './ipfs-cid.js';
import type { LedgerStore } from './ledger.js';

/** Read-compat only: no new capture publication emits this payload. */
export const TRACE_ENVELOPE_ARTIFACT_TYPE = 'jinn.trace-envelope.v0' as const;
/** Canonical local/public evidence payload emitted by new publications. */
export const EPISODE_ARTIFACT_TYPE = EPISODE_SCHEMA_VERSION;

const DONATION_ARTIFACT_ENCODING = 'jinn.artifact.donation.v1' as const;
const DEFAULT_PRICE_USDC = '0';

export interface HarnessPublishDeps {
  participant: { safeAddress: `0x${string}`; agentEoa: `0x${string}` };
  signer: { address: `0x${string}`; privateKey?: `0x${string}` };
  clientGitSha: string;
  /** Upload an evidence or companion payload as an artifact blob. */
  publishArtifact: (input: {
    artifactType: string;
    payload: unknown;
  }) => Promise<CapturePublishedBlob>;
  /** Upload the signed wrapper envelope; its CID is the corpus ref. */
  publishEnvelope: (envelope: SignedEnvelope) => Promise<CapturePublishedBlob>;
  /** Anchor the envelope on-chain (ERC-8004). */
  anchorEnvelope: (input: CaptureEnvelopeAnchorInput) => Promise<CaptureEnvelopeAnchorResult>;
  /** Custom signer (e.g. remote key); default signs with signer.privateKey. */
  signEnvelope?: (unsigned: UnsignedEnvelope) => Promise<SignedEnvelope['signature']>;
  /** The contribution ledger every publish/veto is recorded in. */
  ledger: LedgerStore;
  /** Access endpoint recorded on the artifact when the blob has none. */
  defaultArtifactEndpoint?: string;
  now?: () => Date;
}

export interface ManifestAnchorResult {
  txHash: `0x${string}`;
  blockNumber: number | null;
  gasUsed: bigint | null;
  feeWei: bigint | null;
}

export type ManifestAnchorReconciliation =
  | ({ status: 'confirmed' } & ManifestAnchorResult)
  | { status: 'reverted'; txHash: `0x${string}` }
  | { status: 'pending'; txHash: `0x${string}` };

export interface ManifestBatchJournalStore {
  loadManifestBatchJournal(batchKey: string): string | null;
  saveManifestBatchJournal(batchKey: string, stateJson: string): void;
}

export interface ManifestAnchorRecord {
  manifestCid: string;
  contentKind: 'manifest';
  metadataKey: string;
  payloadHex: `0x${string}`;
  txHash: `0x${string}`;
  blockNumber: number | null;
  gasUsed: bigint | null;
  feeWei: bigint | null;
  anchoredAt: number;
}

export interface PerRecordControlAnchorRecord {
  envelopeRef: string;
  contentKind: 'capture';
  metadataKey: string;
  payloadHex: `0x${string}`;
  txHash: `0x${string}`;
  blockNumber: number | null;
  gasUsed: bigint;
  feeWei: bigint;
  anchoredAt: number;
}

export interface ManifestBatchPublishDeps extends HarnessPublishDeps {
  publishManifestBody(body: ManifestV0): Promise<CapturePublishedBlob>;
  anchorManifest(input: {
    manifestCid: string;
    payload: ManifestPayload;
    onBroadcast?: (txHash: `0x${string}`) => void;
  }): Promise<ManifestAnchorResult>;
  /** Durable live-only recovery journal. */
  manifestJournal?: ManifestBatchJournalStore;
  /** Read-only reconciliation for a previously journaled transaction. */
  reconcileAnchor?(
    txHash: `0x${string}`,
  ): Promise<ManifestAnchorReconciliation>;
  recordManifestAnchor(input: ManifestAnchorRecord): void;
  /** Required only by the explicit paired gas-measurement control. */
  recordControlAnchor?(input: PerRecordControlAnchorRecord): void;
  /**
   * Test seam for exercising partition behavior with small fixtures. Values
   * above Kubo's real raw-block ceiling are clamped to the production limit.
   */
  maxManifestBodyBytes?: number;
  log?: (line: string) => void;
}

export interface ManifestBatchMemberInput {
  pending: PendingEnvelope;
  polarity?: 'pass' | 'fail';
  instanceId?: string;
  /** Immutable upstream identity used to key durable recovery. */
  sourceId?: string;
}

export interface ManifestBatchOptions {
  batchKind: string;
  /** Add one receipt-bound per-record control tx for the first uploaded member. */
  measurePerRecordControl?: boolean;
}

export interface PublishedMemberEnvelope {
  envelopeRef: string;
  sha256: string;
  envelope: SignedEnvelope;
  episode: EpisodeV1Write;
}

export interface ManifestBatchResult {
  manifestCid: string;
  anchorTx: `0x${string}`;
  memberRefs: string[];
  root: `0x${string}`;
  gasUsed: bigint | null;
  feeWei: bigint | null;
  control?: {
    memberRef: string;
    anchorTx: `0x${string}`;
    blockNumber: number | null;
    gasUsed: bigint | null;
    feeWei: bigint | null;
  };
}

export interface ManifestBatchSetResult {
  /** One entry per raw-block-sized manifest, in member order. */
  batches: ManifestBatchResult[];
  /** Every uploaded member ref, including refs in a later failed partition. */
  memberRefs: string[];
  /** Exact frozen member envelopes, including journal-resumed publications. */
  publishedMembers: PublishedMemberEnvelope[];
}

export interface PublishOptions {
  /** Per-task veto: record locally, publish nothing. */
  veto?: boolean;
  /**
   * First-class skill artifact (#1394): validated against
   * SkillArtifactV1Schema and published as a second artifact on the SAME
   * wrapper envelope, alongside (never instead of) the canonical episode.
   */
  skill?: SkillArtifactV1;
}

export interface PublishedResult {
  vetoed: false;
  envelopeRef: string;
  anchorTx: `0x${string}` | null;
}

export type PublishResult = PublishedResult | { vetoed: true };

/**
 * The irreversible publish/anchor succeeded, but the local contribution
 * ledger receipt could not be appended. Ordinary callers receive a failure;
 * recovery-aware seed callers may persist `result` before stopping.
 */
export class PublishLedgerError extends Error {
  override readonly name = 'PublishLedgerError';

  constructor(
    readonly result: PublishedResult,
    readonly ledgerError: unknown,
  ) {
    const detail = ledgerError instanceof Error ? ledgerError.message : String(ledgerError);
    super(
      `anchored ${result.envelopeRef}${result.anchorTx ? ` at ${result.anchorTx}` : ''}, ` +
        `but local ledger append failed: ${detail}`,
    );
  }
}

export class ManifestBatchRecordingError extends Error {
  override readonly name = 'ManifestBatchRecordingError';

  constructor(
    readonly result: ManifestBatchResult,
    readonly recordingError: unknown,
  ) {
    const detail =
      recordingError instanceof Error ? recordingError.message : String(recordingError);
    super(
      `manifest ${result.manifestCid} anchored at ${result.anchorTx}, ` +
        `but local recording failed: ${detail}`,
    );
  }
}

/**
 * A partitioned manifest publish failed. Retain both any completed irreversible
 * anchors and every uploaded member ref so the caller can reconcile without
 * retrying successful work.
 */
export class ManifestBatchSetError extends Error {
  override readonly name = 'ManifestBatchSetError';

  constructor(
    readonly completed: ManifestBatchResult[],
    readonly failed: unknown,
    readonly memberRefs: string[],
  ) {
    const detail = failed instanceof Error ? failed.message : String(failed);
    super(
      `manifest partition failed after ${completed.length} completed partition(s): ${detail}`,
    );
  }
}

export class ManifestBatchPreparationError extends Error {
  override readonly name = 'ManifestBatchPreparationError';

  constructor(
    readonly stage: 'member-upload' | 'partition',
    readonly memberRefs: string[],
    readonly preparationError: unknown,
    readonly batchKey: string | null,
  ) {
    const detail =
      preparationError instanceof Error
        ? preparationError.message
        : String(preparationError);
    super(
      `manifest ${stage} failed after ${memberRefs.length} member upload(s): ${detail}`,
    );
  }
}

/**
 * The manifest body is already content-addressed and the transaction was
 * broadcast, but the anchor could not be confirmed successful. Keep both
 * identifiers so an operator can reconcile before retrying.
 */
export class ManifestBatchAnchorError extends Error {
  override readonly name = 'ManifestBatchAnchorError';
  readonly txHash: `0x${string}` | null;

  constructor(
    readonly manifestCid: string,
    readonly memberRefs: string[],
    readonly root: `0x${string}`,
    readonly anchorError: unknown,
  ) {
    const candidate = (anchorError as { txHash?: unknown } | null)?.txHash;
    const txHash =
      typeof candidate === 'string' && /^0x[0-9a-fA-F]{64}$/.test(candidate)
        ? candidate as `0x${string}`
        : null;
    const detail =
      anchorError instanceof Error ? anchorError.message : String(anchorError);
    super(
      `manifest ${manifestCid} anchor confirmation failed` +
        `${txHash ? ` for ${txHash}` : ''}: ${detail}`,
    );
    this.txHash = txHash;
  }
}

function assertPending(pending: PendingEnvelope): void {
  if (
    pending === null ||
    typeof pending !== 'object' ||
    (pending as { kind?: unknown }).kind !== PENDING_ENVELOPE_KIND
  ) {
    throw new TypeError(
      'publish() accepts only a PendingEnvelope produced by capture() — raw traces cannot be published (no-bypass, spec §5)',
    );
  }
}

/**
 * Consent conversion: the pre-consent draft becomes a full TraceEnvelopeV0
 * with both consent flags literal `true`. Valid only for capture()-produced
 * pending envelopes (runtime kind gate) and re-validated against the frozen
 * schema on the way out.
 */
export function toTraceEnvelope(pending: PendingEnvelope): TraceEnvelopeV0 {
  assertPending(pending);
  return parseTraceEnvelopeV0({
    ...pending.draft,
    consent: { contributionConsent: true, scrubCompleted: true },
  });
}

function publishedStepKind(
  step: TraceEnvelopeV0['steps'][number],
  declaredKind: EpisodeV1Write['trajectory'][number]['kind'] | undefined,
): EpisodeV1Write['trajectory'][number]['kind'] {
  if (declaredKind) return declaredKind;
  const role = step.attributes['role'];
  return role === 'user' || role === 'assistant' || step.name.startsWith('turn:')
    ? 'jinn.agent_turn'
    : 'jinn.tool_call';
}

/**
 * Project the scrubbed pending capture into the same canonical contract the
 * local evidence store uses. Consent remains the publish action and is not a
 * second payload field; trace-envelope.v0 remains available only to legacy
 * readers.
 */
export function toPublishedEpisode(pending: PendingEnvelope): EpisodeV1Write {
  const trace = toTraceEnvelope(pending);
  return EpisodeV1WriteSchema.parse({
    schemaVersion: EPISODE_SCHEMA_VERSION,
    episodeId: trace.session.sessionId,
    retrievalVisible: hasRetrievalMark(trace.task.distributionTags),
    session: {
      ...trace.session,
      kind: pending.episodeFacts.session.kind ?? 'user',
      ...(pending.episodeFacts.session.parentSessionId
        ? { parentSessionId: pending.episodeFacts.session.parentSessionId }
        : {}),
    },
    origin: {
      writer: trace.environment.harness.name,
      build: trace.environment.harness.version,
    },
    task: {
      ...trace.task,
      ...pending.episodeFacts.task,
    },
    trajectory: trace.steps.map((step, index) => ({
      spanId: step.spanId,
      parentSpanId: step.parentSpanId,
      kind: publishedStepKind(step, pending.episodeFacts.trajectoryKinds[index]),
      name: step.name,
      startTimeUnixNano: step.startTimeUnixNano,
      endTimeUnixNano: step.endTimeUnixNano,
      attributes: step.attributes,
      redactedKeys: step.redactedKeys,
      ...(step.truncatedKeys ? { truncatedKeys: step.truncatedKeys } : {}),
    })),
    environment: {
      ...trace.environment,
      ...pending.episodeFacts.environment,
      skillsLoadout: pending.episodeFacts.environment.skillsLoadout ?? [],
    },
    outcome: {
      status: trace.outcome.status,
      verificationStrength: trace.outcome.verifiabilityTier,
      ...(trace.outcome.summary ? { summary: trace.outcome.summary } : {}),
    },
    cost: trace.cost,
    retention: { policy: 'contribution-eligible' },
    provenance: trace.provenance,
    ...(pending.episodeFacts.attemptGroup
      ? { attemptGroup: pending.episodeFacts.attemptGroup }
      : {}),
  });
}

/**
 * Synthesise the capture row `buildUnsignedCaptureEnvelope` reads. The
 * harness layer has no CapturesStore — the pending envelope carries all the
 * session facts. capturePath 'A' = native harness instrumentation (the
 * four-path ingest taxonomy in spec/2026-05-07-telemetry-collector §4.2).
 */
function toCaptureRow(envelope: EpisodeV1Write): PendingCaptureRow {
  return {
    sessionId: envelope.session.sessionId,
    capturedAt: envelope.session.capturedAt,
    originatingTool: {
      name: envelope.environment.harness.name,
      version: envelope.environment.harness.version,
    },
    capturePath: 'A',
    status: 'pending',
    spanCount: envelope.trajectory.length,
    redactedSpanCount: envelope.trajectory.filter(
      (s) => s.redactedKeys.length > 0 || (s.truncatedKeys?.length ?? 0) > 0,
    ).length,
    durationMs: envelope.cost.durationMs,
  };
}

/**
 * Upload one payload as an artifact blob and build its wrapper-envelope
 * Artifact entry (shared by the trace and the optional skill artifact).
 */
async function publishAsArtifact(
  deps: HarnessPublishDeps,
  artifactType: string,
  payload: unknown,
  metadata: Artifact['metadata'],
): Promise<Artifact> {
  const blob = await deps.publishArtifact({ artifactType, payload });
  const sha256 = blob.sha256 ?? sha256Hex(canonicalJson(payload));
  const endpoint = blob.endpoint ?? deps.defaultArtifactEndpoint;
  if (!endpoint) {
    throw new Error(`published ${artifactType} artifact ${blob.cid} has no access endpoint (set defaultArtifactEndpoint)`);
  }
  return {
    artifactType,
    sha256,
    metadata,
    access: { endpoint, priceUsdc: blob.priceUsdc ?? DEFAULT_PRICE_USDC },
    sources: [{ kind: 'ipfs', cid: blob.cid, sha256, encoding: DONATION_ARTIFACT_ENCODING }],
  };
}

/**
 * Consent, upload, and sign one pending member without anchoring or writing the
 * contribution ledger. Both the per-record and manifest paths share this exact
 * byte-producing step so batch mode cannot drift into a second envelope format.
 */
export async function publishMemberEnvelope(
  pending: PendingEnvelope,
  deps: HarnessPublishDeps,
  opts: Pick<PublishOptions, 'skill'> & { now?: Date } = {},
): Promise<PublishedMemberEnvelope> {
  assertPending(pending);
  const now = opts.now ?? deps.now?.() ?? new Date();
  const episode = toPublishedEpisode(pending);
  const skill = opts.skill === undefined ? undefined : SkillArtifactV1Schema.parse(opts.skill);

  const artifacts: Artifact[] = [
    await publishAsArtifact(deps, EPISODE_ARTIFACT_TYPE, episode, {
      description: 'Layer-1 canonical evidence episode (scrubbed)',
      tags: episode.task.distributionTags,
    }),
  ];
  if (skill) {
    artifacts.push(
      await publishAsArtifact(deps, SKILL_ARTIFACT_TYPE, skill, {
        description: `Skill: ${skill.skill.name}`,
        tags: episode.task.distributionTags,
      }),
    );
  }

  const unsigned = buildUnsignedCaptureEnvelope({
    capture: toCaptureRow(episode),
    now,
    participant: deps.participant,
    signerAddress: deps.signer.address,
    clientGitSha: deps.clientGitSha,
    artifacts,
    harnessBundleSha: EMPTY_BUNDLE_SHA256,
  });
  const signature = deps.signEnvelope
    ? await deps.signEnvelope(unsigned)
    : await signWithPrivateKey(unsigned, deps);
  const envelope = SignedEnvelopeSchema.parse({ ...unsigned, signature });

  const envelopeBlob = await deps.publishEnvelope(envelope);
  const envelopeRef = envelopeBlob.cid;
  const sha256 = envelopeBlob.sha256 ?? sha256Hex(canonicalJson(envelope));
  return { envelopeRef, sha256, envelope, episode };
}

/**
 * Publish a pending envelope: consent conversion → artifact upload → signed
 * wrapper envelope → ERC-8004 anchor → ledger entry. Returns the corpus ref
 * (the wrapper envelope's CID) and the anchor tx.
 */
export async function publish(
  pending: PendingEnvelope,
  deps: HarnessPublishDeps,
  opts: PublishOptions = {},
): Promise<PublishResult> {
  assertPending(pending);
  const now = deps.now?.() ?? new Date();

  if (opts.veto) {
    deps.ledger.append({
      ts: now.toISOString(),
      taskSummary: pending.draft.task.summary,
      envelopeRef: null,
      anchorTx: null,
      verifiabilityTier: pending.draft.outcome.verifiabilityTier,
      status: 'vetoed (local only)',
    });
    return { vetoed: true };
  }

  const member = await publishMemberEnvelope(pending, deps, {
    ...(opts.skill === undefined ? {} : { skill: opts.skill }),
    now,
  });
  const { envelopeRef, envelope, episode } = member;
  const anchor = await deps.anchorEnvelope({
    metadataKey: `capture:${envelopeRef}`,
    envelopeCid: envelopeRef,
    envelopeHash: envelope.signature.hash as `0x${string}`,
    envelope,
  });
  const anchorTx = anchor.txHash ?? null;
  const result: PublishedResult = { vetoed: false, envelopeRef, anchorTx };

  try {
    deps.ledger.append({
      ts: now.toISOString(),
      taskSummary: episode.task.summary,
      envelopeRef,
      anchorTx,
      verifiabilityTier: episode.outcome.verificationStrength,
      status: 'published',
    });
  } catch (err) {
    throw new PublishLedgerError(result, err);
  }

  return result;
}

type PreparedManifestMember = PublishedMemberEnvelope & ManifestBatchMemberInput;

interface JournalMemberInput {
  pending: PendingEnvelope;
  polarity?: 'pass' | 'fail';
  instanceId?: string;
  sourceId: string;
}

interface JournalTransaction {
  status: 'broadcast' | 'confirmed';
  txHash: `0x${string}`;
  blockNumber?: number | null;
  gasUsed?: string | null;
  feeWei?: string | null;
  payloadHex?: `0x${string}`;
}

interface JournalPartition {
  body: ManifestV0;
  manifestCid: string | null;
  transaction: JournalTransaction | null;
  anchorRecorded: boolean;
  controlTransaction?: JournalTransaction | null;
  controlPayloadHex?: `0x${string}`;
  controlRecorded?: boolean;
}

interface ManifestBatchJournalState {
  version: 1;
  batchKey: string;
  batchKind: string;
  sourceIds: string[];
  nowIso: string;
  maxBodyBytes: number;
  measurePerRecordControl: boolean;
  members: JournalMemberInput[];
  published: PreparedManifestMember[];
  partitions: JournalPartition[] | null;
}

interface ActiveManifestJournal {
  batchKey: string | null;
  state: ManifestBatchJournalState;
  save(): void;
}

function safeJournalMember(member: ManifestBatchMemberInput): JournalMemberInput {
  return {
    pending: {
      kind: member.pending.kind,
      draft: member.pending.draft,
      // Redaction `before` values are display-only secrets and must never be
      // persisted. The draft is already scrubbed and is all publication needs.
      redactions: [],
    },
    ...(member.polarity === undefined ? {} : { polarity: member.polarity }),
    ...(member.instanceId === undefined ? {} : { instanceId: member.instanceId }),
    sourceId: member.sourceId!,
  };
}

function manifestBatchKey(batchKind: string, sourceIds: string[]): string {
  return sha256Hex(
    canonicalJson({
      schemaVersion: 'jinn.manifest-batch-recovery.v1',
      batchKind,
      sourceIds,
    }),
  );
}

function parseJournalState(raw: string): ManifestBatchJournalState {
  const parsed = JSON.parse(raw) as Partial<ManifestBatchJournalState>;
  if (
    parsed.version !== 1 ||
    typeof parsed.batchKey !== 'string' ||
    typeof parsed.batchKind !== 'string' ||
    !Array.isArray(parsed.sourceIds) ||
    !parsed.sourceIds.every((value) => typeof value === 'string') ||
    typeof parsed.nowIso !== 'string' ||
    !Number.isInteger(parsed.maxBodyBytes) ||
    typeof parsed.measurePerRecordControl !== 'boolean' ||
    !Array.isArray(parsed.members) ||
    !Array.isArray(parsed.published) ||
    (parsed.partitions !== null && !Array.isArray(parsed.partitions))
  ) {
    throw new Error('manifest journal conflict: invalid persisted state');
  }
  return parsed as ManifestBatchJournalState;
}

function openManifestJournal(
  members: ManifestBatchMemberInput[],
  deps: ManifestBatchPublishDeps,
  opts: ManifestBatchOptions,
  now: Date,
  maxBodyBytes: number,
): ActiveManifestJournal {
  const journal = deps.manifestJournal;
  if (!journal) {
    const sourceIds = members.map((member, index) => member.sourceId ?? `ephemeral:${index}`);
    return {
      batchKey: null,
      state: {
        version: 1,
        batchKey: '',
        batchKind: opts.batchKind,
        sourceIds,
        nowIso: now.toISOString(),
        maxBodyBytes,
        measurePerRecordControl: Boolean(opts.measurePerRecordControl),
        members: members.map((member, index) =>
          safeJournalMember({ ...member, sourceId: sourceIds[index]! })),
        published: [],
        partitions: null,
      },
      save: () => undefined,
    };
  }

  if (
    members.some(
      (member) =>
        typeof member.sourceId !== 'string' || member.sourceId.length === 0,
    )
  ) {
    throw new Error(
      'durable manifest recovery requires a non-empty immutable sourceId for every member',
    );
  }
  const sourceIds = members.map((member) => member.sourceId!);
  const batchKey = manifestBatchKey(opts.batchKind, sourceIds);
  const persisted = journal.loadManifestBatchJournal(batchKey);
  const state = persisted === null
    ? {
        version: 1 as const,
        batchKey,
        batchKind: opts.batchKind,
        sourceIds,
        nowIso: now.toISOString(),
        maxBodyBytes,
        measurePerRecordControl: Boolean(opts.measurePerRecordControl),
        members: members.map(safeJournalMember),
        published: [],
        partitions: null,
      }
    : parseJournalState(persisted);
  if (
    state.batchKey !== batchKey ||
    state.batchKind !== opts.batchKind ||
    canonicalJson(state.sourceIds) !== canonicalJson(sourceIds) ||
    state.maxBodyBytes !== maxBodyBytes ||
    state.measurePerRecordControl !== Boolean(opts.measurePerRecordControl)
  ) {
    throw new Error('manifest journal conflict: invocation does not match frozen plan');
  }
  const active = {
    batchKey,
    state,
    save: () =>
      journal.saveManifestBatchJournal(batchKey, JSON.stringify(state)),
  };
  if (persisted === null) active.save();
  return active;
}

function manifestMember(member: PreparedManifestMember) {
  return {
    cid: member.envelopeRef,
    sha256: member.sha256,
    ...(member.polarity === undefined ? {} : { polarity: member.polarity }),
    ...(member.instanceId === undefined ? {} : { instanceId: member.instanceId }),
  };
}

function buildManifestBody(
  published: PreparedManifestMember[],
  batchKind: string,
  createdAt: number,
): ManifestV0 {
  const root = merkleRoot(
    published.map((member) => hashLeaf(member.envelopeRef)),
  );
  return parseManifestV0({
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    batchKind,
    createdAt,
    merkleRoot: root,
    members: published.map(manifestMember),
  });
}

function manifestBodyByteLength(
  published: PreparedManifestMember[],
  batchKind: string,
  createdAt: number,
): number {
  // The real root is always the same 0x + 64-character width as this
  // placeholder, so this is the exact canonical byte length without
  // rebuilding an O(n log n) tree for every partition probe.
  return new TextEncoder().encode(
    canonicalJson({
      schemaVersion: MANIFEST_SCHEMA_VERSION,
      batchKind,
      createdAt,
      merkleRoot: `0x${'0'.repeat(64)}`,
      members: published.map(manifestMember),
    }),
  ).byteLength;
}

function partitionManifestMembers(
  published: PreparedManifestMember[],
  batchKind: string,
  createdAt: number,
  maxBodyBytes: number,
): PreparedManifestMember[][] {
  const partitions: PreparedManifestMember[][] = [];
  let current: PreparedManifestMember[] = [];
  for (const member of published) {
    const candidate = [...current, member];
    if (
      manifestBodyByteLength(candidate, batchKind, createdAt) <= maxBodyBytes
    ) {
      current = candidate;
      continue;
    }
    if (current.length === 0) {
      throw new Error(
        `manifest member ${member.envelopeRef} cannot fit in one ${maxBodyBytes}-byte raw IPFS block`,
      );
    }
    partitions.push(current);
    current = [member];
    if (manifestBodyByteLength(current, batchKind, createdAt) > maxBodyBytes) {
      throw new Error(
        `manifest member ${member.envelopeRef} cannot fit in one ${maxBodyBytes}-byte raw IPFS block`,
      );
    }
  }
  if (current.length > 0) partitions.push(current);
  return partitions;
}

async function publishPreparedManifest(
  published: PreparedManifestMember[],
  deps: ManifestBatchPublishDeps,
  args: {
    batchKind: string;
    createdAt: number;
    now: Date;
    measurePerRecordControl: boolean;
    maxBodyBytes: number;
    partition?: JournalPartition;
    journal?: ActiveManifestJournal;
  },
): Promise<ManifestBatchResult> {
  const body = buildManifestBody(published, args.batchKind, args.createdAt);
  const bodyBytes = new TextEncoder().encode(canonicalJson(body));
  if (bodyBytes.byteLength > args.maxBodyBytes) {
    throw new Error(
      `manifest body is ${bodyBytes.byteLength} bytes, exceeding the ${args.maxBodyBytes}-byte raw IPFS block limit`,
    );
  }
  const partition = args.partition ?? {
    body,
    manifestCid: null,
    transaction: null,
    anchorRecorded: false,
  };
  if (canonicalJson(partition.body) !== canonicalJson(body)) {
    throw new Error('manifest journal conflict: frozen partition plan changed');
  }
  const saveJournal = (): void => args.journal?.save();
  if (partition.manifestCid === null) {
    const manifestBlob = await deps.publishManifestBody(body);
    assertRawSha256CidMatches(manifestBlob.cid, bodyBytes);
    partition.manifestCid = manifestBlob.cid;
    saveJournal();
  } else {
    assertRawSha256CidMatches(partition.manifestCid, bodyBytes);
  }
  const manifestCid = partition.manifestCid;
  const root = body.merkleRoot as `0x${string}`;
  const payload: ManifestPayload = {
    version: 0,
    merkleRoot: root,
    memberCount: published.length,
    createdAt: args.createdAt,
  };

  const reconcile = async (
    transaction: JournalTransaction,
  ): Promise<ManifestAnchorResult | null> => {
    if (transaction.status === 'confirmed') {
      return {
        txHash: transaction.txHash,
        blockNumber: transaction.blockNumber ?? null,
        gasUsed:
          transaction.gasUsed === null || transaction.gasUsed === undefined
            ? null
            : BigInt(transaction.gasUsed),
        feeWei:
          transaction.feeWei === null || transaction.feeWei === undefined
            ? null
            : BigInt(transaction.feeWei),
      };
    }
    if (!deps.reconcileAnchor) {
      throw Object.assign(
        new Error(`manifest transaction ${transaction.txHash} is unconfirmed; reconciliation is unavailable`),
        { txHash: transaction.txHash },
      );
    }
    const reconciled = await deps.reconcileAnchor(transaction.txHash);
    if (reconciled.status === 'pending') {
      throw Object.assign(
        new Error(`manifest transaction ${transaction.txHash} is pending; reconcile before retrying`),
        { txHash: transaction.txHash },
      );
    }
    if (reconciled.status === 'reverted') return null;
    return reconciled;
  };

  let anchor: ManifestAnchorResult | null = null;
  if (partition.transaction !== null) {
    try {
      anchor = await reconcile(partition.transaction);
    } catch (error) {
      throw new ManifestBatchAnchorError(
        manifestCid,
        published.map((member) => member.envelopeRef),
        root,
        error,
      );
    }
    if (anchor === null) {
      partition.transaction = null;
      saveJournal();
    } else if (partition.transaction.status !== 'confirmed') {
      partition.transaction = {
        status: 'confirmed',
        txHash: anchor.txHash,
        blockNumber: anchor.blockNumber,
        gasUsed: anchor.gasUsed?.toString() ?? null,
        feeWei: anchor.feeWei?.toString() ?? null,
      };
      saveJournal();
    }
  }
  if (anchor === null) {
    try {
      anchor = await deps.anchorManifest({
        manifestCid,
        payload,
        onBroadcast: (txHash) => {
          partition.transaction = { status: 'broadcast', txHash };
          saveJournal();
        },
      });
    } catch (error) {
      throw new ManifestBatchAnchorError(
        manifestCid,
        published.map((member) => member.envelopeRef),
        root,
        error,
      );
    }
    partition.transaction = {
      status: 'confirmed',
      txHash: anchor.txHash,
      blockNumber: anchor.blockNumber,
      gasUsed: anchor.gasUsed?.toString() ?? null,
      feeWei: anchor.feeWei?.toString() ?? null,
    };
    saveJournal();
  }
  const result: ManifestBatchResult = {
    manifestCid,
    anchorTx: anchor.txHash,
    memberRefs: published.map((member) => member.envelopeRef),
    root,
    gasUsed: anchor.gasUsed,
    feeWei: anchor.feeWei,
  };

  try {
    if (!partition.anchorRecorded) {
      deps.recordManifestAnchor({
        manifestCid,
        contentKind: 'manifest',
        metadataKey: buildManifestMetadataKey(manifestCid),
        payloadHex: encodeManifestPayload(payload),
        txHash: anchor.txHash,
        blockNumber: anchor.blockNumber,
        gasUsed: anchor.gasUsed,
        feeWei: anchor.feeWei,
        anchoredAt: args.createdAt,
      });
      partition.anchorRecorded = true;
      saveJournal();
    }
    if (args.measurePerRecordControl) {
      const controlMember = published[0]!;
      const metadataKey = `capture:${controlMember.envelopeRef}`;
      let controlAnchor: ManifestAnchorResult | null =
        partition.controlTransaction
          ? await reconcile(partition.controlTransaction)
          : null;
      let controlPayloadHex =
        partition.controlPayloadHex ?? partition.controlTransaction?.payloadHex;
      if (controlAnchor === null && partition.controlTransaction) {
        partition.controlTransaction = null;
        saveJournal();
      }
      if (controlAnchor === null) {
        const publishedControl = await deps.anchorEnvelope({
          metadataKey,
          envelopeCid: controlMember.envelopeRef,
          envelopeHash: controlMember.envelope.signature.hash as `0x${string}`,
          envelope: controlMember.envelope,
          requireSuccessfulReceipt: true,
          onPrepared: (payloadHex) => {
            partition.controlPayloadHex = payloadHex;
            controlPayloadHex = payloadHex;
            saveJournal();
          },
          onBroadcast: (txHash) => {
            partition.controlTransaction = { status: 'broadcast', txHash };
            saveJournal();
          },
        });
        if (!publishedControl.txHash) {
          throw new Error('per-record control anchor returned no transaction hash');
        }
        controlAnchor = {
          txHash: publishedControl.txHash,
          blockNumber: publishedControl.blockNumber ?? null,
          gasUsed: publishedControl.gasUsed ?? null,
          feeWei: publishedControl.feeWei ?? null,
        };
        partition.controlTransaction = {
          status: 'confirmed',
          txHash: controlAnchor.txHash,
          blockNumber: controlAnchor.blockNumber,
          gasUsed: controlAnchor.gasUsed?.toString() ?? null,
          feeWei: controlAnchor.feeWei?.toString() ?? null,
          ...(publishedControl.payloadHex
            ? { payloadHex: publishedControl.payloadHex }
            : {}),
        };
        controlPayloadHex = publishedControl.payloadHex;
        saveJournal();
      }
      result.control = {
        memberRef: controlMember.envelopeRef,
        anchorTx: controlAnchor.txHash,
        blockNumber: controlAnchor.blockNumber ?? null,
        gasUsed: controlAnchor.gasUsed ?? null,
        feeWei: controlAnchor.feeWei ?? null,
      };
      if (result.control.gasUsed === null || result.control.feeWei === null) {
        throw new Error(
          `per-record control receipt telemetry unavailable for ${controlAnchor.txHash}`,
        );
      }
      if (!controlPayloadHex) {
        throw new Error(
          `per-record control payload unavailable for ${controlAnchor.txHash}`,
        );
      }
      if (!partition.controlRecorded) {
        deps.recordControlAnchor!({
          envelopeRef: controlMember.envelopeRef,
          contentKind: 'capture',
          metadataKey,
          payloadHex: controlPayloadHex,
          txHash: controlAnchor.txHash,
          blockNumber: result.control.blockNumber,
          gasUsed: result.control.gasUsed,
          feeWei: result.control.feeWei,
          anchoredAt: args.createdAt,
        });
        partition.controlRecorded = true;
        saveJournal();
      }
    }
    for (const member of published) {
      const ledgerEntry = {
        ts: args.now.toISOString(),
        taskSummary: member.episode.task.summary,
        envelopeRef: member.envelopeRef,
        anchorTx: anchor.txHash,
        verifiabilityTier: member.episode.outcome.verificationStrength,
        status: 'published',
      } as const;
      const alreadyRecorded = deps.ledger.list().some(
        (entry) =>
          entry.status === 'published' &&
          entry.envelopeRef === ledgerEntry.envelopeRef &&
          entry.anchorTx === ledgerEntry.anchorTx,
      );
      if (!alreadyRecorded) deps.ledger.append(ledgerEntry);
    }
  } catch (error) {
    throw new ManifestBatchRecordingError(result, error);
  }

  deps.log?.(
    `[manifest] batch anchored cid=${manifestCid} members=${published.length} ` +
      `gasUsed=${anchor.gasUsed?.toString() ?? 'null'} ` +
      `feeWei=${anchor.feeWei?.toString() ?? 'null'}`,
  );
  if (result.control) {
    deps.log?.(
      `[manifest] per-record control anchored cid=${result.control.memberRef} ` +
        `tx=${result.control.anchorTx} gasUsed=${result.control.gasUsed?.toString() ?? 'null'} ` +
        `feeWei=${result.control.feeWei?.toString() ?? 'null'}`,
    );
  }
  return result;
}

/**
 * Upload substrate members once, partition their manifest bodies at Kubo's
 * raw-block boundary, and anchor exactly once per resulting manifest.
 */
export async function publishManifestBatch(
  members: ManifestBatchMemberInput[],
  deps: ManifestBatchPublishDeps,
  opts: ManifestBatchOptions,
): Promise<ManifestBatchSetResult> {
  if (members.length === 0) {
    throw new Error('publishManifestBatch requires at least one member');
  }
  if (typeof opts.batchKind !== 'string' || opts.batchKind.length === 0) {
    throw new Error('publishManifestBatch requires a non-empty batchKind');
  }
  if (opts.measurePerRecordControl && !deps.recordControlAnchor) {
    throw new Error(
      'per-record measurement control requires recordControlAnchor persistence',
    );
  }
  const requestedMax = deps.maxManifestBodyBytes ?? MAX_RAW_IPFS_BLOCK_BYTES;
  if (!Number.isInteger(requestedMax) || requestedMax < 1) {
    throw new Error('maxManifestBodyBytes must be a positive integer');
  }
  const maxBodyBytes = Math.min(requestedMax, MAX_RAW_IPFS_BLOCK_BYTES);
  const requestedNow = deps.now?.() ?? new Date();
  const journal = openManifestJournal(
    members,
    deps,
    opts,
    requestedNow,
    maxBodyBytes,
  );
  const now = new Date(journal.state.nowIso);
  if (Number.isNaN(now.getTime())) {
    throw new Error('manifest journal conflict: invalid frozen publication time');
  }
  const createdAt = Math.floor(now.getTime() / 1000);
  const published = journal.state.published;
  try {
    for (
      let index = published.length;
      index < journal.state.members.length;
      index += 1
    ) {
      const member = journal.state.members[index]!;
      const uploaded = await publishMemberEnvelope(member.pending, deps, { now });
      published.push({ ...member, ...uploaded });
      journal.save();
    }
  } catch (error) {
    throw new ManifestBatchPreparationError(
      'member-upload',
      published.map((member) => member.envelopeRef),
      error,
      journal.batchKey,
    );
  }
  let partitions: PreparedManifestMember[][];
  try {
    partitions = partitionManifestMembers(
      published,
      opts.batchKind,
      createdAt,
      maxBodyBytes,
    );
  } catch (error) {
    throw new ManifestBatchPreparationError(
      'partition',
      published.map((member) => member.envelopeRef),
      error,
      journal.batchKey,
    );
  }
  const frozenBodies = partitions.map((partition) =>
    buildManifestBody(partition, opts.batchKind, createdAt));
  if (journal.state.partitions === null) {
    journal.state.partitions = frozenBodies.map((body) => ({
      body,
      manifestCid: null,
      transaction: null,
      anchorRecorded: false,
    }));
    journal.save();
  } else if (
    journal.state.partitions.length !== frozenBodies.length ||
    journal.state.partitions.some(
      (partition, index) =>
        canonicalJson(partition.body) !== canonicalJson(frozenBodies[index]!),
    )
  ) {
    throw new Error('manifest journal conflict: frozen partition plan changed');
  }
  const batches: ManifestBatchResult[] = [];
  try {
    for (let index = 0; index < partitions.length; index += 1) {
      batches.push(
        await publishPreparedManifest(partitions[index]!, deps, {
          batchKind: opts.batchKind,
          createdAt,
          now,
          measurePerRecordControl:
            Boolean(opts.measurePerRecordControl) && index === 0,
          maxBodyBytes,
          partition: journal.state.partitions[index]!,
          journal,
        }),
      );
    }
  } catch (error) {
    if (batches.length > 0 || partitions.length > 1) {
      throw new ManifestBatchSetError(
        batches,
        error,
        published.map((member) => member.envelopeRef),
      );
    }
    throw error;
  }
  return {
    batches,
    memberRefs: published.map((member) => member.envelopeRef),
    publishedMembers: published.map(
      ({ envelopeRef, sha256, envelope, trace }) => ({
        envelopeRef,
        sha256,
        envelope,
        trace,
      }),
    ),
  };
}

async function signWithPrivateKey(
  unsigned: UnsignedEnvelope,
  deps: HarnessPublishDeps,
): Promise<SignedEnvelope['signature']> {
  if (!deps.signer.privateKey) {
    throw new Error('publish() requires signer.privateKey or a signEnvelope dependency');
  }
  const signed = await signCanonical(unsigned, deps.signer.privateKey, deps.signer.address);
  return { algo: 'secp256k1', signer: signed.signer, hash: signed.hash, sig: signed.sig };
}
