import { acquireArtifactContent } from './acquire.js';
import { fetchManifest } from './fetch.js';
import type {
  ArtifactContent,
  Corpus,
  CorpusDeps,
  CorpusEnvelope,
  CorpusManifest,
  CorpusOptions,
  CorpusQuery,
  EnvelopeRef,
  ManifestPreview,
  ReadArgs,
} from './types.js';

export function createCorpus<TEnvelope extends CorpusManifest>(
  options: CorpusOptions<TEnvelope>,
  deps: CorpusDeps = {},
): Corpus<TEnvelope> {
  async function query(query: CorpusQuery): Promise<EnvelopeRef[]> {
    let refs: EnvelopeRef[];
    if (options.discovery) {
      try {
        refs = await options.discovery.queryEnvelopes(query);
      } catch (error) {
        throw new Error(
          `corpus query failed (discovery): ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    } else if (options.legacyQuery) {
      try {
        refs = await options.legacyQuery(query);
      } catch (error) {
        throw new Error(
          `corpus query failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    } else {
      refs = [];
    }
    const deduped = new Map<string, EnvelopeRef>();
    for (const ref of refs) {
      if (!deduped.has(ref.manifestCid)) deduped.set(ref.manifestCid, ref);
    }
    return [...deduped.values()];
  }

  function fetchOne(ref: EnvelopeRef): Promise<ManifestPreview<TEnvelope>> {
    return fetchManifest(ref, options.ipfsGatewayUrl, {
      ...(deps.fetchFromIpfs ? { fetchFromIpfs: deps.fetchFromIpfs } : {}),
      parseEnvelope: options.parseEnvelope,
    });
  }

  async function acquire(
    manifest: ManifestPreview<TEnvelope>,
  ): Promise<CorpusEnvelope<TEnvelope>> {
    const contents = new Map<string, ArtifactContent>();
    for (const artifact of manifest.envelope.artifacts) {
      const content = await acquireArtifactContent({
        sha256: artifact.sha256,
        artifactType: artifact.artifactType,
        access: artifact.access,
        store: options.store,
        selfSafeAddress: options.selfSafeAddress,
        privateKey: options.signer.privateKey,
        routeResolver: options.routeResolver,
        envelopeCid: manifest.ref.manifestCid,
        sources: artifact.sources,
        ipfsGatewayUrl: options.ipfsGatewayUrl,
        ownerSafe: manifest.envelope.participant.safeAddress,
        acquireFn: deps.acquireFn,
        fetchFromIpfs: deps.fetchFromIpfs,
      });
      contents.set(artifact.sha256, content);
    }
    return {
      ref: manifest.ref,
      envelope: manifest.envelope,
      artifactContents: contents,
    };
  }

  async function acquireBySha256(
    sha256: string,
    access: { endpoint: string; priceUsdc: string },
    hint: {
      artifactType?: string;
      envelopeCid?: string;
      sources?: import('./types.js').ArtifactSource[];
      ownerSafe?: string;
    } = {},
  ): Promise<ArtifactContent> {
    return acquireArtifactContent({
      sha256,
      artifactType: hint.artifactType ?? 'unknown',
      access,
      store: options.store,
      selfSafeAddress: options.selfSafeAddress,
      privateKey: options.signer.privateKey,
      routeResolver: options.routeResolver,
      envelopeCid: hint.envelopeCid,
      sources: hint.sources,
      ipfsGatewayUrl: options.ipfsGatewayUrl,
      ownerSafe: hint.ownerSafe,
      acquireFn: deps.acquireFn,
      fetchFromIpfs: deps.fetchFromIpfs,
    });
  }

  async function read(
    args: ReadArgs<TEnvelope>,
  ): Promise<CorpusEnvelope<TEnvelope>[]> {
    const refs = await query(args.query);
    const previews: ManifestPreview<TEnvelope>[] = [];
    for (const ref of refs) previews.push(await fetchOne(ref));
    const solverType = args.query.solverType;
    const matching = solverType
      ? previews.filter((preview) => preview.envelope.solverType === solverType)
      : previews;
    const selected = args.select ? args.select(matching) : matching;
    const envelopes: CorpusEnvelope<TEnvelope>[] = [];
    for (const preview of selected) envelopes.push(await acquire(preview));
    return envelopes;
  }

  return { read, query, fetchManifest: fetchOne, acquire, acquireBySha256 };
}
