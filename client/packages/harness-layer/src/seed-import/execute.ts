/**
 * `execute()` — publish the approved import rows through the Task-4 path
 * (plan Task 6, spec §7).
 *
 * Each imported skill becomes a synthetic captured task carrying the
 * SKILL.md as its single step, runs through the SAME mandatory scrub
 * (`capture()`) and the SAME publish/anchor path (`publish()`) as a real
 * contribution — one publish path, per the 2026-07-02 schema review — with
 * `provenance: 'imported'` and attribution metadata in the step attributes.
 * Seeds are thereby excluded from the demand signal and from emissions
 * eligibility by every provenance-aware reader.
 *
 * The licence gate is structural, not advisory: execute() re-checks each
 * row's licence from the freshly-fetched source. A verdict hand-edited to
 * `import` over a non-allowlisted licence is refused — widening the gate is
 * a code change to the disclosed allowlist, reviewable in a PR, not a
 * report-file edit.
 *
 * Idempotent by seed identity (issue #1771, `state.ts`): re-running execute
 * over an unchanged skill publishes nothing new (a `skipped` row instead);
 * re-running over a CHANGED skill (different skillMd/description/licence/
 * source) republishes and sets the new record's
 * `provenance.supersedes` to the prior envelopeRef. `opts.state` defaults to
 * a fresh in-memory store per call, so existing callers that never pass one
 * see unchanged behaviour (every row always publishes) — the CLI wires a
 * file-backed store for real runs (cli.ts, `seed execute`).
 */

import type { SkillArtifactV1 } from '../../../../src/types/skill-artifact.js';
import { capture } from '../capture.js';
import type { CapturedTask } from '../capture.js';
import { buildSeedScrubPipeline } from '../../../../src/trajectory/scrub/build.js';
import { publish, type HarnessPublishDeps } from '../publish.js';
import { checkLicence } from './licence.js';
import type { SeedSkill, SeedSource } from './fetch.js';
import type { ImportReport } from './report.js';
import {
  createMemorySeedImportState,
  hashSeedContent,
  type SeedImportStateStore,
} from './state.js';

export interface ImportResult {
  imported: Array<{
    skill: string;
    envelopeRef: string;
    anchorTx: string | null;
    /** Publication succeeded, but local lineage state needs operator recovery. */
    stateWarning?: string;
  }>;
  skipped: Array<{ skill: string; reason: string }>;
  errors: Array<{ skill: string; error: string }>;
}

/** Caps from the frozen envelope schema (envelope-v0.md size limits). */
const MAX_TAG_CHARS = 64;
const MAX_TAGS = 16;

/**
 * Extract `name:` from a SKILL.md YAML frontmatter block, if present.
 * Deliberately a line-parser, not a YAML dependency — skill frontmatter
 * names are plain scalars; anything more exotic simply yields no tag.
 */
