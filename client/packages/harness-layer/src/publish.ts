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
import { PENDING_ENVELOPE_KIND, type PendingEnvelope } from './capture.js';
import { parseTraceEnvelopeV0, type TraceEnvelopeV0 } from './envelope.js';
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
