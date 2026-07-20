import { createHash } from 'node:crypto';
import {
  UnsignedEnvelopeSchema,
  canonicalJson,
  type Artifact,
  type SessionProvenance,
  type SignedEnvelope,
  type UnsignedEnvelope,
} from '@jinn-network/core';

export interface CapturePublishedBlob {
  cid: string;
  sha256?: string;
  endpoint?: string;
  priceUsdc?: string;
}

export interface CaptureEnvelopeAnchorInput {
  metadataKey: string;
  envelopeCid: string;
  envelopeHash: `0x${string}`;
  envelope: SignedEnvelope;
  requireSuccessfulReceipt?: boolean;
  onBroadcast?: (txHash: `0x${string}`) => void;
  onPrepared?: (payloadHex: `0x${string}`) => void;
}

export interface CaptureEnvelopeAnchorResult {
  txHash?: `0x${string}`;
  blockNumber?: number | null;
  gasUsed?: bigint | null;
  feeWei?: bigint | null;
  payloadHex?: `0x${string}`;
}

/**
 * The capture-row facts the layer needs to wrap an episode or skill. This is
 * deliberately narrower than the daemon's persistence row.
 */
export interface LayerCaptureRow {
  sessionId: string;
  capturedAt: string;
  originatingTool: { name: string; version?: string };
  capturePath: string;
  spanCount: number;
  redactedSpanCount: number;
  durationMs: number;
  repoRemoteUrl?: string | null;
  repoCommitHash?: string | null;
}

export interface BuildUnsignedCaptureEnvelopeArgs {
  capture: LayerCaptureRow;
  now: Date;
  participant: { safeAddress: `0x${string}`; agentEoa: `0x${string}` };
  signerAddress: `0x${string}`;
  clientGitSha: string;
  artifacts: Artifact[];
  harnessBundleSha: string;
  executorOverrides?: Partial<UnsignedEnvelope['executor']>;
  solverType?: string;
  role?: UnsignedEnvelope['role'];
}

/**
 * Build the byte-compatible `jinn.execution.v1` wrapper previously supplied
 * by the client capture publisher.
 */
export function buildUnsignedCaptureEnvelope(
  args: BuildUnsignedCaptureEnvelopeArgs,
): UnsignedEnvelope {
  const {
    capture,
    now,
    participant,
    signerAddress,
    artifacts,
    harnessBundleSha,
  } = args;
  const sessionProvenance: SessionProvenance = {
    sessionId: capture.sessionId,
    capturedAt: capture.capturedAt,
    originatingTool: capture.originatingTool,
    ...(capture.repoRemoteUrl || capture.repoCommitHash
      ? {
          repo: {
            ...(capture.repoRemoteUrl
              ? { remoteUrl: capture.repoRemoteUrl }
              : {}),
            ...(capture.repoCommitHash
              ? { commitHash: capture.repoCommitHash }
              : {}),
          },
        }
      : {}),
    license: { operatorAssertion: 'unspecified' },
  };
  const windowEnd = Math.floor(now.getTime() / 1000);
  const runtimeBundleDigest = `sha256:${sha256Hex(
    canonicalJson({
      tool: capture.originatingTool,
      capturePath: capture.capturePath,
    }),
  )}`;
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
    window: {
      startTs: Math.max(
        0,
        windowEnd - Math.ceil(capture.durationMs / 1000),
      ),
      endTs: windowEnd,
    },
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

export function sha256Hex(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex');
}