export function frontmatterName(skillMd: string): string | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(skillMd);
  if (!match) return null;
  for (const line of match[1]!.split(/\r?\n/)) {
    const kv = /^name:\s*(.+)$/.exec(line.trim());
    if (kv) {
      const value = kv[1]!.trim().replace(/^["']|["']$/g, '').trim();
      return value || null;
    }
  }
  return null;
}

/** Last path segment of a registry-style skill id (`owner/repo/slug`). */
export function skillSlug(skillId: string): string {
  const segments = skillId.split('/').filter((s) => s.length > 0);
  return segments[segments.length - 1] ?? skillId;
}

/**
 * Seed tags (#1343): the seed marker, the repo, the skill slug (last path
 * segment), and the SKILL.md frontmatter name when it declares one. Tags are
 * freeform under the frozen schema (envelope-v0.md: no fixed taxonomy) but
 * the size caps are structural — dedupe, clamp to 64 chars, cap at 16.
 * The signal's authoritative seed marker stays `provenance: 'imported'`;
 * `seed-import` is honest labelling on top.
 */
function seedTags(skill: SeedSkill): string[] {
  const segments = skill.skill.split('/').filter((s) => s.length > 0);
  const repoName = segments[1] ?? skill.skill;
  const slug = skillSlug(skill.skill);
  const name = frontmatterName(skill.skillMd);
  const tags: string[] = [];
  for (const candidate of ['seed-import', repoName, slug, ...(name ? [name] : [])]) {
    const tag = candidate.trim().slice(0, MAX_TAG_CHARS);
    if (tag && !tags.includes(tag)) tags.push(tag);
  }
  return tags.slice(0, MAX_TAGS);
}

function toCapturedTask(skill: SeedSkill, now: Date): CapturedTask {
  const nano = `${now.getTime()}000000`;
  return {
    session: {
      sessionId: `seed:${skill.skill}`,
      capturedAt: now.toISOString(),
    },
    task: {
      summary: `Seed import: ${skill.skill}${skill.description ? ` — ${skill.description}` : ''}`,
      distributionTags: seedTags(skill),
    },
    environment: {
      harness: { name: 'jinn-layer-seed-import', version: '0.1.0' },
      model: 'none',
      tools: [],
    },
    steps: [
      {
        spanId: 'seed-1',
        parentSpanId: null,
        name: 'seed:skill-md',
        startTimeUnixNano: nano,
        endTimeUnixNano: nano,
        attributes: {
          'skill.md': skill.skillMd,
          'seed.attribution': {
            skill: skill.skill,
            source: skill.source,
            licence: skill.licence,
          },
        },
        redactedKeys: [],
      },
    ],
    outcome: {
      // user-accepted is literal here: the human approved this exact list.
      status: 'completed',
      verifiabilityTier: 'user-accepted',
    },
    cost: { durationMs: 0 },
    provenance: 'imported',
  };
}

/** First-class skill artifact for a seed (#1394). Companion-file fetch is #1381. */
function toSkillArtifact(
  skill: SeedSkill,
  safeAddress: `0x${string}`,
  supersedes?: string,
): SkillArtifactV1 {
  return {
    schemaVersion: 'jinn.skill.v1',
    skill: {
      name: frontmatterName(skill.skillMd) ?? skillSlug(skill.skill),
      ...(skill.description !== undefined ? { description: skill.description } : {}),
      skillMd: skill.skillMd,
    },
    files: [],
    provenance: {
      kind: 'imported',
      sourceEnvelopeCids: [],
      operator: { safeAddress },
      seed: { skill: skill.skill, source: skill.source, licence: skill.licence },
      ...(supersedes ? { supersedes } : {}),
    },
  };
}

/** The content fields that define "did this seed change" for idempotency (state.ts). */
function skillContentFingerprint(skill: SeedSkill): unknown {
  return {
    skillMd: skill.skillMd,
    description: skill.description ?? null,
    licence: skill.licence,
    source: skill.source,
  };
}

export async function execute(
  report: ImportReport,
  source: SeedSource,
  deps: HarnessPublishDeps,
  opts: { state?: SeedImportStateStore } = {},
): Promise<ImportResult> {
  const skills = new Map((await source.list()).map((s) => [s.skill, s]));
  const result: ImportResult = { imported: [], skipped: [], errors: [] };
  const now = deps.now?.() ?? new Date();
  // Seed profile (#1409): deterministic secret detectors only. Seeds are
  // public licence-checked prose, not operator trace data — the
  // probabilistic stages false-positive on SKILL.md content and defaced
  // the anchored corpus. Capture stays mandatory and fail-closed.
  const seedScrubPipeline = buildSeedScrubPipeline();
  const state = opts.state ?? createMemorySeedImportState();

  for (const row of report) {
    if (row.verdict === 'skip') {
      result.skipped.push({ skill: row.skill, reason: row.reason });
      continue;
    }
    try {
      const skill = skills.get(row.skill);
      if (!skill) throw new Error(`skill ${row.skill} not found in source ${source.name}`);
      const licence = checkLicence(skill.licence);
      if (licence.verdict !== 'import') {
        throw new Error(`licence gate refused ${row.skill}: ${licence.reason}`);
      }

      const identity = `skill:${skill.skill}`;
      const contentHash = hashSeedContent(skillContentFingerprint(skill));
      const prior = state.get(identity);
      if (prior && prior.contentHash === contentHash) {
        result.skipped.push({ skill: row.skill, reason: `unchanged since ${prior.envelopeRef}` });
        continue;
      }

      const pending = await capture(toCapturedTask(skill, now), {
        pipeline: seedScrubPipeline,
      });
      const published = await publish(pending, deps, {
        skill: toSkillArtifact(skill, deps.participant.safeAddress, prior?.envelopeRef),
      });
      if (published.vetoed) throw new Error('unexpected veto on seed publish');
      let stateWarning: string | undefined;
      try {
        state.set(identity, { contentHash, envelopeRef: published.envelopeRef, publishedAt: now.toISOString() });
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        stateWarning =
          `published ${published.envelopeRef}, but seed-import state persistence failed: ${detail}; ` +
          'recovery required before retrying this seed';
      }
      result.imported.push({
        skill: row.skill,
        envelopeRef: published.envelopeRef,
        anchorTx: published.anchorTx,
        ...(stateWarning ? { stateWarning } : {}),
      });
    } catch (err) {
      result.errors.push({
        skill: row.skill,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return result;
}
