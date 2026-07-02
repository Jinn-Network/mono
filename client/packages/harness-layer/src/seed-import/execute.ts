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
 */

import { capture } from '../capture.js';
import type { CapturedTask } from '../capture.js';
import { publish, type HarnessPublishDeps } from '../publish.js';
import { checkLicence } from './licence.js';
import type { SeedSkill, SeedSource } from './fetch.js';
import type { ImportReport } from './report.js';

export interface ImportResult {
  imported: Array<{ skill: string; envelopeRef: string; anchorTx: string | null }>;
  skipped: Array<{ skill: string; reason: string }>;
  errors: Array<{ skill: string; error: string }>;
}

function toCapturedTask(skill: SeedSkill, now: Date): CapturedTask {
  const nano = `${now.getTime()}000000`;
  const repoName = skill.skill.split('/')[1] ?? skill.skill;
  return {
    session: {
      sessionId: `seed:${skill.skill}`,
      capturedAt: now.toISOString(),
    },
    task: {
      summary: `Seed import: ${skill.skill}${skill.description ? ` — ${skill.description}` : ''}`,
      distributionTags: ['seed-import', repoName],
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

export async function execute(
  report: ImportReport,
  source: SeedSource,
  deps: HarnessPublishDeps,
): Promise<ImportResult> {
  const skills = new Map((await source.list()).map((s) => [s.skill, s]));
  const result: ImportResult = { imported: [], skipped: [], errors: [] };
  const now = deps.now?.() ?? new Date();

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
      const pending = await capture(toCapturedTask(skill, now));
      const published = await publish(pending, deps);
      if (published.vetoed) throw new Error('unexpected veto on seed publish');
      result.imported.push({
        skill: row.skill,
        envelopeRef: published.envelopeRef,
        anchorTx: published.anchorTx,
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
