import type { MergeBatchPr, MergeBatchWave, MergeBatchWaveKind } from './types.js';

export interface PlanWaveOptions {
  maxWaveSize: number;
}

export function planMergeBatchWaves(
  prs: MergeBatchPr[],
  opts: PlanWaveOptions,
): MergeBatchWave[] {
  const sorted = [...prs].sort((a, b) => a.number - b.number);
  const solo = sorted.filter((pr) => pr.risk === 'large' || pr.risk === 'solo');
  const regular = sorted.filter((pr) => pr.risk !== 'large' && pr.risk !== 'solo');

  const groups = buildRegularGroups(regular);
  const independent: MergeBatchPr[] = [];
  const waves: MergeBatchWave[] = [];

  for (const group of groups) {
    if (group.kind === 'independent') {
      independent.push(...group.prs);
      continue;
    }
    waves.push(toWave(waves.length + 1, group.kind, group.prs, group.reason));
  }

  for (let i = 0; i < independent.length; i += opts.maxWaveSize) {
    const chunk = independent.slice(i, i + opts.maxWaveSize);
    waves.push(
      toWave(
        waves.length + 1,
        'independent',
        chunk,
        `up to ${opts.maxWaveSize} independent PRs`,
      ),
    );
  }

  for (const pr of solo) {
    waves.push(
      toWave(waves.length + 1, 'solo-large', [pr], `${pr.risk} PR requires its own lane`),
    );
  }

  return waves
    .sort((a, b) => minPr(a) - minPr(b))
    .map((wave, i) => ({
      ...wave,
      id: `wave-${i + 1}`,
    }));
}

interface Group {
  kind: MergeBatchWaveKind;
  prs: MergeBatchPr[];
  reason: string;
}

function buildRegularGroups(prs: MergeBatchPr[]): Group[] {
  const remaining = new Map(prs.map((pr) => [pr.number, pr]));
  const groups: Group[] = [];

  for (const pr of prs) {
    if (!remaining.has(pr.number)) continue;
    const component = collectComponent(pr, remaining);
    for (const item of component) remaining.delete(item.number);

    const hasDependency = component.some((item) => item.dependsOnPrNumbers.length > 0);
    const hasOverlap = hasFileOverlap(component);
    const kind: MergeBatchWaveKind = hasDependency
      ? 'dependency-stack'
      : hasOverlap
        ? 'reactive-overlap'
        : 'independent';

    groups.push({
      kind,
      prs: orderComponent(component),
      reason: groupReason(kind),
    });
  }

  return groups;
}

function collectComponent(
  seed: MergeBatchPr,
  remaining: Map<number, MergeBatchPr>,
): MergeBatchPr[] {
  const out = new Map<number, MergeBatchPr>();
  const queue = [seed];

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (out.has(current.number)) continue;
    out.set(current.number, current);

    for (const other of remaining.values()) {
      if (out.has(other.number)) continue;
      if (connected(current, other)) queue.push(other);
    }
  }

  return [...out.values()];
}

function connected(a: MergeBatchPr, b: MergeBatchPr): boolean {
  if (a.dependsOnPrNumbers.includes(b.number)) return true;
  if (b.dependsOnPrNumbers.includes(a.number)) return true;
  return a.files.some((file) => b.files.includes(file));
}

function hasFileOverlap(prs: MergeBatchPr[]): boolean {
  const seen = new Set<string>();
  for (const pr of prs) {
    for (const file of pr.files) {
      if (seen.has(file)) return true;
      seen.add(file);
    }
  }
  return false;
}

function orderComponent(prs: MergeBatchPr[]): MergeBatchPr[] {
  return [...prs].sort((a, b) => {
    const aDepends = a.dependsOnPrNumbers.includes(b.number);
    const bDepends = b.dependsOnPrNumbers.includes(a.number);
    if (aDepends && !bDepends) return 1;
    if (bDepends && !aDepends) return -1;
    return a.number - b.number;
  });
}

function groupReason(kind: MergeBatchWaveKind): string {
  if (kind === 'dependency-stack') return 'dependency stack kept consecutive';
  if (kind === 'reactive-overlap') return 'overlapping files kept consecutive';
  return 'independent PRs';
}

function toWave(
  index: number,
  kind: MergeBatchWaveKind,
  prs: MergeBatchPr[],
  reason: string,
): MergeBatchWave {
  return {
    id: `wave-${index}`,
    kind,
    prs,
    reason,
    status: 'planned',
  };
}

function minPr(wave: MergeBatchWave): number {
  return Math.min(...wave.prs.map((pr) => pr.number));
}
