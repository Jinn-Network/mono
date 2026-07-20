import { describe, expect, it } from 'vitest';
import { CredentialPool, selectCredential } from '../../src/lifecycle/credentials.js';
import {
  makeProductionReconciliationWriter,
} from '../../src/lifecycle/reconciliation-writer-production.js';
import type { GitHubLifecycleSnapshot } from '../../src/lifecycle/snapshot.js';
import { gitOid } from '../../src/lifecycle/types.js';

const HEAD = gitOid('1'.repeat(40));
const CHANGED_HEAD = gitOid('2'.repeat(40));

function snapshot(
  draft: boolean,
  options: {
    readonly head?: typeof HEAD;
    readonly projectStatus?: 'Todo' | 'Human';
    readonly blockedOn?: 'Nothing' | 'Human';
  } = {},
): GitHubLifecycleSnapshot {
  return {
    project: {
      items: options.projectStatus === undefined ? [] : [{
        id: 'PVTI_issue_42',
        number: 42,
        contentType: 'Issue',
        status: options.projectStatus,
        priority: 'P1',
        effort: 'High',
        blockedOn: options.blockedOn ?? 'Nothing',
        issueType: 'feat',
        blockedByIssues: [],
        sprintIterationId: null,
      }],
      rateLimit: { remaining: 4_000, used: 1, resetAt: '2026-07-20T13:00:00.000Z' },
      currentSprintIterationId: null,
    },
    issues: [],
    branches: [],
    diagnostics: [],
    pullRequests: [{
      number: 84,
      title: 'feat: test',
      body: 'Closes #42',
      author: 'implementation-bot',
      baseRefName: 'next',
      headRefName: 'autopilot/42',
      headOid: options.head ?? HEAD,
      headCommittedAt: '2026-07-20T12:00:00.000Z',
      isDraft: draft,
      state: 'OPEN',
      labels: ['engine:review'],
      closingIssueNumbers: [42],
      mergeability: 'UNKNOWN',
      mergeStateStatus: 'BLOCKED',
      checks: [],
      reviews: [],
    }],
    lifecycle: { items: [] },
    capturedAt: '2026-07-20T12:00:00.000Z',
  };
}

describe('production reconciliation writer', () => {
  it('accepts a lost mutation response only after exact selected-identity readback', async () => {
    let draft = false;
    const calls: Array<{ env?: NodeJS.ProcessEnv }> = [];
    const selection = selectCredential(new CredentialPool([{
      login: 'implementation-bot',
      normalizedLogin: 'implementation-bot',
      implementationToken: 'selected-secret',
    }]), { phase: 'implement' });
    if (selection.status !== 'selected') throw new Error('selection failed');
    const writer = makeProductionReconciliationWriter({
      repositoryPath: '/repo',
      readSnapshot: async () => snapshot(draft),
      credential: selection.credential,
      environment: { GITHUB_TOKEN: 'ambient-secret' },
      runner: async (_command, args, options) => {
        calls.push({ env: options?.env });
        if (args.includes('ready')) {
          draft = true;
          throw new Error('response lost');
        }
        throw new Error(`unexpected ${args.join(' ')}`);
      },
    });

    await expect(writer.setPullRequestDraft(84, true, HEAD)).resolves.toBeUndefined();
    expect(calls[0]?.env?.GH_TOKEN).toBe('selected-secret');
    expect(calls[0]?.env?.GITHUB_TOKEN).toBe('');
  });

  it('does not accept a field-only readback after the exact PR head changes', async () => {
    let draft = false;
    let head: typeof HEAD = HEAD;
    const selection = selectCredential(new CredentialPool([{
      login: 'implementation-bot',
      normalizedLogin: 'implementation-bot',
      implementationToken: 'selected-secret',
    }]), { phase: 'implement' });
    if (selection.status !== 'selected') throw new Error('selection failed');
    const writer = makeProductionReconciliationWriter({
      repositoryPath: '/repo',
      readSnapshot: async () => snapshot(draft, { head }),
      credential: selection.credential,
      runner: async (_command, args) => {
        if (args.includes('ready')) {
          draft = true;
          head = CHANGED_HEAD;
          throw new Error('response lost while head changed');
        }
        throw new Error(`unexpected ${args.join(' ')}`);
      },
    });

    await expect(writer.setPullRequestDraft(84, true, HEAD))
      .rejects.toThrow('response lost while head changed');
  });

  it('never moves a Human-owned Project item back into automation', async () => {
    let mutations = 0;
    const selection = selectCredential(new CredentialPool([{
      login: 'implementation-bot',
      normalizedLogin: 'implementation-bot',
      implementationToken: 'selected-secret',
    }]), { phase: 'implement' });
    if (selection.status !== 'selected') throw new Error('selection failed');
    const writer = makeProductionReconciliationWriter({
      repositoryPath: '/repo',
      readSnapshot: async () => snapshot(true, {
        projectStatus: 'Human',
        blockedOn: 'Human',
      }),
      credential: selection.credential,
      runner: async () => {
        mutations++;
        return '';
      },
    });

    await expect(writer.setProjectStatus(42, 'Todo', HEAD))
      .rejects.toThrow('Human is dominant');
    expect(mutations).toBe(0);
  });
});
