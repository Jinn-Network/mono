/**
 * Harness-layer consume path — the embeddable corpus surface.
 *
 * Thin wrapper over core's `createCorpus()` and the configured corpus
 * discovery port. No new query logic lives
 * here: `search` delegates ref discovery to the discovery port and manifest
 * retrieval to the corpus, then applies a client-side substring match
 * (solverType lives in the IPFS manifest body, not in the on-chain envelope
 * payload, so the indexer cannot filter on it — see
 * core's HTTP discovery `queryEnvelopes`). `get` is
 * fetchManifest + acquire.
 *
 * Plan: docs/superpowers/plans/2026-07-02-jinn-harness-network-v0-plan.md
 * Task 1 (issue #1308).
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  createCorpus,
  createHttpCorpusDiscovery,
  queryCaptureMeta as queryCaptureMetaCore,
  type AcquireResult,
  type ArtifactContent,
  type CaptureMetaHit,
  type Corpus,
  type CorpusDiscoveryPort,
  type CorpusStorePort,
  type EnvelopeRef,
} from '@jinn-network/core/corpus-read';
import {
  SignedEnvelopeSchema,
  type SignedEnvelope,
  SKILL_ARTIFACT_TYPE,
} from '@jinn-network/core';
import { SqliteCorpusStore } from './corpus-store.js';
import { extractSkill } from './skill.js';

export const DEFAULT_TESTNET_DISCOVERY_URL =
  'https://jinn-indexer-production.up.railway.app';
/**
 * Default public IPFS gateway. Mirrors the `ipfsGatewayUrl` zod default in
 * operator/src/config.ts (inline schema default; not exported as a constant).
 */
