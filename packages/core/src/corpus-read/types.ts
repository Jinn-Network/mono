import type { AcquireResult } from './fetch-artifact.js';

export interface EnvelopeRef {
  manifestCid: string;
  manifestHash: string;
  operator: { agentId: string; safeAddress: string };
  evidenceTier: 'self-signed' | 'committed' | 'attested' | 'unknown';
  publishedAt: number;
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
  manifestHash?: string;
}

export interface ArtifactSource {
  kind: 'ipfs';
  cid: string;
  sha256: string;
  encoding: 'jinn.artifact.donation.v1';
}

export interface CorpusManifestArtifact {
  artifactType: string;
  sha256: string;
  access: { endpoint: string; priceUsdc: string };
  sources?: ArtifactSource[];
}

/**
 * The read-side projection core needs from a signed execution envelope.
 * Client-owned validation supplies this shape through `parseEnvelope`; core
 * deliberately has no dependency on daemon schemas.
 */
export interface CorpusManifest {
  solverType: string;
  role: string;
  generatedAt: number;
  task?: { cid: string; requestId: string };
  participant: { safeAddress: string };
  artifacts: CorpusManifestArtifact[];
}

export interface ManifestPreview<TEnvelope extends CorpusManifest = CorpusManifest> {
  ref: EnvelopeRef;
  envelope: TEnvelope;
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

export interface CorpusEnvelope<TEnvelope extends CorpusManifest = CorpusManifest>
  extends ManifestPreview<TEnvelope> {
  artifactContents: Map<string, ArtifactContent>;
}

export interface RouteResolver {
  resolve(req: {
    sha256: string;
    access: { endpoint: string; priceUsdc: string };
    requesterSafe: string;
  }): Promise<{ bytes: Buffer; sourceOperator?: string; pricePaidUsdc: string } | null>;
}

export interface NetworkArtifactRow {
  sha256: string;
  artifactType: string;
  content: Buffer;
  fetchedAt: string;
  sourceOperator?: string | null;
}

export interface ServedArtifactRow {
  artifactType: string;
  envelopeCid: string | null;
  content: Buffer;
}

export interface SaveNetworkArtifactInput {
  sha256: string;
  artifactType: string;
  envelopeCid: string | null;
  content: Buffer;
  source: 'origin' | 'route-resolver' | 'self-store-mirror';
  sourceOperator?: string | null;
  sourceEndpoint?: string | null;
  paidAmountUsdc: string;
  fetchedAt: string;
}

/** SQLite ownership remains client-side until C4; core consumes this port. */
export interface CorpusStorePort {
  getNetworkArtifact(sha256: string): NetworkArtifactRow | null;
  touchNetworkArtifactUsage(sha256: string, usedAt: string): void;
  saveNetworkArtifact(input: SaveNetworkArtifactInput): void;
  getServedArtifact(sha256: string): ServedArtifactRow | null;
}

/** Chain/indexer selection remains client-side; core only needs this read port. */
export interface CorpusDiscoveryPort {
  queryEnvelopes(query: CorpusQuery): Promise<EnvelopeRef[]>;
}

export interface CorpusOptions<TEnvelope extends CorpusManifest = CorpusManifest> {
  ipfsGatewayUrl: string;
  store: CorpusStorePort;
  signer: { privateKey: string };
  selfSafeAddress: string;
  routeResolver?: RouteResolver;
  discovery?: CorpusDiscoveryPort;
  legacyQuery?: (query: CorpusQuery) => Promise<EnvelopeRef[]>;
  parseEnvelope(input: unknown): TEnvelope;
}

export interface CorpusDeps {
  fetchFromIpfs?: (gatewayUrl: string, cid: string) => Promise<unknown>;
  acquireFn?: (
    endpoint: string,
    sha256: string,
    privateKey?: string,
  ) => Promise<Buffer | null | AcquireResult>;
}

export interface ReadArgs<TEnvelope extends CorpusManifest = CorpusManifest> {
  query: CorpusQuery;
  select?: (
    manifests: ManifestPreview<TEnvelope>[],
  ) => ManifestPreview<TEnvelope>[];
}

export interface Corpus<TEnvelope extends CorpusManifest = CorpusManifest> {
  read(args: ReadArgs<TEnvelope>): Promise<CorpusEnvelope<TEnvelope>[]>;
  query(query: CorpusQuery): Promise<EnvelopeRef[]>;
  fetchManifest(ref: EnvelopeRef): Promise<ManifestPreview<TEnvelope>>;
  acquire(manifest: ManifestPreview<TEnvelope>): Promise<CorpusEnvelope<TEnvelope>>;
  acquireBySha256(
    sha256: string,
    access: { endpoint: string; priceUsdc: string },
    hint?: {
      artifactType?: string;
      envelopeCid?: string;
      sources?: ArtifactSource[];
      ownerSafe?: string;
    },
  ): Promise<ArtifactContent>;
}

export class ManifestFetchError extends Error {
  constructor(
    public readonly manifestCid: string,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(`manifest ${manifestCid}: ${message}`);
    this.name = 'ManifestFetchError';
  }
}

export class AcquireError extends Error {
  constructor(
    public readonly sha256: string,
    message: string,
    public readonly cause?: unknown,
  ) {
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

export class DiscoveryUnavailableError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'DiscoveryUnavailableError';
  }
}
