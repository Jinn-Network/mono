import { execFile } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 5 * 60_000;
const GIT_MAX_BUFFER_BYTES = 16 * 1024 * 1024;

export interface RepositoryWorkspaceSource {
  readonly repository: string;
  readonly baseCommit: string;
}

export interface RepositoryWorkspaceDeps {
  readonly repositoryUrl?: (repository: string) => string;
}

function canonicalGitHubUrl(repository: string): string {
  return `https://github.com/${repository}.git`;
}

function assertSource(source: RepositoryWorkspaceSource): void {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/
      .test(source.repository)
    || source.repository.toLowerCase().endsWith('.git')
  ) {
    throw new Error(`Invalid repository workspace slug: ${source.repository}`);
  }
  if (!/^[0-9a-f]{40}$/.test(source.baseCommit)) {
    throw new Error(
      `Invalid repository workspace base commit: ${source.baseCommit}`,
    );
  }
}

/**
 * Materialize the signed repository and exact signed base commit before an
 * agent is allowed to inspect or mutate it. Repository-shaped learner tasks
 * use this checkout as the authoritative patch source; agent-authored payload
 * files never substitute for its Git state.
 */
export async function prepareRepositoryWorkspace(
  workspaceDir: string,
  source: RepositoryWorkspaceSource,
  deps: RepositoryWorkspaceDeps = {},
): Promise<void> {
  assertSource(source);
  const repositoryUrl = (deps.repositoryUrl ?? canonicalGitHubUrl)(
    source.repository,
  );
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_LFS_SKIP_SMUDGE: '1',
    GIT_TERMINAL_PROMPT: '0',
  };
  const git = async (args: string[]): Promise<string> => {
    const { stdout } = await execFileAsync('git', args, {
      env,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER_BYTES,
    });
    return stdout;
  };

  await mkdir(workspaceDir);
  try {
    await git(['init', '-q', workspaceDir]);
    await git([
      '-C',
      workspaceDir,
      'remote',
      'add',
      'origin',
      repositoryUrl,
    ]);
    await git([
      '-C',
      workspaceDir,
      'fetch',
      '-q',
      '--depth',
      '1',
      '--no-tags',
      'origin',
      source.baseCommit,
    ]);
    await git([
      '-C',
      workspaceDir,
      'checkout',
      '-q',
      '--detach',
      'FETCH_HEAD',
    ]);

    const actualHead = (await git([
      '-C',
      workspaceDir,
      'rev-parse',
      'HEAD',
    ])).trim().toLowerCase();
    if (actualHead !== source.baseCommit) {
      throw new Error(
        `Repository workspace head mismatch: expected ${source.baseCommit}, got ${actualHead || '<empty>'}`,
      );
    }
    const status = await git([
      '-C',
      workspaceDir,
      'status',
      '--porcelain=v1',
      '--untracked-files=all',
    ]);
    if (status.length > 0) {
      throw new Error('Repository workspace was not clean after checkout');
    }
  } catch (error) {
    await rm(workspaceDir, { recursive: true, force: true });
    throw error;
  }
}
