import { describe, expect, it } from 'vitest';
import {
  makeProductionMergeActionPort,
} from '../../src/lifecycle/merge-executor-production.js';
import { CredentialPool, selectCredential } from '../../src/lifecycle/credentials.js';
import type { GitHubLifecycleSnapshot } from '../../src/lifecycle/snapshot.js';
import { gitOid, isoTimestamp } from '../../src/lifecycle/types.js';

const HEAD = gitOid('1'.repeat(40));
const BASE = gitOid('3'.repeat(40));

function snapshot(): GitHubLifecycleSnapshot {
  const marker = 'review-marker';
  return {
    pullRequests: [{
      number: 84,
      title: 'PR',
      body: '',
      author: 'implementation-bot',
      baseRefName: 'stack/base',
      headRefName: 'autopilot/84',
      headOid: HEAD,
      headCommittedAt: isoTimestamp('2026-07-20T00:00:00.000Z'),
      isDraft: false,
      state: 'OPEN',
      labels: ['engine:review'],
      closingIssueNumbers: [84],
      mergeability: 'MERGEABLE',
      mergeStateStatus: 'CLEAN',
      checks: [{ name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' }],
      reviews: [],
      branchClaim: {
        version: 2,
        phase: 'implement',
        issueNumber: 84,
        prNumber: 84,
        attempt: '11111111-1111-4111-8111-111111111111',
        runner: 'runner-a',
        login: 'implementation-bot',
        expectedHead: BASE,
        targetBase: 'stack/base',
        startedAt: isoTimestamp('2026-07-20T00:00:00.000Z'),
        phaseComplete: true,
      },
    }],
    lifecycle: {
      capturedAt: isoTimestamp('2026-07-20T00:00:00.000Z'),
      items: [{
        kind: 'pull-request',
        issueNumber: 84,
        prNumber: 84,
        v2Marked: true,
        projectStatus: 'In Review',
        labels: ['engine:review'],
        head: HEAD,
        headChangedAt: isoTimestamp('2026-07-20T00:00:00.000Z'),
        isDraft: false,
        merged: false,
        needsReview: false,
        approved: true,
        mergeState: 'clean',
        reviewClaim: {
          version: 1,
          prNumber: 84,
          issueNumber: 84,
          head: HEAD,
          generation: '22222222-2222-4222-8222-222222222222',
          reviewer: 'review-bot',
          runner: 'runner-b',
          startedAt: isoTimestamp('2026-07-20T00:00:00.000Z'),
          state: 'terminal-approved',
          verdict: {
            state: 'APPROVE',
            head: HEAD,
            marker,
            submittedAt: isoTimestamp('2026-07-20T00:01:00.000Z'),
          },
        },
        terminalVerdict: {
          reviewer: 'review-bot',
          state: 'APPROVE',
          head: HEAD,
          marker,
          submittedAt: isoTimestamp('2026-07-20T00:01:00.000Z'),
        },
      }],
    },
    diagnostics: [],
  } as unknown as GitHubLifecycleSnapshot;
}

function candidateRunner(changedFiles: number, filenames: readonly string[]) {
  return async (command: string, args: readonly string[]): Promise<string> => {
    expect(command).toBe('gh');
    const endpoint = args.find((arg) => arg.startsWith('repos/'));
    if (endpoint === 'repos/Jinn-Network/mono/pulls/84') {
      return JSON.stringify({
        changed_files: changedFiles,
        head: { sha: HEAD },
        base: { ref: 'stack/base', sha: BASE },
      });
    }
    if (endpoint?.startsWith('repos/Jinn-Network/mono/pulls/84/files?')) {
      return JSON.stringify([filenames.map((filename) => ({ filename }))]);
    }
    if (endpoint?.startsWith('repos/Jinn-Network/mono/contents/.github/CODEOWNERS')) {
      expect(endpoint).toContain(`ref=${BASE}`);
      return JSON.stringify({
        content: Buffer.from('# no owned paths\n').toString('base64'),
      });
    }
    if (endpoint?.startsWith('repos/Jinn-Network/mono/compare/')) {
      expect(endpoint).toBe(`repos/Jinn-Network/mono/compare/${BASE}...${HEAD}`);
      return JSON.stringify({ status: 'ahead' });
    }
    throw new Error(`unexpected ${command} ${args.join(' ')}`);
  };
}

describe('production head-pinned merge port', () => {
  it('uses the selected identity, exact SHA, and no admin or bypass flag', async () => {
    const calls: Array<{ command: string; args: readonly string[]; env?: NodeJS.ProcessEnv }> = [];
    const runner = async (
      command: string,
      args: readonly string[],
      options?: { readonly env?: NodeJS.ProcessEnv },
    ): Promise<string> => {
      calls.push({ command, args, env: options?.env });
      if (command === 'gh' && args.includes('-X') && args.includes('PUT')) {
        return JSON.stringify({ merged: true, sha: '2'.repeat(40), message: 'merged' });
      }
      throw new Error(`unexpected ${command} ${args.join(' ')}`);
    };
    const port = makeProductionMergeActionPort({
      readSnapshot: async () => {
        throw new Error('unused');
      },
      authorAllowlist: new Set(['implementation-bot']),
      runner,
      environment: { GH_TOKEN: 'ambient-secret' },
    });
    const selection = selectCredential(new CredentialPool([{
      login: 'implementation-bot',
      normalizedLogin: 'implementation-bot',
      implementationToken: 'selected-secret',
    }]), { phase: 'merge' });
    if (selection.status !== 'selected') throw new Error('selection failed');

    await expect(port.mergeExactHead({
      prNumber: 84,
      head: HEAD,
      credential: selection.credential,
    })).resolves.toMatchObject({ status: 'merged', head: HEAD });

    const merge = calls.find((call) =>
      call.args.some((arg) => arg.endsWith('pulls/84/merge')));
    expect(merge?.args).toContain(`sha=${HEAD}`);
    expect(merge?.args).toContain('merge_method=squash');
    expect(merge?.args.join(' ')).not.toMatch(/admin|bypass/i);
    expect(merge?.env?.GH_TOKEN).toBe('selected-secret');
    expect(merge?.env?.GITHUB_TOKEN).toBe('');
  });

  it.each([
    { name: 'REST total exceeds returned filenames', total: 2, files: ['src/a.ts'] },
    { name: 'GitHub file endpoint ceiling is exceeded', total: 3_001, files: ['src/a.ts'] },
    { name: 'returned filenames are duplicated', total: 2, files: ['src/a.ts', 'src/a.ts'] },
  ])('fails changed-file completeness when $name', async ({ total, files }) => {
    const port = makeProductionMergeActionPort({
      readSnapshot: async () => snapshot(),
      authorAllowlist: new Set(['implementation-bot']),
      runner: candidateRunner(total, files),
    });

    await expect(port.readCandidate(84)).resolves.toMatchObject({
      changedFilesComplete: false,
      codeownersComplete: true,
    });
  });

  it('binds complete files and CODEOWNERS to the exact candidate base OID', async () => {
    const port = makeProductionMergeActionPort({
      readSnapshot: async () => snapshot(),
      authorAllowlist: new Set(['implementation-bot']),
      runner: candidateRunner(2, ['src/a.ts', 'src/b.ts']),
    });

    await expect(port.readCandidate(84)).resolves.toMatchObject({
      baseRefName: 'stack/base',
      changedFilesComplete: true,
      codeownersComplete: true,
    });
  });
});
