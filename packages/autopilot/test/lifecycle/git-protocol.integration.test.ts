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
  it('elects one branch claimant and atomically rejects both fix refs when one lease loses', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'jinn-git-protocol-')));
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
    await git(local, ['push', 'origin', `${base}:refs/heads/autopilot/42`]);

    await git(local, ['commit', '--allow-empty', '-m', 'claim one']);
    const claimOne = oid(await git(local, ['rev-parse', 'HEAD']));
    await git(local, ['reset', '--hard', base]);
    await git(local, ['commit', '--allow-empty', '-m', 'claim two']);
    const claimTwo = oid(await git(local, ['rev-parse', 'HEAD']));

    let atomicCompetitor: { readonly oid: string; readonly ref: string } | undefined;
    let atomicPushAttempted = false;
    const runner: GitCommandRunner = async (command, args) => {
      expect(command).toBe('git');
      if (args[0] === 'push' && args.includes('--atomic') && atomicCompetitor !== undefined) {
        atomicPushAttempted = true;
        await git(local, [
          'push',
          'origin',
          `${atomicCompetitor.oid}:${atomicCompetitor.ref}`,
        ]);
      }
      return git(local, args);
    };
    const port = makeGitProtocolPort(runner);
    const branch = gitRefName('autopilot/42');

    const first = await port.claimBranch({ branch, expectedHead: base, claimOid: claimOne });
    const second = await port.claimBranch({ branch, expectedHead: base, claimOid: claimTwo });

    expect(first.status).toBe('won');
    expect(second).toMatchObject({ status: 'lost', observed: claimOne });
    expect(oid(await git(local, ['ls-remote', remote, 'refs/heads/autopilot/42']))).toBe(claimOne);

    await git(local, ['checkout', '--detach', base]);
    await git(local, ['commit', '--allow-empty', '-m', 'review base']);
    const reviewBase = oid(await git(local, ['rev-parse', 'HEAD']));
    const reviewRef = 'refs/jinn-autopilot/review-claims/v1/101';
    await git(local, ['push', 'origin', `${reviewBase}:${reviewRef}`]);

    await git(local, ['checkout', '--detach', claimOne]);
    writeFileSync(join(local, 'fix.txt'), 'fix\n');
    await git(local, ['add', 'fix.txt']);
    await git(local, ['commit', '-m', 'review fix']);
    const fixHead = oid(await git(local, ['rev-parse', 'HEAD']));

    await git(local, ['checkout', '--detach', reviewBase]);
    await git(local, ['commit', '--allow-empty', '-m', 'paired review metadata']);
    const pairedReview = oid(await git(local, ['rev-parse', 'HEAD']));
    await git(local, ['reset', '--hard', reviewBase]);
    await git(local, ['commit', '--allow-empty', '-m', 'competing review metadata']);
    const competingReview = oid(await git(local, ['rev-parse', 'HEAD']));
    atomicCompetitor = { oid: competingReview, ref: reviewRef };

    const rejected = await port.publishReviewFix({
      branch,
      expectedHead: claimOne,
      newHead: fixHead,
      prNumber: 101,
      expectedRecordOid: reviewBase,
      recordOid: pairedReview,
    });

    expect(rejected).toMatchObject({
      status: 'lost',
      expected: { branch: claimOne, review: reviewBase },
      published: { branch: fixHead, review: pairedReview },
      observed: { branch: claimOne, review: competingReview },
    });
    expect(atomicPushAttempted).toBe(true);
    expect(oid(await git(local, ['ls-remote', remote, 'refs/heads/autopilot/42']))).toBe(claimOne);
    expect(oid(await git(local, ['ls-remote', remote, reviewRef]))).toBe(competingReview);
  });
});
