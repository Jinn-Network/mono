import { describe, expect, it } from 'vitest';
import {
  makeProductionMergeActionPort,
} from '../../src/lifecycle/merge-executor-production.js';
import { CredentialPool, selectCredential } from '../../src/lifecycle/credentials.js';
import { gitOid } from '../../src/lifecycle/types.js';

const HEAD = gitOid('1'.repeat(40));

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
});
