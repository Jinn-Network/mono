import { createHash } from 'node:crypto';
import type { Artifact, ArtifactSource, SignedEnvelope, UnsignedEnvelope } from '../types/envelope.js';
import { SignedEnvelopeSchema, UnsignedEnvelopeSchema } from '../types/envelope.js';
import type { SessionProvenance } from '../types/session-provenance.js';
import type { CapturesStore, PendingCaptureRow, SpanRow } from '../store/captures.js';
import { canonicalJson } from '../harnesses/engine/canonical-json.js';
import { signCanonical } from '../harnesses/engine/signing.js';
import { EMPTY_BUNDLE_SHA256 } from '../trajectory/schema.js';
import {
  HARNESS_BUNDLE_ARTIFACT_TYPE,
  HarnessBundleManifestSchema,
  type HarnessBundleManifest,
} from '../trajectory/harness-bundle-schema.js';
import type { ScrubPipeline } from '../trajectory/scrub/pipeline.js';
import { buildScrubPipeline } from '../trajectory/scrub/build.js';
import { scrubCaptureSpans } from '../trajectory/scrub/emit-scrub.js';

const ZERO_MEASUREMENT = `0x${'0'.repeat(64)}` as const;
const DEFAULT_PRICE_USDC = '0';
const DONATION_ARTIFACT_ENCODING = 'jinn.artifact.donation.v1' as const;
const CAPTURE_TRACE_ARTIFACT_TYPE = 'jinn.capture-trajectory.v1' as const;

export interface CapturePublishedBlob {
  cid: string;
  sha256?: string;
  endpoint?: string;
  priceUsdc?: string;
}

export interface PublishCaptureArtifactInput {
  sessionId: string;
  artifactType: string;
  payload: unknown;
  metadata?: Artifact['metadata'];
}

export interface CaptureHarnessBundle {
  manifest: HarnessBundleManifest;
  payload?: unknown;
  cid?: string;
  endpoint?: string;
  priceUsdc?: string;
}

export interface CapturePublishDeps {
  captures: CapturesStore;
  participant: { safeAddress: `0x${string}`; agentEoa: `0x${string}` };
  signer: { address: `0x${string}`; privateKey?: `0x${string}` };
  clientGitSha: string;
  publishArtifact: (input: PublishCaptureArtifactInput) => Promise<CapturePublishedBlob>;
  publishEnvelope: (envelope: SignedEnvelope) => Promise<CapturePublishedBlob>;
  anchorEnvelope: (input: CaptureEnvelopeAnchorInput) => Promise<CaptureEnvelopeAnchorResult>;
  signEnvelope?: (unsigned: UnsignedEnvelope) => Promise<SignedEnvelope['signature']>;
  resolveHarnessBundle?: (capture: PendingCaptureRow) => Promise<CaptureHarnessBundle | null> | CaptureHarnessBundle | null;
  now?: () => Date;
  defaultArtifactEndpoint?: string;
  defaultPriceUsdc?: string;
  executor?: Partial<UnsignedEnvelope['executor']>;
  /**
   * Seller-side scrub pipeline (secretlint + openredaction + optional ML PII).
   * Every capture span's attributes are scrubbed through it before the trajectory
   * is uploaded. The daemon wires the shared configured pipeline in main.ts. When
   * absent this defaults to `buildScrubPipeline()` (the non-ML safety floor), so a
   * missing wire scrubs rather than leaks — symmetric with the task engine
   * (`harnesses/engine/engine.ts`). To publish raw, opt out *explicitly* by
   * passing an empty `new ScrubPipeline([])`.
   */
  scrubPipeline?: ScrubPipeline;
}

export interface CaptureEnvelopeAnchorInput {
  metadataKey: string;
  envelopeCid: string;
  envelopeHash: `0x${string}`;
  envelope: SignedEnvelope;
  /** Measurement controls require a mined successful receipt, not best effort. */
  requireSuccessfulReceipt?: boolean;
  /** Persist an irreversible broadcast before receipt confirmation begins. */
  onBroadcast?: (txHash: `0x${string}`) => void;
  /** Persist the deterministic payload before its transaction is sent. */
  onPrepared?: (payloadHex: `0x${string}`) => void;
}

export interface CaptureEnvelopeAnchorResult {
  txHash?: `0x${string}`;
  blockNumber?: number | null;
  gasUsed?: bigint | null;
  feeWei?: bigint | null;
  /** Exact ABI payload written on chain, for durable control-row recording. */
  payloadHex?: `0x${string}`;
}

export interface PublishCaptureResult {
  capture: PendingCaptureRow;
  envelope: SignedEnvelope;
  envelopeCid: string;
  envelopeSha256: string;
  envelopeHash: `0x${string}`;
  trajectory: {
    cid: string;
    sha256: string;
    endpoint: string;
    priceUsdc: string;
    sources: ArtifactSource[];
  };
  artifacts: Artifact[];
  anchor: CaptureEnvelopeAnchorResult;
}

