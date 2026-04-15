/**
 * Working tree inspection and staging operations
 */

import { getRepoRoot } from '../../shared/repo_utils.js';
import type { CodeMetadata } from '../../agent/shared/code_metadata.js';
import { GIT_STATUS_TIMEOUT_MS } from '../constants.js';

/**
 * Check if working tree has uncommitted changes
 */
export async function hasUncommittedChanges(codeMetadata: CodeMetadata): Promise<boolean> {
  const repoRoot = getRepoRoot(codeMetadata);
  const { execFileSync } = await import('node:child_process');

  try {
    const statusOutput = execFileSync('git', ['status', '--porcelain'], {
      cwd: repoRoot,
      stdio: 'pipe',
      encoding: 'utf-8',
      timeout: GIT_STATUS_TIMEOUT_MS,
      env: process.env as Record<string, string>,
    }).trim();

    return statusOutput.length > 0;
  } catch (error: any) {
    // If status check fails, assume there are changes to be safe
    return true;
  }
}

/**
 * Stage all changes in the working tree
 */
export async function stageAllChanges(codeMetadata: CodeMetadata): Promise<void> {
  const repoRoot = getRepoRoot(codeMetadata);
  const { execFileSync } = await import('node:child_process');

  execFileSync('git', ['add', '--all'], {
    cwd: repoRoot,
    stdio: 'pipe',
    encoding: 'utf-8',
    timeout: GIT_STATUS_TIMEOUT_MS,
    env: process.env as Record<string, string>,
  });
}

/**
 * Get git status output
 */
export async function getGitStatus(codeMetadata: CodeMetadata): Promise<string> {
  const repoRoot = getRepoRoot(codeMetadata);
  const { execFileSync } = await import('node:child_process');

  return execFileSync('git', ['status', '--porcelain'], {
    cwd: repoRoot,
    stdio: 'pipe',
    encoding: 'utf-8',
    timeout: GIT_STATUS_TIMEOUT_MS,
    env: process.env as Record<string, string>,
  }).trim();
}

/**
 * Count commits on current branch (useful for checking if branch has commits before push)
 */
export async function getCommitCount(codeMetadata: CodeMetadata, branchName?: string): Promise<number> {
  const repoRoot = getRepoRoot(codeMetadata);
  const { execFileSync } = await import('node:child_process');

  try {
    const ref = branchName || 'HEAD';
    const output = execFileSync('git', ['rev-list', '--count', ref], {
      cwd: repoRoot,
      stdio: 'pipe',
      encoding: 'utf-8',
      timeout: GIT_STATUS_TIMEOUT_MS,
      env: process.env as Record<string, string>,
    }).trim();
    
    return parseInt(output, 10) || 0;
  } catch {
    return 0;
  }
}

