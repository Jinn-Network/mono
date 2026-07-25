import type {
  CorpusRecord,
  EpisodeV1,
} from '@jinn-network/plugin';

export interface EpisodeRecordProjection {
  ref: string;
  origin: string;
  retrievalVisible: boolean;
  isSkillPayload?: boolean;
}

function seedStepSynthesis(
  steps: EpisodeV1['trajectory'],
): string | undefined {
  for (const step of steps) {
    const value = step.attributes['seed.synthesis'];
    if (typeof value === 'string' && value.trim().length > 0) return value;
  }
  return undefined;
}

function hasSkillMdAttribute(steps: EpisodeV1['trajectory']): boolean {
  return steps.some((step) => {
    const value = step.attributes['skill.md'];
    return typeof value === 'string' && value.length > 0;
  });
}

export function episodeToCorpusRecord(
  episode: EpisodeV1,
  projection: EpisodeRecordProjection,
): CorpusRecord {
  const synthesis =
    episode.outcome.summary ?? seedStepSynthesis(episode.trajectory);
  const isSkillPayload =
    projection.isSkillPayload === true
    || hasSkillMdAttribute(episode.trajectory);

  return {
    ref: projection.ref,
    canonicalEpisodeId: episode.episodeId,
    task: {
      summary: episode.task.summary,
      ...(episode.task.repositorySlug
        ? { repositorySlug: episode.task.repositorySlug }
        : {}),
    },
    outcome: {
      status: episode.outcome.status,
      verifiabilityTier: episode.outcome.verificationStrength,
    },
    ...(synthesis ? { synthesis } : {}),
    steps: episode.trajectory.map((step) => ({
      name: step.name,
      attributes: step.attributes,
    })),
    tags: episode.task.distributionTags,
    provenance: episode.provenance,
    origin: projection.origin,
    capturedAt: episode.session.capturedAt,
    retrievalVisible: projection.retrievalVisible,
    ...(isSkillPayload ? { isSkillPayload: true } : {}),
  };
}
