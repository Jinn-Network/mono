/**
 * Public types for the corpus library.
 *
 * See spec/2026-04-30-phase-a-umbrella.md §2.2 for the rationale and the
 * narrative description of the read pipeline.
 */

import type { Store } from '../store/store.js';
import type { EvidenceTier, Role, SignedEnvelope } from '../types/envelope.js';

export interface CorpusOptions {
  subgraphUrl: string;
  ipfsGatewayUrl: string;
  store: Store;
  signer: { privateKey: string };
  selfSafeAddress: string;
  routeResolver?: RouteResolver;
}

export interface CorpusQuery {
  solverType?: string;
  artifactType?: string;
  taskCid?: string;
  participant?: { safeAddress?: string };
  evidenceTier?: 'self-signed' | 'committed' | 'attested';
  generatedAfter?: number;
  generatedBefore?: number;
  limit?: number;
}

export type EnvelopeProjectionMetadataValue = string | number | boolean;
export type EnvelopeProjectionMetadata = Record<string, EnvelopeProjectionMetadataValue>;

export interface EnvelopeProjection {
  envelopeId: string;
  envelopeCid: string | null;
  envelopeSha256: string | null;
  signatureHash: string;
  solverType: string;
  role: Role;
  taskCid: string | null;
  taskId: string | null;
  requestId: string | null;
  generatedAt: number;
  evidenceTier: EvidenceTier;
  participantSafeAddress: string | null;
  participantAgentEoa: string | null;
  executorImplName: string | null;
  executorImplVersion: string | null;
  executorRuntimeBundleDigest: string | null;
  executorPlugins: string[];
  solutionEnvelopeCid: string | null;
  solutionEnvelopeSha256: string | null;
  solutionEnvelopeRef: string | null;
  metadata: EnvelopeProjectionMetadata;
}

export interface EnvelopeProjectionQuery {
  envelopeRefs?: readonly string[];
  solverType?: string;
  role?: Role;
  taskCid?: string;
  taskId?: string;
  requestId?: string;
  participant?: { safeAddress?: string; agentEoa?: string };
  solutionEnvelopeRef?: string;
  metadata?: EnvelopeProjectionMetadata;
  generatedAfter?: number;
  generatedBefore?: number;
  limit?: number;
}

export interface ReadArgs {
  query: CorpusQuery;
  select?: (manifests: ManifestPreview[]) => ManifestPreview[];
}

export interface EnvelopeRef {
  manifestCid: string;
  manifestHash: string;
  operator: { agentId: string; safeAddress: string };
  evidenceTier: 'self-signed' | 'committed' | 'attested' | 'unknown';
  publishedAt: number;
}

export interface ManifestPreview {
  ref: EnvelopeRef;
  envelope: SignedEnvelope;
}

export interface ArtifactContent {
  sha256: string;
  bytes: Buffer;
  artifactType: string;
  source: 'cache' | 'self-store' | 'origin' | 'route-resolver';
  paidAmountUsdc: string;
  fetchedAt: string;
  sourceOperator?: string;
}

export interface Envelope extends ManifestPreview {
  artifactContents: Map<string, ArtifactContent>;
}

export interface RouteResolver {
  resolve(req: {
    sha256: string;
    access: { endpoint: string; priceUsdc: string };
    requesterSafe: string;
  }): Promise<{ bytes: Buffer; sourceOperator?: string; pricePaidUsdc: string } | null>;
}

export interface Corpus {
  read(args: ReadArgs): Promise<Envelope[]>;
  query(q: CorpusQuery): Promise<EnvelopeRef[]>;
  fetchManifest(ref: EnvelopeRef): Promise<ManifestPreview>;
  acquire(manifest: ManifestPreview): Promise<Envelope>;
  acquireBySha256(
    sha256: string,
    access: { endpoint: string; priceUsdc: string },
    hint?: { artifactType?: string; envelopeCid?: string },
  ): Promise<ArtifactContent>;
}

// ── Errors ─────────────────────────────────────────────────────────────

export class CorpusQueryError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'CorpusQueryError';
  }
}

export class ManifestFetchError extends Error {
  constructor(public readonly manifestCid: string, message: string, public readonly cause?: unknown) {
    super(`manifest ${manifestCid}: ${message}`);
    this.name = 'ManifestFetchError';
  }
}

export class AcquireError extends Error {
  constructor(public readonly sha256: string, message: string, public readonly cause?: unknown) {
    super(`acquire ${sha256}: ${message}`);
    this.name = 'AcquireError';
  }
}

export class HashMismatchError extends Error {
  constructor(
    public readonly sha256Expected: string,
    public readonly sha256Actual: string,
    public readonly source: string,
    public readonly sourceOperator?: string,
  ) {
    super(`hash mismatch: expected ${sha256Expected}, got ${sha256Actual} from ${source}`);
    this.name = 'HashMismatchError';
  }
}
