import { describe, it, expect } from 'vitest';
import { GhIssueSource } from '../../src/dispatcher/issue-source.js';
import type { CommandRunner } from '../../src/dispatcher/issue-source.js';
import {
  toIssueBoardState,
} from '../../src/dispatcher/project-snapshot.js';
import type {
  ProjectSnapshot,
  SnapshotItem,
} from '../../src/dispatcher/project-snapshot.js';

/**
 * Post-#585 / post-#600 fixtures.
 *
 * GhIssueSource.poll(board) now consumes the abstract IssueBoardState (#600);
 * the GitHub-specific projection lives in `toIssueBoardState(snapshot)`. These
 * tests still build a {@link ProjectSnapshot}-shaped fixture so they exercise
 * the production path (snapshot → adapter → source) end-to-end — every
 * `source.poll(SNAPSHOT)` call site below wraps the snapshot in
 * `toIssueBoardState(...)`.
 *
 * Only explicit `gh api` REST pages remain as runner calls inside the source.
 *
 * gh api repos/Jinn-Network/mono/issues?state=open&per_page=100&page=1
 *   → [{"labels":[],"number":403,"title":"fix(client): something"}, ...]
 */

// Fixture issue numbers used in tests
const ISSUE_ON_BOARD_WITH_TYPE = 403;
const ISSUE_ON_BOARD_NO_TYPE = 328;
const ISSUE_NOT_ON_BOARD = 471;

/** Canned REST issue response — includes all three test issues. */
const ISSUE_LIST_JSON = JSON.stringify([
  {
    labels: [],
    number: ISSUE_ON_BOARD_WITH_TYPE,
    title: 'fix(client): test-gated TaskClaimEmitter redeploy',
    user: { login: 'alice' },
  },
  {
    labels: [],
    number: ISSUE_ON_BOARD_NO_TYPE,
    title: 'Release feedback — v0.1.6 operator app dogfood (2026-05-19)',
    user: { login: 'bob' },
  },
  {
    labels: [],
    number: ISSUE_NOT_ON_BOARD,
    title: 'feat(operator-app): expose generator health',
    user: { login: 'carol' },
  },
]);

