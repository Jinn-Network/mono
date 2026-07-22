import { describe, expect, it, vi } from 'vitest';
import {
  carryoverEnabled,
  childrenPathEnabled,
  closeChildrenFor,
  countChildrenOfKind,
  fileChildIssue,
  findOpenChildren,
  formatChildMarker,
  parseChildMarker,
  shouldFileRunawayHold,
  type ChildIssuePort,
  type ChildIssueRecord,
} from '../../src/lifecycle/child-issues.js';

function record(
  over: Partial<ChildIssueRecord> & Pick<ChildIssueRecord, 'number' | 'kind' | 'parentPr'>,
): ChildIssueRecord {
  const marker = formatChildMarker(over.parentPr, over.kind);
  return {
    title: over.title ?? `Child ${over.number}`,
    body: over.body ?? `${marker}\n\nfindings`,
    state: over.state ?? 'open',
    labels: over.labels ?? [over.kind, 'effort:low', 'priority:p1'],
    ...over,
  };
}

function fakePort(seed: ChildIssueRecord[] = []): ChildIssuePort & {
  readonly created: { title: string; body: string; labels: string[] }[];
  readonly closed: number[];
  readonly typed: number[];
} {
  const issues = [...seed];
  const created: { title: string; body: string; labels: string[] }[] = [];
  const closed: number[] = [];
  const typed: number[] = [];
  let next = Math.max(0, ...issues.map((issue) => issue.number)) + 1;
  return {
    created,
    closed,
    typed,
    async searchOpenByMarker(marker) {
      return issues.filter(
        (issue) => issue.state === 'open' && issue.body.includes(marker),
      );
    },
    async listByParentAndKind(parentPr, kind) {
      return issues.filter(
        (issue) => issue.parentPr === parentPr && issue.kind === kind,
      );
    },
    async createIssue(input) {
      created.push({ ...input, labels: [...input.labels] });
      const marker = parseChildMarker(input.body);
      if (marker === null) throw new Error('create without marker');
      const number = next;
      next += 1;
      issues.push({
        number,
        title: input.title,
        body: input.body,
        state: 'open',
        labels: [...input.labels],
        parentPr: marker.parentPr,
        kind: marker.kind,
      });
      return { number };
    },
    async setIssueTypeFix(issueNumber) {
      typed.push(issueNumber);
    },
    async closeIssue(issueNumber, _comment) {
      closed.push(issueNumber);
      const index = issues.findIndex((issue) => issue.number === issueNumber);
      if (index >= 0) {
        issues[index] = { ...issues[index]!, state: 'closed' };
      }
    },
  };
}

describe('child marker parse/format', () => {
  it('round-trips review-finding and reconcile markers', () => {
    for (const kind of ['review-finding', 'reconcile'] as const) {
      const marker = formatChildMarker(42, kind);
      expect(marker).toBe(`<!-- jinn-autopilot:child pr=42 kind=${kind} -->`);
      expect(parseChildMarker(marker)).toEqual({ parentPr: 42, kind });
      expect(parseChildMarker(`preamble\n${marker}\ntrail`)).toEqual({
        parentPr: 42,
        kind,
      });
    }
  });

  it('rejects malformed markers', () => {
    expect(parseChildMarker('<!-- jinn-autopilot:child pr=0 kind=reconcile -->')).toBeNull();
    expect(parseChildMarker('<!-- jinn-autopilot:child pr=1 kind=finding -->')).toBeNull();
    expect(parseChildMarker('no marker')).toBeNull();
  });
});

describe('fileChildIssue', () => {
  it('creates once and is idempotent on the open marker', async () => {
    const port = fakePort();
    const first = await fileChildIssue(port, {
      parentPr: 10,
      kind: 'review-finding',
      title: 'Fix findings for #10',
      body: 'Blocking: missing test',
      effort: 'low',
      priority: 'p1',
    });
    expect(first).toMatchObject({ created: true });
    if ('runawayHold' in first && first.runawayHold) throw new Error('unexpected hold');
    expect(port.created).toHaveLength(1);
    expect(port.created[0]!.labels).toEqual([
      'review-finding',
      'effort:low',
      'priority:p1',
    ]);
    expect(port.created[0]!.body).toContain(formatChildMarker(10, 'review-finding'));
    expect(port.typed).toEqual([first.number]);

    const second = await fileChildIssue(port, {
      parentPr: 10,
      kind: 'review-finding',
      title: 'Fix findings for #10 again',
      body: 'more',
      effort: 'medium',
      priority: 'p1',
    });
    expect(second).toEqual({ number: first.number, created: false });
    expect(port.created).toHaveLength(1);
  });

  it('allows a different kind on the same parent', async () => {
    const port = fakePort([
      record({ number: 1, parentPr: 7, kind: 'review-finding' }),
    ]);
    const result = await fileChildIssue(port, {
      parentPr: 7,
      kind: 'reconcile',
      title: 'Reconcile #7',
      body: 'conflicts',
      effort: 'medium',
      priority: 'p1',
    });
    expect(result).toMatchObject({ created: true });
    if ('runawayHold' in result && result.runawayHold) throw new Error('unexpected hold');
    expect(port.created[0]!.labels[0]).toBe('reconcile');
  });

  it('returns runawayHold when prior children of the kind already hit the limit', async () => {
    const port = fakePort([
      record({ number: 1, parentPr: 8, kind: 'reconcile', state: 'closed' }),
      record({ number: 2, parentPr: 8, kind: 'reconcile', state: 'closed' }),
      record({ number: 3, parentPr: 8, kind: 'reconcile', state: 'closed' }),
    ]);
    const result = await fileChildIssue(port, {
      parentPr: 8,
      kind: 'reconcile',
      title: 'Reconcile #8 again',
      body: 'still conflicting',
      effort: 'medium',
      priority: 'p1',
    });
    expect(result).toEqual({ runawayHold: true, priorCount: 3 });
    expect(port.created).toHaveLength(0);
  });
});

