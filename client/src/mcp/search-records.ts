/**
 * Record-oriented MCP discovery handlers.
 *
 * `search_records` and `inspect_record` are read-only/free. They may query the
 * corpus index and fetch signed manifests from IPFS, but they never call corpus
 * byte acquisition methods or the daemon acquire route.
 */

import type {
  Corpus,
  CorpusQuery,
  EnvelopeRef,
  ManifestPreview,
} from '../corpus/index.js';
import type { EnvelopeProjection, EnvelopeProjectionQuery } from '../corpus/types.js';
import type { Artifact, ArtifactSource, SignedEnvelope } from '../types/envelope.js';
import type { Store } from '../store/store.js';

export type ReadOnlyCorpus = Pick<Corpus, 'query' | 'fetchManifest'>;

export interface ArtifactDescriptor {
  ref: string;
  sha256: string;
  artifactType: string;
  source: 'local' | 'network';
  localSource?: 'served' | 'network';
  envelopeCid: string | null;
  contentSize?: number;
  access?: {
    endpoint: string | null;
    priceUsdc: string;
  };
  acquisition?: {
    tool: 'acquire_artifact';
    arguments: {
      sha256: string;
      access: { endpoint: string; priceUsdc: string };
        envelopeCid?: string;
        artifactType?: string;
        sources?: ArtifactSource[];
        ownerSafe?: string;
      };
    };
  paidAmountUsdc?: string;
  sourceOperator?: string | null;
  createdAt?: string;
  fetchedAt?: string;
}

export interface RecordEnvelopeRef {
  cid: string | null;
  sha256: string | null;
  manifestHash?: string;
  evidenceTier?: EnvelopeRef['evidenceTier'];
  publishedAt?: number;
  operator?: EnvelopeRef['operator'];
}

export interface RecordSummary {
  recordRef: string;
  source: 'local' | 'network';
  envelopeRef: RecordEnvelopeRef | null;
  taskRef: { cid: string | null; id?: string | null; requestId?: string | null } | null;
  solverType?: string;
  role?: string;
  generatedAt?: number;
  participant?: { safeAddress?: string | null; agentEoa?: string | null };
  artifactRefs: ArtifactDescriptor[];
  scoreMetadata?: Record<string, unknown>;
}

export interface SearchRecordsResult {
  records: RecordSummary[];
  warning?: string;
  warnings?: string[];
}

export type SearchRecordsArgs = CorpusQuery & Partial<Pick<
  EnvelopeProjectionQuery,
  'role' | 'taskId' | 'requestId' | 'participant' | 'metadata'
>>;

export interface InspectRecordArgs {
  ref?: string;
  recordRef?: string;
  sha256?: string;
  envelopeCid?: string;
  manifestCid?: string;
  projectionRef?: string;
  envelopeRef?: EnvelopeRef;
}

export interface InspectRecordResult {
  query: InspectRecordArgs;
  record: RecordSummary | null;
  projections: EnvelopeProjection[];
  artifacts: ArtifactDescriptor[];
  warning?: string;
  warnings?: string[];
}

function scoreMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!metadata) return undefined;
  const entries = Object.entries(metadata).filter(([key]) => /score|brier|verdict/i.test(key));
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function projectionSummary(projection: EnvelopeProjection): RecordSummary {
  return {
    recordRef: `projection:${projection.envelopeId}`,
    source: 'local',
    envelopeRef: {
      cid: projection.envelopeCid,
      sha256: projection.envelopeSha256,
      evidenceTier: projection.evidenceTier,
    },
    taskRef: {
      cid: projection.taskCid,
      id: projection.taskId,
      requestId: projection.requestId,
    },
    solverType: projection.solverType,
    role: projection.role,
    generatedAt: projection.generatedAt,
    participant: {
      safeAddress: projection.participantSafeAddress,
      agentEoa: projection.participantAgentEoa,
    },
    artifactRefs: [],
    scoreMetadata: scoreMetadata(projection.metadata),
  };
}

function localRecord(row: ReturnType<Store['searchOwnAndCached']>[number]): RecordSummary {
  const artifact = localArtifactDescriptor(row);
  return {
    recordRef: `local:${row.source}:${row.sha256}`,
    source: 'local',
    envelopeRef: row.envelopeCid ? { cid: row.envelopeCid, sha256: null } : null,
    taskRef: null,
    artifactRefs: [artifact],
  };
}

