import { beforeEach, describe, expect, it } from 'vitest';
import { resetFieldCache } from '../../src/dispatcher/field-cache.js';
import { fileReviewFollowUps } from '../../src/lifecycle/review-follow-ups.js';
import {
  FEAT_ISSUE_TYPE_ID,
  makeProductionReviewFollowUpPort,
} from '../../src/lifecycle/review-follow-ups-production.js';

const HEAD = 'a'.repeat(40);

const FIELD_LIST_JSON = JSON.stringify({
  fields: [
    {
      id: 'PVTSSF_blocked',
      name: 'Blocked on',
      options: [
        { id: 'opt_nothing', name: 'Nothing' },
        { id: 'opt_human', name: 'Human' },
        { id: 'opt_another', name: 'Another issue' },
      ],
    },
    {
      id: 'PVTSSF_status',
      name: 'Status',
      options: [
        { id: 'opt_todo', name: 'Todo' },
        { id: 'opt_in_progress', name: 'In Progress' },
        { id: 'opt_human_status', name: 'Human' },
        { id: 'opt_in_review', name: 'In Review' },
        { id: 'opt_done', name: 'Done' },
      ],
    },
    {
      id: 'PVTSSF_effort',
      name: 'Effort',
      options: [
        { id: 'opt_low', name: 'Low' },
        { id: 'opt_medium', name: 'Medium' },
        { id: 'opt_high', name: 'High' },
        { id: 'opt_xhigh', name: 'XHigh' },
        { id: 'opt_max', name: 'Max' },
      ],
    },
    {
      id: 'PVTSSF_priority',
      name: 'Priority',
      options: [
        { id: 'opt_p0', name: 'P0' },
        { id: 'opt_p1', name: 'P1' },
        { id: 'opt_p2', name: 'P2' },
        { id: 'opt_p3', name: 'P3' },
        { id: 'opt_p4', name: 'P4' },
      ],
    },
  ],
});

