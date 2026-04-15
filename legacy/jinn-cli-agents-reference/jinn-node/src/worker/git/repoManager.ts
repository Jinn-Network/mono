/**
 * Repository management: cloning, fetching, and root resolution
 */

import { existsSync } from 'node:fs';
import { workerLogger } from '../../logging/index.js';
import { getRepoRoot, extractRepoName, getJinnWorkspaceDir } from '../../shared/repo_utils.js';
import type { CodeMetadata } from '../../agent/shared/code_metadata.js';
import { GIT_CLONE_TIMEOUT_MS, GIT_FETCH_TIMEOUT_MS } from '../constants.js';
import { serializeError } from '../logging/errors.js';
import { config, secrets } from '../../config/index.js';
// Repo setup (gitignore, beads) now happens in jobRunner after branch checkout

function buildGithubHttpsUrl(remoteUrl: string): string | null {
  if (!remoteUrl) return null;
  if (remoteUrl.startsWith('https://github.com/')) {
    return remoteUrl;
  }
  if (remoteUrl.startsWith('git@github.com:')) {
    const path = remoteUrl.slice('git@github.com:'.length);
    return `https://github.com/${path}`;
  }
  return null;
}

/**
 * Normalize SSH URL to use local host alias if configured.
 * This allows workers to use a custom SSH host (e.g., 'ritsukai' instead of 'github.com')
 * when the user has a non-default SSH key setup.
 * 
 * Set SSH_HOST_ALIAS=ritsukai in .env to rewrite git@github.com: to git@ritsukai:
 */
function normalizeSshUrl(url: string): string {
  const sshHostAlias = process.env.SSH_HOST_ALIAS;
  if (sshHostAlias && url.startsWith('git@github.com:')) {
    const normalizedUrl = url.replace('git@github.com:', `git@${sshHostAlias}:`);
    workerLogger.debug({ originalUrl: url, normalizedUrl, sshHostAlias }, 'Normalized SSH URL using host alias');
    return normalizedUrl;
  }
  return url;
}

/**
 * Result of repository clone/fetch operation
 */
export interface RepoCloneResult {
  wasAlreadyCloned: boolean;
  fetchPerformed: boolean;
}

/**
 * Validate that a clone URL is safe (GitHub HTTPS or GitHub SSH only).
 * Rejects file://, ssh://attacker.com, and other arbitrary URL schemes
 * to prevent SSRF, token leakage, and malicious hook execution.
 */