export async function publishCaptureEnvelope(
  sessionId: string,
  deps: CapturePublishDeps,
): Promise<PublishCaptureResult> {
  const capture = deps.captures.getBySession(sessionId);
  if (!capture) throw new Error(`capture not found: ${sessionId}`);
  if (capture.status !== 'pending') {
    throw new Error(`capture ${sessionId} is not pending (status=${capture.status})`);
  }

  const spans = deps.captures.getSpansBySession(sessionId);
  const now = deps.now?.() ?? new Date();
  // Default to the non-ML safety floor when no pipeline is injected, mirroring
  // the task engine (engine.ts) — a missing wire must scrub, not leak.
  const scrubPipeline = deps.scrubPipeline ?? buildScrubPipeline();
  const trajectoryPayload = await buildCaptureTrajectoryPayload(capture, spans, now, scrubPipeline);
  const trajectoryBlob = await deps.publishArtifact({
    sessionId,
    artifactType: CAPTURE_TRACE_ARTIFACT_TYPE,
    payload: trajectoryPayload,
    metadata: { description: 'Redacted local-session capture trajectory' },
  });
  const trajectory = blobToAccess(trajectoryBlob, deps);

  const harnessBundle = await deps.resolveHarnessBundle?.(capture) ?? null;
  const artifacts: Artifact[] = [trajectoryToArtifact(trajectory)];
  let harnessBundleSha = EMPTY_BUNDLE_SHA256;
  if (harnessBundle) {
    const manifest = HarnessBundleManifestSchema.parse(harnessBundle.manifest);
    harnessBundleSha = manifest.bundleSha256;
    const published = harnessBundle.cid
      ? {
          cid: harnessBundle.cid,
          sha256: manifest.bundleSha256,
          endpoint: harnessBundle.endpoint,
          priceUsdc: harnessBundle.priceUsdc,
        }
      : await deps.publishArtifact({
          sessionId,
          artifactType: HARNESS_BUNDLE_ARTIFACT_TYPE,
          payload: harnessBundle.payload ?? manifest,
          metadata: { description: 'Operator-approved harness configuration bundle' },
        });
    const access = blobToAccess({ ...published, sha256: published.sha256 ?? manifest.bundleSha256 }, deps);
    artifacts.push({
      artifactType: HARNESS_BUNDLE_ARTIFACT_TYPE,
      sha256: manifest.bundleSha256,
      metadata: { description: 'Operator-approved harness configuration bundle' },
      access: { endpoint: access.endpoint, priceUsdc: access.priceUsdc },
      sources: [{
        kind: 'ipfs',
        cid: access.cid,
        sha256: manifest.bundleSha256,
        encoding: 'jinn.artifact.donation.v1',
      }],
    });
  }

  const unsigned = buildUnsignedCaptureEnvelope({
    capture,
    now,
    participant: deps.participant,
    signerAddress: deps.signer.address,
    clientGitSha: deps.clientGitSha,
    artifacts,
    harnessBundleSha,
    executorOverrides: deps.executor,
  });
  const parsedUnsigned = UnsignedEnvelopeSchema.parse(unsigned);
  const signature = deps.signEnvelope
    ? await deps.signEnvelope(parsedUnsigned)
    : await signUnsignedCaptureEnvelope(parsedUnsigned, deps);
  const envelope = SignedEnvelopeSchema.parse({ ...parsedUnsigned, signature });
  const envelopeBlob = await deps.publishEnvelope(envelope);
  const envelopeCid = envelopeBlob.cid;
  const envelopeSha256 = envelopeBlob.sha256 ?? sha256Hex(canonicalJson(envelope));
  const envelopeHash = envelope.signature.hash as `0x${string}`;
  const anchor = await deps.anchorEnvelope({
    metadataKey: `capture:${envelopeCid}`,
    envelopeCid,
    envelopeHash,
    envelope,
  });

  return {
    capture,
    envelope,
    envelopeCid,
    envelopeSha256,
    envelopeHash,
    trajectory,
    artifacts,
    anchor,
  };
}

interface BuildUnsignedCaptureEnvelopeArgs {
  capture: PendingCaptureRow;
  now: Date;
  participant: CapturePublishDeps['participant'];
  signerAddress: `0x${string}`;
  clientGitSha: string;
  artifacts: Artifact[];
  harnessBundleSha: string;
  executorOverrides?: Partial<UnsignedEnvelope['executor']>;
  /** Discriminator override (default 'capture'). Layer-2 skills pass 'distilled-skill'. */
  solverType?: string;
  /** Role override (default 'capture'). `role` is a closed enum; skills stay 'capture'. */
  role?: UnsignedEnvelope['role'];
}

