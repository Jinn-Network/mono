/**
 * Skill recognition (#1394): the shared install-path helper.
 *
 * `extractSkill(record)` prefers a first-class `jinn.skill.v1` artifact and
 * falls back to the seeded shape (episode/legacy trace artifact ->
 * `seed:skill-md` step -> `skill.md` attribute + `seed.attribution`),
 * synthesising an equivalent provenance block from the embedded fields.
 */

import { z } from 'zod/v3';
import {
  SKILL_ARTIFACT_TYPE,
  SkillArtifactV1Schema,
  type SkillArtifactV1,
} from '../../../src/types/skill-artifact.js';
import { EpisodeV1Schema } from '@jinn-network/plugin';
import type { CorpusRecord } from './consume.js';
import {
  EPISODE_ARTIFACT_TYPE,
  TRACE_ENVELOPE_ARTIFACT_TYPE,
} from './publish.js';
import { parseTraceEnvelopeV0 } from './envelope.js';
import { frontmatterName, skillSlug } from './seed-import/execute.js';

export interface ExtractedSkill {
  skill: SkillArtifactV1;
  /** Which carrier the skill came from. */
  shape: 'jinn.skill.v1' | 'seeded-episode' | 'seeded-trace';
}

const SeedAttributionSchema = z.object({
  skill: z.string().min(1),
  source: z.string().min(1),
  licence: z.string().nullable(),
});

function parseJson(content: Buffer): unknown {
  return JSON.parse(content.toString('utf-8'));
}

/**
 * Extract the skill carried by a corpus record, or null when the record
 * carries none. Throws when a `jinn.skill.v1` artifact is present but
 * malformed — a corrupt first-class skill is an error, not a fall-through.
 */
export function extractSkill(record: CorpusRecord): ExtractedSkill | null {
  const skillArtifact = record.artifacts.find((a) => a.artifactType === SKILL_ARTIFACT_TYPE);
  if (skillArtifact) {
    return {
      skill: SkillArtifactV1Schema.parse(parseJson(skillArtifact.content)),
      shape: 'jinn.skill.v1',
    };
  }

  const episodeArtifact = record.artifacts.find(
    (a) => a.artifactType === EPISODE_ARTIFACT_TYPE,
  );
  const traceArtifact = episodeArtifact
    ? undefined
    : record.artifacts.find((a) => a.artifactType === TRACE_ENVELOPE_ARTIFACT_TYPE);
  const carrier = episodeArtifact ?? traceArtifact;
  if (!carrier) return null;

  let steps;
  try {
    steps = episodeArtifact
      ? EpisodeV1Schema.parse(parseJson(carrier.content)).trajectory
      : parseTraceEnvelopeV0(parseJson(carrier.content)).steps;
  } catch {
    return null; // malformed evidence carrier — do not silently use a second shape
  }
  const step = steps.find((candidate) => candidate.name === 'seed:skill-md');
  const skillMd = step?.attributes['skill.md'];
  if (typeof skillMd !== 'string' || skillMd.length === 0) return null;
  const attribution = SeedAttributionSchema.safeParse(step!.attributes['seed.attribution']);
  const seed = attribution.success ? attribution.data : undefined;
  return {
    skill: {
      schemaVersion: SKILL_ARTIFACT_TYPE,
      skill: {
        name: frontmatterName(skillMd) ?? (seed ? skillSlug(seed.skill) : 'skill'),
        skillMd,
      },
      files: [],
      provenance: {
        kind: 'imported',
        // [] for seed imports (the schema's documented convention, matching
        // first-class seed artifacts) — callers already hold record.ref.
        sourceEnvelopeCids: [],
        operator: { safeAddress: record.envelope.participant.safeAddress },
        ...(seed ? { seed } : {}),
      },
    },
    shape: episodeArtifact ? 'seeded-episode' : 'seeded-trace',
  };
}
