import type {
  CorpusPort,
  CorpusRecord,
  EvidencePort,
  EpisodeV1,
  KnowledgeHit,
  PortResult,
} from '@jinn-network/plugin';
import {
  degraded,
  ok,
  unavailable,
} from '@jinn-network/plugin';
import { episodeToCorpusRecord } from './episode-record.js';

export const LOCAL_EPISODE_REF_PREFIX = 'local-episode:';

export function localEpisodeRef(episodeId: string): string {
  return `${LOCAL_EPISODE_REF_PREFIX}${encodeURIComponent(episodeId)}`;
}

function localEpisodeId(ref: string): string | null {
  if (!ref.startsWith(LOCAL_EPISODE_REF_PREFIX)) return null;
  try {
    const value = decodeURIComponent(ref.slice(LOCAL_EPISODE_REF_PREFIX.length));
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

export interface LocalEpisodeCorpusAdapterDeps {
  evidence: EvidencePort;
}

export function createLocalEpisodeCorpusAdapter(
  deps: LocalEpisodeCorpusAdapterDeps,
): CorpusPort {
  let snapshot: Promise<PortResult<EpisodeV1[]>> | undefined;
  const episodes = (): Promise<PortResult<EpisodeV1[]>> => {
    snapshot ??= deps.evidence.list();
    return snapshot;
  };

  function toHit(episode: EpisodeV1): KnowledgeHit {
    const publishedAt = Date.parse(episode.session.capturedAt);
    return {
      ref: localEpisodeRef(episode.episodeId),
      canonicalEpisodeId: episode.episodeId,
      kind: 'trace',
      snippet: episode.task.summary,
      tags: episode.task.distributionTags,
      tier: episode.outcome.verificationStrength,
      origin: `local:${episode.episodeId}`,
      ...(Number.isFinite(publishedAt) ? { publishedAt } : {}),
      recencyDomain: 'unix-ms',
      retrievalVisible: true,
    };
  }

  async function search(query: string): Promise<PortResult<KnowledgeHit[]>> {
    const result = await episodes();
    if (result.status === 'unavailable') {
      return unavailable(`local corpus: ${result.reason}`);
    }
    const needle = query.toLocaleLowerCase();
    const hits = (result.status === 'ok' ? result.value : result.value ?? [])
      .filter((episode) => [
        episode.task.summary,
        ...episode.task.distributionTags,
      ].some((value) => value.toLocaleLowerCase().includes(needle)))
      .map(toHit);
    return result.status === 'degraded'
      ? degraded(`local corpus: ${result.reason}`, hits)
      : ok(hits);
  }

  async function get(ref: string): Promise<PortResult<CorpusRecord | null>> {
    const episodeId = localEpisodeId(ref);
    if (episodeId === null) return ok(null);

    // Search is backed by the lazy list snapshot, which can contain supported
    // legacy captures that EvidencePort.get() cannot address by episode id.
    // Serve an advertised episode from that same read-only snapshot so
    // search/get stay symmetric without migrating or rewriting storage.
    if (snapshot !== undefined) {
      const listed = await snapshot;
      if (listed.status !== 'unavailable') {
        const listedEpisode = (listed.status === 'ok'
          ? listed.value
          : listed.value ?? [])
          .find((candidate) => candidate.episodeId === episodeId);
        if (listedEpisode !== undefined) {
          const value = episodeToCorpusRecord(listedEpisode, {
            ref,
            origin: `local:${listedEpisode.episodeId}`,
            retrievalVisible: true,
          });
          return listed.status === 'degraded'
            ? degraded(`local corpus: ${listed.reason}`, value)
            : ok(value);
        }
      }
    }

    const result = await deps.evidence.get(episodeId);
    if (result.status === 'unavailable') {
      return unavailable(`local corpus: ${result.reason}`);
    }
    const episode = result.status === 'ok' ? result.value : result.value ?? null;
    const value = episode === null
      ? null
      : episodeToCorpusRecord(episode, {
          ref,
          origin: `local:${episode.episodeId}`,
          retrievalVisible: true,
        });
    return result.status === 'degraded'
      ? degraded(`local corpus: ${result.reason}`, value)
      : ok(value);
  }

  return { search, get };
}
