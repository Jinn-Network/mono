import type { EvidenceListQuery, EvidencePort, EvidenceRetentionPolicy } from '../ports/evidence-port.js';
import type { EpisodeV1 } from '../schemas/episode.js';
import { ok } from '../outcome.js';

const DEFAULT_RETENTION: EvidenceRetentionPolicy = { policy: 'local-private', maxEpisodes: 200 };

export class InMemoryEvidencePort implements EvidencePort {
  private readonly episodes = new Map<string, EpisodeV1>();

  constructor(private readonly retentionPolicy: EvidenceRetentionPolicy = DEFAULT_RETENTION) {}

  async put(episode: EpisodeV1) {
    this.episodes.set(episode.episodeId, episode);
    return ok({ episodeId: episode.episodeId });
  }

  async get(episodeId: string) {
    return ok(this.episodes.get(episodeId) ?? null);
  }

  async list(query: EvidenceListQuery = {}) {
    const all = [...this.episodes.values()];
    return ok(query.limit ? all.slice(0, query.limit) : all);
  }

  async retention() {
    return ok(this.retentionPolicy);
  }
}
