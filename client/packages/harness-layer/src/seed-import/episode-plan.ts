/**
 * `planEpisodes()` — list + structural validation, ZERO writes (mirrors
 * `plan.ts` for the evidence-episode source, issue #1771). Episodes are
 * first-party content (no licence gate); the only structural failure this
 * catches is a duplicate `id` within one batch — a same-identity collision
 * would otherwise make idempotency (state.ts) apply to whichever file lists
 * second, silently dropping the first from the report.
 */

import type { EpisodeSource, SeedEpisode } from './episode-fetch.js';
import type { EpisodeImportReport } from './episode-report.js';

export async function planEpisodes(source: EpisodeSource): Promise<EpisodeImportReport> {
  const episodes = await source.list();
  const seen = new Set<string>();
  return episodes.map((episode: SeedEpisode) => {
    const duplicate = seen.has(episode.id);
    seen.add(episode.id);
    return {
      id: episode.id,
      taskSummary: episode.taskSummary,
      tags: episode.tags,
      verdict: duplicate ? 'skip' : 'import',
      reason: duplicate
        ? `duplicate id "${episode.id}" in source — first occurrence wins`
        : 'first-party recorded episode',
    } as const;
  });
}