export function buildUnsignedCaptureEnvelope(args: BuildUnsignedCaptureEnvelopeArgs): UnsignedEnvelope {
  const { capture, now, participant, signerAddress, artifacts, harnessBundleSha } = args;
  const sessionProvenance: SessionProvenance = {
    sessionId: capture.sessionId,
    capturedAt: capture.capturedAt,
    originatingTool: capture.originatingTool,
    ...(capture.repoRemoteUrl || capture.repoCommitHash
      ? {
          repo: {
            ...(capture.repoRemoteUrl ? { remoteUrl: capture.repoRemoteUrl } : {}),
            ...(capture.repoCommitHash ? { commitHash: capture.repoCommitHash } : {}),
          },
        }
      : {}),
    license: { operatorAssertion: 'unspecified' },
  };
  const windowEnd = Math.floor(now.getTime() / 1000);
  const runtimeBundleDigest = `sha256:${sha256Hex(canonicalJson({
    tool: capture.originatingTool,
    capturePath: capture.capturePath,
  }))}`;
  const executor: UnsignedEnvelope['executor'] = {
    implName: capture.originatingTool.name,
    implVersion: capture.originatingTool.version ?? 'unknown',
    clientGitSha: args.clientGitSha,
    codeDigest: `sha256:${harnessBundleSha}`,
    runtimeBundleDigest,
    plugins: [],
    signingKey: { kind: 'agent-eoa', pubkey: signerAddress },
    mode: 'train',
    ...args.executorOverrides,
  };

  return UnsignedEnvelopeSchema.parse({
    schemaVersion: 'jinn.execution.v1',
    solverType: args.solverType ?? 'capture',
    role: args.role ?? 'capture',
    generatedAt: windowEnd,
    sessionProvenance,
    participant,
    window: { startTs: Math.max(0, windowEnd - Math.ceil(capture.durationMs / 1000)), endTs: windowEnd },
    executor,
    evidenceTier: 'self-signed',
    attestation: null,
    trajectory: null,
    artifacts,
    payload: {
      capture: {
        sessionId: capture.sessionId,
        capturePath: capture.capturePath,
        spanCount: capture.spanCount,
        redactedSpanCount: capture.redactedSpanCount,
        durationMs: capture.durationMs,
      },
    },
  });
}

async function buildCaptureTrajectoryPayload(
  capture: PendingCaptureRow,
  spans: SpanRow[],
  now: Date,
  scrubPipeline: ScrubPipeline,
): Promise<Record<string, unknown>> {
  // Seller-side scrub: captures are stored raw at ingest, so the publish path is
  // the last gate before a trajectory becomes public/sellable. Scrubbing here
  // both sanitises the span attributes and grows each span's redactedKeys, which
  // the manifest below is derived from.
  const perClassCounts: Record<string, number> = {};
  const scrubbed = await scrubCaptureSpans(spans, scrubPipeline, { perClassCounts });
  const unsigned = {
    schemaVersion: CAPTURE_TRACE_ARTIFACT_TYPE,
    sessionId: capture.sessionId,
    capturedAt: capture.capturedAt,
    exportedAt: now.toISOString(),
    spans: scrubbed,
    redactionManifest: {
      spans: scrubbed.map((span) => ({ spanId: span.spanId, redactedKeys: span.redactedKeys })),
      totalRedactions: scrubbed.reduce((sum, span) => sum + span.redactedKeys.length, 0),
      ...scrubPipeline.manifestProvenance(perClassCounts),
    },
  };
  return unsigned;
}

async function signUnsignedCaptureEnvelope(
  unsigned: UnsignedEnvelope,
  deps: CapturePublishDeps,
): Promise<SignedEnvelope['signature']> {
  if (!deps.signer.privateKey) {
    throw new Error('publishCaptureEnvelope requires signer.privateKey or signEnvelope dependency');
  }
  const signed = await signCanonical(unsigned, deps.signer.privateKey, deps.signer.address);
  return {
    algo: 'secp256k1',
    signer: signed.signer,
    hash: signed.hash,
    sig: signed.sig,
  };
}

function blobToAccess(blob: CapturePublishedBlob, deps: Pick<
  CapturePublishDeps,
  'defaultArtifactEndpoint' | 'defaultPriceUsdc'
>): { cid: string; sha256: string; endpoint: string; priceUsdc: string; sources: ArtifactSource[] } {
  const endpoint = blob.endpoint ?? deps.defaultArtifactEndpoint;
  if (!endpoint) {
    throw new Error(`published artifact ${blob.cid} did not provide an access endpoint`);
  }
  if (!blob.sha256) {
    throw new Error(`published artifact ${blob.cid} did not provide a sha256`);
  }
  return {
    cid: blob.cid,
    sha256: blob.sha256,
    endpoint,
    priceUsdc: blob.priceUsdc ?? deps.defaultPriceUsdc ?? DEFAULT_PRICE_USDC,
    sources: [{
      kind: 'ipfs',
      cid: blob.cid,
      sha256: blob.sha256,
      encoding: DONATION_ARTIFACT_ENCODING,
    }],
  };
}

function trajectoryToArtifact(trajectory: ReturnType<typeof blobToAccess>): Artifact {
  return {
    artifactType: CAPTURE_TRACE_ARTIFACT_TYPE,
    sha256: trajectory.sha256,
    metadata: { description: 'Redacted local-session capture trajectory' },
    access: { endpoint: trajectory.endpoint, priceUsdc: trajectory.priceUsdc },
    sources: trajectory.sources,
  };
}

export function sha256Hex(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex');
}