function snapshotItem(overrides: Partial<SnapshotItem> & Pick<SnapshotItem, 'id' | 'number'>): SnapshotItem {
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

/**
 * Snapshot containing only issues 403 and 328 (471 is intentionally absent
 * → off-board test).
 */
const SNAPSHOT: ProjectSnapshot = {
  items: [
    snapshotItem({
      id: 'PVTI_lADODh3-Ac4BXYaIzgtUv1A',
      number: ISSUE_ON_BOARD_WITH_TYPE,
      status: 'Done',
      priority: 'P1',
      effort: 'Medium',
      blockedOn: 'Nothing',
      issueType: 'fix',
    }),
    snapshotItem({
      id: 'PVTI_lADODh3-Ac4BXYaIzgtNV5I',
      number: ISSUE_ON_BOARD_NO_TYPE,
      status: 'In Progress',
      priority: 'P1',
      effort: null,
      blockedOn: 'Nothing',
      issueType: null, // no Issue Type set
    }),
  ],
  rateLimit: { remaining: 4999, used: 1, resetAt: '2026-05-25T16:00:00Z' },
  currentSprintIterationId: null,
};

/** Build a fake CommandRunner that returns canned JSON matching real gh shapes. */
function makeFakeRunner(): CommandRunner {
  return async (cmd: string, args: string[]): Promise<string> => {
    if (cmd === 'gh' && args[0] === 'api' && args[1]?.includes('/issues?')) {
      return ISSUE_LIST_JSON;
    }
    // Post-#585: GhIssueSource.poll no longer calls `gh project` or
    // GraphQL — both are folded into the orchestrator-supplied
    // snapshot.
    throw new Error(`Unexpected command: ${cmd} ${args.join(' ')}`);
  };
}

describe('GhIssueSource', () => {
  it('maps an issue on the board with Issue Type to a fully-populated PolledIssue', async () => {
    const source = new GhIssueSource(makeFakeRunner());
    const issues = await source.poll(toIssueBoardState(SNAPSHOT));

    const issue = issues.find((i) => i.number === ISSUE_ON_BOARD_WITH_TYPE);
    expect(issue).toBeDefined();
    expect(issue!.shape).toBe('fix');
    expect(issue!.blockedOn).toBe('Nothing');
    expect(issue!.effort).toBe('Medium');
    expect(issue!.priority).toBe('P1');
    expect(issue!.status).toBe('Done');
    expect(issue!.onBoard).toBe(true);
    expect(issue!.blockedByIssues).toEqual([]);
    expect(issue!.author).toBe('alice');
  });

  it('maps an issue on the board with no Issue Type to shape: null', async () => {
    const source = new GhIssueSource(makeFakeRunner());
    const issues = await source.poll(toIssueBoardState(SNAPSHOT));

    const issue = issues.find((i) => i.number === ISSUE_ON_BOARD_NO_TYPE);
    expect(issue).toBeDefined();
    expect(issue!.shape).toBeNull();
    expect(issue!.onBoard).toBe(true);
    expect(issue!.priority).toBe('P1');
    expect(issue!.status).toBe('In Progress');
    expect(issue!.author).toBe('bob');
  });

  it('maps an issue not on the board to onBoard: false with null routing fields', async () => {
    const source = new GhIssueSource(makeFakeRunner());
    const issues = await source.poll(toIssueBoardState(SNAPSHOT));

    const issue = issues.find((i) => i.number === ISSUE_NOT_ON_BOARD);
    expect(issue).toBeDefined();
    expect(issue!.onBoard).toBe(false);
    expect(issue!.shape).toBeNull();
    expect(issue!.blockedOn).toBeNull();
    expect(issue!.effort).toBeNull();
    expect(issue!.priority).toBeNull();
    expect(issue!.status).toBeNull();
    expect(issue!.blockedByIssues).toEqual([]);
    expect(issue!.author).toBe('carol');
  });

  it('returns all polled issues (including off-board ones)', async () => {
    const source = new GhIssueSource(makeFakeRunner());
    const issues = await source.poll(toIssueBoardState(SNAPSHOT));
    expect(issues.length).toBe(3);
  });

  it('preserves issue title from the issue list', async () => {
    const source = new GhIssueSource(makeFakeRunner());
    const issues = await source.poll(toIssueBoardState(SNAPSHOT));
    const issue = issues.find((i) => i.number === ISSUE_ON_BOARD_WITH_TYPE);
    expect(issue!.title).toBe('fix(client): test-gated TaskClaimEmitter redeploy');
  });

  it('skips snapshot items whose contentType is not Issue (PRs, DraftIssues)', async () => {
    // A snapshot containing a PR item with number=403 must NOT be matched
    // to the Issue #403 in the issue list — only Issue-typed snapshot items
    // are considered for board membership.
    const snapshotWithPr: ProjectSnapshot = {
      items: [
        snapshotItem({
          id: 'PVTI_pr',
          number: ISSUE_ON_BOARD_WITH_TYPE,
          contentType: 'PullRequest',
          // PR items legitimately have no Project field values set
          issueType: null,
        }),
      ],
      rateLimit: { remaining: 4999, used: 1, resetAt: '2026-05-25T16:00:00Z' },
      currentSprintIterationId: null,
    };
    const source = new GhIssueSource(makeFakeRunner());
    const issues = await source.poll(toIssueBoardState(snapshotWithPr));

    const issue = issues.find((i) => i.number === ISSUE_ON_BOARD_WITH_TYPE);
    expect(issue!.onBoard).toBe(false);
    expect(issue!.status).toBeNull();
  });
});
