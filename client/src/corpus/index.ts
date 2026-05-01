/**
 * Corpus library entry point.
 *
 * Spec: spec/2026-04-30-phase-a-umbrella.md §2.
 */

import type {
  Corpus,
  CorpusOptions,
  CorpusQuery,
  EnvelopeRef,
  ManifestPreview,
  Envelope,
  ArtifactContent,
  ReadArgs,
} from './types.js';
import { runCorpusQuery } from './query.js';
import { fetchManifest } from './fetch.js';
import { acquireArtifactContent } from './acquire.js';

export type {
  Corpus,
  CorpusOptions,
  CorpusQuery,
  EnvelopeRef,
  ManifestPreview,
  Envelope,
  ArtifactContent,
  ReadArgs,
  RouteResolver,
} from './types.js';
export { CorpusQueryError, ManifestFetchError, AcquireError, HashMismatchError } from './types.js';
export { noopRouteResolver } from './route-resolver.js';
export { getCachedArtifact, hasCachedArtifact } from './cache.js';

interface InternalDeps {
  fetch?: typeof globalThis.fetch;
  fetchFromIpfs?: (gatewayUrl: string, cid: string) => Promise<unknown>;
  acquireFn?: (endpoint: string, sha256: string, privateKey: string) => Promise<Buffer | null>;
}

export function createCorpus(opts: CorpusOptions, deps: InternalDeps = {}): Corpus {
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const fetchFromIpfsImpl = deps.fetchFromIpfs;
  const acquireFn = deps.acquireFn;

  async function query(q: CorpusQuery): Promise<EnvelopeRef[]> {
    return runCorpusQuery(opts.subgraphUrl, q, fetchImpl);
  }

  async function fetchOne(ref: EnvelopeRef): Promise<ManifestPreview> {
    return fetchManifest(ref, opts.ipfsGatewayUrl, fetchFromIpfsImpl);
  }

  async function acquire(manifest: ManifestPreview): Promise<Envelope> {
    const contents = new Map<string, ArtifactContent>();
    for (const a of manifest.envelope.artifacts) {
      const ac = await acquireArtifactContent({
        sha256: a.sha256,
        artifactType: a.artifactType,
        access: a.access,
        store: opts.store,
        selfSafeAddress: opts.selfSafeAddress,
        privateKey: opts.signer.privateKey,
        routeResolver: opts.routeResolver,
        envelopeCid: manifest.ref.manifestCid,
        ownerSafe: manifest.envelope.participant.safeAddress,
        acquireFn,
      });
      contents.set(a.sha256, ac);
    }
    return { ref: manifest.ref, envelope: manifest.envelope, artifactContents: contents };
  }

  async function acquireBySha256(
    sha256: string,
    access: { endpoint: string; priceUsdc: string },
    hint?: { artifactType?: string; envelopeCid?: string },
  ): Promise<ArtifactContent> {
    return acquireArtifactContent({
      sha256,
      artifactType: hint?.artifactType ?? 'unknown',
      access,
      store: opts.store,
      selfSafeAddress: opts.selfSafeAddress,
      privateKey: opts.signer.privateKey,
      routeResolver: opts.routeResolver,
      envelopeCid: hint?.envelopeCid,
      acquireFn,
    });
  }

  async function read(args: ReadArgs): Promise<Envelope[]> {
    const refs = await query(args.query);
    const previews: ManifestPreview[] = [];
    for (const ref of refs) {
      previews.push(await fetchOne(ref));
    }
    // Post-fetch kind filter (subgraph index doesn't expose intent kind; spec §10 Q6).
    const kindFilter = args.query.kind;
    const kindFiltered = kindFilter ? previews.filter((p) => p.envelope.kind === kindFilter) : previews;
    const selected = args.select ? args.select(kindFiltered) : kindFiltered;
    const envelopes: Envelope[] = [];
    for (const sel of selected) {
      envelopes.push(await acquire(sel));
    }
    return envelopes;
  }

  return {
    read,
    query,
    fetchManifest: fetchOne,
    acquire,
    acquireBySha256,
  };
}
