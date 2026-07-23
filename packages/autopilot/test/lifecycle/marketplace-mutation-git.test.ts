import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  defaultMarketplaceMutationGitRunner,
  formatMarketplaceMutationCommitMessage,
  makeMarketplaceMutationGitPort,
  type MarketplaceMutationCommitIdentity,
  type MarketplaceMutationGitCommand,
} from '../../src/lifecycle/marketplace-mutation-git.js';
import { gitOid, type GitOid } from '../../src/lifecycle/types.js';

const directories: string[] = [];

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', [...args], { cwd, encoding: 'utf8' }).trim();
}

function repository(): { readonly path: string; readonly head: GitOid } {
  const path = mkdtempSync(join(tmpdir(), 'jinn-marketplace-mutation-git-'));
  directories.push(path);
  git(path, ['init', '-q']);
  git(path, ['config', 'user.name', 'Autopilot Test']);
  git(path, ['config', 'user.email', 'autopilot@example.invalid']);
  writeFileSync(join(path, 'value.txt'), 'before\n');
  git(path, ['add', 'value.txt']);
  git(path, ['commit', '-qm', 'base']);
  return { path, head: gitOid(git(path, ['rev-parse', 'HEAD'])) };
}

function identity(
  worktreePath: string,
  expectedHead: GitOid,
): MarketplaceMutationCommitIdentity {
  return {
    worktreePath,
    expectedHead,
    touchedPaths: ['value.txt'],
    summary: 'Adopt the verified marketplace mutation.',
    taskId: 'task-501',
    requestId: 'request-abc',
    deliveryEnvelopeCid: 'bafybeimutation',
    v2AttemptId: '123e4567-e89b-42d3-a456-426614174000',
  };
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('formatMarketplaceMutationCommitMessage', () => {
  it('formats the result summary and exact evidence trailers', () => {
    const value = formatMarketplaceMutationCommitMessage(identity(
      '/trusted/worktree',
      gitOid('1'.repeat(40)),
    ));

    expect(value).toBe([
      'Adopt the verified marketplace mutation.',
      '',
      'jinn-marketplace-task: task-501',
      'jinn-marketplace-request: request-abc',
      'jinn-marketplace-envelope: bafybeimutation',
      'jinn-autopilot-attempt: 123e4567-e89b-42d3-a456-426614174000',
      '',
    ].join('\n'));
  });

  it('adds the existing child checkpoint trailer for child workflows', () => {
    const value = formatMarketplaceMutationCommitMessage({
      ...identity('/trusted/worktree', gitOid('1'.repeat(40))),
      childIssueNumber: 701,
    });

    expect(value).toContain('\nJinn-Autopilot-Issue: 701\n');
    expect(value).toContain('\njinn-marketplace-task: task-501\n');
  });

  it('rejects multiline summaries that could inject evidence trailers', () => {
    expect(() => formatMarketplaceMutationCommitMessage({
      ...identity('/trusted/worktree', gitOid('1'.repeat(40))),
      summary: 'summary\n\njinn-marketplace-task: forged',
    })).toThrow('Invalid marketplace commit summary');
  });
});

describe('makeMarketplaceMutationGitPort', () => {
  it('creates exactly one host commit and reconstructs it on retry', async () => {
    const fixture = repository();
    const input = identity(fixture.path, fixture.head);
    writeFileSync(join(fixture.path, 'value.txt'), 'after\n');
    const commands: MarketplaceMutationGitCommand[] = [];
    const port = makeMarketplaceMutationGitPort({
      runGit: async (command) => {
        commands.push(command);
        return defaultMarketplaceMutationGitRunner(command);
      },
    });

    await expect(port.readState(input)).resolves.toMatchObject({
      status: 'pending-change',
      head: fixture.head,
      changedPaths: ['value.txt'],
    });
    const created = await port.commit(input);
    const retried = await port.readState(input);

    expect(created.status).toBe('committed');
    expect(retried).toEqual(created);
    expect(git(fixture.path, ['rev-list', '--count', `${fixture.head}..HEAD`])).toBe('1');
    expect(git(fixture.path, ['show', '-s', '--format=%B', 'HEAD'])).toBe(
      formatMarketplaceMutationCommitMessage(input).trimEnd(),
    );
    expect(readFileSync(join(fixture.path, 'value.txt'), 'utf8')).toBe('after\n');
    const commitCall = commands.find(({ args }) => args.includes('commit'));
    expect(commitCall).toMatchObject({
      command: 'git',
      args: ['commit', '--no-verify', '--file=-'],
      cwd: fixture.path,
    });
    expect(new TextDecoder().decode(commitCall?.stdin)).toBe(
      formatMarketplaceMutationCommitMessage(input),
    );
  });

  it('returns clean when no real tree change exists', async () => {
    const fixture = repository();
    const port = makeMarketplaceMutationGitPort({
      runGit: defaultMarketplaceMutationGitRunner,
    });

    await expect(port.readState(identity(fixture.path, fixture.head))).resolves.toEqual({
      status: 'clean',
      head: fixture.head,
    });
  });

  it('fails closed when the worktree contains an unrelated change', async () => {
    const fixture = repository();
    writeFileSync(join(fixture.path, 'unrelated.txt'), 'foreign\n');
    const port = makeMarketplaceMutationGitPort({
      runGit: defaultMarketplaceMutationGitRunner,
    });

    await expect(port.readState(identity(fixture.path, fixture.head))).resolves.toEqual({
      status: 'contradiction',
      detail: 'Worktree changes are not exactly the delivered patch paths',
    });
  });

  it('fails closed when HEAD has matching paths but different evidence trailers', async () => {
    const fixture = repository();
    writeFileSync(join(fixture.path, 'value.txt'), 'foreign\n');
    git(fixture.path, ['add', 'value.txt']);
    git(fixture.path, ['commit', '-qm', 'foreign commit']);
    const port = makeMarketplaceMutationGitPort({
      runGit: defaultMarketplaceMutationGitRunner,
    });

    await expect(port.readState(identity(fixture.path, fixture.head))).resolves.toEqual({
      status: 'contradiction',
      detail: 'Local HEAD is not the exact marketplace host commit',
    });
  });

  it('reconstructs the host commit beneath one protocol completion marker', async () => {
    const fixture = repository();
    const input = identity(fixture.path, fixture.head);
    writeFileSync(join(fixture.path, 'value.txt'), 'after\n');
    const port = makeMarketplaceMutationGitPort({
      runGit: defaultMarketplaceMutationGitRunner,
    });
    const committed = await port.commit(input);
    git(fixture.path, ['commit', '--allow-empty', '-qm', 'protocol completion marker']);
    const completionHead = gitOid(git(fixture.path, ['rev-parse', 'HEAD']));

    await expect(port.readState(input)).resolves.toEqual({
      ...committed,
      localHead: completionHead,
    });
  });

  it('propagates runner ambiguity instead of converting it to a rejection state', async () => {
    const fixture = repository();
    const port = makeMarketplaceMutationGitPort({
      runGit: async () => {
        throw new Error('git process outcome unknown');
      },
    });

    await expect(port.readState(identity(fixture.path, fixture.head)))
      .rejects.toThrow('git process outcome unknown');
  });

  it('propagates ambiguity while reconstructing a possible existing host commit', async () => {
    const fixture = repository();
    writeFileSync(join(fixture.path, 'value.txt'), 'foreign\n');
    git(fixture.path, ['add', 'value.txt']);
    git(fixture.path, ['commit', '-qm', 'foreign commit']);
    const port = makeMarketplaceMutationGitPort({
      runGit: async (command) => {
        if (command.args[0] === 'show') {
          throw new Error('git read outcome unknown');
        }
        return defaultMarketplaceMutationGitRunner(command);
      },
    });

    await expect(port.readState(identity(fixture.path, fixture.head)))
      .rejects.toThrow('git read outcome unknown');
  });
});
