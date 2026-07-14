import { describe, it, expect } from 'vitest';
import { GhIssueSource } from '../../src/dispatcher/issue-source.js';
import type {
  CommandRunner,
  IssueBoardEntry,
  IssueBoardState,
} from '../../src/dispatcher/issue-source.js';
import { toIssueBoardState } from '../../src/dispatcher/project-snapshot.js';
import type {
  ProjectSnapshot,
  SnapshotItem,
} from '../../src/dispatcher/project-snapshot.js';

/**
 * IssueSource seam decoupling (#600). Exercises:
 *  1. Structural satisfaction — a hand-rolled `IssueBoardState` (no
 *     `ProjectSnapshot`) is accepted by `GhIssueSource.poll`.
 *  2. `toIssueBoardState(snapshot)` projects correctly — Issue items only,
 *     all routing fields plumbed, current-sprint surfaced, unknown → null.
 */

// Fixture issue numbers used in tests
const ISSUE_ON_BOARD = 403;
const ISSUE_OFF_BOARD = 471;

/** Canned gh issue list response — includes both fixture issues. */
const ISSUE_LIST_JSON = JSON.stringify([
  {
    labels: [],
    number: ISSUE_ON_BOARD,
    title: 'fix(client): test-gated TaskClaimEmitter redeploy',
    author: { login: 'alice' },
  },
  {
    labels: [],
    number: ISSUE_OFF_BOARD,
    title: 'feat(operator-app): expose generator health',
    author: { login: 'carol' },
  },
]);

/** `gh issue list` runner — the only command `GhIssueSource.poll` issues. */
function makeFakeRunner(): CommandRunner {
  return async (cmd: string, args: string[]): Promise<string> => {
    if (cmd === 'gh' && args[0] === 'issue') {
      return ISSUE_LIST_JSON;
    }
    throw new Error(`Unexpected command: ${cmd} ${args.join(' ')}`);
  };
}

/** SnapshotItem helper mirroring `issue-source.test.ts`. */
function snapshotItem(
  overrides: Partial<SnapshotItem> & Pick<SnapshotItem, 'id' | 'number'>,
): SnapshotItem {
  return {
    contentType: 'Issue',
    status: null,
    priority: null,
    effort: null,
    blockedOn: null,
    issueType: null,
    blockedByIssues: [],
    sprintIterationId: null,
    ...overrides,
  };
}

