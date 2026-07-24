import { describe, expect, it } from 'vitest';
import {
  derivePaintedStatus,
  planBoardPaint,
  planOrphanChildCloses,
  planStatusPaints,
  type OrphanChildFact,
  type PaintBoardItem,
  type PaintFacts,
} from '../../src/lifecycle/board-painter.js';

const NOW = new Date('2026-07-22T12:00:00.000Z');
const CURRENT_ITERATION = 'iter-current';

function facts(overrides: Partial<PaintFacts> = {}): PaintFacts {
  return {
    issueOpen: true,
    labels: [],
    hasOpenDraftPr: false,
    hasOpenNonDraftPr: false,
    hasClaimBranch: false,
    merged: false,
    hasOpenChildren: false,
    ...overrides,
  };
}

function item(
  overrides: Partial<PaintBoardItem> & Pick<PaintBoardItem, 'itemId' | 'issueNumber'>,
): PaintBoardItem {
  const { itemId, issueNumber, ...rest } = overrides;
  return {
    itemId,
    issueNumber,
    currentStatus: null,
    facts: facts(),
    sprintIterationId: null,
    ...rest,
  };
}

describe('derivePaintedStatus — §3 mapping matrix', () => {
  it('ELIGIBLE → Todo', () => {
    expect(derivePaintedStatus(facts())).toBe('Todo');
  });

  it('CLAIMED (claim branch, no PR) → In Progress', () => {
    expect(derivePaintedStatus(facts({ hasClaimBranch: true }))).toBe('In Progress');
  });

  it('IN PROGRESS (draft PR) → In Progress', () => {
    expect(derivePaintedStatus(facts({ hasOpenDraftPr: true }))).toBe('In Progress');
  });

  it('DELIVERED / IN REVIEW / MERGE-READY (non-draft open PR) → In Review', () => {
    expect(derivePaintedStatus(facts({ hasOpenNonDraftPr: true }))).toBe('In Review');
  });

  it('BLOCKED-BY-CHILD (open children) → In Review', () => {
    expect(derivePaintedStatus(facts({
      hasOpenNonDraftPr: true,
      hasOpenChildren: true,
    }))).toBe('In Review');
    // Children alone (parent PR still open via non-draft) — also when only
    // the child flag is set without a PR fact (defensive).
    expect(derivePaintedStatus(facts({ hasOpenChildren: true }))).toBe('In Review');
  });

  it('DONE (merged) → Done', () => {
    expect(derivePaintedStatus(facts({
      issueOpen: false,
      merged: true,
      hasOpenNonDraftPr: false,
    }))).toBe('Done');
  });

  it('closed issue without merge → Done', () => {
    expect(derivePaintedStatus(facts({ issueOpen: false }))).toBe('Done');
  });

  it.each([
    ['autopilot:human'],
    ['review:needs-human'],
  ] as const)('HUMAN label %s overrides everything', (label) => {
    expect(derivePaintedStatus(facts({
      labels: [label],
      merged: true,
      hasOpenNonDraftPr: true,
      hasOpenChildren: true,
      hasClaimBranch: true,
      hasOpenDraftPr: true,
    }))).toBe('Human');
  });

  it('non-draft outranks draft / claim for In Review', () => {
    expect(derivePaintedStatus(facts({
      hasOpenNonDraftPr: true,
      hasOpenDraftPr: true,
      hasClaimBranch: true,
    }))).toBe('In Review');
  });
});

describe('planStatusPaints', () => {
  it('no-ops when current Status already matches', () => {
    expect(planStatusPaints([
      item({
        itemId: 'ITEM_1',
        issueNumber: 1,
        currentStatus: 'Todo',
        facts: facts(),
      }),
      item({
        itemId: 'ITEM_2',
        issueNumber: 2,
        currentStatus: 'In Progress',
        facts: facts({ hasClaimBranch: true }),
      }),
      item({
        itemId: 'ITEM_3',
        issueNumber: 3,
        currentStatus: 'In Review',
        facts: facts({ hasOpenNonDraftPr: true }),
      }),
      item({
        itemId: 'ITEM_4',
        issueNumber: 4,
        currentStatus: 'Done',
        facts: facts({ merged: true, issueOpen: false }),
      }),
      item({
        itemId: 'ITEM_5',
        issueNumber: 5,
        currentStatus: 'Human',
        facts: facts({ labels: ['autopilot:human'] }),
      }),
    ])).toEqual([]);
  });

  it('emits only diffs, preserving snapshot order', () => {
    expect(planStatusPaints([
      item({
        itemId: 'ITEM_1',
        issueNumber: 10,
        currentStatus: 'In Progress',
        facts: facts(),
      }),
      item({
        itemId: 'ITEM_2',
        issueNumber: 20,
        currentStatus: 'Todo',
        facts: facts(),
      }),
      item({
        itemId: 'ITEM_3',
        issueNumber: 30,
        currentStatus: null,
        facts: facts({ hasOpenDraftPr: true }),
      }),
    ])).toEqual([
      {
        itemId: 'ITEM_1',
        issueNumber: 10,
        from: 'In Progress',
        to: 'Todo',
      },
      {
        itemId: 'ITEM_3',
        issueNumber: 30,
        from: null,
        to: 'In Progress',
      },
    ]);
  });
});

