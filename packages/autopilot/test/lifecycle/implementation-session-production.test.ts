import { describe, expect, it } from 'vitest';
import type { CommandRunner } from '../../src/dispatcher/issue-source.js';
import type { AttemptManifest } from '../../src/lifecycle/attempt-workspace.js';
import { encodeBranchClaimTrailers } from '../../src/lifecycle/codecs.js';
import {
  makeProductionImplementationSessionPort,
} from '../../src/lifecycle/implementation-session-production.js';
import { gitOid, gitRefName, type BranchClaim } from '../../src/lifecycle/types.js';

const CLAIM = gitOid('1'.repeat(40));
const WORK = gitOid('2'.repeat(40));
const ATTEMPT = '11111111-1111-4111-8111-111111111111';

function branchClaim(): BranchClaim {
  return {
    kind: 'branch-claim',
    protocolVersion: 2,
    phase: 'implement',
    issueNumber: 42,
    prNumber: 84,
    attempt: ATTEMPT,
    runner: 'runner-a',
    login: 'implementation-bot',
    expectedHead: CLAIM,
    targetBase: gitRefName('next'),
    claimedAt: '2026-07-20T12:00:00.000Z',
  };
}

function manifest(): AttemptManifest {
  return {
    version: 2,
    attemptId: ATTEMPT,
    runnerId: 'runner-a',
    host: 'host-a',
    phase: 'implement',
    subject: 'issue-42',
    issueNumber: 42,
    prNumber: 84,
    branch: 'autopilot/42',
    targetBase: 'next',
    expectedHead: CLAIM,
    claimOid: CLAIM,
    selectedLogin: 'implementation-bot',
    repository: {
      root: '/repo',
      gitCommonDir: '/repo/.git',
      remoteName: 'jinn-autopilot-v2',
      remoteUrlHash: 'a'.repeat(64),
    },
    processState: 'running',
    pid: 4242,
    paths: {
      attemptDir: '/attempt',
      worktree: '/attempt/worktree',
      manifest: '/attempt/manifest.json',
      log: '/attempt/session.log',
      ghConfigDir: '/attempt/gh-config',
      askpass: '/attempt/askpass',
    },
    timestamps: {
      createdAt: '2026-07-20T12:00:00.000Z',
      updatedAt: '2026-07-20T12:01:00.000Z',
      childStartedAt: '2026-07-20T12:01:00.000Z',
    },
  };
}

