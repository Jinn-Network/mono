import { describe, expect, it } from 'vitest';
import type { AttemptManifest } from '../../src/lifecycle/attempt-workspace.js';
import {
  makeProductionMergePrepSessionPort,
  rangeDiffProvesMechanical,
} from '../../src/lifecycle/merge-prep-session-production.js';
import { encodeBranchClaimTrailers } from '../../src/lifecycle/codecs.js';
import { gitOid, gitRefName } from '../../src/lifecycle/types.js';

const CLAIM = gitOid('1'.repeat(40));
const PREPARED = gitOid('2'.repeat(40));
const BASE = gitOid('3'.repeat(40));
const ATTEMPT = '11111111-1111-4111-8111-111111111111';

describe('production merge-prep session port', () => {
  it('classifies only a complete patch-equivalent range-diff as mechanical', () => {
    expect(rangeDiffProvesMechanical([
      '1:  aaaaaaa = 1:  bbbbbbb Preserve the first patch',
      '2:  ccccccc = 2:  ddddddd Preserve the second patch',
    ].join('\n'))).toBe(true);
    expect(rangeDiffProvesMechanical(
      '1:  aaaaaaa ! 1:  bbbbbbb Conflict resolution changed the patch',
    )).toBe(false);
    expect(rangeDiffProvesMechanical(
      '1:  aaaaaaa < -:  ------- Patch disappeared',
    )).toBe(false);
    expect(rangeDiffProvesMechanical('')).toBe(false);
  });

  it('publishes the prepared exact child with a selected-identity lease', async () => {
    const calls: Array<{ args: string[]; env?: Record<string, string> }> = [];
    let remote = CLAIM;
    const port = makeProductionMergePrepSessionPort({
      environment: {
        GH_TOKEN: 'selected-secret',
        GITHUB_TOKEN: 'ambient-secret',
        JINN_AUTOPILOT_SESSION_MANIFEST: '/attempt/manifest.json',
      },
      runner: async (command, args, options) => {
        expect(command).toBe('git');
        calls.push({ args, env: options?.env });
        if (args.includes('rev-list')) return `${PREPARED} ${CLAIM}\n`;
        if (args.includes('ls-remote')) {
          return `${remote}\trefs/heads/autopilot/42\n`;
        }
        if (args.includes('push')) {
          remote = PREPARED;
          return '';
        }
        throw new Error(`unexpected ${args.join(' ')}`);
      },
    });
    const manifest = {
      branch: 'autopilot/42',
      paths: {
        askpass: '/attempt/askpass',
        worktree: '/attempt/worktree',
      },
      repository: { remoteName: 'jinn-autopilot-v2' },
    } as AttemptManifest;

    await expect(port.publishPrepared({
      manifest,
      expectedRemoteHead: CLAIM,
      newHead: PREPARED,
    })).resolves.toMatchObject({ status: 'won', observed: PREPARED });

    const push = calls.find((call) => call.args.includes('push'));
    expect(push?.args).toContain(
      `--force-with-lease=refs/heads/autopilot/42:${CLAIM}`,
    );
    expect(push?.args).toContain('jinn-autopilot-v2');
    expect(calls.every((call) => call.env?.GH_TOKEN === 'selected-secret')).toBe(true);
    expect(calls.every((call) => call.env?.GITHUB_TOKEN === '')).toBe(true);
  });

  it('carries incomplete REST changed-file evidence into session authority', async () => {
    const claim = {
      kind: 'branch-claim' as const,
      protocolVersion: 2 as const,
      phase: 'merge-prep' as const,
      issueNumber: 42,
      prNumber: 84,
      attempt: ATTEMPT,
      runner: 'runner-a',
      login: 'implementation-bot',
      expectedHead: PREPARED,
      targetBase: gitRefName('next'),
      targetBaseOid: BASE,
      claimedAt: '2026-07-20T12:00:00.000Z',
    };
    const manifest = {
      phase: 'merge-prep',
      attemptId: ATTEMPT,
      runnerId: 'runner-a',
      issueNumber: 42,
      prNumber: 84,
      branch: 'autopilot/42',
      targetBase: 'next',
      targetBaseOid: BASE,
      selectedLogin: 'implementation-bot',
      paths: {
        askpass: '/attempt/askpass',
        worktree: '/attempt/worktree',
        ghConfigDir: '/attempt/gh',
      },
      repository: { remoteName: 'jinn-autopilot-v2' },
    } as unknown as AttemptManifest;
    const port = makeProductionMergePrepSessionPort({
      environment: {
        GH_TOKEN: 'selected-secret',
        JINN_AUTOPILOT_SESSION_MANIFEST: '/attempt/manifest.json',
      },
      runner: async (command, args) => {
        if (command === 'git' && args.includes('remote')) {
          return 'https://github.com/Jinn-Network/mono.git\n';
        }
        if (command === 'git' && args.includes('ls-remote')) {
          const ref = args.at(-1);
          if (ref === 'refs/heads/autopilot/42') {
            return `${CLAIM}\t${ref}\n`;
          }
          if (ref === 'refs/heads/next') return `${BASE}\t${ref}\n`;
        }
        if (command === 'git' && args.includes('fetch')) return '';
        if (command === 'git' && args.includes('rev-list')) return `${CLAIM}\n`;
        if (command === 'git' && args.includes('show')) {
          return `Autopilot merge-prep claim\n\n${encodeBranchClaimTrailers(claim)}`;
        }
        if (command === 'gh' && args[0] === 'api' && args[1] === 'user') {
          return 'implementation-bot\n';
        }
        if (command === 'gh' && args[0] === 'pr' && args[1] === 'view') {
          return JSON.stringify({
            number: 84,
            headRefOid: CLAIM,
            headRefName: 'autopilot/42',
            baseRefName: 'next',
            isDraft: true,
            labels: [{ name: 'engine:review' }],
            body: '<!-- jinn-autopilot:v2 issue=42 branch=autopilot/42 -->',
          });
        }
        if (command === 'gh' && args[0] === 'api' && args[1] === 'graphql') {
          return JSON.stringify({
            data: {
              rateLimit: {
                remaining: 4999,
                used: 1,
                resetAt: '2026-07-20T13:00:00.000Z',
              },
              organization: {
                projectV2: {
                  sprintField: null,
                  items: {
                    pageInfo: { hasNextPage: false, endCursor: null },
                    nodes: [{
                      id: 'PVTI_issue_42',
                      content: {
                        __typename: 'Issue',
                        number: 42,
                        issueType: { name: 'feat' },
                        blockedBy: { nodes: [] },
                      },
                      status: { name: 'In Review' },
                      priority: { name: 'P1' },
                      effort: { name: 'High' },
                      blockedOn: { name: 'Nothing' },
                      sprint: null,
                    }],
                  },
                },
              },
            },
          });
        }
        if (
          command === 'gh'
          && args.some((arg) => arg === 'repos/Jinn-Network/mono/pulls/84')
        ) {
          return JSON.stringify({
            changed_files: 2,
            head: { sha: CLAIM },
            base: { ref: 'next', sha: BASE },
          });
        }
        if (
          command === 'gh'
          && args.some((arg) =>
            arg.startsWith('repos/Jinn-Network/mono/pulls/84/files?'))
        ) {
          return JSON.stringify([[{ filename: 'src/visible.ts' }]]);
        }
        if (
          command === 'gh'
          && args.some((arg) =>
            arg === `repos/Jinn-Network/mono/contents/.github/CODEOWNERS?ref=${BASE}`)
        ) {
          return JSON.stringify({
            content: Buffer.from('# no owned paths\n').toString('base64'),
          });
        }
        throw new Error(`unexpected ${command} ${args.join(' ')}`);
      },
    });

    await expect(port.readAuthority(manifest)).resolves.toMatchObject({
      targetBaseOid: BASE,
      pullRequest: {
        changedFilesComplete: false,
        codeownerSensitive: false,
      },
    });
  });
});
