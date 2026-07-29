import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  prepareRepositoryWorkspace,
} from '../../../../src/harnesses/impls/learner/repository-workspace.js';

function git(args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

describe('prepareRepositoryWorkspace', () => {
  it('checks out the exact signed commit into a clean Git workspace', async () => {
    const root = mkdtempSync(join(tmpdir(), 'jinn-repository-workspace-'));
    const source = join(root, 'source');
    const remote = join(root, 'remote.git');
    const workspace = join(root, 'workspace');
    try {
      git(['init', '-q', source]);
      git(['-C', source, 'config', 'user.name', 'Jinn Test']);
      git(['-C', source, 'config', 'user.email', 'test@jinn.network']);
      writeFileSync(join(source, 'marker.txt'), 'signed base\n');
      git(['-C', source, 'add', 'marker.txt']);
      git(['-C', source, 'commit', '-q', '-m', 'signed base']);
      const baseCommit = git(['-C', source, 'rev-parse', 'HEAD']);
      git(['clone', '-q', '--bare', source, remote]);

      await prepareRepositoryWorkspace(
        workspace,
        { repository: 'Jinn-Network/mono', baseCommit },
        { repositoryUrl: () => remote },
      );

      expect(git(['-C', workspace, 'rev-parse', 'HEAD'])).toBe(baseCommit);
      expect(git(['-C', workspace, 'status', '--porcelain=v1'])).toBe('');
      expect(readFileSync(join(workspace, 'marker.txt'), 'utf8')).toBe(
        'signed base\n',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('removes a partial workspace when the signed commit cannot be fetched', async () => {
    const root = mkdtempSync(join(tmpdir(), 'jinn-repository-workspace-fail-'));
    const remote = join(root, 'remote.git');
    const workspace = join(root, 'workspace');
    try {
      git(['init', '-q', '--bare', remote]);
      await expect(prepareRepositoryWorkspace(
        workspace,
        {
          repository: 'Jinn-Network/mono',
          baseCommit: 'a'.repeat(40),
        },
        { repositoryUrl: () => remote },
      )).rejects.toThrow();
      expect(() => readFileSync(join(workspace, 'HEAD'))).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
