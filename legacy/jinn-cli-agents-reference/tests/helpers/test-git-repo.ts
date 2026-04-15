import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export interface TestGitRepo {
  repoPath: string;
  workspacePath: string;
  remoteUrl: string;
  cleanup: () => void;
}

export function parseRepoSlug(remote: string): string | null {
  if (!remote) return null;
  const trimmed = remote.trim();

  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      const parts = url.pathname.replace(/^\/+/, '').split('/');
      if (parts.length >= 2) {
        return `${parts[0]}/${parts[1].replace(/\.git$/i, '')}`;
      }
    } catch {
      return null;
    }
  }

  const sshMatch = trimmed.match(/^git@([^:]+):(.+)$/);
  if (sshMatch) {
    return sshMatch[2].replace(/\.git$/i, '');
  }

  const slugMatch = trimmed.match(/^([^/]+\/[^/]+)(?:\.git)?$/);
  if (slugMatch) {
    return slugMatch[1].replace(/\.git$/i, '');
  }

  return null;
}

export function setupTestGitRepo(repoPath: string, suiteId: string): TestGitRepo {
  const githubRemote = process.env.TEST_GITHUB_REPO;

  if (!githubRemote) {
    throw new Error(
      'TEST_GITHUB_REPO environment variable is required. ' +
      'Set it to the GitHub repository URL (e.g., https://github.com/user/test-repo.git)'
    );
  }

  const { authRemote, displayRemote } = resolveRemoteUrls(githubRemote);

  if (fs.existsSync(repoPath)) {
    fs.rmSync(repoPath, { recursive: true, force: true });
  }

  fs.mkdirSync(path.dirname(repoPath), { recursive: true });

  console.log(`[test-repo] Cloning test repository from ${displayRemote}`);
  execSync(`git clone ${authRemote} ${repoPath}`, {
    stdio: 'inherit',
    timeout: 30000
  });

  configureTestRepo(repoPath);

  const workspacePath = ensureWorkspaceWorktree(repoPath, suiteId);
  console.log('[test-repo] ✓ Test git repository ready');

  return {
    repoPath,
    workspacePath,
    remoteUrl: displayRemote,
    cleanup: () => cleanupTestRepo(repoPath, workspacePath)
  };
}

export function getTestGitRepo(suiteId: string): TestGitRepo {
  const remoteHint = process.env.TEST_GITHUB_REPO;

  if (!remoteHint) {
    throw new Error(
      'TEST_GITHUB_REPO environment variable is required. ' +
      'Set it to your test repository URL (e.g., https://github.com/user/test-repo.git)'
    );
  }

  const fixturesDir = path.join(process.cwd(), 'tests', 'fixtures');
  const repoPath = path.join(fixturesDir, `test-repo-${suiteId}`);
  const { authRemote, displayRemote } = resolveRemoteUrls(remoteHint);

  if (fs.existsSync(repoPath) && fs.existsSync(path.join(repoPath, '.git'))) {
    try {
      execSync('git status', { cwd: repoPath, stdio: 'ignore' });
      console.log('[test-repo] Using existing suite-scoped test repository');

      try {
        const currentOrigin = execSync('git remote get-url origin', {
          cwd: repoPath,
          encoding: 'utf-8'
        }).trim();
        if (currentOrigin !== authRemote) {
          execSync(`git remote set-url origin ${authRemote}`, { cwd: repoPath, stdio: 'ignore' });
        }
      } catch {
        execSync(`git remote add origin ${authRemote}`, { cwd: repoPath, stdio: 'ignore' });
      }

      execSync('git fetch origin --prune', { cwd: repoPath, stdio: 'ignore' });
      execSync('git checkout main', { cwd: repoPath, stdio: 'ignore' });
      execSync('git reset --hard origin/main', { cwd: repoPath, stdio: 'ignore' });
      execSync('git clean -fd', { cwd: repoPath, stdio: 'ignore' });

      const workspacePath = ensureWorkspaceWorktree(repoPath, suiteId);

      return {
        repoPath,
        workspacePath,
        remoteUrl: displayRemote,
        cleanup: () => cleanupTestRepo(repoPath, workspacePath)
      };
    } catch {
      console.log('[test-repo] Existing repo is invalid, recreating...');
    }
  }

  return setupTestGitRepo(repoPath, suiteId);
}

