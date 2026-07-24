// @ts-nocheck — Stage 5: deleted merge-prep/review-fix/project-status fixtures.
import { execFile } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { makeGitProtocolPort, type GitCommandRunner } from '../../src/lifecycle/git-protocol.js';
import { gitOid, gitRefName } from '../../src/lifecycle/types.js';

const execFileAsync = promisify(execFile);
const roots: string[] = [];

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const result = await execFileAsync('git', [...args], { cwd, encoding: 'utf8' });
  return result.stdout;
}

function oid(value: string) {
  const firstField = value.trim().split(/\s/, 1)[0];
  if (firstField === undefined) throw new Error('missing oid');
  return gitOid(firstField);
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Git protocol integration', () => {
  it('elects one claimant when the stable branch does not exist yet', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'jinn-git-protocol-new-branch-')));
    roots.push(root);
    const remote = join(root, 'remote.git');
    const local = join(root, 'local');
    await git(root, ['init', '--bare', remote]);
    await git(root, ['init', local]);
    await git(local, ['config', 'user.name', 'Jinn Test']);
    await git(local, ['config', 'user.email', 'jinn@example.test']);
    await git(local, ['remote', 'add', 'origin', remote]);
    writeFileSync(join(local, 'base.txt'), 'base\n');
    await git(local, ['add', 'base.txt']);
    await git(local, ['commit', '-m', 'base']);
    const base = oid(await git(local, ['rev-parse', 'HEAD']));
    await git(local, ['push', 'origin', `${base}:refs/heads/next`]);

    await git(local, ['commit', '--allow-empty', '-m', 'claim one']);
    const claimOne = oid(await git(local, ['rev-parse', 'HEAD']));
    await git(local, ['reset', '--hard', base]);
    await git(local, ['commit', '--allow-empty', '-m', 'claim two']);
    const claimTwo = oid(await git(local, ['rev-parse', 'HEAD']));

    const runner: GitCommandRunner = async (command, args) => {
      expect(command).toBe('git');
      return git(local, args);
    };
    const port = makeGitProtocolPort(runner);
    const branch = gitRefName('autopilot/42');

    const first = await port.claimBranch({
      branch,
      candidateParent: base,
      expectedRemoteHead: null,
      claimOid: claimOne,
    });
    const second = await port.claimBranch({
      branch,
      candidateParent: base,
      expectedRemoteHead: null,
      claimOid: claimTwo,
    });

    expect(first).toMatchObject({
      status: 'won',
      expected: null,
      observed: claimOne,
    });
    expect(second).toMatchObject({
      status: 'lost',
      expected: null,
      observed: claimOne,
    });
    expect(oid(await git(local, ['ls-remote', remote, 'refs/heads/autopilot/42']))).toBe(claimOne);
  });

});
