import { Buffer } from 'node:buffer';
import type { Hex } from 'viem';
import { uploadToIpfs } from '../adapters/mech/ipfs.js';
import type { Store } from '../store/store.js';
import type { CapturesStore } from '../store/captures.js';
import { canonicalJson } from '../util/canonical-json.js';
import type { IdentityPublisher, ExecutionPayloadV2 } from '../erc8004/index.js';
import {
  codeDigestSha256ToBytes32,
  contentKindForAnchor,
  encodeExecutionPayloadV2,
  modeStringToFlag,
} from '../erc8004/index.js';
import {
  publishCaptureEnvelope,
  sha256Hex,
  type CapturePublishDeps,
  type PublishCaptureResult,
} from './publish.js';
import {
  CaptureRateLimiter,
  type CaptureRateLimitDefaults,
} from './rate-limit.js';
import { CapturePublishRateLimitError, CapturePublishUnavailableError } from '../api/captures.js';
import type { ScrubPipeline } from '../trajectory/scrub/pipeline.js';

const DONATION_ARTIFACT_ENCODING = 'jinn.artifact.donation.v1' as const;
const ZERO_BYTES32 = `0x${'0'.repeat(64)}` as const;

export interface LiveCapturePublisherOptions {
  store: Store;
  captures: CapturesStore;
  ipfsRegistryUrl: string;
  operatorEndpoint: string;
  defaultPriceUsdc: string;
  perArtifactTypePrice?: Record<string, string>;
  participant: { safeAddress: `0x${string}`; agentEoa: `0x${string}` };
  signer: { address: `0x${string}`; privateKey: `0x${string}` };
  clientGitSha: string;
  identityPublisher?: IdentityPublisher;
  harnessMode?: 'train' | 'frozen';
  rateLimits?: Partial<CaptureRateLimitDefaults>;
  /**
   * Seller-side scrub pipeline applied to capture spans before publish. Wired
   * from main.ts so captures and task trajectories share one pipeline (and the
   * same optional ML PII detector). Absent → the publish path defaults to the
   * non-ML safety floor (buildScrubPipeline()), so captures are never published
   * raw by omission.
   */
  scrubPipeline?: ScrubPipeline;
}

export interface LiveCapturePublisher {
  publishCapture(sessionId: string): Promise<{ envelopeCid: string; result: PublishCaptureResult }>;
  rateLimiter: CaptureRateLimiter;
}

export function createLiveCapturePublisher(options: LiveCapturePublisherOptions): LiveCapturePublisher {
  const rateLimiter = new CaptureRateLimiter({ limits: options.rateLimits });

  return {
    rateLimiter,
    async publishCapture(sessionId: string) {
      if (!options.identityPublisher) {
        throw new CapturePublishUnavailableError(
          'Capture publishing requires an ERC-8004 IdentityPublisher; re-run bootstrap if the operator agent NFT is missing.',
        );
      }

      const capture = options.captures.getBySession(sessionId);
      if (!capture) throw new Error(`capture not found: ${sessionId}`);
      const rate = rateLimiter.tryAcquire({
        operator: options.participant.safeAddress,
        repo: capture.repoRemoteUrl ?? capture.repoCommitHash ?? null,
      });
      if (!rate.allowed) {
        throw new CapturePublishRateLimitError(rate.reason ?? 'capture_rate_limit', rate.retryAfterMs);
      }

      const servedSha256s: string[] = [];
      const publishDeps: CapturePublishDeps = {
        captures: options.captures,
        participant: options.participant,
        signer: options.signer,
        clientGitSha: options.clientGitSha,
        defaultArtifactEndpoint: options.operatorEndpoint,
        defaultPriceUsdc: options.defaultPriceUsdc,
        executor: { mode: options.harnessMode ?? 'train' },
        ...(options.scrubPipeline ? { scrubPipeline: options.scrubPipeline } : {}),
        publishArtifact: async ({ artifactType, payload }) => {
          const content = Buffer.from(canonicalJson(payload), 'utf8');
          const sha256 = sha256Hex(content);
          const priceUsdc =
            options.perArtifactTypePrice?.[artifactType] ??
            options.defaultPriceUsdc;
          const cid = await uploadToIpfs(options.ipfsRegistryUrl, {
            schemaVersion: DONATION_ARTIFACT_ENCODING,
            artifactType,
            sha256,
            encoding: DONATION_ARTIFACT_ENCODING,
            data: content.toString('base64'),
          });
          options.store.saveServedArtifact({
            sha256,
            artifactType,
            requestId: sessionId,
            content,
            priceUsdc,
            createdAt: new Date().toISOString(),
          });
          servedSha256s.push(sha256);
          return {
            cid,
            sha256,
            endpoint: options.operatorEndpoint,
            priceUsdc,
          };
        },
        publishEnvelope: async (envelope) => {
          const cid = await uploadToIpfs(options.ipfsRegistryUrl, envelope);
          return {
            cid,
            sha256: sha256Hex(canonicalJson(envelope)),
            endpoint: options.operatorEndpoint,
            priceUsdc: '0',
          };
        },
        anchorEnvelope: async ({ metadataKey, envelopeCid, envelopeHash, envelope }) => {
          const payload: ExecutionPayloadV2 = {
            version: 2,
            tier: 0,
            manifestHash: envelopeHash as Hex,
            attestationQuoteCid: '0x',
            sourceMeasurement: ZERO_BYTES32,
            codeDigest: codeDigestSha256ToBytes32(envelope.executor.codeDigest),
            implName: envelope.executor.implName,
            modeFlag: modeStringToFlag(envelope.executor.mode ?? 'train'),
          };
          const payloadHex = encodeExecutionPayloadV2(payload);
          const publisher = options.identityPublisher!;
          const contentKind = contentKindForAnchor(metadataKey, envelopeCid);
          const { txHash, blockNumber } = await publisher.publishContentV2({
            kind: contentKind,
            cid: envelopeCid,
            payload,
          });
          try {
            options.store.saveErc8004Anchor({
              envelopeId: envelopeHash,
              envelopeCid,
              contentKind,
              metadataKey,
              agentId: publisher.agent.toString(),
              chainId: publisher.chainId,
              identityRegistryAddress: publisher.registry,
              txHash,
              blockNumber,
              payloadHex,
              anchoredAt: Math.floor(Date.now() / 1000),
            });
          } catch (err) {
            console.warn(
              `[captures] failed to record erc8004 anchor for ${envelopeCid} (non-fatal): ${err instanceof Error ? err.message : err}`,
            );
          }
          return { txHash, blockNumber };
        },
      };

      const result = await publishCaptureEnvelope(sessionId, publishDeps);
      for (const sha256 of servedSha256s) {
        options.store.setServedArtifactEnvelopeCid(sha256, result.envelopeCid);
      }
      return { envelopeCid: result.envelopeCid, result };
    },
  };
}