describe('planOrphanChildCloses', () => {
  it('closes children whose parent merged or closed', () => {
    const children: OrphanChildFact[] = [
      { childIssueNumber: 101, parentPrNumber: 5, parentState: 'merged' },
      { childIssueNumber: 102, parentPrNumber: 6, parentState: 'open' },
      { childIssueNumber: 103, parentPrNumber: 7, parentState: 'closed' },
    ];
    expect(planOrphanChildCloses(children)).toEqual([
      {
        childIssueNumber: 101,
        parentPrNumber: 5,
        reason: 'Parent PR #5 merged',
      },
      {
        childIssueNumber: 103,
        parentPrNumber: 7,
        reason: 'Parent PR #7 closed',
      },
    ]);
  });

  it('returns empty when every parent is still open', () => {
    expect(planOrphanChildCloses([
      { childIssueNumber: 101, parentPrNumber: 5, parentState: 'open' },
    ])).toEqual([]);
  });
});

describe('planBoardPaint — archive + orphan + paint', () => {
  it('archives stale Done (painted) items and plans orphan closes', () => {
    const plan = planBoardPaint(
      [
        item({
          itemId: 'ITEM_DONE_OLD',
          issueNumber: 1,
          currentStatus: 'In Review',
          facts: facts({ merged: true, issueOpen: false }),
          sprintIterationId: 'iter-old',
        }),
        item({
          itemId: 'ITEM_DONE_CURRENT',
          issueNumber: 2,
          currentStatus: 'Done',
          facts: facts({ merged: true, issueOpen: false }),
          sprintIterationId: CURRENT_ITERATION,
        }),
        item({
          itemId: 'ITEM_LIVE',
          issueNumber: 3,
          currentStatus: 'Todo',
          facts: facts({ hasClaimBranch: true }),
          sprintIterationId: null,
        }),
      ],
      [
        { childIssueNumber: 201, parentPrNumber: 9, parentState: 'merged' },
        { childIssueNumber: 202, parentPrNumber: 10, parentState: 'open' },
      ],
      CURRENT_ITERATION,
      NOW,
    );

    expect(plan.paints).toEqual([
      {
        itemId: 'ITEM_DONE_OLD',
        issueNumber: 1,
        from: 'In Review',
        to: 'Done',
      },
      {
        itemId: 'ITEM_LIVE',
        issueNumber: 3,
        from: 'Todo',
        to: 'In Progress',
      },
    ]);
    expect(plan.archiveItemIds).toEqual(['ITEM_DONE_OLD']);
    expect(plan.orphanCloses).toEqual([
      {
        childIssueNumber: 201,
        parentPrNumber: 9,
        reason: 'Parent PR #9 merged',
      },
    ]);
  });

  it('no-ops paints and archive when board already matches and Done is current-sprint', () => {
    const plan = planBoardPaint(
      [
        item({
          itemId: 'ITEM_1',
          issueNumber: 1,
          currentStatus: 'Done',
          facts: facts({ merged: true, issueOpen: false }),
          sprintIterationId: CURRENT_ITERATION,
        }),
      ],
      [],
      CURRENT_ITERATION,
      NOW,
    );
    expect(plan.paints).toEqual([]);
    expect(plan.archiveItemIds).toEqual([]);
    expect(plan.orphanCloses).toEqual([]);
  });

  it('closes every orphan child whose parent is merged or closed in one sweep', () => {
    const plan = planBoardPaint(
      [
        item({
          itemId: 'ITEM_LIVE',
          issueNumber: 3,
          currentStatus: 'In Review',
          facts: facts({ hasOpenNonDraftPr: true }),
        }),
      ],
      [
        { childIssueNumber: 301, parentPrNumber: 11, parentState: 'merged' },
        { childIssueNumber: 302, parentPrNumber: 12, parentState: 'closed' },
        { childIssueNumber: 303, parentPrNumber: 13, parentState: 'open' },
        { childIssueNumber: 304, parentPrNumber: 14, parentState: 'merged' },
      ],
      CURRENT_ITERATION,
      NOW,
    );
    expect(plan.orphanCloses).toEqual([
      {
        childIssueNumber: 301,
        parentPrNumber: 11,
        reason: 'Parent PR #11 merged',
      },
      {
        childIssueNumber: 302,
        parentPrNumber: 12,
        reason: 'Parent PR #12 closed',
      },
      {
        childIssueNumber: 304,
        parentPrNumber: 14,
        reason: 'Parent PR #14 merged',
      },
    ]);
  });
});
