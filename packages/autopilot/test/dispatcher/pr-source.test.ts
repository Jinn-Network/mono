import { describe, it, expect } from 'vitest';
import { GhPrSource } from '../../src/dispatcher/pr-source.js';
import type { CommandRunner } from '../../src/dispatcher/issue-source.js';

const LABEL = 'engine:review';
const BOT = 'jinn-bot';

const PR_LIST = JSON.stringify([
  { number: 10, title: 'feat: a', headRefName: 'feat/10-a', headRefOid: 'sha10', isDraft: true, author: { login: 'jinn-bot' } },
  { number: 11, title: 'fix: b',  headRefName: 'fix/11-b',  headRefOid: 'sha11', isDraft: false, author: { login: 'alice' } },
]);
const PR10_VIEW = JSON.stringify({
  reviews: [{ author: { login: 'jinn-bot' }, state: 'APPROVED', submittedAt: '2026-05-29T12:00:00Z' }],
  commits: [{ committedDate: '2026-05-29T10:00:00Z' }],
});
const PR11_VIEW = JSON.stringify({
  reviews: [],
  commits: [{ committedDate: '2026-05-29T09:00:00Z' }],
});

function makeRunner() {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const runner: CommandRunner = async (cmd, args) => {
    calls.push({ cmd, args });
    if (args[0] === 'pr' && args[1] === 'list') return PR_LIST;
    if (args[0] === 'pr' && args[1] === 'view' && args[2] === '10') return PR10_VIEW;
    if (args[0] === 'pr' && args[1] === 'view' && args[2] === '11') return PR11_VIEW;
    throw new Error(`Unexpected: ${cmd} ${args.join(' ')}`);
  };
  return { runner, calls };
}

describe('GhPrSource.poll', () => {
  it('lists PRs by the opt-in label and computes needsReview from reviews vs latest commit', async () => {
    const { runner, calls } = makeRunner();
    const polled = await new GhPrSource(runner, LABEL, BOT).poll();
    const list = calls.find((c) => c.args[0] === 'pr' && c.args[1] === 'list');
    expect(list!.args).toContain('--label');
    expect(list!.args[list!.args.indexOf('--label') + 1]).toBe(LABEL);
    const pr10 = polled.find((p) => p.number === 10)!;
    const pr11 = polled.find((p) => p.number === 11)!;
    expect(pr10.hasReviewLabel).toBe(true);
    expect(pr10.headRefName).toBe('feat/10-a');
    expect(pr10.headRefOid).toBe('sha10');
    expect(pr10.author).toBe('jinn-bot');
    expect(pr10.needsReview).toBe(true);
    expect(pr11.needsReview).toBe(true);
    expect(pr11.author).toBe('alice');
  });

  it('reconciles a current bot approval while the PR is still draft', async () => {
    const runner: CommandRunner = async (_cmd, args) => {
      if (args[0] === 'pr' && args[1] === 'list') {
        return JSON.stringify([{
          number: 14,
          title: 't',
          headRefName: 'x',
          headRefOid: 's',
          isDraft: true,
          author: { login: 'jinn-bot' },
        }]);
      }
      if (args[0] === 'pr' && args[1] === 'view') return PR10_VIEW;
      throw new Error('unexpected');
    };

    const polled = await new GhPrSource(runner, LABEL, BOT).poll();

    expect(polled[0]).toMatchObject({ isDraft: true, needsReview: true });
  });

  it('does not redispatch a current bot approval once the PR is ready', async () => {
    const runner: CommandRunner = async (_cmd, args) => {
      if (args[0] === 'pr' && args[1] === 'list') {
        return JSON.stringify([{
          number: 15,
          title: 't',
          headRefName: 'x',
          headRefOid: 's',
          isDraft: false,
          author: { login: 'jinn-bot' },
        }]);
      }
      if (args[0] === 'pr' && args[1] === 'view') return PR10_VIEW;
      throw new Error('unexpected');
    };

    const polled = await new GhPrSource(runner, LABEL, BOT).poll();

    expect(polled[0]).toMatchObject({ isDraft: false, needsReview: false });
  });

  it.each(['CHANGES_REQUESTED', 'COMMENTED'])(
    'preserves a current %s review on a draft without treating it as incomplete approval',
    async (state) => {
      const runner: CommandRunner = async (_cmd, args) => {
        if (args[0] === 'pr' && args[1] === 'list') {
          return JSON.stringify([{
            number: 16,
            title: 't',
            headRefName: 'x',
            headRefOid: 's',
            isDraft: true,
            author: { login: 'jinn-bot' },
          }]);
        }
        if (args[0] === 'pr' && args[1] === 'view') {
          return JSON.stringify({
            reviews: [{
              author: { login: BOT },
              state,
              submittedAt: '2026-05-29T12:00:00Z',
            }],
            commits: [{ committedDate: '2026-05-29T10:00:00Z' }],
          });
        }
        throw new Error('unexpected');
      };

      const polled = await new GhPrSource(runner, LABEL, BOT).poll();

      expect(polled[0]).toMatchObject({ isDraft: true, needsReview: false });
    },
  );

  it('treats a bot review OLDER than the latest commit as stale -> needsReview:true', async () => {
    const STALE_VIEW = JSON.stringify({
      reviews: [{ author: { login: BOT }, state: 'APPROVED', submittedAt: '2026-05-29T08:00:00Z' }],
      commits: [{ committedDate: '2026-05-29T11:00:00Z' }],
    });
    const runner: CommandRunner = async (_cmd, args) => {
      if (args[0] === 'pr' && args[1] === 'list')
        return JSON.stringify([{ number: 12, title: 't', headRefName: 'x', headRefOid: 's', isDraft: false, author: { login: 'bob' } }]);
      if (args[0] === 'pr' && args[1] === 'view') return STALE_VIEW;
      throw new Error('unexpected');
    };
    const polled = await new GhPrSource(runner, LABEL, BOT).poll();
    expect(polled[0].needsReview).toBe(true);
  });

  it('matches the bot review case-insensitively (A1) -> needsReview:false', async () => {
    // Review author login differs only in CASE from the configured BOT
    // ('Jinn-Bot' vs 'jinn-bot'). Case-folding must still detect the current
    // review, else the PR would be re-reviewed forever.
    const MIXED_CASE_VIEW = JSON.stringify({
      reviews: [{ author: { login: 'Jinn-Bot' }, state: 'APPROVED', submittedAt: '2026-05-29T12:00:00Z' }],
      commits: [{ committedDate: '2026-05-29T10:00:00Z' }],
    });
    const runner: CommandRunner = async (_cmd, args) => {
      if (args[0] === 'pr' && args[1] === 'list')
        return JSON.stringify([{ number: 13, title: 't', headRefName: 'x', headRefOid: 's', isDraft: false, author: { login: 'bob' } }]);
      if (args[0] === 'pr' && args[1] === 'view') return MIXED_CASE_VIEW;
      throw new Error('unexpected');
    };
    const polled = await new GhPrSource(runner, LABEL, BOT).poll();
    expect(polled[0].needsReview).toBe(false);
  });

  it('returns empty when reviewBotLogin is empty (fail-safe, no gh calls)', async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const runner: CommandRunner = async (cmd, args) => { calls.push({ cmd, args }); return '[]'; };
    const polled = await new GhPrSource(runner, LABEL, '').poll();
    expect(polled).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});
