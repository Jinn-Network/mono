import { describe, it, expect } from 'vitest';
import { makePauseSession } from '../../src/dispatcher/pause-session.js';
import type { FieldCache } from '../../src/dispatcher/field-cache.js';
import type {
  ProjectSnapshot,
  SnapshotItem,
  CommandRunner,
} from '../../src/dispatcher/project-snapshot.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PROJECT_ID = 'PVT_kwDODh3-Ac4BXYaI';

const FIELD_CACHE: FieldCache = {
  projectId: PROJECT_ID,
  status: {
    fieldId: 'PVTSSF_STATUS_FIELD_ID',
    options: {
      Todo: 'opt_todo',
      'In Progress': 'opt_in_progress',
      Human: 'opt_human',
      'In Review': 'opt_in_review',
      Done: 'opt_done',
    },
  },
  blockedOn: {
    fieldId: 'PVTSSF_lADODh3-Ac4BXYaIzhTdqRo',
    options: {
      Nothing: '122744bf',
      Human: 'a20d20ac',
      'Another issue': 'e3e1b0c4',
    },
  },
};

function makeIssueItem(number: number, id: string): SnapshotItem {
  return {
    id,
    number,
    contentType: 'Issue',
    status: 'In Progress',
    priority: 'P1',
    effort: 'Medium',
    blockedOn: 'Nothing',
    issueType: 'feat',
    blockedByIssues: [],
    sprintIterationId: null,
  };
}

function makePrItem(number: number, id: string): SnapshotItem {
  return {
    id,
    number,
    contentType: 'PullRequest',
    status: null,
    priority: null,
    effort: null,
    blockedOn: null,
    issueType: null,
    blockedByIssues: [],
    sprintIterationId: null,
  };
}

function makeSnapshot(items: SnapshotItem[]): ProjectSnapshot {
  return {
    items,
    rateLimit: { remaining: 5000, used: 0, resetAt: '' },
    currentSprintIterationId: null,
  };
}

type RunnerCall = { cmd: string; args: string[] };

function makeRunner(): { runner: CommandRunner; calls: RunnerCall[] } {
  const calls: RunnerCall[] = [];
  const runner: CommandRunner = async (cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === 'gh' && args[0] === 'project' && args[1] === 'item-edit') return '';
    throw new Error(`Unexpected command: ${cmd} ${args.join(' ')}`);
  };
  return { runner, calls };
}

function makeCapturingLogger(): {
  log: (msg: string) => void;
  error: (msg: string) => void;
  logs: string[];
  errors: string[];
} {
  const logs: string[] = [];
  const errors: string[] = [];
  return {
    log: (m: string) => logs.push(m),
    error: (m: string) => errors.push(m),
    logs,
    errors,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('makePauseSession', () => {
  it('looks up the project item id from snapshot.items by issue number and sets Blocked on: Human', async () => {
    const snapshot = makeSnapshot([
      makeIssueItem(201, 'PVTI_TEST_201'),
      makeIssueItem(202, 'PVTI_TEST_202'),
      makePrItem(999, 'PVTI_PR_999'),
    ]);
    const { runner, calls } = makeRunner();
    const logger = makeCapturingLogger();

    const pauseSession = makePauseSession(snapshot, FIELD_CACHE, runner, logger);
    await pauseSession(201);

    // Exactly one runner call — the item-edit on PVTI_TEST_201.
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      cmd: 'gh',
      args: [
        'project', 'item-edit',
        '--id', 'PVTI_TEST_201',
        '--project-id', PROJECT_ID,
        '--field-id', FIELD_CACHE.blockedOn.fieldId,
        '--single-select-option-id', FIELD_CACHE.blockedOn.options.Human,
      ],
    });
  });

  it('does NOT call gh project item-list (#599)', async () => {
    const snapshot = makeSnapshot([makeIssueItem(201, 'PVTI_TEST_201')]);
    const { runner, calls } = makeRunner();
    const logger = makeCapturingLogger();

    const pauseSession = makePauseSession(snapshot, FIELD_CACHE, runner, logger);
    await pauseSession(201);

    const itemListCalls = calls.filter(
      (c) => c.cmd === 'gh' && c.args[0] === 'project' && c.args[1] === 'item-list',
    );
    expect(itemListCalls).toHaveLength(0);
  });

  it('does NOT call gh project field-list (#599)', async () => {
    const snapshot = makeSnapshot([makeIssueItem(201, 'PVTI_TEST_201')]);
    const { runner, calls } = makeRunner();
    const logger = makeCapturingLogger();

    const pauseSession = makePauseSession(snapshot, FIELD_CACHE, runner, logger);
    await pauseSession(201);

    const fieldListCalls = calls.filter(
      (c) => c.cmd === 'gh' && c.args[0] === 'project' && c.args[1] === 'field-list',
    );
    expect(fieldListCalls).toHaveLength(0);
  });

  it('logs error and returns when the issue is not in the snapshot', async () => {
    const snapshot = makeSnapshot([makeIssueItem(201, 'PVTI_TEST_201')]);
    const { runner, calls } = makeRunner();
    const logger = makeCapturingLogger();

    const pauseSession = makePauseSession(snapshot, FIELD_CACHE, runner, logger);
    await pauseSession(999); // not in snapshot

    // No item-edit call — pause-session bails out cleanly.
    expect(calls).toHaveLength(0);

    // Operator-visible log line — preserve wording for log-stability
    // across releases.
    const substring =
      'pauseSession: issue #999 not found in project board — cannot set Blocked on: Human';
    const hit = logger.errors.find((m) => m.includes(substring));
    expect(hit).toBeDefined();
  });

  it('ignores PullRequest items with the same number as the target issue', async () => {
    // GitHub edge case: an Issue and a linked PR can share a number.
    // makePauseSession must resolve to the Issue's item id, not the PR's.
    const snapshot = makeSnapshot([
      makePrItem(201, 'PVTI_PR_201'),
      makeIssueItem(201, 'PVTI_ISSUE_201'),
    ]);
    const { runner, calls } = makeRunner();
    const logger = makeCapturingLogger();

    const pauseSession = makePauseSession(snapshot, FIELD_CACHE, runner, logger);
    await pauseSession(201);

    expect(calls).toHaveLength(1);
    const idIdx = calls[0].args.indexOf('--id');
    expect(calls[0].args[idIdx + 1]).toBe('PVTI_ISSUE_201');
  });
});
