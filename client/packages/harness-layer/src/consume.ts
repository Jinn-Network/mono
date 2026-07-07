/**
 * Harness-layer consume path — the embeddable corpus surface.
 *
 * Thin wrapper over `createCorpus()` (client/src/corpus/) and the configured
 * DiscoveryAPI (client/src/discovery/factory.ts). No new query logic lives
 * here: `search` delegates ref discovery to the DiscoveryAPI and manifest
 * retrieval to the corpus, then applies a client-side substring match
 * (solverType lives in the IPFS manifest body, not in the on-chain envelope
 * payload, so the indexer cannot filter on it — see
 * client/src/discovery/http.ts `queryEnvelopes`). `get` is
 * fetchManifest + acquire.
 *
 * Plan: docs/superpowers/plans/2026-07-02-jinn-harness-network-v0-plan.md
 * Task 1 (issue #1308).
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { createCorpus, type Corpus } from '../../../src/corpus/index.js';
import type { ArtifactContent, EnvelopeRef } from '../../../src/corpus/types.js';
import type { SignedEnvelope } from '../../../src/types/envelope.js';
import { Store } from '../../../src/store/store.js';
import { createDiscoveryAPI } from '../../../src/discovery/factory.js';
import type { DiscoveryAPI } from '../../../src/discovery/types.js';
import { DEFAULT_TESTNET_DISCOVERY_URL } from '../../../src/config.js';
import type { AcquireResult } from '../../../src/corpus/fetch-artifact.js';
import { SKILL_ARTIFACT_TYPE } from '../../../src/types/skill-artifact.js';

/**
 * Default public IPFS gateway. Mirrors the `ipfsGatewayUrl` zod default in
 * client/src/config.ts (inline schema default; not exported as a constant).
 */
export const DEFAULT_IPFS_GATEWAY_URL = 'https://gateway.autonolas.tech';

/** Base Sepolia — the testnet the default discovery indexer serves. */
const TESTNET_CHAIN_ID = 84532;

export interface HarnessLayerConfig {
  /** Discovery indexer URL. Default: the testnet Ponder indexer. */
  discoveryUrl?: string;
  /** IPFS gateway for manifest / donated-artifact fetches. */
  ipfsGatewayUrl?: string;
  /** SQLite path for the artifact cache. Default: ~/.jinn-client/harness-layer/corpus-cache.db */
  dbPath?: string;
  /**
   * Capture-meta search endpoint (#1344) — the content-aware fast path.
   * Default: `<discoveryUrl base>/capture-meta` (the indexer serves it next
   * to /graphql). Set to '' to disable.
   */
  captureMetaUrl?: string;
  /** Injectable HTTP fetch for the capture-meta fast path (tests). */
  fetchImpl?: typeof fetch;
  /** Injectable DiscoveryAPI (tests). Overrides discoveryUrl. */
  discovery?: DiscoveryAPI;
  /** Injectable Store (tests). Overrides dbPath. */
  store?: Store;
  /** Injectable IPFS fetch (tests). */
  fetchFromIpfs?: (gatewayUrl: string, cid: string) => Promise<unknown>;
  /** Injectable origin acquire fn (tests). */
  acquireFn?: (endpoint: string, sha256: string, privateKey?: string) => Promise<Buffer | null | AcquireResult>;
}

export interface ResolvedHarnessLayerConfig {
  discoveryUrl: string;
  ipfsGatewayUrl: string;
  dbPath: string;
  /** '' when the content-aware fast path is disabled. */
  captureMetaUrl: string;
}

/** One search result — a corpus record ref plus its provenance fields. */
export interface CorpusSearchHit {
  /** Human-readable title: `<solverType> / <role>`. */
  title: string;
  /** Record ref (the envelope manifest CID) — pass to `get()`. */
  ref: string;
  solverType: string;
  role: string;
  artifactTypes: string[];
  /**
   * `'skill'` when the record carries a `jinn.skill.v1` artifact, else
   * `'trace'`. Note: legacy pre-#1394 seeded-trace records (skill.md as a step
   * attribute, no first-class artifact) classify as `'trace'` here even though
   * `extractSkill()` still recognises them via its fallback shape — acceptable
   * because the layer-2 re-import supersedes them with first-class records.
   */
  kind: 'skill' | 'trace';
  // Provenance.
  evidenceTier: EnvelopeRef['evidenceTier'];
  generatedAt: number;
  publishedAt: number;
  operator: { agentId: string; safeAddress: string };
  task: { cid: string; requestId: string } | null;
  /** Distribution tags, when the hit came via the capture-meta fast path. */
  tags?: string[];
  /** Scrubbed task summary, when the hit came via the capture-meta fast path. */
  summary?: string;
}