function localArtifactDescriptor(row: ReturnType<Store['searchOwnAndCached']>[number]): ArtifactDescriptor {
  const access = row.source === 'served'
    ? { endpoint: null, priceUsdc: row.priceUsdc ?? '0' }
    : (row.sourceEndpoint
        ? { endpoint: row.sourceEndpoint, priceUsdc: row.paidAmountUsdc ?? '0' }
        : undefined);
  const descriptor: ArtifactDescriptor = {
    ref: `artifact:${row.sha256}`,
    sha256: row.sha256,
    artifactType: row.artifactType,
    source: 'local',
    localSource: row.source,
    envelopeCid: row.envelopeCid,
    contentSize: row.contentSize,
    access,
    createdAt: row.createdAt,
    sourceOperator: row.sourceOperator,
    paidAmountUsdc: row.paidAmountUsdc,
  };
  if (row.sourceEndpoint) {
    descriptor.acquisition = {
      tool: 'acquire_artifact',
      arguments: {
        sha256: row.sha256,
        access: { endpoint: row.sourceEndpoint, priceUsdc: row.paidAmountUsdc ?? '0' },
        ...(row.envelopeCid ? { envelopeCid: row.envelopeCid } : {}),
        artifactType: row.artifactType,
      },
    };
  }
  return descriptor;
}

function manifestArtifactDescriptor(ref: EnvelopeRef, artifact: Artifact, ownerSafe?: string): ArtifactDescriptor {
  const acquisitionArguments: NonNullable<ArtifactDescriptor['acquisition']>['arguments'] = {
    sha256: artifact.sha256,
    access: artifact.access,
    envelopeCid: ref.manifestCid,
    artifactType: artifact.artifactType,
  };
  const sourceOperator = ownerSafe || ref.operator.safeAddress;
  if (sourceOperator) {
    acquisitionArguments.ownerSafe = sourceOperator;
  }
  if (artifact.sources && artifact.sources.length > 0) {
    acquisitionArguments.sources = artifact.sources;
  }
  return {
    ref: `network:artifact:${artifact.sha256}@${ref.manifestCid}`,
    sha256: artifact.sha256,
    artifactType: artifact.artifactType,
    source: 'network',
    envelopeCid: ref.manifestCid,
    access: artifact.access,
    acquisition: {
      tool: 'acquire_artifact',
      arguments: acquisitionArguments,
    },
  };
}