describe('makeProductionReviewFollowUpPort', () => {
  beforeEach(() => {
    resetFieldCache();
  });

  it('files a triage-complete follow-up without child labels or markers', async () => {
    const calls: string[][] = [];
    const port = makeProductionReviewFollowUpPort({
      runner: async (_cmd, args) => {
        calls.push([...args]);
        if (args[0] === 'issue' && args[1] === 'list') {
          return '[]';
        }
        if (args[0] === 'issue' && args[1] === 'create') {
          return 'https://github.com/Jinn-Network/mono/issues/501\n';
        }
        if (args[0] === 'issue' && args[1] === 'view') {
          return 'I_kwIssue501\n';
        }
        if (args[0] === 'api' && args[1] === 'graphql') {
          return '{"data":{}}';
        }
        if (args[0] === 'project' && args[1] === 'field-list') {
          return FIELD_LIST_JSON;
        }
        if (args[0] === 'project' && args[1] === 'item-add') {
          return JSON.stringify({ id: 'PVTI_followup501' });
        }
        if (args[0] === 'project' && args[1] === 'item-edit') {
          return '';
        }
        throw new Error(`Unexpected gh args: ${args.join(' ')}`);
      },
    });

    const filed = await fileReviewFollowUps(port, {
      parentPr: 84,
      head: HEAD,
      entries: [{
        type: 'feat',
        title: 'Extract timeout helper',
        body: 'Non-blocking debt.',
        effort: 'medium',
        priority: 'p2',
      }],
    });

    expect(filed).toEqual([{ number: 501, created: true, index: 0 }]);

    const listCall = calls.find((args) => args[0] === 'issue' && args[1] === 'list');
    expect(listCall).toEqual(expect.arrayContaining([
      '--json', 'number,body',
    ]));
    expect(listCall!.join(' ')).not.toContain('title');
    expect(listCall!.join(' ')).not.toContain('labels');

    const createCall = calls.find((args) => args[0] === 'issue' && args[1] === 'create');
    expect(createCall).toBeDefined();
    expect(createCall).toEqual(expect.arrayContaining([
      '--label', 'effort:medium',
      '--label', 'priority:p2',
    ]));
    expect(createCall!.join(' ')).not.toContain('review-finding');
    expect(createCall!.join(' ')).not.toContain('reconcile');
    expect(createCall!.join(' ')).toContain('jinn-autopilot:review-follow-up');
    expect(createCall!.join(' ')).not.toContain('jinn-autopilot:child');

    const graphql = calls.find((args) => args[0] === 'api' && args[1] === 'graphql');
    expect(graphql?.join(' ')).toContain(`typeId=${FEAT_ISSUE_TYPE_ID}`);
    expect(graphql?.join(' ')).toContain('issueId=I_kwIssue501');
    expect(graphql?.join(' ')).toContain('updateIssueIssueType');

    const itemAdd = calls.find((args) => args[0] === 'project' && args[1] === 'item-add');
    expect(itemAdd).toEqual(expect.arrayContaining([
      'item-add', '1', '--owner', 'Jinn-Network',
      '--url', 'https://github.com/Jinn-Network/mono/issues/501',
      '--format', 'json',
    ]));

    const itemEdits = calls.filter((args) => args[0] === 'project' && args[1] === 'item-edit');
    expect(itemEdits).toHaveLength(3);
    expect(itemEdits.some((args) =>
      args.includes('PVTSSF_blocked') && args.includes('opt_nothing'),
    )).toBe(true);
    expect(itemEdits.some((args) =>
      args.includes('PVTSSF_effort') && args.includes('opt_medium'),
    )).toBe(true);
    expect(itemEdits.some((args) =>
      args.includes('PVTSSF_priority') && args.includes('opt_p2'),
    )).toBe(true);
  });

  it('reuses an open follow-up matched by marker without recreating but still triages', async () => {
    const marker =
      `<!-- jinn-autopilot:review-follow-up pr=84 head=${HEAD} index=0 -->`;
    const calls: string[][] = [];
    let createCount = 0;
    let listCount = 0;
    const port = makeProductionReviewFollowUpPort({
      runner: async (_cmd, args) => {
        calls.push([...args]);
        if (args[0] === 'issue' && args[1] === 'list') {
          listCount += 1;
          return JSON.stringify([{
            number: 400,
            body: `${marker}\n\nold`,
          }]);
        }
        if (args[0] === 'issue' && args[1] === 'create') {
          createCount += 1;
          return 'https://github.com/Jinn-Network/mono/issues/999\n';
        }
        if (args[0] === 'issue' && args[1] === 'view') {
          return 'I_kwIssue400\n';
        }
        if (args[0] === 'api' && args[1] === 'graphql') {
          return '{"data":{}}';
        }
        if (args[0] === 'project' && args[1] === 'field-list') {
          return FIELD_LIST_JSON;
        }
        if (args[0] === 'project' && args[1] === 'item-add') {
          return JSON.stringify({ id: 'PVTI_followup400' });
        }
        if (args[0] === 'project' && args[1] === 'item-edit') {
          return '';
        }
        throw new Error(`Unexpected gh args: ${args.join(' ')}`);
      },
    });

    const filed = await fileReviewFollowUps(port, {
      parentPr: 84,
      head: HEAD,
      entries: [{
        type: 'chore',
        title: 'Existing',
        body: 'x',
        effort: 'low',
        priority: 'p3',
      }],
    });

    expect(filed).toEqual([{ number: 400, created: false, index: 0 }]);
    expect(createCount).toBe(0);
    expect(listCount).toBe(1);
    expect(calls.some((args) => args[0] === 'api' && args[1] === 'graphql')).toBe(true);
    expect(calls.filter((args) => args[0] === 'project' && args[1] === 'item-edit'))
      .toHaveLength(3);
  });
});