describe('IssueBoardState seam', () => {
  it('GhIssueSource.poll accepts a hand-rolled IssueBoardState (not a ProjectSnapshot)', async () => {
    // A stub that satisfies IssueBoardState without ever touching
    // ProjectSnapshot — proves the seam is decoupled from the GitHub Project
    // shape. A future SolverNet IssueSource consumer would build a board
    // state like this from on-chain task data.
    const sprintId = 'sprint-x';
    const stubEntry: IssueBoardEntry = {
      id: 'STUB-1',
      status: 'Todo',
      priority: 'P0',
      effort: 'Low',
      blockedOn: 'Nothing',
      issueType: 'feat',
      blockedByIssues: [],
      sprintIterationId: sprintId,
    };
    const stub: IssueBoardState = {
      getIssue(issueNumber: number): IssueBoardEntry | null {
        return issueNumber === ISSUE_ON_BOARD ? stubEntry : null;
      },
      currentSprintIterationId: sprintId,
    };

    const source = new GhIssueSource(makeFakeRunner());
    const issues = await source.poll(stub);

    const onBoard = issues.find((i) => i.number === ISSUE_ON_BOARD);
    expect(onBoard).toBeDefined();
    expect(onBoard!.onBoard).toBe(true);
    expect(onBoard!.status).toBe('Todo');
    expect(onBoard!.priority).toBe('P0');
    expect(onBoard!.effort).toBe('Low');
    expect(onBoard!.blockedOn).toBe('Nothing');
    expect(onBoard!.shape).toBe('feat');
    expect(onBoard!.projectItemId).toBe('STUB-1');
    expect(onBoard!.inCurrentSprint).toBe(true);

    const offBoard = issues.find((i) => i.number === ISSUE_OFF_BOARD);
    expect(offBoard).toBeDefined();
    expect(offBoard!.onBoard).toBe(false);
    expect(offBoard!.status).toBeNull();
    expect(offBoard!.priority).toBeNull();
    expect(offBoard!.effort).toBeNull();
    expect(offBoard!.blockedOn).toBeNull();
    expect(offBoard!.shape).toBeNull();
    expect(offBoard!.projectItemId).toBeNull();
    expect(offBoard!.inCurrentSprint).toBe(false);
  });

  it('toIssueBoardState surfaces an Issue snapshot item as a fully-populated IssueBoardEntry', async () => {
    const snapshot: ProjectSnapshot = {
      items: [
        snapshotItem({
          id: 'PVTI_403',
          number: ISSUE_ON_BOARD,
          status: 'Todo',
          priority: 'P1',
          effort: 'Medium',
          blockedOn: 'Nothing',
          issueType: 'fix',
          sprintIterationId: 'iter-7',
        }),
      ],
      rateLimit: { remaining: 4999, used: 1, resetAt: '2026-05-25T16:00:00Z' },
      currentSprintIterationId: 'iter-7',
    };
    const board = toIssueBoardState(snapshot);
    const entry = board.getIssue(ISSUE_ON_BOARD);
    expect(entry).not.toBeNull();
    expect(entry!.id).toBe('PVTI_403');
    expect(entry!.status).toBe('Todo');
    expect(entry!.priority).toBe('P1');
    expect(entry!.effort).toBe('Medium');
    expect(entry!.blockedOn).toBe('Nothing');
    expect(entry!.issueType).toBe('fix');
    expect(entry!.sprintIterationId).toBe('iter-7');
  });

  it('toIssueBoardState filters non-Issue snapshot items (PullRequest / DraftIssue)', async () => {
    // A PR-typed item with the same number as a real issue must NOT shadow
    // the issue in the abstract view — the seam treats it as off-board.
    const snapshot: ProjectSnapshot = {
      items: [
        snapshotItem({
          id: 'PVTI_pr',
          number: ISSUE_ON_BOARD,
          contentType: 'PullRequest',
        }),
      ],
      rateLimit: { remaining: 4999, used: 1, resetAt: '2026-05-25T16:00:00Z' },
      currentSprintIterationId: null,
    };
    const board = toIssueBoardState(snapshot);
    expect(board.getIssue(ISSUE_ON_BOARD)).toBeNull();
  });

  it('toIssueBoardState surfaces currentSprintIterationId (value or null)', async () => {
    const withSprint: ProjectSnapshot = {
      items: [],
      rateLimit: { remaining: 5000, used: 0, resetAt: '2026-05-25T16:00:00Z' },
      currentSprintIterationId: 'iter-now',
    };
    const withoutSprint: ProjectSnapshot = {
      items: [],
      rateLimit: { remaining: 5000, used: 0, resetAt: '2026-05-25T16:00:00Z' },
      currentSprintIterationId: null,
    };
    expect(toIssueBoardState(withSprint).currentSprintIterationId).toBe('iter-now');
    expect(toIssueBoardState(withoutSprint).currentSprintIterationId).toBeNull();
  });

  it('toIssueBoardState returns null for issue numbers not on the board', async () => {
    const snapshot: ProjectSnapshot = {
      items: [
        snapshotItem({
          id: 'PVTI_403',
          number: ISSUE_ON_BOARD,
          status: 'Todo',
        }),
      ],
      rateLimit: { remaining: 4999, used: 1, resetAt: '2026-05-25T16:00:00Z' },
      currentSprintIterationId: null,
    };
    const board = toIssueBoardState(snapshot);
    expect(board.getIssue(ISSUE_OFF_BOARD)).toBeNull();
    expect(board.getIssue(999_999)).toBeNull();
  });
});
