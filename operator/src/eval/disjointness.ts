import { minhashSketch, type CorpusDerivedIndex } from './corpus-index.js';

export interface SlateTaskForDisjointness {
  instance_id: string;
  repo: string;
  /** Distinctive tokens from the gold patch (changed paths/symbols/PR id). */
  goldPatchTokens: string[];
}

export interface AxisCheck { verdict: 'pass' | 'fail'; flaggedPairs: Array<[string, string]>; }
export interface DisjointnessResult { instance: AxisCheck; repo: AxisCheck; lexical: AxisCheck; }

export class CorpusContaminationError extends Error {
  constructor(public readonly result: DisjointnessResult) {
    const fails = (['instance', 'repo', 'lexical'] as const).filter((a) => result[a].verdict === 'fail');
    super(`corpus contamination on axes [${fails.join(', ')}]: ${JSON.stringify(
      fails.flatMap((a) => result[a].flaggedPairs),
    )}`);
    this.name = 'CorpusContaminationError';
  }
}

/** MinHash Jaccard estimate between two equal-length sketches. An all-zero
 *  sketch is corpus-index's empty-token-set sentinel; a set with no tokens has
 *  no meaningful overlap, so return 0 rather than letting the sentinel zeros
 *  count as matches (which would false-positive a degenerate gold patch or an
 *  empty corpus record into a contamination flag). */
function sketchJaccard(a: number[], b: number[]): number {
  if (a.length === 0) return 0;
  if (a.length !== b.length) {
    throw new Error(`sketchJaccard: sketch length mismatch (${a.length} vs ${b.length})`);
  }
  if (a.every((x) => x === 0) || b.every((x) => x === 0)) return 0;
  let same = 0;
  for (let i = 0; i < a.length; i++) if (a[i] === b[i]) same++;
  return same / a.length;
}

export function checkCorpusDisjoint(
  slate: SlateTaskForDisjointness[],
  index: CorpusDerivedIndex,
  opts: { lexicalJaccardThreshold?: number } = {},
): DisjointnessResult {
  const threshold = opts.lexicalJaccardThreshold ?? 0.15;
  const corpusRepos = new Set(index.repos);
  const corpusInstances = new Set(index.instanceIds);

  const instance: AxisCheck = { verdict: 'pass', flaggedPairs: [] };
  const repo: AxisCheck = { verdict: 'pass', flaggedPairs: [] };
  const lexical: AxisCheck = { verdict: 'pass', flaggedPairs: [] };

  for (const task of slate) {
    if (corpusInstances.has(task.instance_id)) {
      instance.verdict = 'fail';
      for (const rec of index.records) if (rec.instanceIds.includes(task.instance_id)) instance.flaggedPairs.push([task.instance_id, rec.id]);
    }
    if (corpusRepos.has(task.repo)) {
      repo.verdict = 'fail';
      for (const rec of index.records) if (rec.repos.includes(task.repo)) repo.flaggedPairs.push([task.instance_id, rec.id]);
    }
    const goldSketch = minhashSketch(task.goldPatchTokens);
    for (const rec of index.records) {
      if (sketchJaccard(goldSketch, rec.sketch) >= threshold) {
        lexical.verdict = 'fail';
        lexical.flaggedPairs.push([task.instance_id, rec.id]);
      }
    }
  }
  return { instance, repo, lexical };
}

export function assertCorpusDisjoint(
  slate: SlateTaskForDisjointness[],
  index: CorpusDerivedIndex,
  opts: { lexicalJaccardThreshold?: number } = {},
): DisjointnessResult {
  const result = checkCorpusDisjoint(slate, index, opts);
  if (result.instance.verdict === 'fail' || result.repo.verdict === 'fail' || result.lexical.verdict === 'fail') {
    throw new CorpusContaminationError(result);
  }
  return result;
}