function projectSnapshot(status: 'In Progress' | 'Human' | 'In Review'): string {
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
              status: { name: status },
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

function projectFields(): string {
  return JSON.stringify({
    fields: [
      {
        id: 'status-field',
        name: 'Status',
        options: [
          { id: 'todo', name: 'Todo' },
          { id: 'in-progress', name: 'In Progress' },
          { id: 'human', name: 'Human' },
          { id: 'in-review', name: 'In Review' },
          { id: 'done', name: 'Done' },
        ],
      },
      {
        id: 'blocked-field',
        name: 'Blocked on',
        options: [
          { id: 'nothing', name: 'Nothing' },
          { id: 'human-blocked', name: 'Human' },
          { id: 'another-issue', name: 'Another issue' },
        ],
      },
    ],
  });
}

function pullRequest(
  labels: readonly string[],
  draft = true,
): string {
  return JSON.stringify({
    number: 84,
    headRefName: 'autopilot/42',
    baseRefName: 'next',
    headRefOid: CLAIM,
    isDraft: draft,
    labels: labels.map((name) => ({ name })),
    body: 'Closes #42\n\n<!-- jinn-autopilot:v2 issue=42 branch=autopilot/42 -->',
  });
}

describe('production implementation session port', () => {
  it('reads winning claim ancestry through only the canonical HTTPS remote and selected identity', async () => {
    const calls: Array<{ cmd: string; args: string[]; env?: Record<string, string> }> = [];
    const runner: CommandRunner = async (cmd, args, options) => {
      calls.push({ cmd, args, env: options?.env });
      if (cmd === 'git' && args.includes('get-url')) {
        return 'https://github.com/Jinn-Network/mono.git\n';
      }
      if (cmd === 'gh' && args.includes('user')) return 'implementation-bot\n';
      if (cmd === 'git' && args.includes('ls-remote')) {
        return `${WORK}\trefs/heads/autopilot/42\n`;
      }
      if (cmd === 'git' && args.includes('fetch')) return '';
      if (cmd === 'git' && args.includes('rev-list')) return `${WORK}\n${CLAIM}\n`;
      if (cmd === 'git' && args.includes('show')) {
        const oid = args.at(-1);
        return oid === CLAIM
          ? `Implementation claim\n\n${encodeBranchClaimTrailers(branchClaim())}\n`
          : 'work\n';
      }
      throw new Error(`unexpected call: ${cmd} ${args.join(' ')}`);
    };
    const port = makeProductionImplementationSessionPort({
      runner,
      environment: {
        GH_TOKEN: 'selected-secret',
        GITHUB_TOKEN: 'ambient-secret',
        SSH_AUTH_SOCK: '/tmp/agent.sock',
      },
    });

    await expect(port.readAuthority(manifest())).resolves.toEqual({
      remoteHead: WORK,
      latestClaimOid: CLAIM,
      latestClaim: branchClaim(),
    });

    expect(calls.some(({ args }) => args.includes('git@github.com'))).toBe(false);
    for (const call of calls) {
      expect(call.env?.GH_TOKEN).toBe('selected-secret');
      expect(call.env?.GITHUB_TOKEN).toBe('');
      expect(call.env?.GIT_SSH_COMMAND).toBe('false');
      expect(call.env?.GIT_ASKPASS).toBe('/attempt/askpass');
    }
  });

  it('rejects an SSH or non-canonical configured remote before publication', async () => {
    const calls: string[][] = [];
    const runner: CommandRunner = async (cmd, args) => {
      calls.push([cmd, ...args]);
      if (cmd === 'git' && args.includes('get-url')) {
        return 'git@github.com:Jinn-Network/mono.git\n';
      }
      throw new Error('must not continue');
    };
    const port = makeProductionImplementationSessionPort({
      runner,
      environment: { GH_TOKEN: 'selected-secret' },
    });

    await expect(port.readAuthority(manifest())).rejects.toThrow(/canonical HTTPS/i);
    expect(calls).toHaveLength(1);
  });

  it('fails closed on newer malformed lifecycle metadata instead of adopting an older claim', async () => {
    const runner: CommandRunner = async (cmd, args) => {
      if (cmd === 'git' && args.includes('get-url')) {
        return 'https://github.com/Jinn-Network/mono.git\n';
      }
      if (cmd === 'gh' && args.includes('user')) return 'implementation-bot\n';
      if (cmd === 'git' && args.includes('ls-remote')) {
        return `${WORK}\trefs/heads/autopilot/42\n`;
      }
      if (cmd === 'git' && args.includes('fetch')) return '';
      if (cmd === 'git' && args.includes('rev-list')) return `${WORK}\n${CLAIM}\n`;
      if (cmd === 'git' && args.includes('show')) {
        return args.at(-1) === WORK
          ? 'work\n\nJinn-Autopilot-Protocol: 2\n'
          : `claim\n\n${encodeBranchClaimTrailers(branchClaim())}\n`;
      }
      throw new Error(`unexpected call: ${cmd} ${args.join(' ')}`);
    };
    const port = makeProductionImplementationSessionPort({
      runner,
      environment: {
        GH_TOKEN: 'selected-secret',
        JINN_AUTOPILOT_SESSION_MANIFEST: '/attempt/manifest.json',
      },
    });

    await expect(port.readAuthority(manifest())).rejects.toThrow(
      /malformed lifecycle metadata/i,
    );
  });

  it('publishes checkpoints with the exact expected-remote lease and askpass', async () => {
    const calls: Array<{ cmd: string; args: string[]; env?: Record<string, string> }> = [];
    let remoteHead = CLAIM;
    const runner: CommandRunner = async (cmd, args, options) => {
      calls.push({ cmd, args, env: options?.env });
      if (cmd === 'git' && args.includes('get-url')) {
        return 'https://github.com/Jinn-Network/mono.git\n';
      }
      if (cmd === 'git' && args.includes('ls-remote')) {
        return `${remoteHead}\trefs/heads/autopilot/42\n`;
      }
      if (cmd === 'git' && args.includes('push')) {
        remoteHead = WORK;
        return '';
      }
      throw new Error(`unexpected call: ${cmd} ${args.join(' ')}`);
    };
    const port = makeProductionImplementationSessionPort({
      runner,
      environment: { GH_TOKEN: 'selected-secret', GITHUB_TOKEN: 'ambient-secret' },
    });

    await expect(port.publishBranch({
      manifest: manifest(),
      expectedRemoteHead: CLAIM,
      newHead: WORK,
    })).resolves.toMatchObject({
      status: 'won',
      expected: CLAIM,
      published: WORK,
    });

    const push = calls.find(({ args }) => args.includes('push'))!;
    expect(push.args).toContain(`--force-with-lease=refs/heads/autopilot/42:${CLAIM}`);
    expect(push.args).toContain(`${WORK}:refs/heads/autopilot/42`);
    expect(push.env).toMatchObject({
      GH_TOKEN: 'selected-secret',
      GITHUB_TOKEN: '',
      GIT_ASKPASS: '/attempt/askpass',
      GIT_SSH_COMMAND: 'false',
    });
  });

  it('uses the session-bound manifest for PR mutations without ambient fallback', async () => {
    const runner: CommandRunner = async (cmd, args) => {
      if (cmd === 'gh' && args.includes('view')) {
        return JSON.stringify({
          number: 84,
          headRefName: 'autopilot/42',
          baseRefName: 'next',
          headRefOid: CLAIM,
          isDraft: true,
          labels: [{ name: 'engine:review' }],
          body: 'Closes #42',
        });
      }
      throw new Error(`unexpected call: ${cmd} ${args.join(' ')}`);
    };
    const bound = manifest();
    const port = makeProductionImplementationSessionPort({
      runner,
      environment: {
        GH_TOKEN: 'selected-secret',
        JINN_AUTOPILOT_SESSION_MANIFEST: bound.paths.manifest,
      },
      readManifest: () => bound,
    });

    await expect(port.readPullRequest(84, CLAIM)).resolves.toMatchObject({
      number: 84,
      head: CLAIM,
      draft: true,
    });
  });

  it.each([
    ['Project In Review', 'label'],
    ['Project In Review', 'status'],
    ['ready', 'label'],
    ['ready', 'status'],
  ] as const)(
    'fails closed at the production %s mutation boundary when a Human %s arrives',
    async (mutation, humanSignal) => {
      let labels = ['engine:review'];
      let status: 'In Progress' | 'Human' | 'In Review' = 'In Progress';
      let draft = true;
      let prReads = 0;
      let projectReads = 0;
      const mutations: string[] = [];
      const runner: CommandRunner = async (cmd, args) => {
        if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'view') {
          prReads += 1;
          const response = pullRequest(labels, draft);
          if (mutation === 'ready' && prReads === 1) {
            if (humanSignal === 'label') labels = [...labels, 'review:needs-human'];
            else status = 'Human';
          }
          return response;
        }
        if (cmd === 'gh' && args[0] === 'api' && args[1] === 'graphql') {
          projectReads += 1;
          return projectSnapshot(status);
        }
        if (cmd === 'gh' && args[0] === 'project' && args[1] === 'field-list') {
          if (mutation === 'Project In Review') {
            if (humanSignal === 'label') labels = [...labels, 'review:needs-human'];
            else status = 'Human';
          }
          return projectFields();
        }
        if (cmd === 'gh' && args[0] === 'project' && args[1] === 'item-edit') {
          mutations.push('project');
          status = 'In Review';
          return '';
        }
        if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'ready') {
          mutations.push('ready');
          draft = false;
          return '';
        }
        throw new Error(`unexpected call: ${cmd} ${args.join(' ')}`);
      };
      const bound = manifest();
      const port = makeProductionImplementationSessionPort({
        runner,
        environment: {
          GH_TOKEN: 'selected-secret',
          JINN_AUTOPILOT_SESSION_MANIFEST: bound.paths.manifest,
        },
        readManifest: () => bound,
      });

      const operation = mutation === 'Project In Review'
        ? port.setProjectStatus(42, CLAIM, 'In Review')
        : port.setPullRequestDraft(84, CLAIM, false);

      await expect(operation).rejects.toThrow(/Human/i);
      expect(mutations).toEqual([]);
      expect(prReads).toBeGreaterThanOrEqual(2);
      expect(projectReads).toBeGreaterThanOrEqual(1);
    },
  );
});
