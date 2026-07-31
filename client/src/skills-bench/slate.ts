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

/** An instance excluded from a slate by an operator (e.g. after
 *  `sweep-gradeability.ts` finds it ungradeable), recorded for audit and
 *  reproducibility rather than silently dropped. */
export interface ExcludedCandidate {
  instance_id: string;
  reason: string;
}

export interface SkillsBenchSlate {
  version: 'skills-bench-slate.v1';
  seed: string;
  feedback: SlateCandidate[];
  holdout: SlateCandidate[];
  /** Operator-driven exclusions (build-slate.ts --exclude-instances /
   *  --exclude-file). Absent/empty is equivalent for hashing purposes — see
   *  `hashSlate` — so pre-existing slate.json files (and the smoke2
   *  manifest) keep their historical sha256. */
  excluded?: ExcludedCandidate[];
  sha256: string;
}

function rankKey(seed: string, id: string): string {
  return createHash('sha256').update(`${seed}:${id}`).digest('hex');
}

export function hashSlate(slate: Omit<SkillsBenchSlate, 'sha256'>): string {
  const canonical: {
    version: string;
    seed: string;
    feedback: string[];
    holdout: string[];
    excluded?: { instance_id: string; reason: string }[];
  } = {
    version: slate.version,
    seed: slate.seed,
    feedback: slate.feedback.map((c) => c.instance_id),
    holdout: slate.holdout.map((c) => c.instance_id),
  };
  // Omit the key entirely when there is nothing to record, rather than
  // serializing `excluded: []` — keeps the hash of an unexcluded slate
  // byte-identical to how it hashed before this field existed.
  if (slate.excluded && slate.excluded.length > 0) {
    canonical.excluded = slate.excluded.map((e) => ({ instance_id: e.instance_id, reason: e.reason }));
  }
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
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
