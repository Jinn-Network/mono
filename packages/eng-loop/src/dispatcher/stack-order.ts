/**
 * Pure candidate-set discovery + stack ordering for the merge-batch skill.
 *
 * Given every open PR's (number, headRefName, baseRefName), enumerate the
 * mergeable candidate set — PRs based on `next` (roots) plus PRs transitively
 * stacked on a root — ordered each stack contiguous and bottom-up (root first).
 * PRs whose base is neither `next` nor any open PR's head branch (deleted base,
 * or a base-ref cycle) are returned in `orphans`, never silently dropped.
 *
 * No I/O: callers pass the descriptors fetched via `gh pr list`. Mirrors the
 * pure-function pattern of `review-ready-filter.ts` (selectReviewable).
 */

export interface PrDescriptor {
  number: number;
  headRefName: string;
  baseRefName: string;
}

export interface OrderedPr {
  number: number;
  headRefName: string;
  baseRefName: string;
  tier: 'root' | 'stacked';
  parentNumber: number | null;
  stackRootNumber: number;
  depth: number;
}

export interface StackOrdering {
  candidates: OrderedPr[];
  orphans: PrDescriptor[];
}

/**
 * Walk `pr` upward via base→head links to its root. Returns the root descriptor
 * if the chain terminates at a PR whose base is `baseBranch`; returns null if
 * the chain hits an unknown base (orphan) or revisits a node (cycle).
 */
function findRoot(
  pr: PrDescriptor,
  headToPr: Map<string, PrDescriptor>,
  baseBranch: string,
): PrDescriptor | null {
  const visited = new Set<number>();
  let current = pr;
  while (current.baseRefName !== baseBranch) {
    if (visited.has(current.number)) return null; // cycle guard
    visited.add(current.number);
    const parent = headToPr.get(current.baseRefName);
    if (parent === undefined) return null; // orphan: base is not next nor any open head
    current = parent;
  }
  return current;
}

export function enumerateStacks(prs: PrDescriptor[], baseBranch = 'next'): StackOrdering {
  const headToPr = new Map<string, PrDescriptor>();
  for (const pr of prs) headToPr.set(pr.headRefName, pr);

  const orphans: PrDescriptor[] = [];
  const rooted: PrDescriptor[] = [];
  for (const pr of prs) {
    if (findRoot(pr, headToPr, baseBranch) === null) orphans.push(pr);
    else rooted.push(pr);
  }

  const childrenOf = new Map<number, PrDescriptor[]>();
  const roots: PrDescriptor[] = [];
  for (const pr of rooted) {
    if (pr.baseRefName === baseBranch) {
      roots.push(pr);
    } else {
      const parentNumber = headToPr.get(pr.baseRefName)!.number;
      const list = childrenOf.get(parentNumber) ?? [];
      list.push(pr);
      childrenOf.set(parentNumber, list);
    }
  }

  roots.sort((a, b) => a.number - b.number);
  const candidates: OrderedPr[] = [];

  function emitStack(root: PrDescriptor): void {
    let frontier: Array<{ pr: PrDescriptor; depth: number }> = [{ pr: root, depth: 0 }];
    while (frontier.length > 0) {
      frontier.sort((a, b) => a.pr.number - b.pr.number);
      const next: Array<{ pr: PrDescriptor; depth: number }> = [];
      for (const { pr, depth } of frontier) {
        candidates.push({
          number: pr.number,
          headRefName: pr.headRefName,
          baseRefName: pr.baseRefName,
          tier: depth === 0 ? 'root' : 'stacked',
          parentNumber: depth === 0 ? null : headToPr.get(pr.baseRefName)!.number,
          stackRootNumber: root.number,
          depth,
        });
        const children = childrenOf.get(pr.number) ?? [];
        for (const child of children) next.push({ pr: child, depth: depth + 1 });
      }
      frontier = next;
    }
  }

  for (const root of roots) emitStack(root);

  return { candidates, orphans };
}
