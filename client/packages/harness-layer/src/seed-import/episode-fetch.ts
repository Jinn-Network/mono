/**
 * Evidence-episode seed source (issue #1771, rescope plan §4.2-§4.4).
 *
 * Stage 1's rescoped retrieval serves evidence records, not skill records
 * (docs/superpowers/plans/2026-07-16-jinn-plugin-stage-1-rescope-plan.md
 * §3.1). The shared testnet corpus had almost no evidence to serve — skills.sh
 * skill seeds only. This source reads a directory of hand-authored
 * seed-episode JSON files (each transformed offline from a REAL completed
 * session per the runbook, docs/runbooks/stage1-evidence-seeding.md) and
 * feeds them through the SAME `capture() -> publish()` path the skill lane
 * uses (`episode-execute.ts`), so a seeded evidence record is
 * indistinguishable on the wire from an organically captured one.
 *
 * Step convention (so a future retrieval-side packet projector — rescope
 * plan §3.2 `projectKnowledgePacket`, R1/#1770 — has an obvious, discoverable
 * shape to read): every content step's `attributes` carries
 *   'seed.step.label' — one of the §3.2 excerpt labels
 *                        ('failure' | 'fix' | 'command' | 'diff' | 'note')
 *   'seed.step.title' — a short human title
 *   'seed.step.text'  — the excerpt content itself
 * and a final step carries the episode-level metadata:
 *   'seed.synthesis'   — the authored how-it-was-solved text (§3.2 `synthesis`)
 *   'seed.attribution' — { repo, baseCommit?, origin, sourceUrl?, supersedes? }
 * No bespoke fixture format: this is exactly the frozen jinn.trace-envelope.v0
 * step shape (spec §3.1), the same free-form-attribute convention the
 * existing `seed:skill-md` skill-seed step already uses.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { OutcomeStatusSchema, VerifiabilityTierSchema } from '../envelope.js';

/** Rescope plan §3.2 excerpt labels — the knowledge-packet projection's vocabulary. */
export const SEED_EPISODE_EXCERPT_LABELS = ['failure', 'fix', 'command', 'diff', 'note'] as const;
export const SeedEpisodeExcerptLabelSchema = z.enum(SEED_EPISODE_EXCERPT_LABELS);
export type SeedEpisodeExcerptLabel = z.infer<typeof SeedEpisodeExcerptLabelSchema>;

export const SeedEpisodeStepSchema = z.strictObject({
  label: SeedEpisodeExcerptLabelSchema,
  title: z.string().min(1),
  text: z.string().min(1),
});
export type SeedEpisodeStep = z.infer<typeof SeedEpisodeStepSchema>;

/**
 * A seed-episode file — the canonical captured-evidence contract (issue
 * #1771): task summary, ordered steps with real commands/outputs (a source
 * episode carries at least one `failure` and its `fix`; distractors are
 * freeform), outcome + verifiability tier, tags, attribution, and an
 * authored synthesis. Strict: an unknown field is a malformed fixture, not
 * silently tolerated.
 */
export const SeedEpisodeSchema = z.strictObject({
  /** Stable seed identity — the idempotency key (state.ts) and filename stem. */
  id: z.string().min(1),
  /** `owner/repo` the episode re-performs work in/against. */
  repo: z.string().min(1),
  /** Full 40-char commit sha the episode was re-performed AT (pre-fix state), when applicable. */
  baseCommit: z.string().regex(/^[0-9a-f]{40}$/, 'full 40-char commit sha').optional(),
  taskSummary: z.string().min(1).max(500),
  tags: z.array(z.string().min(1)).min(1),
  steps: z.array(SeedEpisodeStepSchema).min(1),
  outcome: z.strictObject({
    status: OutcomeStatusSchema,
    verifiabilityTier: VerifiabilityTierSchema,
  }),
  /** 3-6 sentence how-it-was-solved text (rescope plan §3.2 `synthesis`). */
  synthesis: z.string().min(1),
  attribution: z.strictObject({
    /**
     * How this episode entered the corpus — stated honestly. Vocabulary in
     * use (freeform by schema; document new values in
     * docs/runbooks/stage1-evidence-seeding.md):
     * - 'operator-recorded-session' — transformed from a real recorded
     *   session; pair with `sourceUrl` when it re-performs a merged fix.
     * - 'operator-authored-distractor' — hand-authored negative/contrast
     *   material that must not claim the recorded-session evidentiary
     *   standard (PR #1779 review).
     */
    origin: z.string().min(1),
    /** Link to the real merged fix, when the episode re-performs one. */
    sourceUrl: z.string().min(1).optional(),
  }),
});
export type SeedEpisode = z.infer<typeof SeedEpisodeSchema>;

/** Parse an untrusted value (a seed-episode JSON file) as a SeedEpisode; throws ZodError. */
export function parseSeedEpisode(input: unknown): SeedEpisode {
  return SeedEpisodeSchema.parse(input);
}

export interface EpisodeSource {
  name: string;
  list(): Promise<SeedEpisode[]>;
}

/**
 * Local directory seed source: every `*.episode.json` file in `dir`,
 * validated against `SeedEpisodeSchema`. Sorted by filename for
 * deterministic plan/execute ordering (reproducible report files; the
 * fixture-lint test pins this too). Files not matching the `.episode.json`
 * suffix (e.g. the skill-shaped distractor fixtures) are ignored by
 * construction — episodes and skills are separate lanes.
 */
export function createLocalEpisodeSeedSource(dir: string): EpisodeSource {
  return {
    name: `local-episodes:${dir}`,
    async list(): Promise<SeedEpisode[]> {
      const files = readdirSync(dir)
        .filter((f) => f.endsWith('.episode.json'))
        .sort();
      return files.map((f) => parseSeedEpisode(JSON.parse(readFileSync(join(dir, f), 'utf-8'))));
    },
  };
}