describe('findOpenChildren / closeChildrenFor', () => {
  it('lists open children and closes them', async () => {
    const port = fakePort([
      record({ number: 1, parentPr: 3, kind: 'review-finding' }),
      record({ number: 2, parentPr: 3, kind: 'reconcile' }),
      record({ number: 3, parentPr: 3, kind: 'reconcile', state: 'closed' }),
      record({ number: 4, parentPr: 9, kind: 'reconcile' }),
    ]);
    const open = await findOpenChildren(port, 3);
    expect(open.map((issue) => issue.number).sort()).toEqual([1, 2]);

    const closed = await closeChildrenFor(port, 3, 'parent merged');
    expect([...closed].sort()).toEqual([1, 2]);
    expect([...port.closed].sort()).toEqual([1, 2]);
    expect(await findOpenChildren(port, 3)).toEqual([]);
  });
});

describe('runaway helpers and knobs', () => {
  it('counts prior children of one kind', async () => {
    const port = fakePort([
      record({ number: 1, parentPr: 5, kind: 'reconcile' }),
      record({ number: 2, parentPr: 5, kind: 'reconcile', state: 'closed' }),
      record({ number: 3, parentPr: 5, kind: 'review-finding' }),
    ]);
    expect(await countChildrenOfKind(port, 5, 'reconcile')).toBe(2);
    expect(shouldFileRunawayHold(2)).toBe(false);
    expect(shouldFileRunawayHold(3)).toBe(true);
  });

  it('defaults children on and carryover on (Stage 4)', () => {
    expect(childrenPathEnabled({})).toBe(true);
    expect(childrenPathEnabled({ JINN_AUTOPILOT_CHILDREN: '0' })).toBe(false);
    expect(childrenPathEnabled({ JINN_AUTOPILOT_CHILDREN: 'false' })).toBe(false);
    expect(carryoverEnabled({})).toBe(true);
    expect(carryoverEnabled({ JINN_AUTOPILOT_CARRYOVER: '' })).toBe(true);
    expect(carryoverEnabled({ JINN_AUTOPILOT_CARRYOVER: '0' })).toBe(false);
    expect(carryoverEnabled({ JINN_AUTOPILOT_CARRYOVER: 'false' })).toBe(false);
    expect(carryoverEnabled({ JINN_AUTOPILOT_CARRYOVER: 'no' })).toBe(false);
    expect(carryoverEnabled({ JINN_AUTOPILOT_CARRYOVER: 'off' })).toBe(false);
    expect(carryoverEnabled({ JINN_AUTOPILOT_CARRYOVER: '1' })).toBe(true);
    expect(carryoverEnabled({ JINN_AUTOPILOT_CARRYOVER: 'yes' })).toBe(true);
  });
});

describe('production port GraphQL type assign contract', () => {
  it('uses the fix Issue Type id constant', async () => {
    const { FIX_ISSUE_TYPE_ID, makeProductionChildIssuePort } = await import(
      '../../src/lifecycle/child-issues-production.js'
    );
    expect(FIX_ISSUE_TYPE_ID).toBe('IT_kwDODh3-Ac4BvpyK');

    const calls: string[][] = [];
    const port = makeProductionChildIssuePort({
      runner: async (_cmd, args) => {
        calls.push([...args]);
        if (args[0] === 'issue' && args[1] === 'list') {
          return '[]';
        }
        if (args[0] === 'issue' && args[1] === 'create') {
          return 'https://github.com/Jinn-Network/mono/issues/99\n';
        }
        if (args[0] === 'issue' && args[1] === 'view') {
          return 'I_kwIssue99\n';
        }
        if (args[0] === 'api' && args[1] === 'graphql') {
          return '{"data":{}}';
        }
        return '';
      },
    });

    const filed = await fileChildIssue(port, {
      parentPr: 12,
      kind: 'reconcile',
      title: 'Reconcile',
      body: 'x',
      effort: 'low',
      priority: 'p1',
    });
    expect(filed).toEqual({ number: 99, created: true });
    const graphql = calls.find((args) => args[0] === 'api' && args[1] === 'graphql');
    expect(graphql?.join(' ')).toContain('typeId=IT_kwDODh3-Ac4BvpyK');
    expect(graphql?.join(' ')).toContain('issueId=I_kwIssue99');
    // silence unused vi import if tree-shaken differently
    expect(vi).toBeDefined();
  });
});