/** Shape served by the indexer's GET /capture-meta (#1344). */
interface CaptureMetaHit {
  manifestCid: string;
  taskSummary: string;
  tags: string[];
  provenance: string;
  verifiabilityTier: string;
}

export interface CorpusArtifact {
  sha256: string;
  artifactType: string;
  content: Buffer;
  source: ArtifactContent['source'];
  sizeBytes: number;
}

/** A fully-fetched corpus record: the signed envelope plus artifact bytes. */
export interface CorpusRecord {
  ref: string;
  envelope: SignedEnvelope;
  provenance: {
    operator: { agentId: string; safeAddress: string };
    evidenceTier: EnvelopeRef['evidenceTier'];
    publishedAt: number;
  };
  artifacts: CorpusArtifact[];
}

export interface HarnessLayer {
  readonly config: ResolvedHarnessLayerConfig;
  corpus: {
    /**
     * Query the corpus and return records whose solverType / role /
     * artifactType / ref / task cid contains `query` (case-insensitive).
     * Empty query returns everything fetched (up to `limit`).
     */
    search(query: string, opts?: { limit?: number; kind?: 'skill' | 'trace' }): Promise<CorpusSearchHit[]>;
    /** Fetch a record by ref (manifest CID from a search hit), including artifact bytes. */
    get(ref: string): Promise<CorpusRecord>;
  };
}

const DEFAULT_SEARCH_LIMIT = 50;

function matchesQuery(hit: CorpusSearchHit, needle: string): boolean {
  if (needle === '') return true;
  const haystack = [
    hit.solverType,
    hit.role,
    hit.ref,
    hit.task?.cid ?? '',
    hit.operator.safeAddress,
    ...hit.artifactTypes,
  ].join('\n').toLowerCase();
  return haystack.includes(needle.toLowerCase());
}

function toSearchHit(ref: EnvelopeRef, envelope: SignedEnvelope): CorpusSearchHit {
  return {
    title: `${envelope.solverType} / ${envelope.role}`,
    ref: ref.manifestCid,
    solverType: envelope.solverType,
    role: envelope.role,
    artifactTypes: envelope.artifacts.map((a) => a.artifactType),
    kind: envelope.artifacts.some((a) => a.artifactType === SKILL_ARTIFACT_TYPE) ? 'skill' : 'trace',
    evidenceTier: ref.evidenceTier,
    generatedAt: envelope.generatedAt,
    publishedAt: ref.publishedAt,
    operator: {
      agentId: ref.operator.agentId,
      // The indexer does not store safeAddress; enrich from the manifest.
      safeAddress: ref.operator.safeAddress || envelope.participant.safeAddress,
    },
    task: envelope.task
      ? { cid: envelope.task.cid, requestId: envelope.task.requestId }
      : null,
  };
}

/** Synthesize an EnvelopeRef for a bare manifest CID (get-by-ref path). */
function refForCid(manifestCid: string): EnvelopeRef {
  return {
    manifestCid,
    manifestHash: '',
    operator: { agentId: '', safeAddress: '' },
    evidenceTier: 'unknown',
    publishedAt: 0,
  };
}

