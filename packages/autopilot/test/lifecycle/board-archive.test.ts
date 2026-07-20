import { describe, expect, it } from 'vitest';
import {
  planBoardArchive,
  type BoardArchiveProjectSnapshot,
} from '../../src/lifecycle/board-archive.js';

const NOW = new Date('2026-07-20T12:00:00.000Z');
const CURRENT_ITERATION = 'iter-current';

function snapshot(
  overrides: Partial<BoardArchiveProjectSnapshot> = {},
): BoardArchiveProjectSnapshot {
  return {
    items: [],
    currentSprintIterationId: CURRENT_ITERATION,
    ...overrides,
  };
}

describe('planBoardArchive', () => {
  it('archives a Done item committed to a past (non-current) sprint iteration', () => {
    const result = planBoardArchive(snapshot({
      items: [{ id: 'ITEM_1', status: 'Done', sprintIterationId: 'iter-old' }],
    }), NOW);
    expect(result).toEqual(['ITEM_1']);
  });

  it('keeps a Done item committed to the current sprint iteration', () => {
    const result = planBoardArchive(snapshot({
      items: [{ id: 'ITEM_1', status: 'Done', sprintIterationId: CURRENT_ITERATION }],
    }), NOW);
    expect(result).toEqual([]);
  });

  it('archives a Done item with no sprint iteration at all', () => {
    const result = planBoardArchive(snapshot({
      items: [{ id: 'ITEM_1', status: 'Done', sprintIterationId: null }],
    }), NOW);
    expect(result).toEqual(['ITEM_1']);
  });

  it.each([
    ['Todo', null],
    ['Todo', 'iter-old'],
    ['In Progress', null],
    ['In Progress', 'iter-old'],
    ['Human', null],
    ['Human', 'iter-old'],
    ['In Review', null],
    ['In Review', 'iter-old'],
  ] as const)('keeps a %s item regardless of sprint (%s)', (status, sprintIterationId) => {
    const result = planBoardArchive(snapshot({
      items: [{ id: 'ITEM_1', status, sprintIterationId }],
    }), NOW);
    expect(result).toEqual([]);
  });

  it('archives a Done item whose stored iteration has rolled into completedIterations', () => {
    // The item's `sprintIterationId` still points at an iteration that has
    // since moved from the Sprint field's `iterations` list into
    // `completedIterations` (jinn-mono#1883) — `currentSprintIterationId`
    // never resolves to a completed iteration, so this item simply never
    // matches "current" and archives with no special-casing required.
    const result = planBoardArchive(snapshot({
      items: [{ id: 'ITEM_1', status: 'Done', sprintIterationId: 'iter-long-completed' }],
    }), NOW);
    expect(result).toEqual(['ITEM_1']);
  });

  it('keeps a Done item when the board has no active sprint at all', () => {
    const result = planBoardArchive(snapshot({
      items: [{ id: 'ITEM_1', status: 'Done', sprintIterationId: null }],
      currentSprintIterationId: null,
    }), NOW);
    // No sprint at all is still "not committed to the current sprint" — archives.
    expect(result).toEqual(['ITEM_1']);
  });

  it('returns candidate ids in snapshot order, one per Done+non-current item', () => {
    const result = planBoardArchive(snapshot({
      items: [
        { id: 'ITEM_1', status: 'Done', sprintIterationId: 'iter-old' },
        { id: 'ITEM_2', status: 'Todo', sprintIterationId: null },
        { id: 'ITEM_3', status: 'Done', sprintIterationId: CURRENT_ITERATION },
        { id: 'ITEM_4', status: 'Done', sprintIterationId: null },
      ],
    }), NOW);
    expect(result).toEqual(['ITEM_1', 'ITEM_4']);
  });

  it('rejects an invalid derivation time', () => {
    expect(() => planBoardArchive(snapshot(), new Date('not-a-date'))).toThrow(
      'Invalid board-archive derivation time',
    );
  });
});