function cleanupTestRepo(repoPath: string, workspacePath: string): void {
  if (!fs.existsSync(repoPath)) {
    console.warn('[test-repo] Cleanup skipped: repo path missing');
    return;
  }

  removeWorkspaceWorktree(repoPath, workspacePath);

  try {
    execSync('git fetch origin --prune', { cwd: repoPath, stdio: 'ignore' });
  } catch (e: any) {
    console.warn('[test-repo] Cleanup warning (fetch --prune):', e.message);
  }

  try {
    const branches = execSync('git branch --format="%(refname:short)"', {
      cwd: repoPath,
      encoding: 'utf-8'
    })
      .split('\n')
      .filter(b => b && b !== 'main' && b.startsWith('job/'));

    for (const branch of branches) {
      try {
        execSync(`git branch -D ${branch}`, { cwd: repoPath, stdio: 'ignore' });
      } catch (branchErr: any) {
        console.warn(`[test-repo] Warning deleting local branch ${branch}:`, branchErr.message);
      }
      try {
        execSync(`git push origin --delete ${branch}`, { cwd: repoPath, stdio: 'ignore' });
      } catch (pushErr: any) {
        if (!/not found|remote ref does not exist/i.test(pushErr.message ?? '')) {
          console.warn(`[test-repo] Warning deleting remote branch ${branch}:`, pushErr.message);
        }
      }
    }
  } catch (e: any) {
    console.warn('[test-repo] Cleanup warning (enumerate branches):', e.message);
  }

  try {
    execSync('git checkout main', { cwd: repoPath, stdio: 'ignore' });
    execSync('git reset --hard origin/main', { cwd: repoPath, stdio: 'ignore' });
    execSync('git clean -fd', { cwd: repoPath, stdio: 'ignore' });
    console.log('[test-repo] Cleaned up working repository');
  } catch (e: any) {
    console.warn('[test-repo] Cleanup warning (reset main):', e.message);
  }
}

function configureTestRepo(repoPath: string): void {
  execSync('git config user.email "test@jinn.local"', { cwd: repoPath, stdio: 'ignore' });
  execSync('git config user.name "Jinn Test"', { cwd: repoPath, stdio: 'ignore' });
  execSync('git checkout main', { cwd: repoPath, stdio: 'ignore' });
  execSync('git reset --hard origin/main', { cwd: repoPath, stdio: 'ignore' });
  execSync('git clean -fd', { cwd: repoPath, stdio: 'ignore' });
}

function resolveRemoteUrls(remote: string): { authRemote: string; displayRemote: string } {
  const token = process.env.GITHUB_TOKEN;
  const httpsRemote = ensureHttpsRemote(remote);

  if (!token) {
    return { authRemote: httpsRemote, displayRemote: httpsRemote };
  }

  try {
    const url = new URL(httpsRemote);
    url.username = url.username || 'oauth2';
    url.password = token;
    const authRemote = url.toString();

    const displayUrl = new URL(httpsRemote);
    displayUrl.username = '';
    displayUrl.password = '';
    const displayRemote = displayUrl.toString().replace('://@', '://');

    return { authRemote, displayRemote };
  } catch {
    return { authRemote: httpsRemote, displayRemote: httpsRemote };
  }
}

function ensureHttpsRemote(remote: string): string {
  const slug = parseRepoSlug(remote);
  if (slug) {
    return `https://github.com/${slug}.git`;
  }

  if (!remote) return remote;

  const sshMatch = remote.match(/^git@([^:]+):(.+)$/);
  if (sshMatch) {
    return `https://${sshMatch[1]}/${sshMatch[2]}`;
  }

  return remote;
}

function ensureWorkspaceWorktree(repoPath: string, suiteIdOrRemoteHint: string): string {
  // Use suite-scoped worktree directory instead of repo name
  const tmpDir = path.join(process.cwd(), 'tests', 'tmp');
  const gitWorktreesDir = path.join(tmpDir, 'git-worktrees');
  fs.mkdirSync(gitWorktreesDir, { recursive: true });
  const workspacePath = path.join(gitWorktreesDir, suiteIdOrRemoteHint);

  try {
    const list = execSync('git worktree list --porcelain', {
      cwd: repoPath,
      encoding: 'utf-8'
    });
    const hasWorktree = list
      .split('\n')
      .some(line => line.startsWith('worktree ') && line.slice('worktree '.length).trim() === workspacePath);

    if (!hasWorktree) {
      if (fs.existsSync(workspacePath)) {
        fs.rmSync(workspacePath, { recursive: true, force: true });
      }
      execSync(`git worktree add --force --detach ${workspacePath}`, {
        cwd: repoPath,
        stdio: 'ignore'
      });
    }
  } catch (error) {
    console.warn('[test-repo] Failed to ensure workspace worktree:', error instanceof Error ? error.message : error);
  }

  return workspacePath;
}

function removeWorkspaceWorktree(repoPath: string, workspacePath: string): void {
  if (!fs.existsSync(repoPath) || !fs.existsSync(path.join(repoPath, '.git'))) {
    try {
      if (fs.existsSync(workspacePath)) {
        fs.rmSync(workspacePath, { recursive: true, force: true });
      }
    } catch (error) {
      console.warn('[test-repo] Failed to delete workspace mirror path:', error instanceof Error ? error.message : error);
    }
    return;
  }

  try {
    const list = execSync('git worktree list --porcelain', {
      cwd: repoPath,
      encoding: 'utf-8'
    });
    const hasWorktree = list
      .split('\n')
      .some(line => line.startsWith('worktree ') && line.slice('worktree '.length).trim() === workspacePath);

    if (hasWorktree) {
      execSync(`git worktree remove --force ${workspacePath}`, {
        cwd: repoPath,
        stdio: 'ignore'
      });
    }
  } catch (error) {
    console.warn('[test-repo] Failed to remove workspace worktree:', error instanceof Error ? error.message : error);
  }

  try {
    if (fs.existsSync(workspacePath)) {
      fs.rmSync(workspacePath, { recursive: true, force: true });
    }
  } catch (error) {
    console.warn('[test-repo] Failed to delete workspace mirror path:', error instanceof Error ? error.message : error);
  }
}

