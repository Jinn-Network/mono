import { describe, it, expect } from 'vitest';
import { fetchIssuePrMap } from '../../src/dispatcher/pr-links.js';
import type { CommandRunner } from '../../src/dispatcher/issue-source.js';

function runnerReturning(json: unknown): CommandRunner {
  return async () => JSON.stringify(json);
}

describe('fetchIssuePrMap', () => {
  it('maps each closingIssuesReference to its PR link and normalizes state', async () => {
    const runner = runnerReturning([
      {
        number: 500, headRefName: 'feat/50-a', baseRefName: 'next', state: 'OPEN', isDraft: true,
        author: { login: 'ritsukai' },
        closingIssuesReferences: [{ number: 50 }],
      },
      {
        number: 501, headRefName: 'fix/60-b', baseRefName: 'next', state: 'MERGED', isDraft: false,
        closingIssuesReferences: [{ number: 60 }, { number: 61 }], // one PR can close several issues
      },
      {
        number: 502, headRefName: 'x', baseRefName: 'next', state: 'CLOSED', isDraft: false,
        closingIssuesReferences: [], // closes nothing → contributes to no issue
      },
    ]);
    const map = await fetchIssuePrMap(runner);
    expect(map.get(50)).toEqual([
      { prNumber: 500, headRefName: 'feat/50-a', baseRefName: 'next', state: 'OPEN', isDraft: true, author: 'ritsukai', labels: [] },
    ]);
    expect(map.get(60)?.[0].state).toBe('MERGED');
    expect(map.get(61)?.[0].prNumber).toBe(501);
    expect(map.has(999)).toBe(false);
  });

  it('accumulates multiple PRs that close the same issue (e.g. a closed attempt + a live one)', async () => {
    const runner = runnerReturning([
      { number: 10, headRefName: 'old', baseRefName: 'next', state: 'CLOSED', isDraft: false, closingIssuesReferences: [{ number: 5 }] },
      { number: 11, headRefName: 'new', baseRefName: 'next', state: 'OPEN', isDraft: true, closingIssuesReferences: [{ number: 5 }] },
    ]);
    const map = await fetchIssuePrMap(runner);
    expect(map.get(5)?.map((l) => l.state).sort()).toEqual(['CLOSED', 'OPEN']);
  });

  it('skips a PR with an unrecognized state rather than corrupting the map', async () => {
    const runner = runnerReturning([
      { number: 1, headRefName: 'h', baseRefName: 'next', state: 'WEIRD', isDraft: false, closingIssuesReferences: [{ number: 7 }] },
    ]);
    const map = await fetchIssuePrMap(runner);
    expect(map.has(7)).toBe(false);
  });

  it('returns an empty map when there are no PRs', async () => {
    const map = await fetchIssuePrMap(runnerReturning([]));
    expect(map.size).toBe(0);
  });
});
