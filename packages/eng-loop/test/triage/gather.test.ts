import { describe, it, expect } from 'vitest';
import { gatherRealityCheckSignals } from '../../src/triage/gather.js';
import type { CommandRunner } from '../../src/dispatcher/issue-source.js';
import { classifyRealityCheck } from '../../src/triage/reality-check.js';

/**
 * Tests for the shell-command signal gatherer.
 *
 * Gather sequences four commands and reduces their output to a
 * {@link RealityCheckInput}:
 *
 *   1. `git fetch --all --quiet`                                  (always)
 *   2. `gh search prs '#<N> in:body' --repo Jinn-Network/mono …`
 *   3. `gh issue view <N> --json closedByPullRequestsReferences …`
 *   4. `git log --all --grep='#<N>\\b' --format='%H\\t%D\\t%s'`
 *   5. for each commit SHA: `git branch -a --contains <sha>`
 *
 * Tests use an injected {@link CommandRunner} that records the call
 * sequence and dispatches canned responses.
 */

// ---------------------------------------------------------------------------
// Fake runner — records calls + dispatches canned responses
// ---------------------------------------------------------------------------

interface Recorder {
  calls: Array<{ cmd: string; args: string[] }>;
}

function recorder(): Recorder {
  return { calls: [] };
}

function makeRunner(
  rec: Recorder,
  responses: { matcher: (cmd: string, args: string[]) => boolean; reply: string | (() => string) }[],
): CommandRunner {
  return async (cmd, args) => {
    rec.calls.push({ cmd, args });
    for (const r of responses) {
      if (r.matcher(cmd, args)) {
        return typeof r.reply === 'function' ? r.reply() : r.reply;
      }
    }
    throw new Error(`unhandled command: ${cmd} ${args.join(' ')}`);
  };
}

// ---------------------------------------------------------------------------
// Helpers — common matchers
// ---------------------------------------------------------------------------

const isGitFetch = (cmd: string, args: string[]) =>
  cmd === 'git' && args[0] === 'fetch' && args.includes('--all') && args.includes('--quiet');

const isGhSearchPrs = (cmd: string, args: string[]) =>
  cmd === 'gh' && args[0] === 'search' && args[1] === 'prs';

const isGhPrView = (cmd: string, args: string[]) =>
  cmd === 'gh' && args[0] === 'pr' && args[1] === 'view';

const isGhIssueView = (cmd: string, args: string[]) =>
  cmd === 'gh' && args[0] === 'issue' && args[1] === 'view';

/**
 * Match `gh pr view <n> …` for a specific PR number. The CLI receives the
 * PR number as a string, so we compare against the third positional arg.
 */
const isGhPrViewFor = (prNumber: number) =>
  (cmd: string, args: string[]): boolean =>
    isGhPrView(cmd, args) && args[2] === String(prNumber);

const isGitLog = (cmd: string, args: string[]) =>
  cmd === 'git' && args[0] === 'log' && args.includes('--all');

