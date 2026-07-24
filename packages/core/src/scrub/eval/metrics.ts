import type { ClassCounts, ClassMetrics, ScrubClass } from './types.js';

export function emptyCounts(): ClassCounts {
  return { tp: 0, fp: 0, fn: 0 };
}

export function metricsFromCounts(c: ClassCounts): ClassMetrics {
  const recall = c.tp + c.fn === 0 ? 1 : c.tp / (c.tp + c.fn);
  const precision = c.tp + c.fp === 0 ? 1 : c.tp / (c.tp + c.fp);
  const beta = 2;
  const betaSq = beta * beta;
  const fBeta2 =
    precision + recall === 0
      ? 0
      : ((1 + betaSq) * precision * recall) / (betaSq * precision + recall);
  return { ...c, recall, precision, fBeta2 };
}

export function mergeCounts(a: ClassCounts, b: ClassCounts): ClassCounts {
  return { tp: a.tp + b.tp, fp: a.fp + b.fp, fn: a.fn + b.fn };
}

/**
 * Score predicted spans against gold labels for one class using interval overlap.
 * A prediction that overlaps any unmatched gold label is TP; unmatched gold → FN;
 * unmatched predictions → FP. Distinct-source dedupe: gold labels with the same
 * `sourceId` count once (first occurrence wins).
 */
export function scoreClass(
  gold: Array<{ start: number; end: number; sourceId?: string }>,
  pred: Array<{ start: number; end: number }>,
): ClassCounts {
  const seenSources = new Set<string>();
  const dedupedGold: Array<{ start: number; end: number }> = [];
  for (const g of gold) {
    if (g.sourceId) {
      if (seenSources.has(g.sourceId)) continue;
      seenSources.add(g.sourceId);
    }
    dedupedGold.push({ start: g.start, end: g.end });
  }

  const goldMatched = new Array(dedupedGold.length).fill(false);
  const predMatched = new Array(pred.length).fill(false);

  for (let pi = 0; pi < pred.length; pi += 1) {
    for (let gi = 0; gi < dedupedGold.length; gi += 1) {
      if (goldMatched[gi]) continue;
      if (overlaps(pred[pi]!, dedupedGold[gi]!)) {
        goldMatched[gi] = true;
        predMatched[pi] = true;
        break;
      }
    }
  }

  let tp = 0;
  let fn = 0;
  let fp = 0;
  for (const m of goldMatched) {
    if (m) tp += 1;
    else fn += 1;
  }
  for (const m of predMatched) {
    if (!m) fp += 1;
  }
  return { tp, fp, fn };
}

function overlaps(a: { start: number; end: number }, b: { start: number; end: number }): boolean {
  return a.start < b.end && b.start < a.end;
}

export function aggregateClassMap(
  perFixture: Array<Partial<Record<ScrubClass, ClassCounts>>>,
): Partial<Record<ScrubClass, ClassMetrics>> {
  const acc: Partial<Record<ScrubClass, ClassCounts>> = {};
  for (const row of perFixture) {
    for (const [cls, counts] of Object.entries(row) as Array<[ScrubClass, ClassCounts]>) {
      acc[cls] = acc[cls] ? mergeCounts(acc[cls]!, counts) : { ...counts };
    }
  }
  const out: Partial<Record<ScrubClass, ClassMetrics>> = {};
  for (const [cls, counts] of Object.entries(acc) as Array<[ScrubClass, ClassCounts]>) {
    out[cls] = metricsFromCounts(counts);
  }
  return out;
}