export const DEFAULT_IPFS_GATEWAY_URL = 'https://gateway.autonolas.tech';

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
  discovery?: CorpusDiscoveryPort;
  /** Injectable core read-side store (tests/embedders). Overrides dbPath. */
  store?: CorpusStorePort & { path?: string };
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
  /** Repository identity from indexed canonical capture metadata. */
  repositorySlug?: string;
  /** Authored outcome/seed synthesis from indexed canonical capture metadata. */
  synthesis?: string;
  /** Named W2 allowlist decision; absent on legacy index rows. */
  retrievalVisible?: boolean;
  /** Canonical capture verification strength from capture-meta, when present. */
  verifiabilityTier?: string;
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
     *
     * By default the result is collapsed to lineage heads: a skill record
     * superseded (or deprecated) by a same-operator record in the fetched page
     * is dropped (#1462). Pass `includeSuperseded: true` to disable the
     * collapse and see every record.
     */
    search(query: string, opts?: { limit?: number; kind?: 'skill' | 'trace'; includeSuperseded?: boolean }): Promise<CorpusSearchHit[]>;
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

  const store = config.store ?? new SqliteCorpusStore(resolved.dbPath);
  const discovery = config.discovery ?? createHttpCorpusDiscovery({
    url: resolved.discoveryUrl,
    fetchImpl: globalThis.fetch,
  });

  // `signer.privateKey` and `selfSafeAddress` are required by CorpusOptions
  // but unused by the read paths this layer exposes (query / fetchManifest /
  // ipfs-and-origin acquire). Placeholders, same as the read-only corpus in
  // operator/src/mcp/server.ts.
  const corpus: Corpus<SignedEnvelope> = createCorpus(
    {
      discovery,
      ipfsGatewayUrl: resolved.ipfsGatewayUrl,
      store,
      signer: { privateKey: '0x0' },
      selfSafeAddress: '0x0000000000000000000000000000000000000000',
      parseEnvelope(input) {
        return SignedEnvelopeSchema.parse(input);
      },
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
    return queryCaptureMetaCore({
      url: resolved.captureMetaUrl,
      query,
      limit,
      fetchImpl,
    });
  }

  /**
   * Collapse a page of hits to lineage heads (#1462). For every `kind:'skill'`
   * hit, fetch its body and read `provenance.supersedes` / `provenance.deprecates`:
   *   - a `deprecates: true` record hides itself, and
   *   - a `supersedes` pointer hides its target when — and only when — the
   *     target's operator matches this record's operator.
   *
   * Operator identity is the on-chain-derived `operator.agentId` the DiscoveryAPI
   * supplies on each hit (IdentityRegistry event → indexer `row.agentId`), NOT the
   * envelope `participant.safeAddress`. participant.safeAddress is free-form IPFS
   * manifest content the publisher writes at will; keying the same-operator check
   * off it would let a forged address grief default discovery. agentId is not
   * forgeable in this way — a record is only indexed under its publisher's real
   * agentId — so a supersede fires only against the same on-chain operator. The
   * match is fail-safe: an absent agentId never matches, so an unattributed record
   * collapses nothing. Residual (narrower): the supersede intent itself is not yet
   * signature-verified end-to-end; tracked in spec/2026-07-06-distillation-v1.md §16.
   *
   * O(page) window (DECISION #3, no indexer change): a supersede is honored
   * only when BOTH successor and target land in the same fetched page (spec
   * §5/§16). Head-resolution is fail-safe: an unfetchable body hides nothing
   * (mirrors the warn+continue on the manifest-scan path above).
   */
  async function resolveHeads(hits: CorpusSearchHit[]): Promise<CorpusSearchHit[]> {
    const lineage = new Map<string, { op: string; supersedes?: string; deprecates?: boolean }>();
    for (const h of hits) {
      if (h.kind !== 'skill') continue;
      try {
        const record = await get(h.ref);
        const prov = extractSkill(record)?.skill.provenance;
        lineage.set(h.ref, {
          // Operator identity from the on-chain-derived `operator.agentId` the
          // DiscoveryAPI supplies on the hit (IdentityRegistry event → indexer
          // `row.agentId`, carried through `corpus.fetchManifest` untouched) —
          // NOT the envelope `participant.safeAddress`, which is free-form IPFS
          // manifest content the publisher writes at will (a forged value there
          // could grief default discovery). A record can only be indexed under
          // its publisher's real `agentId`, so a supersede pointer only fires
          // against the SAME on-chain operator.
          op: h.operator.agentId,
          supersedes: prov?.supersedes,
          deprecates: prov?.deprecates,
        });
      } catch (err) {
        console.warn(`[harness-layer] head-resolution skipping ${h.ref}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const excluded = new Set<string>();
    for (const [selfRef, info] of lineage) {
      if (info.deprecates === true) excluded.add(selfRef);
      if (info.supersedes) {
        const target = lineage.get(info.supersedes);
        // Same-operator only, fail-safe when identity is unknown: require both
        // agentIds non-empty and equal. An empty agentId (a backend that does
        // not attribute the hit) never matches, so an unattributable record
        // hides nothing rather than griefing.
        if (target && info.op && target.op && target.op === info.op) {
          excluded.add(info.supersedes);
        }
      }
    }
    return hits.filter((h) => !(h.kind === 'skill' && excluded.has(h.ref)));
  }

  async function search(
    query: string,
    opts: { limit?: number; kind?: 'skill' | 'trace'; includeSuperseded?: boolean } = {},
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
          ...(typeof metaHit.repositorySlug === 'string'
            ? { repositorySlug: metaHit.repositorySlug }
            : {}),
          ...(typeof metaHit.synthesis === 'string'
            ? { synthesis: metaHit.synthesis }
            : {}),
          ...(typeof metaHit.retrievalVisible === 'boolean'
            ? { retrievalVisible: metaHit.retrievalVisible }
            : {}),
          ...(typeof metaHit.verifiabilityTier === 'string'
            ? { verifiabilityTier: metaHit.verifiabilityTier }
            : {}),
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
    // Collapse to lineage heads (#1462) unless the caller opts out. Runs before
    // the kind filter so a superseded skill is dropped regardless of the filter.
    const heads = opts.includeSuperseded ? hits : await resolveHeads(hits);
    // Client-side kind filter (spec §5: the indexer has no artifactType column,
    // so this is a best-effort filter over the fetched page — a kind-filtered
    // search may return fewer than `limit` if other kinds consumed the budget).
    return opts.kind ? heads.filter((h) => h.kind === opts.kind) : heads;
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
