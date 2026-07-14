import type { PortResult } from '../outcome.js';
import type { EpisodeV1 } from '../schemas/episode.js';

export interface EvidenceListQuery {
  limit?: number;
}

export interface EvidenceRetentionPolicy {
  policy: 'local-private' | 'contribution-eligible';
  maxEpisodes: number;
}

export interface EvidencePort {
  put(episode: EpisodeV1): Promise<PortResult<{ episodeId: string }>>;
  get(episodeId: string): Promise<PortResult<EpisodeV1 | null>>;
  list(query?: EvidenceListQuery): Promise<PortResult<EpisodeV1[]>>;
  retention(): Promise<PortResult<EvidenceRetentionPolicy>>;
}
