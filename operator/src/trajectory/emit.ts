/**
 * Emit a signed jinn.trajectory.v1 blob and upload it to IPFS.
 *
 * Signing mirrors envelope-assembly.ts (§4.2a mechanics):
 *   hash = keccak256(JCS(trajectory minus signature))
 *   → signed with agent EOA key
 *   → signed blob uploaded to IPFS
 *   → { cid, sha256 } returned for the envelope.
 */

import { createHash } from 'node:crypto';
import { keccak256, toBytes, type Hex } from 'viem';
import { signCanonical } from '../harnesses/engine/signing.js';
import { canonicalJson } from '../util/canonical-json.js';
import { uploadToIpfs } from '../adapters/mech/ipfs.js';
import {
  scrubArtifactBytes,
  type ArtifactScrubConfig,
} from '../harnesses/engine/artifact-scrub.js';
import type { TrajectoryCollector } from './collector.js';
import type { ScrubPipeline } from './scrub/pipeline.js';
import { scrubSpansForEmit } from './scrub/emit-scrub.js';
import type { JinnTrajectoryV1, Span, RedactionManifest } from './schema.js';

export interface EmitTrajectoryParams {
  collector: TrajectoryCollector;
  runId: string;
  /** Set to the parent restoration envelope CID for a verdict trajectory; null otherwise. */
  parentEnvelopeCid?: string | null;
  signerPrivateKey: Hex;
  signerAddress: `0x${string}`;
  ipfsRegistryUrl: string;
  scrub?: ArtifactScrubConfig;
  /**
   * Seller-side scrub pipeline (secretlint + openredaction + optional ML PII).
   * When provided, every span is scrubbed through it before signing.
   */
  scrubPipeline?: ScrubPipeline;
}

export interface EmitTrajectoryResult {
  cid: string;
  sha256: string;
  signed: JinnTrajectoryV1;
}

function sha256Hex(bytes: string): string {
  return createHash('sha256').update(bytes, 'utf8').digest('hex');
}

function scrubSpan(span: Span, scrub: ArtifactScrubConfig): { span: Span; redactedKeys: string[] } {
  const result = scrubArtifactBytes(Buffer.from(JSON.stringify(span), 'utf8'), scrub);
  if (result.bytes.length === 0) return { span, redactedKeys: [] };
  try {
    return {
      span: JSON.parse(result.bytes.toString('utf8')) as Span,
      redactedKeys: result.redactedKeys,
    };
  } catch {
    return { span, redactedKeys: [] };
  }
}

function scrubSnapshot(
  spans: Span[],
  redactionManifest: RedactionManifest,
  scrub: ArtifactScrubConfig | undefined,
): { spans: Span[]; redactionManifest: RedactionManifest } {
  if (!scrub) return { spans, redactionManifest };
  const scrubbedSpans: Span[] = [];
  const extraManifestEntries: RedactionManifest['spans'] = [];
  let extraRedactions = 0;
  for (const span of spans) {
    const result = scrubSpan(span, scrub);
    scrubbedSpans.push(result.span);
    if (result.redactedKeys.length > 0) {
      extraManifestEntries.push({
        spanId: span.spanId,
        redactedKeys: result.redactedKeys.map((key) => `trajectory.${key}`),
      });
      extraRedactions += result.redactedKeys.length;
    }
  }
  return {
    spans: scrubbedSpans,
    redactionManifest: {
      spans: [...redactionManifest.spans, ...extraManifestEntries],
      totalRedactions: redactionManifest.totalRedactions + extraRedactions,
      ...(redactionManifest.schemaVersion !== undefined
        ? { schemaVersion: redactionManifest.schemaVersion }
        : {}),
      ...(redactionManifest.policyHash !== undefined
        ? { policyHash: redactionManifest.policyHash }
        : {}),
      ...(redactionManifest.perClassCounts !== undefined
        ? { perClassCounts: redactionManifest.perClassCounts }
        : {}),
    },
  };
}

export async function emitTrajectory(
  p: EmitTrajectoryParams,
): Promise<EmitTrajectoryResult> {
  const snap = p.collector.snapshot();
  let spans = snap.spans;
  let manifest = snap.redactionManifest;
  if (p.scrubPipeline) {
    const piped = await scrubSpansForEmit(spans, p.scrubPipeline, p.collector.taskCid);
    spans = piped.spans;
    manifest = piped.redactionManifest;
  }
  const scrubbed = scrubSnapshot(spans, manifest, p.scrub);
  const unsigned = {
    schemaVersion: 'jinn.trajectory.v1' as const,
    runId: p.runId,
    parentEnvelopeCid: p.parentEnvelopeCid ?? null,
    spans: scrubbed.spans,
    redactionManifest: scrubbed.redactionManifest,
  };

  const sig = await signCanonical(unsigned, p.signerPrivateKey, p.signerAddress);

  const signed: JinnTrajectoryV1 = {
    ...unsigned,
    signature: {
      algo: 'secp256k1',
      signer: p.signerAddress,
      hash: sig.hash as Hex,
      sig: sig.sig as Hex,
    },
  };

  const serialized = JSON.stringify(signed);
  const sha256 = sha256Hex(serialized);
  const cid = await uploadToIpfs(p.ipfsRegistryUrl, signed);

  return { cid, sha256, signed };
}
