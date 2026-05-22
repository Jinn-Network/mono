import { describe, it, expect } from 'vitest';
import { GhIssueSource } from '../../src/dispatcher/issue-source.js';
import type { CommandRunner } from '../../src/dispatcher/issue-source.js';

/**
 * Canned JSON fixtures matching real `gh` output shapes observed 2026-05-21.
 *
 * gh issue list --repo Jinn-Network/mono --state open --json number,title,labels
 *   → [{"labels":[],"number":403,"title":"fix(client): something"}]
 *
 * gh project item-list 1 --owner Jinn-Network --format json
 *   → {"items":[{"blocked on":"Nothing","effort":"Medium","priority":"P1",
 *       "status":"Done","title":"...","id":"PVTI_...","repository":"...",
 *       "content":{"number":403,"type":"Issue","title":"...","url":"...","body":"...","repository":"Jinn-Network/mono"}}],
 *      "totalCount":158}
 *
 * gh api graphql -f query='{repository(owner:"Jinn-Network",name:"mono"){i403:issue(number:403){issueType{name}}}}'
 *   → {"data":{"repository":{"i403":{"issueType":{"name":"fix"}}}}}
 */

// Fixture issue numbers used in tests
const ISSUE_ON_BOARD_WITH_TYPE = 403;
const ISSUE_ON_BOARD_NO_TYPE = 328;
const ISSUE_NOT_ON_BOARD = 471;

/** Canned gh issue list response — includes all three test issues. */
const ISSUE_LIST_JSON = JSON.stringify([
  {
    labels: [],
    number: ISSUE_ON_BOARD_WITH_TYPE,
    title: 'fix(client): test-gated TaskClaimEmitter redeploy',
    author: { login: 'alice' },
  },
  {
    labels: [],
    number: ISSUE_ON_BOARD_NO_TYPE,
    title: 'Release feedback — v0.1.6 operator app dogfood (2026-05-19)',
    author: { login: 'bob' },
  },
  {
    labels: [],
    number: ISSUE_NOT_ON_BOARD,
    title: 'feat(operator-app): expose generator health',
    author: { login: 'carol' },
  },
]);

/** Canned gh project item-list response — only issues 403 and 328 are on the board. */
const PROJECT_ITEMS_JSON = JSON.stringify({
  items: [
    {
      'blocked on': 'Nothing',
      effort: 'Medium',
      priority: 'P1',
      status: 'Done',
      title: '[#220] PR 1: test-gated TaskClaimEmitter redeploy',
      id: 'PVTI_lADODh3-Ac4BXYaIzgtUv1A',
      repository: 'https://github.com/Jinn-Network/mono',
      content: {
        number: ISSUE_ON_BOARD_WITH_TYPE,
        type: 'Issue',
        title: 'fix(client): test-gated TaskClaimEmitter redeploy',
        url: `https://github.com/Jinn-Network/mono/issues/${ISSUE_ON_BOARD_WITH_TYPE}`,
        body: 'Context...',
        repository: 'Jinn-Network/mono',
      },
    },
    {
      'blocked on': 'Nothing',
      priority: 'P1',
      status: 'In Progress',
      title: 'Release feedback — v0.1.6 operator app dogfood (2026-05-19)',
      id: 'PVTI_lADODh3-Ac4BXYaIzgtNV5I',
      repository: 'https://github.com/Jinn-Network/mono',
      content: {
        number: ISSUE_ON_BOARD_NO_TYPE,
        type: 'Issue',
        title: 'Release feedback — v0.1.6 operator app dogfood (2026-05-19)',
        url: `https://github.com/Jinn-Network/mono/issues/${ISSUE_ON_BOARD_NO_TYPE}`,
        body: 'Context...',
        repository: 'Jinn-Network/mono',
      },
    },
  ],
  totalCount: 158,
});

/**
 * Canned GraphQL response for Issue Types.
 * Real shape: {"data":{"repository":{"i403":{"issueType":{"name":"fix"}},"i328":{"issueType":null}}}}
 */
const GRAPHQL_ISSUE_TYPES_JSON = JSON.stringify({
  data: {
    repository: {
      [`i${ISSUE_ON_BOARD_WITH_TYPE}`]: { issueType: { name: 'fix' } },
      [`i${ISSUE_ON_BOARD_NO_TYPE}`]: { issueType: null },
      [`i${ISSUE_NOT_ON_BOARD}`]: { issueType: null },
    },
  },
});

/** Build a fake CommandRunner that returns canned JSON matching real gh shapes. */
function makeFakeRunner(): CommandRunner {
  return async (cmd: string, args: string[]): Promise<string> => {
    if (cmd === 'gh' && args[0] === 'issue') {
      // gh issue list --repo ... --state open --json number,title,labels --limit ...
      return ISSUE_LIST_JSON;
    }
    if (cmd === 'gh' && args[0] === 'project') {
      // gh project item-list 1 --owner Jinn-Network --format json --limit ...
      return PROJECT_ITEMS_JSON;
    }
    if (cmd === 'gh' && args[0] === 'api') {
      // gh api graphql -f query=...
      return GRAPHQL_ISSUE_TYPES_JSON;
    }
    throw new Error(`Unexpected command: ${cmd} ${args.join(' ')}`);
  };
}

describe('GhIssueSource', () => {
  it('maps an issue on the board with Issue Type to a fully-populated PolledIssue', async () => {
    const source = new GhIssueSource(makeFakeRunner());
    const issues = await source.poll();

    const issue = issues.find((i) => i.number === ISSUE_ON_BOARD_WITH_TYPE);
    expect(issue).toBeDefined();
    expect(issue!.shape).toBe('fix');
    expect(issue!.blockedOn).toBe('Nothing');
    expect(issue!.effort).toBe('Medium');
    expect(issue!.priority).toBe('P1');
    expect(issue!.status).toBe('Done');
    expect(issue!.onBoard).toBe(true);
    expect(issue!.blockedOnIssue).toBeNull();
    expect(issue!.author).toBe('alice');
  });

  it('maps an issue on the board with no Issue Type to shape: null', async () => {
    const source = new GhIssueSource(makeFakeRunner());
    const issues = await source.poll();

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
    const issues = await source.poll();

    const issue = issues.find((i) => i.number === ISSUE_NOT_ON_BOARD);
    expect(issue).toBeDefined();
    expect(issue!.onBoard).toBe(false);
    expect(issue!.shape).toBeNull();
    expect(issue!.blockedOn).toBeNull();
    expect(issue!.effort).toBeNull();
    expect(issue!.priority).toBeNull();
    expect(issue!.status).toBeNull();
    expect(issue!.blockedOnIssue).toBeNull();
    expect(issue!.author).toBe('carol');
  });

  it('returns all polled issues (including off-board ones)', async () => {
    const source = new GhIssueSource(makeFakeRunner());
    const issues = await source.poll();
    expect(issues.length).toBe(3);
  });

  it('preserves issue title from the issue list', async () => {
    const source = new GhIssueSource(makeFakeRunner());
    const issues = await source.poll();
    const issue = issues.find((i) => i.number === ISSUE_ON_BOARD_WITH_TYPE);
    expect(issue!.title).toBe('fix(client): test-gated TaskClaimEmitter redeploy');
  });
});