const isGitBranchContains = (cmd: string, args: string[]) =>
  cmd === 'git' && args[0] === 'branch' && args.includes('--contains');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('gatherRealityCheckSignals', () => {
  it('issue 561 with c627afc2 only on release/v2026.05.25 → fixed-pending-backmerge (AC #4)', async () => {
    const rec = recorder();
    // `gh search prs --json number,body` now returns only the lite shape;
    // full PR detail (state / headRefName / mergeCommit / mergedAt /
    // closedAt) comes from a follow-up `gh pr view <n>` call per PR.
    const ghSearchReply = JSON.stringify([
      { number: 562, body: 'Closes #561' },
    ]);
    const ghPrViewReply = JSON.stringify({
      number: 562,
      state: 'MERGED',
      title: 'fix: scarce thing',
      headRefName: 'fix/561-scarce-thing',
      body: 'Closes #561',
      mergeCommit: { oid: 'c627afc28abcd0000000000000000000000000ab' },
      mergedAt: '2026-05-25T00:00:00Z',
      closedAt: '2026-05-25T00:00:00Z',
    });
    const ghIssueViewReply = JSON.stringify({
      closedByPullRequestsReferences: [{ number: 562 }],
    });
    // git log --all --grep='#561\b' --format='%H%x09%D%x09%s'
    // One commit, with refs containing release branch (DEcoration not used by gatherer)
    const gitLogReply =
      `c627afc28abcd0000000000000000000000000ab\trefs/remotes/origin/release/v2026.05.25\tfix: scarce thing (#561)\n`;
    // git branch -a --contains c627afc28abcd0000000000000000000000000ab
    // Shows only the release branch on origin (no `origin/next`, no `origin/main`).
    const gitBranchReply =
      `  remotes/origin/release/v2026.05.25\n` +
      `  release/v2026.05.25\n`;

    const runner = makeRunner(rec, [
      { matcher: isGitFetch, reply: '' },
      { matcher: isGhSearchPrs, reply: ghSearchReply },
      { matcher: isGhPrViewFor(562), reply: ghPrViewReply },
      { matcher: isGhIssueView, reply: ghIssueViewReply },
      { matcher: isGitLog, reply: gitLogReply },
      { matcher: isGitBranchContains, reply: gitBranchReply },
    ]);

    const input = await gatherRealityCheckSignals(561, runner);

    // Sanity on the signal shape:
    expect(input.issueNumber).toBe(561);
    expect(input.closedByPrNumbers).toContain(562);
    expect(input.prs).toHaveLength(1);
    expect(input.prs[0]).toMatchObject({
      number: 562,
      state: 'MERGED',
      bodyClosesIssue: true,
      mergeCommitOid: 'c627afc28abcd0000000000000000000000000ab',
    });
    expect(input.commits).toHaveLength(1);
    expect(input.commits[0]).toMatchObject({
      sha: 'c627afc28abcd0000000000000000000000000ab',
      isRevert: false,
      reachableFrom: {
        trunk: [],
        side: [{ kind: 'release', name: 'release/v2026.05.25' }],
      },
    });

    // End-to-end classification: pending back-merge.
    const verdict = classifyRealityCheck(input);
    expect(verdict.classification).toBe('fixed-pending-backmerge');
  });

  it('runs git fetch --all --quiet exactly once at the top', async () => {
    const rec = recorder();
    const runner = makeRunner(rec, [
      { matcher: isGitFetch, reply: '' },
      { matcher: isGhSearchPrs, reply: '[]' },
      { matcher: isGhIssueView, reply: JSON.stringify({ closedByPullRequestsReferences: [] }) },
      { matcher: isGitLog, reply: '' },
    ]);

    await gatherRealityCheckSignals(572, runner);

    const fetches = rec.calls.filter((c) => isGitFetch(c.cmd, c.args));
    expect(fetches).toHaveLength(1);
    // Must be the first call.
    expect(isGitFetch(rec.calls[0].cmd, rec.calls[0].args)).toBe(true);
  });

  it('fail-loud: rethrows when gh exits non-zero', async () => {
    const rec = recorder();
    const runner: CommandRunner = async (cmd, args) => {
      rec.calls.push({ cmd, args });
      if (isGitFetch(cmd, args)) return '';
      if (isGhSearchPrs(cmd, args)) throw new Error('gh: 503 Service Unavailable');
      throw new Error(`unhandled command: ${cmd} ${args.join(' ')}`);
    };
    await expect(gatherRealityCheckSignals(572, runner)).rejects.toThrow(
      /503 Service Unavailable/,
    );
  });

  it('fail-loud: rethrows when git log exits non-zero', async () => {
    const rec = recorder();
    const runner: CommandRunner = async (cmd, args) => {
      rec.calls.push({ cmd, args });
      if (isGitFetch(cmd, args)) return '';
      if (isGhSearchPrs(cmd, args)) return '[]';
      if (isGhIssueView(cmd, args)) {
        return JSON.stringify({ closedByPullRequestsReferences: [] });
      }
      if (isGitLog(cmd, args)) throw new Error('git: fatal: bad revision');
      throw new Error(`unhandled command: ${cmd} ${args.join(' ')}`);
    };
    await expect(gatherRealityCheckSignals(572, runner)).rejects.toThrow(
      /bad revision/,
    );
  });

  it('digit-boundary at the gather layer: a commit subject mentioning (#5721) does not match #572', async () => {
    const rec = recorder();
    // git log with an UNRELATED #5721 hit in the subject — gatherer must
    // drop it because the regex word-boundary check rejects digit-extended
    // matches. (The real git log invocation already uses `--grep='#572\b'`
    // but with `\b` in BRE this only narrows partially; the gatherer
    // therefore re-filters the parsed output.)
    const gitLogReply =
      `aaaa1111\trefs/remotes/origin/next\tfix: foo (#5721)\n`;

    const runner = makeRunner(rec, [
      { matcher: isGitFetch, reply: '' },
      { matcher: isGhSearchPrs, reply: '[]' },
      {
        matcher: isGhIssueView,
        reply: JSON.stringify({ closedByPullRequestsReferences: [] }),
      },
      { matcher: isGitLog, reply: gitLogReply },
    ]);

    const input = await gatherRealityCheckSignals(572, runner);
    expect(input.commits).toHaveLength(0);
  });

  it('detects revert subjects via Conventional-Commit prefix too', async () => {
    const rec = recorder();
    const gitLogReply =
      `bbbb2222\trefs/remotes/origin/next\trevert(scope): fix foo (#572)\n` +
      `ffff0000\trefs/remotes/origin/next\tfix: foo (#572)\n`;

    const runner = makeRunner(rec, [
      { matcher: isGitFetch, reply: '' },
      { matcher: isGhSearchPrs, reply: '[]' },
      {
        matcher: isGhIssueView,
        reply: JSON.stringify({ closedByPullRequestsReferences: [] }),
      },
      { matcher: isGitLog, reply: gitLogReply },
      {
        matcher: isGitBranchContains,
        reply: '  remotes/origin/next\n',
      },
    ]);

    const input = await gatherRealityCheckSignals(572, runner);
    expect(input.commits.find((c) => c.sha === 'bbbb2222')!.isRevert).toBe(true);
    expect(input.commits.find((c) => c.sha === 'ffff0000')!.isRevert).toBe(false);
  });

  it('marks bodyClosesIssue=true when the PR is in closedByPullRequestsReferences even without a closure keyword', async () => {
    const rec = recorder();
    const ghSearchReply = JSON.stringify([
      { number: 700, body: 'Related to #572 but no closure keyword' },
    ]);
    const ghPrViewReply = JSON.stringify({
      number: 700,
      state: 'MERGED',
      title: 'feat: thing',
      headRefName: 'feat/700-thing',
      body: 'Related to #572 but no closure keyword',
      mergeCommit: { oid: 'cafecafe' },
      mergedAt: '2026-05-25T00:00:00Z',
      closedAt: '2026-05-25T00:00:00Z',
    });
    const ghIssueViewReply = JSON.stringify({
      closedByPullRequestsReferences: [{ number: 700 }],
    });

    const runner = makeRunner(rec, [
      { matcher: isGitFetch, reply: '' },
      { matcher: isGhSearchPrs, reply: ghSearchReply },
      { matcher: isGhPrViewFor(700), reply: ghPrViewReply },
      { matcher: isGhIssueView, reply: ghIssueViewReply },
      { matcher: isGitLog, reply: '' },
    ]);

    const input = await gatherRealityCheckSignals(572, runner);
    expect(input.prs[0].bodyClosesIssue).toBe(true);
  });

  it('marks bodyClosesIssue=false when neither body keyword nor closedByPrs reference', async () => {
    const rec = recorder();
    const ghSearchReply = JSON.stringify([
      { number: 700, body: 'See also #572 for context' },
    ]);
    const ghPrViewReply = JSON.stringify({
      number: 700,
      state: 'MERGED',
      title: 'feat: thing',
      headRefName: 'feat/700-thing',
      body: 'See also #572 for context',
      mergeCommit: { oid: 'cafecafe' },
      mergedAt: '2026-05-25T00:00:00Z',
      closedAt: '2026-05-25T00:00:00Z',
    });
    const ghIssueViewReply = JSON.stringify({
      closedByPullRequestsReferences: [],
    });

    const runner = makeRunner(rec, [
      { matcher: isGitFetch, reply: '' },
      { matcher: isGhSearchPrs, reply: ghSearchReply },
      { matcher: isGhPrViewFor(700), reply: ghPrViewReply },
      { matcher: isGhIssueView, reply: ghIssueViewReply },
      { matcher: isGitLog, reply: '' },
    ]);

    const input = await gatherRealityCheckSignals(572, runner);
    expect(input.prs[0].bodyClosesIssue).toBe(false);
  });

  it('throws when issueNumber is not a positive integer (0, -1, 1.5)', async () => {
    const runner: CommandRunner = async () => '';
    for (const bad of [0, -1, 1.5]) {
      await expect(gatherRealityCheckSignals(bad, runner)).rejects.toThrow(
        /must be a positive integer/,
      );
    }
  });

  it('regression: parses the real flat-array shape of gh issue view --json closedByPullRequestsReferences', async () => {
    // Live shape captured from `gh issue view 602 --repo Jinn-Network/mono
    // --json closedByPullRequestsReferences`:
    //   {"closedByPullRequestsReferences":[{"id":"…","number":613,
    //    "repository":{"id":"…","name":"mono","owner":{…}},
    //    "url":"https://github.com/Jinn-Network/mono/pull/613"}]}
    // The earlier code assumed a GraphQL `{nodes: [...]}` wrapper that gh
    // does NOT emit for this field; parsing crashed with
    // "Cannot read properties of undefined (reading 'map')".
    const rec = recorder();
    const liveIssueViewReply = JSON.stringify({
      closedByPullRequestsReferences: [
        {
          id: 'PR_kwDORvo7lc7fLaQS',
          number: 613,
          repository: {
            id: 'R_kgDORvo7lQ',
            name: 'mono',
            owner: { id: 'O_kgDODh3-AQ', login: 'Jinn-Network' },
          },
          url: 'https://github.com/Jinn-Network/mono/pull/613',
        },
      ],
    });

    const runner = makeRunner(rec, [
      { matcher: isGitFetch, reply: '' },
      { matcher: isGhSearchPrs, reply: '[]' },
      { matcher: isGhIssueView, reply: liveIssueViewReply },
      { matcher: isGitLog, reply: '' },
    ]);

    const input = await gatherRealityCheckSignals(602, runner);
    expect(input.closedByPrNumbers).toEqual([613]);
  });

  it('regression: gh search prs --json only requests fields gh search prs actually supports', async () => {
    // `gh search prs --json` exposes a narrower set than `gh pr view --json`.
    // Asking for `headRefName` / `mergedAt` / `mergeCommit` here makes gh
    // exit non-zero ("Unknown JSON field"), breaking `yarn triage:check`
    // end-to-end. The per-PR detail call (`gh pr view`) covers those.
    const SEARCH_SUPPORTED = new Set([
      'assignees', 'author', 'authorAssociation', 'body', 'closedAt',
      'commentsCount', 'createdAt', 'id', 'isDraft', 'isLocked',
      'isPullRequest', 'labels', 'number', 'repository', 'state', 'title',
      'updatedAt', 'url',
    ]);

    const rec = recorder();
    const runner = makeRunner(rec, [
      { matcher: isGitFetch, reply: '' },
      { matcher: isGhSearchPrs, reply: '[]' },
      {
        matcher: isGhIssueView,
        reply: JSON.stringify({ closedByPullRequestsReferences: [] }),
      },
      { matcher: isGitLog, reply: '' },
    ]);

    await gatherRealityCheckSignals(675, runner);

    const ghSearch = rec.calls.find((c) => isGhSearchPrs(c.cmd, c.args));
    expect(ghSearch).toBeDefined();
    const args = ghSearch!.args;
    const jsonIdx = args.indexOf('--json');
    expect(jsonIdx).toBeGreaterThan(-1);
    const fields = args[jsonIdx + 1].split(',');
    for (const f of fields) {
      expect(SEARCH_SUPPORTED).toContain(f);
    }
    // Belt-and-braces: the three fields that broke this in the wild must
    // never appear in the search-prs argv.
    for (const banned of ['headRefName', 'mergedAt', 'mergeCommit']) {
      expect(fields).not.toContain(banned);
    }
  });

  it('regression: gh search prs argv never contains `--state all` (gh rejects it)', async () => {
    const rec = recorder();
    const runner = makeRunner(rec, [
      { matcher: isGitFetch, reply: '' },
      { matcher: isGhSearchPrs, reply: '[]' },
      {
        matcher: isGhIssueView,
        reply: JSON.stringify({ closedByPullRequestsReferences: [] }),
      },
      { matcher: isGitLog, reply: '' },
    ]);

    await gatherRealityCheckSignals(675, runner);

    const ghSearch = rec.calls.find((c) => isGhSearchPrs(c.cmd, c.args));
    expect(ghSearch).toBeDefined();
    const args = ghSearch!.args;
    // `gh search prs --state` accepts only {open|closed}. Passing "all"
    // makes gh exit non-zero, which broke `yarn triage:check` end-to-end.
    const stateIdx = args.indexOf('--state');
    if (stateIdx !== -1) {
      expect(args[stateIdx + 1]).not.toBe('all');
      expect(['open', 'closed']).toContain(args[stateIdx + 1]);
    }
    // Belt-and-braces: regardless of `--state` placement, `all` must not
    // appear as the immediate successor of any `--state` token.
    for (let i = 0; i < args.length - 1; i++) {
      if (args[i] === '--state') {
        expect(args[i + 1]).not.toBe('all');
      }
    }
  });

  it('buckets `origin/next` and `origin/main` as trunk, release/* + hotfix/* as side, ignores other refs', async () => {
    const rec = recorder();
    const gitLogReply = `abc1234\t\tfix: foo (#572)\n`;
    const gitBranchReply =
      `  remotes/origin/next\n` +
      `  remotes/origin/main\n` +
      `  remotes/origin/release/v2026.05.25\n` +
      `  remotes/origin/hotfix/v2026.05.20-x\n` +
      `  remotes/origin/feat/some-branch\n` +
      `  feat/local-branch\n`;

    const runner = makeRunner(rec, [
      { matcher: isGitFetch, reply: '' },
      { matcher: isGhSearchPrs, reply: '[]' },
      {
        matcher: isGhIssueView,
        reply: JSON.stringify({ closedByPullRequestsReferences: [] }),
      },
      { matcher: isGitLog, reply: gitLogReply },
      { matcher: isGitBranchContains, reply: gitBranchReply },
    ]);

    const input = await gatherRealityCheckSignals(572, runner);
    const reach = input.commits[0].reachableFrom;
    expect(reach.trunk.sort()).toEqual(['main', 'next']);
    expect(reach.side).toEqual(
      expect.arrayContaining([
        { kind: 'release', name: 'release/v2026.05.25' },
        { kind: 'hotfix', name: 'hotfix/v2026.05.20-x' },
      ]),
    );
    expect(reach.side).toHaveLength(2);
  });
});