function validateCloneUrl(url: string): void {
  if (!url || typeof url !== 'string') {
    throw new Error('Clone URL is required');
  }

  const trimmed = url.trim();

  // Allow: https://github.com/owner/repo[.git]
  if (/^https:\/\/github\.com\/[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+(\.git)?\/?$/.test(trimmed)) {
    return;
  }

  // Allow: git@github.com:owner/repo[.git]
  if (/^git@github\.com:[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+(\.git)?$/.test(trimmed)) {
    return;
  }

  // Allow: SSH host alias format (e.g., git@ritsukai:owner/repo.git)
  const sshHostAlias = process.env.SSH_HOST_ALIAS;
  if (sshHostAlias) {
    const escapedAlias = sshHostAlias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const aliasRegex = new RegExp(`^git@${escapedAlias}:[a-zA-Z0-9._-]+/[a-zA-Z0-9._-]+(\\.git)?$`);
    if (aliasRegex.test(trimmed)) {
      return;
    }
  }

  throw new Error(
    `Unsafe clone URL rejected: '${trimmed.slice(0, 100)}'. ` +
    'Only https://github.com/ and git@github.com: URLs are allowed.'
  );
}

/**
 * Ensure repository is cloned to the workspace directory
 * Clones if it doesn't exist, otherwise fetches latest refs
 * @returns Result indicating whether repo was already cloned and if fetch was performed
 */
export async function ensureRepoCloned(remoteUrl: string, targetPath: string): Promise<RepoCloneResult> {
  const { execFileSync } = await import('node:child_process');

  // Validate URL before any git operations
  validateCloneUrl(remoteUrl);
  if (existsSync(targetPath)) {
    workerLogger.info({ targetPath }, 'Repository already cloned');

    // Always fetch branches to ensure we have latest remote refs
    let fetchPerformed = false;
    try {
      execFileSync('git', ['fetch', '--all'], {
        cwd: targetPath,
        stdio: 'pipe',
        encoding: 'utf-8',
        timeout: GIT_FETCH_TIMEOUT_MS,
        env: process.env as Record<string, string>,
      });
      workerLogger.info({ targetPath }, 'Fetched all branches');
      fetchPerformed = true;
    } catch (error: any) {
      workerLogger.warn({ targetPath, error: serializeError(error) }, 'Failed to fetch all branches (non-fatal)');
    }

    return { wasAlreadyCloned: true, fetchPerformed };
  }

  workerLogger.info({ remoteUrl, targetPath }, 'Cloning repository');

  // If GITHUB_TOKEN is available, prefer HTTPS with token over SSH
  // This works in containers without SSH keys configured (e.g., Railway)
  let cloneUrl = normalizeSshUrl(remoteUrl);
  const token = secrets.githubToken;

  if (token) {
    const httpsUrl = buildGithubHttpsUrl(remoteUrl);
    if (httpsUrl) {
      // Use x-access-token:TOKEN format for GitHub PAT authentication
      cloneUrl = httpsUrl.replace('https://', `https://x-access-token:${token}@`);
      workerLogger.info({ targetPath }, 'Using HTTPS with GITHUB_TOKEN for clone');
    } else {
      workerLogger.info({ targetPath, hasToken: true }, 'Clone URL preparation (non-GitHub URL, using original)');
    }
  } else {
    workerLogger.info({ targetPath, hasToken: false }, 'Clone URL preparation (no token, using original URL)');
  }

  try {
    execFileSync('git', ['clone', cloneUrl, targetPath], {
      stdio: 'pipe',
      encoding: 'utf-8',
      timeout: GIT_CLONE_TIMEOUT_MS,
      env: process.env as Record<string, string>,
    });
    workerLogger.info({ targetPath }, 'Successfully cloned repository');
  } catch (error: any) {
    const stderr = String(error.stderr || '');
    const authFailed = stderr.includes('Permission denied (publickey)') || stderr.includes('publickey');

    if (authFailed) {
      const httpsUrl = buildGithubHttpsUrl(remoteUrl);
      const token = secrets.githubToken;
      const authUrl = httpsUrl && token ? httpsUrl.replace('https://', `https://${token}@`) : httpsUrl;

      if (authUrl) {
        try {
          execFileSync('git', ['clone', authUrl, targetPath], {
            stdio: 'pipe',
            encoding: 'utf-8',
            timeout: GIT_CLONE_TIMEOUT_MS,
            env: process.env as Record<string, string>,
          });
          workerLogger.info({ targetPath, httpsUrl }, 'Successfully cloned repository via HTTPS');
          return { wasAlreadyCloned: false, fetchPerformed: false };
        } catch (fallbackError: any) {
          const fallbackStderr = String(fallbackError.stderr || '').slice(0, 300);
          const fallbackStatus403 = fallbackStderr.includes('error: 403') || fallbackStderr.includes('Write access to repository not granted');
          const fallbackMessage = fallbackStatus403
            ? 'Failed to clone repository via HTTPS: token lacks access to repository (403).'
            : `Failed to clone repository via HTTPS: ${fallbackError.stderr || fallbackError.message}`;
          workerLogger.error({ httpsUrl, targetPath, error: serializeError(fallbackError) }, fallbackMessage);
        }
      }
    }

    const errorMessage = `Failed to clone repository: ${error.stderr || error.message}`;
    workerLogger.error({ remoteUrl, targetPath, error: serializeError(error) }, errorMessage);
    throw new Error(errorMessage);
  }

  // Fetch all branches
  let fetchPerformed = false;
  try {
    execFileSync('git', ['fetch', '--all'], {
      cwd: targetPath,
      stdio: 'pipe',
      encoding: 'utf-8',
      timeout: GIT_FETCH_TIMEOUT_MS,
      env: process.env as Record<string, string>,
    });
    workerLogger.info({ targetPath }, 'Fetched all branches');
    fetchPerformed = true;
  } catch (error: any) {
    workerLogger.warn({ targetPath, error: serializeError(error) }, 'Failed to fetch all branches (non-fatal)');
  }

  return { wasAlreadyCloned: false, fetchPerformed };
}

/**
 * Get repository root for a given code metadata
 * Uses shared repo_utils logic
 */
export function getRepoRootForMetadata(codeMetadata?: CodeMetadata): string {
  return getRepoRoot(codeMetadata);
}

/**
 * Prepare repository for job execution
 * Clones repo if needed and returns repo root path
 */
export async function prepareRepoForJob(codeMetadata: CodeMetadata): Promise<string> {
  if (codeMetadata?.repo?.remoteUrl) {
    const repoName = extractRepoName(codeMetadata.repo.remoteUrl);
    if (repoName) {
      const workspaceDir = config.git.workspaceDir;
      const repoRoot = `${workspaceDir}/${repoName}`;
      await ensureRepoCloned(codeMetadata.repo.remoteUrl, repoRoot);
      return repoRoot;
    }
  }

  // Fallback to current working directory or env override
  return getRepoRoot(codeMetadata);
}

