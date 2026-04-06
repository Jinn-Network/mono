/**
 * Push branch to remote with error handling
 */

import { execFileSync } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { workerLogger } from '../../logging/index.js';
import { secrets } from '../../config/index.js';
import { getRepoRoot } from '../../shared/repo_utils.js';
import type { CodeMetadata } from '../../agent/shared/code_metadata.js';
import { DEFAULT_REMOTE_NAME, GIT_PUSH_TIMEOUT_MS } from '../constants.js';
import { serializeError } from '../logging/errors.js';

/**
 * Configure git credential helper if GITHUB_TOKEN is available
 * This enables git push to authenticate with the token
 */
function configureGitCredentials(repoRoot: string): void {
  const token = secrets.githubToken;
  if (!token) {
    workerLogger.debug('No GITHUB_TOKEN available for git credential configuration');
    return;
  }

  try {
    // Configure credential helper to use the token for github.com
    // This sets up a store-based credential that git will use for HTTPS URLs
    execFileSync('git', ['config', '--local', 'credential.helper', 'store'], {
      cwd: repoRoot,
      stdio: 'pipe',
      encoding: 'utf-8',
      timeout: 5000,
    });

    const gitCredentialsPath = join(homedir(), '.git-credentials');
    const credentialLine = `https://${token}:x-oauth-basic@github.com\n`;

    // Append if file exists, otherwise create
    try {
      appendFileSync(gitCredentialsPath, credentialLine, { mode: 0o600 });
    } catch {
      writeFileSync(gitCredentialsPath, credentialLine, { mode: 0o600 });
    }

    workerLogger.debug({ repoRoot }, 'Configured git credentials for GITHUB_TOKEN');
  } catch (error: any) {
    workerLogger.warn({ error: serializeError(error) }, 'Failed to configure git credentials (non-fatal)');
  }
}

/**
 * Custom error for git push failures
 */
export class GitPushError extends Error {
  constructor(
    message: string,
    public readonly branchName: string,
    public readonly remote: string,
    public readonly originalError?: any
  ) {
    super(message);
    this.name = 'GitPushError';
  }
}

function isNonFastForwardPush(stderr: string): boolean {
  const normalized = stderr.toLowerCase();
  return normalized.includes('fetch first')
    || normalized.includes('non-fast-forward')
    || normalized.includes('updates were rejected')
    || normalized.includes('remote contains work that you do not have locally');
}

/**
 * Push job branch to remote
 */
export async function pushJobBranch(branchName: string, codeMetadata: CodeMetadata): Promise<void> {
  // Determine repo root using shared logic
  const repoRoot = getRepoRoot(codeMetadata);
  const remoteName = DEFAULT_REMOTE_NAME;
  const { execFileSync } = await import('node:child_process');

  const pushInfo = {
    branchName,
    repoRoot,
    remoteName,
    codeMetadataRepoRoot: process.env.CODE_METADATA_REPO_ROOT,
    remoteUrl: codeMetadata?.repo?.remoteUrl,
  };
  workerLogger.info(pushInfo, 'Pushing job branch to remote');

  // Configure git credentials if GITHUB_TOKEN is available
  configureGitCredentials(repoRoot);

  // Verify remote configuration
  try {
    const remoteUrl = execFileSync('git', ['remote', 'get-url', remoteName], {
      cwd: repoRoot,
      stdio: 'pipe',
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();
    workerLogger.info({ branchName, remoteName, remoteUrl }, 'Remote URL configured');
  } catch (remoteCheckError: any) {
    workerLogger.warn({ branchName, remoteName, error: serializeError(remoteCheckError) }, 'Failed to get remote URL (non-fatal)');
  }

  try {
    // Push with -u to set upstream tracking
    execFileSync('git', ['push', '-u', remoteName, `${branchName}:${branchName}`], {
      cwd: repoRoot,
      stdio: 'pipe',
      encoding: 'utf-8',
      timeout: GIT_PUSH_TIMEOUT_MS,
      env: process.env as Record<string, string>,
    });
    workerLogger.info({ branchName, remote: remoteName, repoRoot }, 'Successfully pushed branch');
  } catch (error: any) {
    const stderr = String(error.stderr || error.message || '');
    const errorMessage = `Failed to push branch ${branchName} to ${remoteName}: ${error.stderr || error.message}`;
    workerLogger.error({ branchName, remote: remoteName, error: serializeError(error) }, errorMessage);

    if (isNonFastForwardPush(stderr)) {
      workerLogger.warn({ branchName, remote: remoteName, repoRoot }, 'Push rejected (non-fast-forward). Attempting fetch + rebase');
      try {
        execFileSync('git', ['fetch', remoteName, branchName], {
          cwd: repoRoot,
          stdio: 'pipe',
          encoding: 'utf-8',
          timeout: GIT_PUSH_TIMEOUT_MS,
          env: process.env as Record<string, string>,
        });
        execFileSync('git', ['rebase', `${remoteName}/${branchName}`], {
          cwd: repoRoot,
          stdio: 'pipe',
          encoding: 'utf-8',
          timeout: GIT_PUSH_TIMEOUT_MS,
          env: process.env as Record<string, string>,
        });
        execFileSync('git', ['push', '-u', remoteName, `${branchName}:${branchName}`], {
          cwd: repoRoot,
          stdio: 'pipe',
          encoding: 'utf-8',
          timeout: GIT_PUSH_TIMEOUT_MS,
          env: process.env as Record<string, string>,
        });
        workerLogger.info({ branchName, remote: remoteName, repoRoot }, 'Successfully pushed branch after rebase');
        return;
      } catch (rebaseError: any) {
        try {
          execFileSync('git', ['rebase', '--abort'], {
            cwd: repoRoot,
            stdio: 'pipe',
            encoding: 'utf-8',
            timeout: GIT_PUSH_TIMEOUT_MS,
            env: process.env as Record<string, string>,
          });
        } catch (abortError: any) {
          workerLogger.warn(
            { branchName, remote: remoteName, error: serializeError(abortError) },
            'Failed to abort rebase after push rejection'
          );
        }

        const rebaseMessage = `Push rejected (non-fast-forward). Failed to rebase ${branchName} onto ${remoteName}/${branchName}: ${rebaseError.stderr || rebaseError.message}`;
        workerLogger.error({ branchName, remote: remoteName, error: serializeError(rebaseError) }, rebaseMessage);
        throw new GitPushError(
          rebaseMessage,
          branchName,
          remoteName,
          rebaseError
        );
      }
    }

    // Determine if this is a "no commits" error vs network/authentication error
    const isNoCommitsError = stderr.includes('no commits') || stderr.includes('nothing to push');
    
    throw new GitPushError(
      errorMessage,
      branchName,
      remoteName,
      error
    );
  }
}
