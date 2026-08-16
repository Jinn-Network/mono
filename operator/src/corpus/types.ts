/**
 * Public types for the corpus library.
 *
 * See spec/2026-04-30-phase-a-umbrella.md §2.2 for the rationale and the
 * narrative description of the read pipeline.
 */

import type { Store } from '../store/store.js';
import type { ArtifactSource, EvidenceTier, LegacyEnvelopeRole, Role, SignedEnvelope } from '../types/envelope.js';

export interface CorpusOptions {
  ipfsGatewayUrl: string;
  store: Store;
  signer: { privateKey: string };
  selfSafeAddress: string;
  routeResolver?: RouteResolver;
  onchain?: import('./onchain-query.js').OnchainCorpusQueryOptions;
  /**
   * Envelope-query port. When provided, delegates all `queryEnvelopes` calls to
   * it (Ponder HTTP or onchain floor) and bypasses the `onchain` legacy path. A
   * full `DiscoveryAPI` satisfies it structurally, and when one is passed it
   * owns the primary-vs-floor fallback split internally via `withFallback`.
   *
   * Typed as core's one-method `CorpusDiscoveryPort` rather than the whole
   * `DiscoveryAPI` (one-swap R3b, issue #2494): `queryEnvelopes` is the only
   * method the corpus ever calls, and the narrower type keeps `corpus/` off the
   * legacy `discovery/` tree the D-wave deletes — which in turn is what lets
   * `discovery-client/` depend on these shapes without a cycle back.
   *
   * When both `discovery` and `onchain` are set, `discovery` takes precedence.
   */
  discovery?: import('@jinn-network/core/corpus-read').CorpusDiscoveryPort;
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
  /** Filter envelopes by the manifest hash (the keccak256 of the manifest body). */
  manifestHash?: string;
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
  role?: Role | LegacyEnvelopeRole;
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
  source: 'cache' | 'self-store' | 'origin' | 'route-resolver' | 'ipfs';
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
    hint?: { artifactType?: string; envelopeCid?: string; sources?: ArtifactSource[]; ownerSafe?: string },
  ): Promise<ArtifactContent>;
}

// ── Errors ─────────────────────────────────────────────────────────────

export class CorpusQueryError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'CorpusQueryError';
  }
}

export {
  ManifestFetchError,
  AcquireError,
  HashMismatchError,
} from '@jinn-network/core/corpus-read';
