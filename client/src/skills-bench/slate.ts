import { createHash } from 'node:crypto';

export interface SlateCandidate {
  instance_id: string;
  repo: string;
  hf_dataset: string;
  hf_split: string;
}

export interface SplitOptions {
  seed: string;
  feedbackSize: number;
  holdoutSize: number;
}

export interface SkillsBenchSlate {
  version: 'skills-bench-slate.v1';
  seed: string;
  feedback: SlateCandidate[];
  holdout: SlateCandidate[];
  sha256: string;
}

function rankKey(seed: string, id: string): string {
  return createHash('sha256').update(`${seed}:${id}`).digest('hex');
}

export function hashSlate(slate: Omit<SkillsBenchSlate, 'sha256'>): string {
  const canonical = JSON.stringify({
    version: slate.version,
    seed: slate.seed,
    feedback: slate.feedback.map((c) => c.instance_id),
    holdout: slate.holdout.map((c) => c.instance_id),
  });
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * Seed-deterministic split: candidates are ranked by sha256(seed, instance_id),
 * then assigned alternately (even rank → feedback, odd → holdout) until each
 * half is full. Alternation balances difficulty drift better than a prefix cut
 * and keeps the split a pure function of (seed, membership).
 */
export function splitSlate(candidates: SlateCandidate[], opts: SplitOptions): SkillsBenchSlate {
  const need = opts.feedbackSize + opts.holdoutSize;
  const unique = [...new Map(candidates.map((c) => [c.instance_id, c])).values()];
  if (unique.length < need) {
    throw new Error(`pool too small: ${unique.length} candidates for ${need} slots`);
  }
  const ranked = [...unique].sort((a, b) =>
    rankKey(opts.seed, a.instance_id).localeCompare(rankKey(opts.seed, b.instance_id)));
  const feedback: SlateCandidate[] = [];
  const holdout: SlateCandidate[] = [];
  for (const c of ranked) {
    if (feedback.length + holdout.length === need) break;
    if ((feedback.length + holdout.length) % 2 === 0 && feedback.length < opts.feedbackSize) feedback.push(c);
    else if (holdout.length < opts.holdoutSize) holdout.push(c);
    else feedback.push(c);
  }
  const body = { version: 'skills-bench-slate.v1' as const, seed: opts.seed, feedback, holdout };
  return { ...body, sha256: hashSlate(body) };
}
