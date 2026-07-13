import { describe, it, expect, vi } from 'vitest';
import { syncHumanLane } from '../../src/dispatcher/human-lane.js';
import type { CommandRunner } from '../../src/dispatcher/issue-source.js';
import type { FieldCache } from '../../src/dispatcher/field-cache.js';
import type { ProjectSnapshot, SnapshotItem } from '../../src/dispatcher/project-snapshot.js';

const HUMAN_OPTION_ID = 'opt_human';
const TODO_OPTION_ID = 'opt_todo';
const STATUS_FIELD_ID = 'field_status';
const PROJECT_ID = 'PVT_test';

const FIELD_CACHE: FieldCache = {
  projectId: PROJECT_ID,
  status: {
    fieldId: STATUS_FIELD_ID,
    options: {
      Todo: TODO_OPTION_ID,
      'In Progress': 'opt_inprog',
      Human: HUMAN_OPTION_ID,
      'In Review': 'opt_inreview',
      Done: 'opt_done',
    },
  },
  blockedOn: {
    fieldId: 'field_blocked',
    options: { Nothing: 'opt_nothing', Human: 'opt_b_human', 'Another issue': 'opt_another' },
  },
};

function item(overrides: Partial<SnapshotItem> & Pick<SnapshotItem, 'id' | 'number'>): SnapshotItem {
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

function snapshot(items: SnapshotItem[]): ProjectSnapshot {
  return {
    items,
    rateLimit: { remaining: 5000, used: 0, resetAt: '2026-06-14T12:00:00Z' },
    currentSprintIterationId: null,
  };
}

/** Records every `gh project item-edit` call as [itemId, optionId]. */
function recordingRunner(): { runner: CommandRunner; edits: Array<[string, string]> } {
  const edits: Array<[string, string]> = [];
  const runner: CommandRunner = async (cmd, args) => {
    if (cmd === 'gh' && args[0] === 'project' && args[1] === 'item-edit') {
      const id = args[args.indexOf('--id') + 1];
      const opt = args[args.indexOf('--single-select-option-id') + 1];
      edits.push([id, opt]);
      return '';
    }
    throw new Error(`Unexpected command: ${cmd} ${args.join(' ')}`);
  };
  return { runner, edits };
}

describe('syncHumanLane — promote', () => {
  it('promotes an escalated In Progress issue (Blocked on: Human) to Status: Human', async () => {
    const { runner, edits } = recordingRunner();
    const { promoted, demoted } = await syncHumanLane(
      snapshot([item({ id: 'PVTI_1', number: 980, status: 'In Progress', blockedOn: 'Human' })]),
      FIELD_CACHE,
      runner,
    );
    expect(promoted).toEqual([980]);
    expect(demoted).toEqual([]);
    expect(edits).toEqual([['PVTI_1', HUMAN_OPTION_ID]]);
  });

  it('promotes a Todo issue blocked on a human (the human-gated backlog) into the lane', async () => {
    const { runner, edits } = recordingRunner();
    const { promoted } = await syncHumanLane(
      snapshot([item({ id: 'PVTI_2', number: 647, status: 'Todo', blockedOn: 'Human' })]),
      FIELD_CACHE,
      runner,
    );
    expect(promoted).toEqual([647]);
    expect(edits).toEqual([['PVTI_2', HUMAN_OPTION_ID]]);
  });

  it('leaves Done and In Review issues alone even if Blocked on: Human is stale', async () => {
    const { runner, edits } = recordingRunner();
    const { promoted, demoted } = await syncHumanLane(
      snapshot([
        item({ id: 'PVTI_d', number: 930, status: 'Done', blockedOn: 'Human' }),
        item({ id: 'PVTI_r', number: 931, status: 'In Review', blockedOn: 'Human' }),
      ]),
      FIELD_CACHE,
      runner,
    );
    expect(promoted).toEqual([]);
    expect(demoted).toEqual([]);
    expect(edits).toEqual([]);
  });
});

describe('syncHumanLane — demote (unblock path)', () => {
  it('demotes a Human-lane issue back to Todo once it is no longer blocked on a human', async () => {
    const { runner, edits } = recordingRunner();
    const { promoted, demoted } = await syncHumanLane(
      snapshot([item({ id: 'PVTI_1', number: 980, status: 'Human', blockedOn: 'Nothing' })]),
      FIELD_CACHE,
      runner,
    );
    expect(demoted).toEqual([980]);
    expect(promoted).toEqual([]);
    expect(edits).toEqual([['PVTI_1', TODO_OPTION_ID]]);
  });

  it('demotes a Human-lane issue with a cleared (null) block back to Todo', async () => {
    const { runner, edits } = recordingRunner();
    const { demoted } = await syncHumanLane(
      snapshot([item({ id: 'PVTI_1', number: 980, status: 'Human', blockedOn: null })]),
      FIELD_CACHE,
      runner,
    );
    expect(demoted).toEqual([980]);
    expect(edits).toEqual([['PVTI_1', TODO_OPTION_ID]]);
  });
});

describe('syncHumanLane — idempotence / no-ops', () => {
  it('does not touch a correctly-parked item (Status: Human + Blocked on: Human)', async () => {
    const { runner, edits } = recordingRunner();
    const { promoted, demoted } = await syncHumanLane(
      snapshot([item({ id: 'PVTI_1', number: 980, status: 'Human', blockedOn: 'Human' })]),
      FIELD_CACHE,
      runner,
    );
    expect(promoted).toEqual([]);
    expect(demoted).toEqual([]);
    expect(edits).toEqual([]);
  });

  it('does not touch a dispatchable Todo issue (Blocked on: Nothing)', async () => {
    const { runner, edits } = recordingRunner();
    await syncHumanLane(
      snapshot([item({ id: 'PVTI_2', number: 778, status: 'Todo', blockedOn: 'Nothing' })]),
      FIELD_CACHE,
      runner,
    );
    expect(edits).toEqual([]);
  });

  it('ignores non-Issue items (PRs / draft issues)', async () => {
    const { runner, edits } = recordingRunner();
    await syncHumanLane(
      snapshot([
        item({ id: 'PVTI_PR', number: 1, contentType: 'PullRequest', status: 'In Progress', blockedOn: 'Human' }),
      ]),
      FIELD_CACHE,
      runner,
    );
    expect(edits).toEqual([]);
  });
});

describe('syncHumanLane — resilience', () => {
  it('isolates a per-item failure: one bad edit does not stop the others', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const runner: CommandRunner = async (_cmd, args) => {
      if (args[args.indexOf('--id') + 1] === 'PVTI_bad') throw new Error('gh boom');
      return '';
    };
    const { promoted } = await syncHumanLane(
      snapshot([
        item({ id: 'PVTI_bad', number: 111, status: 'Todo', blockedOn: 'Human' }),
        item({ id: 'PVTI_ok', number: 222, status: 'Todo', blockedOn: 'Human' }),
      ]),
      FIELD_CACHE,
      runner,
    );
    expect(promoted).toEqual([222]);
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});
