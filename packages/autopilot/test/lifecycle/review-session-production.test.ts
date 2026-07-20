import { describe, expect, it } from 'vitest';
import type { AttemptManifest } from '../../src/lifecycle/attempt-workspace.js';
import { encodeReviewClaimPayload } from '../../src/lifecycle/codecs.js';
import {
  makeProductionReviewSessionPort,
} from '../../src/lifecycle/review-session-production.js';
import {
  gitOid,
  type ReviewClaimRecord,
} from '../../src/lifecycle/types.js';

const HEAD = gitOid('1'.repeat(40));
const REVIEW = gitOid('2'.repeat(40));
const RECORD = gitOid('3'.repeat(40));
const TREE = gitOid('4'.repeat(40));
const BLOB = gitOid('5'.repeat(40));
const ATTEMPT = '11111111-1111-4111-8111-111111111111';
const GENERATION = '22222222-2222-4222-8222-222222222222';

function claim(): ReviewClaimRecord {
  return {
    kind: 'review-claim',
    protocolVersion: 2,
    prNumber: 84,
    generation: GENERATION,
    attempt: ATTEMPT,
    reviewer: 'review-bot',
    head: HEAD,
    state: 'active',
    recordedAt: '2026-07-20T12:00:00.000Z',
  };
}

function manifest(): AttemptManifest {
  return {
    version: 2,
    attemptId: ATTEMPT,
    runnerId: 'runner',
    host: 'host',
    phase: 'review',
    subject: 'pr-84',
    issueNumber: 42,
    prNumber: 84,
    branch: 'autopilot/42',
    targetBase: 'next',
    expectedHead: HEAD,
    claimOid: REVIEW,
    reviewGeneration: GENERATION,
    reviewRefOid: REVIEW,
    reviewApprovalPolicy: 'approve-eligible',
    selectedLogin: 'review-bot',
    repository: {
      root: '/repo',
      gitCommonDir: '/repo/.git',
      remoteName: 'origin',
      remoteUrlHash: 'a'.repeat(64),
    },
    processState: 'running',
    pid: 42,
    paths: {
      attemptDir: '/attempt',
      worktree: '/attempt/worktree',
      manifest: '/attempt/manifest.json',
      log: '/attempt/log',
      ghConfigDir: '/attempt/gh',
      askpass: '/attempt/askpass',
    },
    timestamps: {
      createdAt: '2026-07-20T12:00:00.000Z',
      updatedAt: '2026-07-20T12:00:00.000Z',
      childStartedAt: '2026-07-20T12:00:00.000Z',
    },
  };
}

describe('production review session port', () => {
  it('uses only the selected credential and explicit review commit_id/event/body', async () => {
    const calls: Array<{
      cmd: string;
      args: string[];
      env?: Record<string, string>;
    }> = [];
    const port = makeProductionReviewSessionPort({
      environment: {
        GH_TOKEN: 'selected-secret',
        GITHUB_TOKEN: 'ambient-secret',
        JINN_IMPL_GH_TOKEN: 'other-secret',
        JINN_AUTOPILOT_SESSION_MANIFEST: '/attempt/manifest.json',
      },
      readManifest: () => manifest(),
      runner: async (cmd, args, options) => {
        calls.push({ cmd, args, env: options?.env });
        if (cmd === 'gh' && args.join(' ') === 'api user --jq .login') {
          return 'review-bot\n';
        }
        if (cmd === 'gh' && args.includes('view')) {
          return JSON.stringify({
            number: 84,
            headRefOid: HEAD,
            headRefName: 'autopilot/42',
            baseRefName: 'next',
            isDraft: false,
            body: '<!-- jinn-autopilot:v2 issue=42 branch=autopilot/42 -->',
            author: { login: 'implementation-bot' },
            labels: [{ name: 'engine:review' }],
          });
        }
        if (cmd === 'gh' && args.join(' ').includes('repos/Jinn-Network/mono/pulls/84/reviews')) {
          return '{}';
        }
        throw new Error(`unexpected ${cmd} ${args.join(' ')}`);
      },
    });

    await port.submitNativeReview({
      manifest: manifest(),
      prNumber: 84,
      commitId: HEAD,
      reviewer: 'review-bot',
      state: 'APPROVE',
      body: 'exact body',
    });

    const mutation = calls.find((call) => call.args.includes('--method'));
    expect(mutation?.args).toEqual([
      'api', '--method', 'POST',
      'repos/Jinn-Network/mono/pulls/84/reviews',
      '-f', `commit_id=${HEAD}`,
      '-f', 'event=APPROVE',
      '-f', 'body=exact body',
    ]);
    expect(mutation?.env).toMatchObject({ GH_TOKEN: 'selected-secret' });
    expect(mutation?.env?.GITHUB_TOKEN).toBe('');
    expect(mutation?.env?.JINN_IMPL_GH_TOKEN).toBe('');
  });

  it('reads the exact review ref payload and validates selected identity and canonical HTTPS remote', async () => {
    const calls: string[] = [];
    const port = makeProductionReviewSessionPort({
      environment: {
        GH_TOKEN: 'selected-secret',
        JINN_AUTOPILOT_SESSION_MANIFEST: '/attempt/manifest.json',
      },
      readManifest: () => manifest(),
      runner: async (cmd, args) => {
        calls.push(`${cmd} ${args.join(' ')}`);
        if (cmd === 'gh') return 'review-bot\n';
        if (args.includes('get-url')) return 'https://github.com/Jinn-Network/mono.git\n';
        if (args.includes('ls-remote')) {
          return `${REVIEW}\trefs/jinn-autopilot/review-claims/v1/84\n`;
        }
        if (args.includes('fetch')) return '';
        if (args.includes('show')) return `${encodeReviewClaimPayload(claim())}\n`;
        throw new Error(`unexpected ${cmd} ${args.join(' ')}`);
      },
    });

    await expect(port.readAuthority(manifest())).resolves.toEqual({
      reviewRefOid: REVIEW,
      record: claim(),
    });
    expect(calls.some((call) => call.includes('ls-remote'))).toBe(true);
    expect(calls.some((call) => call.includes('jinn-autopilot-review.json'))).toBe(true);
  });

  it('creates append-only metadata commits with the exact sole parent', async () => {
    const calls: string[][] = [];
    const port = makeProductionReviewSessionPort({
      environment: {
        GH_TOKEN: 'selected-secret',
        JINN_AUTOPILOT_SESSION_MANIFEST: '/attempt/manifest.json',
      },
      readManifest: () => manifest(),
      writeMetadataFile: () => '/attempt/metadata.json',
      removeMetadataFile: () => undefined,
      runner: async (cmd, args) => {
        expect(cmd).toBe('git');
        calls.push(args);
        if (args.includes('hash-object')) return `${BLOB}\n`;
        if (args.includes('write-tree')) return `${TREE}\n`;
        if (args.includes('commit-tree')) return `${RECORD}\n`;
        return '';
      },
    });

    await expect(port.createReviewRecord({
      manifest: manifest(),
      parent: REVIEW,
      record: claim(),
    })).resolves.toBe(RECORD);

    const commit = calls.find((args) => args.includes('commit-tree'));
    expect(commit).toEqual(expect.arrayContaining([
      'commit-tree', TREE, '-p', REVIEW,
    ]));
    expect(calls.find((args) => args.includes('update-index')))
      .toEqual(expect.arrayContaining([
        '--cacheinfo', `100644,${BLOB},jinn-autopilot-review.json`,
      ]));
  });
});
