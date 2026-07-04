/**
 * Skill recognition (#1394): the shared install-path helper.
 *
 * `extractSkill(record)` prefers a first-class `jinn.skill.v1` artifact and
 * falls back to the seeded shape (trace-envelope artifact -> `seed:skill-md`
 * step -> `skill.md` attribute + `seed.attribution`), synthesising an
 * equivalent provenance block from the legacy fields — backwards-compatible
 * with every seed published before the first-class type existed.
 */

import { z } from 'zod/v3';
import {
  SKILL_ARTIFACT_TYPE,
  SkillArtifactV1Schema,
  type SkillArtifactV1,
} from '../../../src/types/skill-artifact.js';
import type { CorpusRecord } from './consume.js';
import { TRACE_ENVELOPE_ARTIFACT_TYPE } from './publish.js';
import { parseTraceEnvelopeV0 } from './envelope.js';
import { frontmatterName, skillSlug } from './seed-import/execute.js';

export interface ExtractedSkill {
  skill: SkillArtifactV1;
  /** Which carrier the skill came from. */
  shape: 'jinn.skill.v1' | 'seeded-trace';
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

  // Legacy seeded shape (pre-#1394 seed imports).
  const traceArtifact = record.artifacts.find(
    (a) => a.artifactType === TRACE_ENVELOPE_ARTIFACT_TYPE,
  );
  if (!traceArtifact) return null;
  let trace;
  try {
    trace = parseTraceEnvelopeV0(parseJson(traceArtifact.content));
  } catch {
    return null; // not a valid trace envelope — no skill here
  }
  const step = trace.steps.find((s) => s.name === 'seed:skill-md');
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
        sourceEnvelopeCids: [record.ref],
        operator: { safeAddress: record.envelope.participant.safeAddress },
        ...(seed ? { seed } : {}),
      },
    },
    shape: 'seeded-trace',
  };
}