export function createHarnessLayer(config: HarnessLayerConfig = {}): HarnessLayer {
  const discoveryUrl = config.discoveryUrl ?? DEFAULT_TESTNET_DISCOVERY_URL;
  const resolved: ResolvedHarnessLayerConfig = {
    discoveryUrl,
    ipfsGatewayUrl: config.ipfsGatewayUrl ?? DEFAULT_IPFS_GATEWAY_URL,
    dbPath: config.store?.path
      ?? config.dbPath
      ?? join(homedir(), '.jinn-client', 'harness-layer', 'corpus-cache.db'),
    captureMetaUrl: config.captureMetaUrl
      ?? `${discoveryUrl.replace(/\/graphql\/?$/, '').replace(/\/$/, '')}/capture-meta`,
  };
  const fetchImpl = config.fetchImpl ?? globalThis.fetch;

  const store = config.store ?? new Store(resolved.dbPath);
  const discovery = config.discovery ?? createDiscoveryAPI(
    { mode: 'http', url: resolved.discoveryUrl },
    { chainId: TESTNET_CHAIN_ID, fetchImpl: globalThis.fetch },
  );

  // `signer.privateKey` and `selfSafeAddress` are required by CorpusOptions
  // but unused by the read paths this layer exposes (query / fetchManifest /
  // ipfs-and-origin acquire). Placeholders, same as the read-only corpus in
  // client/src/mcp/server.ts.
  const corpus: Corpus = createCorpus(
    {
      discovery,
      ipfsGatewayUrl: resolved.ipfsGatewayUrl,
      store,
      signer: { privateKey: '0x0' },
      selfSafeAddress: '0x0000000000000000000000000000000000000000',
    },
    {
      ...(config.fetchFromIpfs ? { fetchFromIpfs: config.fetchFromIpfs } : {}),
      ...(config.acquireFn ? { acquireFn: config.acquireFn } : {}),
    },
  );

  /**
   * Content-aware fast path (#1344): substring search over the indexer's
   * enriched capture metadata (tags + task summary) — finds by content
   * without any artifact fetch. Degrades to [] on any failure (older
   * indexer, onchain mode, network error) so the manifest scan below is
   * always the floor.
   */
  async function queryCaptureMeta(query: string, limit: number): Promise<CaptureMetaHit[]> {
    if (!resolved.captureMetaUrl || query === '') return [];
    try {
      const url = `${resolved.captureMetaUrl}?q=${encodeURIComponent(query)}&limit=${limit}`;
      const res = await fetchImpl(url);
      if (!res.ok) return [];
      const body = (await res.json()) as unknown;
      if (!Array.isArray(body)) return [];
      return body.filter(
        (h): h is CaptureMetaHit =>
          h !== null && typeof h === 'object' && typeof (h as CaptureMetaHit).manifestCid === 'string',
      );
    } catch {
      return [];
    }
  }

  async function search(
    query: string,
    opts: { limit?: number; kind?: 'skill' | 'trace' } = {},
  ): Promise<CorpusSearchHit[]> {
    const limit = opts.limit ?? DEFAULT_SEARCH_LIMIT;
    const hits: CorpusSearchHit[] = [];
    const seen = new Set<string>();

    // Fast path: content matches from indexed capture meta. Manifest fetch
    // per hit only (never artifact bodies).
    for (const metaHit of await queryCaptureMeta(query, limit)) {
      if (hits.length >= limit) break;
      try {
        const preview = await corpus.fetchManifest(refForCid(metaHit.manifestCid));
        const hit = toSearchHit(preview.ref, preview.envelope);
        hits.push({
          ...hit,
          tags: Array.isArray(metaHit.tags) ? metaHit.tags : [],
          summary: metaHit.taskSummary,
        });
        seen.add(metaHit.manifestCid);
      } catch (err) {
        console.warn(`[harness-layer] skipping capture-meta hit ${metaHit.manifestCid}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const refs = await corpus.query({ limit });
    for (const ref of refs) {
      if (seen.has(ref.manifestCid)) continue;
      let preview;
      try {
        preview = await corpus.fetchManifest(ref);
      } catch (err) {
        // A single unfetchable manifest must not sink the whole search.
        console.warn(`[harness-layer] skipping manifest ${ref.manifestCid}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      const hit = toSearchHit(preview.ref, preview.envelope);
      if (matchesQuery(hit, query)) hits.push(hit);
      if (hits.length >= limit) break;
    }
    // Client-side kind filter (spec §5: the indexer has no artifactType column,
    // so this is a best-effort filter over the fetched page — a kind-filtered
    // search may return fewer than `limit` if other kinds consumed the budget).
    return opts.kind ? hits.filter((h) => h.kind === opts.kind) : hits;
  }

  async function get(ref: string): Promise<CorpusRecord> {
    const preview = await corpus.fetchManifest(refForCid(ref));
    const envelope = await corpus.acquire(preview);
    const artifacts: CorpusArtifact[] = envelope.envelope.artifacts.map((a) => {
      const content = envelope.artifactContents.get(a.sha256);
      if (!content) throw new Error(`artifact ${a.sha256} missing from acquire result`);
      return {
        sha256: a.sha256,
        artifactType: a.artifactType,
        content: content.bytes,
        source: content.source,
        sizeBytes: content.bytes.length,
      };
    });
    return {
      ref: envelope.ref.manifestCid,
      envelope: envelope.envelope,
      provenance: {
        operator: {
          agentId: envelope.ref.operator.agentId,
          safeAddress: envelope.ref.operator.safeAddress || envelope.envelope.participant.safeAddress,
        },
        evidenceTier: envelope.ref.evidenceTier,
        publishedAt: envelope.ref.publishedAt,
      },
      artifacts,
    };
  }

  return {
    config: resolved,
    corpus: { search, get },
  };
}