function metadataValueAt(record: Record<string, unknown>, key: string): unknown {
  let current: unknown = record;
  for (const part of key.split('.')) {
    if (!isPlainRecord(current)) return undefined;
    current = current[part];
  }
  return current;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function manifestMatchesArgs(preview: ManifestPreview, args: SearchRecordsArgs): boolean {
  const envelope = preview.envelope;
  if (args.solverType && envelope.solverType !== args.solverType) return false;
  if (args.taskCid && envelope.task?.cid !== args.taskCid) return false;
  if (args.taskId) return false;
  if (args.requestId && envelope.task?.requestId !== args.requestId) return false;
  if (args.role && envelope.role !== args.role) return false;
  if (args.evidenceTier && preview.ref.evidenceTier !== args.evidenceTier) return false;
  if (args.generatedAfter !== undefined && envelope.generatedAt < args.generatedAfter) return false;
  if (args.generatedBefore !== undefined && envelope.generatedAt > args.generatedBefore) return false;
  if (args.participant?.safeAddress && envelope.participant.safeAddress !== args.participant.safeAddress) return false;
  if (args.participant?.agentEoa && envelope.participant.agentEoa !== args.participant.agentEoa) return false;
  if (args.metadata) {
    if (!isPlainRecord(envelope.payload)) return false;
    for (const [key, value] of Object.entries(args.metadata)) {
      if (metadataValueAt(envelope.payload, key) !== value) return false;
    }
  }
  return true;
}

function manifestRecord(preview: ManifestPreview, args: SearchRecordsArgs): RecordSummary | null {
  const envelope = preview.envelope;
  if (!manifestMatchesArgs(preview, args)) return null;
  const ref: EnvelopeRef = {
    ...preview.ref,
    operator: {
      agentId: preview.ref.operator.agentId,
      safeAddress: preview.ref.operator.safeAddress || envelope.participant.safeAddress,
    },
  };
  const artifacts = envelope.artifacts
    .filter((artifact) => !args.artifactType || artifact.artifactType === args.artifactType)
    .map((artifact) => manifestArtifactDescriptor(ref, artifact, envelope.participant.safeAddress));
  if (args.artifactType && artifacts.length === 0) return null;
  return {
    recordRef: `network:envelope:${ref.manifestCid}`,
    source: 'network',
    envelopeRef: {
      cid: ref.manifestCid,
      sha256: null,
      manifestHash: ref.manifestHash,
      evidenceTier: ref.evidenceTier,
      publishedAt: ref.publishedAt,
      operator: ref.operator,
    },
    taskRef: envelope.task
      ? { cid: envelope.task.cid, requestId: envelope.task.requestId }
      : null,
    solverType: envelope.solverType,
    role: envelope.role,
    generatedAt: envelope.generatedAt,
    participant: envelope.participant,
    artifactRefs: artifacts,
    scoreMetadata: scoreMetadata(envelope.payload as Record<string, unknown>),
  };
}

function projectionQuery(args: SearchRecordsArgs): EnvelopeProjectionQuery {
  return {
    solverType: args.solverType,
    role: args.role,
    taskCid: args.taskCid,
    taskId: args.taskId,
    requestId: args.requestId,
    participant: args.participant,
    metadata: args.metadata,
    generatedAfter: args.generatedAfter,
    generatedBefore: args.generatedBefore,
    limit: args.limit ?? 50,
  };
}

function appendUnique(records: RecordSummary[], next: RecordSummary): void {
  if (!records.some((record) => record.recordRef === next.recordRef)) {
    records.push(next);
  }
}

export async function handleSearchRecords(
  corpus: ReadOnlyCorpus | null,
  store: Store,
  args: SearchRecordsArgs,
): Promise<SearchRecordsResult> {
  const projections = store.queryEnvelopeProjections(projectionQuery(args)).map(projectionSummary);
  const local = store.searchOwnAndCached({
    artifactType: args.artifactType,
    limit: args.limit ?? 50,
  }).map(localRecord);

  if (!corpus) {
    console.warn(
      '[mcp:search_records] corpus not configured (missing IPFS gateway plus subgraph or on-chain corpus config) - local-only results',
    );
    const records: RecordSummary[] = [];
    for (const projection of projections) appendUnique(records, projection);
    for (const record of local) appendUnique(records, record);
    return {
      records,
      warning:
        'corpus not configured (missing IPFS gateway plus subgraph or on-chain corpus config); network results unavailable',
    };
  }

  const records: RecordSummary[] = [];
  for (const projection of projections) appendUnique(records, projection);
  for (const record of local) appendUnique(records, record);
  const warnings: string[] = [];
  const refs = await corpus.query(args);
  for (const ref of refs) {
    try {
      const preview = await corpus.fetchManifest(ref);
      const record = manifestRecord(preview, args);
      if (record) appendUnique(records, record);
    } catch (err) {
      warnings.push(`manifest ${ref.manifestCid}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return {
    records,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

function normalizeRef(args: InspectRecordArgs): string | undefined {
  return args.ref ?? args.recordRef ?? args.sha256 ?? args.envelopeCid ?? args.manifestCid ?? args.projectionRef;
}

function stripKnownPrefix(ref: string): string {
  if (ref.startsWith('local:served:')) return ref.slice('local:served:'.length);
  if (ref.startsWith('local:network:')) return ref.slice('local:network:'.length);
  if (ref.startsWith('artifact:')) return ref.slice('artifact:'.length);
  if (ref.startsWith('projection:')) return ref.slice('projection:'.length);
  if (ref.startsWith('network:envelope:')) return ref.slice('network:envelope:'.length);
  if (ref.startsWith('envelope:')) return ref.slice('envelope:'.length);
  if (ref.startsWith('network:artifact:')) {
    const rest = ref.slice('network:artifact:'.length);
    return rest.split('@')[0] ?? rest;
  }
  return ref;
}

function manifestCidFromArgs(args: InspectRecordArgs): string | undefined {
  if (args.envelopeRef) return args.envelopeRef.manifestCid;
  if (args.manifestCid) return args.manifestCid;
  if (args.envelopeCid) return args.envelopeCid;
  const raw = args.ref ?? args.recordRef;
  if (!raw) return undefined;
  if (raw.startsWith('network:envelope:')) return raw.slice('network:envelope:'.length);
  if (raw.startsWith('envelope:')) return raw.slice('envelope:'.length);
  if (raw.startsWith('network:artifact:')) return raw.split('@')[1];
  return undefined;
}

function shaFromArgs(args: InspectRecordArgs): string | undefined {
  if (args.sha256) return args.sha256;
  const raw = normalizeRef(args);
  if (!raw) return undefined;
  const stripped = stripKnownPrefix(raw);
  return /^[0-9a-f]{64}$/.test(stripped) ? stripped : undefined;
}

function envelopeRefForFetch(args: InspectRecordArgs, manifestCid: string): EnvelopeRef {
  return args.envelopeRef ?? {
    manifestCid,
    manifestHash: '',
    operator: { agentId: '', safeAddress: '' },
    evidenceTier: 'unknown',
    publishedAt: 0,
  };
}

function localArtifactFromSha(store: Store, sha256: string): ArtifactDescriptor[] {
  const served = store.getServedArtifactMetadata(sha256);
  if (served) {
    return [localArtifactDescriptor({
      sha256: served.sha256,
      artifactType: served.artifactType,
      source: 'served',
      envelopeCid: served.envelopeCid,
      createdAt: served.createdAt,
      contentSize: served.contentSize,
      priceUsdc: served.priceUsdc,
    })];
  }
  const cached = store.getNetworkArtifactMetadata(sha256);
  if (cached) {
    return [localArtifactDescriptor({
      sha256: cached.sha256,
      artifactType: cached.artifactType,
      source: 'network',
      envelopeCid: cached.envelopeCid,
      createdAt: cached.fetchedAt,
      contentSize: cached.contentSize,
      sourceEndpoint: cached.sourceEndpoint,
      sourceOperator: cached.sourceOperator,
      paidAmountUsdc: cached.paidAmountUsdc,
    })];
  }
  return [];
}

function projectionRefs(args: InspectRecordArgs): string[] {
  const refs = [
    args.ref,
    args.recordRef,
    args.envelopeCid,
    args.manifestCid,
    args.projectionRef,
    args.envelopeRef?.manifestCid,
    args.envelopeRef?.manifestHash,
  ].filter((ref): ref is string => Boolean(ref));
  return Array.from(new Set(refs.flatMap((ref) => [ref, stripKnownPrefix(ref)])));
}

export async function handleInspectRecord(
  corpus: ReadOnlyCorpus | null,
  store: Store,
  args: InspectRecordArgs,
): Promise<InspectRecordResult> {
  const projections = store.queryEnvelopeProjections({ envelopeRefs: projectionRefs(args), limit: 10 });
  const artifacts: ArtifactDescriptor[] = [];
  const warnings: string[] = [];
  const sha256 = shaFromArgs(args);
  if (sha256) artifacts.push(...localArtifactFromSha(store, sha256));

  const manifestCid = manifestCidFromArgs(args)
    ?? projections.find((projection) => projection.envelopeCid)?.envelopeCid
    ?? artifacts.find((artifact) => artifact.envelopeCid)?.envelopeCid
    ?? undefined;
  let record: RecordSummary | null = projections[0] ? projectionSummary(projections[0]) : null;

  if (manifestCid && corpus) {
    try {
      const preview = await corpus.fetchManifest(envelopeRefForFetch(args, manifestCid));
      const networkRecord = manifestRecord(preview, {});
      if (networkRecord) {
        const selectedSha = shaFromArgs(args);
        const selectedArtifacts = selectedSha
          ? networkRecord.artifactRefs.filter((artifact) => artifact.sha256 === selectedSha)
          : networkRecord.artifactRefs;
        record = {
          ...networkRecord,
          artifactRefs: selectedArtifacts,
          scoreMetadata: record?.scoreMetadata ?? networkRecord.scoreMetadata,
        };
        artifacts.push(...selectedArtifacts);
      }
    } catch (err) {
      warnings.push(`manifest ${manifestCid}: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else if (manifestCid && !corpus) {
    warnings.push('corpus not configured; manifest details unavailable');
  }

  if (!record && artifacts[0]) {
    record = {
      recordRef: artifacts[0].localSource
        ? `local:${artifacts[0].localSource}:${artifacts[0].sha256}`
        : artifacts[0].ref,
      source: artifacts[0].source,
      envelopeRef: artifacts[0].envelopeCid ? { cid: artifacts[0].envelopeCid, sha256: null } : null,
      taskRef: null,
      artifactRefs: artifacts,
    };
  } else if (record && artifacts.length > 0 && record.artifactRefs.length === 0) {
    record = { ...record, artifactRefs: artifacts };
  }

  return {
    query: args,
    record,
    projections,
    artifacts,
    ...(warnings.length > 0 ? { warnings, warning: warnings[0] } : {}),
  };
}
